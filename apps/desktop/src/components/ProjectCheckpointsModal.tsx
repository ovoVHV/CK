import { useCallback, useEffect, useState } from 'react';
import {
    ArchiveRestore,
    Blocks,
    Clock3,
    HardDrive,
    Loader2,
    RefreshCw,
    Save,
    ShieldCheck,
    Trash2,
    X,
} from 'lucide-react';
import {
    MAX_PROJECT_CHECKPOINTS,
    checkpointReasonLabel,
    deleteProjectCheckpoint,
    formatCheckpointBytes,
    formatCheckpointTime,
    isNativeCheckpointStorageAvailable,
    listProjectCheckpoints,
    loadProjectCheckpoint,
    type ProjectCheckpoint,
    type ProjectCheckpointMetadata,
} from '../services/project_checkpoints';
import { useDialog } from '../contexts/DialogContext';

interface ProjectCheckpointsModalProps {
    isOpen: boolean;
    projectPath: string;
    onClose: () => void;
    /**
     * The workspace owner performs the actual restore through the same official
     * Blockly load path used by normal projects. It must create a
     * `before_restore` checkpoint before replacing the current workspace.
     */
    onRestore: (checkpoint: ProjectCheckpoint) => Promise<void> | void;
    /** Save the currently visible workspace through the same complete serializer. */
    onCreate: () => Promise<void> | void;
}

const boardLabel = (fqbn: string): string => {
    const parts = fqbn.split(':');
    return parts.length >= 3 ? parts.slice(0, 3).join(':') : fqbn;
};

