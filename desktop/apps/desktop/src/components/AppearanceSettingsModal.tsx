import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Languages, MonitorCog, Moon, Palette, Sun, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../contexts/ThemeContext';
import {
    BLOCK_LOCALE_PREFERENCE_CHANGED_EVENT,
    changeBlockLocalePreference,
    changeUiLocale,
    getLocalePreferences,
    type BlockLocalePreference,
    type UiLocale,
} from '../i18n';
import type { ThemeMode } from '../services/app_theme';
import {
    BLOCKLY_VISUAL_STYLE_OPTIONS,
    type BlocklyVisualStyle,
} from '../services/blockly_visual_style';
import { BlockVisualStyleSample } from './BlockVisualStyleControl';

interface AppearanceSettingsModalProps {
    updateSettings?: ReactNode;
    isOpen: boolean;
    blocklyVisualStyle: BlocklyVisualStyle;
    onBlocklyVisualStyleChange: (style: BlocklyVisualStyle) => void;
    blocklyVisualStyleDisabled?: boolean;
    onClose: () => void;
}

const THEME_OPTIONS = [
    {
        mode: 'light',
        labelKey: 'settings.appearance.interfaceTheme.options.light.label',
        descriptionKey: 'settings.appearance.interfaceTheme.options.light.description',
        Icon: Sun,
    },
    {
        mode: 'dark',
        labelKey: 'settings.appearance.interfaceTheme.options.dark.label',
        descriptionKey: 'settings.appearance.interfaceTheme.options.dark.description',
        Icon: Moon,
    },
    {
        mode: 'system',
        labelKey: 'settings.appearance.interfaceTheme.options.system.label',
        descriptionKey: 'settings.appearance.interfaceTheme.options.system.description',
        Icon: MonitorCog,
    },
] as const satisfies ReadonlyArray<{
    mode: ThemeMode;
    labelKey: string;
    descriptionKey: string;
    Icon: typeof Sun;
}>;

