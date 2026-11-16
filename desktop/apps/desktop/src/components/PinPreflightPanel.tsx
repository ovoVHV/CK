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
import { useTranslation } from 'react-i18next';
import type {
    PinCatalogEntry,
    PinCatalogFilter,
    PinPreflightIssue,
    PinPreflightReport,
    PinUsage,
} from '../services/pin_preflight';
import { filterPinCatalog, summarizePinReferences } from '../services/pin_preflight';
import type { WorkspaceViewMode } from '../services/workspace_view_mode';

type PanelCatalogFilter = PinCatalogFilter | 'attention';

interface PinPreflightPanelProps {
    report: PinPreflightReport | null;
    onLocateBlock: (blockId: string) => void;
    compact?: boolean;
    displayMode?: WorkspaceViewMode;
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
const CONNECTOR_SIDE_LABEL_KEYS: Record<'left' | 'right' | 'top' | 'bottom', string> = {
    left: 'pin.connector.left',
    right: 'pin.connector.right',
    top: 'pin.connector.top',
    bottom: 'pin.connector.bottom',
};

const effectiveRiskSeverity = (
    pin: PinCatalogEntry,
    risk: PinCatalogEntry['activeRisks'][number],
) => risk.severity === 'blocker' && pin.evidenceLevel !== 'verified'
    ? 'warning'
    : risk.severity;

const isPinUsed = (pin: PinCatalogEntry): boolean => pin.usages.length > 0;
const hasPinRisk = (pin: PinCatalogEntry): boolean => pin.activeRisks.length > 0 || pin.reservedBy.length > 0;

const catalogTone = (pin: PinCatalogEntry): string => {
    // A board-level risk is information about a pin, not an active project
    // warning. Keep unused pins visually neutral so the map does not imply
    // that every known boot/UART/USB caveat is currently affecting the
    // project. Only an occupied pin gets warning/error emphasis below.
    const isUsed = isPinUsed(pin);
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
    displayMode = 'engineering',
}: PinPreflightPanelProps) {
    const { t: translate } = useTranslation('health');
    const t = translate as unknown as (key: string, options?: Record<string, unknown>) => string;
    const connectorSideLabel = (side: 'left' | 'right' | 'top' | 'bottom' | undefined): string => (
        side ? t(CONNECTOR_SIDE_LABEL_KEYS[side]) : ''
    );
    const simple = displayMode === 'simple';
    const attentionDefault = compact || simple;
    const showTechnicalDetails = !compact && !simple;
    const [query, setQuery] = useState('');
    // The compact/simple health view should answer "what am I using?" first.
    // Keep the complete catalog one click away through the existing filters,
    // while avoiding a wall of every board pin on a narrow dock.
    const [catalogFilter, setCatalogFilter] = useState<PanelCatalogFilter>(attentionDefault ? 'attention' : 'all');
    useEffect(() => {
        setCatalogFilter(current => {
            if (attentionDefault && current === 'all') return 'attention';
            if (!attentionDefault && current === 'attention') return 'all';
            return current;
        });
    }, [attentionDefault]);
    const visiblePins = useMemo(() => filterPinCatalog(
        report?.catalog || [],
        { query, filter: catalogFilter === 'attention' ? 'all' : catalogFilter },
    ).filter(pin => catalogFilter !== 'attention'
        || pin.usages.length > 0
        || pin.activeRisks.length > 0
        || pin.reservedBy.length > 0
    ).sort((left, right) => {
        if (catalogFilter !== 'attention') return 0;
        const score = (pin: PinCatalogEntry) => (pin.usages.length > 0 ? 2 : 0)
            + (pin.activeRisks.length > 0 || pin.reservedBy.length > 0 ? 1 : 0);
        return score(right) - score(left);
    }), [catalogFilter, query, report?.catalog]);

    if (!report) return null;

    const unknownUsages = report.usages.filter(usage => usage.resolution === 'unknown');
    const needsConfirmation = report.status !== 'ready' || report.warnings.length > 0 || report.notices.length > 0;
    const knownUsageCount = report.usages.filter(usage => usage.resolution === 'known').length;
    const invalidUsageCount = report.usages.filter(usage => usage.resolution === 'invalid').length;
    const usedPinCount = report.catalog.filter(isPinUsed).length;
    const riskPinCount = report.catalog.filter(hasPinRisk).length;
    const projectRiskPinCount = report.catalog.filter(pin => isPinUsed(pin) && hasPinRisk(pin)).length;
    const boardNoticePinCount = report.catalog.filter(pin => !isPinUsed(pin) && hasPinRisk(pin)).length;
    const attentionPinCount = report.catalog.filter(pin => isPinUsed(pin) || hasPinRisk(pin)).length;
    const collapsedUnusedPinCount = report.catalog.filter(pin => !isPinUsed(pin) && !hasPinRisk(pin)).length;

    return (
        <section
            className="mx-2 mt-2 shrink-0 rounded-md border border-slate-200 bg-white/95 dark:border-slate-700 dark:bg-slate-900/90"
            aria-label={t('pin.panelAriaLabel')}
        >
            <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 dark:border-slate-800">
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${!report.canCompile ? 'bg-red-50 text-red-700 dark:bg-red-950/55 dark:text-red-300' : needsConfirmation ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/55 dark:text-amber-300' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/55 dark:text-emerald-300'}`}>
                    {report.canCompile ? <Cable size={15} /> : <CircleAlert size={15} />}
                </span>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                        <h3 className="text-xs font-bold text-slate-800 dark:text-slate-100">{simple ? t('pin.usage') : t('pin.risk')}</h3>
                        <span className={`rounded border px-1.5 py-0.5 text-[9px] font-bold ${!report.canCompile ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/45 dark:text-red-300' : needsConfirmation ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/45 dark:text-amber-300' : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/45 dark:text-emerald-300'}`}>
                            {report.canCompile ? t(needsConfirmation ? 'pin.needsConfirmation' : 'status.pass') : t('pin.blockers', { count: report.blockers.length })}
                        </span>
                        {showTechnicalDetails && (
                            <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[9px] font-bold text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
                                {t(`pin.evidenceLevel.${report.pinEvidenceLevel}`)}
                            </span>
                        )}
                    </div>
                    <p className="mt-0.5 break-words text-[9px] text-slate-500 dark:text-slate-400" title={report.boardName || report.boardFqbn}>
                        {report.status === 'ready'
                            ? attentionDefault
                                ? t('pin.summary.attention', {
                                    boardName: report.boardName,
                                    compileStatus: t(report.canCompile ? 'pin.summary.canCompile' : 'pin.summary.needsAttention'),
                                    used: usedPinCount,
                                    riskSuffix: projectRiskPinCount > 0 ? t('pin.summary.riskSuffix', { count: projectRiskPinCount }) : '',
                                    noticeSuffix: boardNoticePinCount > 0 ? t('pin.summary.noticeSuffix', { count: boardNoticePinCount }) : '',
                                    unknownSuffix: unknownUsages.length > 0 ? t('pin.summary.unknownSuffix', { count: unknownUsages.length }) : '',
                                })
                                : t('pin.summary.catalog', {
                                    boardName: report.boardName,
                                    total: report.catalog.length,
                                    known: knownUsageCount,
                                    unknown: unknownUsages.length,
                                    invalidSuffix: invalidUsageCount > 0 ? t('pin.summary.invalidSuffix', { count: invalidUsageCount }) : '',
                                })
                            : t('pin.summary.unsupported')}
                    </p>
                </div>
            </div>

            <p className="px-3 pt-2 text-[9px] text-slate-500 dark:text-slate-400">{t('pin.declarationBoundary')}</p>
            {report.issues.length > 0 && (
                <div className="grid gap-1.5 px-2.5 pt-2">
                    {report.issues.map((issue) => {
                        const theme = issueTheme(issue);
                        const Icon = theme.Icon;
                        return (
                            <article key={issue.id} className={`flex items-start gap-2 rounded border px-2 py-1.5 ${theme.shell}`}>
                                <Icon size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                                <div className="min-w-0 flex-1">
                                    <div className="text-[10px] font-bold text-slate-700 dark:text-slate-200">{t(`pin.issue.${issue.code}.title`, { defaultValue: issue.title })}</div>
                                    {showTechnicalDetails && <div className="mt-0.5 break-words text-[9px] leading-4 text-slate-500 dark:text-slate-400">{t(`pin.issue.${issue.code}.detail`, { defaultValue: issue.detail })}</div>}
                                </div>
                                {issue.blockId && (
                                    <button
                                        type="button"
                                        onClick={() => onLocateBlock(issue.blockId!)}
                                        className={`inline-flex h-7 shrink-0 items-center gap-1 rounded border px-2 text-[9px] font-bold transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-slate-800 ${theme.badge}`}
                                    >
                                        <LocateFixed size={11} />
                                        {t('pin.locate')}
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
                                placeholder={t(attentionDefault ? 'pin.searchCompact' : 'pin.searchFull')}
                                aria-label={t('pin.searchAriaLabel')}
                                className="h-8 w-full rounded border border-slate-200 bg-white pl-7 pr-2 text-[10px] text-slate-700 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:focus:ring-brand-950"
                            />
                        </label>
                        <div className="flex flex-wrap gap-1" aria-label={t('pin.filterAriaLabel')}>
                            {(attentionDefault
                                ? [
                                    ['attention', t('pin.filter.attentionCount', { count: attentionPinCount })],
                                    ['used', t('pin.filter.usedCount', { count: usedPinCount })],
                                    ['risk', t('pin.filter.riskCount', { count: riskPinCount })],
                                    ['all', t('pin.filter.allCount', { count: report.catalog.length })],
                                ]
                                : [
                                    ['all', t('pin.filter.all')],
                                    ['used', t('pin.filter.used')],
                                    ['risk', t('pin.filter.risk')],
                                    ['available', t('pin.filter.available')],
                                ])
                                .map(([value, label]) => (
                                <button
                                    key={value}
                                    type="button"
                                    onClick={() => setCatalogFilter(value as PanelCatalogFilter)}
                                    aria-pressed={catalogFilter === value}
                                    className={`h-7 rounded border px-2 text-[9px] font-bold transition ${catalogFilter === value
                                        ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-800 dark:bg-brand-950/50 dark:text-brand-300'
                                        : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800'}`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1 text-[9px] text-slate-400 dark:text-slate-500">
                        <span>{t('pin.visibleCount', { visible: visiblePins.length, total: report.catalog.length })}</span>
                        {showTechnicalDetails && <span>{report.catalog.some(pin => pin.connector?.position != null)
                            ? t('pin.catalogOrder.physical')
                            : t('pin.catalogOrder.logical')}</span>}
                    </div>
                    <div className="mt-1 text-[8px] leading-4 text-slate-400 dark:text-slate-500">
                        {attentionDefault
                            ? t(collapsedUnusedPinCount > 0 ? 'pin.collapsed.withUnused' : 'pin.collapsed.none', { count: collapsedUnusedPinCount })
                            : t('pin.unusedDisclaimer')}
                    </div>

                    {visiblePins.length > 0 ? (
                        <div
                            className="mt-1.5 grid min-w-0 gap-1.5"
                            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))' }}
                        >
                            {visiblePins.map(pin => (
                                <article
                                    key={pin.value}
                                    data-ck-pin-value={pin.value}
                                    data-ck-pin-state={pin.usages.length > 0 ? 'used' : pin.activeRisks.length > 0 || pin.reservedBy.length > 0 ? 'risk' : 'unused'}
                                    className={`min-w-0 rounded border ${compact && pin.usages.length === 0 ? 'px-1.5 py-1' : 'px-2 py-1.5'} ${catalogTone(pin)}`}
                                >
                                    <div className="flex items-start gap-2">
                                        <span className="min-w-10 max-w-[45%] break-all whitespace-normal rounded bg-slate-800 px-1.5 py-0.5 text-center font-mono text-[10px] font-bold text-white dark:bg-slate-950">
                                            {pin.value}
                                        </span>
                                        <div className="min-w-0 flex-1">
                                            <div className="break-words text-[10px] font-bold text-slate-700 dark:text-slate-200">{pin.label}</div>
                                            {showTechnicalDetails && (pin.connector?.id || pin.source) && (
                                                <div className="mt-0.5 break-words text-[8px] text-slate-400 dark:text-slate-500">
                                                    {[pin.connector?.id && [pin.connector.id, connectorSideLabel(pin.connector.side), pin.connector.position != null ? `#${pin.connector.position}` : ''].filter(Boolean).join(' · '), pin.source].filter(Boolean).join(' · ')}
                                                </div>
                                            )}
                                        </div>
                                        {pin.usages.length > 0 && (
                                            <span className="shrink-0 rounded border border-sky-200 bg-sky-50 px-1 py-0.5 text-[8px] font-bold text-sky-700 dark:border-sky-900 dark:bg-sky-950/50 dark:text-sky-300">
                                                {t('pin.usageCountBadge', { count: pin.usages.length })}
                                            </span>
                                        )}
                                    </div>

                                    {showTechnicalDetails && (pin.aliases.length > 0 || pin.capabilities.length > 0) && (
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
                                            {t('pin.reservedBy', {
                                                values: pin.reservedBy.join(t('listSeparator')),
                                                unusedSuffix: pin.usages.length === 0 ? t('pin.unusedSuffix') : '',
                                            })}
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
                                            {pin.usages.length === 0 ? t('pin.boardNoticeSuffix') : ''}
                                            {risk.severity === 'blocker' && pin.evidenceLevel !== 'verified' ? t('pin.publisherWarningSuffix') : ''}
                                        </div>
                                    ))}

                                    {pin.usages.length > 0 && (
                                        <div className="mt-1">
                                            <div className="mb-1 text-[9px] font-bold text-slate-600 dark:text-slate-300">
                                                {t('pin.referenceSummary', summarizePinReferences(pin.usages))}
                                            </div>
                                            {summarizePinReferences(pin.usages).conflictCount > 0 && <p className="text-[9px] text-amber-700 dark:text-amber-300">{t('pin.roleConflict')}</p>}
                                            {summarizePinReferences(pin.usages).roles.map(role => (
                                            <details key={role.id} className="mt-1 text-[9px]" open={role.references.length === 1 ? true : undefined}>
                                            <summary className="cursor-pointer text-sky-700 dark:text-sky-300">{t(`pin.roles.${role.id}`, { defaultValue: role.id })} · {t('pin.usageCountBadge', { count: role.references.length })}</summary>
                                            <div className="flex flex-wrap gap-1">
                                            {role.references.map(usage => (
                                                <button
                                                    key={usage.id}
                                                    type="button"
                                                    onClick={() => onLocateBlock(usage.blockId)}
                                                    className="inline-flex max-w-full items-center gap-1 break-words rounded border border-sky-200 bg-white px-1.5 py-1 text-[8px] font-semibold text-sky-700 hover:bg-sky-50 dark:border-sky-900 dark:bg-slate-900 dark:text-sky-300 dark:hover:bg-sky-950/40"
                                                    title={t('pin.locateTitle', { usage: usageText(usage) })}
                                                >
                                                    <LocateFixed size={8} />
                                                    <span className="font-black">{t('pin.locate')}</span>
                                                    <span className="truncate">{usageText(usage)}</span>
                                                </button>
                                            ))}
                                            </div>
                                            </details>
                                            ))}
                                        </div>
                                    )}
                                </article>
                            ))}
                        </div>
                    ) : (
                        <div className="mt-2 rounded border border-dashed border-slate-200 px-3 py-4 text-center text-[10px] text-slate-400 dark:border-slate-700 dark:text-slate-500">
                            {t('pin.noMatches')}
                        </div>
                    )}
                </div>
            )}

            {report.status === 'ready' && report.usages.length === 0 && (
                <div className="flex items-center gap-1.5 px-3 py-2 text-[10px] text-slate-500 dark:text-slate-400">
                    <CheckCircle2 size={12} className="text-emerald-600 dark:text-emerald-400" />
                    {t('pin.noAnalyzableUsage')}
                </div>
            )}
        </section>
    );
}

export default PinPreflightPanel;
