import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const workspaceSource = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');
const dockSource = await readFile(new URL('./BlockDock.tsx', import.meta.url), 'utf8');
const controlSource = await readFile(new URL('./BlockVisualStyleControl.tsx', import.meta.url), 'utf8');
const appearanceSource = await readFile(new URL('./AppearanceSettingsModal.tsx', import.meta.url), 'utf8');
const zhCNCommon = JSON.parse(await readFile(new URL('../locales/zh-CN/common.json', import.meta.url), 'utf8'));
const themeSource = await readFile(new URL('../theme/blockly_visual_themes.ts', import.meta.url), 'utf8');
const skinPainterSource = await readFile(new URL('../services/blockly_visual_skin.ts', import.meta.url), 'utf8');

const cssHexRgb = value => {
    const match = String(value).match(/^#([0-9a-f]{6})$/i);
    assert.ok(match, `expected a six-digit CSS colour, received ${value}`);
    return [0, 2, 4].map(index => Number.parseInt(match[1].slice(index, index + 2), 16));
};

const cssContrast = (left, right) => {
    const luminance = colour => {
        const channels = cssHexRgb(colour).map(channel => {
            const value = channel / 255;
            return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const [lighter, darker] = [luminance(left), luminance(right)].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
};

const skinCssVariables = (cssSource, style) => {
    const variables = {};
    const selectorToken = `[data-ck-blockly-skin='${style}']`;
    for (const rule of cssSource.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!rule[1].includes(selectorToken)) continue;
        for (const declaration of rule[2].matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{6})/gi)) {
            variables[declaration[1]] = declaration[2].toLowerCase();
        }
    }
    return variables;
};

test('renderer switching is an explicit lossless workspace transition', () => {
    assert.match(workspaceSource, /Blockly\.serialization\.workspaces\.save\(workspace\)/);
    assert.match(workspaceSource, /rendererTransitionRef\.current = \{/);
    assert.match(workspaceSource, /Blockly\.serialization\.workspaces\.load\(rendererTransition\.state, ws\)/);
    assert.match(workspaceSource, /ws\.setScale\(rendererTransition\.scale\)/);
    assert.match(workspaceSource, /ws\.scroll\(rendererTransition\.scrollX, rendererTransition\.scrollY\)/);
    assert.match(workspaceSource, /selectedBlockId[\s\S]*?getBlockById\(rendererTransition\.selectedBlockId\)\?\.select\(\)/);
    assert.match(workspaceSource, /Failed to restore renderer transition state/);
    assert.match(workspaceSource, /正在恢复原外观/);
});

test('all six visual skins keep one renderer and paired CK themes', () => {
    assert.match(workspaceSource, /renderer: rendererName/);
    assert.match(workspaceSource, /getBlocklyVisualTheme\(blocklyVisualStyle, resolvedTheme\)/);
    assert.match(workspaceSource, /currentRenderer === nextRenderer/);
    assert.match(workspaceSource, /setTheme\?\.\(nextTheme\)/);
    assert.match(workspaceSource, /\}, \[blocklyRendererRevision\]\);/);
    assert.match(workspaceSource, /data-ck-blockly-skin=\{blocklyVisualStyle\}/);
    assert.match(themeSource, /base: Blockly\.Themes\.Classic/);
    assert.match(themeSource, /original:[\s\S]*?pastel:[\s\S]*?arcade:[\s\S]*?sticker:[\s\S]*?neon:[\s\S]*?mono:/);
    assert.match(themeSource, /PASTEL_BLOCK_STYLES[\s\S]*?ARCADE_BLOCK_STYLES[\s\S]*?STICKER_BLOCK_STYLES/);
    assert.match(themeSource, /NEON_BLOCK_STYLES/);
    assert.match(themeSource, /MONO_BLOCK_STYLES/);
    assert.match(themeSource, /ORIGINAL_BLOCK_STYLES/);
    assert.match(themeSource, /componentStyles: colourMode === 'dark' \? DARK_COMPONENTS : LIGHT_COMPONENTS/);
    assert.doesNotMatch(themeSource, /Blockly\.Themes\.(?:Geras|Zelos)/);
    assert.doesNotMatch(themeSource, /generator|FQBN|schemaVersion/);
});

