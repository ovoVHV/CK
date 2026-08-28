import * as Blockly from 'blockly/core';

export const CKDarkTheme = Blockly.Theme.defineTheme('ck_dark', {
    name: 'ck_dark',
    base: Blockly.Themes.Classic,
    componentStyles: {
        workspaceBackgroundColour: '#0f172a', // Slate-900
        toolboxBackgroundColour: '#0f172a',   // Slate-900 (Unified with workspace for clean look)
        toolboxForegroundColour: '#e2e8f0',   // Slate-200
        flyoutBackgroundColour: '#1e293b',    // Slate-800
        flyoutForegroundColour: '#e2e8f0',    // Slate-200
        flyoutOpacity: 0.95,
        scrollbarColour: '#334155',           // Slate-700
        insertionMarkerColour: '#ffffff',
        insertionMarkerOpacity: 0.3,
        scrollbarOpacity: 0.4,

    },
    startHats: true,
});

export const CKLightTheme = Blockly.Theme.defineTheme('ck_light', {
    name: 'ck_light',
    base: Blockly.Themes.Classic,
    componentStyles: {
        workspaceBackgroundColour: '#ffffff',
        toolboxBackgroundColour: '#f1f5f9',   // Slate-100
        toolboxForegroundColour: '#334155',   // Slate-700
        flyoutBackgroundColour: '#ffffff',
        flyoutForegroundColour: '#334155',
        flyoutOpacity: 1,
        scrollbarColour: '#cbd5e1',           // Slate-300
        insertionMarkerColour: '#000000',
        insertionMarkerOpacity: 0.2,
        scrollbarOpacity: 0.4,
        cursorColour: '#000000'
    },
    startHats: true,
});
