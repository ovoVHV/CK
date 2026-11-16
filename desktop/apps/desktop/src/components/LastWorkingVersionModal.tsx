import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Activity,
    ArchiveRestore,
    Boxes,
    CheckCircle2,
    CircuitBoard,
    Code2,
    GitCompareArrows,
    HardDrive,
    Loader2,
    RefreshCw,
    RotateCcw,
    ShieldCheck,
    Trash2,
    Upload,
    X,
} from 'lucide-react';
import { useDialog } from '../contexts/DialogContext';
import { useTranslation } from 'react-i18next';
import {
    compareWithLastWorkingVersion,
    deleteLastWorkingVersion,
    formatLastWorkingBytes,
    formatLastWorkingTime,
    getLastWorkingVersion,
    type CurrentWorkingVersionState,
    type LastWorkingDiffGroup,
    type LastWorkingDiffReport,
    type LastWorkingVersion,
} from '../services/last_working_version';

interface LastWorkingVersionModalProps {
    isOpen: boolean;
    projectPath: string;
    activePort: string | null;
    isBusy: boolean;
    getCurrentState: () => CurrentWorkingVersionState;
    onClose: () => void;
    onRestoreProject: (version: LastWorkingVersion) => Promise<void>;
    onRestoreFirmware: (version: LastWorkingVersion) => Promise<void>;
    onCompleteRestore: (version: LastWorkingVersion) => Promise<void>;
    onRebuildLocked: (version: LastWorkingVersion) => Promise<void>;
}

const GROUP_ORDER: LastWorkingDiffGroup[] = [
    'workspace',
    'environment',
    'dependencies',
    'device',
    'resources',
];

const severityClass = {
    info: 'border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/55',
    warning: 'border-amber-200 bg-amber-50/75 dark:border-amber-900 dark:bg-amber-950/25',
    important: 'border-rose-200 bg-rose-50/75 dark:border-rose-900 dark:bg-rose-950/25',
};