test('skin switching repaints rendered block paths instead of only changing theme metadata', () => {
    assert.match(workspaceSource, /applyBlocklyVisualSkin/);
    assert.match(skinPainterSource, /transformBlocklyBlockColour/);
    assert.match(skinPainterSource, /querySelectorAll\('\.blocklyBlock'\)/);
    assert.match(skinPainterSource, /skinPathFill\(path, transformed, style\)/);
    assert.match(skinPainterSource, /style\.setProperty\('fill', surfaceFill, 'important'\)/);
    assert.match(skinPainterSource, /getToolbox\?\.\(\)\?\.getFlyout/);
    assert.match(skinPainterSource, /workspace background|stage surface|generated source/i);
});

test('toolbox refresh always paints the current skin from the earliest input phase', () => {
    assert.match(workspaceSource, /const blocklyVisualStyleRef = useRef\(blocklyVisualStyle\)/);
    assert.match(workspaceSource, /blocklyVisualStyleRef\.current = blocklyVisualStyle/);
    assert.match(
        workspaceSource,
        /applyBlocklyVisualSkin\(workspace, blocklyVisualStyleRef\.current\)/,
    );
    assert.match(workspaceSource, /const previousHandler = wsAny\.__ckToolboxDomRefreshHandler/);
    assert.match(workspaceSource, /previousRoot\.removeEventListener\('pointerdown', previousHandler, true\)/);
    assert.match(workspaceSource, /toolboxRoot\.addEventListener\('pointerdown', refresh, true\)/);
    assert.doesNotMatch(workspaceSource, /toolboxRoot\.addEventListener\('pointerup', refresh, true\)/);
    assert.doesNotMatch(workspaceSource, /toolboxRoot\.addEventListener\('click', refresh, true\)/);
    assert.match(workspaceSource, /if \(blocklySkinPaintFrameRef\.current !== null\) return/);
    assert.doesNotMatch(workspaceSource, /if \(wsAny\.__ckToolboxDomHooksApplied\) return/);
});

test('new flyout blocks are painted before their first visible frame', () => {
    assert.match(
        workspaceSource,
        /const repaintBlocklyVisualSkin = useCallback[\s\S]*?applyBlocklyVisualSkin\(workspace, blocklyVisualStyleRef\.current\);[\s\S]*?scheduleBlocklyVisualSkin\(workspace\)/,
    );
    assert.match(workspaceSource, /queueMicrotask\(refreshVisuals\)/);
    assert.match(workspaceSource, /requestAnimationFrame\(refreshVisuals\)/);
    // MutationObserver runs before paint; refresh only changed roots, not all
    // project blocks. A full repaint here defeats large-workspace editing.
    assert.match(workspaceSource, /new MutationObserver[\s\S]*?applyBlocklyVisualSkinToRoots\(roots, blocklyVisualStyleRef\.current/);
    assert.match(workspaceSource, /currentColour !== visualColour\.toLowerCase\(\)/);
    assert.doesNotMatch(workspaceSource, /\[40, 180\]/);
    assert.doesNotMatch(
        workspaceSource,
        /const syncLoadedExtensionBlockColours[\s\S]*?scheduleBlocklyVisualSkin\(workspace\);\n\s*\}, \[extensionBlockColours/,
    );
});

test('skins use distinct materials and explicit field contrast in both app themes', async () => {
    const cssSource = await readFile(new URL('../index.css', import.meta.url), 'utf8');
    assert.match(skinPainterSource, /style === 'sticker'[\s\S]*?createElementNS\(SVG_NAMESPACE, 'pattern'\)/);
    assert.match(skinPainterSource, /style === 'arcade'[\s\S]*?appendGradientStop/);
    assert.match(skinPainterSource, /style === 'neon'[\s\S]*?appendGradientStop/);
    assert.match(skinPainterSource, /\.blocklyNonEditableField > rect/);
    assert.match(skinPainterSource, /\.blocklyDropdownField > \.blocklyDropdownRect/);
    for (const style of ['pastel', 'sticker', 'mono']) {
        assert.match(
            cssSource,
            new RegExp(`data-ck-blockly-skin=['"]${style}['"][\\s\\S]*?--ck-blockly-field-text:\\s*#1f2937`),
        );
    }
    for (const style of ['arcade', 'neon']) {
        assert.match(
            cssSource,
            new RegExp(`data-ck-blockly-skin=['"]${style}['"][\\s\\S]*?--ck-blockly-field-text:\\s*#f8fafc`),
        );
    }
    assert.match(cssSource, /blocklyEditableField \.blocklyText[\s\S]*?--ck-blockly-skin-field-text/);
    const blockLabelRule = cssSource.match(
        /data-ck-blockly-skin]:not\(\[data-ck-blockly-skin='original'\]\) \.blocklyBlock:not\(\.blocklyInsertionMarker\) \.blocklyText,[\s\S]*?\{([^}]*)\}/,
    );
    assert.ok(blockLabelRule, 'non-original skins need a dedicated ordinary-label rule');
    assert.match(blockLabelRule[1], /var\(--ck-block-skin-label,/);
    assert.doesNotMatch(blockLabelRule[1], /--ck-blockly-skin-field-text/);

    const fieldTextRule = cssSource.match(
        /data-ck-blockly-skin]:not\(\[data-ck-blockly-skin='original'\]\) \.blocklyBlock:not\(\.blocklyInsertionMarker\) \.blocklyEditableField \.blocklyText,[\s\S]*?\{([^}]*)\}/,
    );
    assert.ok(fieldTextRule, 'field values need a block-scoped rule strong enough to override ordinary labels');
    assert.match(fieldTextRule[1], /var\(--ck-blockly-skin-field-text\)/);
    assert.doesNotMatch(fieldTextRule[1], /--ck-block-skin-label/);
    assert.ok(
        cssSource.indexOf(fieldTextRule[0]) > cssSource.indexOf(blockLabelRule[0]),
        'field-value ink must be declared after the ordinary block-label ink',
    );
    for (const style of ['pastel', 'arcade', 'sticker', 'neon', 'mono']) {
        const variables = skinCssVariables(cssSource, style);
        const fieldSurface = variables['--ck-blockly-field'];
        const fieldText = variables['--ck-blockly-skin-field-text'];
        assert.ok(fieldSurface, `${style} needs an explicit field surface independent from block labels`);
        assert.ok(fieldText, `${style} needs an explicit field text colour independent from block labels`);
        assert.ok(
            cssContrast(fieldSurface, fieldText) >= 4.5,
            `${style} field values must keep at least 4.5:1 contrast`,
        );
    }
    const stickerPathRule = cssSource.match(
        /data-ck-blockly-skin='sticker'\] \.blocklyBlock:not\(\.blocklyInsertionMarker\)>\.blocklyPath,[\s\S]*?\{([^}]*)\}/,
    );
    assert.ok(stickerPathRule);
    assert.doesNotMatch(stickerPathRule[1], /(?:sepia|brightness|saturate)\(/);
});

