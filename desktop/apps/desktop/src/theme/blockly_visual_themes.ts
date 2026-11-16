import * as Blockly from 'blockly/core';
import type { ResolvedTheme } from '../services/app_theme';
import type { BlocklyVisualStyle } from '../services/blockly_visual_style';

/*
 * These are paint palettes for one CK block language. Every option keeps the
 * same Thrasos renderer and block definitions; only block colours, field
 * accents and edge treatment change. The application owns the stage surface,
 * so componentStyles are always selected by light/dark mode, never by skin.
 */
type BlockStyle = {
    colourPrimary: string;
    colourSecondary: string;
    colourTertiary: string;
};

type BlockStyleMap = Record<string, BlockStyle>;

const ORIGINAL_BLOCK_STYLES: BlockStyleMap = {
    hat_blocks: { colourPrimary: '#5B6FBE', colourSecondary: '#4D5FA8', colourTertiary: '#3C4B86' },
    logic_blocks: { colourPrimary: '#4169E1', colourSecondary: '#3556BA', colourTertiary: '#294491' },
    loop_blocks: { colourPrimary: '#20B2AA', colourSecondary: '#178E88', colourTertiary: '#116E6A' },
    math_blocks: { colourPrimary: '#6BAA16', colourSecondary: '#568A11', colourTertiary: '#41690D' },
    text_blocks: { colourPrimary: '#B9772A', colourSecondary: '#985F20', colourTertiary: '#754817' },
    procedure_blocks: { colourPrimary: '#8A57A5', colourSecondary: '#704486', colourTertiary: '#563468' },
    list_blocks: { colourPrimary: '#5F63B6', colourSecondary: '#4C4F95', colourTertiary: '#393B72' },
    variable_blocks: { colourPrimary: '#C05078', colourSecondary: '#A13D61', colourTertiary: '#7E304B' },
    variable_dynamic_blocks: { colourPrimary: '#A74F91', colourSecondary: '#883E75', colourTertiary: '#682E5A' },
};

const PASTEL_BLOCK_STYLES: BlockStyleMap = {
    hat_blocks: { colourPrimary: '#8AA7E8', colourSecondary: '#7290D1', colourTertiary: '#5B73B0' },
    logic_blocks: { colourPrimary: '#7E9DEB', colourSecondary: '#6885CF', colourTertiary: '#526AAA' },
    loop_blocks: { colourPrimary: '#69C3C0', colourSecondary: '#51A9A6', colourTertiary: '#3F8E8A' },
    math_blocks: { colourPrimary: '#B1D866', colourSecondary: '#96BD4D', colourTertiary: '#789E39' },
    text_blocks: { colourPrimary: '#F1B56C', colourSecondary: '#D99A53', colourTertiary: '#B8793D' },
    procedure_blocks: { colourPrimary: '#B69AE1', colourSecondary: '#997DC5', colourTertiary: '#795FA5' },
    list_blocks: { colourPrimary: '#A2B0EA', colourSecondary: '#8795D0', colourTertiary: '#6D78AE' },
    variable_blocks: { colourPrimary: '#EC9BB5', colourSecondary: '#D77B9A', colourTertiary: '#B85E7D' },
    variable_dynamic_blocks: { colourPrimary: '#DB9CCD', colourSecondary: '#BD7CB1', colourTertiary: '#9B6091' },
};

const ARCADE_BLOCK_STYLES: BlockStyleMap = {
    hat_blocks: { colourPrimary: '#FF8A1F', colourSecondary: '#D9650D', colourTertiary: '#9E4108' },
    logic_blocks: { colourPrimary: '#FF9D27', colourSecondary: '#D77A11', colourTertiary: '#A55508' },
    loop_blocks: { colourPrimary: '#00B8B0', colourSecondary: '#008D8B', colourTertiary: '#006364' },
    math_blocks: { colourPrimary: '#A6CF19', colourSecondary: '#7FA90D', colourTertiary: '#5B7907' },
    text_blocks: { colourPrimary: '#E6A800', colourSecondary: '#BA7F00', colourTertiary: '#875900' },
    procedure_blocks: { colourPrimary: '#B34DE0', colourSecondary: '#8830AE', colourTertiary: '#5E1C7C' },
    list_blocks: { colourPrimary: '#6558DE', colourSecondary: '#4D43B0', colourTertiary: '#352C82' },
    variable_blocks: { colourPrimary: '#EC3C83', colourSecondary: '#BF2868', colourTertiary: '#8A194A' },
    variable_dynamic_blocks: { colourPrimary: '#D83B89', colourSecondary: '#AB286A', colourTertiary: '#781B4B' },
};

