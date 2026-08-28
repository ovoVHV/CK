import { ChevronDown, Gauge, HardDrive, MemoryStick } from 'lucide-react';
import {
    assessMemoryConfiguration,
    formatResourceBytes,
    formatResourceDelta,
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
            label: '空间紧张',
        };
    }
    if (level === 'warning') {
        return {
            bar: 'bg-amber-500',
            track: 'bg-amber-100 dark:bg-amber-950/70',
            text: 'text-amber-700 dark:text-amber-300',
            badge: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/45 dark:text-amber-300',
            label: '接近上限',
        };
    }
    return {
        bar: 'bg-emerald-500',
        track: 'bg-emerald-100 dark:bg-emerald-950/70',
        text: 'text-emerald-700 dark:text-emerald-300',
        badge: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/45 dark:text-emerald-300',
        label: '余量充足',
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
    const theme = levelTheme(metric.level);
    const capacityKnown = metric.capacityKnown !== false && metric.totalBytes > 0;
    const width = Math.min(100, Math.max(0, metric.percent));
    const delta = formatResourceDelta(
        metric.deltaBytes,
        metric.deltaPercentagePoints,
        metric.baselineCapacityChanged,
    );
    const percentLabel = capacityKnown ? percentageText(metric.percent) : '上限未知';
    const details = capacityKnown
        ? `${formatResourceBytes(metric.usedBytes)} / ${formatResourceBytes(metric.totalBytes)}`
        : `${formatResourceBytes(metric.usedBytes)} 已用 · 上限未知`;

    if (compact) {
        return (
            <div className="min-w-0" title={`${name} ${percentLabel}，${details}，${delta}`}>
                <div className="flex min-w-0 items-baseline gap-1.5 leading-4">
                    <span className="shrink-0 text-[10px] font-bold text-slate-600 dark:text-slate-300">{name}</span>
                    <span className={`shrink-0 font-mono text-[10px] font-bold ${capacityKnown ? theme.text : 'text-slate-500 dark:text-slate-400'}`}>{percentLabel}</span>
                    <span className="truncate font-mono text-[9px] text-slate-500 dark:text-slate-400">{details}</span>
                </div>
                {capacityKnown ? (
                    <div
                        className={`mt-1 h-1 rounded-full overflow-hidden ${theme.track}`}
                        role="progressbar"
                        aria-label={`${name} 使用率`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Number(width.toFixed(1))}
                        aria-valuetext={`${percentageText(metric.percent)}，已用 ${details}`}
                    >
                        <div className={`h-full rounded-full transition-[width] duration-300 ${theme.bar}`} style={{ width: `${width}%` }} />
                    </div>
                ) : (
                    <div className="mt-1 h-1 rounded-full bg-slate-200 dark:bg-slate-700" aria-label={`${name} 上限未知`} />
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
                    <span className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold ${capacityKnown ? theme.badge : 'border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'}`}>{capacityKnown ? theme.label : '上限未知'}</span>
                </div>
            </div>
            <div className="mt-2 flex min-w-0 items-end justify-between gap-2">
                <div className="min-w-0 truncate font-mono text-[15px] font-bold leading-none text-slate-700 dark:text-slate-100">
                    {formatResourceBytes(metric.usedBytes)}
                    <span className="ml-1 text-[9px] font-normal text-slate-400 dark:text-slate-500">已用</span>
                </div>
                <strong className={`shrink-0 font-mono text-xs ${capacityKnown ? theme.text : 'text-slate-500 dark:text-slate-400'}`}>{percentLabel}</strong>
            </div>
            {capacityKnown ? (
                <div
                    className={`mt-2 h-1.5 overflow-hidden rounded-full ${theme.track}`}
                    role="progressbar"
                    aria-label={`${name} 使用率`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Number(width.toFixed(1))}
                    aria-valuetext={`${percentageText(metric.percent)}，已用 ${details}`}
                >
                    <div className={`h-full rounded-full transition-[width] duration-300 ${theme.bar}`} style={{ width: `${width}%` }} />
                </div>
            ) : (
                <div className="mt-2 h-1.5 rounded-full bg-slate-200 dark:bg-slate-700" aria-label={`${name} 上限未知`} />
            )}
            <div className="mt-1.5 flex min-w-0 items-center justify-between gap-2 text-[9px]">
                <span className="shrink-0 font-mono text-slate-500 dark:text-slate-400">{capacityKnown ? `上限 ${formatResourceBytes(metric.totalBytes)}` : '核心未提供可信上限'}</span>
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
    const positiveGrowth = (explanation.flashDeltaBytes || 0) > 0
        || (explanation.ramDeltaBytes || 0) > 0;
    const title = positiveGrowth ? '为什么变大？' : '资源变化解释';
    return (
        <details
            data-ck-role="resource-growth-explanation"
            className={`group min-w-0 rounded-md border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900/75 ${compact ? 'w-full' : ''}`}
        >
            <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-[10px] font-bold text-slate-600 outline-none hover:text-teal-700 focus-visible:ring-2 focus-visible:ring-teal-500 dark:text-slate-300 dark:hover:text-teal-300">
                <ChevronDown size={12} className="shrink-0 transition-transform group-open:rotate-180" />
                <span className="shrink-0">{title}</span>
                <span className="min-w-0 truncate font-mono text-[9px] font-medium text-slate-400 dark:text-slate-500">
                    {explanation.summary}
                </span>
                <span className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[8px] ${explanation.status === 'verified'
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                    : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}`}
                >
                    {explanation.status === 'verified' ? 'map 已核验' : '仅总量'}
                </span>
            </summary>
            <div className="border-t border-slate-100 px-2.5 py-2 text-[9px] leading-4 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                <p>{explanation.detail}</p>
                {explanation.contributions.length > 0 && (
                    <div className="mt-1.5 grid gap-1" aria-label="资源增长来源">
                        {explanation.contributions.slice(0, 8).map(item => (
                            <div key={item.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded bg-slate-50 px-2 py-1 dark:bg-slate-800/75">
                                <span className="min-w-0 truncate font-semibold text-slate-700 dark:text-slate-200" title={item.label}>{item.label}</span>
                                <span className={deltaClass(item.flashDeltaBytes)}>Flash {signedBytes(item.flashDeltaBytes)}</span>
                                <span className={deltaClass(item.ramDeltaBytes)}>RAM {signedBytes(item.ramDeltaBytes)}</span>
                            </div>
                        ))}
                        {explanation.contributions.length > 8 && (
                            <span>另有 {explanation.contributions.length - 8} 项保留在机器可读报告中。</span>
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
        ? '读取中'
        : configurationSource === 'unverified'
            ? '未验证'
            : '核心默认';
    const configuredFlash = configuration.flashSizeOption || unresolvedValue;
    const configuredPartition = configuration.partitionSchemeOption || unresolvedValue;
    const configuredPsram = configuration.psramOption || unresolvedValue;
    const configurationText = [
        `FlashSize=${configuredFlash}`,
        `PartitionScheme=${configuredPartition}`,
        `PSRAM=${configuredPsram}`,
    ].join(' · ');
    const isEsp32 = /^esp32:esp32:/i.test(resolvedFqbn || configurationIdentity);
    const partitionLabel = isEsp32 ? 'APP 分区' : '分区方案';
    const observedFlash = report.uploaderMemory?.flashBytes != null
        ? formatResourceBytes(report.uploaderMemory.flashBytes)
        : '未实测';
    const observedPsram = report.uploaderMemory?.psramBytes != null
        ? formatResourceBytes(report.uploaderMemory.psramBytes)
        : '未实测';
    const observedAt = report.uploaderMemory?.measuredAt
        ? new Date(report.uploaderMemory.measuredAt)
        : null;
    const observedAtText = observedAt && Number.isFinite(observedAt.getTime())
        ? observedAt.toLocaleString('zh-CN', { hour12: false })
        : '';
    const uploaderText = report.uploaderMemory
        ? `Flash=${observedFlash} · PSRAM=${observedPsram}${observedAtText ? ` · ${observedAtText}` : ''}`
        : isEsp32
            ? '尚无成功上传实测（不从 N/R 型号名推断）'
            : '当前上传器不提供实体 Flash/PSRAM 独立实测';
    const assessmentItems = [
        assessment.flash === 'configured-larger'
            ? {
                text: '配置容量大于实体 Flash，上传前需修正',
                className: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/45 dark:text-red-300',
            }
            : assessment.flash === 'configured-smaller'
                ? {
                    text: '配置容量小于实体 Flash，仅使用部分空间',
                    className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/45 dark:text-amber-300',
                }
                : assessment.flash === 'match'
                    ? {
                        text: '配置 Flash 与实体容量匹配',
                        className: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/45 dark:text-emerald-300',
                    }
                    : null,
        assessment.psramDisabledButPresent
            ? {
                text: '检测到实体 PSRAM，但当前配置未启用',
                className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/45 dark:text-amber-300',
            }
            : null,
    ].filter((item): item is NonNullable<typeof item> => item !== null);

    const metrics = [
        report.flash ? { key: 'flash', name: '程序空间', description: isEsp32 ? 'APP 分区上限，不等于整颗 Flash' : '当前编译目标的程序上限', metric: report.flash } : null,
        report.ram ? { key: 'ram', name: '内部 RAM', description: '静态用量，不含 PSRAM', metric: report.ram } : null,
    ].filter((item): item is NonNullable<typeof item> => item !== null);
    const configurationTitle = `配置值：${configurationText}\n项目配置身份：${configurationIdentity}\n后端编译身份：${resolvedFqbn}`;
    const measurementTitle = `最近一次成功上传实测：${uploaderText}\n更换开发板后请重新上传以更新测量。`;
    const growthExplanation = explainCompileResourceGrowth(report);

    if (compact) {
        return (
            <section data-ck-role="resource-budget-panel" className="mx-2 mt-1 shrink-0 rounded-md border border-slate-200 bg-white/90 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-900/85" aria-label="程序空间和内部 RAM 资源预算">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="flex shrink-0 items-center gap-1 text-[9px] font-bold text-slate-500 dark:text-slate-400" title="程序空间按当前编译目标上限计算（ESP32 为 APP 分区）；内部 RAM 不含 PSRAM">
                        <Gauge size={11} />资源预算
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
                    {isCompiling && <span className="ml-auto shrink-0 animate-pulse text-[9px] text-blue-600 dark:text-blue-300">更新中</span>}
                </div>
                {isEsp32 && (
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-100 pt-1 text-[8px] text-slate-400 dark:border-slate-800 dark:text-slate-500">
                        <span className="min-w-0 max-w-full break-all leading-4" title={configurationTitle}>分区 {configuredPartition} · PSRAM 模式 {configuredPsram}</span>
                        <span className="min-w-0 max-w-full break-words leading-4" title={measurementTitle}>实体 Flash {observedFlash} · PSRAM {observedPsram}</span>
                        {assessmentItems.map(item => (
                            <span key={item.text} className={`max-w-full rounded border px-1 leading-4 ${item.className}`}>{item.text}</span>
                        ))}
                    </div>
                )}
            </section>
        );
    }

    return (
        <section data-ck-role="resource-budget-panel" className="mx-2 mt-1.5 shrink-0 rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2.5 dark:border-slate-700 dark:bg-slate-800/65" aria-label="程序空间和内部 RAM 资源预算">
            <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-200/70 text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                        <Gauge size={13} />
                    </span>
                    <div className="min-w-0">
                        <div className="text-[10px] font-bold text-slate-700 dark:text-slate-200">资源预算</div>
                        <div className="text-[9px] text-slate-400 dark:text-slate-500">
                            {isEsp32 ? '本次构建占用与板卡容量分开显示' : '本次构建占用（当前 Core 口径）'}
                        </div>
                    </div>
                </div>
                {isCompiling && <span className="shrink-0 animate-pulse rounded-full bg-blue-50 px-2 py-0.5 text-[9px] text-blue-600 dark:bg-blue-950/50 dark:text-blue-300">正在更新本次结果</span>}
            </div>
            <div className="mt-2 grid min-w-0 grid-cols-1 gap-2">
                <div
                    className="grid min-w-0 gap-2"
                    style={{
                        gridTemplateColumns: metrics.length > 1
                            ? 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))'
                            : 'minmax(0, 1fr)',
                    }}
                    aria-label="本次构建资源占用"
                >
                    {metrics.map(({ key, ...metricProps }) => (
                        <ResourceMetric key={key} {...metricProps} compact={false} />
                    ))}
                </div>

                <ResourceGrowthDetails explanation={growthExplanation} compact={false} />

                {isEsp32 && (
                    <aside className="min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)] dark:border-slate-700 dark:bg-slate-900/75 dark:shadow-none" aria-label="板卡 Flash 和 PSRAM 容量">
                    <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-1.5 dark:border-slate-800">
                        <span className="flex items-center gap-1.5 text-[10px] font-bold text-slate-700 dark:text-slate-200">
                            <HardDrive size={12} className="text-slate-400 dark:text-slate-500" />板卡容量
                        </span>
                        <span className="text-[9px] text-slate-400 dark:text-slate-500">配置值 ≠ 程序空间</span>
                    </div>
                    <div className="grid min-w-0 grid-cols-2 divide-x divide-slate-100 dark:divide-slate-800">
                        <div className="min-w-0 px-3 py-2" title={configurationTitle}>
                            <div className="text-[9px] font-semibold tracking-wide text-slate-400 dark:text-slate-500">当前编译配置</div>
                            <div className="mt-1.5 grid min-w-0 grid-cols-2 gap-2">
                                <div className="min-w-0">
                                    <div className="text-[9px] text-slate-400 dark:text-slate-500">配置 Flash</div>
                                    <div className="break-words font-mono text-[13px] font-bold text-slate-700 dark:text-slate-100">{configuredFlash}</div>
                                </div>
                                <div className="min-w-0">
                                    <div className="text-[9px] text-slate-400 dark:text-slate-500">PSRAM 模式</div>
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
                                <span className="text-[9px] font-semibold tracking-wide text-slate-400 dark:text-slate-500">最近成功上传实测</span>
                                <MemoryStick size={11} className="shrink-0 text-slate-300 dark:text-slate-600" />
                            </div>
                            <div className="mt-1.5 grid min-w-0 grid-cols-2 gap-2">
                                <div className="min-w-0">
                                    <div className="text-[9px] text-slate-400 dark:text-slate-500">实体 Flash</div>
                                    <div className="break-words font-mono text-[13px] font-bold text-slate-700 dark:text-slate-100">{observedFlash}</div>
                                </div>
                                <div className="min-w-0">
                                    <div className="text-[9px] text-slate-400 dark:text-slate-500">实体 PSRAM</div>
                                    <div className="break-words font-mono text-[13px] font-bold text-slate-700 dark:text-slate-100">{observedPsram}</div>
                                </div>
                            </div>
                            <div className="mt-1.5 break-words border-t border-slate-100 pt-1 text-[9px] leading-4 text-slate-400 dark:border-slate-800 dark:text-slate-500">
                                {observedAtText || (isEsp32 ? '成功上传后由烧录器读取' : '成功上传后更新')}
                                {isEsp32 && <span> · N/R 不作为容量依据</span>}
                            </div>
                        </div>
                    </div>
                    {assessmentItems.length > 0 && (
                        <div className="flex min-w-0 flex-wrap gap-1.5 border-t border-slate-100 px-2.5 py-1.5 dark:border-slate-800" aria-label="容量配置检查">
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
                    <span className="truncate" title="ESP32 模组标识中 N 表示 Flash、R 表示 PSRAM；PSRAM 配置通常只是模式，容量只采用烧录器实测。">
                        ESP32：程序空间取 APP 分区上限；内部 RAM 不含 PSRAM；实体容量只采用上传实测。
                    </span>
                </div>
            )}
        </section>
    );
}
