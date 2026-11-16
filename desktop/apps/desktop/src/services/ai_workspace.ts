import * as Blockly from 'blockly';
import type { BlockSearchEntry } from '../types/library';
import { aiCapabilitySummary } from './ai_library_context';

export type BlockState = Blockly.serialization.blocks.State;
export type WorkspaceState = ReturnType<typeof Blockly.serialization.workspaces.save>;
export type AiEdit =
    | { action: 'set_field'; blockId: string; field: string; value: string | number | boolean }
    | { action: 'add_top'; block: BlockState }
    | { action: 'append'; blockId: string; input?: string; block: BlockState }
    | { action: 'replace'; blockId: string; block: BlockState }
    | { action: 'remove'; blockId: string };
export interface AiProposal {
    summary: string;
    edits: AiEdit[];
    variables?: Array<{ name: string; type?: string }>;
}
export interface AiPreview {
    proposal: AiProposal;
    before: string;
    after: string;
    changes: Array<{ kind: 'added' | 'removed' | 'changed'; id: string; before?: string; after?: string }>;
    added: number;
    removed: number;
    changed: number;
}
export interface AiGraphNode { key: string; type: string; fields?: BlockState['fields']; inputs?: Record<string, string>; next?: string; extraState?: unknown }

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const assert: (ok: unknown, message: string) => asserts ok = (ok, message) => { if (!ok) throw new Error(message); };
const snapshot = (workspace: Blockly.Workspace) => JSON.stringify(Blockly.serialization.workspaces.save(workspace));
export const aiWorkspaceSnapshot = snapshot;
const quiet = <T>(fn: () => T): T => {
    Blockly.Events.disable();
    try { return fn(); } finally { Blockly.Events.enable(); }
};
const plain = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const safeKeys = (object: Record<string, any>, allowed: string[]) => {
    for (const key of Object.keys(object)) assert(allowed.includes(key), `不支持的字段：${key}`);
};

// A flat wire representation avoids deeply nested model JSON. References are
// templates, not workspace IDs: every occurrence creates a distinct block.
export function expandAiBlockGraph(value: unknown, prior: Map<string, AiGraphNode>) {
    assert(plain(value), '积木图必须是对象');
    safeKeys(value, ['summary', 'variables', 'nodes', 'placements', 'reset', 'patch', 'removeKeys']);
    assert(value.reset == null || typeof value.reset === 'boolean', 'reset必须是布尔值');
    assert(value.patch == null || typeof value.patch === 'boolean', 'patch必须是布尔值');
    assert(!(value.reset && value.patch), 'patch和reset不能同时使用');
    assert(value.removeKeys == null || (value.patch && Array.isArray(value.removeKeys) && value.removeKeys.length <= 40 && value.removeKeys.every((key: unknown) => typeof key === 'string' && prior.has(key))), 'removeKeys仅用于patch，最多40个已有节点key');
    assert(Array.isArray(value.nodes) && value.nodes.length <= 40, '每段最多40个节点');
    assert(Array.isArray(value.placements) && value.placements.length <= 40, '每段最多40个放置操作');
    assert(value.nodes.length || value.placements.length || value.removeKeys?.length, '节点和放置操作不能同时为空');
    assert(typeof value.summary === 'string' && value.summary.trim() && value.summary.length <= 1200, '请提供简短的修改说明');
    validateAiVariables(value.variables);
    const nodes = new Map(value.reset ? [] : prior);
    for (const key of value.removeKeys || []) nodes.delete(key);
    const local = new Set<string>();
    for (const node of value.nodes) {
        assert(plain(node), '节点必须是对象'); safeKeys(node, ['key', 'type', 'fields', 'inputs', 'next', 'extraState']);
        assert(typeof node.key === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(node.key) && !local.has(node.key), '节点key无效或本段重复');
        assert(value.patch || !nodes.has(node.key), `节点${node.key}已存在；局部修改请用patch:true和完整节点，新增节点请用新key`);
        assert(typeof node.type === 'string' && node.type.length <= 128, '节点type无效');
        if (node.inputs != null) assert(plain(node.inputs) && Object.values(node.inputs).every(v => typeof v === 'string'), 'inputs的值必须是节点key');
        if (node.next != null) assert(typeof node.next === 'string', 'next必须是节点key');
        local.add(node.key); nodes.set(node.key, structuredClone(node) as AiGraphNode);
    }
    assert(nodes.size <= 256 && JSON.stringify([...nodes.values()]).length <= 120000, '暂存节点超过上限');
    let count = 0;
    const expand = (key: string, visiting: Set<string>): BlockState => {
        assert(!visiting.has(key), `积木连接存在环：${key}`);
        assert(visiting.size < 32 && ++count <= 180, '展开后的积木过深或超过180个');
        const node = nodes.get(key); assert(node, `找不到节点：${key}`);
        const next = new Set(visiting).add(key);
        return { type: node.type, ...(node.fields ? { fields: structuredClone(node.fields) } : {}),
            ...(node.extraState != null ? { extraState: structuredClone(node.extraState) } : {}),
            ...(node.inputs ? { inputs: Object.fromEntries(Object.entries(node.inputs).map(([name, child]) => [name, { block: expand(child, next) }])) } : {}),
            ...(node.next ? { next: { block: expand(node.next, next) } } : {}) };
    };
    const edits = value.placements.map((p: any) => {
        assert(plain(p), '放置操作格式错误'); safeKeys(p, ['action', 'blockId', 'input', 'node']);
        assert(['append', 'replace', 'add_top'].includes(p.action) && typeof p.node === 'string', '放置操作需要action和node');
        const { node, ...edit } = p; return { ...edit, block: expand(node, new Set()) };
    });
    const proposal = { summary: value.summary, edits, ...(value.variables ? { variables: value.variables } : {}) } as AiProposal;
    if (edits.length) parseAiProposal(proposal);
    return { nodes, proposal, reset: Boolean(value.reset), patch: Boolean(value.patch) };
}