test('shadow-block CSS uses an explicit outline without opacity or forced-filter readability hacks', async () => {
    const cssSource = await readFile(new URL('../index.css', import.meta.url), 'utf8');
    const shadowRules = [...cssSource.matchAll(/([^{}]*\.blocklyShadow[^{}]*)\{([^}]*)\}/g)];
    assert.ok(shadowRules.length > 0, 'shadow blocks need a dedicated visual rule');
    for (const [, selector, declarations] of shadowRules) {
        assert.doesNotMatch(
            declarations,
            /filter\s*:[^;]*!important/i,
            `${selector.trim()} must not override the skin material filter`,
        );
        assert.doesNotMatch(
            declarations,
            /fill-opacity\s*:/i,
            `${selector.trim()} must not wash out the shadow fill`,
        );
        if (/blockly(?:Text|FieldText|DropdownText)/.test(selector)) {
            assert.doesNotMatch(
                declarations,
                /(?:^|;)\s*opacity\s*:/i,
                `${selector.trim()} must not fade shadow text`,
            );
        }
    }
});

test('selection and highlight outlines are shared by every skin but yield to debug overlays', async () => {
    const cssSource = await readFile(new URL('../index.css', import.meta.url), 'utf8');
    const selectedSelector = '.ck-workspace-shell[data-ck-blockly-skin] .blocklyBlock.blocklySelected>.blocklyPath';
    const highlightedSelector = '.ck-workspace-shell[data-ck-blockly-skin] .blocklyBlock.blocklyHighlighted>.blocklyPath';
    const selectedIndex = cssSource.indexOf(selectedSelector);
    const highlightedIndex = cssSource.indexOf(highlightedSelector);
    assert.ok(
        selectedIndex >= 0,
        'selected-block rule must include the skin-bearing shell and .blocklyBlock specificity',
    );
    assert.ok(
        highlightedIndex >= 0,
        'highlighted-block rule must include the skin-bearing shell and .blocklyBlock specificity',
    );

    const selectedRule = cssSource.slice(selectedIndex).match(/^[^{]+\{([^}]*)\}/);
    const highlightedRule = cssSource.slice(highlightedIndex).match(/^[^{]+\{([^}]*)\}/);
    assert.ok(selectedRule);
    assert.ok(highlightedRule);
    for (const [state, declarations] of [
        ['selected', selectedRule[1]],
        ['highlighted', highlightedRule[1]],
    ]) {
        assert.match(declarations, /stroke\s*:\s*[^;]+!important/i, `${state} needs an authoritative visible stroke`);
        assert.match(declarations, /stroke-width\s*:\s*[^;]+!important/i, `${state} needs an authoritative visible stroke width`);
    }

    const debugSelectors = [
        '.ck-workspace-shell[data-ck-blockly-skin] .blocklyBlock.ck-block-compile-error:not(.ck-block-debug-paused)>.blocklyPath',
        '.ck-workspace-shell[data-ck-blockly-skin] .blocklyBlock.ck-block-has-breakpoint>.blocklyPath',
        '.ck-workspace-shell[data-ck-blockly-skin] .blocklyBlock.ck-block-debug-paused>.blocklyPath',
        ".ck-workspace-shell[data-ck-blockly-skin] .blocklyBlock.ck-block-trace-pending:not(.ck-block-debug-paused):not(.ck-block-has-breakpoint):not(.ck-block-compile-error)>.blocklyPath",
        ".ck-workspace-shell[data-ck-blockly-skin] .blocklyBlock.ck-block-trace-covered:not(.ck-block-debug-paused):not(.ck-block-has-breakpoint):not(.ck-block-compile-error)>.blocklyPath",
        ".ck-workspace-shell[data-ck-blockly-skin] .blocklyBlock.ck-block-trace-current:not(.ck-block-debug-paused):not(.ck-block-has-breakpoint):not(.ck-block-compile-error)>.blocklyPath",
    ];
    const interactionRuleEnd = Math.max(selectedIndex, highlightedIndex);
    for (const selector of debugSelectors) {
        const debugIndex = cssSource.indexOf(selector);
        assert.ok(debugIndex > interactionRuleEnd, `${selector} must come later and override selection/highlight`);
    }
});

