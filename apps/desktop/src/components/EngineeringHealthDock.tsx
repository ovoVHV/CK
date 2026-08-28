import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { GripVertical, HeartPulse, PanelRightClose } from 'lucide-react';
import { EngineeringHealthView } from './EngineeringHealthView';
import type { CompileDoctorReport } from '../services/compile_doctor';
import type { CompileIssueAction, CompileIssueCard } from '../services/compile_issue_cards';
import type { CompileResourceReport } from '../services/compile_resources';
import type { DeviceHealthReport } from '../services/device_health';
import type { PinPreflightReport } from '../services/pin_preflight';
import type { WorkspaceViewMode } from '../services/workspace_view_mode';

export const ENGINEERING_HEALTH_DOCK_MIN_WIDTH = 280;
export const ENGINEERING_HEALTH_DOCK_MAX_WIDTH = 640;

interface EngineeringHealthDockProps {
    width: number;
    onWidthChange: (width: number) => void;
    onResizeStart: () => void;
    onClose: () => void;
    compileDoctorReport: CompileDoctorReport | null;
    deviceHealthReport: DeviceHealthReport | null;
    compileResourceReport: CompileResourceReport | null;
    pinPreflightReport: PinPreflightReport | null;
    compileIssues: CompileIssueCard[];
    fqbn: string;
    configurationFqbn: string;
    configurationSource: 'loading' | 'resolved' | 'core-default' | 'unverified';
    displayMode: WorkspaceViewMode;
    isCompiling?: boolean;
    isDeviceHealthRunning?: boolean;
    onLocateBlock: (blockId: string) => void;
    onIssueAction: (action: CompileIssueAction, issue: CompileIssueCard) => void;
}

const clampDockWidth = (width: number) => Math.min(
    ENGINEERING_HEALTH_DOCK_MAX_WIDTH,
    Math.max(ENGINEERING_HEALTH_DOCK_MIN_WIDTH, Math.round(width)),
);

export function EngineeringHealthDock({
    width,
    onWidthChange,
    onResizeStart,
    onClose,
    compileDoctorReport,
    deviceHealthReport,
    compileResourceReport,
    pinPreflightReport,
    compileIssues,
    fqbn,
    configurationFqbn,
    configurationSource,
    displayMode,
    isCompiling = false,
    isDeviceHealthRunning = false,
    onLocateBlock,
    onIssueAction,
}: EngineeringHealthDockProps) {
    const [isResizing, setIsResizing] = useState(false);
    const resizeOriginRef = useRef({ clientX: 0, width: 0 });

    useEffect(() => {
        if (!isResizing) return;
        const previousCursor = document.body.style.cursor;
        const previousUserSelect = document.body.style.userSelect;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        return () => {
            document.body.style.cursor = previousCursor;
            document.body.style.userSelect = previousUserSelect;
        };
    }, [isResizing]);

    const beginResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        resizeOriginRef.current = { clientX: event.clientX, width };
        onResizeStart();
        setIsResizing(true);
    };

    const continueResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (!isResizing) return;
        const delta = resizeOriginRef.current.clientX - event.clientX;
        onWidthChange(clampDockWidth(resizeOriginRef.current.width + delta));
    };

    const finishResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        setIsResizing(false);
    };

    return (
        <aside
            className="relative flex min-h-0 shrink-0 flex-col overflow-hidden border-l border-slate-200 bg-white shadow-[-8px_0_24px_rgba(15,23,42,0.08)] dark:border-slate-700 dark:bg-slate-950 dark:shadow-[-8px_0_24px_rgba(0,0,0,0.22)]"
            style={{ width: `max(${ENGINEERING_HEALTH_DOCK_MIN_WIDTH}px, min(${clampDockWidth(width)}px, 44vw))` }}
            data-ck-role="engineering-health-dock"
            data-ck-view-mode={displayMode}
            aria-label="工程体检侧栏"
        >
            <button
                type="button"
                role="separator"
                aria-orientation="vertical"
                aria-label="调整工程体检侧栏宽度"
                aria-valuemin={ENGINEERING_HEALTH_DOCK_MIN_WIDTH}
                aria-valuemax={ENGINEERING_HEALTH_DOCK_MAX_WIDTH}
                aria-valuenow={clampDockWidth(width)}
                onPointerDown={beginResize}
                onPointerMove={continueResize}
                onPointerUp={finishResize}
                onPointerCancel={finishResize}
                className={`group absolute inset-y-0 left-0 z-20 w-2 -translate-x-1/2 cursor-col-resize touch-none outline-none ${isResizing ? 'bg-teal-500/20' : 'bg-transparent'}`}
                title="拖动调整宽度"
            >
                <span className="absolute left-1/2 top-1/2 flex h-12 w-3 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 shadow-sm transition-colors group-hover:border-teal-300 group-hover:text-teal-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-500 dark:group-hover:border-teal-700 dark:group-hover:text-teal-300">
                    <GripVertical size={10} aria-hidden="true" />
                </span>
            </button>

            <header className="flex min-h-14 shrink-0 items-center gap-2.5 border-b border-slate-200 bg-white px-3 py-2 pl-4 dark:border-slate-700 dark:bg-slate-900">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300">
                    <HeartPulse size={17} aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                    <h2 className="text-xs font-bold text-slate-900 dark:text-slate-100">工程体检</h2>
                    <p className="mt-0.5 truncate text-[9px] text-slate-500 dark:text-slate-400">
                        {displayMode === 'simple' ? '结果与需要处理的问题' : '完整资源、真机、引脚和构建证据'}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    className="flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg px-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-500 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                    title="收起工程体检侧栏"
                    aria-label="收起工程体检侧栏"
                >
                    <PanelRightClose size={16} />
                    <span className="hidden text-[10px] font-bold min-[1500px]:inline">收起</span>
                </button>
            </header>
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
                <EngineeringHealthView
                    compileDoctorReport={compileDoctorReport}
                    deviceHealthReport={deviceHealthReport}
                    compileResourceReport={compileResourceReport}
                    pinPreflightReport={pinPreflightReport}
                    compileIssues={compileIssues}
                    fqbn={fqbn}
                    configurationFqbn={configurationFqbn}
                    configurationSource={configurationSource}
                    displayMode={displayMode}
                    isCompiling={isCompiling}
                    isDeviceHealthRunning={isDeviceHealthRunning}
                    compact={width < 360}
                    onLocateBlock={onLocateBlock}
                    onIssueAction={onIssueAction}
                />
            </div>
        </aside>
    );
}

export default EngineeringHealthDock;
