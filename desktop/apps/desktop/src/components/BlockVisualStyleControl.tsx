import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Palette } from 'lucide-react';
import {
    BLOCKLY_VISUAL_STYLE_OPTIONS,
    blocklyVisualStyleOption,
    type BlocklyVisualStyle,
} from '../services/blockly_visual_style';

interface BlockVisualStyleControlProps {
    value: BlocklyVisualStyle;
    onChange: (style: BlocklyVisualStyle) => void;
    disabled?: boolean;
}

const MENU_WIDTH = 260;
const VIEWPORT_MARGIN = 8;

interface MenuPosition {
    left: number;
    top: number;
}

const STYLE_SAMPLE_PALETTES: Record<BlocklyVisualStyle, readonly [string, string, string]> = {
    original: ['#4169E1', '#20B2AA', '#B9772A'],
    pastel: ['#6F8ED7', '#53A6AE', '#D08B54'],
    arcade: ['#E77A1F', '#008C8C', '#7E32A8'],
    sticker: ['#6679AA', '#4D8585', '#A95B70'],
    neon: ['#3D8BFF', '#00D6C9', '#FF5CA8'],
    mono: ['#64748B', '#A1A1AA', '#D4D4D8'],
};

export const BlockVisualStyleSample = ({ style }: { style: BlocklyVisualStyle }) => {
    const palette = STYLE_SAMPLE_PALETTES[style];
    return (
        <span
            className={`relative block h-10 w-14 shrink-0 overflow-hidden rounded-lg border ${style === 'arcade' || style === 'neon'
                ? 'border-slate-700 bg-[#0a1018] shadow-inner'
                : style === 'sticker'
                    ? 'border-amber-200 bg-[#f6f0e2] shadow-sm'
                    : style === 'mono'
                        ? 'border-slate-300 bg-slate-100 shadow-sm'
                    : 'border-blue-100 bg-[#f8fbff]'}`}
            aria-hidden="true"
            data-ck-role={`block-visual-style-sample-${style}`}
        >
            {palette.map((colour, index) => (
                <span
                    key={colour}
                    className={`absolute left-2 h-2.5 rounded-sm border border-white/70 ${style === 'arcade' || style === 'neon'
                        ? 'shadow-[1px_2px_0_rgba(0,0,0,0.72)]'
                        : style === 'sticker'
                            ? 'border-dashed shadow-[1px_2px_2px_rgba(87,69,48,0.24)]'
                            : style === 'mono'
                                ? 'border-slate-500 shadow-[0_1px_2px_rgba(15,23,42,0.2)]'
                            : 'shadow-[0_1px_2px_rgba(71,85,105,0.16)]'}`}
                    style={{
                        backgroundColor: colour,
                        top: 4 + index * 11,
                        width: 30 + index * 5,
                        transform: style === 'sticker' ? `rotate(${index === 1 ? -1.5 : 1}deg)` : undefined,
                    }}
                />
            ))}
        </span>
    );
};

export function BlockVisualStyleControl({
    value,
    onChange,
    disabled = false,
}: BlockVisualStyleControlProps) {
    const [open, setOpen] = useState(false);
    const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const current = blocklyVisualStyleOption(value);

    const updateMenuPosition = useCallback(() => {
        const trigger = triggerRef.current;
        if (!trigger) return;
        const rect = trigger.getBoundingClientRect();
        const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN);
        const left = Math.min(Math.max(VIEWPORT_MARGIN, rect.right - MENU_WIDTH), maxLeft);
        const menuHeight = menuRef.current?.offsetHeight || 292;
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
            <div ref={rootRef} className="relative shrink-0" data-ck-role="block-visual-style-control">
                <button
                    ref={triggerRef}
                    type="button"
                    onClick={() => setOpen(previous => !previous)}
                    disabled={disabled}
                    className="inline-flex h-9 items-center gap-2 rounded-full border border-slate-200 bg-slate-100/80 px-3 text-xs font-bold text-slate-600 transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-wait disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:border-brand-600 dark:hover:bg-brand-900/40 dark:hover:text-brand-200"
                    aria-haspopup="menu"
                    aria-expanded={open}
                    aria-controls={open ? 'ck-block-visual-style-menu' : undefined}
                    title={`积木皮肤：${current.label}`}
                >
                    <Palette size={14} />
                    <span>积木 · {current.shortLabel}</span>
                </button>
            </div>

            {open && menuPosition && typeof document !== 'undefined' && createPortal(
                <div
                    ref={menuRef}
                    id="ck-block-visual-style-menu"
                    data-ck-role="block-visual-style-menu"
                    className="fixed z-[10000] overflow-hidden rounded-xl border border-slate-200 bg-white p-1.5 shadow-2xl dark:border-slate-600 dark:bg-slate-900"
                    style={{ left: menuPosition.left, top: menuPosition.top, width: MENU_WIDTH }}
                    role="menu"
                    aria-label="选择积木外观"
                >
                    <div className="px-2.5 pb-1.5 pt-1 text-[10px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                        工作区积木外观
                    </div>
                    {BLOCKLY_VISUAL_STYLE_OPTIONS.map(option => {
                        const selected = option.id === value;
                        return (
                            <button
                                key={option.id}
                                type="button"
                                onClick={() => {
                                    onChange(option.id);
                                    setOpen(false);
                                }}
                                className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors ${selected
                                    ? 'bg-brand-50 text-brand-800 dark:bg-brand-900/35 dark:text-brand-200'
                                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
                                role="menuitemradio"
                                aria-checked={selected}
                                data-ck-role={`block-visual-style-${option.id}`}
                            >
                                <BlockVisualStyleSample style={option.id} />
                                <span className="min-w-0 flex-1">
                                    <span className="block text-xs font-bold">{option.label}</span>
                                    <span className="mt-0.5 block text-[9px] leading-4 text-slate-500 dark:text-slate-400">{option.description}</span>
                                </span>
                                {selected && <Check size={14} className="shrink-0 text-brand-600 dark:text-brand-300" />}
                            </button>
                        );
                    })}
                    <div className="mx-2 mt-1 border-t border-slate-100 px-0 pb-1 pt-2 text-[9px] leading-4 text-slate-400 dark:border-slate-700 dark:text-slate-500">
                        只改变颜色与质感，不改变积木形状、代码或工程格式。
                    </div>
                </div>
            , document.body)}
        </>
    );
}

export default BlockVisualStyleControl;