const STICKER_BLOCK_STYLES: BlockStyleMap = {
    hat_blocks: { colourPrimary: '#7791C7', colourSecondary: '#5F76A8', colourTertiary: '#475A87' },
    logic_blocks: { colourPrimary: '#C97849', colourSecondary: '#A95E35', colourTertiary: '#834524' },
    loop_blocks: { colourPrimary: '#70B7A9', colourSecondary: '#55988D', colourTertiary: '#3D786F' },
    math_blocks: { colourPrimary: '#A4C95C', colourSecondary: '#83A744', colourTertiary: '#63842F' },
    text_blocks: { colourPrimary: '#E5AC5A', colourSecondary: '#C98E3D', colourTertiary: '#9E6D2D' },
    procedure_blocks: { colourPrimary: '#B67898', colourSecondary: '#975D7E', colourTertiary: '#764663' },
    list_blocks: { colourPrimary: '#65A6A8', colourSecondary: '#4F878A', colourTertiary: '#39686C' },
    variable_blocks: { colourPrimary: '#D47F9B', colourSecondary: '#B96280', colourTertiary: '#944A65' },
    variable_dynamic_blocks: { colourPrimary: '#C78CB4', colourSecondary: '#A96F98', colourTertiary: '#855579' },
};

const NEON_BLOCK_STYLES: BlockStyleMap = {
    hat_blocks: { colourPrimary: '#5E7BFF', colourSecondary: '#3F56D1', colourTertiary: '#27379A' },
    logic_blocks: { colourPrimary: '#3D8BFF', colourSecondary: '#2464D0', colourTertiary: '#174399' },
    loop_blocks: { colourPrimary: '#00D6C9', colourSecondary: '#00A99F', colourTertiary: '#007B75' },
    math_blocks: { colourPrimary: '#B8E52B', colourSecondary: '#8FBB12', colourTertiary: '#638600' },
    text_blocks: { colourPrimary: '#FFC52E', colourSecondary: '#D89500', colourTertiary: '#9D6500' },
    procedure_blocks: { colourPrimary: '#D45CFF', colourSecondary: '#A238D2', colourTertiary: '#6E1C99' },
    list_blocks: { colourPrimary: '#8B6CFF', colourSecondary: '#6548D1', colourTertiary: '#422A9A' },
    variable_blocks: { colourPrimary: '#FF5CA8', colourSecondary: '#D93682', colourTertiary: '#A31F5C' },
    variable_dynamic_blocks: { colourPrimary: '#FF62D3', colourSecondary: '#D63EAA', colourTertiary: '#9F257D' },
};

const MONO_BLOCK_STYLES: BlockStyleMap = {
    hat_blocks: { colourPrimary: '#94A3B8', colourSecondary: '#718096', colourTertiary: '#4B5563' },
    logic_blocks: { colourPrimary: '#64748B', colourSecondary: '#475569', colourTertiary: '#334155' },
    loop_blocks: { colourPrimary: '#A1A1AA', colourSecondary: '#737373', colourTertiary: '#525252' },
    math_blocks: { colourPrimary: '#D4D4D8', colourSecondary: '#A3A3A3', colourTertiary: '#737373' },
    text_blocks: { colourPrimary: '#A8A29E', colourSecondary: '#78716C', colourTertiary: '#57534E' },
    procedure_blocks: { colourPrimary: '#A1A1AA', colourSecondary: '#71717A', colourTertiary: '#52525B' },
    list_blocks: { colourPrimary: '#94A3B8', colourSecondary: '#64748B', colourTertiary: '#475569' },
    variable_blocks: { colourPrimary: '#B4B4B8', colourSecondary: '#858585', colourTertiary: '#5F5F63' },
    variable_dynamic_blocks: { colourPrimary: '#A3A3A3', colourSecondary: '#737373', colourTertiary: '#525252' },
};

