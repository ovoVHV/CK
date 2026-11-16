import { AlertTriangle, Ban, CheckCircle2, ChevronDown, CircleHelp, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PackageQualityReport, QualityCheckStatus } from '../types/packageQuality';
import {
    qualityHashLabel,
    qualityStatusSummary,
    redactQualityMessage,
    type PackageQualityTone,
} from '../services/package_quality_ui';

interface PackageQualityStatusBadgeProps {
    report?: PackageQualityReport | null;
}

interface PackageQualityReportPanelProps extends PackageQualityStatusBadgeProps {
    metadataVersion?: string | number | null;
    sourceLabel?: string;
    compact?: boolean;
}

const toneClasses: Record<PackageQualityTone, string> = {
    neutral: 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
    warning: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
    danger: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300',
};

const CheckIcon = ({ status }: { status: QualityCheckStatus }) => {
    if (status === 'error') return <Ban size={13} className="mt-0.5 shrink-0 text-rose-500" />;
    if (status === 'warning') return <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-500" />;
    return <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-500" />;
};

const qualityLabelKey = (status: PackageQualityReport['status'] | undefined): string => {
    if (status === 'passed') return 'packageQuality.passed';
    if (status === 'passed_with_warnings') return 'packageQuality.warning';
    if (status === 'failed') return 'packageQuality.blocked';
    return 'packageQuality.unknown';
};

const qualityCheckLabelKey = (status: QualityCheckStatus): string => {
    if (status === 'error') return 'packageQuality.checkBlocked';
    if (status === 'warning') return 'packageQuality.checkWarning';
    return 'packageQuality.checkPassed';
};

export const PackageQualityStatusBadge = ({ report }: PackageQualityStatusBadgeProps) => {
    const { t } = useTranslation();
    const translate = t as any;
    const summary = qualityStatusSummary(report);
    const Icon = summary.tone === 'danger'
        ? Ban
        : summary.tone === 'warning'
            ? AlertTriangle
            : summary.tone === 'success'
                ? ShieldCheck
                : CircleHelp;
    return (
        <span
            data-ck-quality-status={report?.status || 'pending'}
            className={`shrink-0 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold ${toneClasses[summary.tone]}`}
            title={translate(qualityLabelKey(report?.status))}
        >
            <Icon size={11} /> {translate(qualityLabelKey(report?.status))}
        </span>
    );
};

export const PackageQualityReportPanel = ({
    report,
    metadataVersion,
    sourceLabel,
    compact = false,
}: PackageQualityReportPanelProps) => {
    const { t } = useTranslation();
    const translate = t as any;
    const summary = qualityStatusSummary(report);
    const displayedSourceLabel = sourceLabel || t('packageQuality.sourceUndeclared');
    const contentHash = qualityHashLabel(report?.source_content_sha256);
    const checks = report?.checks || [];
    const orderedChecks = [...checks].sort((left, right) => {
        const order: Record<QualityCheckStatus, number> = { error: 0, warning: 1, passed: 2 };
        return order[left.status] - order[right.status];
    });

    return (
        <section
            data-ck-role="package-quality-report"
            className={`rounded-lg border ${toneClasses[summary.tone]} ${compact ? 'p-2.5' : 'p-3'}`}
            aria-label={t('packageQuality.title')}
        >
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-bold">{t('packageQuality.title')}</span>
                        <PackageQualityStatusBadge report={report} />
                    </div>
                    <p className="mt-1 text-[10px] leading-relaxed opacity-85">{translate(qualityLabelKey(report?.status))}</p>
                </div>
                {report && (
                    <div className="shrink-0 text-right text-[10px] font-semibold">
                        <span className={report.error_count ? 'text-rose-600 dark:text-rose-300' : ''}>{t('packageQuality.blockedCount', { count: report.error_count })}</span>
                        <span className="mx-1.5 opacity-40">·</span>
                        <span className={report.warning_count ? 'text-amber-600 dark:text-amber-300' : ''}>{t('packageQuality.warningCount', { count: report.warning_count })}</span>
                    </div>
                )}
            </div>

            <dl className="mt-2 grid grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-1 text-[10px]">
                <dt className="opacity-60">{t('packageQuality.source')}</dt>
                <dd className="font-medium break-words">{displayedSourceLabel}</dd>
                <dt className="opacity-60">{t('packageQuality.metadata')}</dt>
                <dd className="font-mono break-all">{metadataVersion ? `schema v${metadataVersion}` : t('boardSelector.passport.notDeclared')}</dd>
                <dt className="opacity-60">{t('packageQuality.contentHash')} SHA-256</dt>
                <dd className="font-mono break-all select-all">{contentHash || t('packageQuality.notRecorded')}</dd>
                {report?.validator_id && (
                    <>
                        <dt className="opacity-60">{t('packageQuality.validator')}</dt>
                        <dd className="font-mono break-all">{report.validator_id}{report.validator_version ? ` @ ${report.validator_version}` : ''}</dd>
                    </>
                )}
                {report?.ruleset_version && (
                    <>
                        <dt className="opacity-60">{t('packageQuality.ruleset')}</dt>
                        <dd className="font-mono break-all">{report.ruleset_version}</dd>
                    </>
                )}
                {report?.certification_level && (
                    <>
                        <dt className="opacity-60">{t('packageQuality.evidenceLevel')}</dt>
                        <dd className="font-mono break-all">
                            {report.certification_level === 'local-static'
                                ? t('packageQuality.localStatic')
                                : report.certification_level}
                        </dd>
                    </>
                )}
                {report?.generated_at && (
                    <>
                        <dt className="opacity-60">{t('packageQuality.generatedAt')}</dt>
                        <dd className="font-mono break-all select-all">{report.generated_at}</dd>
                    </>
                )}
                {report?.contract_sha256 && (
                    <>
                        <dt className="opacity-60">{t('packageQuality.rulesHash')}</dt>
                        <dd className="font-mono break-all select-all">{report.contract_sha256}</dd>
                    </>
                )}
            </dl>

            {orderedChecks.length > 0 && (
                <details className="mt-2 border-t border-current/15 pt-2" open={summary.tone === 'danger'}>
                    <summary className="flex cursor-pointer list-none items-center gap-1 text-[10px] font-bold select-none">
                        <ChevronDown size={12} /> {t('packageQuality.viewChecks', { count: orderedChecks.length })}
                    </summary>
                    <div className={`mt-2 grid ${compact ? 'grid-cols-1' : 'grid-cols-1 xl:grid-cols-2'} gap-1.5`}>
                        {orderedChecks.map((check, index) => (
                            <div key={`${check.code}-${index}`} className="flex items-start gap-2 rounded border border-current/15 bg-white/65 px-2 py-1.5 dark:bg-slate-950/25">
                                <CheckIcon status={check.status} />
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-1.5 text-[9px] font-bold">
                                        <span>{translate(qualityCheckLabelKey(check.status))}</span>
                                        <code className="break-all font-mono opacity-60">{check.code}</code>
                                    </div>
                                    <p className="mt-0.5 break-words text-[10px] leading-relaxed opacity-85">{redactQualityMessage(check.message, { emptyLabel: t('packageQuality.checkCompleted'), pathPlaceholder: t('packageQuality.pathPlaceholder') })}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </details>
            )}

            <p className="mt-2 border-t border-current/15 pt-2 text-[9px] leading-relaxed opacity-70">
                {t('packageQuality.localStaticNotice')}
            </p>
        </section>
    );
};

export default PackageQualityReportPanel;
