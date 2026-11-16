import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, MonitorCog, Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../contexts/ThemeContext';
import type { ThemeMode } from '../services/app_theme';

const OPTIONS = [
    { mode: 'light', Icon: Sun },
    { mode: 'dark', Icon: Moon },
    { mode: 'system', Icon: MonitorCog },
] as const satisfies ReadonlyArray<{ mode: ThemeMode; Icon: typeof Sun }>;

const MENU_WIDTH = 224;
const VIEWPORT_MARGIN = 8;

interface MenuPosition {
    left: number;
    top: number;
}

export function ThemeModeControl() {
    const { t } = useTranslation();
    const { mode, resolvedTheme, setThemeMode } = useAppTheme();
    const [open, setOpen] = useState(false);
    const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const current = OPTIONS.find(option => option.mode === mode) || OPTIONS[2];
    const CurrentIcon = current.Icon;
    const currentLabel = t(`settings.appearance.interfaceTheme.options.${current.mode}.label`);

    const updateMenuPosition = useCallback(() => {
        const trigger = triggerRef.current;
        if (!trigger) return;

        const rect = trigger.getBoundingClientRect();
        const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN);
        const left = Math.min(Math.max(VIEWPORT_MARGIN, rect.right - MENU_WIDTH), maxLeft);
        const menuHeight = menuRef.current?.offsetHeight || 190;
        const belowTop = rect.bottom + VIEWPORT_MARGIN;
        const top = belowTop + menuHeight <= window.innerHeight - VIEWPORT_MARGIN
            ? belowTop
            : Math.max(VIEWPORT_MARGIN, rect.top - menuHeight - VIEWPORT_MARGIN);

        setMenuPosition({ left, top });
    }, []);

    useLayoutEffect(() => {
        if (!open) {
            setMenuPosition(null);
            return;
        }
        updateMenuPosition();
    }, [open, updateMenuPosition]);

    useEffect(() => {
        if (!open) return;
        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target as Node;
            if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown);
        window.addEventListener('resize', updateMenuPosition);
        window.addEventListener('scroll', updateMenuPosition, true);
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('resize', updateMenuPosition);
            window.removeEventListener('scroll', updateMenuPosition, true);
        };
    }, [open, updateMenuPosition]);

    return (
        <>
            <div ref={rootRef} className="relative shrink-0" data-ck-role="theme-mode-control">
                <button
                    ref={triggerRef}
                    type="button"
                    onClick={() => setOpen(previous => !previous)}
                    className="inline-flex h-9 items-center gap-2 rounded-full border border-slate-200 bg-slate-100/80 px-3 text-xs font-bold text-slate-600 transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:border-brand-600 dark:hover:bg-brand-900/40 dark:hover:text-brand-200"
                    aria-haspopup="menu"
                    aria-expanded={open}
                    aria-controls={open ? 'ck-theme-mode-menu' : undefined}
                    title={t('settings.appearance.interfaceTheme.triggerTitle', {
                        selected: currentLabel,
                        resolved: t(`settings.appearance.interfaceTheme.options.${resolvedTheme}.label`),
                    })}
                >
                    <CurrentIcon size={14} />
                    <span>{currentLabel}</span>
                </button>
            </div>

            {open && menuPosition && typeof document !== 'undefined' && createPortal(
                <div
                    ref={menuRef}
                    id="ck-theme-mode-menu"
                    data-ck-role="theme-mode-menu"
                    className="fixed z-[10000] overflow-hidden rounded-xl border border-slate-200 bg-white p-1.5 shadow-2xl dark:border-slate-600 dark:bg-slate-900"
                    style={{ left: menuPosition.left, top: menuPosition.top, width: MENU_WIDTH }}
                    role="menu"
                    aria-label={t('settings.appearance.interfaceTheme.selectAria')}
                >
                    {OPTIONS.map(({ mode: optionMode, Icon }) => {
                        const selected = optionMode === mode;
                        const label = t(`settings.appearance.interfaceTheme.options.${optionMode}.label`);
                        const description = t(`settings.appearance.interfaceTheme.options.${optionMode}.description`);
                        return (
                            <button
                                key={optionMode}
                                type="button"
                                onClick={() => {
                                    setThemeMode(optionMode);
                                    setOpen(false);
                                }}
                                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${selected
                                    ? 'bg-brand-50 text-brand-800 dark:bg-brand-900/35 dark:text-brand-200'
                                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
                                role="menuitemradio"
                                aria-checked={selected}
                            >
                                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${selected
                                    ? 'bg-white text-brand-700 shadow-sm dark:bg-slate-800 dark:text-brand-300'
                                    : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}`}
                                >
                                    <Icon size={15} />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block text-xs font-bold">{label}</span>
                                    <span className="mt-0.5 block text-[9px] leading-4 text-slate-500 dark:text-slate-400">{description}</span>
                                </span>
                                {selected && <Check size={14} className="shrink-0 text-brand-600 dark:text-brand-300" />}
                            </button>
                        );
                    })}
                </div>
            , document.body)}
        </>
    );
}

export default ThemeModeControl;
