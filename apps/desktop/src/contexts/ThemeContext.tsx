import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useLayoutEffect,
    useMemo,
    useState,
    type ReactNode,
} from 'react';
import {
    APP_THEME_STORAGE_KEY,
    applyThemeToDocument,
    getBrowserThemeStorage,
    normalizeThemeMode,
    persistThemeMode,
    readPersistedThemeMode,
    resolveThemeMode,
    type ResolvedTheme,
    type ThemeMode,
} from '../services/app_theme';

export interface ThemeContextValue {
    mode: ThemeMode;
    resolvedTheme: ResolvedTheme;
    setThemeMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const readSystemDark = (): boolean => (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
);

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [mode, setMode] = useState<ThemeMode>(() => (
        readPersistedThemeMode(getBrowserThemeStorage())
    ));
    const [systemDark, setSystemDark] = useState(readSystemDark);
    const resolvedTheme = resolveThemeMode(mode, systemDark);

    const setThemeMode = useCallback((nextMode: ThemeMode) => {
        setMode(normalizeThemeMode(nextMode));
    }, []);

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        const handleChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
        setSystemDark(media.matches);
        media.addEventListener('change', handleChange);
        return () => media.removeEventListener('change', handleChange);
    }, []);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const handleStorage = (event: StorageEvent) => {
            if (event.key !== APP_THEME_STORAGE_KEY) return;
            setMode(normalizeThemeMode(event.newValue));
        };
        window.addEventListener('storage', handleStorage);
        return () => window.removeEventListener('storage', handleStorage);
    }, []);

    useLayoutEffect(() => {
        if (typeof document === 'undefined') return;
        applyThemeToDocument(mode, resolvedTheme, document.documentElement);
        persistThemeMode(mode, getBrowserThemeStorage());
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('ck-theme-change', {
                detail: { mode, resolvedTheme },
            }));
        }
    }, [mode, resolvedTheme]);

    const value = useMemo<ThemeContextValue>(() => ({
        mode,
        resolvedTheme,
        setThemeMode,
    }), [mode, resolvedTheme, setThemeMode]);

    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useAppTheme = (): ThemeContextValue => {
    const context = useContext(ThemeContext);
    if (!context) throw new Error('useAppTheme must be used inside ThemeProvider');
    return context;
};
