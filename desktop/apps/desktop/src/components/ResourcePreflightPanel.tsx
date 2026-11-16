import {
    CheckCircle2,
    CircleAlert,
    CircleHelp,
    FileSearch,
    MapPin,
    ShieldCheck,
    TriangleAlert,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { resourceRoleLabel } from './resource_presentation';
import type {
    CompilerLibraryResourceUsage,
} from '../services/compiler_resource_usage';
import type {
    ResourcePreflightCheck,
    ResourcePreflightEvidence,
    ResourcePreflightIssue,
    ResourcePreflightReport,
    ResourcePreflightStatus,
} from '../services/resource_preflight';
import type { WorkspaceViewMode } from '../services/workspace_view_mode';

interface ResourcePreflightPanelProps {
    report: ResourcePreflightReport | null;
    isRunning?: boolean;
    compact?: boolean;
    displayMode?: WorkspaceViewMode;
    onLocateBlock: (blockId: string) => void;
    onCompileForResources?: () => void;
    isCompiling?: boolean;
}

const statusTheme = (status: ResourcePreflightStatus) => {
    if (status === 'conflict') {
        return {
            shell: 'border-red-200 bg-red-50/70 dark:border-red-900 dark:bg-red-950/35',
            icon: 'bg-red-100 text-red-700 dark:bg-red-950/70 dark:text-red-300',
            pill: 'border-red-200 bg-red-100 text-red-700 dark:border-red-800 dark:bg-red-950/60 dark:text-red-300',
            Icon: CircleAlert,
        };
    }
    if (status === 'warning') {
        return {
            shell: 'border-amber-200 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950/35',
            icon: 'bg-amber-100 text-amber-700 dark:bg-amber-950/70 dark:text-amber-300',
            pill: 'border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
            Icon: TriangleAlert,
        };
    }
    if (status === 'unavailable') {
        return {
            shell: 'border-slate-200 bg-slate-50/75 dark:border-slate-800 dark:bg-slate-900/70',
            icon: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
            pill: 'border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300',
            Icon: CircleHelp,
        };
    }
    return {
        shell: 'border-emerald-200 bg-emerald-50/65 dark:border-emerald-900 dark:bg-emerald-950/30',
        icon: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300',
        pill: 'border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300',
        Icon: CheckCircle2,
    };
};

const normalizeBlockReference = (reference: string): string => {
    const trimmed = reference.trim();
    return trimmed.startsWith('block:') ? trimmed.slice('block:'.length) : trimmed;
};

function LocateReference({ reference, onLocateBlock, label }: {
    reference: string;
    onLocateBlock: (blockId: string) => void;
    label: string;
}) {
    const blockId = normalizeBlockReference(reference);
    if (!blockId) return null;
    return (
        <button
            type="button"
            data-ck-role="resource-preflight-locate"
            data-block-id={blockId}
            onClick={() => onLocateBlock(blockId)}
            className="inline-flex min-w-0 max-w-full items-center gap-1 rounded border border-brand-200 bg-white/75 px-2 py-1 text-[11px] font-semibold text-brand-700 hover:bg-brand-50 dark:border-brand-800 dark:bg-slate-900/60 dark:text-brand-300 dark:hover:bg-brand-950/50"
            title={`${label}: ${blockId}`}
        >
            <MapPin size={10} aria-hidden="true" />
            <span className="min-w-0 break-words">{label}</span>
        </button>
    );
}

function EvidenceList({ evidence, label }: { evidence?: ResourcePreflightEvidence[]; label: string }) {
    if (!evidence || evidence.length === 0) return <span className="text-slate-400 dark:text-slate-500">—</span>;
    return (
        <div className="flex min-w-0 flex-wrap gap-1" aria-label={label}>
            {evidence.map((item, index) => (
                <span key={`${item.id || item.source}-${index}`} className="inline-flex min-w-0 items-center gap-1 rounded border border-slate-200 bg-white/70 px-1.5 py-0.5 text-[9px] text-slate-600 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300">
                    <FileSearch size={10} aria-hidden="true" />
                    <span className="max-w-[15rem] truncate">{item.source}</span>
                    {item.confidence && <span className="text-slate-400 dark:text-slate-500">· {item.confidence}</span>}
                </span>
            ))}
        </div>
    );
}

function ValueList({ values, empty = '—' }: { values?: string[]; empty?: string }) {
    if (!values || values.length === 0) return <span className="text-slate-400 dark:text-slate-500">{empty}</span>;
    return <span className="break-all">{values.join(' · ')}</span>;
}

function ImplementationUsageList({
    usage,
    compact,
    onLocateBlock,
    t,
}: {
    usage: CompilerLibraryResourceUsage[];
    compact: boolean;
    onLocateBlock: (blockId: string) => void;
    t: (key: string, options?: Record<string, unknown>) => string;
}) {
    const kindLabel = (kind: CompilerLibraryResourceUsage['kinds'][number]) =>
        t(`resourcePreflight.implementationUsage.kind.${kind}`, { defaultValue: kind.toUpperCase() });
    return (
        <details
            className="mt-2 rounded border border-sky-200 bg-sky-50/60 p-2 text-[11px] text-slate-600 dark:border-sky-900 dark:bg-sky-950/20 dark:text-slate-300"
            data-ck-role="compiler-resource-usage"
            open={!compact}
        >
            <summary className="cursor-pointer font-semibold text-sky-800 dark:text-sky-200">
                {t('resourcePreflight.implementationUsage.title')}
            </summary>
            <p className="mt-1 leading-5">{t('resourcePreflight.implementationUsage.description')}</p>
            <div className="mt-2 grid min-w-0 gap-2">
                {usage.map((item) => {
                    const implementationLabel = item.implementation.split(/[\\/]/).filter(Boolean).pop() || item.implementation;
                    const statusLabel = t(`resourcePreflight.implementationUsage.status.${item.status}`, {
                        defaultValue: item.status,
                    });
                    return (
                        <article
                            key={`${item.implementation}|${item.blockReferences.join(',')}`}
                            className="min-w-0 rounded border border-sky-100 bg-white/70 p-2 dark:border-sky-900/70 dark:bg-slate-900/50"
                            data-ck-role="compiler-resource-usage-item"
                        >
                            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                                <span className="min-w-0 break-all font-semibold text-slate-800 dark:text-slate-100" title={item.implementation}>
                                    {implementationLabel}
                                </span>
                                <span className="rounded border border-sky-200 px-1.5 py-0.5 text-[9px] text-sky-700 dark:border-sky-800 dark:text-sky-300">
                                    {statusLabel}
                                </span>
                            </div>
                            <div className="mt-1 break-words">
                                <span className="font-semibold">{t('resourcePreflight.implementationUsage.resources')}：</span>
                                {item.kinds.map(kindLabel).join(' · ')}
                                {item.resources.length > 0 && ` · ${item.resources.join(' · ')}`}
                            </div>
                            {item.roles.length > 0 && (
                                <div className="mt-1 break-words">
                                    <span className="font-semibold">{t('resourcePreflight.implementationUsage.roles')}：</span>
                                    {item.roles.join(' · ')}
                                </div>
                            )}
                            {item.unresolved.length > 0 && (
                                <div className="mt-1 break-words text-amber-700 dark:text-amber-300">
                                    <span className="font-semibold">{t('resourcePreflight.implementationUsage.unresolved')}：</span>
                                    {item.unresolved.join(' · ')}
                                </div>
                            )}
                            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
                                <span className="font-semibold">{t('resourcePreflight.implementationUsage.blocks')}：</span>
                                {item.blockReferences.length > 0
                                    ? item.blockReferences.map(blockId => (
                                        <LocateReference
                                            key={blockId}
                                            reference={blockId}
                                            onLocateBlock={onLocateBlock}
                                            label={blockId}
                                        />
                                    ))
                                    : <span className="text-slate-400 dark:text-slate-500">{t('resourcePreflight.none')}</span>}
                            </div>
                        </article>
                    );
                })}
            </div>
        </details>
    );
}

function coverageEntries(
    coverage: ResourcePreflightCheck['coverage'] | null | undefined,
    t: (key: string, options?: Record<string, unknown>) => string,
): Array<[string, string]> {
    if (!coverage) return [];
    const entries: Array<[string, string | undefined]> = [
        ['graph', coverage.graph],
        ['analysis', coverage.analysis],
        ['declaration', coverage.declaration],
        ['project', coverage.project],
        ['hardwareEvidence', coverage.hardwareEvidence],
        ['hardwareValidation', coverage.hardwareValidation],
    ];
    return entries
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
        .map(([key, value]) => [
            t(`resourceInspector.coverage.${key}`, { defaultValue: key }),
            t(
                key === 'hardwareEvidence' || key === 'hardwareValidation'
                    ? `resourceInspector.evidenceValue.${value}`
                    : `resourceInspector.coverageValue.${value}`,
                { defaultValue: value },
            ),
        ]);
}

function explanationFor(
    check: ResourcePreflightCheck,
    issue: ResourcePreflightIssue | undefined,
    t: (key: string, options?: Record<string, unknown>) => string,
) {
    if (check.severity === 'pass') return null;
    const code = issue?.explanationCode || check.code;
    return {
        reason: t(`resourceInspector.conflictDetails.${code}.reason`, { defaultValue: t('resourcePreflight.explanationDefaults.reason') }),
        impact: t(`resourceInspector.conflictDetails.${code}.impact`, { defaultValue: t('resourcePreflight.explanationDefaults.impact') }),
        suggestion: t(`resourceInspector.conflictDetails.${code}.suggestion`, { defaultValue: t('resourcePreflight.explanationDefaults.suggestion') }),
    };
}

function CheckCard({ check, issue, compact, onLocateBlock, t }: {
    check: ResourcePreflightCheck;
    issue?: ResourcePreflightIssue;
    compact: boolean;
    onLocateBlock: (blockId: string) => void;
    t: (key: string, options?: Record<string, unknown>) => string;
}) {
    const theme = statusTheme(check.severity);
    const StatusIcon = theme.Icon;
    const statusLabel = t(`resourcePreflight.status.${check.severity}`, { defaultValue: check.severity.toUpperCase() });
    const codeLabel = t(`resourcePreflight.code.${check.code}`, {
        defaultValue: t(`resourceInspector.conflictCode.${check.code}`, { defaultValue: t('experience.reviewResource') }),
    });
    const blockRefs = [...new Set(check.blockReferences || [])];
    const coverageValues = coverageEntries(check.coverage, t);
    const explanation = explanationFor(check, issue, t);
    return (
        <article
            data-ck-role="resource-preflight-check"
            data-preflight-status={check.severity}
            data-preflight-code={check.code}
            className={`rounded-md border ${theme.shell} ${compact ? 'px-2.5 py-2' : 'px-3 py-2.5'}`}
        >
            <div className="flex min-w-0 items-start gap-2">
                <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${theme.icon}`}>
                    <StatusIcon size={15} aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <span className={`rounded border px-1.5 py-0.5 text-[9px] font-bold ${theme.pill}`}>{statusLabel}</span>
                        <span className="min-w-0 break-words text-xs font-bold text-slate-800 dark:text-slate-100">{codeLabel}</span>
                        {(check.resource || check.resourceId) && (
                            <span className="min-w-0 break-all rounded bg-white/70 px-1.5 py-0.5 font-mono text-[11px] text-slate-600 dark:bg-slate-900/60 dark:text-slate-300">
                                {check.resource || check.resourceId}
                            </span>
                        )}
                    </div>
                    {explanation && (
                        <div className="mt-1.5 grid min-w-0 gap-1 text-[11px] leading-5 text-slate-600 dark:text-slate-300">
                            {check.bindings.length > 0 && <div className="font-semibold">{[...new Set(check.bindings.map(binding => resourceRoleLabel(binding.claim.role, t)))].join(' + ')}</div>}
                            {check.bindings.length === 0 && check.sourceLabels && <div className="break-words font-semibold">{[...new Set(Object.values(check.sourceLabels))].join(' + ')}</div>}
                            <div><span className="font-bold text-slate-700 dark:text-slate-200">{t('resourcePreflight.reason')}: </span>{explanation.reason}</div>
                            <div><span className="font-bold text-slate-700 dark:text-slate-200">{t('resourcePreflight.impact')}: </span>{explanation.impact}</div>
                            <div><span className="font-bold text-slate-700 dark:text-slate-200">{t('resourcePreflight.suggestion')}: </span>{explanation.suggestion}</div>
                        </div>
                    )}
                </div>
            </div>

            <details className="mt-2 text-[11px] text-slate-500 dark:text-slate-400" data-ck-role="preflight-technical-details">
            <summary className="cursor-pointer">{t('experience.details')}</summary>
            <div className="mt-1 break-all font-mono">{check.code}</div>
            <div className="mt-2 grid min-w-0 gap-x-3 gap-y-1.5 break-all text-[11px] leading-5 text-slate-600 dark:text-slate-300" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))' }}>
                <div className="min-w-0"><span className="font-bold text-slate-700 dark:text-slate-200">{t('resourcePreflight.claim')}：</span><ValueList values={check.claimReferences?.length ? check.claimReferences : check.claimIds} empty={t('resourcePreflight.none')} /></div>
                <div className="min-w-0"><span className="font-bold text-slate-700 dark:text-slate-200">{t('resourcePreflight.binding')}：</span>{check.bindings && check.bindings.length > 0 ? <span>{check.bindings.map(binding => `${binding.claimId || 'binding'} → ${binding.resource}${binding.ancestors?.length ? ` (${binding.ancestors.join(' → ')})` : binding.direct === false ? ` (${t('resourcePreflight.inherited')})` : ''}`).join(' · ')}</span> : <span className="text-slate-400 dark:text-slate-500">{t('resourcePreflight.none')}</span>}</div>
                <div className="min-w-0"><span className="font-bold text-slate-700 dark:text-slate-200">{t('resourcePreflight.coverage')}：</span>{coverageValues.length > 0 ? <span>{coverageValues.map(([key, value]) => `${key}: ${value}`).join(' · ')}</span> : <span className="text-slate-400 dark:text-slate-500">{t('resourcePreflight.none')}</span>}</div>
                <div className="min-w-0"><span className="font-bold text-slate-700 dark:text-slate-200">{t('resourcePreflight.evidence')}：</span><EvidenceList evidence={check.evidence} label={t('resourcePreflight.evidence')} /></div>
            </div>
            </details>

            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 border-t border-slate-200/70 pt-1.5 dark:border-slate-700">
                <span className="inline-flex items-center gap-1 text-[9px] font-bold text-slate-500 dark:text-slate-400"><MapPin size={10} aria-hidden="true" />{t('resourcePreflight.block')}</span>
                {blockRefs.length > 0
                    ? blockRefs.map(reference => {
                        const source = check.bindings.find(binding => normalizeBlockReference(binding.claim.reference) === normalizeBlockReference(reference));
                        const label = source ? resourceRoleLabel(source.claim.role, t) : check.sourceLabels?.[reference];
                        return <LocateReference key={reference} reference={reference} onLocateBlock={onLocateBlock} label={label ? t('experience.locateSource', { role: label }) : t('resourcePreflight.locate')} />;
                    })
                    : <span className="text-[9px] text-slate-400 dark:text-slate-500">{t('resourcePreflight.none')}</span>}
            </div>
        </article>
    );
}

export function ResourcePreflightPanel({
    report,
    isRunning = false,
    compact = false,
    displayMode = 'engineering',
    onLocateBlock,
    onCompileForResources,
    isCompiling = false,
}: ResourcePreflightPanelProps) {
    const { t: translate } = useTranslation('health');
    const t = translate as unknown as (key: string, options?: Record<string, unknown>) => string;
    if (!report && !isRunning) return null;

    if (!report) {
        return (
            <section data-ck-role="resource-preflight-panel" className="mx-2 mt-2 flex shrink-0 items-center gap-2 rounded-md border border-blue-200 bg-blue-50/70 px-3 py-2 text-xs text-blue-700 dark:border-blue-900 dark:bg-blue-950/35 dark:text-blue-300">
                <ShieldCheck size={15} className="animate-pulse" aria-hidden="true" />
                {t('resourcePreflight.collecting')}
            </section>
        );
    }

    const theme = statusTheme(report.status);
    const StatusIcon = theme.Icon;
    const simple = displayMode === 'simple';
    const checks = report.checks || [];
    const counts = checks.reduce((summary, check) => {
        summary[check.severity] += 1;
        return summary;
    }, { pass: 0, warning: 0, conflict: 0, unavailable: 0 } as Record<ResourcePreflightStatus, number>);
    const phaseLabel = t(`resourcePreflight.phase.${report.phase}`, { defaultValue: report.phase });
    const unavailableReason = report.status === 'unavailable'
        ? t(`resourcePreflight.unavailableReason.${report.reasonCode || 'default'}`, { defaultValue: t('resourcePreflight.unavailableReason.default') })
        : null;
    return (
        <section
            data-ck-role="resource-preflight-panel"
            data-preflight-status={report.status}
            className={`mx-2 mt-2 min-w-0 shrink-0 border-y border-slate-200 dark:border-slate-800 ${compact ? 'py-2' : 'py-2.5'}`}
            aria-label={t('resourcePreflight.title')}
        >
            <div className="flex min-w-0 items-start gap-2.5">
                <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${theme.icon}`}>
                    <StatusIcon size={15} aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">{t('resourcePreflight.title')}</span>
                        <span className="rounded border border-slate-200 bg-white/70 px-1.5 py-0.5 text-[9px] font-semibold text-slate-600 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300">{phaseLabel}</span>
                        <span className={`rounded border px-1.5 py-0.5 text-[9px] font-bold ${theme.pill}`}>{t(`resourcePreflight.status.${report.status}`, { defaultValue: report.status.toUpperCase() })}</span>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-4 text-slate-600 dark:text-slate-300">{t(`resourcePreflight.summary.${report.status}`, { count: counts[report.status], defaultValue: t('resourcePreflight.summary.default') })}</p>
                    {unavailableReason && <p className="mt-0.5 text-[10px] leading-4 text-slate-500 dark:text-slate-400">{unavailableReason}</p>}
                </div>
            </div>

            {report.implementationCheck && (
                <div className="mt-2 min-w-0 rounded border border-slate-200 bg-white/70 p-2 text-[11px] leading-5 text-slate-600 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300"
                    data-ck-role="implementation-check" data-check-state={report.implementationCheck} role="status" aria-live="polite">
                    <div className="font-semibold">{t(`resourcePreflight.implementation.${report.implementationCheck}`)}</div>
                    <p className="mt-0.5 break-words">{t(`resourcePreflight.implementationHelp.${report.implementationCheck}`)}</p>
                    {onCompileForResources && report.implementationCheck !== 'running' && report.implementationCheck !== 'partial' && (
                        <button type="button" onClick={onCompileForResources} disabled={isCompiling || isRunning}
                            data-ck-role="compile-for-resources"
                            className="mt-1 max-w-full whitespace-normal rounded border border-brand-300 px-2 py-1 text-left font-semibold text-brand-700 disabled:cursor-wait disabled:opacity-50 dark:border-brand-700 dark:text-brand-300">
                            {t('resourcePreflight.compileForResources')}
                        </button>
                    )}
                    <details className="mt-1">
                        <summary className="cursor-pointer">{t('resourcePreflight.implementationScopeTitle')}</summary>
                        <p className="mt-1 break-words">{t('resourcePreflight.implementationScope')}</p>
                    </details>
                </div>
            )}

            {report.implementationUsage && report.implementationUsage.length > 0 && (
                <ImplementationUsageList
                    usage={report.implementationUsage}
                    compact={compact || simple}
                    onLocateBlock={onLocateBlock}
                    t={t}
                />
            )}

            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 text-[9px] text-slate-500 dark:text-slate-400" data-ck-role="resource-preflight-summary">
                <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">{t('resourcePreflight.status.pass')}: {counts.pass}</span>
                <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-amber-700 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300">{t('resourcePreflight.status.warning')}: {counts.warning}</span>
                <span className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-red-700 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300">{t('resourcePreflight.status.conflict')}: {counts.conflict}</span>
                {counts.unavailable > 0 && <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-slate-600 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300">{t('resourcePreflight.status.unavailable')}: {counts.unavailable}</span>}
                <span className="ml-auto inline-flex items-center gap-1"><ShieldCheck size={10} aria-hidden="true" />{t('resourcePreflight.readOnly')}</span>
            </div>

            {checks.length > 0 ? (
                <div className="mt-2 grid min-w-0 gap-2" data-ck-role="resource-preflight-checks">
                    {checks.filter(check => check.severity !== 'pass').map(check => (
                        <CheckCard key={check.id} check={check} issue={report.issues.find(issue => issue.id === check.issueId)} compact={compact || simple} onLocateBlock={onLocateBlock} t={t} />
                    ))}
                    {counts.pass > 0 && <details open={!simple} data-ck-role="preflight-completed-checks">
                        <summary className="cursor-pointer py-1 text-[11px] text-slate-500 dark:text-slate-400">{t('experience.passedChecks', { count: counts.pass })}</summary>
                        <div className="mt-1 grid gap-2">{checks.filter(check => check.severity === 'pass').map(check => (
                            <CheckCard key={check.id} check={check} compact={compact || simple} onLocateBlock={onLocateBlock} t={t} />
                        ))}</div>
                    </details>}
                </div>
            ) : (
                <div className="mt-2 rounded border border-slate-200 bg-white/60 px-2 py-1.5 text-[10px] text-slate-500 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-400">{t('resourcePreflight.noChecks')}</div>
            )}
        </section>
    );
}

export default ResourcePreflightPanel;
