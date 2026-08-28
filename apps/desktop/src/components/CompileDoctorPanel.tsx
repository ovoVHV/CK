import { Activity, CheckCircle2, CircleAlert, Database, Gauge, TimerReset, TriangleAlert } from 'lucide-react';
import {
    compileBuildModeLabel,
    compileMissReasonLabel,
    formatCompileDuration,
    type CompileDoctorReport,
} from '../services/compile_doctor';
import type { WorkspaceViewMode } from '../services/workspace_view_mode';

interface CompileDoctorPanelProps {
    report: CompileDoctorReport | null;
    isCompiling?: boolean;
    compact?: boolean;
    displayMode?: WorkspaceViewMode;
}

const statusTheme = (status: CompileDoctorReport['status']) => {
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
    return {
        shell: 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/30',
        icon: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300',
        title: 'text-emerald-800 dark:text-emerald-300',
        Icon: CheckCircle2,
    };
};

const cachePill = (active: boolean, label: string) => (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${active ? 'bg-white text-emerald-700 border border-emerald-200 dark:border-emerald-800 dark:bg-slate-900/75 dark:text-emerald-300' : 'bg-white/70 text-slate-400 border border-slate-200 dark:border-slate-700 dark:bg-slate-900/55 dark:text-slate-500'}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`} />
        {label}
    </span>
);

const toolchainIdentitySourceLabel = (
    source: CompileDoctorReport['toolchainIdentitySource'],
): string | null => {
    if (source === 'process-memory') return '进程内身份复用';
    if (source === 'persistent-metadata') return '跨进程证据复用';
    if (source === 'strong-content') return '强内容校验';
    return null;
};

const forgeCoreStatusTone = (status: CompileDoctorReport['forgeCoreStatus']): string => {
    if (status === 'certified-evidence-available') {
        return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/55 dark:text-emerald-300';
    }
    if (status === 'local-certification-required') {
        return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/55 dark:text-amber-300';
    }
    return 'border-slate-300 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-300';
};

export function CompileDoctorPanel({
    report,
    isCompiling = false,
    compact = false,
    displayMode = 'engineering',
}: CompileDoctorPanelProps) {
    if (!report && !isCompiling) return null;

    if (!report) {
        return (
            <div className="mx-2 mt-2 rounded-md border border-blue-200 bg-blue-50/70 px-3 py-2 flex items-center gap-2 text-xs text-blue-700 shrink-0 dark:border-blue-900 dark:bg-blue-950/35 dark:text-blue-300">
                <Activity size={15} className="animate-pulse" />
                构建体检正在采集缓存、锁等待和工具链信息…
            </div>
        );
    }

    const theme = statusTheme(report.status);
    const StatusIcon = theme.Icon;
    const simple = displayMode === 'simple';
    const identitySourceLabel = toolchainIdentitySourceLabel(report.toolchainIdentitySource);

    return (
        <section className={`mx-2 mt-2 rounded-md border ${theme.shell} ${compact ? 'px-2.5 py-2' : 'px-3 py-2.5'} shrink-0`} aria-label="构建体检">
            <div className="flex items-start gap-2.5 min-w-0">
                <div className={`h-7 w-7 rounded-md flex items-center justify-center shrink-0 ${theme.icon}`}>
                    <StatusIcon size={15} />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wide dark:text-slate-400">构建体检</span>
                        {report.forgeDecision && (
                            <span
                                data-ck-role="forge-engine-badge"
                                className="rounded border border-teal-200 bg-teal-50 px-1.5 py-0.5 text-[9px] font-bold text-teal-700 dark:border-teal-800 dark:bg-teal-950/55 dark:text-teal-300"
                                title={report.forgeDecision === 'allow-fast' ? '已通过快速路径资格检查' : '使用平台原生兼容路径'}
                            >
                                CK Forge
                            </span>
                        )}
                        <span className={`text-xs font-bold ${theme.title}`}>{report.summary}</span>
                        {isCompiling && <span className="text-[10px] text-blue-600 animate-pulse dark:text-blue-300">正在重新检测</span>}
                    </div>
                    <p className="mt-0.5 text-[11px] leading-4 text-slate-600 dark:text-slate-300">{report.explanation}</p>
                    {report.forgeDecision && (
                        <div
                            data-ck-role="forge-core-qualification-status"
                            className={`mt-1.5 rounded border px-2 py-1 text-[10px] leading-4 ${forgeCoreStatusTone(report.forgeCoreStatus)}`}
                            title={report.forgeReasonDetails.join('；') || report.forgeCoreStatusDetail}
                        >
                            <span className="font-bold">{report.forgeCoreStatusLabel}</span>
                            <span className="ml-1">{report.forgeCoreStatusDetail}</span>
                        </div>
                    )}
                </div>
            </div>

            <div
                className="mt-2 grid min-w-0 gap-1.5"
                style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(110px, 100%), 1fr))' }}
            >
                <div className="rounded border border-white/80 bg-white/75 px-2 py-1.5 min-w-0 dark:border-slate-700 dark:bg-slate-900/65">
                    <span className="flex items-center gap-1 text-[9px] text-slate-400 dark:text-slate-500"><Gauge size={11} />编译路径</span>
                    <span className="mt-0.5 block truncate text-[10px] font-bold text-slate-700 dark:text-slate-200">{compileBuildModeLabel(report.buildMode)}</span>
                </div>
                <div className="rounded border border-white/80 bg-white/75 px-2 py-1.5 min-w-0 dark:border-slate-700 dark:bg-slate-900/65">
                    <span className="flex items-center gap-1 text-[9px] text-slate-400 dark:text-slate-500"><TimerReset size={11} />总耗时</span>
                    <span className="mt-0.5 block text-[10px] font-mono font-bold text-slate-700 dark:text-slate-200">{formatCompileDuration(report.totalMs)}</span>
                </div>
                <div className="rounded border border-white/80 bg-white/75 px-2 py-1.5 min-w-0 dark:border-slate-700 dark:bg-slate-900/65">
                    <span className="flex items-center gap-1 text-[9px] text-slate-400 dark:text-slate-500"><Activity size={11} />真正编译</span>
                    <span className="mt-0.5 block text-[10px] font-mono font-bold text-slate-700 dark:text-slate-200">{formatCompileDuration(report.cliCompileMs)}</span>
                </div>
                <div className={`rounded border bg-white/75 px-2 py-1.5 min-w-0 dark:bg-slate-900/65 ${report.lockWaitMs >= 1000 ? 'border-amber-200 dark:border-amber-800' : 'border-white/80 dark:border-slate-700'}`}>
                    <span className="flex items-center gap-1 text-[9px] text-slate-400 dark:text-slate-500"><Database size={11} />等待编译锁</span>
                    <span className={`mt-0.5 block text-[10px] font-mono font-bold ${report.lockWaitMs >= 1000 ? 'text-amber-700 dark:text-amber-300' : 'text-slate-700 dark:text-slate-200'}`}>{formatCompileDuration(report.lockWaitMs)}</span>
                </div>
            </div>

            {!simple && !compact && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {cachePill(report.exactMatch, '完整产物')}
                    {cachePill(report.coreCache, '核心缓存')}
                    {cachePill(report.ccacheEnabled, '编译对象')}
                    {identitySourceLabel && (
                        <span
                            data-ck-role="toolchain-identity-source"
                            className="inline-flex items-center rounded border border-slate-200 bg-white/75 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:border-slate-700 dark:bg-slate-900/65 dark:text-slate-300"
                            title={report.toolchainIdentitySource === 'persistent-metadata'
                                ? '已复核安装树元数据并复用上次强内容校验结论'
                                : report.toolchainIdentitySource === 'process-memory'
                                    ? '已复核轻量包元数据并复用本进程已验证的工具链身份'
                                    : '本次重新校验了当前目标实际使用的工具链内容'}
                        >
                            工具链：{identitySourceLabel}
                        </span>
                    )}
                    {report.warmupReused && cachePill(true, '后台预热')}
                    {report.forcedRebuild && <span className="text-[10px] font-semibold text-amber-700 dark:text-amber-300">本次为强制重建</span>}
                </div>
            )}

            {!simple && (report.missReasons.length > 0 || report.environmentChanges.length > 0 || report.status !== 'healthy') && (
                <div className="mt-2 border-t border-slate-200/70 pt-1.5 text-[10px] leading-4 text-slate-600 dark:border-slate-700 dark:text-slate-300">
                    {report.missReasons.length > 0 && (
                        <div><span className="font-bold text-slate-700 dark:text-slate-200">缓存变化：</span>{report.missReasons.map(compileMissReasonLabel).join('、')}</div>
                    )}
                    {report.environmentChanges.length > 0 && (
                        <div><span className="font-bold text-slate-700 dark:text-slate-200">环境变化：</span>{report.environmentChanges.join('；')}</div>
                    )}
                    {report.forgeReasonDetails.length > 0 && report.forgeCoreStatus !== 'certified-evidence-available' && (
                        <div><span className="font-bold text-slate-700 dark:text-slate-200">资格原因：</span>{report.forgeReasonDetails.join('；')}</div>
                    )}
                    <div><span className="font-bold text-slate-700 dark:text-slate-200">建议：</span>{report.recommendation}</div>
                </div>
            )}

            {simple && (
                <>
                    <div
                        data-ck-role="compile-doctor-actionable-summary"
                        className="mt-2 border-t border-slate-200/70 pt-1.5 text-[10px] leading-4 text-slate-600 dark:border-slate-700 dark:text-slate-300"
                    >
                        <span className="font-bold text-slate-700 dark:text-slate-200">建议：</span>
                        {report.recommendation}
                    </div>
                    <details data-ck-role="compile-doctor-advanced-details" className="mt-1.5 text-[10px] text-slate-500 dark:text-slate-400">
                        <summary className="cursor-pointer select-none font-semibold text-teal-700 hover:text-teal-800 dark:text-teal-300 dark:hover:text-teal-200">
                            查看缓存与环境技术信息
                        </summary>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            {cachePill(report.exactMatch, '完整产物')}
                            {cachePill(report.coreCache, '核心缓存')}
                            {cachePill(report.ccacheEnabled, '编译对象')}
                            {identitySourceLabel && (
                                <span
                                    data-ck-role="toolchain-identity-source-advanced"
                                    className="inline-flex items-center rounded border border-slate-200 bg-white/75 px-1.5 py-0.5 font-semibold text-slate-600 dark:border-slate-700 dark:bg-slate-900/65 dark:text-slate-300"
                                >
                                    工具链：{identitySourceLabel}
                                </span>
                            )}
                            {report.warmupReused && cachePill(true, '后台预热')}
                            {report.forcedRebuild && <span className="text-[10px] font-semibold text-amber-700 dark:text-amber-300">本次为强制重建</span>}
                        </div>
                        {(report.missReasons.length > 0 || report.environmentChanges.length > 0 || report.forgeReasonDetails.length > 0) && (
                            <div className="mt-1.5 leading-4">
                                {report.missReasons.length > 0 && (
                                    <div><span className="font-bold">缓存变化：</span>{report.missReasons.map(compileMissReasonLabel).join('、')}</div>
                                )}
                                {report.environmentChanges.length > 0 && (
                                    <div><span className="font-bold">环境变化：</span>{report.environmentChanges.join('；')}</div>
                                )}
                                {report.forgeReasonDetails.length > 0 && report.forgeCoreStatus !== 'certified-evidence-available' && (
                                    <div><span className="font-bold">资格原因：</span>{report.forgeReasonDetails.join('；')}</div>
                                )}
                            </div>
                        )}
                    </details>
                </>
            )}
        </section>
    );
}