test('trace CSS never overrides breakpoint or persistent compile-error outlines', async () => {
    const cssSource = await readFile(new URL('../index.css', import.meta.url), 'utf8');
    const compileErrorIndex = cssSource.indexOf(
        '.ck-workspace-shell[data-ck-blockly-skin] .blocklyBlock.ck-block-compile-error:not(.ck-block-debug-paused)>.blocklyPath',
    );
    assert.ok(
        compileErrorIndex >= 0,
        'compile-error rule must include the skin-bearing shell and .blocklyBlock specificity',
    );
    const compileErrorRule = cssSource.slice(compileErrorIndex).match(/^[^{]+\{([^}]*)\}/);
    assert.ok(compileErrorRule);
    assert.match(compileErrorRule[1], /stroke\s*:\s*#(?:dc2626|ef4444)\s*!important/i);
    assert.match(compileErrorRule[1], /stroke-width\s*:\s*[^;]+!important/i);

    for (const state of ['pending', 'covered', 'current']) {
        const selectorPrefix = `.ck-workspace-shell[data-ck-blockly-skin] .blocklyBlock.ck-block-trace-${state}`;
        const selectorStart = cssSource.indexOf(selectorPrefix);
        assert.ok(selectorStart > compileErrorIndex, `${state} trace rule must come after the persistent error rule`);
        const selector = cssSource.slice(selectorStart, cssSource.indexOf('{', selectorStart));
        assert.ok(
            selector.startsWith(selectorPrefix),
            `${state} must include the skin-bearing shell and .blocklyBlock specificity`,
        );
        assert.match(selector, /:not\(\.ck-block-has-breakpoint\)/, `${state} must preserve breakpoint red`);
        assert.match(selector, /:not\(\.ck-block-compile-error\)/, `${state} must preserve compile-error red`);
    }
});

test('debug overlays and visual Block Dock previews follow the rebuilt workspace', async () => {
    assert.match(workspaceSource, /refreshBlockBreakpointVisuals\([\s\S]*?blockDebugSessionRef\.current\.pausedBlockId/);
    assert.match(workspaceSource, /refreshBlockTraceVisuals\([\s\S]*?blockRunModeRef\.current === 'trace'/);
    assert.match(workspaceSource, /<BlockDock[\s\S]*?renderer=\{blocklyRendererForVisualStyle\(blocklyVisualStyle\)\}/);
    assert.match(workspaceSource, /<BlockDock[\s\S]*?visualStyle=\{blocklyVisualStyle\}/);
    assert.match(dockSource, /theme: Blockly\.Theme/);
    assert.match(dockSource, /applyBlocklyVisualSkin\(previewWorkspace, visualStyle\)/);
    assert.match(dockSource, /\}, \[blockLocale, open, previewRevision, renderer, results, themeKey, visualStyle, workspace\]\);/);
    assert.match(dockSource, /blockPreviewCacheKey\(entry, visualStyle, themeKey, renderer, blockLocale\)/);
    assert.match(dockSource, /setAttribute\(['"]data-ck-blockly-skin['"],\s*visualStyle\)/);
    assert.match(dockSource, /appendReferencedSkinPaintDefs\(block\.getSvgRoot\(\)\.ownerSVGElement, svg, root\)/);
    assert.match(dockSource, /data-ck-block-skin-preview-defs/);
    assert.doesNotMatch(
        await readFile(new URL('../index.css', import.meta.url), 'utf8'),
        /\.ck-block-dock-result-preview-svg[\s\S]{0,240}?fill:\s*#fff/,
    );
});

test('double restore failure remains fail-closed and keeps a recovery path', () => {
    assert.match(workspaceSource, /setIsReadOnly\(true\)/);
    assert.match(workspaceSource, /setRendererRecoveryFailure\(/);
    assert.match(workspaceSource, /data-ck-role="blockly-renderer-recovery-failure"/);
    assert.match(workspaceSource, /导出恢复快照/);
    assert.match(workspaceSource, /阻止编译\/上传/);
    assert.match(workspaceSource, /rendererRecoveryFailure/);
});

test('the view menu has one appearance entry and the dedicated modal owns both theme controls', () => {
    assert.doesNotMatch(workspaceSource, /<BlockVisualStyleControl/);
    assert.match(workspaceSource, /视图/);
    assert.equal(
        (workspaceSource.match(/data-ck-role="appearance-settings-action"/g) || []).length,
        1,
    );
    assert.match(workspaceSource, /setIsAppearanceSettingsOpen\(true\)/);
    assert.match(workspaceSource, /<AppearanceSettingsModal[\s\S]*?blocklyVisualStyle=\{blocklyVisualStyle\}/);
    assert.match(workspaceSource, /<AppearanceSettingsModal[\s\S]*?onBlocklyVisualStyleChange=\{handleBlocklyVisualStyleChange\}/);
    assert.doesNotMatch(workspaceSource, /BLOCKLY_VISUAL_STYLE_OPTIONS\.map\(option =>/);

    assert.match(appearanceSource, /createPortal\(/);
    assert.match(appearanceSource, /data-ck-role="appearance-settings-modal"/);
    assert.match(appearanceSource, /THEME_OPTIONS\.map\(/);
    assert.match(appearanceSource, /setThemeMode\(mode\)/);
    assert.match(appearanceSource, /BLOCKLY_VISUAL_STYLE_OPTIONS\.map\(option =>/);
    assert.match(appearanceSource, /onBlocklyVisualStyleChange\(option\.id\)/);
    assert.match(appearanceSource, /<BlockVisualStyleSample style=\{option\.id\}/);
    assert.match(appearanceSource, /settings\.appearance\.blockSkin\.description/);
    assert.match(zhCNCommon.settings.appearance.blockSkin.description, /主工作区、分类侧栏、快速积木、最近使用和固定积木预览/);
    assert.match(controlSource, /STYLE_SAMPLE_PALETTES:[\s\S]*?original:[\s\S]*?pastel:[\s\S]*?arcade:[\s\S]*?sticker:[\s\S]*?neon:[\s\S]*?mono:/);
});

test('visual skins do not own the workspace surface', async () => {
    const cssSource = await readFile(new URL('../index.css', import.meta.url), 'utf8');
    for (const style of ['original', 'pastel', 'arcade', 'sticker', 'neon', 'mono']) {
        const escaped = style.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const skinRules = [...cssSource.matchAll(new RegExp(`\\.ck-workspace-shell\\[data-ck-blockly-skin=['"]${escaped}['"]\\][^{]*\\{([^}]*)\\}`, 'g'))];
        for (const match of skinRules) {
            assert.doesNotMatch(match[1], /--ck-blockly-(?:workspace|flyout|grid|scrollbar)\s*:/, `${style} must not redefine app surface variables`);
        }
        assert.doesNotMatch(
            cssSource,
            new RegExp(`\\.ck-workspace-shell\\[data-ck-blockly-skin=['"]${escaped}['"]\\][^{]*\\}\\s*\\.blocklySvg`),
            `${style} must not override Blockly stage background`,
        );
    }
});
