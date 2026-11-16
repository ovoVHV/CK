import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./blockly_locale.ts', import.meta.url), 'utf8');

// Execute the pure presentation bridge with small Blockly/preferences doubles.
// The production module still imports the real Blockly runtime; this keeps the
// unit test deterministic and avoids a DOM requirement in Node.
const runtimeShim = `
class Input {
    constructor() { this.calls = []; }
    appendField(field, name) { this.calls.push([field, name]); return this; }
}
class Block {
    setTooltip(value) { this.tooltip = value; return this; }
}
class FieldDropdown {
    setOptions(value) { this.options = typeof value === 'function' ? value.call(this) : value; return this; }
}
const Blockly = {
    Input,
    Block,
    FieldDropdown,
    locale: null,
    setLocale(messages) { this.locale = messages; },
};
globalThis.__BlocklyLocaleTest = { Input, Block, FieldDropdown };
const En = { MSG_HELLO: 'hello' };
const ZhHans = { MSG_HELLO: '你好' };
const DEFAULT_BLOCK_LOCALE = 'follow-ui';
const DEFAULT_UI_LOCALE = 'zh-CN';
const readLocalePreferences = () => ({ uiLocale: 'zh-CN', blockLocale: 'follow-ui' });
const resolveBlockLocale = (preference, uiLocale) => (
    preference === 'en-US' || (preference === 'follow-ui' && uiLocale === 'en-US')
        ? 'en-US'
        : 'zh-CN'
);
`;
const executableSource = source.replace(
    /import \* as Blockly from 'blockly';[\s\S]*?import \{[\s\S]*?\} from '\.\.\/i18n\/preferences';/,
    runtimeShim,
);
const transpiled = ts.transpileModule(executableSource, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
    },
    fileName: 'blockly_locale.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
    [],
);
const locale = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`);

test('effective Blockly locale follows UI or an explicit block preference', () => {
    assert.equal(locale.getEffectiveBlocklyLocale('follow-ui', 'en-US'), 'en-US');
    assert.equal(locale.getEffectiveBlocklyLocale('follow-ui', 'zh-CN'), 'zh-CN');
    assert.equal(locale.getEffectiveBlocklyLocale('en-US', 'zh-CN'), 'en-US');
});

test('category, block, and text labels are presentation-only', () => {
    assert.equal(locale.getBlocklyCategoryLabel('logic', 'en-US'), 'Logic');
    assert.equal(locale.getBlocklyBlockLabel('serial_print', 'en-US'), 'Print to serial');
    assert.equal(locale.translateBlocklyText('等待', 'en-US'), 'Wait');
    assert.equal(locale.translateBlocklyText('第2维下标', 'en-US'), 'Dimension 2 index');
    assert.equal(locale.translateBlocklyText('用户自定义说明', 'en-US'), '用户自定义说明');
});

test('plain labels and tooltips localize while dropdown values stay stable', () => {
    locale.applyBlocklyLocale('en-US');
    const input = new globalThis.__BlocklyLocaleTest.Input();
    input.appendField('等待');
    assert.equal(input.calls[0][0], 'Wait');

    const dropdown = new globalThis.__BlocklyLocaleTest.FieldDropdown();
    dropdown.setOptions([
        ['换行', 'TRUE'],
        ['variable', 'variable'],
    ]);
    assert.deepEqual(dropdown.options, [
        ['Newline', 'TRUE'],
        ['variable', 'variable'],
    ]);

    const block = new globalThis.__BlocklyLocaleTest.Block();
    block.setTooltip('等待');
    assert.equal(block.tooltip, 'Wait');
});

test('the bridge never rewrites identity-bearing dropdown values', () => {
    assert.match(source, /return \[translateBlocklyText\(item\[0\]\), item\[1\]\];/);
    assert.match(source, /if \(item\[0\] === item\[1\]\) return item;/);
    assert.match(source, /Blockly\.setLocale\(/);
    assert.match(source, /PROCEDURE_MESSAGES\[normalized\]/);
});
