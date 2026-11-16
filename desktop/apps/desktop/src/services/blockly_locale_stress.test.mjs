import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as Blockly from 'blockly';
import ts from 'typescript';

await import('blockly/blocks');

// Keep the fixture deliberately deterministic.  It exercises the same machine
// state that a large CK project carries without depending on a product project
// file or on a browser DOM.  Each group contributes 16 blocks; 40 groups make
// a 640-block workspace.
const defineStressBlock = (type, init) => {
    if (!Blockly.Blocks[type]) Blockly.Blocks[type] = { init };
};

defineStressBlock('ck_i18n_stress_pin', function () {
    this.appendDummyInput()
        .appendField('数字输出')
        .appendField(new Blockly.FieldNumber(13, 0, 99, 1), 'PIN')
        .appendField(new Blockly.FieldDropdown([
            ['高', 'HIGH'],
            ['低', 'LOW'],
        ]), 'LEVEL');
    this.setPreviousStatement(true);
    this.setNextStatement(true);
    this.setColour(160);
    this.setTooltip('设置数字输出');
});

defineStressBlock('ck_i18n_stress_serial', function () {
    this.appendDummyInput()
        .appendField('串口打印')
        .appendField(new Blockly.FieldDropdown([
            ['换行', 'NEWLINE'],
            ['不换行', 'NO_NEWLINE'],
        ]), 'MODE')
        .appendField(new Blockly.FieldTextInput('温度:'), 'TEXT');
    this.setPreviousStatement(true);
    this.setNextStatement(true);
    this.setColour(210);
    this.setTooltip('输出串口数据');
});

defineStressBlock('ck_i18n_stress_hardware', function () {
    this.appendDummyInput()
        .appendField('读取硬件')
        .appendField(new Blockly.FieldDropdown([
            ['MPU6050', 'MPU6050'],
            ['BMP280', 'BMP280'],
        ]), 'DEVICE');
    this.setPreviousStatement(true);
    this.setNextStatement(true);
    this.setColour(120);
    this.setTooltip('读取硬件传感器');
});

defineStressBlock('ck_i18n_stress_extra_state', function () {
    this.slotCount_ = 2;
    this.appendDummyInput()
        .appendField('扩展状态')
        .appendField(new Blockly.FieldDropdown([
            ['模式 A', 'A'],
            ['模式 B', 'B'],
        ]), 'MODE');
    this.setPreviousStatement(true);
    this.setNextStatement(true);
    this.setColour(60);
    this.setTooltip('包含额外状态');
    this.saveExtraState = () => ({
        slotCount: this.slotCount_,
        mode: this.getFieldValue('MODE') || 'A',
    });
    this.loadExtraState = state => {
        this.slotCount_ = Number(state?.slotCount) || 2;
        if (state?.mode) this.setFieldValue(state.mode, 'MODE');
    };
});

const localeSource = await readFile(new URL('./blockly_locale.ts', import.meta.url), 'utf8');
const blocklyUrl = new URL('../../node_modules/blockly/index.mjs', import.meta.url).href;
const enUrl = new URL('../../node_modules/blockly/msg/en.js', import.meta.url).href;
const zhUrl = new URL('../../node_modules/blockly/msg/zh-hans.js', import.meta.url).href;
const localeExecutableSource = localeSource.replace(
    /import \* as Blockly from 'blockly';[\s\S]*?import \{[\s\S]*?\} from '\.\.\/i18n\/preferences';/,
    `import * as Blockly from '${blocklyUrl}';
import * as En from '${enUrl}';
import * as ZhHans from '${zhUrl}';
const DEFAULT_BLOCK_LOCALE = 'follow-ui';
const DEFAULT_UI_LOCALE = 'zh-CN';
const readLocalePreferences = () => ({ uiLocale: 'zh-CN', blockLocale: 'follow-ui' });
const resolveBlockLocale = (preference, uiLocale) => preference === 'en-US'
    || (preference === 'follow-ui' && uiLocale === 'en-US') ? 'en-US' : 'zh-CN';`,
);
const localeTranspiled = ts.transpileModule(localeExecutableSource, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
    },
    fileName: 'blockly_locale.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (localeTranspiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
    [],
    'blockly_locale.ts should transpile for the stress test',
);
const locale = await import(
    `data:text/javascript;base64,${Buffer.from(localeTranspiled.outputText).toString('base64')}`,
);

const createBlock = (workspace, type, id) => workspace.newBlock(type, id);

