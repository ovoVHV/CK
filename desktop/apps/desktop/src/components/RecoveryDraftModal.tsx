import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    AlertTriangle,
    ArchiveRestore,
    Blocks,
    Columns3,
    Eye,
    FilePlus2,
    Info,
    ShieldCheck,
    Trash2,
    X,
} from 'lucide-react';
import type {
    RecoveryDraft,
    RecoveryDraftMetadata,
    RecoveryDraftState,
} from '../services/recovery_drafts';
import {
    createRecoveryDraftChangeSummary,
} from '../services/recovery_drafts';
import { createRecoveryBlockComparison } from '../services/recovery_block_compare';
import { RecoveryBlocksComparison, RecoveryBlocksPreview } from './RecoveryBlocksPreview';

interface RecoveryDraftModalProps {
    candidate: RecoveryDraftMetadata;
    draft: RecoveryDraft;
    currentState: RecoveryDraftState;
    busy?: boolean;
    onKeepForLater: () => void;
    onDiscard: () => void;
    onRestoreAsNew: () => void;
    onRestoreCurrent: () => void;
}

type DetailMode = 'preview' | 'compare';

const shortHash = (value: string) => String(value || '').replace(/^sha256:/, '').slice(0, 12);
const signedDelta = (value: number): string => value > 0 ? `+${value}` : String(value);

