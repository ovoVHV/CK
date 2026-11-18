import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { PanelResizeHandle, useSavedPanelSize } from './PanelResizeHandle';

const compactHeight = 168;
const SizeContext = createContext({ expanded: false, toggle: () => {} });
export function ConsoleSizeToggle() {
    const { expanded, toggle } = useContext(SizeContext);
    return <button type="button" data-ck-action="toggle-console-size" onClick={toggle}
        aria-expanded={expanded} aria-label={expanded ? '恢复紧凑控制台' : '展开控制台'}
        title={expanded ? '恢复紧凑高度' : '展开查看更多输出'}
        className="ck-serial-icon-button h-7 px-1.5 flex items-center justify-center gap-1 rounded text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800">
        {expanded ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
        <span className="text-[10px] whitespace-nowrap">{expanded ? '紧凑' : '展开'}</span>
    </button>;
}
export function ConsoleDock({ children }: { children: ReactNode }) {
    const panel = useRef<HTMLDivElement>(null);
    const [height, saveHeight] = useSavedPanelSize('ck_console_height_v2', compactHeight);
    const [available, setAvailable] = useState(800);
    const max = Math.max(120, available - 290), min = Math.min(140, max);
    const actual = Math.max(min, Math.min(max, height));
    useLayoutEffect(() => {
        const parent = panel.current?.parentElement; if (!parent) return;
        const measure = () => setAvailable(parent.clientHeight);
        const observer = new ResizeObserver(measure); observer.observe(parent); measure(); return () => observer.disconnect();
    }, []);
    const expanded = actual > compactHeight + 20;
    return <div ref={panel} className="ck-console-panel ck-serial-console-panel bg-[#fbfcfe] border-t border-[#dce3ec] flex flex-col shrink-0 relative dark:border-slate-700 dark:bg-slate-950"
        data-expanded={expanded} style={{ height: actual }}>
        <PanelResizeHandle target={panel} axis="height" size={actual} min={min} max={max} reset={compactHeight} onCommit={saveHeight} label="调整串口与输出面板高度" />
        <SizeContext.Provider value={{expanded, toggle: () => saveHeight(expanded ? compactHeight : Math.min(max, Math.max(200, Math.min(available * .42, available - 395))))}}>{children}</SizeContext.Provider>
    </div>;
}
