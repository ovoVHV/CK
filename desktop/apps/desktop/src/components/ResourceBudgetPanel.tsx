import { ChevronDown, Gauge, HardDrive, MemoryStick } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUiText } from '../i18n/uiText';
import {
    assessMemoryConfiguration,
    formatResourceBytes,
    parseCompileMemoryConfiguration,
    selectCompileMemoryConfigurationFqbn,
    type CompileResourceMetricReport,
    type CompileResourceReport,
    type ResourceBudgetLevel,
} from '../services/compile_resources';
import {
    explainCompileResourceGrowth,
    type ResourceGrowthExplanation,
} from '../services/resource_growth';

interface ResourceBudgetPanelProps {
    report: CompileResourceReport | null;
    fqbn?: string;
    configurationFqbn?: string;
    configurationSource?: 'loading' | 'resolved' | 'core-default' | 'unverified';
    isCompiling?: boolean;
    compact?: boolean;
}

const levelTheme = (level: ResourceBudgetLevel) => {
    if (level === 'critical') {
        return {
            bar: 'bg-red-500',
            track: 'bg-red-100 dark:bg-red-950/70',
            text: 'text-red-700 dark:text-red-300',
            badge: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/45 dark:text-red-300',
            labelKey: 'resource.level.critical',
        };
    }
    if (level === 'warning') {
        return {
            bar: 'bg-amber-500',
            track: 'bg-amber-100 dark:bg-amber-950/70',
            text: 'text-amber-700 dark:text-amber-300',
            badge: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/45 dark:text-amber-300',
            labelKey: 'resource.level.warning',
        };
    }
    return {
        bar: 'bg-emerald-500',
        track: 'bg-emerald-100 dark:bg-emerald-950/70',
        text: 'text-emerald-700 dark:text-emerald-300',
        badge: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/45 dark:text-emerald-300',
        labelKey: 'resource.level.healthy',
    };
};

const deltaClass = (deltaBytes: number | null): string => {
    if (deltaBytes == null || deltaBytes === 0) return 'text-slate-400 dark:text-slate-500';
    return deltaBytes > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300';
};

const percentageText = (percent: number): string => `${percent.toFixed(1)}%`;

interface MetricProps {
    name: string;
    description: string;
    metric: CompileResourceMetricReport;
    compact: boolean;
}