export function RecoveryDraftModal({
    candidate,
    draft,
    currentState,
    busy = false,
    onKeepForLater,
    onDiscard,
    onRestoreAsNew,
    onRestoreCurrent,
}: RecoveryDraftModalProps) {
    const { t: translate, i18n } = useTranslation('recovery');
    const t = translate as unknown as (key: string, options?: Record<string, unknown>) => string;
    const [detailMode, setDetailMode] = useState<DetailMode>('compare');
    const summary = useMemo(
        () => createRecoveryDraftChangeSummary(currentState, draft),
        [currentState, draft],
    );
    const blockComparison = useMemo(
        () => createRecoveryBlockComparison(currentState.workspaceJson, draft.workspaceJson),
        [currentState.workspaceJson, draft.workspaceJson],
    );
    const summaryItems = useMemo(() => {
        const items: string[] = [];
        if (summary.workspaceChanged) {
            const delta = summary.draftBlockCount - summary.currentBlockCount;
            items.push(delta === 0
                ? t('draft.summaryItems.blocksModified', { count: summary.draftBlockCount })
                : t('draft.summaryItems.blockCount', {
                    current: summary.currentBlockCount,
                    draft: summary.draftBlockCount,
                    delta: signedDelta(delta),
                }));
        }
        if (summary.sourceChanged) {
            const delta = summary.draftSourceLineCount - summary.currentSourceLineCount;
            items.push(delta === 0
                ? t('draft.summaryItems.sourceModified', { count: summary.draftSourceLineCount })
                : t('draft.summaryItems.sourceCount', {
                    current: summary.currentSourceLineCount,
                    draft: summary.draftSourceLineCount,
                    delta: signedDelta(delta),
                }));
        }
        if (summary.boardChanged) items.push(t('draft.summaryItems.boardChanged', {
            current: currentState.board || t('draft.unspecified'),
            draft: draft.board || t('draft.unspecified'),
        }));
        if (summary.fqbnChanged) items.push(t('draft.summaryItems.fqbnChanged'));
        if (summary.optionsChanged) items.push(t('draft.summaryItems.optionsChanged'));
        if (items.length === 0) items.push(t('draft.summaryItems.serializedChanged'));
        return items;
    }, [currentState.board, draft.board, i18n.resolvedLanguage, summary, t]);
    const summaryDescription = [
        ...summaryItems.slice(0, 2),
        ...(summaryItems.length > 2 ? [t('draft.summaryItems.moreChanges', { count: summaryItems.length - 2 })] : []),
    ].join(i18n.resolvedLanguage === 'en-US' ? '; ' : '；');
    const draftTime = useMemo(() => {
        const value = new Date(candidate.createdAt);
        if (Number.isNaN(value.getTime())) return candidate.createdAt;
        return new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language, {
            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        }).format(value);
    }, [candidate.createdAt, i18n.language, i18n.resolvedLanguage]);

    return (
        <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-[2px]" data-ck-role="recovery-draft-backdrop">
            <section
                role="dialog"
                aria-modal="true"
                aria-labelledby="ck-recovery-draft-title"
                className="flex max-h-[94vh] w-full max-w-7xl flex-col overflow-hidden rounded-2xl border border-amber-200 bg-white shadow-2xl dark:border-amber-900/70 dark:bg-slate-900"
                data-ck-role="recovery-draft-dialog"
            >
                <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 px-6 py-5 dark:border-slate-800">
                    <div className="flex min-w-0 items-start gap-3">
                        <div className="mt-0.5 rounded-xl bg-amber-100 p-2.5 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
                            <ArchiveRestore size={22} />
                        </div>
                        <div className="min-w-0">
                            <h2 id="ck-recovery-draft-title" className="text-lg font-bold text-slate-900 dark:text-slate-100">{t('draft.title')}</h2>
                            <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
                                {t('draft.description')}
                            </p>
                        </div>
                    </div>
                    <button type="button" onClick={onKeepForLater} disabled={busy} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50 dark:hover:bg-slate-800" aria-label={t('draft.closeAria')}>
                        <X size={18} />
                    </button>
                </header>

                <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 sm:col-span-2 dark:border-slate-700 dark:bg-slate-950/60">
                            <div className="text-xs font-semibold text-slate-500">{t('draft.project')}</div>
                            <div className="mt-1 truncate text-sm font-bold text-slate-800 dark:text-slate-100">{candidate.projectName || t('draft.unnamedProject')}</div>
                            <div className="mt-1 truncate text-xs text-slate-500" title={candidate.projectPath}>{candidate.projectPath}</div>
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-950/60">
                            <div className="text-xs font-semibold text-slate-500">{t('draft.createdAt')}</div>
                            <div className="mt-1 text-sm font-bold text-slate-800 dark:text-slate-100">{draftTime}</div>
                            <div className="mt-1 text-xs text-slate-500">{t('draft.fingerprint', { hash: shortHash(candidate.fullStateHash) })}</div>
                        </div>
                    </div>

                    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/60 dark:bg-amber-950/25">
                        <div className="text-xs font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300">{t('draft.summary')}</div>
                        <p className="mt-1 text-sm font-bold text-amber-950 dark:text-amber-100">{summaryDescription}</p>
                        <ul className="mt-2 grid gap-x-5 gap-y-1 text-sm leading-6 text-amber-900 sm:grid-cols-2 dark:text-amber-200">
                            {summaryItems.map(item => <li key={item}>• {item}</li>)}
                        </ul>
                    </div>

                    <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label={t('draft.viewModeAria')}>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={detailMode === 'compare'}
                            onClick={() => setDetailMode('compare')}
                            className={`inline-flex h-10 items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition-colors ${detailMode === 'compare' ? 'border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-950/40 dark:text-brand-200' : 'border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800'}`}
                        >
                            <Columns3 size={16} /> {t('draft.blockCompare')}
                        </button>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={detailMode === 'preview'}
                            onClick={() => setDetailMode('preview')}
                            className={`inline-flex h-10 items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition-colors ${detailMode === 'preview' ? 'border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-950/40 dark:text-brand-200' : 'border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800'}`}
                        >
                            <Eye size={16} /> {t('draft.previewOnly')}
                        </button>
                    </div>

                    {detailMode === 'preview' && (
                        <section className="mt-3" aria-label={t('draft.previewAria')}>
                            <RecoveryBlocksPreview
                                title={t('draft.previewTitle')}
                                caption={`${draft.board || t('draft.boardUnspecified')} · ${draft.fqbn || t('draft.targetUnspecified')}`}
                                workspaceJson={draft.workspaceJson}
                                changeKinds={blockComparison.draftKinds}
                                accent="draft"
                            />
                        </section>
                    )}

                    {detailMode === 'compare' && (
                        <section className="mt-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-950/30" aria-label={t('draft.compareAria')}>
                            {blockComparison.parseError ? (
                                <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                                    <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                                    <span>{t('draft.compareParseError', { error: blockComparison.parseError })}</span>
                                </div>
                            ) : (
                                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
                                    <Blocks size={17} className="text-brand-600 dark:text-brand-300" />
                                    {t('draft.blockCountChange', { current: blockComparison.currentBlockCount, draft: blockComparison.draftBlockCount })}
                                </div>
                            )}
                            <RecoveryBlocksComparison
                                currentWorkspaceJson={currentState.workspaceJson}
                                draftWorkspaceJson={draft.workspaceJson}
                                comparison={blockComparison}
                            />
                        </section>
                    )}

                    <details className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm dark:border-slate-700 dark:bg-slate-950/50">
                        <summary className="flex cursor-pointer list-none items-center gap-2 font-semibold text-slate-700 dark:text-slate-200">
                            <Info size={16} /> {t('draft.technicalInfo')}
                        </summary>
                        <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
                            <div><div className="text-slate-500">{t('draft.board')}</div><div className={summary.boardChanged ? 'mt-1 font-bold text-amber-700 dark:text-amber-300' : 'mt-1 font-semibold'}>{currentState.board || t('draft.unspecified')} → {draft.board || t('draft.unspecified')}</div></div>
                            <div><div className="text-slate-500">{t('draft.compileTarget')}</div><div className={summary.fqbnChanged ? 'mt-1 break-all font-bold text-amber-700 dark:text-amber-300' : 'mt-1 break-all font-semibold'}>{draft.fqbn || t('draft.unspecified')}</div></div>
                            <div><div className="text-slate-500">{t('draft.sourceSize')}</div><div className="mt-1 font-semibold">{t('draft.lineCount', { current: summary.currentSourceLineCount, draft: summary.draftSourceLineCount })}</div></div>
                            <div><div className="text-slate-500">{t('draft.boardOptions')}</div><div className={summary.optionsChanged ? 'mt-1 font-bold text-amber-700 dark:text-amber-300' : 'mt-1 font-semibold'}>{summary.optionsChanged ? t('draft.changed') : t('draft.unchanged')}</div></div>
                        </div>
                    </details>

                    <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-sm leading-6 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                        <AlertTriangle size={17} className="mt-1 shrink-0" />
                        <span>{t('draft.safetyNote')}</span>
                    </div>
                </div>

                <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-6 py-4 dark:border-slate-800 dark:bg-slate-950/50">
                    <button type="button" onClick={onDiscard} disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-lg border border-red-200 px-3 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40">
                        <Trash2 size={15} /> {t('draft.discard')}
                    </button>
                    <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={onKeepForLater} disabled={busy} className="inline-flex h-10 items-center rounded-lg px-3 text-sm font-semibold text-slate-600 hover:bg-slate-200 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-800">
                            {t('draft.keepForLater')}
                        </button>
                        <button type="button" onClick={onRestoreAsNew} disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">
                            <FilePlus2 size={15} /> {t('draft.restoreAs')}
                        </button>
                        <button type="button" onClick={onRestoreCurrent} disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-lg bg-amber-600 px-4 text-sm font-bold text-white hover:bg-amber-700 disabled:opacity-50 dark:bg-amber-500 dark:text-slate-950 dark:hover:bg-amber-400">
                            <ShieldCheck size={15} /> {busy ? t('draft.restoring') : t('draft.overwrite')}
                        </button>
                    </div>
                </footer>
            </section>
        </div>
    );
}
