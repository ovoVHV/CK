import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const themeControlSource = await readFile(new URL('./ThemeModeControl.tsx', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../index.css', import.meta.url), 'utf8');

test('theme menu is portalled above page stacking and clipping contexts', () => {
    assert.match(themeControlSource, /import \{ createPortal \} from 'react-dom'/);
    assert.match(themeControlSource, /data-ck-role="theme-mode-menu"/);
    assert.match(themeControlSource, /className="fixed z-\[10000\]/);
    assert.match(themeControlSource, /trigger\.getBoundingClientRect\(\)/);
    assert.match(themeControlSource, /!rootRef\.current\?\.contains\(target\) && !menuRef\.current\?\.contains\(target\)/);
});

test('final workspace surface rules pair light and dark flyout, workspace, grid, and scrollbar colours', () => {
    assert.match(cssSource, /\.ck-workspace-shell \{[\s\S]*?--ck-blockly-workspace: #fbfcfe;[\s\S]*?--ck-blockly-flyout: #f2f5f8;/);
    assert.match(cssSource, /\.dark \.ck-workspace-shell \{[\s\S]*?--ck-blockly-workspace: #0b1220;[\s\S]*?--ck-blockly-flyout: #111827;/);
    assert.match(cssSource, /\.ck-workspace-shell \.blocklyFlyoutBackground \{\s*fill: var\(--ck-blockly-flyout\) !important;/);
    assert.match(cssSource, /\.ck-workspace-shell \.blocklySvg \{\s*background-color: var\(--ck-blockly-workspace\) !important;/);
    assert.doesNotMatch(cssSource, /\.ck-workspace-shell \.blocklyMainBackground \{\s*fill:/, 'grid pattern fill must remain owned by Blockly');
    assert.match(cssSource, /pattern\[id\^="blocklyGridPattern"\] line \{\s*stroke: var\(--ck-blockly-grid\) !important;/);
    assert.match(cssSource, /\.ck-workspace-shell \.blocklyScrollbarHandle \{\s*fill: var\(--ck-blockly-scrollbar\) !important;/);

    const legacyLightRule = cssSource.search(/\.blocklyFlyoutBackground \{\r?\n\s*fill: #f8fafc/);
    const finalScopedRule = cssSource.search(/\.ck-workspace-shell \.blocklyFlyoutBackground \{\r?\n\s*fill: var\(--ck-blockly-flyout\)/);
    assert.ok(legacyLightRule >= 0 && finalScopedRule > legacyLightRule, 'scoped theme rule must win over the legacy light flyout override');
});

test('Blockly v12 fields and dark popovers use readable dark surfaces', () => {
    assert.match(cssSource, /\.blocklyEditableField>rect:not\(\.blocklyDropdownRect\)/);
    assert.match(cssSource, /\.blocklyNonEditableField>rect:not\(\.blocklyDropdownRect\)/);
    assert.match(cssSource, /--ck-blockly-field: #263449;/);
    assert.match(cssSource, /--ck-blockly-field-text: #f1f5f9;/);
    assert.match(cssSource, /\.dark \.blocklyDropDownDiv,[\s\S]*?background-color: #111827 !important;/);
    assert.match(cssSource, /\.dark \.blocklyWidgetDiv \.blocklyHtmlInput \{[\s\S]*?color: #f8fafc !important;/);
    assert.match(cssSource, /\.dark \.ck-workspace-shell \.blocklyShadow>\.blocklyPath \{[\s\S]*?filter: brightness\(0\.44\) saturate\(2\.25\) contrast\(1\.08\) !important;/);
    assert.match(cssSource, /\.dark \.ck-workspace-shell \.blocklyShadow \.blocklyFieldText,[\s\S]*?fill: #f8fafc !important;/);
});

test('dark signal-rail category labels and icons no longer retain low-contrast light colours', () => {
    assert.match(cssSource, /\.dark \.ck-blockly-toolbox-root \.blocklyToolboxCategory:not\(\.blocklyToolboxSelected\):not\(\.ck-toolbox-selected\) \{\s*color: #cbd5e1 !important;/);
    assert.match(cssSource, /\.dark \.ck-blockly-toolbox-root \.blocklyToolboxCategoryLabel::before \{[\s\S]*?filter: brightness\(0\) invert\(1\) !important;/);
    assert.match(cssSource, /background: color-mix\(in srgb, var\(--ck-toolbox-accent, #14b8a6\) 42%, #111827\) !important;/);
    assert.match(cssSource, /inset 3px 0 0 var\(--ck-toolbox-accent, #14b8a6\)/);
    assert.match(cssSource, /filter: drop-shadow\(0 0 4px var\(--ck-toolbox-accent, #14b8a6\)\)/);
});
