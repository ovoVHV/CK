import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./blockly_visual_style.ts', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
    },
    fileName: 'blockly_visual_style.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
    [],
);
const visualStyle = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

test('defaults invalid preferences to original and keeps every skin on CK geometry', () => {
    assert.equal(visualStyle.normalizeBlocklyVisualStyle(undefined), 'original');
    assert.equal(visualStyle.normalizeBlocklyVisualStyle('unexpected'), 'original');
    assert.equal(visualStyle.normalizeBlocklyVisualStyle('original'), 'original');
    assert.equal(visualStyle.blocklyRendererForVisualStyle('pastel'), 'thrasos');
    assert.equal(visualStyle.blocklyRendererForVisualStyle('arcade'), 'thrasos');
    assert.equal(visualStyle.blocklyRendererForVisualStyle('sticker'), 'thrasos');
    assert.equal(visualStyle.blocklyRendererForVisualStyle('neon'), 'thrasos');
    assert.equal(visualStyle.blocklyRendererForVisualStyle('mono'), 'thrasos');
});

test('persists one visual-only preference and tolerates storage denial', () => {
    const values = new Map();
    const storage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
    };
    assert.equal(visualStyle.persistBlocklyVisualStyle('sticker', storage), 'sticker');
    assert.equal(values.get(visualStyle.BLOCKLY_VISUAL_STYLE_STORAGE_KEY), 'sticker');
    assert.equal(visualStyle.readBlocklyVisualStyle(storage), 'sticker');
    assert.doesNotThrow(() => visualStyle.persistBlocklyVisualStyle('arcade', {
        setItem() { throw new Error('denied'); },
    }));
    assert.equal(visualStyle.readBlocklyVisualStyle({
        getItem() { throw new Error('denied'); },
    }), 'original');
});

test('migrates old renderer preferences into visual-only skins', () => {
    assert.equal(visualStyle.normalizeBlocklyVisualStyle('modern'), 'pastel');
    assert.equal(visualStyle.normalizeBlocklyVisualStyle('classic'), 'arcade');
    assert.equal(visualStyle.normalizeBlocklyVisualStyle('round'), 'sticker');
});

test('exposes the six built-in skins with one renderer and user-facing labels', () => {
    assert.deepEqual(
        visualStyle.BLOCKLY_VISUAL_STYLE_OPTIONS.map(option => [option.id, option.renderer]),
        [
            ['original', 'thrasos'],
            ['pastel', 'thrasos'],
            ['arcade', 'thrasos'],
            ['sticker', 'thrasos'],
            ['neon', 'thrasos'],
            ['mono', 'thrasos'],
        ],
    );
    visualStyle.BLOCKLY_VISUAL_STYLE_OPTIONS.forEach(option => {
        assert.ok(option.label.length > 0);
        assert.ok(option.description.length > 0);
    });
});
