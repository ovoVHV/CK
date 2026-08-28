import { AlertTriangle, Ban, CheckCircle2, CircleHelp, ShieldCheck } from 'lucide-react';
import type { LibraryInfo } from '../types/library';
import {
    blockPassportStatusLabel,
    buildBlockPackagePassport,
    type BlockPackagePassportStageStatus,
} from '../services/block_package_passport';

const statusClass: Record<BlockPackagePassportStageStatus, string> = {
    passed: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/35 dark:text-emerald-300',
    warning: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/35 dark:text-amber-300',
    failed: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/35 dark:text-rose-300',
    pending: 'border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400',
};

const StageIcon = ({ status }: { status: BlockPackagePassportStageStatus }) => {
    if (status === 'passed') return <CheckCircle2 size={13} />;
    if (status === 'warning') return <AlertTriangle size={13} />;
    if (status === 'failed') return <Ban size={13} />;
    return <CircleHelp size={13} />;
};

export function BlockPackagePassportBadge({ library }: { library: Partial<LibraryInfo> }) {
    const passport = buildBlockPackagePassport(library);
    const tone = passport.summary === 'blocked'
        ? statusClass.failed
        : passport.summary === 'ready'
            ? statusClass.passed
            : statusClass.warning;
    const SummaryIcon = passport.summary === 'blocked'
        ? Ban
        : passport.summary === 'attention'
            ? AlertTriangle
            : ShieldCheck;
    const summaryLabel = passport.summary === 'blocked'
        ? '已阻止'
        : passport.summary === 'attention'
            ? '需关注'
            : '证据完整';
    return (
        <span
            className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold ${tone}`}
            title={passport.boundary}
            aria-label={`积木库证据护照：${summaryLabel}，${passport.passedStages}/${passport.totalStages} 阶段已验证`}
            data-ck-block-passport-summary={passport.summary}
        >
            <SummaryIcon size={11} /> 证据护照 · {summaryLabel} {passport.passedStages}/{passport.totalStages}
        </span>
    );
}

export function BlockPackagePassportPanel({ library }: { library: Partial<LibraryInfo> }) {
    const passport = buildBlockPackagePassport(library);
    return (
        <section
            className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900"
            data-ck-role="block-package-passport"
            aria-label="积木库证据护照"
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <div className="text-xs font-bold text-slate-700 dark:text-slate-200">积木库证据护照</div>
                    <p className="mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">按当前包内容和本机证据逐级展示，不计算综合分。</p>
                </div>
                <BlockPackagePassportBadge library={library} />
            </div>
            <div className="mt-2 grid grid-cols-1 gap-1.5 xl:grid-cols-2">
                {passport.stages.map(stage => (
                    <div key={stage.id} className={`rounded border px-2 py-1.5 ${statusClass[stage.status]}`}>
                        <div className="flex items-center gap-1.5 text-[10px] font-bold">
                            <StageIcon status={stage.status} />
                            <span>{stage.label}</span>
                            <span className="ml-auto text-[9px] opacity-75">{blockPassportStatusLabel(stage.status)}</span>
                        </div>
                        <p className="mt-1 text-[9px] leading-4 opacity-85">{stage.detail}</p>
                    </div>
                ))}
            </div>
            <p className="mt-2 border-t border-slate-100 pt-2 text-[9px] leading-4 text-slate-400 dark:border-slate-800 dark:text-slate-500">
                {passport.boundary}
            </p>
        </section>
    );
}

export default BlockPackagePassportPanel;
