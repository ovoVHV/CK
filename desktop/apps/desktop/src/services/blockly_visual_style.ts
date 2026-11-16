export const BLOCKLY_VISUAL_STYLE_STORAGE_KEY = 'ck_blockly_visual_style';

// Visual skins deliberately share one renderer.  These ids describe paint
// treatment only; they are not renderer/serialization versions.
export type BlocklyVisualStyle = 'original' | 'pastel' | 'arcade' | 'sticker' | 'neon' | 'mono';
export type BlocklyRendererName = 'thrasos';

export interface BlocklyVisualStyleStorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

export interface BlocklyVisualStyleOption {
    id: BlocklyVisualStyle;
    renderer: BlocklyRendererName;
    label: string;
    shortLabel: string;
    description: string;
}

export const BLOCKLY_VISUAL_STYLE_OPTIONS: readonly BlocklyVisualStyleOption[] = [
    {
        id: 'original',
        renderer: 'thrasos',
        label: '原版 CK',
        shortLabel: '原版',
        description: '保留 CK 默认配色与简洁边缘效果',
    },
    {
        id: 'pastel',
        renderer: 'thrasos',
        label: '浅色彩糖',
        shortLabel: '彩糖',
        description: '干净软色、圆润浅色字段，适合教学与日常创作',
    },
    {
        id: 'arcade',
        renderer: 'thrasos',
        label: '复古机能',
        shortLabel: '机能',
        description: '阶梯高光、硬描边和像素玩具般的厚重层次',
    },
    {
        id: 'sticker',
        renderer: 'thrasos',
        label: '手帐拼贴',
        shortLabel: '贴纸',
        description: '纸张颗粒、细缝线和暖色投影，保留多色分类',
    },
    {
        id: 'neon',
        renderer: 'thrasos',
        label: '霓虹荧光',
        shortLabel: '霓虹',
        description: '深色块体配荧光边缘，不用整块刺眼高亮',
    },
    {
        id: 'mono',
        renderer: 'thrasos',
        label: '石墨灰阶',
        shortLabel: '灰阶',
        description: '低干扰灰阶配色，适合专注阅读代码',
    },
] as const;

export const normalizeBlocklyVisualStyle = (value: unknown): BlocklyVisualStyle => {
    if (value === 'original' || value === 'pastel' || value === 'arcade' || value === 'sticker' || value === 'neon' || value === 'mono') return value;

    // Migrate the first renderer-oriented preference set into visual-only
    // skins.  The workspace always keeps CK's Thrasos geometry now.
    if (value === 'modern') return 'pastel';
    if (value === 'classic') return 'arcade';
    if (value === 'round') return 'sticker';
    // Preserve the pre-skin CK appearance for new/invalid preferences.
    return 'original';
};

export const getBrowserBlocklyVisualStyleStorage = (): BlocklyVisualStyleStorageLike | null => {
    try {
        return typeof window !== 'undefined' ? window.localStorage : null;
    } catch {
        return null;
    }
};

export const readBlocklyVisualStyle = (
    storage?: BlocklyVisualStyleStorageLike | null,
): BlocklyVisualStyle => {
    try {
        return normalizeBlocklyVisualStyle(storage?.getItem(BLOCKLY_VISUAL_STYLE_STORAGE_KEY));
    } catch {
        return 'original';
    }
};

export const persistBlocklyVisualStyle = (
    style: BlocklyVisualStyle,
    storage?: BlocklyVisualStyleStorageLike | null,
): BlocklyVisualStyle => {
    const normalized = normalizeBlocklyVisualStyle(style);
    try {
        storage?.setItem(BLOCKLY_VISUAL_STYLE_STORAGE_KEY, normalized);
    } catch {
        // Visual preferences must never block editing when storage is denied.
    }
    return normalized;
};

export const blocklyRendererForVisualStyle = (
    style: BlocklyVisualStyle,
): BlocklyRendererName => (
    BLOCKLY_VISUAL_STYLE_OPTIONS.find(option => option.id === normalizeBlocklyVisualStyle(style))
        ?.renderer || 'thrasos'
);

export const blocklyVisualStyleOption = (
    style: BlocklyVisualStyle,
): BlocklyVisualStyleOption => (
    BLOCKLY_VISUAL_STYLE_OPTIONS.find(option => option.id === normalizeBlocklyVisualStyle(style))
        || BLOCKLY_VISUAL_STYLE_OPTIONS[0]
);
