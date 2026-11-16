import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
    deleteProjectCheckpoint,
    formatCheckpointBytes,
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
    const { t: translate, i18n } = useTranslation('recovery');
    const t = translate as unknown as (key: string, options?: Record<string, unknown>) => string;
    const dialog = useDialog();
    const [checkpoints, setCheckpoints] = useState<ProjectCheckpointMetadata[]>([]);
    const [loading, setLoading] = useState(false);
    const [creating, setCreating] = useState(false);
    const [restoringId, setRestoringId] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const hasActiveOperation = loading || creating || Boolean(restoringId) || Boolean(deletingId);
    const formatTime = useCallback((createdAt: string): string => {
        const time = new Date(createdAt);
        if (Number.isNaN(time.getTime())) return createdAt;
        return new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language, {
            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        }).format(time);
    }, [i18n.language, i18n.resolvedLanguage]);
    const reasonLabel = useCallback((reason: ProjectCheckpointMetadata['reason']): string => {
        if (['before_compile', 'before_upload', 'before_restore', 'before_leave', 'manual'].includes(reason)) {
            return t(`checkpoint.reason.${reason}`);
        }
        return t('checkpoint.reason.automatic');
    }, [t]);

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
            setError(t('checkpoint.errors.read', { cause: String(cause) }));
        } finally {
            setLoading(false);
        }
    }, [projectPath, t]);

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
            title: t('checkpoint.confirm.restoreTitle'),
            message: t('checkpoint.confirm.restoreMessage', {
                time: formatTime(metadata.createdAt),
                board: boardLabel(metadata.board),
                count: metadata.blockCount,
                reason: reasonLabel(metadata.reason),
            }),
            tone: 'warning',
            confirmLabel: t('checkpoint.confirm.restoreAction'),
            cancelLabel: t('checkpoint.confirm.cancel'),
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
            setError(t('checkpoint.errors.restore', { cause: String(cause) }));
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
            setError(t('checkpoint.errors.create', { cause: String(cause) }));
        } finally {
            setCreating(false);
        }
    };

    const remove = async (metadata: ProjectCheckpointMetadata) => {
        if (hasActiveOperation || !isNativeCheckpointStorageAvailable()) return;
        const confirmed = await dialog.confirm({
            title: t('checkpoint.confirm.deleteTitle'),
            message: t('checkpoint.confirm.deleteMessage', {
                time: formatTime(metadata.createdAt),
                board: boardLabel(metadata.board),
                count: metadata.blockCount,
                reason: reasonLabel(metadata.reason),
            }),
            tone: 'danger',
            confirmLabel: t('checkpoint.confirm.deleteAction'),
            cancelLabel: t('checkpoint.confirm.cancel'),
        });
        if (!confirmed) return;
        setDeletingId(metadata.id);
        setError(null);
        try {
            await deleteProjectCheckpoint(projectPath, metadata.id);
            await refresh();
        } catch (cause) {
            console.error('[ProjectCheckpoints] Failed to delete checkpoint', cause);
            setError(t('checkpoint.errors.delete', { cause: String(cause) }));
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
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-[var(--accent)] dark:bg-brand-950/55 dark:text-brand-300">
                            <ShieldCheck size={19} />
                        </span>
                        <div className="min-w-0">
                            <h2 id="project-checkpoints-title" className="text-sm font-bold text-slate-900 dark:text-slate-100">
                                {t('checkpoint.title')}
                            </h2>
                            <p className="mt-1 truncate text-[11px] text-slate-500 dark:text-slate-400" title={projectPath}>
                                {t('checkpoint.description')}
                            </p>
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                        <button
                            type="button"
                            onClick={() => void refresh()}
                            disabled={hasActiveOperation || !nativeAvailable}
                            className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold text-slate-500 transition-colors hover:bg-slate-100 hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-brand-300"
                        >
                            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
                            {t('checkpoint.refresh')}
                        </button>
                        <button
                            type="button"
                            onClick={onClose}
                            disabled={hasActiveOperation}
                            className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                            aria-label={t('checkpoint.closeAria')}
                        >
                            <X size={16} />
                        </button>
                    </div>
                </header>

                <div className="flex shrink-0 flex-col gap-2 border-b border-slate-200 bg-brand-50/55 px-5 py-2.5 text-[10px] leading-4 text-brand-900 min-[520px]:flex-row min-[520px]:items-center dark:border-slate-700 dark:bg-brand-950/30 dark:text-brand-200">
                    <span className="min-w-0 flex-1">
                        {t('checkpoint.retention', { count: MAX_PROJECT_CHECKPOINTS })}
                    </span>
                    <button
                        type="button"
                        data-ck-role="create-manual-checkpoint"
                        onClick={() => void createManualCheckpoint()}
                        disabled={hasActiveOperation || !nativeAvailable}
                        className="flex h-8 w-full shrink-0 items-center justify-center gap-1.5 rounded-md border border-brand-200 bg-white px-2.5 text-[11px] font-bold text-[var(--accent)] shadow-sm transition-colors hover:bg-brand-100 disabled:cursor-not-allowed disabled:opacity-50 min-[520px]:w-auto dark:border-brand-800 dark:bg-slate-900 dark:text-brand-300 dark:hover:bg-brand-950/70"
                        title={t('checkpoint.createTooltip')}
                    >
                        {creating ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                        {creating ? t('checkpoint.saving') : t('checkpoint.saveCurrent')}
                    </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    {!nativeAvailable && (
                        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-5 text-center text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
                            {t('checkpoint.desktopOnly')}
                        </div>
                    )}

                    {nativeAvailable && loading && checkpoints.length === 0 && (
                        <div className="flex min-h-40 items-center justify-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                            <Loader2 size={16} className="animate-spin text-[var(--accent)] dark:text-brand-300" />
                            {t('checkpoint.loading')}
                        </div>
                    )}

                    {nativeAvailable && !loading && checkpoints.length === 0 && !error && (
                        <div className="flex min-h-44 flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white px-4 text-center dark:border-slate-700 dark:bg-slate-800/55">
                            <HardDrive size={25} className="text-slate-300 dark:text-slate-600" />
                            <p className="mt-3 text-xs font-bold text-slate-600 dark:text-slate-300">{t('checkpoint.emptyTitle')}</p>
                            <p className="mt-1 text-[10px] leading-4 text-slate-400 dark:text-slate-500">
                                {t('checkpoint.emptyDescription')}
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
                                            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${index === 0 ? 'bg-brand-50 text-[var(--accent)] dark:bg-brand-950/55 dark:text-brand-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-300'}`}>
                                                <Clock3 size={15} />
                                            </span>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                                    <strong className="text-xs text-slate-800 dark:text-slate-100">
                                                        {reasonLabel(checkpoint.reason)}
                                                    </strong>
                                                    {index === 0 && (
                                                        <span className="rounded border border-brand-200 bg-brand-50 px-1.5 py-0.5 text-[9px] font-bold text-[var(--accent)] dark:border-brand-900 dark:bg-brand-950/45 dark:text-brand-300">
                                                            {t('checkpoint.latest')}
                                                        </span>
                                                    )}
                                                    <time className="text-[10px] font-mono text-slate-400 dark:text-slate-500" dateTime={checkpoint.createdAt}>
                                                        {formatTime(checkpoint.createdAt)}
                                                    </time>
                                                </div>
                                                <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500 dark:text-slate-400">
                                                    <span className="inline-flex items-center gap-1">
                                                        <Blocks size={11} /> {t('checkpoint.blockCount', { count: checkpoint.blockCount })}
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
                                                className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md border border-brand-200 bg-brand-50 px-3 text-[11px] font-bold text-[var(--accent)] transition-colors hover:bg-brand-100 disabled:cursor-not-allowed disabled:opacity-50 min-[520px]:w-auto dark:border-brand-800 dark:bg-brand-950/45 dark:text-brand-300 dark:hover:bg-brand-950/70"
                                                aria-label={t('checkpoint.restoreAria', { reason: reasonLabel(checkpoint.reason), time: formatTime(checkpoint.createdAt) })}
                                            >
                                                {restoring ? <Loader2 size={14} className="animate-spin" /> : <ArchiveRestore size={14} />}
                                                {restoring ? t('checkpoint.restoring') : t('checkpoint.restore')}
                                            </button>
                                            <button
                                                type="button"
                                                data-ck-role="delete-project-checkpoint"
                                                onClick={() => void remove(checkpoint)}
                                                disabled={hasActiveOperation}
                                                className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md border border-red-200 bg-red-50 px-3 text-[11px] font-bold text-red-700 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 min-[520px]:w-auto dark:border-red-900 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-950/65"
                                                aria-label={t('checkpoint.deleteAria', { reason: reasonLabel(checkpoint.reason), time: formatTime(checkpoint.createdAt) })}
                                            >
                                                {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                                                {deleting ? t('checkpoint.deleting') : t('checkpoint.delete')}
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
