export const APP_THEME_STORAGE_KEY = 'app_theme';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export interface ThemeStorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

export const getBrowserThemeStorage = (): ThemeStorageLike | null => {
    try {
        return typeof window !== 'undefined' ? window.localStorage : null;
    } catch {
        return null;
    }
};

export const normalizeThemeMode = (value: unknown): ThemeMode => (
    value === 'light' || value === 'dark' || value === 'system'
        ? value
        : 'system'
);

export const readPersistedThemeMode = (storage?: ThemeStorageLike | null): ThemeMode => {
    try {
        return normalizeThemeMode(storage?.getItem(APP_THEME_STORAGE_KEY));
    } catch {
        return 'system';
    }
};

export const persistThemeMode = (
    mode: ThemeMode,
    storage?: ThemeStorageLike | null,
): void => {
    try {
        storage?.setItem(APP_THEME_STORAGE_KEY, normalizeThemeMode(mode));
    } catch {
        // Theme switching must remain usable when storage is unavailable.
    }
};

export const resolveThemeMode = (
    mode: ThemeMode,
    systemPrefersDark: boolean,
): ResolvedTheme => (
    mode === 'system'
        ? (systemPrefersDark ? 'dark' : 'light')
        : mode
);

export const applyThemeToDocument = (
    mode: ThemeMode,
    resolvedTheme: ResolvedTheme,
    root: HTMLElement | null | undefined,
): void => {
    if (!root) return;
    root.classList.toggle('dark', resolvedTheme === 'dark');
    root.classList.toggle('light', resolvedTheme === 'light');
    root.dataset.themeMode = mode;
    root.dataset.theme = resolvedTheme;
    root.style.colorScheme = resolvedTheme;
};

const systemPrefersDark = (): boolean => (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
);

/** Apply the saved mode before React renders to avoid a light-theme flash. */
export const bootstrapDocumentTheme = (): {
    mode: ThemeMode;
    resolvedTheme: ResolvedTheme;
} => {
    const storage = getBrowserThemeStorage();
    const mode = readPersistedThemeMode(storage);
    const resolvedTheme = resolveThemeMode(mode, systemPrefersDark());
    if (typeof document !== 'undefined') {
        applyThemeToDocument(mode, resolvedTheme, document.documentElement);
    }
    return { mode, resolvedTheme };
};