function ResourceMetric({ name, description, metric, compact }: MetricProps) {
    const { t: translate } = useTranslation('health');
    const t = translate as unknown as (key: string, options?: Record<string, unknown>) => string;
    const theme = levelTheme(metric.level);
    const capacityKnown = metric.capacityKnown !== false && metric.totalBytes > 0;
    const width = Math.min(100, Math.max(0, metric.percent));
    const delta = metric.baselineCapacityChanged
        ? t('resource.delta.capacityChanged')
        : metric.deltaBytes == null || metric.deltaPercentagePoints == null
            ? t('resource.delta.noBaseline')
            : metric.deltaBytes === 0 && Math.abs(metric.deltaPercentagePoints) < 0.05
                ? t('resource.delta.unchanged')
                : t('resource.delta.changed', {
                    bytes: `${metric.deltaBytes > 0 ? '+' : metric.deltaBytes < 0 ? '−' : ''}${formatResourceBytes(Math.abs(metric.deltaBytes))}`,
                    percent: `${metric.deltaPercentagePoints > 0 ? '+' : metric.deltaPercentagePoints < 0 ? '−' : ''}${Math.abs(metric.deltaPercentagePoints).toFixed(1)}%`,
                });
    const percentLabel = capacityKnown ? percentageText(metric.percent) : t('resource.capacityUnknown');
    const details = capacityKnown
        ? `${formatResourceBytes(metric.usedBytes)} / ${formatResourceBytes(metric.totalBytes)}`
        : t('resource.usedUnknownCapacity', { used: formatResourceBytes(metric.usedBytes) });

    if (compact) {
        return (
            <div className="min-w-0" title={t('resource.metricTitle', { name, percent: percentLabel, details, delta })}>
                <div className="flex min-w-0 items-baseline gap-1.5 leading-4">
                    <span className="shrink-0 text-[10px] font-bold text-slate-600 dark:text-slate-300">{name}</span>
                    <span className={`shrink-0 font-mono text-[10px] font-bold ${capacityKnown ? theme.text : 'text-slate-500 dark:text-slate-400'}`}>{percentLabel}</span>
                    <span className="truncate font-mono text-[9px] text-slate-500 dark:text-slate-400">{details}</span>
                </div>
                {capacityKnown ? (
                    <div
                        className={`mt-1 h-1 rounded-full overflow-hidden ${theme.track}`}
                        role="progressbar"
                        aria-label={t('resource.usageAriaLabel', { name })}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Number(width.toFixed(1))}
                        aria-valuetext={t('resource.usageValueText', { percent: percentageText(metric.percent), details })}
                    >
                        <div className={`h-full rounded-full transition-[width] duration-300 ${theme.bar}`} style={{ width: `${width}%` }} />
                    </div>
                ) : (
                    <div className="mt-1 h-1 rounded-full bg-slate-200 dark:bg-slate-700" aria-label={t('resource.unknownCapacityAriaLabel', { name })} />
                )}
            </div>
        );
    }

    return (
        <div className="min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.03)] dark:border-slate-700 dark:bg-slate-900/75 dark:shadow-none">
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <div className="text-[11px] font-bold text-slate-700 dark:text-slate-200">{name}</div>
                    <div className="mt-0.5 truncate text-[9px] text-slate-400 dark:text-slate-500" title={description}>{description}</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                    <span className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold ${capacityKnown ? theme.badge : 'border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'}`}>{capacityKnown ? t(theme.labelKey) : t('resource.capacityUnknown')}</span>
                </div>
            </div>
            <div className="mt-2 flex min-w-0 items-end justify-between gap-2">
                <div className="min-w-0 truncate font-mono text-[15px] font-bold leading-none text-slate-700 dark:text-slate-100">
                    {formatResourceBytes(metric.usedBytes)}
                    <span className="ml-1 text-[9px] font-normal text-slate-400 dark:text-slate-500">{t('resource.used')}</span>
                </div>
                <strong className={`shrink-0 font-mono text-xs ${capacityKnown ? theme.text : 'text-slate-500 dark:text-slate-400'}`}>{percentLabel}</strong>
            </div>
            {capacityKnown ? (
                <div
                    className={`mt-2 h-1.5 overflow-hidden rounded-full ${theme.track}`}
                    role="progressbar"
                    aria-label={t('resource.usageAriaLabel', { name })}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Number(width.toFixed(1))}
                    aria-valuetext={t('resource.usageValueText', { percent: percentageText(metric.percent), details })}
                >
                    <div className={`h-full rounded-full transition-[width] duration-300 ${theme.bar}`} style={{ width: `${width}%` }} />
                </div>
            ) : (
                <div className="mt-2 h-1.5 rounded-full bg-slate-200 dark:bg-slate-700" aria-label={t('resource.unknownCapacityAriaLabel', { name })} />
            )}
            <div className="mt-1.5 flex min-w-0 items-center justify-between gap-2 text-[9px]">
                <span className="shrink-0 font-mono text-slate-500 dark:text-slate-400">{capacityKnown ? t('resource.limit', { value: formatResourceBytes(metric.totalBytes) }) : t('resource.coreCapacityUnknown')}</span>
                <span className={deltaClass(metric.deltaBytes)}>{delta}</span>
            </div>
        </div>
    );
}

const signedBytes = (value: number | null): string => {
    if (value == null) return '—';
    return `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatResourceBytes(Math.abs(value))}`;
};

function ResourceGrowthDetails({
    explanation,
    compact,
}: {
    explanation: ResourceGrowthExplanation;
    compact: boolean;
}) {
    const { t: translate } = useTranslation('health');
    const { isEn } = useUiText();
    const t = translate as unknown as (key: string, options?: Record<string, unknown>) => string;
    const localizeContributionLabel = (label: string, kind: string) => {
        if (kind === 'linker-overhead') return t('resource.growth.linkerOverhead');
        if (!isEn) return label;
        if (label === '生成代码') return 'Generated code';
        if (label === '其他链接对象') return 'Other linked objects';
        const overflowMatch = label.match(/^其他链接对象（(\d+)\s*组）$/);
        if (overflowMatch) return `Other linked objects (${overflowMatch[1]} groups)`;
        return label;
    };
    const positiveGrowth = (explanation.flashDeltaBytes || 0) > 0
        || (explanation.ramDeltaBytes || 0) > 0;
    const title = t(positiveGrowth ? 'resource.growth.whyLarger' : 'resource.growth.title');
    const deltaParts = [
        explanation.flashDeltaBytes == null ? null : `Flash ${signedBytes(explanation.flashDeltaBytes)}`,
        explanation.ramDeltaBytes == null ? null : `RAM ${signedBytes(explanation.ramDeltaBytes)}`,
    ].filter((part): part is string => Boolean(part));
    const summary = explanation.status === 'incomparable'
        ? t('resource.growth.summary.incomparable')
        : explanation.status === 'no-baseline'
            ? t('resource.growth.summary.noBaseline')
            : deltaParts.length > 0
                ? deltaParts.join(t('listSeparator'))
                : t('resource.growth.summary.noChange');
    const detail = t(`resource.growth.detail.${explanation.status}`);
    return (
        <details
            data-ck-role="resource-growth-explanation"
            className={`group min-w-0 rounded-md border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900/75 ${compact ? 'w-full' : ''}`}
        >
            <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-[10px] font-bold text-slate-600 outline-none hover:text-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-slate-300 dark:hover:text-brand-300">
                <ChevronDown size={12} className="shrink-0 transition-transform group-open:rotate-180" />
                <span className="shrink-0">{title}</span>
                <span className="min-w-0 truncate font-mono text-[9px] font-medium text-slate-400 dark:text-slate-500">
                    {summary}
                </span>
                <span className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[8px] ${explanation.status === 'verified'
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                    : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}`}
                >
                    {t(explanation.status === 'verified' ? 'resource.growth.verifiedMap' : 'resource.growth.totalOnly')}
                </span>
            </summary>
            <div className="border-t border-slate-100 px-2.5 py-2 text-[9px] leading-4 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                <p>{detail}</p>
                {explanation.contributions.length > 0 && (
                    <div className="mt-1.5 grid gap-1" aria-label={t('resource.growth.sourcesAriaLabel')}>
                        {explanation.contributions.slice(0, 8).map(item => (
                            <div key={item.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded bg-slate-50 px-2 py-1 dark:bg-slate-800/75">
                                <span className="min-w-0 truncate font-semibold text-slate-700 dark:text-slate-200" title={localizeContributionLabel(item.label, item.kind)}>{localizeContributionLabel(item.label, item.kind)}</span>
                                <span className={deltaClass(item.flashDeltaBytes)}>Flash {signedBytes(item.flashDeltaBytes)}</span>
                                <span className={deltaClass(item.ramDeltaBytes)}>RAM {signedBytes(item.ramDeltaBytes)}</span>
                            </div>
                        ))}
                        {explanation.contributions.length > 8 && (
                            <span>{t('resource.growth.moreContributions', { count: explanation.contributions.length - 8 })}</span>
                        )}
                    </div>
                )}
            </div>
        </details>
    );
}