// A toolbox entry may contain registered shadow/helper blocks without listing
// them separately. Expose only children referenced by active templates, never
// every type left in Blockly's global registry after a board/library switch.
export function aiAvailableCatalog(catalog: BlockSearchEntry[]): BlockSearchEntry[] {
    const entries = new Map(catalog.filter(entry => Blockly.Blocks[entry.type]).map(entry => [entry.type, entry]));
    for (const entry of catalog) {
        if (!Blockly.Blocks[entry.type] || !entry.xml_template) continue;
        try {
            const xml = Blockly.utils.xml.textToDom(entry.xml_template);
            for (const node of Array.from(xml.querySelectorAll('block, shadow'))) {
                const type = node.getAttribute('type');
                if (!type || entries.has(type) || !Blockly.Blocks[type]) continue;
                const template = node.ownerDocument.createElement('block');
                for (const attribute of Array.from(node.attributes)) if (attribute.name !== 'id') template.setAttribute(attribute.name, attribute.value);
                for (const child of Array.from(node.childNodes)) template.appendChild(child.cloneNode(true));
                entries.set(type, { type, source: entry.source, library_id: entry.library_id, category: entry.category,
                    description: `${entry.display_name || entry.type} 的模板子积木`, keywords: [type, ...(entry.keywords || [])],
                    xml_template: Blockly.utils.xml.domToText(template) });
            }
        } catch { /* An invalid installed template is reported when its schema is requested. */ }
    }
    return [...entries.values()];
}

export function validateAiVariables(variables: unknown) {
    if (variables != null) {
        assert(Array.isArray(variables) && variables.length <= 64, '变量列表最多64项');
        for (const variable of variables) {
            assert(plain(variable), '变量描述格式错误'); safeKeys(variable, ['name', 'type']);
            assert(typeof variable.name === 'string' && variable.name.trim() && variable.name.length <= 128, '变量名无效');
            assert(variable.type == null || (typeof variable.type === 'string' && variable.type.length <= 64), '变量类型无效');
        }
    }
}
export function parseAiProposal(value: unknown): AiProposal {
    assert(plain(value), '修改方案必须是对象');
    safeKeys(value, ['summary', 'edits', 'variables']);
    validateAiVariables(value.variables);
    assert(typeof value.summary === 'string' && value.summary.trim().length > 0 && value.summary.length <= 1200, '请提供简短的修改说明');
    assert(Array.isArray(value.edits) && value.edits.length > 0 && value.edits.length <= 40, '每次修改需要 1–40 个操作');
    assert(JSON.stringify(value).length <= 60000, '修改方案过大，请分成几个步骤');
    for (const edit of value.edits) {
        assert(plain(edit), '修改操作格式错误');
        switch (edit.action) {
            case 'set_field':
                safeKeys(edit, ['action', 'blockId', 'field', 'value']);
                assert(typeof edit.field === 'string' && ['string', 'number', 'boolean'].includes(typeof edit.value), '字段值格式错误');
                break;
            case 'add_top': safeKeys(edit, ['action', 'block']); break;
            case 'append': safeKeys(edit, ['action', 'blockId', 'input', 'block']); break;
            case 'replace': safeKeys(edit, ['action', 'blockId', 'block']); break;
            case 'remove': safeKeys(edit, ['action', 'blockId']); break;
            default: throw new Error(`不支持的操作：${String(edit.action)}`);
        }
        if (edit.action !== 'add_top') assert(typeof edit.blockId === 'string' && edit.blockId.length > 0, '缺少目标积木 ID');
        if (['add_top', 'append', 'replace'].includes(edit.action)) assert(plain(edit.block), '缺少新积木结构');
    }
    return structuredClone(value) as AiProposal;
}

