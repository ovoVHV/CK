import {
    Activity,
    CheckCircle2,
    CircleAlert,
    CircleHelp,
    Copy,
    Cpu,
    Database,
    HardDrive,
    HeartPulse,
    KeyRound,
    TriangleAlert,
    Usb,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
    deriveDeviceHealthPresentation,
    formatDeviceCapacity,
    type DeviceHealthCheck,
    type DeviceHealthReport,
} from '../services/device_health';
import type { WorkspaceViewMode } from '../services/workspace_view_mode';

interface DeviceHealthPanelProps {
    report: DeviceHealthReport | null;
    isRunning?: boolean;
    compact?: boolean;
    displayMode?: WorkspaceViewMode;
}

const statusTheme = (status: ReturnType<typeof deriveDeviceHealthPresentation>['status']) => {
    if (status === 'problem') {
        return {
            shell: 'border-red-200 bg-red-50/70 dark:border-red-900 dark:bg-red-950/35',
            icon: 'bg-red-100 text-red-700 dark:bg-red-950/70 dark:text-red-300',
            title: 'text-red-800 dark:text-red-300',
            Icon: CircleAlert,
        };
    }
    if (status === 'attention') {
        return {
            shell: 'border-amber-200 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950/35',
            icon: 'bg-amber-100 text-amber-700 dark:bg-amber-950/70 dark:text-amber-300',
            title: 'text-amber-800 dark:text-amber-300',
            Icon: TriangleAlert,
        };
    }
    if (status === 'unsupported') {
        return {
            shell: 'border-slate-200 bg-slate-50/85 dark:border-slate-700 dark:bg-slate-800/60',
            icon: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
            title: 'text-slate-700 dark:text-slate-200',
            Icon: CircleHelp,
        };
    }
    return {
        shell: 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/30',
        icon: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300',
        title: 'text-emerald-800 dark:text-emerald-300',
        Icon: CheckCircle2,
    };
};

const checkTheme = (check: DeviceHealthCheck) => {
    if (check.state === 'error') return 'border-red-200 bg-white/70 text-red-700 dark:border-red-900 dark:bg-slate-900/55 dark:text-red-300';
    if (check.state === 'warning') return 'border-amber-200 bg-white/70 text-amber-700 dark:border-amber-900 dark:bg-slate-900/55 dark:text-amber-300';
    if (check.state === 'pass') return 'border-emerald-200 bg-white/70 text-emerald-700 dark:border-emerald-900 dark:bg-slate-900/55 dark:text-emerald-300';
    return 'border-slate-200 bg-white/70 text-slate-500 dark:border-slate-700 dark:bg-slate-900/55 dark:text-slate-400';
};

const fact = (
    Icon: typeof Cpu,
    label: string,
    value: string,
    options: {
        detail?: string;
        title?: string;
        className?: string;
        copyValue?: string;
        copyLabel?: string;
        dataRole?: string;
    } = {},
) => (
    <div
        className={`min-w-0 rounded border border-white/80 bg-white/75 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-900/65 ${options.className || ''}`}
        title={options.title || value}
        data-ck-role={options.dataRole}
    >
        <span className="flex items-center gap-1 text-[9px] text-slate-400 dark:text-slate-500"><Icon size={11} />{label}</span>
        <span className="mt-0.5 flex min-w-0 items-start gap-1">
            <span className="min-w-0 flex-1 select-text whitespace-normal break-words text-[10px] font-bold leading-4 text-slate-700 [overflow-wrap:anywhere] dark:text-slate-200">
                {value}
            </span>
            {options.copyValue && (
                <button
                    type="button"
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-brand-300"
                    onClick={() => {
                        const request = navigator.clipboard?.writeText(options.copyValue as string);
                        request?.catch(() => undefined);
                    }}
                    title={options.copyLabel || label}
                    aria-label={options.copyLabel || label}
                >
                    <Copy size={11} aria-hidden="true" />
                </button>
            )}
        </span>
        {options.detail && options.detail !== value && (
            <span className="mt-0.5 block select-text whitespace-normal break-all font-mono text-[9px] leading-3.5 text-slate-500 dark:text-slate-400">
                {options.detail}
            </span>
        )}
    </div>
);

