import type { BlockSearchEntry } from '../types/library';
import {
    getBlocklyBlockLabel,
    getBlocklyCategoryLabel,
    translateBlocklyText,
    type BlocklyLocale,
} from './blockly_locale';

export type BlockDockPinKind = 'category' | 'library';

export interface BlockDockPin {
    key: string;
    kind: BlockDockPinKind;
    value: string;
    label: string;
}

export interface BlockDockPreferences {
    pins: BlockDockPin[];
    recentTypes: string[];
}

export interface BlockDockSearchOptions {
    query?: string;
    source?: 'all' | 'logic' | 'recent' | 'pin';
    pin?: BlockDockPin | null;
    recentTypes?: readonly string[];
    compatibleTypes?: ReadonlySet<string> | null;
    pins?: readonly BlockDockPin[];
    /** Presentation locale used for searching localized built-in labels. */
    locale?: BlocklyLocale;
    limit?: number;
}

export const BLOCK_DOCK_CATEGORY_IDS = {
    NETWORK: 'network',
    PINS: 'pins',
    TIME: 'time',
    LOGIC: 'logic',
    LOOPS: 'loops',
    FUNCTIONS: 'functions',
    SERIAL: 'serial',
    TEXT: 'text',
    ARRAYS: 'arrays',
    VARIABLES: 'variables',
    MATH: 'math',
} as const;

export type BlockDockCategoryId = typeof BLOCK_DOCK_CATEGORY_IDS[keyof typeof BLOCK_DOCK_CATEGORY_IDS] | string;

type BlockSearchEntryWithCategoryId = BlockSearchEntry & { categoryId?: string };

const STABLE_CATEGORY_ID = /^[a-z0-9][a-z0-9._:-]*$/u;

const LEGACY_CATEGORY_ALIASES = new Map<string, BlockDockCategoryId>([
    ['网络', BLOCK_DOCK_CATEGORY_IDS.NETWORK],
    ['network', BLOCK_DOCK_CATEGORY_IDS.NETWORK],
    ['引脚', BLOCK_DOCK_CATEGORY_IDS.PINS],
    ['pins', BLOCK_DOCK_CATEGORY_IDS.PINS],
    ['时间', BLOCK_DOCK_CATEGORY_IDS.TIME],
    ['time', BLOCK_DOCK_CATEGORY_IDS.TIME],
    ['逻辑', BLOCK_DOCK_CATEGORY_IDS.LOGIC],
    ['logic', BLOCK_DOCK_CATEGORY_IDS.LOGIC],
    ['循环', BLOCK_DOCK_CATEGORY_IDS.LOOPS],
    ['loops', BLOCK_DOCK_CATEGORY_IDS.LOOPS],
    ['函数', BLOCK_DOCK_CATEGORY_IDS.FUNCTIONS],
    ['functions', BLOCK_DOCK_CATEGORY_IDS.FUNCTIONS],
    ['串口', BLOCK_DOCK_CATEGORY_IDS.SERIAL],
    ['serial', BLOCK_DOCK_CATEGORY_IDS.SERIAL],
    ['文本', BLOCK_DOCK_CATEGORY_IDS.TEXT],
    ['text', BLOCK_DOCK_CATEGORY_IDS.TEXT],
    ['数组', BLOCK_DOCK_CATEGORY_IDS.ARRAYS],
    ['arrays', BLOCK_DOCK_CATEGORY_IDS.ARRAYS],
    ['变量', BLOCK_DOCK_CATEGORY_IDS.VARIABLES],
    ['variables', BLOCK_DOCK_CATEGORY_IDS.VARIABLES],
    ['运算', BLOCK_DOCK_CATEGORY_IDS.MATH],
    ['math', BLOCK_DOCK_CATEGORY_IDS.MATH],
]);

const BUILTIN_LOGIC_BLOCK_TYPES = new Set([
    'controls_if',
    'controls_switch_custom',
    'logic_compare',
    'logic_operation',
    'logic_negate',
    'logic_boolean',
    'logic_ternary',
    'logic_ternary_stmt_custom',
    'io_interrupts_disable',
    'io_interrupts_enable',
]);

export interface BlockDockConnectionShape {
    hasOutput: boolean;
    outputChecks: string[] | null;
    hasPrevious: boolean;
    previousChecks: string[] | null;
    hasNext: boolean;
}

