import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import './PanelResizeHandle.css';

export function useSavedPanelSize(key: string, fallback: number) {
    const [size, setSize] = useState(() => {
        try { const n = Number(localStorage.getItem(key)); return Number.isFinite(n) && n >= 100 && n <= 3000 ? n : fallback; } catch { return fallback; }
    });
    const save = (next: number) => { setSize(next); try { localStorage.setItem(key, String(Math.round(next))); } catch { /* Layout still works without storage. */ } };
    return [size, save] as const;
}

/** Resize only the affected element during a gesture; commit parent state once. */
export function PanelResizeHandle({ target, axis, size, min, max, onCommit, label, reset = 360 }: {
    target: RefObject<HTMLElement | null>; axis: 'width' | 'height'; size: number; min: number; max: number;
    onCommit: (size: number) => void; label: string; reset?: number;
}) {
    const latest = useRef({ min, max, onCommit, size }); latest.current = { min, max, onCommit, size };
    const origin = useRef<{ position: number; size: number; current: number; restore: () => void } | null>(null);
    const frame = useRef<number | null>(null);
    const [value, setValue] = useState(size);
    const clamp = (n: number) => Math.max(latest.current.min, Math.min(latest.current.max, Math.round(n)));
    const paint = (n: number) => { if (target.current) target.current.style[axis] = `${n}px`; setValue(n); };
    const finish = (cancel = false) => {
        const drag = origin.current; if (!drag) return;
        origin.current = null;
        if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null;
        const n = clamp(cancel ? drag.size : drag.current); paint(n); drag.restore(); latest.current.onCommit(n);
    };
    useLayoutEffect(() => { if (!origin.current) setValue(size); }, [size]);
    useEffect(() => {
        const blur = () => finish(); window.addEventListener('blur', blur);
        return () => { window.removeEventListener('blur', blur); if (frame.current !== null) cancelAnimationFrame(frame.current); origin.current?.restore(); origin.current = null; };
    }, []);
    return <button type="button" role="separator" className={`ck-panel-resizer ck-panel-resizer--${axis}`} aria-label={label}
        aria-orientation={axis === 'width' ? 'vertical' : 'horizontal'} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}
        title={`${label} · 拖动调整，双击恢复默认`} data-ck-role={`${axis}-resize-handle`}
        onPointerDown={event => {
            if (event.button !== 0 || !target.current) return;
            event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
            const { cursor, userSelect } = document.body.style;
            document.body.style.cursor = axis === 'width' ? 'col-resize' : 'row-resize'; document.body.style.userSelect = 'none';
            const actual = target.current.getBoundingClientRect()[axis];
            origin.current = { position: axis === 'width' ? event.clientX : event.clientY, size: actual, current: actual,
                restore: () => { document.body.style.cursor = cursor; document.body.style.userSelect = userSelect; } };
        }}
        onPointerMove={event => {
            const drag = origin.current; if (!drag) return;
            drag.current = clamp(drag.size + drag.position - (axis === 'width' ? event.clientX : event.clientY));
            if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; if (origin.current) paint(clamp(origin.current.current)); });
        }}
        onPointerUp={event => { finish(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish()}
        onDoubleClick={() => { const n = clamp(reset); paint(n); onCommit(n); }}
        onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation();
            const n = clamp(event.key === 'Home' ? min : event.key === 'End' ? max : size + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? 20 : -20));
            paint(n); onCommit(n);
        }}><span /></button>;
}
