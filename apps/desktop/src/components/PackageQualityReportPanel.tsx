import { AlertTriangle, Ban, CheckCircle2, ChevronDown, CircleHelp, ShieldCheck } from 'lucide-react';
import type { PackageQualityReport, QualityCheckStatus } from '../types/packageQuality';
import {
    qualityCheckLabel,
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

export const PackageQualityStatusBadge = ({ report }: PackageQualityStatusBadgeProps) => {
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
            title={summary.detail}
        >
            <Icon size={11} /> {summary.label}
        </span>
    );
};

export const PackageQualityReportPanel = ({
    report,
    metadataVersion,
    sourceLabel = '来源未声明',
    compact = false,
}: PackageQualityReportPanelProps) => {
    const summary = qualityStatusSummary(report);
    const checks = report?.checks || [];
    const orderedChecks = [...checks].sort((left, right) => {
        const order: Record<QualityCheckStatus, number> = { error: 0, warning: 1, passed: 2 };
        return order[left.status] - order[right.status];
    });

    return (
        <section
            data-ck-role="package-quality-report"
            className={`rounded-lg border ${toneClasses[summary.tone]} ${compact ? 'p-2.5' : 'p-3'}`}
            aria-label="扩展质量报告"
        >
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-bold">自动质量报告</span>
                        <PackageQualityStatusBadge report={report} />
                    </div>
                    <p className="mt-1 text-[10px] leading-relaxed opacity-85">{summary.detail}</p>
                </div>
                {report && (
                    <div className="shrink-0 text-right text-[10px] font-semibold">
                        <span className={report.error_count ? 'text-rose-600 dark:text-rose-300' : ''}>{report.error_count} 阻止</span>
                        <span className="mx-1.5 opacity-40">·</span>
                        <span className={report.warning_count ? 'text-amber-600 dark:text-amber-300' : ''}>{report.warning_count} 警告</span>
                    </div>
                )}
            </div>

            <dl className="mt-2 grid grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-1 text-[10px]">
                <dt className="opacity-60">包来源</dt>
                <dd className="font-medium break-words">{sourceLabel}</dd>
                <dt className="opacity-60">元数据</dt>
                <dd className="font-mono break-all">{metadataVersion ? `schema v${metadataVersion}` : '未声明'}</dd>
                <dt className="opacity-60">内容 SHA-256</dt>
                <dd className="font-mono break-all select-all">{qualityHashLabel(report?.source_content_sha256)}</dd>
                {report?.validator_id && (
                    <>
                        <dt className="opacity-60">检查器</dt>
                        <dd className="font-mono break-all">{report.validator_id}{report.validator_version ? ` @ ${report.validator_version}` : ''}</dd>
                    </>
                )}
                {report?.ruleset_version && (
                    <>
                        <dt className="opacity-60">规则集</dt>
                        <dd className="font-mono break-all">{report.ruleset_version}</dd>
                    </>
                )}
                {report?.certification_level && (
                    <>
                        <dt className="opacity-60">证据级别</dt>
                        <dd className="font-mono break-all">
                            {report.certification_level === 'local-static'
                                ? '本机静态检查'
                                : report.certification_level}
                        </dd>
                    </>
                )}
                {report?.generated_at && (
                    <>
                        <dt className="opacity-60">生成时间</dt>
                        <dd className="font-mono break-all select-all">{report.generated_at}</dd>
                    </>
                )}
                {report?.contract_sha256 && (
                    <>
                        <dt className="opacity-60">规则哈希</dt>
                        <dd className="font-mono break-all select-all">{report.contract_sha256}</dd>
                    </>
                )}
            </dl>

            {orderedChecks.length > 0 && (
                <details className="mt-2 border-t border-current/15 pt-2" open={summary.tone === 'danger'}>
                    <summary className="flex cursor-pointer list-none items-center gap-1 text-[10px] font-bold select-none">
                        <ChevronDown size={12} /> 查看 {orderedChecks.length} 项检查
                    </summary>
                    <div className={`mt-2 grid ${compact ? 'grid-cols-1' : 'grid-cols-1 xl:grid-cols-2'} gap-1.5`}>
                        {orderedChecks.map((check, index) => (
                            <div key={`${check.code}-${index}`} className="flex items-start gap-2 rounded border border-current/15 bg-white/65 px-2 py-1.5 dark:bg-slate-950/25">
                                <CheckIcon status={check.status} />
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-1.5 text-[9px] font-bold">
                                        <span>{qualityCheckLabel(check.status)}</span>
                                        <code className="break-all font-mono opacity-60">{check.code}</code>
                                    </div>
                                    <p className="mt-0.5 break-words text-[10px] leading-relaxed opacity-85">{redactQualityMessage(check.message)}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </details>
            )}

            <p className="mt-2 border-t border-current/15 pt-2 text-[9px] leading-relaxed opacity-70">
                这是本机自动静态检查结果，用于决定扩展能否安全进入运行目录；不代表 CK 官方背书，也不等同于真板验证或发布者签名。
            </p>
        </section>
    );
};

export default PackageQualityReportPanel;
