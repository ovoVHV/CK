import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./block_dock.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
// The service tests intentionally execute a single transpiled module through
// a data: URL.  Keep the production import intact, but provide the tiny
// presentation-only dependency surface needed by these identity/search tests
// so Node does not have to resolve relative TypeScript imports from a data URL.
const blocklyLocaleShim = `
const getBlocklyBlockLabel = () => '';
const getBlocklyCategoryLabel = (value) => String(value ?? '');
const translateBlocklyText = (value) => String(value ?? '');
`;
const executableSource = source.replace(
    /import \{[\s\S]*?\} from '\.\/blockly_locale';/,
    blocklyLocaleShim,
);
const transpiled = ts.transpileModule(executableSource, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
    },
    fileName: 'block_dock.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
    [],
);
const dock = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`);

const entries = [
    { type: 'controls_if', display_name: '如果', category: 'Logic', keywords: ['if', '条件'], source: 'toolbox' },
    { type: 'logic_compare', display_name: '比较', category: 'Logik', keywords: ['compare'], source: 'toolbox' },
    { type: 'mpu_read', display_name: '读取 MPU6050 加速度 Y', category: '传感器 / MPU6050', library_id: 'ck-hw-mpu6050', keywords: ['mpu', 'y', '陀螺仪'], source: 'manifest' },
    { type: 'buzzer_on', display_name: '蜂鸣器开启', category: '执行器 / 蜂鸣器', library_id: 'ck-hw-buzzer', keywords: ['tone'], source: 'manifest' },
];

test('logic is a stable built-in dock source', () => {
    assert.deepEqual(
        dock.searchBlockDockEntries(entries, { source: 'logic' }).map(entry => entry.type).sort(),
        ['controls_if', 'logic_compare'].sort(),
    );
});

test('logic identity is independent from translated category labels', () => {
    assert.equal(dock.blockDockCategoryId(entries[0]), 'logic');
    assert.equal(dock.blockDockCategoryId({
        type: 'third_party_condition',
        category: '任意展示文案',
        category_id: 'logic',
        keywords: [],
        source: 'manifest',
    }), 'logic');
    assert.equal(dock.blockDockCategoryId({
        type: 'third_party_condition',
        category: '逻辑',
        keywords: [],
        source: 'manifest',
    }), 'toolbox-block:third_party_condition');
});

test('category pins persist categoryId while keeping the current label presentation-only', () => {
    const zhEntry = {
        type: 'controls_if',
        category_id: 'logic',
        category: '逻辑',
        keywords: [],
        source: 'toolbox',
    };
    const enEntry = { ...zhEntry, category: 'Logic' };
    const zhPin = dock.createBlockDockPin(zhEntry);
    const enPin = dock.createBlockDockPin(enEntry);

    assert.deepEqual(
        { key: zhPin.key, kind: zhPin.kind, value: zhPin.value },
        { key: enPin.key, kind: enPin.kind, value: enPin.value },
    );
    assert.equal(zhPin.value, 'logic');
    assert.equal(zhPin.label, '逻辑');
    assert.equal(enPin.label, 'Logic');
    assert.equal(dock.blockDockEntryMatchesPin(enEntry, zhPin), true);
    assert.equal(dock.blockDockPinDisplayLabel(zhPin, [enEntry]), 'Logic');
});

test('known legacy category-label pins migrate once and unknown translated identity is discarded', () => {
    const normalized = dock.normalizeBlockDockPreferences({
        pins: [
            { key: 'category:逻辑', kind: 'category', value: '逻辑', label: '逻辑' },
            { key: 'category:传感器', kind: 'category', value: '传感器', label: '传感器' },
        ],
        recentTypes: [],
    });
    assert.deepEqual(normalized.pins, [{
        key: 'category:logic',
        kind: 'category',
        value: 'logic',
        label: '逻辑',
    }]);
});

test('search covers Chinese, English aliases, library and function keywords', () => {
    assert.equal(dock.searchBlockDockEntries(entries, { query: 'mpu y' })[0].type, 'mpu_read');
    assert.equal(dock.searchBlockDockEntries(entries, { query: '陀螺仪' })[0].type, 'mpu_read');
    assert.equal(dock.searchBlockDockEntries(entries, { query: 'tone' })[0].type, 'buzzer_on');
});

test('connection compatibility set removes blocks that cannot be inserted', () => {
    const result = dock.searchBlockDockEntries(entries, {
        query: '',
        compatibleTypes: new Set(['logic_compare', 'mpu_read']),
    });
    assert.deepEqual(result.map(entry => entry.type), ['logic_compare', 'mpu_read']);
});

test('typed value slots and occupied statement slots reject structurally incompatible blocks', () => {
    const numberValue = {
        hasOutput: true,
        outputChecks: ['Number'],
        hasPrevious: false,
        previousChecks: null,
        hasNext: false,
    };
    const statement = {
        hasOutput: false,
        outputChecks: null,
        hasPrevious: true,
        previousChecks: null,
        hasNext: true,
    };
    const terminalStatement = { ...statement, hasNext: false };
    assert.equal(dock.blockDockShapeCanConnect('value', ['Number'], false, numberValue), true);
    assert.equal(dock.blockDockShapeCanConnect('value', ['Boolean'], false, numberValue), false);
    assert.equal(dock.blockDockShapeCanConnect('value', null, false, statement), false);
    assert.equal(dock.blockDockShapeCanConnect('statement', null, true, statement), true);
    assert.equal(dock.blockDockShapeCanConnect('statement', null, true, terminalStatement), false);
});

test('recent blocks rank first and stay unique', () => {
    const recent = dock.addRecentBlockType(['controls_if', 'mpu_read'], 'mpu_read');
    assert.deepEqual(recent, ['mpu_read', 'controls_if']);
    const result = dock.searchBlockDockEntries(entries, { recentTypes: recent });
    assert.equal(result[0].type, 'mpu_read');
});

test('only three temporary sources are pinned and persisted data is tolerant', () => {
    const pins = entries.slice(0, 4).reduce(
        (current, entry) => dock.addBlockDockPin(current, dock.createBlockDockPin(entry)),
        [],
    );
    assert.equal(pins.length, 3);
    assert.deepEqual(
        dock.normalizeBlockDockPreferences({
            pins: [...pins, { broken: true }],
            recentTypes: ['mpu_read', 'mpu_read', '', null],
        }).recentTypes,
        ['mpu_read'],
    );
});