// Models only name registered blocks. No XML/JS evaluation or raw code fallback.
function validateBlockState(state: any, allowed: Set<string>, budget: { count: number }, depth = 0) {
    assert(plain(state) && depth <= 32, '积木结构过深或格式错误');
    assert(++budget.count <= 180, '一次最多生成 180 个积木，请拆分需求');
    safeKeys(state, ['type', 'fields', 'inputs', 'next', 'extraState']);
    assert(typeof state.type === 'string' && allowed.has(state.type) && Blockly.Blocks[state.type], `当前板卡没有可用积木：${String(state.type)}`);
    if (state.fields != null) {
        assert(plain(state.fields), '积木字段格式错误');
        for (const [key, value] of Object.entries(state.fields)) {
            assert(!['__proto__', 'prototype', 'constructor'].includes(key), '非法字段');
            assert(['string', 'number', 'boolean'].includes(typeof value) || (plain(value) && Object.keys(value).every(k => ['id', 'name', 'type'].includes(k))), `字段 ${key} 的值无效`);
        }
    }
    if (state.inputs != null) {
        assert(plain(state.inputs), '输入格式错误');
        for (const input of Object.values(state.inputs)) {
            assert(plain(input), '输入连接格式错误');
            safeKeys(input, ['block', 'shadow']);
            assert(input.block || input.shadow, '输入连接不能为空');
            if (input.block) validateBlockState(input.block, allowed, budget, depth + 1);
            if (input.shadow) validateBlockState(input.shadow, allowed, budget, depth + 1);
        }
    }
    if (state.next != null) {
        assert(plain(state.next) && state.next.block, 'next 需要 block');
        safeKeys(state.next, ['block']);
        validateBlockState(state.next.block, allowed, budget, depth + 1);
    }
}

function checkMaterialized(state: BlockState, block: Blockly.Block) {
    for (const [name, expected] of Object.entries(state.fields || {})) {
        const field = block.getField(name);
        assert(field, `${block.type} 不存在字段 ${name}`);
        if (plain(expected)) {
            const variable = (field as Blockly.FieldVariable).getVariable?.();
            assert(variable && (!expected.name || variable.getName() === expected.name), `变量字段 ${name} 未正确恢复`);
        } else {
            assert(String(field.getValue()) === String(expected), `${block.type}.${name} 不接受值 ${String(expected)}`);
        }
    }
    for (const [name, input] of Object.entries(state.inputs || {})) {
        const child = block.getInputTargetBlock(name);
        const expected = input.block || input.shadow;
        assert(child && expected && child.type === expected.type, `${block.type}.${name} 连接无效`);
        checkMaterialized(expected, child);
    }
    if (state.next?.block) {
        const next = block.getNextBlock();
        assert(next, `${block.type} 后面无法连接语句`);
        checkMaterialized(state.next.block, next);
    }
}