export function ProjectCheckpointsModal({
    isOpen,
    projectPath,
    onClose,
    onRestore,
    onCreate,
}: ProjectCheckpointsModalProps) {
    const dialog = useDialog();
    const [checkpoints, setCheckpoints] = useState<ProjectCheckpointMetadata[]>([]);
    const [loading, setLoading] = useState(false);
    const [creating, setCreating] = useState(false);
    const [restoringId, setRestoringId] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const hasActiveOperation = loading || creating || Boolean(restoringId) || Boolean(deletingId);

    const refresh = useCallback(async () => {
        if (!projectPath || !isNativeCheckpointStorageAvailable()) {
            setCheckpoints([]);
            return;
        }
        setLoading(true);
        setError(null);
        try {
            setCheckpoints(await listProjectCheckpoints(projectPath));
        } catch (cause) {
            console.error('[ProjectCheckpoints] Failed to list checkpoints', cause);
            setError(`读取检查点失败：${String(cause)}`);
        } finally {
            setLoading(false);
        }
    }, [projectPath]);

    useEffect(() => {
        if (!isOpen) return;
        void refresh();
    }, [isOpen, refresh]);

    useEffect(() => {
        if (!isOpen) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !hasActiveOperation) onClose();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [hasActiveOperation, isOpen, onClose]);

    if (!isOpen) return null;

    const restore = async (metadata: ProjectCheckpointMetadata) => {
        if (hasActiveOperation) return;
        const confirmed = await dialog.confirm({
            title: '恢复这个工程检查点？',
            message: `时间：${formatCheckpointTime(metadata.createdAt)}\n板卡：${boardLabel(metadata.board)}\n积木：${metadata.blockCount} 个\n原因：${checkpointReasonLabel(metadata.reason)}\n\n当前工作区会先自动创建“恢复前保护”检查点，再替换为该状态。恢复后请确认内容并手动保存工程。`,
            tone: 'warning',
            confirmLabel: '确认恢复',
            cancelLabel: '取消',
        });
        if (!confirmed) return;
        setRestoringId(metadata.id);
        setError(null);
        try {
            const checkpoint = await loadProjectCheckpoint(projectPath, metadata.id);
            await onRestore(checkpoint);
            onClose();
        } catch (cause) {
            console.error('[ProjectCheckpoints] Failed to restore checkpoint', cause);
            setError(`恢复失败：${String(cause)}`);
        } finally {
            setRestoringId(null);
        }
    };

    const createManualCheckpoint = async () => {
        if (hasActiveOperation || !isNativeCheckpointStorageAvailable()) return;
        setCreating(true);
        setError(null);
        try {
            await onCreate();
            await refresh();
        } catch (cause) {
            console.error('[ProjectCheckpoints] Failed to create manual checkpoint', cause);
            setError(`保存检查点失败：${String(cause)}`);
        } finally {
            setCreating(false);
        }
    };

    const remove = async (metadata: ProjectCheckpointMetadata) => {
        if (hasActiveOperation || !isNativeCheckpointStorageAvailable()) return;
        const confirmed = await dialog.confirm({
            title: '删除这个工程检查点？',
            message: `时间：${formatCheckpointTime(metadata.createdAt)}\n板卡：${boardLabel(metadata.board)}\n积木：${metadata.blockCount} 个\n原因：${checkpointReasonLabel(metadata.reason)}\n\n删除后无法恢复，但不会修改当前工作区、源码或已烧录固件。`,
            tone: 'danger',
            confirmLabel: '确认删除',
            cancelLabel: '取消',
        });
        if (!confirmed) return;
        setDeletingId(metadata.id);
        setError(null);
        try {
            await deleteProjectCheckpoint(projectPath, metadata.id);
            await refresh();
        } catch (cause) {
            console.error('[ProjectCheckpoints] Failed to delete checkpoint', cause);
            setError(`删除检查点失败：${String(cause)}`);
        } finally {
            setDeletingId(null);
        }
    };

    const nativeAvailable = isNativeCheckpointStorageAvailable();

    return (
        <div
            className="fixed inset-0 z-[520] flex items-center justify-center bg-slate-950/35 p-4 backdrop-blur-[1px] dark:bg-black/65"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-checkpoints-title"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget && !hasActiveOperation) onClose();
            }}
        >
            <section className="flex max-h-[min(720px,calc(100vh-32px))] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-[#fbfcfe] shadow-2xl dark:border-slate-700 dark:bg-slate-900">
                <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 bg-white px-5 py-4 dark:border-slate-700 dark:bg-slate-900">
                    <div className="flex min-w-0 items-start gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-[#0f766e] dark:bg-teal-950/55 dark:text-teal-300">
                            <ShieldCheck size={19} />
                        </span>
                        <div className="min-w-0">
                            <h2 id="project-checkpoints-title" className="text-sm font-bold text-slate-900 dark:text-slate-100">
                                工程检查点
                            </h2>
                            <p className="mt-1 truncate text-[11px] text-slate-500 dark:text-slate-400" title={projectPath}>
                                可随时保存，也会在编译、上传和恢复前自动保护
                            </p>
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                        <button
                            type="button"
                            onClick={() => void refresh()}
                            disabled={hasActiveOperation || !nativeAvailable}
                            className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold text-slate-500 transition-colors hover:bg-slate-100 hover:text-[#0f766e] disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-teal-300"
                        >
                            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
                            刷新
                        </button>
                        <button
                            type="button"
                            onClick={onClose}
                            disabled={hasActiveOperation}
                            className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                            aria-label="关闭工程检查点"
                        >
                            <X size={16} />
                        </button>
                    </div>
                </header>

                <div className="flex shrink-0 flex-col gap-2 border-b border-slate-200 bg-teal-50/55 px-5 py-2.5 text-[10px] leading-4 text-teal-900 min-[520px]:flex-row min-[520px]:items-center dark:border-slate-700 dark:bg-teal-950/30 dark:text-teal-200">
                    <span className="min-w-0 flex-1">
                        最多保留最近 {MAX_PROJECT_CHECKPOINTS} 个。手动和自动检查点都使用正式工程序列化，包含变量、过程、第三方积木状态和断点；恢复前会再保护当前状态。
                    </span>
                    <button
                        type="button"
                        data-ck-role="create-manual-checkpoint"
                        onClick={() => void createManualCheckpoint()}
                        disabled={hasActiveOperation || !nativeAvailable}
                        className="flex h-8 w-full shrink-0 items-center justify-center gap-1.5 rounded-md border border-teal-200 bg-white px-2.5 text-[11px] font-bold text-[#0f766e] shadow-sm transition-colors hover:bg-teal-100 disabled:cursor-not-allowed disabled:opacity-50 min-[520px]:w-auto dark:border-teal-800 dark:bg-slate-900 dark:text-teal-300 dark:hover:bg-teal-950/70"
                        title="立即保存当前积木、源码、板卡和完整配置"
                    >
                        {creating ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                        {creating ? '保存中…' : '保存当前状态'}
                    </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    {!nativeAvailable && (
                        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-5 text-center text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
                            工程检查点只在 CK 桌面软件中启用，网页预览不会写入恢复数据。
                        </div>
                    )}

                    {nativeAvailable && loading && checkpoints.length === 0 && (
                        <div className="flex min-h-40 items-center justify-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                            <Loader2 size={16} className="animate-spin text-[#0f766e] dark:text-teal-300" />
                            正在读取检查点…
                        </div>
                    )}

                    {nativeAvailable && !loading && checkpoints.length === 0 && !error && (
                        <div className="flex min-h-44 flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white px-4 text-center dark:border-slate-700 dark:bg-slate-800/55">
                            <HardDrive size={25} className="text-slate-300 dark:text-slate-600" />
                            <p className="mt-3 text-xs font-bold text-slate-600 dark:text-slate-300">还没有检查点</p>
                            <p className="mt-1 text-[10px] leading-4 text-slate-400 dark:text-slate-500">
                                点击“保存当前状态”，或等待下一次编译、上传前自动保护。
                            </p>
                        </div>
                    )}

                    {checkpoints.length > 0 && (
                        <div className="grid gap-2.5">
                            {checkpoints.map((checkpoint, index) => {
                                const restoring = restoringId === checkpoint.id;
                                const deleting = deletingId === checkpoint.id;
                                return (
                                    <article
                                        key={checkpoint.id}
                                        className="flex flex-col items-stretch gap-3 rounded-lg border border-slate-200 bg-white px-3.5 py-3 shadow-sm min-[520px]:flex-row min-[520px]:items-center dark:border-slate-700 dark:bg-slate-800/65"
                                        aria-busy={restoring || deleting}
                                    >
                                        <div className="flex min-w-0 flex-1 items-start gap-3">
                                            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${index === 0 ? 'bg-teal-50 text-[#0f766e] dark:bg-teal-950/55 dark:text-teal-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-300'}`}>
                                                <Clock3 size={15} />
                                            </span>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                                    <strong className="text-xs text-slate-800 dark:text-slate-100">
                                                        {checkpointReasonLabel(checkpoint.reason)}
                                                    </strong>
                                                    {index === 0 && (
                                                        <span className="rounded border border-teal-200 bg-teal-50 px-1.5 py-0.5 text-[9px] font-bold text-[#0f766e] dark:border-teal-900 dark:bg-teal-950/45 dark:text-teal-300">
                                                            最新
                                                        </span>
                                                    )}
                                                    <time className="text-[10px] font-mono text-slate-400 dark:text-slate-500" dateTime={checkpoint.createdAt}>
                                                        {formatCheckpointTime(checkpoint.createdAt)}
                                                    </time>
                                                </div>
                                                <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500 dark:text-slate-400">
                                                    <span className="inline-flex items-center gap-1">
                                                        <Blocks size={11} /> {checkpoint.blockCount} 个积木
                                                    </span>
                                                    <span className="inline-flex items-center gap-1">
                                                        <HardDrive size={11} /> {formatCheckpointBytes(checkpoint.byteSize)}
                                                    </span>
                                                    <span className="max-w-[240px] truncate font-mono" title={checkpoint.board}>
                                                        {boardLabel(checkpoint.board)}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="grid shrink-0 grid-cols-2 gap-2 min-[520px]:flex">
                                            <button
                                                type="button"
                                                onClick={() => void restore(checkpoint)}
                                                disabled={hasActiveOperation}
                                                className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md border border-teal-200 bg-teal-50 px-3 text-[11px] font-bold text-[#0f766e] transition-colors hover:bg-teal-100 disabled:cursor-not-allowed disabled:opacity-50 min-[520px]:w-auto dark:border-teal-800 dark:bg-teal-950/45 dark:text-teal-300 dark:hover:bg-teal-950/70"
                                                aria-label={`恢复检查点：${checkpointReasonLabel(checkpoint.reason)}，${formatCheckpointTime(checkpoint.createdAt)}`}
                                            >
                                                {restoring ? <Loader2 size={14} className="animate-spin" /> : <ArchiveRestore size={14} />}
                                                {restoring ? '恢复中…' : '恢复'}
                                            </button>
                                            <button
                                                type="button"
                                                data-ck-role="delete-project-checkpoint"
                                                onClick={() => void remove(checkpoint)}
                                                disabled={hasActiveOperation}
                                                className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md border border-red-200 bg-red-50 px-3 text-[11px] font-bold text-red-700 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 min-[520px]:w-auto dark:border-red-900 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-950/65"
                                                aria-label={`删除检查点：${checkpointReasonLabel(checkpoint.reason)}，${formatCheckpointTime(checkpoint.createdAt)}`}
                                            >
                                                {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                                                {deleting ? '删除中…' : '删除'}
                                            </button>
                                        </div>
                                    </article>
                                );
                            })}
                        </div>
                    )}

                    {error && (
                        <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[10px] leading-4 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300" role="alert" aria-live="assertive">
                            {error}
                        </div>
                    )}
                </div>
            </section>
        </div>
    );
}

export default ProjectCheckpointsModal;