const STORAGE_KEY = 'ck.blockDock.preferences';
const MAX_PINS = 3;
const MAX_RECENT_TYPES = 12;

export function normalizeBlockDockText(value: unknown): string {
    return String(value ?? '')
        .normalize('NFKC')
        .toLocaleLowerCase('zh-CN')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function stableCategoryId(value: unknown): BlockDockCategoryId | null {
    const candidate = String(value ?? '').trim();
    return STABLE_CATEGORY_ID.test(candidate) ? candidate : null;
}

function legacyCategoryId(value: unknown): BlockDockCategoryId | null {
    return LEGACY_CATEGORY_ALIASES.get(normalizeBlockDockText(value)) || null;
}

function stableIdentityToken(value: unknown): string {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/gu, '-')
        .replace(/^-+|-+$/g, '') || 'unknown';
}

export function blockDockRootCategory(entry: BlockSearchEntry): string {
    return String(entry.category || '其他')
        .split('/')
        .map(part => part.trim())
        .filter(Boolean)[0] || '其他';
}

/**
 * Resolve category identity without consulting the localized category label.
 *
 * Current built-in toolbox entries predate category ids, so their stable block
 * type is the compatibility source. New catalog producers can supply
 * category_id/categoryId directly without changing this consumer.
 */
export function blockDockCategoryId(entry: BlockSearchEntry): BlockDockCategoryId {
    const candidate = entry as BlockSearchEntryWithCategoryId;
    const explicit = stableCategoryId(candidate.category_id || candidate.categoryId);
    if (explicit) return explicit;

    const blockType = String(entry.type || '').trim();
    if (BUILTIN_LOGIC_BLOCK_TYPES.has(blockType)) return BLOCK_DOCK_CATEGORY_IDS.LOGIC;
    if (entry.library_id) return `library:${stableIdentityToken(entry.library_id)}`;
    return `toolbox-block:${stableIdentityToken(blockType)}`;
}

export function blockDockSourceLabel(entry: BlockSearchEntry): string {
    const category = String(entry.category || '').trim();
    if (category) {
        const parts = category.split('/').map(part => part.trim()).filter(Boolean);
        return parts[parts.length - 1] || category;
    }
    return String(entry.library_id || '其他积木').trim();
}

export function blockDockEntryMatchesPin(entry: BlockSearchEntry, pin: BlockDockPin): boolean {
    if (pin.kind === 'library') {
        return normalizeBlockDockText(entry.library_id) === normalizeBlockDockText(pin.value);
    }
    return blockDockCategoryId(entry) === pin.value;
}

/** Resolve current catalog copy without rewriting persisted pin identity. */
export function blockDockPinDisplayLabel(
    pin: BlockDockPin,
    entries: readonly BlockSearchEntry[],
): string {
    const currentEntry = entries.find(entry => blockDockEntryMatchesPin(entry, pin));
    if (!currentEntry) return pin.label;
    return pin.kind === 'library'
        ? blockDockSourceLabel(currentEntry)
        : blockDockRootCategory(currentEntry);
}

export function createBlockDockPin(entry: BlockSearchEntry): BlockDockPin {
    const libraryId = String(entry.library_id || '').trim();
    if (libraryId) {
        const label = blockDockSourceLabel(entry) || libraryId;
        return {
            key: `library:${normalizeBlockDockText(libraryId)}`,
            kind: 'library',
            value: libraryId,
            label,
        };
    }
    const categoryId = blockDockCategoryId(entry);
    const categoryLabel = blockDockRootCategory(entry);
    return {
        key: `category:${categoryId}`,
        kind: 'category',
        value: categoryId,
        label: categoryLabel,
    };
}

function isValidPin(value: unknown): value is BlockDockPin {
    if (!value || typeof value !== 'object') return false;
    const pin = value as Partial<BlockDockPin>;
    return (pin.kind === 'category' || pin.kind === 'library')
        && typeof pin.key === 'string'
        && typeof pin.value === 'string'
        && typeof pin.label === 'string'
        && Boolean(pin.key.trim() && pin.value.trim() && pin.label.trim());
}