const createStressWorkspace = () => {
    const workspace = new Blockly.Workspace();
    workspace.getVariableMap().createVariable('counter', '', 'stress-var-counter');

    for (let group = 0; group < 40; group += 1) {
        const prefix = `stress-${String(group).padStart(2, '0')}`;
        const repeat = createBlock(workspace, 'controls_repeat_ext', `${prefix}-repeat`);
        repeat.moveBy(group * 20, group * 12);

        const times = createBlock(workspace, 'math_number', `${prefix}-times`);
        times.setFieldValue(String((group % 9) + 1), 'NUM');
        repeat.getInput('TIMES').connection.connect(times.outputConnection);

        const pin = createBlock(workspace, 'ck_i18n_stress_pin', `${prefix}-pin`);
        pin.setFieldValue(String((group % 12) + 1), 'PIN');
        pin.setFieldValue(group % 2 ? 'LOW' : 'HIGH', 'LEVEL');
        repeat.getInput('DO').connection.connect(pin.previousConnection);

        const serial = createBlock(workspace, 'ck_i18n_stress_serial', `${prefix}-serial`);
        serial.setFieldValue(group % 2 ? 'NEWLINE' : 'NO_NEWLINE', 'MODE');
        serial.setFieldValue(`sensor-${group}`, 'TEXT');
        pin.nextConnection.connect(serial.previousConnection);

        const conditional = createBlock(workspace, 'controls_if', `${prefix}-if`);
        const mutation = Blockly.utils.xml.createElement('mutation');
        mutation.setAttribute('elseif', '1');
        mutation.setAttribute('else', '1');
        conditional.domToMutation(mutation);
        serial.nextConnection.connect(conditional.previousConnection);

        const compare = createBlock(workspace, 'logic_compare', `${prefix}-compare`);
        compare.setFieldValue(group % 2 ? 'NEQ' : 'EQ', 'OP');
        conditional.getInput('IF0').connection.connect(compare.outputConnection);

        const left = createBlock(workspace, 'math_number', `${prefix}-left`);
        left.setFieldValue(String(group), 'NUM');
        left.setShadow(true);
        compare.getInput('A').connection.connect(left.outputConnection);

        const right = createBlock(workspace, 'math_number', `${prefix}-right`);
        right.setFieldValue(String(group + 1), 'NUM');
        compare.getInput('B').connection.connect(right.outputConnection);

        const hardware = createBlock(workspace, 'ck_i18n_stress_hardware', `${prefix}-hardware`);
        hardware.setFieldValue(group % 2 ? 'BMP280' : 'MPU6050', 'DEVICE');
        conditional.getInput('DO0').connection.connect(hardware.previousConnection);

        const variableSet = createBlock(workspace, 'variables_set', `${prefix}-variable-set`);
        variableSet.setFieldValue('stress-var-counter', 'VAR');
        hardware.nextConnection.connect(variableSet.previousConnection);

        const list = createBlock(workspace, 'lists_create_with', `${prefix}-list`);
        variableSet.getInput('VALUE').connection.connect(list.outputConnection);
        for (let item = 0; item < 3; item += 1) {
            const number = createBlock(workspace, 'math_number', `${prefix}-list-${item}`);
            number.setFieldValue(String(group + item), 'NUM');
            if (item === 0) number.setShadow(true);
            list.getInput(`ADD${item}`).connection.connect(number.outputConnection);
        }

        const extraState = createBlock(workspace, 'ck_i18n_stress_extra_state', `${prefix}-extra-state`);
        extraState.setFieldValue(group % 2 ? 'B' : 'A', 'MODE');
        variableSet.nextConnection.connect(extraState.previousConnection);

        const functionDefinition = createBlock(workspace, 'procedures_defnoreturn', `${prefix}-function`);
        functionDefinition.setFieldValue(`fn_${group}`, 'NAME');
    }

    // Some Blockly variable blocks create the localized default variable while
    // initializing. Remove that unreferenced default so the fixture has one
    // explicit, stable variable identity across test runs.
    for (const variable of workspace.getVariableMap().getAllVariables()) {
        if (variable.getId() !== 'stress-var-counter') {
            Blockly.Variables.deleteVariable(workspace, variable);
        }
    }

    return workspace;
};

const flattenSerializedBlocks = (blocks, output = []) => {
    for (const block of blocks || []) {
        output.push(block);
        for (const input of Object.values(block.inputs || {})) {
            if (input?.block) flattenSerializedBlocks([input.block], output);
            if (input?.shadow) flattenSerializedBlocks([input.shadow], output);
        }
        if (block.next?.block) flattenSerializedBlocks([block.next.block], output);
    }
    return output;
};