export function AppearanceSettingsModal({
    updateSettings,
    isOpen,
    blocklyVisualStyle,
    onBlocklyVisualStyleChange,
    blocklyVisualStyleDisabled = false,
    onClose,
}: AppearanceSettingsModalProps) {
    const { t, i18n } = useTranslation();
    const { mode: themeMode, resolvedTheme, setThemeMode } = useAppTheme();
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const uiLocale: UiLocale = i18n.resolvedLanguage === 'en-US' ? 'en-US' : 'zh-CN';
    const [blockLocalePreference, setBlockLocalePreference] = useState<BlockLocalePreference>(
        () => getLocalePreferences().blockLocale,
    );

    useEffect(() => {
        if (!isOpen) return;
        const previousFocus = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        const focusFrame = requestAnimationFrame(() => closeButtonRef.current?.focus());
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            onCloseRef.current();
        };
        window.addEventListener('keydown', handleKeyDown, true);
        return () => {
            cancelAnimationFrame(focusFrame);
            window.removeEventListener('keydown', handleKeyDown, true);
            previousFocus?.focus();
        };
    }, [isOpen]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const handleBlockLocalePreferenceChanged = (event: Event) => {
            const next = (event as CustomEvent<{ locale?: unknown }>).detail?.locale;
            if (next === 'follow-ui' || next === 'zh-CN' || next === 'en-US') {
                setBlockLocalePreference(next);
            } else {
                setBlockLocalePreference(getLocalePreferences().blockLocale);
            }
        };
        window.addEventListener(
            BLOCK_LOCALE_PREFERENCE_CHANGED_EVENT,
            handleBlockLocalePreferenceChanged,
        );
        return () => window.removeEventListener(
            BLOCK_LOCALE_PREFERENCE_CHANGED_EVENT,
            handleBlockLocalePreferenceChanged,
        );
    }, []);

    if (!isOpen || typeof document === 'undefined') return null;

    return createPortal(
        <div
            className="fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-[2px]"
            data-ck-role="appearance-settings-backdrop"
            onPointerDown={event => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <section
                className="flex max-h-[calc(100vh-32px)] w-full max-w-[780px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
                role="dialog"
                aria-modal="true"
                aria-labelledby="appearance-settings-title"
                data-ck-role="appearance-settings-modal"
            >
                <header className="flex items-center gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-700">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
                        <Palette size={20} />
                    </span>
                    <div className="min-w-0 flex-1">
                        <h2 id="appearance-settings-title" className="text-base font-black text-slate-900 dark:text-white">
                            {t('settings.appearance.title')}
                        </h2>
                        <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                            {t('settings.appearance.subtitle')}
                        </p>
                    </div>
                    <button
                        ref={closeButtonRef}
                        type="button"
                        onClick={onClose}
                        className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                        aria-label={t('settings.appearance.closeAria')}
                    >
                        <X size={18} />
                    </button>
                </header>

                <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
                    {updateSettings}
                    <section aria-labelledby="settings-language-title">
                        <div className="mb-3">
                            <h3 id="settings-language-title" className="text-sm font-black text-slate-800 dark:text-slate-100">
                                {t('settings.language.title')}
                            </h3>
                            <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                                {t('settings.language.description')}
                            </p>
                        </div>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <div className="flex min-w-0 items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 dark:border-slate-700 dark:bg-slate-800/60">
                                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-brand-700 shadow-sm dark:bg-slate-900 dark:text-brand-200">
                                    <Languages size={17} />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <span id="ui-language-label" className="mb-2 block text-xs font-semibold text-slate-600 dark:text-slate-300">
                                        {t('settings.language.interfaceLabel')}
                                    </span>
                                    <div
                                        role="group"
                                        aria-labelledby="ui-language-label"
                                        data-ck-role="ui-locale-selector"
                                        className="grid grid-cols-2 gap-1 rounded-lg border border-slate-200 bg-white p-1 dark:border-slate-600 dark:bg-slate-950"
                                    >
                                        {(['zh-CN', 'en-US'] as const).map(locale => (
                                            <button
                                                key={locale}
                                                type="button"
                                                aria-pressed={uiLocale === locale}
                                                onClick={() => void changeUiLocale(locale)}
                                                className={`min-h-9 min-w-0 rounded-md px-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${uiLocale === locale
                                                    ? 'bg-brand-50 text-brand-800 ring-1 ring-inset ring-brand-300 dark:bg-brand-950 dark:text-brand-100 dark:ring-brand-700'
                                                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
                                            >
                                                {locale === 'zh-CN' ? '简体中文' : 'English'}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            <label className="flex min-w-0 items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 dark:border-slate-700 dark:bg-slate-800/60">
                                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                                    <Palette size={17} />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="mb-2 block text-xs font-semibold text-slate-600 dark:text-slate-300">
                                        {t('settings.language.blockLabel')}
                                    </span>
                                    <select
                                        value={blockLocalePreference}
                                        onChange={event => {
                                            const next = event.target.value as BlockLocalePreference;
                                            changeBlockLocalePreference(next);
                                            setBlockLocalePreference(next);
                                        }}
                                        aria-label={t('settings.language.blockLabel')}
                                        data-ck-role="block-locale-selector"
                                        className="h-11 w-full min-w-0 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-800 outline-none transition-colors focus:border-brand-500 focus:ring-2 focus:ring-brand-100 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-brand-400 dark:focus:ring-brand-950"
                                    >
                                        <option value="follow-ui">{t('settings.language.followInterface')}</option>
                                        <option value="zh-CN">{t('settings.language.options.zhCN')}</option>
                                        <option value="en-US">{t('settings.language.options.enUS')}</option>
                                    </select>
                                    <small className="mt-0.5 block text-[9px] leading-4 text-slate-400 dark:text-slate-500">
                                        {t('settings.language.blockDescription')}
                                    </small>
                                </span>
                            </label>
                        </div>
                    </section>

                    <section aria-labelledby="appearance-interface-theme-title">
                        <div className="mb-3 flex items-end justify-between gap-3">
                            <div>
                                <h3 id="appearance-interface-theme-title" className="text-sm font-black text-slate-800 dark:text-slate-100">
                                    {t('settings.appearance.interfaceTheme.title')}
                                </h3>
                                <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                                    {t('settings.appearance.interfaceTheme.current', {
                                        theme: t(`settings.appearance.interfaceTheme.options.${resolvedTheme}.label`),
                                    })}
                                </p>
                            </div>
                        </div>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                            {THEME_OPTIONS.map(({ mode, labelKey, descriptionKey, Icon }) => {
                                const selected = themeMode === mode;
                                return (
                                    <button
                                        key={mode}
                                        type="button"
                                        onClick={() => setThemeMode(mode)}
                                        className={`flex min-h-[76px] items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors ${selected
                                            ? 'border-brand-400 bg-brand-50 text-brand-800 ring-1 ring-brand-300 dark:border-brand-600 dark:bg-brand-950/45 dark:text-brand-100 dark:ring-brand-800'
                                            : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-brand-200 hover:bg-brand-50/50 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300 dark:hover:border-brand-800 dark:hover:bg-brand-950/25'}`}
                                        role="radio"
                                        aria-checked={selected}
                                        data-ck-role={`appearance-theme-${mode}`}
                                    >
                                        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${selected
                                            ? 'bg-white text-brand-700 shadow-sm dark:bg-slate-800 dark:text-brand-200'
                                            : 'bg-white text-slate-500 dark:bg-slate-900 dark:text-slate-400'}`}
                                        >
                                            <Icon size={17} />
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <strong className="block text-xs">{t(labelKey)}</strong>
                                            <small className="mt-1 block text-[9px] leading-4 opacity-75">{t(descriptionKey)}</small>
                                        </span>
                                        {selected && <Check size={15} className="shrink-0" />}
                                    </button>
                                );
                            })}
                        </div>
                    </section>

                    <section aria-labelledby="appearance-block-skin-title">
                        <div className="mb-3">
                            <h3 id="appearance-block-skin-title" className="text-sm font-black text-slate-800 dark:text-slate-100">
                                {t('settings.appearance.blockSkin.title')}
                            </h3>
                            <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                                {t('settings.appearance.blockSkin.description')}
                            </p>
                        </div>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label={t('settings.appearance.blockSkin.selectAria')}>
                            {BLOCKLY_VISUAL_STYLE_OPTIONS.map(option => {
                                const selected = option.id === blocklyVisualStyle;
                                return (
                                    <button
                                        key={option.id}
                                        type="button"
                                        onClick={() => onBlocklyVisualStyleChange(option.id)}
                                        disabled={blocklyVisualStyleDisabled}
                                        className={`flex min-h-[92px] items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors disabled:cursor-wait disabled:opacity-60 ${selected
                                            ? 'border-brand-400 bg-brand-50 text-brand-800 ring-1 ring-brand-300 dark:border-brand-600 dark:bg-brand-950/45 dark:text-brand-100 dark:ring-brand-800'
                                            : 'border-slate-200 bg-white text-slate-600 hover:border-brand-200 hover:bg-brand-50/40 dark:border-slate-700 dark:bg-slate-800/45 dark:text-slate-300 dark:hover:border-brand-800 dark:hover:bg-brand-950/20'}`}
                                        role="radio"
                                        aria-checked={selected}
                                        data-ck-role={`appearance-block-skin-${option.id}`}
                                    >
                                        <BlockVisualStyleSample style={option.id} />
                                        <span className="min-w-0 flex-1">
                                            <strong className="block text-xs">{t(`settings.appearance.blockSkin.styles.${option.id}.label`)}</strong>
                                            <small className="mt-1 block text-[9px] leading-4 opacity-75">{t(`settings.appearance.blockSkin.styles.${option.id}.description`)}</small>
                                        </span>
                                        {selected && <Check size={15} className="shrink-0" />}
                                    </button>
                                );
                            })}
                        </div>
                    </section>
                </div>

                <footer className="border-t border-slate-200 bg-slate-50 px-5 py-3 text-[10px] text-slate-500 dark:border-slate-700 dark:bg-slate-950/45 dark:text-slate-400">
                    {t('settings.appearance.footer')}
                </footer>
            </section>
        </div>,
        document.body,
    );
}

export default AppearanceSettingsModal;
