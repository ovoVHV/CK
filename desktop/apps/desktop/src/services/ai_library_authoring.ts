import * as Blockly from 'blockly';
import Ajv2020 from 'ajv/dist/2020.js';
import { parseDeclarativeBlockDocument, parseDeclarativeGeneratorDocument, bindDeclarativeGeneratorFunction } from './declarative_block_runtime';
import type { ProjectBuildTarget } from './project_build_target';
import type { AiCandidateResult } from './ai_candidate';
import contractSchema from '../../../../docs/schemas/ck-blocks-v2.schema.json';

const validateContract = new Ajv2020({ strict: false, allErrors: true, ownProperties: true,
    coerceTypes: false, useDefaults: false, removeAdditional: false }).compile(contractSchema);

export interface AiLibraryBlock {
    definition: Record<string, any>;
    generator: Record<string, any>;
    documentation: Record<string, any>;
    sample?: { fields?: Record<string, string | number | boolean>; values?: Record<string, string | number | boolean> };
}
export interface AiLibraryDraft {
    id: string; name: string; version: string; description: string;
    blocks: AiLibraryBlock[]; files: Record<string, string>; readme: string;
    origin?: { packageId: string; version: string; contentSha256: string; license: string; licenseId: string };
}
export interface AiLibraryPreview {
    token: string; packageId: string; name: string; version: string; contentSha256: string;
    types: string[]; files: string[]; source: string; validation: AiCandidateResult;
}
export interface AiLibraryHost {
    readSource?: (packageId: string, contentSha256: string, path?: string, offset?: number) => Promise<unknown>;
    revise?: (packageId: string, contentSha256: string) => Promise<{ draft: AiLibraryDraft; typeMap: Record<string,string> }>;
    validate: (draft: AiLibraryDraft, context: { signal: AbortSignal; onStep: (text: string) => void }) => Promise<AiLibraryPreview>;
    install: (preview: AiLibraryPreview, signal: AbortSignal, onStep: (text: string) => void, checkCurrent?: () => void) => Promise<void>;
    discard: (token: string) => Promise<void>;
    export: (preview: AiLibraryPreview) => Promise<string | null>;
}