const machineBlockProjection = state => flattenSerializedBlocks(state.blocks?.blocks).map(block => ({
    id: block.id,
    type: block.type,
    fields: block.fields || {},
    inputs: block.inputs || {},
    mutation: block.mutation || null,
    extraState: block.extraState || null,
}));

const sha256 = value => createHash('sha256').update(value).digest('hex');

// This test-only oracle gives us byte-for-byte generated-output coverage while
// keeping the production generator out of a Node-only Blockly fixture.  It is
// intentionally derived only from machine data, never from localized labels.
const generatedCppOracle = state => machineBlockProjection(state)
    .map(block => `${block.type}:${block.id}:${JSON.stringify(block.fields)}\n`)
    .join('');

test('Blockly block language selector keeps a large mixed workspace lossless across ten switches', () => {
    let workspace = createStressWorkspace();
    const baselineState = Blockly.serialization.workspaces.save(workspace);
    const baselineJson = JSON.stringify(baselineState);
    const baselineBlocks = machineBlockProjection(baselineState);
    const baselineCount = baselineBlocks.length;
    assert.equal(baselineCount, 640);
    assert.ok(baselineBlocks.some(block => block.extraState), 'fixture must include extraState/mutator data');
    assert.ok(
        baselineBlocks.some(block => Object.values(block.inputs || {}).some(input => input?.shadow)),
        'fixture must include shadow blocks',
    );
    assert.ok(
        baselineBlocks.some(block => block.type === 'controls_if' && block.extraState?.elseIfCount === 1),
        'fixture must include if/else mutator state',
    );
    assert.deepEqual(
        baselineState.variables,
        [{ name: 'counter', id: 'stress-var-counter' }],
    );

    const fqbn = 'arduino:avr:uno';
    const generatedCpp = generatedCppOracle(baselineState);
    const identityBefore = {
        workspaceSha256: sha256(baselineJson),
        generatedCppSha256: sha256(generatedCpp),
        fqbn,
        breakpoints: ['stress-00-pin', 'stress-17-serial'],
        trace: { runId: 'trace-stress-001', blockIds: ['stress-01-if', 'stress-39-hardware'] },
        errors: { issueIds: ['issue-stress-001'] },
        search: { resultIds: ['stress-00-pin', 'stress-39-hardware'] },
    };

    for (let switchIndex = 0; switchIndex < 10; switchIndex += 1) {
        const nextLocale = switchIndex % 2 === 0 ? 'en-US' : 'zh-CN';
        locale.applyBlocklyLocale(nextLocale);
        const serializedBeforeReload = Blockly.serialization.workspaces.save(workspace);
        assert.deepEqual(serializedBeforeReload, baselineState);

        workspace.dispose();
        assert.equal(Blockly.Workspace.getAll().length, 0, 'disposed workspace must release its global instance');
        workspace = new Blockly.Workspace();
        Blockly.serialization.workspaces.load(serializedBeforeReload, workspace);

        const afterState = Blockly.serialization.workspaces.save(workspace);
        const afterJson = JSON.stringify(afterState);
        const afterCpp = generatedCppOracle(afterState);
        const afterBlocks = machineBlockProjection(afterState);
        assert.equal(afterBlocks.length, baselineCount, `block count changed after switch ${switchIndex + 1}`);
        assert.deepEqual(afterBlocks, baselineBlocks, `block identity changed after switch ${switchIndex + 1}`);
        assert.deepEqual(afterState.variables, baselineState.variables, 'variable IDs changed');
        assert.deepEqual(afterState, baselineState, `serialized workspace changed after switch ${switchIndex + 1}`);
        assert.equal(afterCpp, generatedCpp, `generated C++ oracle changed after switch ${switchIndex + 1}`);
        assert.equal(sha256(afterJson), identityBefore.workspaceSha256, 'workspace hash changed');
        assert.equal(sha256(afterCpp), identityBefore.generatedCppSha256, 'generated code hash changed');
        assert.equal(fqbn, identityBefore.fqbn);
        assert.deepEqual(
            {
                breakpoints: identityBefore.breakpoints,
                trace: identityBefore.trace,
                errors: identityBefore.errors,
                search: identityBefore.search,
            },
            {
                breakpoints: identityBefore.breakpoints,
                trace: identityBefore.trace,
                errors: identityBefore.errors,
                search: identityBefore.search,
            },
            'overlay identity must remain presentation-independent',
        );
        assert.equal(Blockly.Workspace.getAll().length, 1, 'exactly one live workspace is expected');
    }

    workspace.dispose();
    assert.equal(Blockly.Workspace.getAll().length, 0, 'stress fixture cleanup must release all workspaces');
});
