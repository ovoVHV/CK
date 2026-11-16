import { HeartPulse } from 'lucide-react';
import { useRef } from 'react';
import { ProjectCheckNavigation, ProjectRecoveryLinks, type ProjectCheckActions, type ProjectCheckSection } from './ProjectCheckNavigation';
import { describeHealthCapability } from '../services/health_capability';
import { projectHealthCapabilities } from '../services/project_health_capabilities';
import { useTranslation } from 'react-i18next';
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
import type { HardwareResourceInspectorView } from '../services/hardware_resource_inspector';
import { HardwareResourceInspector } from './HardwareResourceInspector';
import type { ResourcePreflightReport } from '../services/resource_preflight';
import { ResourcePreflightPanel } from './ResourcePreflightPanel';
import { ProjectOverview } from './ProjectOverview';

interface EngineeringHealthViewProps extends ProjectCheckActions {
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
    isCompiling?: boolean;
    isDeviceHealthRunning?: boolean;
    compact?: boolean;
    displayMode?: WorkspaceViewMode;
    onLocateBlock: (blockId: string) => void;
    onCompileForResources?: () => void;
    onIssueAction: (action: CompileIssueAction, issue: CompileIssueCard) => void;
}

export function EngineeringHealthView({
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
    isCompiling = false,
    isDeviceHealthRunning = false,
    compact = false,
    displayMode = 'engineering',
    onLocateBlock,
    onCompileForResources,
    onIssueAction,
    onOpenLibraries,
    onOpenCheckpoints,
    onOpenLastWorking,
}: EngineeringHealthViewProps) {
    const { t } = useTranslation('health');
    const rootRef = useRef<HTMLDivElement>(null);
    const navigate = (section: ProjectCheckSection) => {
        const role = { compile: 'health-project-risks', hardware: 'health-hardware', resources: 'health-resource-budget',
            recovery: 'health-recovery', dependencies: 'health-environment' }[section];
        rootRef.current?.querySelector<HTMLElement>(`[data-ck-role="${role}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    };
    const hasReport = Boolean(
        compileDoctorReport
        || deviceHealthReport
        || compileResourceReport
        || pinPreflightReport
        || hardwareResourceInspector
        || resourcePreflightReport
        || compileIssues.length > 0,
    );
    const simple = displayMode === 'simple';
    const coverage = describeHealthCapability({
        fqbn: configurationFqbn || fqbn, coreVersion, customBoard,
        trustedPins: pinPreflightReport ? pinPreflightReport.status === 'ready' && pinPreflightReport.catalog.length > 0 : undefined,
    });

    return (
        <div
            ref={rootRef}
            className="h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain bg-[#f8fafc] pb-2 dark:bg-slate-950"
            data-ck-role="engineering-health-view"
            aria-label={t('title')}
            data-ck-view-mode={displayMode}
        >
            <ProjectCheckNavigation onSelect={navigate} />
            <ProjectOverview
                projectName=""
                boardName=""
                isCompiling={isCompiling}
                compileReport={compileDoctorReport}
                resourceReport={resourcePreflightReport}
                resourceRunning={isResourcePreflightRunning}
                issues={compileIssues}
                showIdentity={false}
                embedded
            />
            {!hasReport && !isCompiling && !isDeviceHealthRunning && (
                <div className="flex min-h-28 items-center justify-center px-6 py-4 text-center">
                    <div className="max-w-md text-slate-400 dark:text-slate-500">
                        <HeartPulse size={24} className="mx-auto mb-2" aria-hidden="true" />
                        <div className="text-xs font-bold text-slate-500 dark:text-slate-400">{t('empty.title')}</div>
                        <p className="mt-1 text-[11px] leading-5">
                            {t('empty.description')}
                        </p>
                    </div>
                </div>
            )}

            <section className="border-b border-slate-200 px-3 py-3 dark:border-slate-800" data-ck-role="health-environment">
                <h3 className="mb-2 text-xs font-semibold text-slate-800 dark:text-slate-100">{t('experience.environment')}</h3>
                <dl className="grid min-w-0 gap-2 text-[11px]" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(130px, 100%), 1fr))' }}>
                    <div className="min-w-0">
                        <dt className="text-slate-500 dark:text-slate-400">{t('experience.board')}</dt>
                        <dd className="mt-0.5 font-medium text-slate-800 dark:text-slate-100">{t(configurationSource === 'resolved' ? 'experience.resolved' : configurationSource === 'loading' ? 'experience.resolving' : configurationSource === 'core-default' ? 'experience.coreDefault' : 'experience.unverified')}</dd>
                    </div>
                    <div className="min-w-0">
                        <dt className="text-slate-500 dark:text-slate-400">{t('experience.core')}</dt>
                        <dd className="mt-0.5 break-words font-medium text-slate-800 dark:text-slate-100">{coreVersion ? t('experience.version', { version: coreVersion }) : t('experience.unverified')}</dd>
                    </div>
                    <div className="min-w-0">
                        <dt className="text-slate-500 dark:text-slate-400">{t('experience.libraries')}</dt>
                        <dd className={`mt-0.5 font-medium ${compileIssues.some(issue => issue.id === 'missing-header') ? 'text-red-700 dark:text-red-300' : 'text-slate-800 dark:text-slate-100'}`}>{t(compileIssues.some(issue => issue.id === 'missing-header') ? 'experience.dependencyMissing' : compileDoctorReport?.success ? 'experience.dependencyResolved' : 'experience.unverified')}</dd>
                    </div>
                </dl>
                {onOpenLibraries && <button type="button" onClick={onOpenLibraries}
                    className="mt-2 rounded border border-slate-300 px-2 py-1 text-[11px] text-brand-700 dark:border-slate-600 dark:text-brand-300">
                    {t('productV2.manageLibraries')}
                </button>}
                <details className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
                    <summary className="cursor-pointer">{t('experience.details')}</summary>
                    <p className="mt-1 break-all font-mono">{configurationFqbn || fqbn || t('experience.waitingResources')}</p>
                    <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-600 dark:text-slate-300" data-ck-role="health-capability">
                    <span>{t('coverage.engineering')}</span>
                    <span>{t(coverage.pin === 'available' ? 'coverage.pin.available' : 'coverage.pin.unsupported')}</span>
                    {coverage.device !== 'unsupported' && <span data-capability={coverage.device} data-evidence={coverage.evidence}>
                        {t(coverage.evidence === 'hardware-verified' ? 'coverage.device.hardware-verified' : 'coverage.device.code-path-verified')}
                    </span>}
                    {coverage.evidence === 'hardware-verified' && <span>{t('coverage.validatedScope')}</span>}
                    </div>
                </details>
            </section>

            <section data-ck-role="health-project-risks" className="py-2">
                <h3 className="px-3 text-xs font-semibold text-slate-800 dark:text-slate-100">{t('experience.risks')}</h3>
                <ResourcePreflightPanel
                    report={resourcePreflightReport}
                    isRunning={isResourcePreflightRunning}
                    compact={compact || simple}
                    displayMode={displayMode}
                    onLocateBlock={onLocateBlock}
                    onCompileForResources={onCompileForResources}
                    isCompiling={isCompiling}
                />
                <BuildIssueCards
                    issues={compileIssues}
                    compact={compact || simple}
                    onAction={onIssueAction}
                    onLocateBlock={onLocateBlock}
                />
                {!resourcePreflightReport && !isResourcePreflightRunning && compileIssues.length === 0 && (
                    <p className="px-3 pt-2 text-[11px] text-slate-500 dark:text-slate-400">{t('experience.noChecks')}</p>
                )}
            </section>
            <CompileDoctorPanel
                report={compileDoctorReport}
                isCompiling={isCompiling}
                compact={compact}
                displayMode={displayMode}
            />
            <section data-ck-role="health-resource-budget">
            <ResourceBudgetPanel
                report={compileResourceReport}
                fqbn={fqbn}
                configurationFqbn={configurationFqbn}
                configurationSource={configurationSource}
                isCompiling={isCompiling}
                compact={compact || simple}
            />
            </section>
            <section className="mt-3 border-t border-slate-200 py-3 dark:border-slate-800" data-ck-role="health-hardware">
            {!hardwareResourceInspector && <>
                <h3 className="px-3 text-xs font-semibold text-slate-800 dark:text-slate-100">{t('experience.hardware')}</h3>
                <p className="px-3 pt-2 text-[11px] text-slate-500 dark:text-slate-400">{t('experience.waitingResources')}</p>
            </>}
            <HardwareResourceInspector
                view={hardwareResourceInspector}
                compact={compact || simple}
                displayMode={displayMode}
                onLocateBlock={onLocateBlock}
            />
            {coverage.pin !== 'unsupported' && <PinPreflightPanel
                report={pinPreflightReport}
                compact={compact || simple}
                displayMode={displayMode}
                onLocateBlock={onLocateBlock}
            />}
            </section>
            {coverage.device !== 'unsupported' && <section className="border-t border-slate-200 py-3 dark:border-slate-800" data-ck-role="health-device">
            <h3 className="px-3 text-xs font-semibold text-slate-800 dark:text-slate-100">{t('experience.device')}</h3>
            {!deviceHealthReport && !isDeviceHealthRunning && <p className="px-3 pt-2 text-[11px] text-slate-500 dark:text-slate-400">{t('resourceInspector.evidenceValue.not-tested')}</p>}
            <DeviceHealthPanel
                report={deviceHealthReport}
                isRunning={isDeviceHealthRunning}
                compact={compact}
                displayMode={displayMode}
            />
            </section>}
            <ProjectRecoveryLinks onOpenCheckpoints={onOpenCheckpoints} onOpenLastWorking={projectHealthCapabilities(fqbn).lastWorkingVersion ? onOpenLastWorking : undefined} />
        </div>
    );
}

export default EngineeringHealthView;