function connect(parent: Blockly.Connection | null | undefined, child: Blockly.Connection | null | undefined) {
    assert(parent && child, '目标没有所需的连接接口');
    assert(!parent.isConnected() && !child.isConnected(), '目标连接已被占用');
    parent.connect(child);
    assert(parent.targetConnection === child, '积木连接类型不兼容');
}
function tail(block: Blockly.Block): Blockly.Block {
    let last = block;
    while (last.getNextBlock()) last = last.getNextBlock()!;
    return last;
}
function descriptions(workspace: Blockly.Workspace) {
    return new Map(workspace.getAllBlocks(false).map(b => [b.id, {
        label: b.toString(180, '…'),
        shape: JSON.stringify({ type: b.type, state: Blockly.serialization.blocks.save(b, { addInputBlocks: false, addNextBlocks: false }),
            parent: b.getParent()?.id, next: b.getNextBlock()?.id,
            inputs: b.inputList.map(i => [i.name, i.connection?.targetBlock()?.id]) }),
    }]));
}

export function previewAiProposal(workspace: Blockly.Workspace, proposal: AiProposal, catalog: BlockSearchEntry[]): AiPreview {
    const before = snapshot(workspace);
    const original = descriptions(workspace);
    const allowed = new Set(aiAvailableCatalog(catalog).map(b => b.type));
    // Existing types remain readable; adding a type still requires the active catalog.
    const draft = new Blockly.Workspace();
    return quiet(() => {
        try {
            Blockly.serialization.workspaces.load(JSON.parse(before), draft);
            // Variable dropdowns need their workspace symbols before a block is
            // deserialized. Block-change listeners are intentionally disabled in previews.
            for (const variable of proposal.variables || []) draft.getVariableMap().createVariable(variable.name, variable.type || '');
            const budget = { count: 0 };
            for (const edit of proposal.edits) {
                const target = 'blockId' in edit ? draft.getBlockById(edit.blockId) : null;
                if ('blockId' in edit) assert(target, `目标积木已不存在：${edit.blockId}`);
                if (edit.action === 'set_field') {
                    const field = target!.getField(edit.field);
                    assert(field && field.EDITABLE && !(field instanceof Blockly.FieldVariable), '字段不存在、不可编辑或需要变量结构');
                    field.setValue(edit.value);
                    assert(String(field.getValue()) === String(edit.value), `字段 ${edit.field} 不接受这个值`);
                    continue;
                }
                if (edit.action === 'remove') { target!.dispose(true); continue; }
                validateBlockState(edit.block, allowed, budget);
                const child = Blockly.serialization.blocks.append(edit.block, draft);
                checkMaterialized(edit.block, child);
                if (edit.action === 'add_top') {
                    assert(!child.outputConnection, '值积木需要连接到输入，不能单独放置');
                    if (/^controls_(setup|loop)_custom$/.test(child.type)) {
                        assert(draft.getAllBlocks(false).filter(b => b.type === child.type).length === 1, '初始化/循环容器已经存在，请追加或修改现有容器');
                    }
                    const y = Math.max(24, ...draft.getTopBlocks(false).filter(b => b !== child).map(b => b.getRelativeToSurfaceXY().y + 160));
                    child.moveBy(36, y);
                } else if (edit.action === 'append') {
                    if (edit.input) {
                        const input = target!.getInput(edit.input);
                        assert(input?.type === Blockly.inputs.inputTypes.STATEMENT, 'append.input 必须是语句输入');
                        const existing = input.connection?.targetBlock();
                        connect(existing ? tail(existing).nextConnection : input.connection, child.previousConnection);
                    } else {
                        const following = target!.getNextBlock();
                        if (following) following.unplug(false);
                        connect(target!.nextConnection, child.previousConnection);
                        if (following) connect(tail(child).nextConnection, following.previousConnection);
                    }
                } else {
                    const upstream = target!.outputConnection?.targetConnection || target!.previousConnection?.targetConnection;
                    const following = target!.getNextBlock();
                    const position = target!.getRelativeToSurfaceXY();
                    if (following) following.unplug(false);
                    target!.unplug(false);
                    if (upstream) connect(upstream, child.outputConnection || child.previousConnection);
                    else child.moveBy(position.x, position.y);
                    if (following) connect(tail(child).nextConnection, following.previousConnection);
                    target!.dispose(false);
                }
            }
            const next = descriptions(draft);
            const changes: AiPreview['changes'] = [];
            for (const [id, row] of original) {
                const updated = next.get(id);
                if (!updated) changes.push({ kind: 'removed', id, before: row.label });
                else if (updated.shape !== row.shape) changes.push({ kind: 'changed', id, before: row.label, after: updated.label });
            }
            for (const [id, row] of next) if (!original.has(id)) changes.push({ kind: 'added', id, after: row.label });
            assert(changes.length > 0, '这个方案没有改变任何积木');
            return { proposal, before, after: snapshot(draft), changes,
                added: changes.filter(c => c.kind === 'added').length,
                removed: changes.filter(c => c.kind === 'removed').length,
                changed: changes.filter(c => c.kind === 'changed').length };
        } finally { draft.dispose(); }
    });
}

