import { useEffect, useMemo, useState } from 'react';
import {
    Cable,
    CheckCircle2,
    CircleAlert,
    CircleHelp,
    LocateFixed,
    Search,
    ShieldAlert,
    TriangleAlert,
} from 'lucide-react';
import type {
    PinCatalogEntry,
    PinCatalogFilter,
    PinPreflightIssue,
    PinPreflightReport,
    PinUsage,
} from '../services/pin_preflight';
import { filterPinCatalog } from '../services/pin_preflight';

interface PinPreflightPanelProps {
    report: PinPreflightReport | null;
    onLocateBlock: (blockId: string) => void;
    compact?: boolean;
}

const issueTheme = (issue: PinPreflightIssue) => {
    if (issue.severity === 'blocker') {
        return {
            shell: 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/35',
            badge: 'border-red-200 bg-white text-red-700 dark:border-red-800 dark:bg-slate-900/75 dark:text-red-300',
            Icon: ShieldAlert,
        };
    }
    if (issue.severity === 'warning') {
        return {
            shell: 'border-amber-200 bg-amber-50/80 dark:border-amber-900 dark:bg-amber-950/35',
            badge: 'border-amber-200 bg-white text-amber-700 dark:border-amber-800 dark:bg-slate-900/75 dark:text-amber-300',
            Icon: TriangleAlert,
        };
    }
    return {
        shell: 'border-sky-200 bg-sky-50/80 dark:border-sky-900 dark:bg-sky-950/35',
        badge: 'border-sky-200 bg-white text-sky-700 dark:border-sky-800 dark:bg-slate-900/75 dark:text-sky-300',
        Icon: CircleHelp,
    };
};

const usageText = (usage: PinUsage): string => `${usage.blockLabel} · ${usage.roleLabel}`;
const CONNECTOR_SIDE_LABELS: Record<'left' | 'right' | 'top' | 'bottom', string> = {
    left: '左侧',
    right: '右侧',
    top: '顶部',
    bottom: '底部',
};
const connectorSideLabel = (side: 'left' | 'right' | 'top' | 'bottom' | undefined): string => (
    side ? CONNECTOR_SIDE_LABELS[side] : ''
);

const effectiveRiskSeverity = (
    pin: PinCatalogEntry,
    risk: PinCatalogEntry['activeRisks'][number],
) => risk.severity === 'blocker' && pin.evidenceLevel !== 'verified'
    ? 'warning'
    : risk.severity;

const catalogTone = (pin: PinCatalogEntry): string => {
    // A board-level risk is information about a pin, not an active project
    // warning. Keep unused pins visually neutral so the map does not imply
    // that every known boot/UART/USB caveat is currently affecting the
    // project. Only an occupied pin gets warning/error emphasis below.
    const isUsed = pin.usages.length > 0;
    if (isUsed && pin.activeRisks.some(risk => effectiveRiskSeverity(pin, risk) === 'blocker')) {
        return 'border-red-300 bg-red-50/80 dark:border-red-900 dark:bg-red-950/30';
    }
    if (isUsed && (pin.activeRisks.length > 0 || pin.reservedBy.length > 0)) {
        return 'border-amber-300 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950/25';
    }
    if (isUsed) {
        return 'border-sky-300 bg-sky-50/70 dark:border-sky-900 dark:bg-sky-950/25';
    }
    return 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900';
};

