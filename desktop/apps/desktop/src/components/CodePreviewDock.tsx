import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export const codePreviewLimits = (available: number) => {
    const max = Math.max(0, Math.min(900, available - 360));
    return { min: Math.min(260, max), max };
};
export const clampCodePreviewWidth = (width: number, available: number) => {
    const { min, max } = codePreviewLimits(available);
    return Math.max(min, Math.min(max, Math.round(width)));
};

export function CodePreviewDock({ children, onLayout }: { children: ReactNode; onLayout: () => void }) {
    const { t } = useTranslation('health');
    const ref = useRef<HTMLElement>(null);
    const origin = useRef<{ x: number; width: number } | null>(null);
    const [width, setWidth] = useState(340);
    const [available, setAvailable] = useState(1000);
    const [dragging, setDragging] = useState(false);
    const actual = clampCodePreviewWidth(width, available);
    const limits = codePreviewLimits(available);
    useLayoutEffect(() => {
        const parent = ref.current?.parentElement;
        if (!parent) return;
        const measure = () => {
            const health = parent.querySelector('[data-ck-role="engineering-health-dock"]');
            setAvailable(parent.clientWidth - (health?.getBoundingClientRect().width || 0));
        };
        const observer = new ResizeObserver(measure);
        observer.observe(parent);
        const observeChildren = () => { Array.from(parent.children).forEach(child => observer.observe(child)); measure(); };
        const mutation = new MutationObserver(observeChildren);
        mutation.observe(parent, { childList: true });
        observeChildren();
        return () => { observer.disconnect(); mutation.disconnect(); };
    }, []);
    useLayoutEffect(() => { onLayout(); }, [actual, onLayout]);
    useEffect(() => {
        if (!dragging) return;
        const { cursor, userSelect } = document.body.style;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        return () => { document.body.style.cursor = cursor; document.body.style.userSelect = userSelect; };
    }, [dragging]);
    return (
        <aside ref={ref} data-ck-role="code-preview-dock" style={{ width: actual }} className="cpp-preview-container relative min-w-0 min-h-0 shrink-0 flex flex-col border-l border-[#dce3ec] bg-[#f8fafc] z-10 dark:border-slate-700 dark:bg-[#0b1220]">
            <button type="button" role="separator" aria-orientation="vertical" aria-label={t('codePreview.resize')} title={t('codePreview.resize')}
                aria-valuemin={limits.min} aria-valuemax={limits.max} aria-valuenow={actual}
                className="absolute inset-y-0 left-0 z-20 w-2 cursor-col-resize touch-none bg-transparent hover:bg-brand-500/25 focus-visible:bg-brand-500/25"
                onPointerDown={event => {
                    if (event.button !== 0) return;
                    event.preventDefault(); event.stopPropagation();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    origin.current = { x: event.clientX, width: actual }; setDragging(true);
                }}
                onPointerMove={event => {
                    if (origin.current) setWidth(clampCodePreviewWidth(origin.current.width + origin.current.x - event.clientX, available));
                }}
                onPointerUp={event => {
                    origin.current = null; setDragging(false);
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={() => { origin.current = null; setDragging(false); }}
                onLostPointerCapture={() => { origin.current = null; setDragging(false); }}
                onKeyDown={event => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault();
                    setWidth(clampCodePreviewWidth(event.key === 'Home' ? limits.min : event.key === 'End' ? limits.max : actual + (event.key === 'ArrowLeft' ? 20 : -20), available));
                }}
            />
            {children}
        </aside>
    );
}