// One native Blockly undo event preserves pre-existing undo history and all serializers.
class AiWorkspaceEvent extends Blockly.Events.Abstract {
    isBlank = false;
    type = 'ck_ai_workspace_edit';
    constructor(private workspace: Blockly.Workspace, private before: string, private after: string) {
        super(); this.workspaceId = workspace.id; this.group = Blockly.utils.idGenerator.genUid();
    }
    run(forward: boolean) {
        quiet(() => Blockly.serialization.workspaces.load(JSON.parse(forward ? this.after : this.before), this.workspace));
        // Undo/redo must refresh code generation, dirty state and recovery observers.
        const notice = new AiWorkspaceEvent(this.workspace, '', '');
        notice.recordUndo = false;
        Blockly.Events.fire(notice);
    }
}

export function applyAiPreview(workspace: Blockly.Workspace, preview: AiPreview) {
    assert(snapshot(workspace) === preview.before, '生成方案后工程已有变化，请重新生成，避免覆盖你的修改');
    try { quiet(() => Blockly.serialization.workspaces.load(JSON.parse(preview.after), workspace)); }
    catch (error) {
        quiet(() => Blockly.serialization.workspaces.load(JSON.parse(preview.before), workspace));
        throw new Error(`应用失败，已恢复原积木：${String(error)}`);
    }
    const event = new AiWorkspaceEvent(workspace, preview.before, snapshot(workspace));
    Blockly.Events.fire(event);
    return event;
}

export function aiBlockSchema(type: string, catalog: BlockSearchEntry[]) {
    const entry = aiAvailableCatalog(catalog).find(b => b.type === type);
    assert(entry && Blockly.Blocks[type], '当前板卡没有这种积木，请先搜索');
    const workspace = new Blockly.Workspace();
    return quiet(() => {
        try {
            let block: Blockly.Block;
            if (entry.xml_template) {
                const dom = Blockly.utils.xml.textToDom(entry.xml_template);
                const node = dom.tagName.toLowerCase() === 'block' ? dom : dom.querySelector('block');
                assert(node, '积木模板缺少 block');
                block = Blockly.Xml.domToBlock(node, workspace);
            } else block = workspace.newBlock(type);
            const template = Blockly.serialization.blocks.save(block, { saveIds: false, doFullSerialization: true });
            // This workspace is temporary. Its variable IDs change on every
            // inspection and cannot identify either a schema or a user variable.
            // Keep the serializable name/type pair, including in nested templates.
            const variableValue = (id: string | null) => {
                if (id === null) return null;
                const variable = workspace.getVariableMap().getVariableById(id);
                return variable ? { name: variable.getName(), type: variable.getType() } : id;
            };
            const stripIds = (state: any) => {
                if (!state || typeof state !== 'object') return;
                delete state.id;
                for (const [name, value] of Object.entries(state.fields || {}) as [string, any][]) {
                    if (value && typeof value === 'object' && typeof value.id === 'string' && workspace.getVariableMap().getVariableById(value.id)) state.fields[name] = variableValue(value.id);
                }
                for (const slot of Object.values(state.inputs || {}) as any[]) { stripIds(slot.block); stripIds(slot.shadow); }
                stripIds(state.next?.block);
            };
            stripIds(template);
            return { type, label: entry.display_name || block.toString(120), description: entry.description || '',
                template, fields: block.inputList.flatMap(input => input.fieldRow.filter(f => f.name).map(field => ({
                    name: field.name, value: field instanceof Blockly.FieldVariable ? variableValue(field.getValue()) : field.getValue(), editable: field.EDITABLE,
                    ...(field instanceof Blockly.FieldVariable ? { variable: true } : {}),
                    ...(field instanceof Blockly.FieldDropdown ? { dynamic: field.isOptionListDynamic(), options: field.getOptions(false).map(option => [typeof option[0] === 'string' ? option[0] : '图标选项', field instanceof Blockly.FieldVariable ? variableValue(option[1]) : option[1]]) } : {}),
                }))),
                inputs: block.inputList.filter(i => i.connection).map(i => ({ name: i.name,
                    kind: i.type === Blockly.inputs.inputTypes.STATEMENT ? 'statement' : 'value', accepts: i.connection?.getCheck() })),
                previous: Boolean(block.previousConnection), next: Boolean(block.nextConnection), hasOutput: Boolean(block.outputConnection), output: block.outputConnection?.getCheck() ?? null,
                hardware: entry.hardware ?? null, metadataSource: entry.source,
                capability: aiCapabilitySummary(entry) };
        } finally { workspace.dispose(); }
    });
}