const FONT_STYLE = {
    family: '"Inter", "Segoe UI", "Microsoft YaHei", "Roboto", Helvetica, Arial, sans-serif',
    weight: 'bold',
    size: 12,
} as const;

const LIGHT_COMPONENTS = {
    workspaceBackgroundColour: '#fbfcfe',
    toolboxBackgroundColour: '#f2f5f8',
    toolboxForegroundColour: '#475569',
    flyoutBackgroundColour: '#f2f5f8',
    flyoutForegroundColour: '#475569',
    flyoutOpacity: 0.98,
    scrollbarColour: '#aebdcb',
    scrollbarOpacity: 0.58,
    insertionMarkerColour: '#14b8a6',
    insertionMarkerOpacity: 0.32,
    cursorColour: '#14b8a6',
    markerColour: '#0f766e',
    selectedGlowColour: '#14b8a6',
    selectedGlowOpacity: 0.32,
    replacementGlowColour: '#d97706',
    replacementGlowOpacity: 0.34,
} as const;

const DARK_COMPONENTS = {
    workspaceBackgroundColour: '#0b1220',
    toolboxBackgroundColour: '#111827',
    toolboxForegroundColour: '#cbd5e1',
    flyoutBackgroundColour: '#111827',
    flyoutForegroundColour: '#cbd5e1',
    flyoutOpacity: 0.98,
    scrollbarColour: '#526177',
    scrollbarOpacity: 0.72,
    insertionMarkerColour: '#2dd4bf',
    insertionMarkerOpacity: 0.38,
    cursorColour: '#2dd4bf',
    markerColour: '#5eead4',
    selectedGlowColour: '#facc15',
    selectedGlowOpacity: 0.52,
    replacementGlowColour: '#fb923c',
    replacementGlowOpacity: 0.54,
} as const;

const blockStylesFor = (style: BlocklyVisualStyle): BlockStyleMap => {
    switch (style) {
        case 'original': return ORIGINAL_BLOCK_STYLES;
        case 'arcade': return ARCADE_BLOCK_STYLES;
        case 'sticker': return STICKER_BLOCK_STYLES;
        case 'neon': return NEON_BLOCK_STYLES;
        case 'mono': return MONO_BLOCK_STYLES;
        case 'pastel':
        default: return PASTEL_BLOCK_STYLES;
    }
};

const defineStyleTheme = (
    style: BlocklyVisualStyle,
    colourMode: ResolvedTheme,
): Blockly.Theme => Blockly.Theme.defineTheme(`ck_${style}_${colourMode}`, {
    name: `ck_${style}_${colourMode}`,
    base: Blockly.Themes.Classic,
    blockStyles: blockStylesFor(style),
    // The shell owns the stage/flyout surface. A sticker/neon skin therefore
    // cannot turn a dark workspace white or change the application backdrop.
    componentStyles: colourMode === 'dark' ? DARK_COMPONENTS : LIGHT_COMPONENTS,
    fontStyle: FONT_STYLE,
    startHats: true,
});

const THEMES: Record<BlocklyVisualStyle, Record<ResolvedTheme, Blockly.Theme>> = {
    original: {
        light: defineStyleTheme('original', 'light'),
        dark: defineStyleTheme('original', 'dark'),
    },
    pastel: {
        light: defineStyleTheme('pastel', 'light'),
        dark: defineStyleTheme('pastel', 'dark'),
    },
    arcade: {
        light: defineStyleTheme('arcade', 'light'),
        dark: defineStyleTheme('arcade', 'dark'),
    },
    sticker: {
        light: defineStyleTheme('sticker', 'light'),
        dark: defineStyleTheme('sticker', 'dark'),
    },
    neon: {
        light: defineStyleTheme('neon', 'light'),
        dark: defineStyleTheme('neon', 'dark'),
    },
    mono: {
        light: defineStyleTheme('mono', 'light'),
        dark: defineStyleTheme('mono', 'dark'),
    },
};

export const getBlocklyVisualTheme = (
    style: BlocklyVisualStyle,
    colourMode: ResolvedTheme,
): Blockly.Theme => THEMES[style]?.[colourMode] || THEMES.original[colourMode];

// Backwards-compatible aliases for code that only switches light/dark mode.
export const CKModernLightTheme = THEMES.pastel.light;
export const CKModernDarkTheme = THEMES.pastel.dark;