function normalizeBlockDockPin(pin: BlockDockPin): BlockDockPin | null {
    if (pin.kind === 'library') {
        const value = pin.value.trim();
        return value ? {
            ...pin,
            key: `library:${normalizeBlockDockText(value)}`,
            value,
            label: pin.label.trim(),
        } : null;
    }

    // One-time compatibility adapter for preferences written before categoryId
    // existed. Unknown translated values are intentionally discarded instead
    // of remaining machine identity.
    const categoryId = stableCategoryId(pin.value)
        || legacyCategoryId(pin.value)
        || legacyCategoryId(pin.label);
    if (!categoryId) return null;
    return {
        key: `category:${categoryId}`,
        kind: 'category',
        value: categoryId,
        label: pin.label.trim(),
    };
}

export function normalizeBlockDockPreferences(value: unknown): BlockDockPreferences {
    const candidate = value && typeof value === 'object'
        ? value as Partial<BlockDockPreferences>
        : {};
    const pins = Array.isArray(candidate.pins)
        ? candidate.pins
            .filter(isValidPin)
            .map(normalizeBlockDockPin)
            .filter((pin): pin is BlockDockPin => Boolean(pin))
        : [];
    const uniquePins = pins.filter((pin, index) => (
        pins.findIndex(other => other.key === pin.key) === index
    )).slice(0, MAX_PINS);
    const recentTypes = Array.isArray(candidate.recentTypes)
        ? candidate.recentTypes
            .map(type => String(type || '').trim())
            .filter(Boolean)
        : [];
    return {
        pins: uniquePins,
        recentTypes: [...new Set(recentTypes)].slice(0, MAX_RECENT_TYPES),
    };
}

export function readBlockDockPreferences(storage?: Pick<Storage, 'getItem'> | null): BlockDockPreferences {
    if (!storage) return normalizeBlockDockPreferences(null);
    try {
        const raw = storage.getItem(STORAGE_KEY);
        return raw ? normalizeBlockDockPreferences(JSON.parse(raw)) : normalizeBlockDockPreferences(null);
    } catch {
        return normalizeBlockDockPreferences(null);
    }
}

export function writeBlockDockPreferences(
    preferences: BlockDockPreferences,
    storage?: Pick<Storage, 'setItem'> | null,
): void {
    if (!storage) return;
    try {
        storage.setItem(STORAGE_KEY, JSON.stringify(normalizeBlockDockPreferences(preferences)));
    } catch {
        // Preference persistence must never block editing.
    }
}

export function addRecentBlockType(recentTypes: readonly string[], blockType: string): string[] {
    const normalized = String(blockType || '').trim();
    if (!normalized) return [...recentTypes];
    return [normalized, ...recentTypes.filter(type => type !== normalized)].slice(0, MAX_RECENT_TYPES);
}

export function addBlockDockPin(pins: readonly BlockDockPin[], pin: BlockDockPin): BlockDockPin[] {
    return [pin, ...pins.filter(item => item.key !== pin.key)].slice(0, MAX_PINS);
}

export function blockDockChecksOverlap(left: string[] | null, right: string[] | null): boolean {
    if (!left || !right) return true;
    return left.some(check => right.includes(check));
}

export function blockDockShapeCanConnect(
    kind: 'value' | 'statement',
    targetChecks: string[] | null,
    hasExistingStatement: boolean,
    shape: BlockDockConnectionShape,
): boolean {
    if (kind === 'value') {
        return shape.hasOutput && blockDockChecksOverlap(targetChecks, shape.outputChecks);
    }
    return shape.hasPrevious
        && (!hasExistingStatement || shape.hasNext)
        && blockDockChecksOverlap(targetChecks, shape.previousChecks);
}

// Presentation search aliases, never hardware facts or claim declarations.
const DISCOVERY_SEARCH_ALIASES = [
    ['温度', 'temperature', 'thermal'], ['湿度', 'humidity'],
    ['显示', 'display', 'screen', '屏幕', 'oled'], ['传感器', 'sensor'],
    ['继电器', 'relay'], ['舵机', 'servo'],
    ['灯带', 'led strip', 'ws2812', 'neopixel'], ['串口', 'serial', 'uart'],
    ['模拟', 'analog', 'adc'], ['数字', 'digital', 'gpio'],
];
export function discoverySearchTerms(entry: BlockSearchEntry): string[] {
    const declared = [
        ...(entry.hardware?.resources?.map(resource => resource.kind) ?? []),
        ...(entry.hardware?.boards ?? []), ...(entry.hardware?.architectures ?? []),
        ...(entry.dependencies?.map(dependency => dependency.id) ?? []),
        ...(entry.requires ?? []), entry.semantics?.purpose ?? '', entry.semantics?.behavior ?? '',
    ];
    const text = [entry.display_name, entry.description, ...(entry.keywords ?? []),
        ...(entry.semantics?.concepts ?? []), ...declared].join(' ').toLowerCase();
    return [...declared, ...DISCOVERY_SEARCH_ALIASES.filter(group => group.some(word => text.includes(word))).flat()];
}

