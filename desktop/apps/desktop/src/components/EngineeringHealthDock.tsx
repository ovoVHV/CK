import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { GripVertical, HeartPulse, PanelRightClose } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EngineeringHealthView } from './EngineeringHealthView';
import type { ProjectCheckActions } from './ProjectCheckNavigation';
import type { CompileDoctorReport } from '../services/compile_doctor';
import type { CompileIssueAction, CompileIssueCard } from '../services/compile_issue_cards';
import type { CompileResourceReport } from '../services/compile_resources';
import type { DeviceHealthReport } from '../services/device_health';
import type { PinPreflightReport } from '../services/pin_preflight';
import type { WorkspaceViewMode } from '../services/workspace_view_mode';
import type { HardwareResourceInspectorView } from '../services/hardware_resource_inspector';
import type { ResourcePreflightReport } from '../services/resource_preflight';

export const ENGINEERING_HEALTH_DOCK_MIN_WIDTH = 280;
export const ENGINEERING_HEALTH_DOCK_MAX_WIDTH = 640;

interface EngineeringHealthDockProps extends ProjectCheckActions {
    width: number;
    onWidthChange: (width: number) => void;
    onResizeStart: () => void;
    onClose: () => void;
    compileDoctorReport: CompileDoctorReport | null;
    deviceHealthReport: DeviceHealthReport | null;
    compileResourceReport: CompileResourceReport | null;
    pinPreflightReport: PinPreflightReport | null;
    hardwareResourceInspector?: HardwareResourceInspectorView | null;
    resourcePreflightReport?: ResourcePreflightReport | null;
    isResourcePreflightRunning?: boolean;
    compileIssues: CompileIssueCard[];
    fqbn: string;
    coreVersion?: string;
    customBoard?: boolean;
    configurationFqbn: string;
    configurationSource: 'loading' | 'resolved' | 'core-default' | 'unverified';
    displayMode: WorkspaceViewMode;
    isCompiling?: boolean;
    isDeviceHealthRunning?: boolean;
    onLocateBlock: (blockId: string) => void;
    onCompileForResources?: () => void;
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
    hardwareResourceInspector = null,
    resourcePreflightReport = null,
    isResourcePreflightRunning = false,
    compileIssues,
    fqbn,
    coreVersion,
    customBoard,
    configurationFqbn,
    configurationSource,
    displayMode,
    isCompiling = false,
    isDeviceHealthRunning = false,
    onLocateBlock,
    onCompileForResources,
    onIssueAction,
    onOpenLibraries,
    onOpenCheckpoints,
    onOpenLastWorking,
}: EngineeringHealthDockProps) {
    const { t } = useTranslation('health');
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
            aria-label={t('dock.ariaLabel')}
        >
            <button
                type="button"
                role="separator"
                aria-orientation="vertical"
                aria-label={t('dock.resizeAriaLabel')}
                aria-valuemin={ENGINEERING_HEALTH_DOCK_MIN_WIDTH}
                aria-valuemax={ENGINEERING_HEALTH_DOCK_MAX_WIDTH}
                aria-valuenow={clampDockWidth(width)}
                onPointerDown={beginResize}
                onPointerMove={continueResize}
                onPointerUp={finishResize}
                onPointerCancel={finishResize}
                className={`group absolute inset-y-0 left-0 z-20 w-2 -translate-x-1/2 cursor-col-resize touch-none outline-none ${isResizing ? 'bg-brand-500/20' : 'bg-transparent'}`}
                title={t('dock.resizeTitle')}
            >
                <span className="absolute left-1/2 top-1/2 flex h-12 w-3 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 shadow-sm transition-colors group-hover:border-brand-300 group-hover:text-brand-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-500 dark:group-hover:border-brand-700 dark:group-hover:text-brand-300">
                    <GripVertical size={10} aria-hidden="true" />
                </span>
            </button>

            <header className="flex min-h-14 shrink-0 items-center gap-2.5 border-b border-slate-200 bg-white px-3 py-2 pl-4 dark:border-slate-700 dark:bg-slate-900">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-100 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
                    <HeartPulse size={17} aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                    <h2 className="text-xs font-bold text-slate-900 dark:text-slate-100">{t('title')}</h2>
                    <p className="mt-0.5 truncate text-[9px] text-slate-500 dark:text-slate-400">
                        {displayMode === 'simple' ? t('subtitle') : t('dock.engineeringSubtitle')}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    className="flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg px-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-500 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                    title={t('dock.closeTitle')}
                    aria-label={t('dock.closeTitle')}
                >
                    <PanelRightClose size={16} />
                    <span className="hidden text-[10px] font-bold min-[1500px]:inline">{t('dock.collapse')}</span>
                </button>
            </header>
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
                <EngineeringHealthView
                    onOpenLibraries={onOpenLibraries}
                    onOpenCheckpoints={onOpenCheckpoints}
                    onOpenLastWorking={onOpenLastWorking}
                    compileDoctorReport={compileDoctorReport}
                    deviceHealthReport={deviceHealthReport}
                    compileResourceReport={compileResourceReport}
                    pinPreflightReport={pinPreflightReport}
                    hardwareResourceInspector={hardwareResourceInspector}
                    resourcePreflightReport={resourcePreflightReport}
                    isResourcePreflightRunning={isResourcePreflightRunning}
                    compileIssues={compileIssues}
                    fqbn={fqbn}
                    coreVersion={coreVersion}
                    customBoard={customBoard}
                    configurationFqbn={configurationFqbn}
                    configurationSource={configurationSource}
                    displayMode={displayMode}
                    isCompiling={isCompiling}
                    isDeviceHealthRunning={isDeviceHealthRunning}
                    compact={width < 360}
                    onLocateBlock={onLocateBlock}
                    onCompileForResources={onCompileForResources}
                    onIssueAction={onIssueAction}
                />
            </div>
        </aside>
    );
}

export default EngineeringHealthDock;