export function PinPreflightPanel({
    report,
    onLocateBlock,
    compact = false,
}: PinPreflightPanelProps) {
    const [query, setQuery] = useState('');
    // The compact/simple health view should answer "what am I using?" first.
    // Keep the complete catalog one click away through the existing filters,
    // while avoiding a wall of every board pin on a narrow dock.
    const [catalogFilter, setCatalogFilter] = useState<PinCatalogFilter>(compact ? 'used' : 'all');
    useEffect(() => {
        if (compact) setCatalogFilter(current => current === 'all' ? 'used' : current);
    }, [compact]);
    const visiblePins = useMemo(() => filterPinCatalog(
        report?.catalog || [],
        { query, filter: catalogFilter },
    ), [catalogFilter, query, report?.catalog]);

    if (!report) return null;

    const unknownUsages = report.usages.filter(usage => usage.resolution === 'unknown');
    const knownUsageCount = report.usages.filter(usage => usage.resolution === 'known').length;
    const invalidUsageCount = report.usages.filter(usage => usage.resolution === 'invalid').length;

    return (
        <section
            className="mx-2 mt-2 shrink-0 rounded-md border border-slate-200 bg-white/95 dark:border-slate-700 dark:bg-slate-900/90"
            aria-label="引脚占用与编译前体检"
        >
            <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 dark:border-slate-800">
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${report.canCompile ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/55 dark:text-emerald-300' : 'bg-red-50 text-red-700 dark:bg-red-950/55 dark:text-red-300'}`}>
                    {report.canCompile ? <Cable size={15} /> : <CircleAlert size={15} />}
                </span>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                        <h3 className="text-xs font-bold text-slate-800 dark:text-slate-100">精确引脚风险图</h3>
                        <span className={`rounded border px-1.5 py-0.5 text-[9px] font-bold ${report.canCompile ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/45 dark:text-emerald-300' : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/45 dark:text-red-300'}`}>
                            {report.canCompile ? '可继续编译' : `${report.blockers.length} 项需修正`}
                        </span>
                        {!compact && (
                            <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[9px] font-bold text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
                                {report.pinEvidenceLevel === 'verified'
                                    ? 'CK 已验证数据'
                                    : report.pinEvidenceLevel === 'publisher'
                                        ? '发布者声明'
                                        : '基础引脚目录'}
                            </span>
                        )}
                    </div>
                    <p className="mt-0.5 break-words text-[9px] text-slate-500 dark:text-slate-400" title={report.boardName || report.boardFqbn}>
                        {report.status === 'ready'
                            ? compact
                                ? `${report.boardName} · ${knownUsageCount} 个确定占用${unknownUsages.length > 0 ? ` · ${unknownUsages.length} 个动态/未知` : ''}${invalidUsageCount > 0 ? ` · ${invalidUsageCount} 个清单外` : ''}`
                                : `${report.boardName} · 清单声明 ${report.catalog.length} 个引脚 · ${knownUsageCount} 个确定占用 · ${unknownUsages.length} 个动态/未知${invalidUsageCount > 0 ? ` · ${invalidUsageCount} 个清单外` : ''}`
                            : '当前板卡没有通过门禁的独立引脚清单，不借用其他同芯片板卡数据'}
                    </p>
                </div>
            </div>

            {report.issues.length > 0 && (
                <div className="grid gap-1.5 px-2.5 pt-2">
                    {report.issues.map((issue) => {
                        const theme = issueTheme(issue);
                        const Icon = theme.Icon;
                        return (
                            <article key={issue.id} className={`flex items-start gap-2 rounded border px-2 py-1.5 ${theme.shell}`}>
                                <Icon size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                                <div className="min-w-0 flex-1">
                                    <div className="text-[10px] font-bold text-slate-700 dark:text-slate-200">{issue.title}</div>
                                    {!compact && <div className="mt-0.5 break-words text-[9px] leading-4 text-slate-500 dark:text-slate-400">{issue.detail}</div>}
                                </div>
                                {issue.blockId && (
                                    <button
                                        type="button"
                                        onClick={() => onLocateBlock(issue.blockId!)}
                                        className={`inline-flex h-7 shrink-0 items-center gap-1 rounded border px-2 text-[9px] font-bold transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-slate-800 ${theme.badge}`}
                                    >
                                        <LocateFixed size={11} />
                                        定位积木
                                    </button>
                                )}
                            </article>
                        );
                    })}
                </div>
            )}

            {report.status === 'ready' && report.catalog.length > 0 && (
                <div className="px-2.5 py-2">
                    <div
                        className="grid min-w-0 gap-1.5"
                        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))' }}
                    >
                        <label className="relative min-w-0 flex-1">
                            <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
                            <input
                                type="search"
                                value={query}
                                onChange={event => setQuery(event.target.value)}
                                placeholder={compact ? '搜索引脚或积木' : '搜索 GPIO、D2、SDA、能力、风险或使用积木'}
                                aria-label="搜索当前板卡引脚"
                                className="h-8 w-full rounded border border-slate-200 bg-white pl-7 pr-2 text-[10px] text-slate-700 outline-none transition focus:border-teal-400 focus:ring-2 focus:ring-teal-100 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:focus:ring-teal-950"
                            />
                        </label>
                        <div className="flex flex-wrap gap-1" aria-label="引脚风险图筛选">
                            {([
                                ['all', '全部'],
                                ['used', '已占用'],
                                ['risk', '有风险'],
                                ['available', '未占用'],
                            ] as Array<[PinCatalogFilter, string]>).map(([value, label]) => (
                                <button
                                    key={value}
                                    type="button"
                                    onClick={() => setCatalogFilter(value)}
                                    aria-pressed={catalogFilter === value}
                                    className={`h-7 rounded border px-2 text-[9px] font-bold transition ${catalogFilter === value
                                        ? 'border-teal-300 bg-teal-50 text-teal-700 dark:border-teal-800 dark:bg-teal-950/50 dark:text-teal-300'
                                        : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800'}`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1 text-[9px] text-slate-400 dark:text-slate-500">
                        <span>显示 {visiblePins.length}/{report.catalog.length} 个引脚</span>
                        {!compact && <span>{report.catalog.some(pin => pin.connector?.position != null)
                            ? '按板卡包声明的接口位置排列'
                            : '目录图：板卡包未声明物理坐标，不猜测排针位置'}</span>}
                    </div>
                    <div className="mt-1 text-[8px] leading-4 text-slate-400 dark:text-slate-500">
                        {compact
                            ? '简洁视图默认显示当前占用；切换筛选可查看整板目录。'
                            : '“未占用”只表示当前积木未使用；未声明的能力和电气风险按未知处理，不代表已经验证安全。'}
                    </div>

                    {visiblePins.length > 0 ? (
                        <div
                            className="mt-1.5 grid min-w-0 gap-1.5"
                            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))' }}
                        >
                            {visiblePins.map(pin => (
                                <article key={pin.value} className={`min-w-0 rounded border px-2 py-1.5 ${catalogTone(pin)}`}>
                                    <div className="flex items-start gap-2">
                                        <span className="min-w-10 max-w-[45%] break-all whitespace-normal rounded bg-slate-800 px-1.5 py-0.5 text-center font-mono text-[10px] font-bold text-white dark:bg-slate-950">
                                            {pin.value}
                                        </span>
                                        <div className="min-w-0 flex-1">
                                            <div className="break-words text-[10px] font-bold text-slate-700 dark:text-slate-200">{pin.label}</div>
                                            {!compact && (pin.connector?.id || pin.source) && (
                                                <div className="mt-0.5 break-words text-[8px] text-slate-400 dark:text-slate-500">
                                                    {[pin.connector?.id && [pin.connector.id, connectorSideLabel(pin.connector.side), pin.connector.position != null ? `#${pin.connector.position}` : ''].filter(Boolean).join(' · '), pin.source].filter(Boolean).join(' · ')}
                                                </div>
                                            )}
                                        </div>
                                        {pin.usages.length > 0 && (
                                            <span className="shrink-0 rounded border border-sky-200 bg-sky-50 px-1 py-0.5 text-[8px] font-bold text-sky-700 dark:border-sky-900 dark:bg-sky-950/50 dark:text-sky-300">
                                                {pin.usages.length} 处占用
                                            </span>
                                        )}
                                    </div>

                                    {!compact && (pin.aliases.length > 0 || pin.capabilities.length > 0) && (
                                        <div className="mt-1 flex flex-wrap gap-1">
                                            {pin.aliases.map(alias => (
                                                <span key={`alias:${alias}`} className="max-w-full break-all rounded bg-slate-100 px-1 py-0.5 font-mono text-[8px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">{alias}</span>
                                            ))}
                                            {pin.capabilities.map(capability => (
                                                <span key={`cap:${capability}`} className="max-w-full break-all rounded bg-emerald-50 px-1 py-0.5 text-[8px] text-emerald-700 dark:bg-emerald-950/45 dark:text-emerald-300">{capability}</span>
                                            ))}
                                        </div>
                                    )}

                                    {pin.reservedBy.length > 0 && (
                                        <div className={`mt-1 text-[9px] font-bold ${pin.usages.length > 0
                                            ? 'text-amber-700 dark:text-amber-300'
                                            : 'text-slate-500 dark:text-slate-400'}`}>
                                            保留：{pin.reservedBy.join('、')}{pin.usages.length === 0 ? '（未使用）' : ''}
                                        </div>
                                    )}
                                    {pin.activeRisks.map(risk => (
                                        <div key={risk.code} className={`mt-1 break-words rounded px-1.5 py-1 text-[9px] ${pin.usages.length === 0
                                            ? 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                                            : effectiveRiskSeverity(pin, risk) === 'blocker'
                                            ? 'bg-red-100/80 text-red-700 dark:bg-red-950/55 dark:text-red-300'
                                            : effectiveRiskSeverity(pin, risk) === 'warning'
                                                ? 'bg-amber-100/80 text-amber-700 dark:bg-amber-950/55 dark:text-amber-300'
                                                : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}
                                            title={risk.detail || risk.title}
                                        >
                                            {risk.title}
                                            {pin.usages.length === 0 ? '（未使用，仅板级提示）' : ''}
                                            {risk.severity === 'blocker' && pin.evidenceLevel !== 'verified' ? '（发布者声明，仅警告）' : ''}
                                        </div>
                                    ))}

                                    {pin.usages.length > 0 && (
                                        <div className="mt-1 flex flex-wrap gap-1">
                                            {pin.usages.map(usage => (
                                                <button
                                                    key={usage.id}
                                                    type="button"
                                                    onClick={() => onLocateBlock(usage.blockId)}
                                                    className="inline-flex max-w-full items-center gap-1 break-words rounded border border-sky-200 bg-white px-1.5 py-0.5 text-[8px] text-sky-700 hover:bg-sky-50 dark:border-sky-900 dark:bg-slate-900 dark:text-sky-300 dark:hover:bg-sky-950/40"
                                                    title={`定位：${usageText(usage)}`}
                                                >
                                                    <LocateFixed size={8} />
                                                    {usageText(usage)}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </article>
                            ))}
                        </div>
                    ) : (
                        <div className="mt-2 rounded border border-dashed border-slate-200 px-3 py-4 text-center text-[10px] text-slate-400 dark:border-slate-700 dark:text-slate-500">
                            当前搜索和筛选没有匹配引脚。
                        </div>
                    )}
                </div>
            )}

            {report.status === 'ready' && report.usages.length === 0 && (
                <div className="flex items-center gap-1.5 px-3 py-2 text-[10px] text-slate-500 dark:text-slate-400">
                    <CheckCircle2 size={12} className="text-emerald-600 dark:text-emerald-400" />
                    当前工程没有可确定分析的引脚积木；仍可搜索上方的全板引脚目录。
                </div>
            )}
        </section>
    );
}

export default PinPreflightPanel;
