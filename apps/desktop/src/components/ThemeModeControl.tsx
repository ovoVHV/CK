import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, MonitorCog, Moon, Sun } from 'lucide-react';
import { useAppTheme } from '../contexts/ThemeContext';
import type { ThemeMode } from '../services/app_theme';

interface ThemeOption {
    mode: ThemeMode;
    label: string;
    description: string;
    Icon: typeof Sun;
}

const OPTIONS: ThemeOption[] = [
    { mode: 'light', label: '浅色', description: '明亮清晰的工作界面', Icon: Sun },
    { mode: 'dark', label: '深色', description: '降低夜间使用时的亮度', Icon: Moon },
    { mode: 'system', label: '跟随系统', description: '随 Windows 外观自动切换', Icon: MonitorCog },
];

const MENU_WIDTH = 224;
const VIEWPORT_MARGIN = 8;

interface MenuPosition {
    left: number;
    top: number;
}

export function ThemeModeControl() {
    const { mode, resolvedTheme, setThemeMode } = useAppTheme();
    const [open, setOpen] = useState(false);
    const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const current = OPTIONS.find(option => option.mode === mode) || OPTIONS[2];
    const CurrentIcon = current.Icon;

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
                    className="inline-flex h-9 items-center gap-2 rounded-full border border-slate-200 bg-slate-100/80 px-3 text-xs font-bold text-slate-600 transition-colors hover:border-teal-300 hover:bg-teal-50 hover:text-teal-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:border-teal-600 dark:hover:bg-teal-900/40 dark:hover:text-teal-200"
                    aria-haspopup="menu"
                    aria-expanded={open}
                    aria-controls={open ? 'ck-theme-mode-menu' : undefined}
                    title={`界面主题：${current.label}（当前显示为${resolvedTheme === 'dark' ? '深色' : '浅色'}）`}
                >
                    <CurrentIcon size={14} />
                    <span>{current.label}</span>
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
                    aria-label="选择界面主题"
                >
                    {OPTIONS.map(({ mode: optionMode, label, description, Icon }) => {
                        const selected = optionMode === mode;
                        return (
                            <button
                                key={optionMode}
                                type="button"
                                onClick={() => {
                                    setThemeMode(optionMode);
                                    setOpen(false);
                                }}
                                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${selected
                                    ? 'bg-teal-50 text-teal-800 dark:bg-teal-900/35 dark:text-teal-200'
                                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
                                role="menuitemradio"
                                aria-checked={selected}
                            >
                                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${selected
                                    ? 'bg-white text-teal-700 shadow-sm dark:bg-slate-800 dark:text-teal-300'
                                    : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}`}
                                >
                                    <Icon size={15} />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block text-xs font-bold">{label}</span>
                                    <span className="mt-0.5 block text-[9px] leading-4 text-slate-500 dark:text-slate-400">{description}</span>
                                </span>
                                {selected && <Check size={14} className="shrink-0 text-teal-600 dark:text-teal-300" />}
                            </button>
                        );
                    })}
                </div>
            , document.body)}
        </>
    );
}

export default ThemeModeControl;
