import assert from 'node:assert/strict';
import test from 'node:test';
import { unlink, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as Blockly from 'blockly';
import { build } from 'esbuild';
import ts from 'typescript';

const bundledGeneratorPath = join(
    dirname(fileURLToPath(import.meta.url)),
    `.ck-arduino-generator-source-map-${process.pid}-${Date.now()}.tmp.mjs`,
);
await build({
    entryPoints: [fileURLToPath(new URL('./arduino_generator.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    target: 'node20',
    outfile: bundledGeneratorPath,
    logLevel: 'silent',
});
let generatorModule;
try {
    generatorModule = await import(pathToFileURL(bundledGeneratorPath).href);
} finally {
    await unlink(bundledGeneratorPath).catch(() => undefined);
}

const {
    arduinoGenerator,
    getBlockIdForLine,
    getCompileSourceMap,
    getLineToBlockMap,
    stripBlockMarkers,
} = generatorModule;

Blockly.defineBlocksWithJsonArray([
    {
        type: 'ck_source_map_fixture_statement',
        message0: 'source fixture %1',
        args0: [{ type: 'input_value', name: 'VALUE' }],
        previousStatement: null,
        nextStatement: null,
        colour: 210,
    },
    {
        type: 'ck_source_map_fixture_expression',
        message0: 'dangerous expression',
        output: null,
        colour: 210,
    },
    {
        type: 'ck_source_map_plain_statement',
        message0: 'plain statement',
        previousStatement: null,
        nextStatement: null,
        colour: 210,
    },
    {
        type: 'controls_setup_custom',
        message0: 'setup %1',
        args0: [{ type: 'input_statement', name: 'DO' }],
        colour: 210,
    },
]);

arduinoGenerator.forBlock.ck_source_map_fixture_expression = function () {
    return ['dangerous_unicode_值()', arduinoGenerator.ORDER_ATOMIC];
};

arduinoGenerator.forBlock.ck_source_map_fixture_statement = function (block) {
    const value = arduinoGenerator.valueToCode(
        block,
        'VALUE',
        arduinoGenerator.ORDER_ATOMIC,
    ) || '0';
    arduinoGenerator.addDeclaration(
        'fixture_definition',
        'int fixture_first = 1;\nint fixture_second = 2;',
    );
    arduinoGenerator.addSetup(
        'fixture_setup',
        'fixture_first = 3;\nfixture_second = 4;',
    );
    return `  consume(\n    ${value}\n  );\n`;
};

arduinoGenerator.forBlock.ck_source_map_plain_statement = function () {
    return '  child_first();\n  child_second();\n';
};

const buildFixture = () => {
    const workspace = new Blockly.Workspace();
    const parent = workspace.newBlock(
        'ck_source_map_fixture_statement',
        '父积木*/🙂',
    );
    const expression = workspace.newBlock(
        'ck_source_map_fixture_expression',
        '子表达式🙂',
    );
    parent.getInput('VALUE').connection.connect(expression.outputConnection);
    return { workspace, parent, expression };
};

const findLine = (code, needle) => (
    code.split('\n').findIndex(line => line.includes(needle)) + 1
);

test('generator freezes statement, nested-expression, setup and definition provenance', () => {
    const { workspace, parent, expression } = buildFixture();
    const code = arduinoGenerator.workspaceToCode(workspace);
    const sourceMap = getCompileSourceMap();

    assert.ok(sourceMap, 'generation should freeze a compile source map');
    assert.equal(sourceMap.schema, 'ck-sourcemap');
    assert.equal(sourceMap.version, 1);
    assert.equal(sourceMap.file, 'sketch.ino');
    assert.match(sourceMap.codeSha256, /^[0-9a-f]{64}$/);
    assert.equal(sourceMap.lineCount, code.split('\n').length);

    const mappingsForParent = sourceMap.mappings.filter(
        mapping => mapping.blockId === parent.id,
    );
    assert.ok(mappingsForParent.some(mapping => (
        mapping.blockType === parent.type
        && mapping.section === 'loop'
        && mapping.confidence === 'exact'
    )));
    assert.ok(mappingsForParent.some(mapping => (
        mapping.blockType === parent.type
        && mapping.section === 'expression'
        && mapping.confidence === 'medium'
    )), 'nested expression lines should map to their owning statement block');
    assert.ok(mappingsForParent.some(mapping => (
        mapping.section === 'setup'
        && mapping.confidence === 'high'
    )));
    assert.ok(mappingsForParent.some(mapping => (
        mapping.section === 'definition'
        && mapping.confidence === 'high'
    )));
    assert.equal(
        sourceMap.mappings.some(mapping => mapping.blockId === expression.id),
        false,
        'an inlined value block must not masquerade as a standalone source span',
    );

    const expressionLine = findLine(code, 'dangerous_unicode_值()');
    assert.ok(expressionLine > 0);
    assert.equal(getBlockIdForLine(expressionLine), parent.id);
    assert.equal(getLineToBlockMap().get(expressionLine), parent.id);
    const expressionMapping = sourceMap.mappings.find(mapping => (
        mapping.section === 'expression'
        && expressionLine >= mapping.lineStart
        && expressionLine <= mapping.lineEnd
    ));
    assert.equal(expressionMapping?.blockId, parent.id);

    const finalParentLine = Math.max(...mappingsForParent.map(mapping => mapping.lineEnd));
    assert.ok(finalParentLine < sourceMap.lineCount);
    assert.equal(getLineToBlockMap().has(sourceMap.lineCount), false);
    workspace.dispose();
});

test('source markers are deterministic, preview-clean and do not shift debug lines', () => {
    const { workspace } = buildFixture();
    const firstCode = arduinoGenerator.workspaceToCode(workspace);
    const firstHash = getCompileSourceMap().codeSha256;
    const secondCode = arduinoGenerator.workspaceToCode(workspace);
    const secondHash = getCompileSourceMap().codeSha256;
    const preview = stripBlockMarkers(secondCode);

    assert.equal(secondCode, firstCode);
    assert.equal(secondHash, firstHash);
    assert.match(secondCode, /@ck-source-begin:v1:/);
    assert.match(secondCode, /@ck-source-end:v1:/);
    assert.match(secondCode, /@ck:v1:/, 'legacy debugger markers remain available');
    assert.doesNotMatch(preview, /@ck(?::|-source-)/);
    assert.equal(preview.split('\n').length, secondCode.split('\n').length);
    for (const needle of [
        'int fixture_first = 1;',
        'fixture_first = 3;',
        'dangerous_unicode_值()',
        'void loop()',
    ]) {
        assert.equal(findLine(preview, needle), findLine(secondCode, needle), `${needle} line offset`);
    }
    workspace.dispose();
});

test('copy uses the preview source while raw compilation and workspace identities stay intact', async () => {
    const { workspace } = buildFixture();
    const rawGeneratedCode = arduinoGenerator.workspaceToCode(workspace);
    const snapshot = JSON.stringify(Blockly.serialization.workspaces.save(workspace));
    const mapping = JSON.stringify(getCompileSourceMap());
    const userReadableCode = stripBlockMarkers(rawGeneratedCode);
    const source = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');
    assert.match(source, /const userReadableCode = useMemo\(\(\) => (?:codeViewOpen \? )?stripBlockMarkers\(generatedCode\)/);
    assert.match(source, /\{userReadableCode\}\s*<\/SyntaxHighlighter>/);
    const tree=ts.createSourceFile('Workspace.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    let handler;
    const visit=node=>{
        if(ts.isJsxOpeningElement(node)&&node.tagName.getText(tree)==='button'){
            const attrs=node.attributes.properties;
            if(attrs.some(a=>ts.isJsxAttribute(a)&&a.name.getText(tree)==='aria-label'&&a.initializer?.text==='复制代码')){
                handler=attrs.find(a=>ts.isJsxAttribute(a)&&a.name.getText(tree)==='onClick')?.initializer?.expression;
            }
        }
        ts.forEachChild(node,visit);
    };visit(tree);
    assert.ok(handler, 'exercise the actual clipboard handler');
    const targetModule=await build({entryPoints:[fileURLToPath(new URL('../services/project_build_target.ts',import.meta.url))],bundle:true,format:'esm',platform:'node',write:false,logLevel:'silent'});
    const {sourceWithBuildTarget}=await import('data:text/javascript;base64,'+Buffer.from(targetModule.outputFiles[0].text).toString('base64'));
    const target={board:'arduino:avr:uno',coreVersion:'1.8.8',fqbn:'arduino:avr:uno'};
    let copied;
    const run = new Function('navigator', 'userReadableCode', 'showToast', 'sourceWithBuildTarget','captureBuildTarget',`return (${handler.getText(tree)})();`);
    await run({ clipboard: { writeText: async value => { copied = value; } } }, userReadableCode, () => {},sourceWithBuildTarget,()=>target);
    assert.equal(copied, sourceWithBuildTarget(userReadableCode,target));
    assert(copied.endsWith(userReadableCode));assert(copied.includes(JSON.stringify(target)));
    assert.doesNotMatch(copied, /@ck-source-begin|@ck-source-end|@ck:v1/);
    assert.match(rawGeneratedCode, /@ck-source-begin/);
    assert.equal(JSON.stringify(getCompileSourceMap()), mapping);
    assert.equal(JSON.stringify(Blockly.serialization.workspaces.save(workspace)), snapshot);
    assert.equal(arduinoGenerator.workspaceToCode(workspace), rawGeneratedCode);
    assert.doesNotMatch(source, /code:\s*userReadableCode|setGeneratedCode\(userReadableCode\)|generatedCodeRef\.current\s*=\s*userReadableCode/);
    workspace.dispose();
});

test('unmodified third-party generator conventions automatically receive statement and registry mappings', () => {
    const type = 'vendor_without_diagnostic_metadata';
    Blockly.defineBlocksWithJsonArray([{
        type, message0: 'third-party sensor', previousStatement:null, nextStatement:null, colour:120,
    }]);
    // A normal legacy library generator: no CK diagnostic calls, flags or fields.
    arduinoGenerator[type] = function () {
        arduinoGenerator.includes_.vendor = '#include <VendorSensor.h>';
        arduinoGenerator.definitions_.vendor = 'VendorSensor sensor;';
        arduinoGenerator.setups_.vendor = 'sensor.begin();';
        return 'sensor.readMissing();\n';
    };
    const workspace = new Blockly.Workspace();
    const block = workspace.newBlock(type, 'vendor-no-metadata');
    const code = arduinoGenerator.workspaceToCode(workspace);
    const map = getCompileSourceMap();
    for (const needle of ['#include <VendorSensor.h>', 'VendorSensor sensor;', 'sensor.begin();', 'sensor.readMissing();']) {
        const line = findLine(code, needle);
        assert(line > 0, needle);
        assert.equal(getBlockIdForLine(line), block.id, needle);
        assert(map.mappings.some(m => m.blockId === block.id && line >= m.lineStart && line <= m.lineEnd && ['exact','high'].includes(m.confidence)), needle);
    }
    workspace.dispose();
});

test('declarative third-party libraries require no diagnostic metadata or author callbacks', async () => {
    const source = await readFile(new URL('../services/declarative_block_runtime.ts', import.meta.url),'utf8');
    const compiled = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
    const runtime = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
    const type = 'vendor_declarative_without_diagnostics';
    Blockly.defineBlocksWithJsonArray([{type,message0:'sensor pin %1',args0:[{type:'field_number',name:'PIN',value:7}],previousStatement:null,nextStatement:null,colour:180}]);
    const document = runtime.parseDeclarativeGeneratorDocument(JSON.stringify({schema:'ck-generator',version:1,rules:[{
        type,kind:'statement',template:'sensor.read({{field:PIN}});\n',
        includes:{sensor:'#include <GenericSensor.h>'},declarations:{sensor:'GenericSensor sensor;'},setup:{sensor:'sensor.begin();'},
    }]}));
    arduinoGenerator.forBlock[type] = runtime.bindDeclarativeGeneratorFunction(document.rules[0],arduinoGenerator);
    const workspace = new Blockly.Workspace();
    const block = workspace.newBlock(type,'declarative-no-diagnostics');
    const code=arduinoGenerator.workspaceToCode(workspace);
    for(const fragment of ['#include <GenericSensor.h>','GenericSensor sensor;','sensor.begin();','sensor.read(7);']) {
        const line=findLine(code,fragment);assert(line>0,fragment);assert.equal(getBlockIdForLine(line),block.id,fragment);
    }
    workspace.dispose();
});

test('structural setup and procedure children retain their actual sections', () => {
    const setupWorkspace = new Blockly.Workspace();
    const setup = setupWorkspace.newBlock('controls_setup_custom', 'setup-container');
    const setupChild = setupWorkspace.newBlock('ck_source_map_plain_statement', 'setup-child');
    setup.getInput('DO').connection.connect(setupChild.previousConnection);
    arduinoGenerator.workspaceToCode(setupWorkspace);
    const setupMap = getCompileSourceMap();
    assert.ok(setupMap.mappings.some(mapping => (
        mapping.blockId === setupChild.id
        && mapping.blockType === setupChild.type
        && mapping.section === 'setup'
        && mapping.confidence === 'exact'
    )));
    setupWorkspace.dispose();

    const procedureWorkspace = new Blockly.Workspace();
    const procedure = procedureWorkspace.newBlock('procedures_defnoreturn', 'definition-container');
    procedure.setFieldValue('fixtureProcedure', 'NAME');
    const definitionChild = procedureWorkspace.newBlock(
        'ck_source_map_plain_statement',
        'definition-child',
    );
    procedure.getInput('STACK').connection.connect(definitionChild.previousConnection);
    arduinoGenerator.workspaceToCode(procedureWorkspace);
    const definitionMap = getCompileSourceMap();
    assert.ok(definitionMap.mappings.some(mapping => (
        mapping.blockId === definitionChild.id
        && mapping.blockType === definitionChild.type
        && mapping.section === 'definition'
        && mapping.confidence === 'exact'
    )));
    procedureWorkspace.dispose();
});
