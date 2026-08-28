import { AlertTriangle, ArchiveRestore, FilePlus2, ShieldCheck, Trash2, X } from 'lucide-react';
import type { RecoveryDraft, RecoveryDraftMetadata } from '../services/recovery_drafts';
import { formatRecoveryDraftTime } from '../services/recovery_drafts';

interface RecoveryDraftModalProps {
    candidate: RecoveryDraftMetadata;
    draft: RecoveryDraft;
    busy?: boolean;
    onKeepForLater: () => void;
    onDiscard: () => void;
    onRestoreAsNew: () => void;
    onRestoreCurrent: () => void;
}

const countSerializedBlocks = (raw: string): number => {
    try {
        const root = JSON.parse(raw);
        let count = 0;
        const seen = new Set<unknown>();
        const visit = (value: unknown) => {
            if (!value || typeof value !== 'object' || seen.has(value)) return;
            seen.add(value);
            if (!Array.isArray(value) && typeof (value as any).type === 'string') count += 1;
            if (Array.isArray(value)) value.forEach(visit);
            else Object.values(value as Record<string, unknown>).forEach(visit);
        };
        visit(root);
        return count;
    } catch {
        return 0;
    }
};

const shortHash = (value: string) => String(value || '').replace(/^sha256:/, '').slice(0, 12);

export function RecoveryDraftModal({
    candidate,
    draft,
    busy = false,
    onKeepForLater,
    onDiscard,
    onRestoreAsNew,
    onRestoreCurrent,
}: RecoveryDraftModalProps) {
    const blockCount = countSerializedBlocks(draft.workspaceJson);
    return (
        <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-[2px]" data-ck-role="recovery-draft-backdrop">
            <section
                role="dialog"
                aria-modal="true"
                aria-labelledby="ck-recovery-draft-title"
                className="w-full max-w-2xl overflow-hidden rounded-2xl border border-amber-200 bg-white shadow-2xl dark:border-amber-900/70 dark:bg-slate-900"
                data-ck-role="recovery-draft-dialog"
            >
                <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5 dark:border-slate-800">
                    <div className="flex min-w-0 items-start gap-3">
                        <div className="mt-0.5 rounded-xl bg-amber-100 p-2.5 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
                            <ArchiveRestore size={22} />
                        </div>
                        <div className="min-w-0">
                            <h2 id="ck-recovery-draft-title" className="text-lg font-bold text-slate-900 dark:text-slate-100">发现未保存恢复稿</h2>
                            <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
                                这是本次打开工程会话中最新的一份有效恢复稿。它不会冒充正式版本或自动覆盖工程，更旧的安全稿也不会接着连续弹出。
                            </p>
                        </div>
                    </div>
                    <button type="button" onClick={onKeepForLater} disabled={busy} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50 dark:hover:bg-slate-800" aria-label="暂不处理恢复稿">
                        <X size={18} />
                    </button>
                </header>

                <div className="space-y-4 px-6 py-5">
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-950/60">
                            <div className="text-xs font-semibold text-slate-500">恢复稿时间</div>
                            <div className="mt-1 text-sm font-bold text-slate-800 dark:text-slate-100">{formatRecoveryDraftTime(candidate.createdAt)}</div>
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-950/60">
                            <div className="text-xs font-semibold text-slate-500">保存内容</div>
                            <div className="mt-1 text-sm font-bold text-slate-800 dark:text-slate-100">{blockCount} 个序列化积木 · {(candidate.byteSize / 1024).toFixed(1)} KiB</div>
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-950/60">
                            <div className="text-xs font-semibold text-slate-500">板卡与编译目标</div>
                            <div className="mt-1 break-all text-sm font-bold text-slate-800 dark:text-slate-100">{draft.fqbn || draft.board}</div>
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-950/60">
                            <div className="text-xs font-semibold text-slate-500">完整状态指纹</div>
                            <div className="mt-1 font-mono text-sm font-bold text-slate-800 dark:text-slate-100">{shortHash(candidate.fullStateHash)}…</div>
                        </div>
                    </div>

                    <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-sm leading-6 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                        <AlertTriangle size={17} className="mt-1 shrink-0" />
                        <span>“覆盖当前工作区”会先建立正式检查点，所选稿保留到正式保存成功；“暂不处理”在本次会话内不再提示同基线旧稿，重新打开工程后可再次判断。若恢复稿包含尚未安装的第三方积木，CK 会停止恢复并保留原始数据。</span>
                    </div>
                </div>

                <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-6 py-4 dark:border-slate-800 dark:bg-slate-950/50">
                    <button type="button" onClick={onDiscard} disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-lg border border-red-200 px-3 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40">
                        <Trash2 size={15} /> 放弃恢复稿
                    </button>
                    <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={onRestoreAsNew} disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">
                            <FilePlus2 size={15} /> 恢复为新工程
                        </button>
                        <button type="button" onClick={onRestoreCurrent} disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-lg bg-amber-600 px-4 text-sm font-bold text-white hover:bg-amber-700 disabled:opacity-50 dark:bg-amber-500 dark:text-slate-950 dark:hover:bg-amber-400">
                            <ShieldCheck size={15} /> {busy ? '正在恢复...' : '覆盖当前工作区'}
                        </button>
                    </div>
                </footer>
            </section>
        </div>
    );
}