export interface AiWorkspaceQuery {
    offset?: number; limit?: number; query?: string; ids?: string[]; subtreeId?: string;
}
export function aiReadWorkspace(workspace: Blockly.Workspace, queryOrOffset: AiWorkspaceQuery | number = {}, limit = 12) {
    const args = typeof queryOrOffset === 'number' ? { offset: queryOrOffset, limit } : queryOrOffset;
    assert(plain(args), '积木查询必须是对象');
    safeKeys(args, ['offset', 'limit', 'query', 'ids', 'subtreeId']);
    const start = args.offset ?? 0, count = args.limit ?? 12;
    assert(Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(count) && count >= 1 && count <= 20, '每页需要1–20个积木，offset为非负整数');
    assert(args.query == null || (typeof args.query === 'string' && args.query.length <= 160), '搜索词最多160字符');
    assert(args.ids == null || (Array.isArray(args.ids) && args.ids.length >= 1 && args.ids.length <= 20 && args.ids.every(id => typeof id === 'string')), 'ids需要1–20个积木ID');
    assert(args.subtreeId == null || typeof args.subtreeId === 'string', 'subtreeId必须是积木ID');
    const all = workspace.getAllBlocks(false), variables = workspace.getVariableMap().getAllVariables();
    const rows = all.map(block => ({ id: block.id, type: block.type,
            label: block.toString(160), parentId: block.getParent()?.id || null, nextId: block.getNextBlock()?.id || null,
            fields: Object.fromEntries(block.inputList.flatMap(i => i.fieldRow.filter(f => f.name).map(f => [f.name!, f.getValue()]))),
            inputs: block.inputList.filter(i => i.connection).map(i => ({ name: i.name, blockId: i.connection?.targetBlock()?.id || null })),
        }));
    let candidates = rows;
    if (args.ids) {
        const ids = [...new Set(args.ids)];
        for (const id of ids) assert(workspace.getBlockById(id), `目标积木不存在：${id}`);
        candidates = ids.map(id => rows.find(row => row.id === id)!);
    }
    if (args.subtreeId != null) {
        const root = workspace.getBlockById(args.subtreeId); assert(root, '子树积木不存在');
        const ids = new Set(root.getDescendants(false).map(block => block.id));
        candidates = candidates.filter(row => ids.has(row.id));
    }
    const query = args.query?.trim().toLowerCase();
    if (query) candidates = candidates.filter(row => {
        const names = Object.values(row.fields).flatMap(value => variables.filter(v => v.getId() === value).map(v => v.getName()));
        return JSON.stringify({ type: row.type, fields: row.fields, variables: names }).toLowerCase().includes(query);
    });
    const blocks: typeof rows = [];
    for (const row of candidates.slice(start, start + count)) {
        if (JSON.stringify([...blocks, row]).length > 22000) break;
        blocks.push(row);
    }
    assert(blocks.length || start >= candidates.length, '单个积木信息过大，无法完整读取');
    const usedVariables = new Set(blocks.flatMap(row => Object.values(row.fields)));
    return { total: candidates.length, workspaceTotal: all.length,
        nextOffset: start + blocks.length < candidates.length ? start + blocks.length : null,
        variables: variables.filter(v => !args.ids && !query && !args.subtreeId || usedVariables.has(v.getId())).map(v => ({ id: v.getId(), name: v.getName(), type: v.getType() })),
        blocks, note: '仅这些blocks已完整读取，可作为修改目标。query匹配本块字段/类型/变量名；父级和输入连接用ids精确回读，不必遍历全工程。' };
}

export function aiSelectedBlock(workspace: Blockly.Workspace): string | null {
    const selected = Blockly.common.getSelected();
    return selected instanceof Blockly.BlockSvg && selected.workspace === workspace ? selected.id : null;
}
