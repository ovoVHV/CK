import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    AlertTriangle,
    Blocks,
    Maximize2,
    Minimize2,
    Move,
    Puzzle,
    RotateCcw,
    ScanSearch,
    ZoomIn,
    ZoomOut,
} from 'lucide-react';
import * as Blockly from 'blockly';
import { getBlocklyVisualTheme } from '../theme/blockly_visual_themes';
import { applyBlocklyVisualSkin } from '../services/blockly_visual_skin';
import {
    blocklyRendererForVisualStyle,
    readBlocklyVisualStyle,
} from '../services/blockly_visual_style';
import {
    createRecoveryPreviewWorkspace,
    type RecoveryBlockChangeKind,
    type RecoveryBlockComparison,
} from '../services/recovery_block_compare';
import {
    disposeBlocklyPreviewWorkspaceLifecycle,
    prepareBlocklyWidgetDivForInjection,
} from '../services/blockly_workspace_lifecycle';
import './RecoveryBlocksPreview.css';

interface RecoveryBlocksPreviewProps {
    title: string;
    caption: string;
    workspaceJson: string;
    changeKinds?: Readonly<Record<string, RecoveryBlockChangeKind>>;
    accent: 'current' | 'draft';
    expanded?: boolean;
}

interface RecoveryBlocksComparisonProps {
    currentWorkspaceJson: string;
    draftWorkspaceJson: string;
    comparison: RecoveryBlockComparison;
}

type RenderState = 'loading' | 'ready' | 'empty' | 'error';

// Blockly's registry is an object, so inherited names such as `toString`
// must not be mistaken for installed block definitions. Treating one as
// known would make this disposable preview fail instead of showing the
// missing-third-party-block warning.
const knownBlockType = (type: string): boolean => (
    Object.prototype.hasOwnProperty.call(Blockly.Blocks, type)
    && Boolean((Blockly.Blocks as Record<string, unknown>)[type])
);

const changeClass = (kind: RecoveryBlockChangeKind | undefined): string | null => {
    if (!kind || kind === 'same') return null;
    return `ck-recovery-block-${kind}`;
};