export function DeviceHealthPanel({
    report,
    isRunning = false,
    compact = false,
    displayMode = 'engineering',
}: DeviceHealthPanelProps) {
    const { t: translate, i18n } = useTranslation('health');
    const t = translate as unknown as (key: string, options?: Record<string, unknown>) => string;
    if (!report && !isRunning) return null;

    if (!report) {
        return (
            <section
                data-ck-role="device-health-panel"
                className="mx-2 mt-2 shrink-0 rounded-md border border-brand-200 bg-brand-50/75 px-3 py-2 text-brand-800 dark:border-brand-900 dark:bg-brand-950/35 dark:text-brand-300"
                aria-label={t('device.title')}
                aria-live="polite"
            >
                <div className="flex items-center gap-2 text-xs font-bold">
                    <Activity size={15} className="animate-pulse" />
                    {t('device.runningHandshake')}
                </div>
                <div className="mt-1 text-[10px] text-brand-700/80 dark:text-brand-300/80">
                    {t('device.resetDisclaimerShort')}
                </div>
            </section>
        );
    }

    const presentation = deriveDeviceHealthPresentation(report);
    const theme = statusTheme(presentation.status);
    const StatusIcon = theme.Icon;
    const measuredAt = new Date(report.observedAt);
    const measuredAtText = Number.isFinite(measuredAt.getTime())
        ? measuredAt.toLocaleString(i18n.resolvedLanguage || i18n.language, { hour12: false })
        : report.observedAt;
    const chipLabel = report.device.chip
        ? `${report.device.chip}${report.device.revision ? ` · ${report.device.revision}` : ''}`
        : t('device.notReported');
    const identityLabel = report.device.mac
        ? `MAC ${report.device.mac}`
        : report.device.macSuffix
            ? t('device.identity.macSuffix', { suffix: report.device.macSuffix.toUpperCase() })
            : t(`device.identity.${report.device.identitySource}`);
    const flashLabel = report.memory.flashBytes == null ? t('device.notReported') : formatDeviceCapacity(report.memory.flashBytes);
    const psramLabel = report.memory.psramBytes == null ? t('device.notReported') : formatDeviceCapacity(report.memory.psramBytes);
    const targetParts = [
        report.target.buildMcu,
        report.target.configuredFlashBytes ? t('device.target.configuredFlash', { value: formatDeviceCapacity(report.target.configuredFlashBytes) }) : null,
        report.target.partitionScheme ? t('device.target.partition', { value: report.target.partitionScheme }) : null,
        report.target.psramMode ? `PSRAM ${report.target.psramMode}` : null,
    ].filter(Boolean);
    const targetLabel = targetParts.join(' · ') || report.target.resolvedFqbn;
    const simple = displayMode === 'simple';
    const actionableChecks = presentation.orderedChecks.filter(check => check.state === 'error' || check.state === 'warning');
    const visibleChecks = compact || simple
        ? (actionableChecks.length > 0 ? actionableChecks : presentation.orderedChecks.slice(0, 1))
        : presentation.orderedChecks;
    const hiddenCheckCount = Math.max(0, presentation.orderedChecks.length - visibleChecks.length);
    const psramCheckState = report.checks.find(check => check.id === 'psram')?.state ?? 'unknown';

    return (
        <section
            data-ck-role="device-health-panel"
            data-ck-device-health-status={presentation.status}
            data-ck-device-chip-model={report.device.chip || ''}
            data-ck-device-flash-bytes={report.memory.flashBytes ?? ''}
            data-ck-device-configured-flash-bytes={report.target.configuredFlashBytes ?? ''}
            data-ck-device-psram-bytes={report.memory.psramBytes ?? ''}
            data-ck-device-psram-check-state={psramCheckState}
            data-ck-device-fqbn={report.target.resolvedFqbn}
            data-ck-view-mode={displayMode}
            className={`mx-2 mt-2 shrink-0 rounded-md border ${theme.shell} ${compact ? 'px-2.5 py-2' : 'px-3 py-2.5'}`}
            aria-label={t('device.title')}
            aria-live="polite"
        >
            <div className="flex min-w-0 items-start gap-2.5">
                <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${theme.icon}`}>
                    <StatusIcon size={15} aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                            <HeartPulse size={11} />{t('device.title')}
                        </span>
                        <span className={`text-xs font-bold ${theme.title}`}>{t(`device.status.${presentation.status}.title`)}</span>
                        {isRunning && <span className="animate-pulse text-[10px] text-blue-600 dark:text-blue-300">{t('device.rerunning')}</span>}
                    </div>
                    {!compact && <p className="mt-0.5 text-[11px] leading-4 text-slate-600 dark:text-slate-300">{t(`device.status.${presentation.status}.explanation`)}</p>}
                </div>
                <span className="shrink-0 text-[9px] text-slate-400 dark:text-slate-500" title={t('device.measuredAt', { value: measuredAtText })}>{measuredAtText}</span>
            </div>

            <div
                className={`mt-2 grid gap-1.5 ${compact
                    ? 'grid-cols-[repeat(auto-fit,minmax(118px,1fr))]'
                    : 'grid-cols-[repeat(auto-fit,minmax(150px,1fr))]'}`}
                aria-label={t('device.factsAriaLabel')}
            >
                {fact(Cpu, t('device.fact.chip'), chipLabel)}
                {fact(KeyRound, t('device.fact.mac'), identityLabel, {
                    title: report.device.mac ? t('device.fullMacPrivacy') : identityLabel,
                    copyValue: report.device.mac || undefined,
                    copyLabel: t('device.copyFullMac'),
                    dataRole: 'device-health-full-mac',
                })}
                {fact(HardDrive, t('device.fact.flash'), flashLabel)}
                {!compact && fact(Database, t('device.fact.psram'), psramLabel, {
                    title: report.memory.psramBytes == null ? t('device.psramUnknownTitle') : psramLabel,
                })}
                {fact(Usb, t('device.fact.port'), report.device.portAfter || report.device.portBefore)}
                {!simple && fact(Cpu, t('device.fact.target'), targetLabel, {
                    detail: report.target.resolvedFqbn,
                    title: report.target.resolvedFqbn,
                    copyValue: report.target.resolvedFqbn,
                    copyLabel: t('device.copyFullFqbn'),
                    dataRole: 'device-health-full-fqbn',
                    // Give the canonical FQBN a complete row. `col-span-2` can
                    // create an implicit second column in a one-column panel
                    // and make narrow windows overflow.
                    className: 'col-span-full',
                })}
                {simple && (
                    <details data-ck-role="device-health-advanced-target" className="col-span-full rounded border border-white/80 bg-white/75 px-2 py-1.5 text-[9px] dark:border-slate-700 dark:bg-slate-900/65">
                        <summary className="cursor-pointer select-none font-semibold text-brand-700 hover:text-brand-800 dark:text-brand-300 dark:hover:text-brand-200">
                            {t('device.showFullTarget')}
                        </summary>
                        <div className="mt-1">
                            {fact(Cpu, t('device.fact.target'), targetLabel, {
                                detail: report.target.resolvedFqbn,
                                title: report.target.resolvedFqbn,
                                copyValue: report.target.resolvedFqbn,
                                copyLabel: t('device.copyFullFqbn'),
                                dataRole: 'device-health-full-fqbn',
                            })}
                        </div>
                    </details>
                )}
            </div>

            {visibleChecks.length > 0 && (
                <div className="mt-2 grid gap-1.5" aria-label={t('device.checksAriaLabel')}>
                    {visibleChecks.map(check => (
                        <div key={check.id} className={`min-w-0 rounded border px-2 py-1 text-[10px] ${checkTheme(check)}`}>
                            <div className="flex min-w-0 items-center gap-1.5">
                                <span className="shrink-0 font-bold">{t(`device.checkState.${check.state}`)}</span>
                                <span className="min-w-0 whitespace-normal break-words text-slate-700 [overflow-wrap:anywhere] dark:text-slate-200" title={check.title}>{t(`device.check.${check.id}.${check.state}`, { defaultValue: check.title })}</span>
                                <span className="ml-auto shrink-0 text-[8px] opacity-70">{t(`device.certainty.${check.certainty}`)}</span>
                            </div>
                            {!compact && !simple && check.evidence && (
                                <div className="mt-0.5 select-text whitespace-normal break-all font-mono text-[9px] leading-3.5 opacity-75" title={check.evidence}>
                                    {check.evidence}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {hiddenCheckCount > 0 && (
                <div className="mt-1.5 text-[9px] leading-4 text-slate-500 dark:text-slate-400">
                    {t('device.hiddenChecks', { count: hiddenCheckCount })}
                </div>
            )}

            <div className="mt-2 flex items-center gap-1.5 border-t border-current/10 pt-1.5 text-[9px] text-slate-500 dark:text-slate-400">
                <HeartPulse size={10} className="shrink-0" />
                <span>{t('device.resetDisclaimer')}</span>
            </div>
        </section>
    );
}

export default DeviceHealthPanel;
