import { HeartPulse } from 'lucide-react';
import { BuildIssueCards } from './BuildIssueCards';
import { CompileDoctorPanel } from './CompileDoctorPanel';
import { DeviceHealthPanel } from './DeviceHealthPanel';
import { PinPreflightPanel } from './PinPreflightPanel';
import { ResourceBudgetPanel } from './ResourceBudgetPanel';
import type { CompileDoctorReport } from '../services/compile_doctor';
import type { CompileIssueAction, CompileIssueCard } from '../services/compile_issue_cards';
import type { CompileResourceReport } from '../services/compile_resources';
import type { DeviceHealthReport } from '../services/device_health';
import type { PinPreflightReport } from '../services/pin_preflight';
import type { WorkspaceViewMode } from '../services/workspace_view_mode';

interface EngineeringHealthViewProps {
    compileDoctorReport: CompileDoctorReport | null;
    deviceHealthReport: DeviceHealthReport | null;
    compileResourceReport: CompileResourceReport | null;
    pinPreflightReport: PinPreflightReport | null;
    compileIssues: CompileIssueCard[];
    fqbn: string;
    configurationFqbn: string;
    configurationSource: 'loading' | 'resolved' | 'core-default' | 'unverified';
    isCompiling?: boolean;
    isDeviceHealthRunning?: boolean;
    compact?: boolean;
    displayMode?: WorkspaceViewMode;
    onLocateBlock: (blockId: string) => void;
    onIssueAction: (action: CompileIssueAction, issue: CompileIssueCard) => void;
}

export function EngineeringHealthView({
    compileDoctorReport,
    deviceHealthReport,
    compileResourceReport,
    pinPreflightReport,
    compileIssues,
    fqbn,
    configurationFqbn,
    configurationSource,
    isCompiling = false,
    isDeviceHealthRunning = false,
    compact = false,
    displayMode = 'engineering',
    onLocateBlock,
    onIssueAction,
}: EngineeringHealthViewProps) {
    const hasReport = Boolean(
        compileDoctorReport
        || deviceHealthReport
        || compileResourceReport
        || pinPreflightReport
        || compileIssues.length > 0,
    );
    const simple = displayMode === 'simple';

    return (
        <div
            className="h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain bg-[#f8fafc] pb-2 dark:bg-slate-950"
            data-ck-role="engineering-health-view"
            aria-label="工程体检"
            data-ck-view-mode={displayMode}
        >
            {!hasReport && !isCompiling && !isDeviceHealthRunning && (
                <div className="flex h-full min-h-28 items-center justify-center px-6 text-center">
                    <div className="max-w-md text-slate-400 dark:text-slate-500">
                        <HeartPulse size={24} className="mx-auto mb-2" aria-hidden="true" />
                        <div className="text-xs font-bold text-slate-500 dark:text-slate-400">暂无工程体检结果</div>
                        <p className="mt-1 text-[11px] leading-5">
                            编译、上传或运行真机体检后，这里会集中显示构建缓存、资源预算、真机、引脚和可操作问题。
                        </p>
                    </div>
                </div>
            )}

            {hasReport && (
                <div
                    data-ck-role="engineering-health-display-boundary"
                    className="mx-2 mt-2 rounded-md border border-slate-200 bg-white/80 px-2.5 py-1.5 text-[9px] leading-4 text-slate-500 dark:border-slate-800 dark:bg-slate-900/70 dark:text-slate-400"
                >
                    {simple
                        ? '简洁视图只折叠技术证据；错误、上传风险与安全门禁始终完整显示。'
                        : '工程视图显示完整编译目标、缓存变化与真机证据。'}
                </div>
            )}

            <CompileDoctorPanel
                report={compileDoctorReport}
                isCompiling={isCompiling}
                compact={compact}
                displayMode={displayMode}
            />
            <DeviceHealthPanel
                report={deviceHealthReport}
                isRunning={isDeviceHealthRunning}
                compact={compact}
                displayMode={displayMode}
            />
            <ResourceBudgetPanel
                report={compileResourceReport}
                fqbn={fqbn}
                configurationFqbn={configurationFqbn}
                configurationSource={configurationSource}
                isCompiling={isCompiling}
                compact={compact || simple}
            />
            <PinPreflightPanel
                report={pinPreflightReport}
                compact={compact || simple}
                onLocateBlock={onLocateBlock}
            />
            <BuildIssueCards
                issues={compileIssues}
                compact={compact || simple}
                onAction={onIssueAction}
                onLocateBlock={onLocateBlock}
            />
        </div>
    );
}

export default EngineeringHealthView;
