import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('dock observes the host, SVG and toolbox, including category close without a canvas gesture', async () => {
    const source = await read('./BlockDock.tsx');
    assert.match(source, /Blockly\.Events\.TOOLBOX_ITEM_SELECT/);
    assert.match(source, /observe\(workspace\.getInjectionDiv\(\)\)/);
    assert.match(source, /observe\(workspace\.getParentSvg\(\)\)/);
    assert.match(source, /observe\(toolboxElement\)/);
    assert.match(source, /rect\.width - occupiedWidth/);
    assert.doesNotMatch(source, /metrics\.viewWidth/);
    assert.match(source, /resizeObserver\?\.disconnect\(\)/);
    assert.match(source, /cancelAnimationFrame\(refreshFrameRef\.current\)/);
});

test('language controls do not refocus the close button when parent text rerenders', async () => {
    const source = await read('./AppearanceSettingsModal.tsx');
    assert.match(source, /onCloseRef\.current\(\)/);
    assert.match(source, /}, \[isOpen\]\)/);
    assert.doesNotMatch(source, /}, \[isOpen, onClose\]\)/);
    assert.match(source, /aria-pressed=\{uiLocale === locale\}/);
});

test('Dashboard no longer mounts the release promotion card or dialog', async () => {
    const source = await read('./Dashboard.tsx');
    assert.doesNotMatch(source, /ChangelogModal|LATEST_RELEASE_NOTE|dashboard\.release\./);
});