export function LastWorkingVersionModal({
    isOpen,
    projectPath,
    activePort,
    isBusy,
    getCurrentState,
    onClose,
    onRestoreProject,
    onRestoreFirmware,
    onCompleteRestore,
    onRebuildLocked,
}: LastWorkingVersionModalProps) {
    const { t: translate } = useTranslation('recovery');
    const t = translate as unknown as (key: string, options?: Record<string, unknown>) => string;
    const dialog = useDialog();
    const [version, setVersion] = useState<LastWorkingVersion | null>(null);
    const [diff, setDiff] = useState<LastWorkingDiffReport | null>(null);
    const [loading, setLoading] = useState(false);
    const [comparing, setComparing] = useState(false);
    const [action, setAction] = useState<'project' | 'firmware' | 'complete' | 'rebuild' | 'delete' | null>(null);
    const [error, setError] = useState<string | null>(null);
    const diffGroupLabels = useMemo(() => Object.fromEntries(
        GROUP_ORDER.map(group => [group, t(`lastWorking.groups.${group}`)]),
    ) as Record<LastWorkingDiffGroup, string>, [t]);

    const compare = useCallback(async (target: LastWorkingVersion) => {
        setComparing(true);
        setError(null);
        try {
            setDiff(await compareWithLastWorkingVersion(target, getCurrentState()));
        } catch (cause) {
            setDiff(null);
            setError(t('lastWorking.errors.compare', { cause: String(cause) }));
        } finally {
            setComparing(false);
        }
    }, [getCurrentState, t]);

    const refresh = useCallback(async () => {
        if (!projectPath) return;
        setLoading(true);
        setError(null);
        try {
            const loaded = await getLastWorkingVersion(projectPath);
            setVersion(loaded);
            setDiff(null);
            if (loaded) await compare(loaded);
        } catch (cause) {
            setVersion(null);
            setDiff(null);
            setError(t('lastWorking.errors.read', { cause: String(cause) }));
        } finally {
            setLoading(false);
        }
    }, [compare, projectPath, t]);

    useEffect(() => {
        if (isOpen) void refresh();
    }, [isOpen, refresh]);

    useEffect(() => {
        if (!isOpen) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !action) onClose();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [action, isOpen, onClose]);

    const diffGroups = useMemo(() => GROUP_ORDER.map(group => ({
        group,
        items: diff?.items.filter(item => item.group === group) || [],
    })).filter(group => group.items.length > 0), [diff]);

    if (!isOpen) return null;

    const runAction = async (kind: 'project' | 'firmware' | 'complete' | 'rebuild') => {
        if (!version || action || isBusy) return;
        if ((kind === 'firmware' || kind === 'complete') && !activePort) {
            setError(t('lastWorking.errors.portRequired'));
            return;
        }
        const descriptions = {
            project: {
                title: t('lastWorking.confirm.projectTitle'),
                message: t('lastWorking.confirm.projectMessage'),
                label: t('lastWorking.confirm.projectAction'),
            },
            firmware: {
                title: t('lastWorking.confirm.firmwareTitle'),
                message: t('lastWorking.confirm.firmwareMessage', { port: activePort || '' }),
                label: t('lastWorking.confirm.firmwareAction'),
            },
            complete: {
                title: t('lastWorking.confirm.completeTitle'),
                message: t('lastWorking.confirm.completeMessage', { port: activePort || '' }),
                label: t('lastWorking.confirm.completeAction'),
            },
            rebuild: {
                title: t('lastWorking.confirm.rebuildTitle'),
                message: t('lastWorking.confirm.rebuildMessage'),
                label: t('lastWorking.confirm.rebuildAction'),
            },
        }[kind];
        const confirmed = await dialog.confirm({
            title: descriptions.title,
            message: descriptions.message,
            confirmLabel: descriptions.label,
            cancelLabel: t('lastWorking.confirm.cancel'),
            tone: 'warning',
        });
        if (!confirmed) return;
        setAction(kind);
        setError(null);
        try {
            if (kind === 'project') await onRestoreProject(version);
            else if (kind === 'firmware') await onRestoreFirmware(version);
            else if (kind === 'complete') await onCompleteRestore(version);
            else await onRebuildLocked(version);
            onClose();
        } catch (cause) {
            setError(t('lastWorking.errors.action', { action: descriptions.label, cause: String(cause) }));
        } finally {
            setAction(null);
        }
    };

    const burnedSegments = version?.firmware.artifacts.filter(item => item.flashAddress) || [];

    const deleteVersion = async () => {
        if (!version || action || isBusy || loading || comparing) return;
        const confirmed = await dialog.confirm({
            title: t('lastWorking.confirm.deleteTitle'),
            message: t('lastWorking.confirm.deleteMessage'),
            confirmLabel: t('lastWorking.confirm.deleteAction'),
            cancelLabel: t('lastWorking.confirm.cancel'),
            tone: 'danger',
        });
        if (!confirmed) return;

        setAction('delete');
        setError(null);
        try {
            await deleteLastWorkingVersion(projectPath);
            setVersion(null);
            setDiff(null);
            await refresh();
        } catch (cause) {
            setError(t('lastWorking.errors.delete', { cause: String(cause) }));
        } finally {
            setAction(null);
        }
    };

    return (
        <div
            className="fixed inset-0 z-[530] flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-[2px] dark:bg-black/70"
            role="dialog"
            aria-modal="true"
            aria-labelledby="last-working-version-title"
            onMouseDown={event => {
                if (event.target === event.currentTarget && !action) onClose();
            }}
        >
            <section className="flex max-h-[min(820px,calc(100vh-32px))] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-[#f8fafc] shadow-2xl dark:border-slate-700 dark:bg-slate-950">
                <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 bg-white px-5 py-4 dark:border-slate-700 dark:bg-slate-900">
                    <div className="flex min-w-0 items-start gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 dark:bg-emerald-950/55 dark:text-emerald-300">
                            <ShieldCheck size={21} />
                        </span>
                        <div className="min-w-0">
                            <h2 id="last-working-version-title" className="text-sm font-extrabold text-slate-900 dark:text-slate-100">
                                {t('lastWorking.title')}
                            </h2>
                            <p className="mt-1 text-[11px] leading-4 text-slate-500 dark:text-slate-400">
                                {t('lastWorking.description')}
                            </p>
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                        {version && (
                            <button
                                type="button"
                                onClick={() => void deleteVersion()}
                                disabled={loading || comparing || isBusy || Boolean(action)}
                                className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold text-red-600 hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-300 dark:hover:bg-red-950/40 dark:hover:text-red-200"
                                title={t('lastWorking.deleteTooltip')}
                            >
                                {action === 'delete' ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                                {action === 'delete' ? t('lastWorking.deleting') : t('lastWorking.delete')}
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => void refresh()}
                            disabled={loading || Boolean(action)}
                            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold text-slate-500 hover:bg-slate-100 hover:text-emerald-700 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-emerald-300"
                        >
                            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> {t('lastWorking.refresh')}
                        </button>
                        <button type="button" onClick={onClose} disabled={Boolean(action)} className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50 dark:hover:bg-slate-800 dark:hover:text-slate-200" aria-label={t('lastWorking.closeAria')}>
                            <X size={16} />
                        </button>
                    </div>
                </header>

                <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
                    {loading && !version && (
                        <div className="flex min-h-56 items-center justify-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                            <Loader2 size={17} className="animate-spin text-emerald-600" /> {t('lastWorking.loading')}
                        </div>
                    )}

                    {!loading && !version && !error && (
                        <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-5 text-center dark:border-slate-700 dark:bg-slate-900">
                            <ArchiveRestore size={31} className="text-slate-300 dark:text-slate-600" />
                            <p className="mt-3 text-sm font-bold text-slate-700 dark:text-slate-200">{t('lastWorking.emptyTitle')}</p>
                            <p className="mt-1 max-w-md text-[11px] leading-5 text-slate-400 dark:text-slate-500">
                                {t('lastWorking.emptyDescription')}
                            </p>
                        </div>
                    )}

                    {version && (
                        <div className="grid gap-4">
                            <section className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-4">
                                <InfoCard icon={CheckCircle2} title={t('lastWorking.verifiedAt')} value={formatLastWorkingTime(version.verifiedAt)} detail={version.project.name} />
                                <InfoCard icon={CircuitBoard} title={t('lastWorking.boardAndCore')} value={`${version.environment.coreId}@${version.environment.coreVersion || t('lastWorking.unrecognized')}`} detail={version.environment.fqbn} />
                                <InfoCard icon={HardDrive} title={t('lastWorking.deviceEvidence')} value={`${version.device.chip || t('lastWorking.chipNotReported')} · Flash ${formatLastWorkingBytes(version.device.flashBytes)}`} detail={`PSRAM ${formatLastWorkingBytes(version.device.psramBytes)}`} />
                                <InfoCard icon={Boxes} title={t('lastWorking.firmware')} value={t('lastWorking.segments', { count: burnedSegments.length })} detail={`${version.environment.optimization} · ${version.environment.compileProfile}`} />
                            </section>

                            <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div>
                                        <h3 className="flex items-center gap-2 text-xs font-extrabold text-slate-800 dark:text-slate-100">
                                            <GitCompareArrows size={15} className="text-violet-600 dark:text-violet-300" /> {t('lastWorking.whyItWorked')}
                                        </h3>
                                        <p className="mt-1 text-[10px] text-slate-400 dark:text-slate-500">{t('lastWorking.compareDescription')}</p>
                                    </div>
                                    <button type="button" onClick={() => void compare(version)} disabled={comparing || Boolean(action)} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 px-2.5 text-[10px] font-bold text-slate-600 hover:border-violet-200 hover:bg-violet-50 hover:text-violet-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-violet-950/35 dark:hover:text-violet-300">
                                        <GitCompareArrows size={13} /> {comparing ? t('lastWorking.comparing') : t('lastWorking.compareCurrent')}
                                    </button>
                                </div>

                                {comparing && !diff && <div className="mt-4 flex items-center gap-2 text-[11px] text-slate-500"><Loader2 size={14} className="animate-spin" /> {t('lastWorking.generatingDiff')}</div>}
                                {diff && (
                                    <div className="mt-4 grid gap-3">
                                        <div className={`rounded-lg border px-3 py-2 text-[11px] font-semibold ${diff.identical ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300' : 'border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-900 dark:bg-violet-950/30 dark:text-violet-300'}`}>
                                            {t(`lastWorking.diff.summary.${diff.summaryCode}`, diff.summaryParams)}
                                        </div>
                                        {diffGroups.map(group => (
                                            <div key={group.group}>
                                                <div className="mb-1.5 text-[10px] font-extrabold uppercase tracking-wider text-slate-400 dark:text-slate-500">{diffGroupLabels[group.group]}</div>
                                                <div className="grid gap-1.5">
                                                    {group.items.map((item, index) => (
                                                        <div key={`${item.code}-${index}`} className={`rounded-lg border px-3 py-2 ${severityClass[item.severity]}`}>
                                                            <div className="text-[11px] font-bold text-slate-800 dark:text-slate-100">{t(`lastWorking.diff.items.${item.code}`, item.params)}</div>
                                                            <div className="mt-1 grid gap-1 text-[10px] text-slate-500 dark:text-slate-400 sm:grid-cols-[1fr_auto_1fr]">
                                                                <span className="break-all">{t('lastWorking.previous', { value: item.before })}</span>
                                                                <span className="hidden text-slate-300 sm:inline dark:text-slate-600">→</span>
                                                                <span className="break-all">{t('lastWorking.current', { value: item.after })}</span>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </section>

                            <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
                                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                                    <ActionButton icon={Code2} title={t('lastWorking.actions.restoreProject')} description={t('lastWorking.actions.restoreProjectDescription')} busy={action === 'project'} disabled={isBusy || Boolean(action)} onClick={() => void runAction('project')} />
                                    <ActionButton icon={ShieldCheck} title={t('lastWorking.actions.rebuild')} description={t('lastWorking.actions.rebuildDescription')} busy={action === 'rebuild'} disabled={isBusy || Boolean(action)} onClick={() => void runAction('rebuild')} />
                                    <ActionButton icon={Upload} title={t('lastWorking.actions.restoreFirmware')} description={activePort ? t('lastWorking.actions.restoreFirmwareDescription', { port: activePort }) : t('lastWorking.actions.selectPort')} busy={action === 'firmware'} disabled={isBusy || Boolean(action) || !activePort} onClick={() => void runAction('firmware')} />
                                    <ActionButton icon={RotateCcw} title={t('lastWorking.actions.completeRestore')} description={t('lastWorking.actions.completeRestoreDescription')} busy={action === 'complete'} disabled={isBusy || Boolean(action) || !activePort} onClick={() => void runAction('complete')} emphasized />
                                </div>
                                <div className="mt-3 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-[10px] leading-4 text-slate-500 dark:bg-slate-800/55 dark:text-slate-400">
                                    <Activity size={13} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-300" />
                                    <span>{t('lastWorking.safetyNote')}</span>
                                </div>
                            </section>
                        </div>
                    )}

                    {error && (
                        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] leading-4 text-red-700 dark:border-red-900 dark:bg-red-950/35 dark:text-red-300">
                            {error}
                        </div>
                    )}
                </div>
            </section>
        </div>
    );
}

function InfoCard({ icon: Icon, title, value, detail }: {
    icon: typeof CircuitBoard;
    title: string;
    value: string;
    detail: string;
}) {
    return (
        <article className="min-w-0 rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-400 dark:text-slate-500"><Icon size={13} /> {title}</div>
            <div className="mt-2 select-text break-words text-xs font-extrabold text-slate-800 dark:text-slate-100" title={value}>{value}</div>
            <div className="mt-1 select-text break-all whitespace-normal font-mono text-[9px] leading-4 text-slate-400 dark:text-slate-500" title={detail}>{detail}</div>
        </article>
    );
}

function ActionButton({ icon: Icon, title, description, busy, disabled, onClick, emphasized = false }: {
    icon: typeof Upload;
    title: string;
    description: string;
    busy: boolean;
    disabled: boolean;
    onClick: () => void;
    emphasized?: boolean;
}) {
    const { t: translate } = useTranslation('recovery');
    const t = translate as unknown as (key: string) => string;
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={`flex min-h-[78px] items-start gap-3 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${emphasized ? 'border-emerald-300 bg-emerald-50 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/35 dark:hover:bg-emerald-950/55' : 'border-slate-200 bg-white hover:border-emerald-200 hover:bg-emerald-50/55 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-emerald-900 dark:hover:bg-emerald-950/25'}`}
        >
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-emerald-700 shadow-sm dark:bg-slate-800 dark:text-emerald-300">
                {busy ? <Loader2 size={16} className="animate-spin" /> : <Icon size={16} />}
            </span>
            <span className="min-w-0">
                <span className="block text-xs font-extrabold text-slate-800 dark:text-slate-100">{busy ? t('lastWorking.actions.processing') : title}</span>
                <span className="mt-1 block text-[10px] leading-4 text-slate-500 dark:text-slate-400">{description}</span>
            </span>
        </button>
    );
}

export default LastWorkingVersionModal;