const object = (value: any): value is Record<string, any> => value && typeof value === 'object' && !Array.isArray(value);
const text = (value: any, label: string, max = 2000): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw Error(`${label}不能为空或过长`);
    return value.trim();
};
export function newAiLibraryDraft(): AiLibraryDraft {
    return { id: `ck_ai_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`, name: '', description: '', version: '0.1.0', blocks: [], files: {}, readme: '' };
}
export function stageAiLibrary(previous: AiLibraryDraft, input: any): AiLibraryDraft {
    if (!object(input)) throw Error('库草稿参数需要对象');
    if (/__CK_PRIVATE_\d+__/.test(JSON.stringify(input))) throw Error('库文件不能包含工程私密值占位符，请使用可编辑参数');
    const next: AiLibraryDraft = JSON.parse(JSON.stringify(input.reset ? { ...newAiLibraryDraft(), id: previous.id, ...(previous.origin ? {origin:previous.origin} : {}) } : previous));
    for (const key of ['name', 'description', 'readme'] as const) if (input[key] !== undefined) next[key] = text(input[key], key, key === 'readme' ? 16000 : 2000);
    if (input.version !== undefined) {
        if (typeof input.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(input.version)) throw Error('版本需要 SemVer，例如 0.1.0');
        next.version = input.version;
    }
    if (input.blocks !== undefined) {
        if (!Array.isArray(input.blocks) || input.blocks.length > 8) throw Error('每段最多8个积木');
        for (const block of input.blocks) {
            if (!object(block) || !object(block.definition) || !object(block.generator) || !object(block.documentation)) throw Error('每个积木需要 definition、generator、documentation');
            const type = block.definition.type;
            if (typeof type !== 'string' || !new RegExp(`^${next.id}_[a-zA-Z][a-zA-Z0-9_]{0,60}$`).test(type)) throw Error(`积木 type 必须使用 ${next.id}_ 前缀`);
            if (block.generator.type !== type) throw Error('生成规则与积木 type 不一致');
            const kind = block.generator.kind;
            if (kind !== 'statement' && kind !== 'expression') throw Error(`${type}: generator.kind仅允许statement（语句）或expression（返回值），不能写value、number或output。返回值积木在definition.output声明Number/Boolean/String。`);
            for (const key of ['includes','declarations','setup']) {
                const section=block.generator[key];
                if (section !== undefined && (!object(section) || Object.values(section).some(value=>typeof value!=='string'))) throw Error(`${type}: generator.${key}需要{唯一键:"C++文本"}对象，不能是数组或字符串。例如includes:{header:"#include <MyLibrary.h>"}。`);
            }
            if (kind === 'expression' && block.definition.output === undefined) throw Error(`${type}: expression生成器需要definition.output值输出连接`);
            if (kind === 'statement' && block.definition.output !== undefined) throw Error(`${type}: definition.output是值积木，generator.kind应为expression`);
            parseDeclarativeBlockDocument(JSON.stringify([block.definition]));
            parseDeclarativeGeneratorDocument(JSON.stringify({ schema: 'ck-generator', version: 1, rules: [block.generator] }));
            const serialized = JSON.stringify(block);
            if (/"(?:extensions|mutator|style|onchange|__proto__|constructor|prototype)"\s*:/.test(serialized)) throw Error('新库只支持声明式积木，不支持执行脚本、扩展或 mutator');
            text(block.documentation.description, '积木用途');
            const index = next.blocks.findIndex(row => row.definition.type === type);
            if (index < 0) next.blocks.push(block as AiLibraryBlock); else next.blocks[index] = block as AiLibraryBlock;
        }
    }
    if (input.files !== undefined) {
        if (!Array.isArray(input.files) || input.files.length > 8) throw Error('每段最多8个源文件');
        for (const file of input.files) {
            if (!object(file) || typeof file.path !== 'string' || !/^src\/[A-Za-z][A-Za-z0-9_]{0,80}\.(?:h|hpp|c|cpp)$/.test(file.path)) throw Error('源文件仅允许 src/ 下的 .h/.hpp/.c/.cpp 文件');
            if (file.content === null) delete next.files[file.path];
            else next.files[file.path] = text(file.content, file.path, 48000) + '\n';
        }
    }
    if (next.blocks.length > 24 || Object.keys(next.files).length > 16 || JSON.stringify(next).length > 240000) throw Error('库草稿超过本次上限：24积木、16源文件、240KB文本');
    if (new Set(Object.keys(next.files).map(path => path.toLowerCase())).size !== Object.keys(next.files).length) throw Error('Windows 文件名大小写冲突');
    return next;
}