function entryHaystack(entry: BlockSearchEntry, locale?: BlocklyLocale): string {
    const localizedBlockLabel = locale
        ? getBlocklyBlockLabel(entry.type, locale)
        : '';
    const localizedCategory = locale && entry.category
        ? entry.category
            .split('/')
            .map(part => getBlocklyCategoryLabel(part.trim(), locale))
            .join(' / ')
        : '';
    return normalizeBlockDockText([
        entry.display_name,
        localizedBlockLabel,
        entry.type,
        entry.category,
        localizedCategory,
        entry.library_id,
        entry.description,
        locale ? translateBlocklyText(entry.description, locale) : '',
        ...(entry.keywords || []),
        ...(entry.semantics?.concepts || []),
        ...discoverySearchTerms(entry),
    ].filter(Boolean).join(' '));
}

function queryScore(entry: BlockSearchEntry, query: string, locale?: BlocklyLocale): number | null {
    if (!query) return 0;
    const normalizedQuery = normalizeBlockDockText(query);
    const terms = normalizedQuery.split(' ').filter(Boolean);
    const compactQuery = normalizedQuery.replace(/\s+/g, '');
    const haystack = entryHaystack(entry, locale);
    const compactHaystack = haystack.replace(/\s+/g, '');
    if (!terms.every(term => haystack.includes(term)) && !compactHaystack.includes(compactQuery)) {
        return null;
    }
    const name = normalizeBlockDockText([
        entry.display_name,
        locale ? getBlocklyBlockLabel(entry.type, locale) : '',
    ].filter(Boolean).join(' '));
    const type = normalizeBlockDockText(entry.type);
    const source = normalizeBlockDockText(`${entry.category || ''} ${entry.library_id || ''}`);
    let score = 0;
    if (name === normalizedQuery) score += 140;
    else if (name.startsWith(normalizedQuery)) score += 95;
    else if (name.includes(normalizedQuery)) score += 65;
    if (type === normalizedQuery) score += 85;
    else if (type.includes(normalizedQuery)) score += 45;
    if (source.includes(normalizedQuery)) score += 30;
    if (compactHaystack.includes(compactQuery)) score += 16;
    return score;
}

export function searchBlockDockEntries(
    entries: readonly BlockSearchEntry[],
    options: BlockDockSearchOptions = {},
): BlockSearchEntry[] {
    const {
        query = '',
        source = 'all',
        pin = null,
        recentTypes = [],
        compatibleTypes = null,
        pins = [],
        locale,
        limit = 60,
    } = options;
    const recentRank = new Map(recentTypes.map((type, index) => [type, recentTypes.length - index]));

    return entries
        .filter(entry => !compatibleTypes || compatibleTypes.has(entry.type))
        .filter(entry => {
            if (source === 'logic') return blockDockCategoryId(entry) === BLOCK_DOCK_CATEGORY_IDS.LOGIC;
            if (source === 'recent') return recentRank.has(entry.type);
            if (source === 'pin') return Boolean(pin && blockDockEntryMatchesPin(entry, pin));
            return true;
        })
        .map(entry => {
            const searchScore = queryScore(entry, query, locale);
            if (searchScore == null) return null;
            let priority = searchScore;
            priority += (recentRank.get(entry.type) || 0) * 8;
            if (pins.some(item => blockDockEntryMatchesPin(entry, item))) priority += 24;
            if (blockDockCategoryId(entry) === BLOCK_DOCK_CATEGORY_IDS.LOGIC) priority += 4;
            return { entry, priority };
        })
        .filter((item): item is { entry: BlockSearchEntry; priority: number } => Boolean(item))
        .sort((left, right) => right.priority - left.priority || (
            String(left.entry.display_name || left.entry.type).localeCompare(
                String(right.entry.display_name || right.entry.type),
                'zh-CN',
            )
        ))
        .slice(0, Math.max(1, limit))
        .map(item => item.entry);
}
