export const UI_LOCALE_STORAGE_KEY = 'ck.i18n.uiLocale';
export const BLOCK_LOCALE_STORAGE_KEY = 'ck.i18n.blockLocale';

export const SUPPORTED_UI_LOCALES = ['zh-CN', 'en-US'] as const;
export const SUPPORTED_BLOCK_LOCALE_PREFERENCES = [
    'follow-ui',
    ...SUPPORTED_UI_LOCALES,
] as const;

export type UiLocale = (typeof SUPPORTED_UI_LOCALES)[number];
export type BlockLocalePreference = (typeof SUPPORTED_BLOCK_LOCALE_PREFERENCES)[number];

export const DEFAULT_UI_LOCALE: UiLocale = 'zh-CN';
export const DEFAULT_BLOCK_LOCALE: BlockLocalePreference = 'follow-ui';

export interface LocaleStorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

export interface LocalePreferences {
    uiLocale: UiLocale;
    blockLocale: BlockLocalePreference;
}

export const getBrowserLocaleStorage = (): LocaleStorageLike | null => {
    try {
        return typeof window !== 'undefined' ? window.localStorage : null;
    } catch {
        return null;
    }
};

export const normalizeUiLocale = (value: unknown): UiLocale | null => {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().replace('_', '-').toLowerCase();
    if (normalized === 'zh' || normalized === 'zh-cn' || normalized.startsWith('zh-hans')) {
        return 'zh-CN';
    }
    if (normalized === 'en' || normalized === 'en-us' || normalized.startsWith('en-')) {
        return 'en-US';
    }
    return null;
};

export const normalizeBlockLocalePreference = (value: unknown): BlockLocalePreference => (
    value === 'zh-CN' || value === 'en-US' || value === 'follow-ui'
        ? value
        : DEFAULT_BLOCK_LOCALE
);

export const detectSupportedSystemLocale = (
    languages: readonly unknown[],
): UiLocale | null => {
    for (const language of languages) {
        const supported = normalizeUiLocale(language);
        if (supported) return supported;
    }
    return null;
};

const browserLanguages = (): readonly string[] => {
    if (typeof navigator === 'undefined') return [];
    if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
        return navigator.languages;
    }
    return navigator.language ? [navigator.language] : [];
};

export const readLocalePreferences = (
    storage: LocaleStorageLike | null = getBrowserLocaleStorage(),
    systemLanguages: readonly unknown[] = browserLanguages(),
): LocalePreferences => {
    let storedUiLocale: string | null = null;
    let storedBlockLocale: string | null = null;
    try {
        storedUiLocale = storage?.getItem(UI_LOCALE_STORAGE_KEY) ?? null;
        storedBlockLocale = storage?.getItem(BLOCK_LOCALE_STORAGE_KEY) ?? null;
    } catch {
        // A denied storage backend must not prevent CK from starting.
    }

    return {
        uiLocale: normalizeUiLocale(storedUiLocale)
            ?? detectSupportedSystemLocale(systemLanguages)
            ?? DEFAULT_UI_LOCALE,
        blockLocale: normalizeBlockLocalePreference(storedBlockLocale),
    };
};

export const persistUiLocale = (
    locale: UiLocale,
    storage: LocaleStorageLike | null = getBrowserLocaleStorage(),
): void => {
    try {
        storage?.setItem(UI_LOCALE_STORAGE_KEY, locale);
    } catch {
        // Language switching remains available when persistence is unavailable.
    }
};

export const persistBlockLocalePreference = (
    locale: BlockLocalePreference,
    storage: LocaleStorageLike | null = getBrowserLocaleStorage(),
): void => {
    try {
        storage?.setItem(BLOCK_LOCALE_STORAGE_KEY, normalizeBlockLocalePreference(locale));
    } catch {
        // Language switching remains available when persistence is unavailable.
    }
};

export const resolveBlockLocale = (
    preference: BlockLocalePreference,
    uiLocale: UiLocale,
): UiLocale => preference === 'follow-ui' ? uiLocale : preference;

