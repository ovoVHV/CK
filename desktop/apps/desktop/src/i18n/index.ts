import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { resources, I18N_NAMESPACES } from './resources';
import {
    DEFAULT_UI_LOCALE,
    getBrowserLocaleStorage,
    normalizeUiLocale,
    persistBlockLocalePreference,
    persistUiLocale,
    readLocalePreferences,
    type BlockLocalePreference,
    type LocalePreferences,
    type UiLocale,
} from './preferences';

export * from './preferences';
export { resources } from './resources';

const isDevelopment = import.meta.env.DEV;
let initializationPromise: Promise<typeof i18n> | null = null;
let documentLanguageListenerInstalled = false;

/** Same-window notification used by Blockly's presentation layer. */
export const BLOCK_LOCALE_PREFERENCE_CHANGED_EVENT = 'ck:i18n:block-locale-changed';

export const applyUiLocaleToDocument = (
    locale: UiLocale,
    root: HTMLElement | null | undefined = typeof document !== 'undefined'
        ? document.documentElement
        : null,
): void => {
    if (!root) return;
    root.lang = locale;
    root.dataset.uiLocale = locale;
};

const canonicalUiLocale = (language: string | undefined): UiLocale => (
    normalizeUiLocale(language) ?? DEFAULT_UI_LOCALE
);

const installDocumentLanguageListener = (): void => {
    if (documentLanguageListenerInstalled) return;
    i18n.on('languageChanged', language => {
        applyUiLocaleToDocument(canonicalUiLocale(language));
    });
    documentLanguageListenerInstalled = true;
};

export const getLocalePreferences = (): LocalePreferences => readLocalePreferences();

/**
 * Initialize the local resource bundle before React's first render. No product or
 * workspace state is read or written here; locale remains presentation-only.
 */
export const initializeI18n = (): Promise<typeof i18n> => {
    if (initializationPromise) return initializationPromise;

    const preferences = readLocalePreferences();
    applyUiLocaleToDocument(preferences.uiLocale);
    installDocumentLanguageListener();

    if (i18n.isInitialized) {
        initializationPromise = i18n.changeLanguage(preferences.uiLocale).then(() => i18n);
        return initializationPromise;
    }

    initializationPromise = i18n
        .use(initReactI18next)
        .init({
            resources,
            lng: preferences.uiLocale,
            supportedLngs: ['zh-CN', 'en-US'],
            fallbackLng: ['zh-CN'],
            defaultNS: 'common',
            ns: [...I18N_NAMESPACES],
            interpolation: {
                escapeValue: false,
            },
            initAsync: false,
            returnNull: false,
            returnEmptyString: false,
            saveMissing: isDevelopment,
            missingKeyHandler: (_languages, namespace, key) => {
                if (isDevelopment) {
                    console.error(`[i18n] Missing translation key: ${namespace}:${key}`);
                }
            },
        })
        .then(() => i18n);

    return initializationPromise;
};

export const changeUiLocale = async (locale: UiLocale): Promise<void> => {
    const storage = getBrowserLocaleStorage();
    persistUiLocale(locale, storage);
    applyUiLocaleToDocument(locale);
    if (!i18n.isInitialized) await initializeI18n();
    await i18n.changeLanguage(locale);
};

/** Persist the future Blockly language preference without changing Blockly yet. */
export const changeBlockLocalePreference = (
    locale: BlockLocalePreference,
): void => {
    persistBlockLocalePreference(locale, getBrowserLocaleStorage());
    // `storage` events do not fire in the same window that performs the write.
    // Emit a presentation-only event so the mounted Blockly workspace can
    // rebuild immediately without coupling locale state to project data.
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        try {
            window.dispatchEvent(new CustomEvent(BLOCK_LOCALE_PREFERENCE_CHANGED_EVENT, {
                detail: { locale },
            }));
        } catch {
            // Restricted webviews may not expose CustomEvent; persistence is
            // still successful and callers can re-read the preference.
        }
    }
};

export default i18n;