export function ResourceBudgetPanel({
    report,
    fqbn = '',
    configurationFqbn = '',
    configurationSource = 'resolved',
    isCompiling = false,
    compact = false,
}: ResourceBudgetPanelProps) {
    const { t: translate, i18n } = useTranslation('health');
    const t = translate as unknown as (key: string, options?: Record<string, unknown>) => string;
    if (!report || (!report.flash && !report.ram)) return null;

    const resolvedFqbn = report.fqbn || fqbn;
    const configurationIdentity = configurationFqbn || resolvedFqbn;
    const configurationParseIdentity = selectCompileMemoryConfigurationFqbn(
        configurationIdentity,
        resolvedFqbn,
    );
    const configuration = parseCompileMemoryConfiguration(configurationParseIdentity);
    const assessment = assessMemoryConfiguration(configuration, report.uploaderMemory);
    const unresolvedValue = configurationSource === 'loading'
        ? t('resource.configuration.loading')
        : configurationSource === 'unverified'
            ? t('resource.configuration.unverified')
            : t('resource.configuration.coreDefault');
    const configuredFlash = configuration.flashSizeOption || unresolvedValue;
    const configuredPartition = configuration.partitionSchemeOption || unresolvedValue;
    const configuredPsram = configuration.psramOption || unresolvedValue;
    const configurationText = [
        `FlashSize=${configuredFlash}`,
        `PartitionScheme=${configuredPartition}`,
        `PSRAM=${configuredPsram}`,
    ].join(' · ');
    const isEsp32 = /^esp32:esp32:/i.test(resolvedFqbn || configurationIdentity);
    const partitionLabel = t(isEsp32 ? 'resource.configuration.appPartition' : 'resource.configuration.partitionScheme');
    const observedFlash = report.uploaderMemory?.flashBytes != null
        ? formatResourceBytes(report.uploaderMemory.flashBytes)
        : t('resource.notMeasured');
    const observedPsram = report.uploaderMemory?.psramBytes != null
        ? formatResourceBytes(report.uploaderMemory.psramBytes)
        : t('resource.notMeasured');
    const observedAt = report.uploaderMemory?.measuredAt
        ? new Date(report.uploaderMemory.measuredAt)
        : null;
    const observedAtText = observedAt && Number.isFinite(observedAt.getTime())
        ? observedAt.toLocaleString(i18n.resolvedLanguage || i18n.language, { hour12: false })
        : '';
    const uploaderText = report.uploaderMemory
        ? `Flash=${observedFlash} · PSRAM=${observedPsram}${observedAtText ? ` · ${observedAtText}` : ''}`
        : t(isEsp32 ? 'resource.measurement.noSuccessfulUpload' : 'resource.measurement.unsupported');
    const assessmentItems = [
        assessment.flash === 'configured-larger'
            ? {
                text: t('resource.assessment.configuredLarger'),
                className: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/45 dark:text-red-300',
            }
            : assessment.flash === 'configured-smaller'
                ? {
                    text: t('resource.assessment.configuredSmaller'),
                    className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/45 dark:text-amber-300',
                }
                : assessment.flash === 'match'
                    ? {
                        text: t('resource.assessment.match'),
                        className: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/45 dark:text-emerald-300',
                    }
                    : null,
        assessment.psramDisabledButPresent
            ? {
                text: t('resource.assessment.psramDisabled'),
                className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/45 dark:text-amber-300',
            }
            : null,
    ].filter((item): item is NonNullable<typeof item> => item !== null);

    const metrics = [
        report.flash ? { key: 'flash', name: t('resource.programSpace'), description: t(isEsp32 ? 'resource.programSpaceEsp32Description' : 'resource.programSpaceDescription'), metric: report.flash } : null,
        report.ram ? { key: 'ram', name: t('resource.internalRam'), description: t('resource.internalRamDescription'), metric: report.ram } : null,
    ].filter((item): item is NonNullable<typeof item> => item !== null);
    const configurationTitle = t('resource.configuration.title', { values: configurationText, projectIdentity: configurationIdentity, backendIdentity: resolvedFqbn });
    const measurementTitle = t('resource.measurement.title', { values: uploaderText });
    const growthExplanation = explainCompileResourceGrowth(report);

    if (compact) {
        return (
            <section data-ck-role="resource-budget-panel" className="mx-2 mt-1 shrink-0 rounded-md border border-slate-200 bg-white/90 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-900/85" aria-label={t('resource.panelAriaLabel')}>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="flex shrink-0 items-center gap-1 text-[9px] font-bold text-slate-500 dark:text-slate-400" title={t('resource.budgetTitle')}>
                        <Gauge size={11} />{t('resource.budget')}
                    </span>
                    <div
                        className="grid min-w-0 flex-[1_1_180px] gap-3"
                        style={{
                            gridTemplateColumns: metrics.length > 1
                                ? 'repeat(auto-fit, minmax(160px, 1fr))'
                                : 'minmax(0, 1fr)',
                        }}
                    >
                        {metrics.map(({ key, ...metricProps }) => (
                            <ResourceMetric key={key} {...metricProps} compact />
                        ))}
                    </div>
                    {isCompiling && <span className="ml-auto shrink-0 animate-pulse text-[9px] text-blue-600 dark:text-blue-300">{t('resource.updating')}</span>}
                </div>
                {isEsp32 && (
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-100 pt-1 text-[8px] text-slate-400 dark:border-slate-800 dark:text-slate-500">
                        <span className="min-w-0 max-w-full break-all leading-4" title={configurationTitle}>{t('resource.compactConfiguration', { partition: configuredPartition, psram: configuredPsram })}</span>
                        <span className="min-w-0 max-w-full break-words leading-4" title={measurementTitle}>{t('resource.compactMeasurement', { flash: observedFlash, psram: observedPsram })}</span>
                        {assessmentItems.map(item => (
                            <span key={item.text} className={`max-w-full rounded border px-1 leading-4 ${item.className}`}>{item.text}</span>
                        ))}
                    </div>
                )}
            </section>
        );
    }

    return (
        <section data-ck-role="resource-budget-panel" className="mx-2 mt-1.5 shrink-0 rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2.5 dark:border-slate-700 dark:bg-slate-800/65" aria-label={t('resource.panelAriaLabel')}>
            <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-200/70 text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                        <Gauge size={13} />
                    </span>
                    <div className="min-w-0">
                        <div className="text-[10px] font-bold text-slate-700 dark:text-slate-200">{t('resource.budget')}</div>
                        <div className="text-[9px] text-slate-400 dark:text-slate-500">
                            {t(isEsp32 ? 'resource.subtitleEsp32' : 'resource.subtitleCore')}
                        </div>
                    </div>
                </div>
                {isCompiling && <span className="shrink-0 animate-pulse rounded-full bg-blue-50 px-2 py-0.5 text-[9px] text-blue-600 dark:bg-blue-950/50 dark:text-blue-300">{t('resource.updatingResult')}</span>}
            </div>
            <div className="mt-2 grid min-w-0 grid-cols-1 gap-2">
                <div
                    className="grid min-w-0 gap-2"
                    style={{
                        gridTemplateColumns: metrics.length > 1
                            ? 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))'
                            : 'minmax(0, 1fr)',
                    }}
                    aria-label={t('resource.currentBuildAriaLabel')}
                >
                    {metrics.map(({ key, ...metricProps }) => (
                        <ResourceMetric key={key} {...metricProps} compact={false} />
                    ))}
                </div>

                <ResourceGrowthDetails explanation={growthExplanation} compact={false} />

                {isEsp32 && (
                    <aside className="min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)] dark:border-slate-700 dark:bg-slate-900/75 dark:shadow-none" aria-label={t('resource.boardCapacityAriaLabel')}>
                    <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-1.5 dark:border-slate-800">
                        <span className="flex items-center gap-1.5 text-[10px] font-bold text-slate-700 dark:text-slate-200">
                            <HardDrive size={12} className="text-slate-400 dark:text-slate-500" />{t('resource.boardCapacity')}
                        </span>
                        <span className="text-[9px] text-slate-400 dark:text-slate-500">{t('resource.configurationNotProgramSpace')}</span>
                    </div>
                    <div className="grid min-w-0 grid-cols-2 divide-x divide-slate-100 dark:divide-slate-800">
                        <div className="min-w-0 px-3 py-2" title={configurationTitle}>
                            <div className="text-[9px] font-semibold tracking-wide text-slate-400 dark:text-slate-500">{t('resource.currentConfiguration')}</div>
                            <div className="mt-1.5 grid min-w-0 grid-cols-2 gap-2">
                                <div className="min-w-0">
                                    <div className="text-[9px] text-slate-400 dark:text-slate-500">{t('resource.configuredFlash')}</div>
                                    <div className="break-words font-mono text-[13px] font-bold text-slate-700 dark:text-slate-100">{configuredFlash}</div>
                                </div>
                                <div className="min-w-0">
                                    <div className="text-[9px] text-slate-400 dark:text-slate-500">{t('resource.psramMode')}</div>
                                    <div className="break-words font-mono text-[11px] font-semibold text-slate-600 dark:text-slate-300">{configuredPsram}</div>
                                </div>
                            </div>
                            <div className="mt-1.5 flex min-w-0 items-baseline gap-1 border-t border-slate-100 pt-1 dark:border-slate-800">
                                <span className="shrink-0 text-[9px] text-slate-400 dark:text-slate-500">{partitionLabel}</span>
                                <span className="min-w-0 break-all font-mono text-[10px] leading-4 text-slate-600 dark:text-slate-300" title={configuredPartition}>{configuredPartition}</span>
                            </div>
                        </div>

                        <div className="min-w-0 px-3 py-2" title={measurementTitle}>
                            <div className="flex min-w-0 items-center justify-between gap-1">
                                <span className="text-[9px] font-semibold tracking-wide text-slate-400 dark:text-slate-500">{t('resource.latestMeasurement')}</span>
                                <MemoryStick size={11} className="shrink-0 text-slate-300 dark:text-slate-600" />
                            </div>
                            <div className="mt-1.5 grid min-w-0 grid-cols-2 gap-2">
                                <div className="min-w-0">
                                    <div className="text-[9px] text-slate-400 dark:text-slate-500">{t('resource.physicalFlash')}</div>
                                    <div className="break-words font-mono text-[13px] font-bold text-slate-700 dark:text-slate-100">{observedFlash}</div>
                                </div>
                                <div className="min-w-0">
                                    <div className="text-[9px] text-slate-400 dark:text-slate-500">{t('resource.physicalPsram')}</div>
                                    <div className="break-words font-mono text-[13px] font-bold text-slate-700 dark:text-slate-100">{observedPsram}</div>
                                </div>
                            </div>
                            <div className="mt-1.5 break-words border-t border-slate-100 pt-1 text-[9px] leading-4 text-slate-400 dark:border-slate-800 dark:text-slate-500">
                                {observedAtText || t(isEsp32 ? 'resource.measurement.readByUploader' : 'resource.measurement.updatedAfterUpload')}
                                {isEsp32 && <span>{t('resource.measurement.nrDisclaimerSuffix')}</span>}
                            </div>
                        </div>
                    </div>
                    {assessmentItems.length > 0 && (
                        <div className="flex min-w-0 flex-wrap gap-1.5 border-t border-slate-100 px-2.5 py-1.5 dark:border-slate-800" aria-label={t('resource.capacityCheckAriaLabel')}>
                            {assessmentItems.map(item => (
                                <span key={item.text} className={`rounded-md border px-1.5 py-0.5 text-[9px] font-medium ${item.className}`}>{item.text}</span>
                            ))}
                        </div>
                    )}
                    </aside>
                )}
            </div>
            {isEsp32 && (
                <div className="mt-1.5 flex min-w-0 items-center justify-end text-[9px] text-slate-400 dark:text-slate-500">
                    <span className="truncate" title={t('resource.esp32DisclaimerTitle')}>
                        {t('resource.esp32Disclaimer')}
                    </span>
                </div>
            )}
        </section>
    );
}