export function RecoveryBlocksPreview({
    title,
    caption,
    workspaceJson,
    changeKinds = {},
    accent,
    expanded = false,
}: RecoveryBlocksPreviewProps) {
    const { t: translate } = useTranslation('recovery');
    const t = translate as unknown as (key: string, options?: Record<string, unknown>) => string;
    const hostRef = useRef<HTMLDivElement>(null);
    const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
    const focusTimerRef = useRef<number | null>(null);
    const [renderState, setRenderState] = useState<RenderState>('loading');
    const [renderError, setRenderError] = useState('');
    const [changeCursor, setChangeCursor] = useState(-1);
    const preview = useMemo(
        () => createRecoveryPreviewWorkspace(workspaceJson, knownBlockType),
        [workspaceJson],
    );
    const visualStyle = useMemo(() => readBlocklyVisualStyle(
        typeof window === 'undefined' ? null : window.localStorage,
    ), []);
    const colourMode = typeof document !== 'undefined'
        && document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    const changedBlockIds = useMemo(() => (
        Object.entries(changeKinds)
            .filter(([, kind]) => kind !== 'same')
            .map(([id]) => id)
    ), [changeKinds]);

    const fitWorkspace = useCallback(() => {
        const workspace = workspaceRef.current;
        if (!workspace) return;
        try {
            Blockly.svgResize(workspace);
            if (workspace.getAllBlocks(false).length > 0) workspace.zoomToFit();
        } catch {
            // Preview controls are best effort and never affect recovery data.
        }
    }, []);

    const zoomWorkspace = useCallback((direction: 1 | -1) => {
        try {
            workspaceRef.current?.zoomCenter(direction);
        } catch {
            // A disposed preview can receive the final click during modal close.
        }
    }, []);

    const focusNextChange = useCallback(() => {
        const workspace = workspaceRef.current;
        if (!workspace || changedBlockIds.length === 0) return;
        const nextCursor = (changeCursor + 1) % changedBlockIds.length;
        const blockId = changedBlockIds[nextCursor];
        const block = workspace.getBlockById(blockId);
        if (!block) return;
        setChangeCursor(nextCursor);
        workspace.centerOnBlock(blockId, true);
        const root = block.getSvgRoot();
        root?.classList.add('ck-recovery-block-focused');
        if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
        focusTimerRef.current = window.setTimeout(() => {
            focusTimerRef.current = null;
            root?.classList.remove('ck-recovery-block-focused');
        }, 1400);
    }, [changeCursor, changedBlockIds]);

    useEffect(() => {
        const host = hostRef.current;
        if (!host || !preview.state) {
            setRenderState('error');
            setRenderError(preview.parseError || '');
            return;
        }

        const mainWorkspace = Blockly.getMainWorkspace() as Blockly.WorkspaceSvg | null;
        let workspace: Blockly.WorkspaceSvg | null = null;
        let cancelled = false;
        let resizeObserver: ResizeObserver | null = null;
        let resizeTimer: number | null = null;
        try {
            setRenderState('loading');
            setRenderError('');
            prepareBlocklyWidgetDivForInjection(Blockly.WidgetDiv);
            workspace = Blockly.inject(host, {
                renderer: blocklyRendererForVisualStyle(visualStyle),
                readOnly: true,
                media: '/blockly/media/',
                theme: getBlocklyVisualTheme(visualStyle, colourMode),
                scrollbars: true,
                sounds: false,
                zoom: {
                    controls: false,
                    wheel: true,
                    pinch: true,
                    startScale: 0.8,
                    maxScale: 1.8,
                    minScale: 0.08,
                    scaleSpeed: 1.16,
                },
                move: {
                    scrollbars: true,
                    drag: true,
                    wheel: false,
                },
            });
            workspaceRef.current = workspace;

            const eventsWereEnabled = Blockly.Events.isEnabled();
            try {
                if (eventsWereEnabled) Blockly.Events.disable();
                Blockly.serialization.workspaces.load(preview.state, workspace);
            } finally {
                if (eventsWereEnabled) Blockly.Events.enable();
            }

            workspace.getAllBlocks(false).forEach((block) => {
                const cssClass = changeClass(changeKinds[block.id]);
                const root = block.getSvgRoot();
                if (cssClass && root) root.classList.add(cssClass);
            });
            applyBlocklyVisualSkin(workspace, visualStyle);

            const resize = () => {
                if (cancelled || !workspace) return;
                try {
                    Blockly.svgResize(workspace);
                } catch {
                    // The preview is explanatory only; a resize race must not
                    // affect the recovery decision or the editor workspace.
                }
            };
            const initialFit = () => {
                resize();
                if (!cancelled && workspace?.getAllBlocks(false).length) workspace.zoomToFit();
            };
            resizeTimer = window.setTimeout(initialFit, 0);
            void Blockly.renderManagement.finishQueuedRenders().then(() => {
                if (cancelled) return;
                initialFit();
                setRenderState(preview.blockCount > 0 ? 'ready' : 'empty');
            }).catch((error) => {
                if (cancelled) return;
                setRenderState('error');
                setRenderError(error instanceof Error ? error.message : String(error));
            });
            if (typeof ResizeObserver !== 'undefined') {
                // Resize without zoom-to-fit: otherwise opening fullscreen or
                // resizing the dialog would erase the user's pan/zoom position.
                resizeObserver = new ResizeObserver(resize);
                resizeObserver.observe(host);
            }
        } catch (error) {
            setRenderState('error');
            setRenderError(error instanceof Error ? error.message : String(error));
        } finally {
            if (mainWorkspace?.getInjectionDiv?.()?.isConnected) {
                Blockly.common.setMainWorkspace(mainWorkspace);
            }
        }

        return () => {
            cancelled = true;
            resizeObserver?.disconnect();
            if (resizeTimer !== null) window.clearTimeout(resizeTimer);
            if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
            focusTimerRef.current = null;
            workspaceRef.current = null;
            if (!workspace) return;
            try {
                disposeBlocklyPreviewWorkspaceLifecycle(workspace, mainWorkspace, {
                    getMainWorkspace: () => Blockly.getMainWorkspace(),
                    setMainWorkspace: next => (
                        Blockly.common.setMainWorkspace as unknown as (value: unknown | null) => void
                    )(next),
                });
            } catch {
                // A disposable preview must never interfere with the editor.
            }
        };
    }, [changeKinds, colourMode, preview, visualStyle]);

    const accentClasses = accent === 'draft'
        ? 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/60 dark:bg-emerald-950/15'
        : 'border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-950/55';

    return (
        <article className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border ${expanded ? 'h-full' : ''} ${accentClasses}`} data-ck-role={`recovery-block-preview-${accent}`}>
            <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200/80 px-4 py-3 dark:border-slate-700/80">
                <div className="min-w-0">
                    <h4 className="text-sm font-bold text-slate-900 dark:text-slate-100">{title}</h4>
                    <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">{caption}</p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                    <span className="mr-1 shrink-0 rounded-full bg-white/90 px-2.5 py-1 text-xs font-bold text-slate-700 shadow-sm dark:bg-slate-800 dark:text-slate-200">
                        {t('compare.blockCount', { count: preview.blockCount })}
                    </span>
                    <button type="button" className="ck-recovery-preview-control" onClick={() => zoomWorkspace(-1)} disabled={renderState !== 'ready'} title={t('compare.zoomOut')} aria-label={`${title}: ${t('compare.zoomOut')}`}><ZoomOut size={15} /></button>
                    <button type="button" className="ck-recovery-preview-control" onClick={() => zoomWorkspace(1)} disabled={renderState !== 'ready'} title={t('compare.zoomIn')} aria-label={`${title}: ${t('compare.zoomIn')}`}><ZoomIn size={15} /></button>
                    <button type="button" className="ck-recovery-preview-control" onClick={fitWorkspace} disabled={renderState !== 'ready'} title={t('compare.fit')} aria-label={`${title}: ${t('compare.fit')}`}><RotateCcw size={15} /></button>
                    <button
                        type="button"
                        className="ck-recovery-preview-control gap-1 px-2"
                        onClick={focusNextChange}
                        disabled={renderState !== 'ready' || changedBlockIds.length === 0}
                        title={t('compare.locateNext')}
                    >
                        <ScanSearch size={15} />
                        <span className="hidden 2xl:inline">{changedBlockIds.length > 0
                            ? t('compare.diffPosition', { current: Math.max(changeCursor + 1, 0), total: changedBlockIds.length })
                            : t('compare.noDiff')}</span>
                    </button>
                </div>
            </header>
            <div
                className={`ck-workspace-shell ck-recovery-block-preview relative min-h-0 overflow-hidden bg-white dark:bg-slate-900 ${expanded ? 'flex-1' : 'h-[clamp(26rem,55vh,44rem)]'}`}
                data-ck-blockly-skin={visualStyle}
            >
                <div ref={hostRef} className="absolute inset-0" aria-label={t('compare.readOnlyAria', { title })} />
                {renderState === 'ready' && (
                    <div className="pointer-events-none absolute bottom-2 left-2 z-10 inline-flex items-center gap-1.5 rounded-lg bg-white/85 px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 shadow-sm backdrop-blur dark:bg-slate-950/80 dark:text-slate-300">
                        <Move size={13} /> {t('compare.dragHint')}
                    </div>
                )}
                {renderState === 'loading' && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/70 text-sm font-semibold text-slate-500 dark:bg-slate-900/70 dark:text-slate-300">
                        {t('compare.rendering')}
                    </div>
                )}
                {renderState === 'empty' && (
                    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-slate-500 dark:text-slate-400">
                        <Blocks size={28} />
                        <span className="text-sm font-semibold">{t('compare.empty')}</span>
                    </div>
                )}
                {renderState === 'error' && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-amber-700 dark:text-amber-300">
                        <AlertTriangle size={28} />
                        <span className="text-sm font-bold">{t('compare.renderFailed')}</span>
                        <span className="max-w-sm text-xs leading-5 text-slate-500 dark:text-slate-400">{renderError || t('compare.invalidFallback')}</span>
                    </div>
                )}
            </div>
            {preview.unknownBlockCount > 0 && (
                <div className="flex items-start gap-2 border-t border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                    <Puzzle size={15} className="mt-0.5 shrink-0" />
                    <span>{t('compare.unknownBlocks', {
                        count: preview.unknownBlockCount,
                        types: preview.unknownTypeNames.join(', '),
                    })}</span>
                </div>
            )}
        </article>
    );
}

export function RecoveryBlocksComparison({
    currentWorkspaceJson,
    draftWorkspaceJson,
    comparison,
}: RecoveryBlocksComparisonProps) {
    const { t: translate } = useTranslation('recovery');
    const t = translate as unknown as (key: string, options?: Record<string, unknown>) => string;
    const [expanded, setExpanded] = useState(false);
    useEffect(() => {
        if (!expanded) return;
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setExpanded(false);
        };
        window.addEventListener('keydown', closeOnEscape);
        return () => window.removeEventListener('keydown', closeOnEscape);
    }, [expanded]);

    return (
        <div
            className={expanded ? 'fixed inset-2 z-[10050] flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-300 bg-white p-4 shadow-2xl dark:border-slate-700 dark:bg-slate-950' : ''}
            data-ck-role="recovery-blocks-comparison"
            data-expanded={expanded ? 'true' : 'false'}
        >
            <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-3 text-xs font-semibold">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200">+ {t('compare.added', { count: comparison.addedCount })}</span>
                    <span className="rounded-full bg-red-100 px-2.5 py-1 text-red-800 dark:bg-red-950/50 dark:text-red-200">− {t('compare.removed', { count: comparison.removedCount })}</span>
                    <span className="rounded-full bg-amber-100 px-2.5 py-1 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">● {t('compare.changed', { count: comparison.changedCount })}</span>
                    <span className="text-slate-500 dark:text-slate-400">{t('compare.independentHint')}</span>
                </div>
                <button
                    type="button"
                    className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-xs font-bold text-slate-700 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                    onClick={() => setExpanded(value => !value)}
                    aria-expanded={expanded}
                >
                    {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                    {expanded ? t('compare.exitFullscreen') : t('compare.fullscreen')}
                </button>
            </div>
            <div className={`grid gap-3 ${expanded ? 'min-h-0 flex-1 grid-cols-2' : 'lg:grid-cols-2'}`}>
                <RecoveryBlocksPreview
                    title={t('compare.currentTitle')}
                    caption={t('compare.currentCaption')}
                    workspaceJson={currentWorkspaceJson}
                    changeKinds={comparison.currentKinds}
                    accent="current"
                    expanded={expanded}
                />
                <RecoveryBlocksPreview
                    title={t('compare.draftTitle')}
                    caption={t('compare.draftCaption')}
                    workspaceJson={draftWorkspaceJson}
                    changeKinds={comparison.draftKinds}
                    accent="draft"
                    expanded={expanded}
                />
            </div>
        </div>
    );
}