// Uses the same JSON rules as the installed runtime; temporary definitions are
// synchronous and always removed before any IPC/network await.
export function buildAiLibrary(draft: AiLibraryDraft, target: ProjectBuildTarget): { files: Record<string, string>; source: string; types: string[] } {
    text(draft.name, '库名称'); text(draft.description, '库说明');
    if (!draft.blocks.length) throw Error('库中还没有积木');
    if (!target.optionsComplete || !target.coreVersion) throw Error('板卡与 Core 尚未就绪');
    const types = draft.blocks.map(row => row.definition.type);
    if (types.some(type => Blockly.Blocks[type])) throw Error('新库积木标识已被占用，请新建制作任务');
    const rules = parseDeclarativeGeneratorDocument(JSON.stringify({ schema: 'ck-generator', version: 1, rules: draft.blocks.map(row => row.generator) }));
    const includes = new Map<string, string>(), declarations = new Map<string, string>(), setup = new Map<string, string>();
    const ws = new Blockly.Workspace(); const bodies: string[] = [];
    Blockly.Events.disable();
    try {
        Blockly.defineBlocksWithJsonArray(draft.blocks.map(row => row.definition));
        for (const [index, row] of draft.blocks.entries()) {
            const block = ws.newBlock(row.definition.type);
            if (row.sample?.fields) for (const [name, value] of Object.entries(row.sample.fields)) {
                if (!block.getField(name)) throw Error(`试编译字段不存在：${name}`);
                block.setFieldValue(value, name);
                if (String(block.getFieldValue(name)) !== String(value)) throw Error(`试编译字段值被积木拒绝：${name}`);
            }
            const rule = rules.rules[index];
            if (Boolean(block.outputConnection) !== (rule.kind === 'expression')) throw Error(`${rule.type} 输出连接与生成类型不一致`);
            for (const template of [rule.template, ...Object.values(rule.includes), ...Object.values(rule.declarations), ...Object.values(rule.setup)]) {
                for (const match of template.matchAll(/\{\{(field|field_json|value|statement):(\w+)\}\}/g)) {
                    const [, kind, name] = match;
                    if (kind.startsWith('field') ? !block.getField(name) : !block.getInput(name)?.connection || block.getInput(name)!.type !== (kind === 'value' ? Blockly.inputs.inputTypes.VALUE : Blockly.inputs.inputTypes.STATEMENT)) throw Error(`${rule.type} 引用不存在或类型不符的 ${kind}:${name}`);
                }
            }
            const generator = {
                addInclude: (key: string, value: string) => includes.set(key, value),
                addDeclaration: (key: string, value: string) => declarations.set(key, value),
                addSetup: (key: string, value: string) => setup.set(key, value),
                valueToCode: (_b: unknown, name: string) => {
                    const value = row.sample?.values?.[name] ?? (block.getInput(name)?.connection?.getCheck()?.includes('String') ? '' : 0);
                    if (!['string', 'boolean', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) throw Error(`试编译输入 ${name} 需要常量`);
                    return JSON.stringify(value);
                },
                statementToCode: () => '',
            };
            const generated = bindDeclarativeGeneratorFunction(rule, generator)(block);
            bodies.push(`// block: ${rule.type}\n${Array.isArray(generated) ? `(void)(${generated[0]});` : generated}`);
        }
    } finally { ws.dispose(); for (const type of types) delete Blockly.Blocks[type]; Blockly.Events.enable(); }
    const source = `#include <Arduino.h>\n${[...includes.values()].join('\n')}\n${[...declarations.values()].join('\n')}\nvoid setup() {\n${[...setup.values()].join('\n')}\n}\nvoid loop() {\n${bodies.join('\n')}\n}\n`;
    const docs = draft.blocks.map(row => {
        const def = row.definition, doc = row.documentation;
        const args = Object.entries(def).filter(([key]) => /^args\d+$/.test(key)).flatMap(([, value]) => value as any[]);
        const kind = row.generator.kind === 'expression' ? 'value' : 'statement';
        return {
            type: def.type, display_name: doc.display_name || doc.description, description: doc.description,
            category: draft.name, kind, keywords: doc.keywords || [],
            semantics: doc.semantics || { purpose: doc.description, behavior: doc.description, side_effects: ['未声明，需核对生成代码与硬件'], concepts: [] },
            fields: args.filter(arg => arg.type?.startsWith('field_') && arg.name).map(arg => ({ name: arg.name, kind: arg.type.slice(6), description: doc.fieldDescriptions?.[arg.name] || arg.name,
                ...(arg.options ? { options: arg.options.map(([label, value]: string[]) => ({ label, value })) } : {}) })),
            inputs: args.filter(arg => ['input_value','input_statement'].includes(arg.type)).map(arg => ({ name: arg.name, kind: arg.type === 'input_value' ? 'value' : 'statement', description: doc.inputDescriptions?.[arg.name] || arg.name, ...(arg.check ? { check: arg.check } : {}) })),
            output: { connection: kind === 'value' ? 'value' : 'none', types: kind === 'value' ? (Array.isArray(def.output) ? def.output : [def.output || 'Any']) : [], ...(doc.unit ? { unit: doc.unit } : {}) },
            dependencies: doc.dependencies || [], hardware: doc.hardware || { resources: [], claims: { version: 1, coverage: 'unknown', templates: [] }, notes: ['资源占用尚未完整声明，不代表没有占用'] },
            generation: { language: 'arduino-cpp', shape: row.generator.kind, deterministic: true, emissions: [{ section: kind === 'value' ? 'expression' : 'statement', description: doc.description, template: row.generator.template }] },
            constraints: doc.constraints || [], examples: doc.examples?.length ? doc.examples : [{ id: 'compile-check', title: '默认参数试编译', description: '使用生成器与默认参数覆盖本库积木，仅用于编译检查', project: 'examples/compile_check/compile_check.ino', expected_behavior: '生成可编译代码；实际硬件行为尚待验证' }], errors: doc.errors || [],
        };
    });
    const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
    // Verified scope is this board only; portability must be qualified explicitly.
    const architectures = [target.board.split(':')[1]];
    const files: Record<string, string> = { ...draft.files,
        'library.json': json({ id: draft.id, name: draft.name, version: draft.version, description: draft.description, author: 'CK AI assisted', architectures }),
        'ck-blocks.json': json({ schema_version: 2, id: draft.id, display_name: draft.name, description: draft.description,
            license: { spdx_id: draft.origin?.licenseId || 'LicenseRef-User-Review', file: 'LICENSE' }, compatibility: { boards: [target.board], architectures },
            entrypoints: { blocks: 'blocks/blocks.json', generator: 'blocks/ck-generator.json', toolbox: 'blocks/toolbox.json' }, blocks: docs }),
        'blocks/blocks.json': json(draft.blocks.map(row => row.definition)),
        'blocks/ck-generator.json': json({ schema: 'ck-generator', version: 1, rules: draft.blocks.map(row => row.generator) }),
        'blocks/toolbox.json': json({ kind: 'category', name: draft.name, colour: '#E05263', contents: types.map(type => ({ kind: 'block', type })) }),
        'README.md': `# ${draft.name}\n\n${draft.description}\n\n${draft.readme || '用法请查看各积木提示与代码。'}\n\n版本：${draft.version}。AI 辅助生成，需人工审阅。仅对当前板卡配置试编译，不代表真机通过。\n`,
        'LICENSE': draft.origin?.license || 'LicenseRef-User-Review\nAI-assisted draft. No third-party redistribution rights are granted. Review provenance and choose a license before publication.\n',
        'examples/compile_check/compile_check.ino': source,
    };
    if (!validateContract(JSON.parse(files['ck-blocks.json']))) {
        const issues = (validateContract.errors || []).slice(0, 8).map(error =>
            `${error.instancePath || '/'}: ${error.message}; ${JSON.stringify(error.params)}`);
        throw Error(`库声明格式校验失败（尚未编译）：${issues.join('；')}。按字段路径修复 documentation；可用 get_library_format 读取对应章节的真实结构。`);
    }
    if (Object.keys(draft.files).length) files['library.properties'] = `name=${draft.id}\nversion=${draft.version}\nauthor=CK AI assisted\nmaintainer=CK user\nsentence=AI assisted block library\nparagraph=Review README before use\ncategory=Other\narchitectures=${architectures.join(',')}\n`;
    return { files, source, types };
}

export function aiLibraryFormat(id: string, section?: string) {
    if (section) {
        if (!['hardware','dependencies','semantics','constraints','examples','errors'].includes(section)) throw Error('未知的库契约章节');
        const schema: any = contractSchema, definition = schema.$defs.block.properties[section], definitions: Record<string, unknown> = {};
        const visit = (value: any) => {
            if (value?.$ref) {
                const key = value.$ref.split('/')[2];
                if (!definitions[key] && schema.$defs[key]) { definitions[key] = schema.$defs[key]; visit(schema.$defs[key]); }
            }
            if (value && typeof value === 'object') for (const child of Object.values(value)) if (typeof child === 'object') visit(child);
        };
        visit(definition); return { section, schema: definition, $defs: definitions };
    }
    return { id, typePrefix: id + '_', format: 'CK v2 metadata + Blockly JSON + ck-generator v1',
        workflow: 'stage_library 分段暂存；相同type替换修复；read_library_draft按需回读；submit_library自动检查并试编译；通过后按用户开关安装加载。未安装前不能用于当前工程。',
        example: { name: '数字输出', description: '设置数字引脚电平', blocks: [{
            definition: { type: id + '_write', message0: '数字输出 引脚 %1 电平 %2', args0: [{ type: 'field_number', name: 'PIN', value: 13, min: 0, precision: 1 }, { type: 'field_dropdown', name: 'LEVEL', options: [['高','HIGH'],['低','LOW']] }], previousStatement: null, nextStatement: null, colour: '#E05263', tooltip: '设置指定引脚的数字电平', helpUrl: '' },
            generator: { type: id + '_write', kind: 'statement', template: 'digitalWrite({{field:PIN}}, {{field:LEVEL}});\n', setup: { mode: 'pinMode({{field:PIN}}, OUTPUT);' } },
            documentation: { description: '把指定引脚配置为输出并写入电平', fieldDescriptions: { PIN: '数字引脚', LEVEL: '输出电平' }, hardware: { resources: [{ kind: 'gpio', source: { kind: 'field', name: 'PIN' }, access: 'write', sharing: 'exclusive', capabilities: ['digital-output'], description: '数字输出引脚' }] } },
        }] },
        generatorContract: { kind:['statement','expression'], type:'与definition.type完全相同', template:'语句包含分号；expression仅C++表达式，不加分号', order:'可选整数0–99，默认0', includes:{uniqueHeader:'#include <MyLibrary.h>'}, declarations:{uniqueGlobal:'float exampleValue = 0;'}, setup:{uniqueSetup:'exampleBegin();'}, note:'includes/declarations/setup均为可选的键→C++字符串对象，不是数组。生成器kind与CK元数据kind命名不同；元数据由软件生成，不要混用value。' },
        expressionExample: { definition:{type:id+'_read',message0:'读取结果',output:'Number',colour:'#E05263'},generator:{type:id+'_read',kind:'expression',template:'analogRead(A0)'},documentation:{description:'读取A0的当前模拟值'} },
        precision: '先确认返回值范围、单位和精度。平均值、比例、时间差不能随意改成整数或有符号数；偶数样本中值可能有0.5，除非需求明确取整。核心源码API、generator模板和工程变量的类型需一致。',
        placeholders: ['{{field:NAME}} 未加引号字段', '{{field_json:NAME}} C++字符串字面量', '{{value:NAME}} 值输入', '{{statement:NAME}} 语句输入'],
        documents: 'documentation可写semantics(purpose,behavior,side_effects,concepts)、fieldDescriptions、inputDescriptions、unit、dependencies、hardware(resources/claims)、constraints、examples、errors；遵循现有CK v2规范。未知信息不编造。',
        sources: '可选files:[{path:"src/UniqueName.h",content:"..."}]；仅h/hpp/c/cpp。多个积木共享的函数/状态放入带include guard的唯一头文件或h+cpp，再分别includes引用。生成器的includes/declarations/setup键按积木type隔离，同名键不能跨type去重；不要给多个积木重复写同一函数定义。依赖已有Core或已安装库；缺失依赖会报错，不偷偷安装。',
        limits: '单段8积木/8文件，总共24积木/16源文件/240KB；禁止JavaScript、mutator、远程资源；不覆盖现有库；最多3次试编译；默认只声明当前板卡兼容。',
    };
}
