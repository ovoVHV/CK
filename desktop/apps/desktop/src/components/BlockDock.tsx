import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Command, History, Pin, PinOff, Plus, Search, X } from 'lucide-react';
import * as Blockly from 'blockly';
import type { BlockSearchEntry } from '../types/library';
import type { HardwareResourceInspectorView } from '../services/hardware_resource_inspector';
import { syncExtensionBlockVisualColour } from '../services/extension_loader';
import { applyBlocklyVisualSkin } from '../services/blockly_visual_skin';
import type { BlocklyRendererName, BlocklyVisualStyle } from '../services/blockly_visual_style';
import {
    disposeBlocklyPreviewWorkspaceLifecycle,
    prepareBlocklyWidgetDivForInjection,
} from '../services/blockly_workspace_lifecycle';
import {
    addBlockDockPin,
    addRecentBlockType,
    blockDockChecksOverlap,
    blockDockCategoryId,
    blockDockPinDisplayLabel,
    blockDockShapeCanConnect,
    blockDockSourceLabel,
    createBlockDockPin,
    readBlockDockPreferences,
    searchBlockDockEntries,
    writeBlockDockPreferences,
    type BlockDockPin,
    type BlockDockPreferences,
    type BlockDockConnectionShape,
} from '../services/block_dock';
import {
    getBlocklyBlockLabel,
    getBlocklyCategoryLabel,
    getEffectiveBlocklyLocale,
    getBlocklySourceLabel,
    translateBlocklyText,
    type BlocklyLocale,
} from '../services/blockly_locale';
import {
    BLOCK_LOCALE_PREFERENCE_CHANGED_EVENT,
    getLocalePreferences,
    normalizeUiLocale,
} from '../i18n';

type DockSource =
    | { kind: 'all' }
    | { kind: 'logic' }
    | { kind: 'recent' }
    | { kind: 'pin'; pin: BlockDockPin };

type TargetKind = 'value' | 'statement';

interface BlockConnectionTarget {
    id: string;
    blockId: string;
    connection: Blockly.Connection;
    kind: TargetKind;
    label: string;
    left: number;
    top: number;
    hasExistingStatement: boolean;
}

interface BlockTargetLauncher {
    left: number;
    top: number;
    menuLeft: number;
    menuTop: number;
}

interface BlockTargetMenuSnapshot {
    launcher: BlockTargetLauncher;
    targets: BlockConnectionTarget[];
}

interface BlockDockLayout {
    centerOffset: number;
    availableWidth: number;
}

interface BlockDockProps {
    resourceView?: HardwareResourceInspectorView | null;
    workspace: Blockly.WorkspaceSvg | null;
    renderer: BlocklyRendererName;
    theme: Blockly.Theme;
    visualStyle: BlocklyVisualStyle;
    disabled?: boolean;
    onNotice?: (message: string, type?: 'success' | 'error' | 'info') => void;
}

interface BlockPreviewSnapshot {
    markup: string;
}

const LOGIC_SOURCE: DockSource = { kind: 'logic' };
const RECENT_SOURCE: DockSource = { kind: 'recent' };
const ALL_SOURCE: DockSource = { kind: 'all' };

function sourceKey(source: DockSource): string {
    return source.kind === 'pin' ? source.pin.key : source.kind;
}

function sourceTitle(source: DockSource, catalog: readonly BlockSearchEntry[], locale: BlocklyLocale): string {
    if (source.kind === 'logic') return getBlocklySourceLabel('logic', locale);
    if (source.kind === 'recent') return getBlocklySourceLabel('recent', locale);
    if (source.kind === 'pin') return pinDisplayLabel(source.pin, catalog, locale);
    return getBlocklySourceLabel('all', locale);
}

function inputLabel(block: Blockly.Block, input: Blockly.Input, index: number, locale: BlocklyLocale): string {
    const text = input.fieldRow
        .map(field => {
            try { return field.getText(); } catch { return ''; }
        })
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    const name = String(input.name || '').toUpperCase();
    const localizedText = translateBlocklyText(text, locale);
    if (/^(?:IF|BOOL|CONDITION)/.test(name)) {
        const condition = locale === 'en-US' ? 'Condition' : '条件';
        return localizedText ? `${localizedText} · ${condition}` : condition;
    }
    if (input.connection?.type === Blockly.NEXT_STATEMENT) {
        return localizedText || (locale === 'en-US' ? 'Statement input' : '内部语句');
    }
    return localizedText || (locale === 'en-US' ? `Input ${index + 1}` : `输入 ${index + 1}`);
}

function entryDisplayName(entry: BlockSearchEntry, locale: BlocklyLocale): string {
    const catalogLabel = getBlocklyBlockLabel(entry.type, locale);
    if (catalogLabel !== entry.type) return catalogLabel;
    return translateBlocklyText(String(entry.display_name || entry.type).trim(), locale);
}

function entrySourceLabel(entry: BlockSearchEntry, locale: BlocklyLocale): string {
    const categoryId = blockDockCategoryId(entry);
    const categoryLabel = getBlocklyCategoryLabel(categoryId, locale);
    if (categoryLabel !== categoryId) return categoryLabel;
    return translateBlocklyText(blockDockSourceLabel(entry), locale);
}

function pinDisplayLabel(
    pin: BlockDockPin,
    catalog: readonly BlockSearchEntry[],
    locale: BlocklyLocale,
): string {
    if (pin.kind === 'category') {
        const categoryLabel = getBlocklyCategoryLabel(pin.value, locale);
        if (categoryLabel !== pin.value) return categoryLabel;
    }
    return translateBlocklyText(blockDockPinDisplayLabel(pin, catalog), locale);
}

function createBlockFromEntry(
    workspace: Blockly.WorkspaceSvg,
    entry: BlockSearchEntry,
): Blockly.BlockSvg {
    let block: Blockly.Block;
    if (entry.xml_template) {
        try {
            const xml = Blockly.utils.xml.textToDom(entry.xml_template);
            if (xml.tagName.toLowerCase() === 'block') {
                block = Blockly.Xml.domToBlock(xml, workspace);
                return block as Blockly.BlockSvg;
            }
        } catch {
            // Fall through to the registered block definition.
        }
    }
    block = workspace.newBlock(entry.type);
    const rendered = block as Blockly.BlockSvg;
    rendered.initSvg();
    rendered.render();
    return rendered;
}

function pointerToWorkspace(
    workspace: Blockly.WorkspaceSvg,
    pointer: { x: number; y: number } | null,
): { x: number; y: number } {
    const injectionRect = workspace.getInjectionDiv().getBoundingClientRect();
    const clientX = pointer?.x ?? injectionRect.left + injectionRect.width * 0.58;
    const clientY = pointer?.y ?? injectionRect.top + injectionRect.height * 0.44;
    const matrix = workspace.getCanvas().getScreenCTM();
    if (!matrix) return { x: 80, y: 80 };
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
}

function blockPreviewCacheKey(
    entry: BlockSearchEntry,
    visualStyle: BlocklyVisualStyle,
    themeKey: string,
    renderer: BlocklyRendererName,
    locale: BlocklyLocale,
): string {
    return `${locale}:${visualStyle}:${renderer}:${themeKey}:${entry.type}:${entry.xml_template || ''}`;
}

let nextBlockPreviewPaintScope = 0;

const SKIN_PAINT_REFERENCE_RE = /url\(\s*(['"]?)#(ck-skin-[^)'"\s]+)\1\s*\)/g;

function referencedSkinPaintIds(root: Element): Set<string> {
    const ids = new Set<string>();
    const elements = [root, ...Array.from(root.querySelectorAll('*'))];
    elements.forEach(element => {
        element.getAttributeNames().forEach(attributeName => {
            const value = element.getAttribute(attributeName) || '';
            for (const match of value.matchAll(SKIN_PAINT_REFERENCE_RE)) {
                ids.add(match[2]);
            }
        });
    });
    return ids;
}

function rewriteSkinPaintReferences(root: Element, idMap: ReadonlyMap<string, string>): void {
    const elements = [root, ...Array.from(root.querySelectorAll('*'))];
    elements.forEach(element => {
        element.getAttributeNames().forEach(attributeName => {
            const value = element.getAttribute(attributeName);
            if (!value || !value.includes('url(')) return;
            const next = value.replace(SKIN_PAINT_REFERENCE_RE, (reference, _quote, id: string) => {
                const replacement = idMap.get(id);
                return replacement ? `url(#${replacement})` : reference;
            });
            if (next !== value) element.setAttribute(attributeName, next);
        });
    });
}

function appendReferencedSkinPaintDefs(
    sourceSvg: SVGSVGElement | null,
    snapshotSvg: SVGSVGElement,
    snapshotRoot: SVGGElement,
): void {
    if (!sourceSvg) return;
    const referencedIds = referencedSkinPaintIds(snapshotRoot);
    if (referencedIds.size === 0) return;

    const definitionsById = new Map<string, Element>();
    sourceSvg.querySelectorAll('[id]').forEach(element => {
        const id = element.getAttribute('id');
        if (id && referencedIds.has(id)) definitionsById.set(id, element);
    });
    if (definitionsById.size === 0) return;

    nextBlockPreviewPaintScope += 1;
    const idMap = new Map<string, string>();
    Array.from(definitionsById.keys()).forEach((id, index) => {
        idMap.set(id, `ck-block-preview-${nextBlockPreviewPaintScope}-${index + 1}`);
    });

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.setAttribute('data-ck-block-skin-preview-defs', 'true');
    definitionsById.forEach((definition, id) => {
        const clone = definition.cloneNode(true) as Element;
        clone.setAttribute('id', idMap.get(id) || id);
        rewriteSkinPaintReferences(clone, idMap);
        defs.appendChild(clone);
    });
    rewriteSkinPaintReferences(snapshotRoot, idMap);
    snapshotSvg.appendChild(defs);
}

function createBlockPreviewSnapshot(
    previewWorkspace: Blockly.WorkspaceSvg,
    entry: BlockSearchEntry,
    visualStyle: BlocklyVisualStyle,
): BlockPreviewSnapshot | null {
    let block: Blockly.BlockSvg | null = null;
    try {
        previewWorkspace.clear();
        block = createBlockFromEntry(previewWorkspace, entry);
        block.setMovable(false);
        block.setDeletable(false);
        block.setEditable(false);
        block.moveTo(new Blockly.utils.Coordinate(0, 0));
        syncExtensionBlockVisualColour(block);
        block.render();
        Blockly.renderManagement.triggerQueuedRenders(previewWorkspace);
        applyBlocklyVisualSkin(previewWorkspace, visualStyle);

        const size = block.getHeightWidth();
        const width = Math.max(12, Math.ceil(size.width));
        const height = Math.max(12, Math.ceil(size.height));
        const root = block.getSvgRoot().cloneNode(true) as SVGGElement;
        root.setAttribute('transform', 'translate(3, 3)');
        root.classList.remove('blocklySelected', 'blocklyDragging');
        root.querySelectorAll('[tabindex], [aria-activedescendant]').forEach(element => {
            element.removeAttribute('tabindex');
            element.removeAttribute('aria-activedescendant');
        });

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        svg.setAttribute('viewBox', `0 0 ${width + 6} ${height + 6}`);
        svg.setAttribute('width', String(width + 6));
        svg.setAttribute('height', String(height + 6));
        svg.setAttribute('preserveAspectRatio', 'xMinYMid meet');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('data-ck-blockly-skin', visualStyle);
        svg.classList.add(
            previewWorkspace.getRenderer().getClassName(),
            previewWorkspace.getTheme().getClassName(),
        );
        appendReferencedSkinPaintDefs(block.getSvgRoot().ownerSVGElement, svg, root);
        svg.appendChild(root);
        return { markup: svg.outerHTML };
    } catch {
        return null;
    } finally {
        try { block?.dispose(false); } catch { }
        try { previewWorkspace.clear(); } catch { }
    }
}

export function BlockDock({ workspace, renderer, theme, visualStyle, disabled = false, onNotice }: BlockDockProps) {
    const { t: editorT, i18n: appI18n } = useTranslation('editor');
    const [blockLocaleRevision, setBlockLocaleRevision] = useState(0);
    useEffect(() => {
        const refresh = () => setBlockLocaleRevision(revision => revision + 1);
        window.addEventListener(BLOCK_LOCALE_PREFERENCE_CHANGED_EVENT, refresh);
        return () => window.removeEventListener(BLOCK_LOCALE_PREFERENCE_CHANGED_EVENT, refresh);
    }, []);
    const blockLocale = useMemo(() => {
        const preferences = getLocalePreferences();
        const uiLocale = normalizeUiLocale(appI18n.resolvedLanguage) ?? preferences.uiLocale;
        return getEffectiveBlocklyLocale(preferences.blockLocale, uiLocale);
    }, [appI18n.resolvedLanguage, blockLocaleRevision]);
    const [catalog, setCatalog] = useState<BlockSearchEntry[]>(() => window.CK_BLOCK_CATALOG?.blocks || []);
    const [preferences, setPreferences] = useState<BlockDockPreferences>(() => (
        readBlockDockPreferences(typeof window === 'undefined' ? null : window.localStorage)
    ));
    const [open, setOpen] = useState(false);
    const [source, setSource] = useState<DockSource>(LOGIC_SOURCE);
    const [query, setQuery] = useState('');
    const [selectedResult, setSelectedResult] = useState(0);
    const [activeTarget, setActiveTarget] = useState<BlockConnectionTarget | null>(null);
    const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
    const [connectionTargets, setConnectionTargets] = useState<BlockConnectionTarget[]>([]);
    const [targetLauncher, setTargetLauncher] = useState<BlockTargetLauncher | null>(null);
    const [targetMenu, setTargetMenu] = useState<BlockTargetMenuSnapshot | null>(null);
    const [dockLayout, setDockLayout] = useState<BlockDockLayout | null>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const pointerRef = useRef<{ x: number; y: number } | null>(null);
    const refreshFrameRef = useRef<number | null>(null);
    const previewHostRef = useRef<HTMLDivElement>(null);
    const previewWorkspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
    const previewCacheRef = useRef<Map<string, BlockPreviewSnapshot>>(new Map());
    const [previewRevision, setPreviewRevision] = useState(0);
    const [previews, setPreviews] = useState<Record<string, BlockPreviewSnapshot>>({});
    const themeKey = theme.getClassName();

    const updatePreferences = useCallback((updater: (current: BlockDockPreferences) => BlockDockPreferences) => {
        setPreferences(current => {
            const next = updater(current);
            writeBlockDockPreferences(next, window.localStorage);
            return next;
        });
    }, []);

    useEffect(() => {
        const update = (event: Event) => {
            const detail = (event as CustomEvent<{ blocks?: BlockSearchEntry[] }>).detail;
            setCatalog(detail?.blocks || window.CK_BLOCK_CATALOG?.blocks || []);
        };
        window.addEventListener('ck-block-catalog-updated', update);
        return () => window.removeEventListener('ck-block-catalog-updated', update);
    }, []);

    useEffect(() => {
        const host = previewHostRef.current;
        if (!workspace || !host) return;
        const mainWorkspace = Blockly.getMainWorkspace();
        let previewWorkspace: Blockly.WorkspaceSvg | null = null;
        try {
            prepareBlocklyWidgetDivForInjection(Blockly.WidgetDiv);
            previewWorkspace = Blockly.inject(host, {
                renderer,
                readOnly: true,
                media: '/blockly/media/',
                theme,
                scrollbars: false,
                sounds: false,
                zoom: {
                    controls: false,
                    wheel: false,
                    startScale: 1,
                    maxScale: 1,
                    minScale: 1,
                },
                move: {
                    scrollbars: false,
                    drag: false,
                    wheel: false,
                },
            });
            previewWorkspaceRef.current = previewWorkspace;
            previewCacheRef.current.clear();
            setPreviewRevision(revision => revision + 1);
        } finally {
            if (mainWorkspace && (mainWorkspace as Blockly.WorkspaceSvg).getInjectionDiv?.()?.isConnected) {
                Blockly.common.setMainWorkspace(mainWorkspace);
            }
        }
        return () => {
            previewCacheRef.current.clear();
            previewWorkspaceRef.current = null;
            if (!previewWorkspace) return;
            try {
                disposeBlocklyPreviewWorkspaceLifecycle(previewWorkspace, workspace, {
                    getMainWorkspace: () => Blockly.getMainWorkspace(),
                    setMainWorkspace: next => (
                        Blockly.common.setMainWorkspace as unknown as (value: unknown | null) => void
                    )(next),
                });
            } catch {
                // Preview cleanup must never interrupt the editor lifecycle.
            }
        };
    }, [renderer, theme, themeKey, workspace]);

    const connectionShapes = useMemo(() => {
        const result = new Map<string, BlockDockConnectionShape>();
        const scratch = new Blockly.Workspace();
        const eventsWereEnabled = Blockly.Events.isEnabled();
        if (eventsWereEnabled) Blockly.Events.disable();
        try {
            catalog.forEach(entry => {
                let block: Blockly.Block | null = null;
                try {
                    block = scratch.newBlock(entry.type);
                    result.set(entry.type, {
                        hasOutput: Boolean(block.outputConnection),
                        outputChecks: block.outputConnection?.getCheck() || null,
                        hasPrevious: Boolean(block.previousConnection),
                        previousChecks: block.previousConnection?.getCheck() || null,
                        hasNext: Boolean(block.nextConnection),
                    });
                } catch {
                    // A block that cannot initialize in a headless workspace is not
                    // offered for a typed connection, but remains globally searchable.
                } finally {
                    try { block?.dispose(false); } catch { }
                }
            });
        } finally {
            try { scratch.dispose(); } catch { }
            if (eventsWereEnabled) Blockly.Events.enable();
        }
        return result;
    }, [catalog]);

    const compatibleTypes = useMemo(() => {
        if (!activeTarget) return null;
        const targetChecks = activeTarget.connection.getCheck();
        const result = new Set<string>();
        connectionShapes.forEach((shape, type) => {
            if (blockDockShapeCanConnect(
                activeTarget.kind,
                targetChecks,
                activeTarget.hasExistingStatement,
                shape,
            )) {
                result.add(type);
            }
        });
        return result;
    }, [activeTarget, connectionShapes]);

    const results = useMemo(() => searchBlockDockEntries(catalog, {
        query,
        source: source.kind,
        pin: source.kind === 'pin' ? source.pin : null,
        recentTypes: preferences.recentTypes,
        compatibleTypes,
        pins: preferences.pins,
        locale: blockLocale,
        limit: 40,
    }), [blockLocale, catalog, compatibleTypes, preferences.pins, preferences.recentTypes, query, source]);

    useEffect(() => {
        if (!open || !previewWorkspaceRef.current || !workspace) {
            setPreviews({});
            return;
        }
        const mainWorkspace = workspace;
        let cancelled = false;
        const frame = requestAnimationFrame(() => {
            const previewWorkspace = previewWorkspaceRef.current;
            if (!previewWorkspace || cancelled) return;
            const next: Record<string, BlockPreviewSnapshot> = {};
            const eventsWereEnabled = Blockly.Events.isEnabled();
            if (eventsWereEnabled) Blockly.Events.disable();
            try {
                results.forEach(entry => {
                    const key = blockPreviewCacheKey(entry, visualStyle, themeKey, renderer, blockLocale);
                    let snapshot = previewCacheRef.current.get(key) || null;
                    if (!snapshot) {
                        snapshot = createBlockPreviewSnapshot(previewWorkspace, entry, visualStyle);
                        if (snapshot) previewCacheRef.current.set(key, snapshot);
                    }
                    if (snapshot) next[entry.type] = snapshot;
                });
            } finally {
                if (eventsWereEnabled) Blockly.Events.enable();
                if (Blockly.getMainWorkspace() !== mainWorkspace
                    && mainWorkspace.getInjectionDiv?.()?.isConnected) {
                    Blockly.common.setMainWorkspace(mainWorkspace);
                }
            }
            if (!cancelled) setPreviews(next);
        });
        return () => {
            cancelled = true;
            cancelAnimationFrame(frame);
        };
    }, [blockLocale, open, previewRevision, renderer, results, themeKey, visualStyle, workspace]);

    useEffect(() => {
        setSelectedResult(0);
    }, [query, source, activeTarget]);

    useEffect(() => {
        if (!open) return;
        const frame = requestAnimationFrame(() => searchInputRef.current?.focus());
        return () => cancelAnimationFrame(frame);
    }, [open]);

    const refreshConnectionTargets = useCallback(() => {
        if (!workspace || disabled) {
            setSelectedBlockId(null);
            setConnectionTargets([]);
            setTargetLauncher(null);
            setTargetMenu(null);
            return;
        }
        const commonSelection = Blockly.common.getSelected() as Blockly.BlockSvg | null;
        const selected = commonSelection?.workspace === workspace ? commonSelection : null;
        if (!selected
            || !Array.isArray((selected as Blockly.BlockSvg).inputList)
            || selected.workspace !== workspace
            || selected.isInFlyout) {
            setSelectedBlockId(null);
            setConnectionTargets([]);
            setTargetLauncher(null);
            return;
        }
        setSelectedBlockId(selected.id);
        const canvasMatrix = workspace.getCanvas().getScreenCTM();
        const rect = workspace.getInjectionDiv().getBoundingClientRect();
        if (!canvasMatrix) {
            setConnectionTargets([]);
            setTargetLauncher(null);
            return;
        }
        const blockRect = selected.getSvgRoot().getBoundingClientRect();
        const toAnchor = (connection: Blockly.Connection) => {
            const point = new DOMPoint(connection.x, connection.y).matrixTransform(canvasMatrix);
            return { left: point.x - rect.left, top: point.y - rect.top };
        };
        const next: BlockConnectionTarget[] = [];
        selected.inputList.forEach((input, index) => {
            const connection = input.connection;
            if (!connection) return;
            const targetBlock = connection.targetBlock();
            if (connection.type === Blockly.INPUT_VALUE) {
                if (targetBlock && !targetBlock.isShadow()) return;
                next.push({
                    id: connection.id,
                    blockId: selected.id,
                    connection,
                    kind: 'value',
                    label: inputLabel(selected, input, index, blockLocale),
                    ...toAnchor(connection),
                    hasExistingStatement: false,
                });
                return;
            }
            if (connection.type === Blockly.NEXT_STATEMENT) {
                next.push({
                    id: connection.id,
                    blockId: selected.id,
                    connection,
                    kind: 'statement',
                    label: inputLabel(selected, input, index, blockLocale),
                    ...toAnchor(connection),
                    hasExistingStatement: Boolean(targetBlock),
                });
            }
        });
        if (selected.nextConnection) {
            next.push({
                id: selected.nextConnection.id,
                blockId: selected.id,
                connection: selected.nextConnection,
                kind: 'statement',
                label: selected.nextConnection.targetBlock()
                    ? editorT('blockDock.target.insertBefore')
                    : editorT('blockDock.target.appendAfter'),
                ...toAnchor(selected.nextConnection),
                hasExistingStatement: Boolean(selected.nextConnection.targetBlock()),
            });
        }
        const visibleTargets = next
            .filter(target => (
                target.left > -24 && target.top > -24
                && target.left < rect.width + 24 && target.top < rect.height + 24
            ))
            .map(target => ({
                ...target,
                left: Math.min(Math.max(target.left, 24), Math.max(24, rect.width - 24)),
                top: Math.min(Math.max(target.top, 24), Math.max(24, rect.height - 24)),
            }));
        setConnectionTargets(visibleTargets);
        if (visibleTargets.length === 0) {
            setTargetLauncher(null);
            return;
        }
        const left = Math.min(
            Math.max(blockRect.right - rect.left + 16, 24),
            Math.max(24, rect.width - 24),
        );
        const top = Math.min(
            Math.max(blockRect.top - rect.top + Math.min(28, blockRect.height / 2), 24),
            Math.max(24, rect.height - 24),
        );
        const menuWidth = Math.min(210, Math.max(160, rect.width - 16));
        const menuHeight = Math.min(260, 40 + visibleTargets.length * 37);
        const menuLeft = Math.min(
            Math.max(left - menuWidth, 8),
            Math.max(8, rect.width - menuWidth - 8),
        );
        const menuTop = top + 24 + menuHeight <= rect.height - 8
            ? top + 24
            : Math.max(8, top - menuHeight - 24);
        setTargetLauncher({ left, top, menuLeft, menuTop });
    }, [blockLocale, disabled, editorT, workspace]);

    const refreshDockLayout = useCallback(() => {
        if (!workspace) {
            setDockLayout(null);
            return;
        }
        const rect = workspace.getInjectionDiv().getBoundingClientRect();
        const manager = workspace.getMetricsManager();
        const { left } = manager.getAbsoluteMetrics();
        const toolbox = manager.getToolboxMetrics();
        const flyout = manager.getFlyoutMetrics();
        const vertical = workspace.toolboxPosition === Blockly.utils.toolbox.Position.LEFT
            || workspace.toolboxPosition === Blockly.utils.toolbox.Position.RIGHT;
        // SVG viewWidth is cached until Blockly.svgResize runs. ResizeObserver
        // callbacks can precede that rAF, so measure the live host instead.
        const occupiedWidth = vertical
            ? toolbox.width + (workspace.getFlyout()?.autoClose === false ? flyout.width : 0)
            : 0;
        const availableWidth = Math.max(0, rect.width - occupiedWidth);
        if (rect.width <= 0 || availableWidth <= 0) return;
        const next = {
            centerOffset: left + availableWidth / 2 - rect.width / 2,
            availableWidth,
        };
        setDockLayout(current => (
            current
            && Math.abs(current.centerOffset - next.centerOffset) < 0.5
            && Math.abs(current.availableWidth - next.availableWidth) < 0.5
                ? current
                : next
        ));
    }, [workspace]);

    const scheduleTargetRefresh = useCallback(() => {
        if (refreshFrameRef.current != null) cancelAnimationFrame(refreshFrameRef.current);
        refreshFrameRef.current = requestAnimationFrame(() => {
            refreshFrameRef.current = null;
            refreshDockLayout();
            refreshConnectionTargets();
        });
    }, [refreshConnectionTargets, refreshDockLayout]);

    useEffect(() => {
        if (!workspace) return;
        const listener = (event: Blockly.Events.Abstract) => {
            const raw = event as any;
            if (event.type === Blockly.Events.SELECTED) {
                if (typeof raw.newElementId === 'string') {
                    setSelectedBlockId(raw.newElementId);
                } else {
                    setSelectedBlockId(null);
                    setConnectionTargets([]);
                    setTargetLauncher(null);
                    setTargetMenu(null);
                }
            }
            if (event.type === Blockly.Events.BLOCK_CREATE) {
                const ids = Array.isArray(raw.ids) ? raw.ids : [raw.blockId].filter(Boolean);
                const createdType = ids
                    .map((id: string) => workspace.getBlockById(id)?.type)
                    .find(Boolean);
                if (createdType) {
                    updatePreferences(current => ({
                        ...current,
                        recentTypes: addRecentBlockType(current.recentTypes, createdType),
                    }));
                }
            }
            if ([
                Blockly.Events.SELECTED,
                Blockly.Events.VIEWPORT_CHANGE,
                Blockly.Events.TOOLBOX_ITEM_SELECT,
                Blockly.Events.BLOCK_CREATE,
                Blockly.Events.BLOCK_MOVE,
                Blockly.Events.BLOCK_CHANGE,
                Blockly.Events.BLOCK_DELETE,
            ].includes(event.type as any)) {
                scheduleTargetRefresh();
            }
        };
        workspace.addChangeListener(listener);
        window.addEventListener('resize', scheduleTargetRefresh);
        const resizeObserver = typeof ResizeObserver === 'undefined'
            ? null
            : new ResizeObserver(scheduleTargetRefresh);
        resizeObserver?.observe(workspace.getInjectionDiv());
        resizeObserver?.observe(workspace.getParentSvg());
        const toolboxElement = workspace.getToolbox()?.getRootFocusableNode().getFocusableElement();
        if (toolboxElement) resizeObserver?.observe(toolboxElement);
        scheduleTargetRefresh();
        return () => {
            workspace.removeChangeListener(listener);
            window.removeEventListener('resize', scheduleTargetRefresh);
            resizeObserver?.disconnect();
            if (refreshFrameRef.current != null) cancelAnimationFrame(refreshFrameRef.current);
            refreshFrameRef.current = null;
        };
    }, [scheduleTargetRefresh, updatePreferences, workspace]);

    useEffect(() => {
        if (!workspace) return;
        const onPointerMove = (event: PointerEvent) => {
            const rect = workspace.getInjectionDiv().getBoundingClientRect();
            if (event.clientX >= rect.left && event.clientX <= rect.right
                && event.clientY >= rect.top && event.clientY <= rect.bottom) {
                pointerRef.current = { x: event.clientX, y: event.clientY };
            }
        };
        window.addEventListener('pointermove', onPointerMove, { passive: true });
        return () => window.removeEventListener('pointermove', onPointerMove);
    }, [workspace]);

    const openSource = useCallback((nextSource: DockSource, target: BlockConnectionTarget | null = null) => {
        setTargetMenu(null);
        setSource(nextSource);
        setActiveTarget(target);
        setQuery('');
        setOpen(true);
    }, []);

    const close = useCallback(() => {
        setOpen(false);
        setActiveTarget(null);
        setTargetMenu(null);
        setQuery('');
        workspace?.getInjectionDiv().focus?.();
    }, [workspace]);

    useEffect(() => {
        if (!targetMenu) return;
        const handleOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest(
                '[data-ck-role="block-target-launcher"], [data-ck-role="block-target-menu"]',
            )) return;
            setTargetMenu(null);
        };
        document.addEventListener('pointerdown', handleOutsidePointer, true);
        return () => document.removeEventListener('pointerdown', handleOutsidePointer, true);
    }, [targetMenu]);

    useEffect(() => {
        if (!open) return;
        const handleOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest(
                '[data-ck-role="block-dock-popover"], [data-ck-role="block-dock-nav"]',
            )) return;
            close();
        };
        document.addEventListener('pointerdown', handleOutsidePointer, true);
        return () => document.removeEventListener('pointerdown', handleOutsidePointer, true);
    }, [close, open]);

    const insertEntry = useCallback((entry: BlockSearchEntry) => {
        if (!workspace || disabled) return;
        const group = Blockly.Events.getGroup();
        Blockly.Events.setGroup(true);
        let block: Blockly.BlockSvg | null = null;
        let previousBlock: Blockly.Block | null = null;
        let previousConnection: Blockly.Connection | null = null;
        try {
            block = createBlockFromEntry(workspace, entry);
            if (activeTarget) {
                if (activeTarget.connection.disposed || !workspace.getBlockById(activeTarget.blockId)) {
                    throw new Error('插入位置已经变化，请重新点一次 +');
                }
                const candidateConnection = activeTarget.kind === 'value'
                    ? block.outputConnection
                    : block.previousConnection;
                if (!candidateConnection || !blockDockChecksOverlap(
                    activeTarget.connection.getCheck(),
                    candidateConnection.getCheck(),
                )) {
                    throw new Error('这个积木无法接入当前位置');
                }
                previousBlock = activeTarget.connection.targetBlock();
                previousConnection = activeTarget.connection.targetConnection;
                if (previousConnection) activeTarget.connection.disconnect();
                activeTarget.connection.connect(candidateConnection);
                if (activeTarget.connection.targetConnection !== candidateConnection) {
                    throw new Error('Blockly 拒绝了不兼容的连接');
                }
                if (activeTarget.kind === 'statement' && previousConnection) {
                    if (!block.nextConnection) {
                        throw new Error('这个积木不能插入已有语句之间');
                    }
                    block.nextConnection.connect(previousConnection);
                    if (block.nextConnection.targetConnection !== previousConnection) {
                        throw new Error('这个积木不能插入已有语句之间');
                    }
                } else if (activeTarget.kind === 'value' && previousBlock?.isShadow()) {
                    previousBlock.dispose(false);
                    previousBlock = null;
                    previousConnection = null;
                }
            } else {
                const position = pointerToWorkspace(workspace, pointerRef.current);
                const current = block.getRelativeToSurfaceXY();
                block.moveBy(position.x - current.x, position.y - current.y);
            }
            block.select();
            updatePreferences(current => ({
                ...current,
                recentTypes: addRecentBlockType(current.recentTypes, entry.type),
            }));
            onNotice?.(editorT('blockDock.notice.inserted', {
                label: entryDisplayName(entry, blockLocale),
            }), 'success');
            close();
            requestAnimationFrame(() => {
                Blockly.svgResize(workspace);
                scheduleTargetRefresh();
            });
        } catch (error) {
            try { block?.dispose(false); } catch { }
            try {
                if (activeTarget && !activeTarget.connection.isConnected() && previousConnection) {
                    activeTarget.connection.connect(previousConnection);
                }
            } catch { }
            onNotice?.(error instanceof Error ? error.message : '积木插入失败', 'error');
        } finally {
            Blockly.Events.setGroup(group || false);
        }
    }, [activeTarget, blockLocale, close, disabled, editorT, onNotice, scheduleTargetRefresh, updatePreferences, workspace]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') {
                event.preventDefault();
                event.stopPropagation();
                openSource(ALL_SOURCE, null);
                return;
            }
            if (event.key === 'Escape' && targetMenu) {
                event.preventDefault();
                setTargetMenu(null);
                return;
            }
            if (!open) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                close();
            }
        };
        window.addEventListener('keydown', handleKeyDown, true);
        return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, [close, open, openSource, targetMenu]);

    const togglePin = useCallback((entry: BlockSearchEntry) => {
        const pin = createBlockDockPin(entry);
        const exists = preferences.pins.some(item => item.key === pin.key);
        updatePreferences(current => ({
            ...current,
            pins: exists
                ? current.pins.filter(item => item.key !== pin.key)
                : addBlockDockPin(current.pins, pin),
        }));
    }, [preferences.pins, updatePreferences]);

    if (!workspace || disabled) return null;

    const dockLayoutStyle = dockLayout ? {
        '--ck-block-dock-center-offset': `${dockLayout.centerOffset}px`,
        '--ck-block-dock-available-width': `${dockLayout.availableWidth}px`,
    } as React.CSSProperties : undefined;

    return (
        <div
            className="ck-block-dock-layer"
            data-ck-role="block-dock"
            style={dockLayoutStyle}
        >
            {!open && selectedBlockId && connectionTargets.length === 1 && connectionTargets
                .filter(target => target.blockId === selectedBlockId)
                .map(target => (
                <button
                    key={target.id}
                    type="button"
                    className="ck-block-connection-add"
                    data-kind={target.kind}
                    style={{ left: target.left, top: target.top }}
                    title={editorT('blockDock.target.compatibleTitle', { target: target.label })}
                    aria-label={editorT('blockDock.target.quickInsertAria', { target: target.label })}
                    onPointerDown={event => {
                        if (!event.isPrimary || event.button !== 0) return;
                        event.preventDefault();
                        event.stopPropagation();
                        window.setTimeout(() => openSource(ALL_SOURCE, target), 0);
                    }}
                    onClick={event => {
                        event.stopPropagation();
                        if (event.detail === 0) openSource(ALL_SOURCE, target);
                    }}
                >
                    <span className="ck-block-connection-add-face" aria-hidden="true">
                        <Plus size={15} strokeWidth={3} />
                    </span>
                </button>
            ))}

            {!open && selectedBlockId && connectionTargets.length > 1 && targetLauncher
                && connectionTargets.every(target => target.blockId === selectedBlockId) && (
                <>
                    <button
                        type="button"
                        className="ck-block-connection-add is-multi"
                        style={{ left: targetLauncher.left, top: targetLauncher.top }}
                        title={editorT('blockDock.target.choosePosition')}
                        aria-label={editorT('blockDock.target.choosePosition')}
                        aria-expanded={Boolean(targetMenu)}
                        data-ck-role="block-target-launcher"
                        onPointerDown={event => {
                            if (!event.isPrimary || event.button !== 0) return;
                            event.preventDefault();
                            event.stopPropagation();
                            setTargetMenu(current => current ? null : {
                                launcher: { ...targetLauncher },
                                targets: [...connectionTargets],
                            });
                        }}
                        onClick={event => {
                            event.stopPropagation();
                            if (event.detail === 0) {
                                setTargetMenu(current => current ? null : {
                                    launcher: { ...targetLauncher },
                                    targets: [...connectionTargets],
                                });
                            }
                        }}
                    >
                        <span className="ck-block-connection-add-face" aria-hidden="true">
                            <Plus size={15} strokeWidth={3} />
                        </span>
                    </button>
                </>
            )}

            {!open && targetMenu && (
                <div
                    className="ck-block-target-menu"
                    data-ck-role="block-target-menu"
                    style={{ left: targetMenu.launcher.menuLeft, top: targetMenu.launcher.menuTop }}
                    role="menu"
                    aria-label={editorT('blockDock.target.choosePosition')}
                    onPointerDown={event => event.stopPropagation()}
                >
                    <strong>{editorT('blockDock.target.insertInto')}</strong>
                    {targetMenu.targets.map(target => (
                        <button
                            key={target.id}
                            type="button"
                            role="menuitem"
                            onPointerDown={event => {
                                if (event.button !== 0) return;
                                event.preventDefault();
                                event.stopPropagation();
                                try { event.currentTarget.setPointerCapture(event.pointerId); } catch { }
                            }}
                            onPointerUp={event => {
                                if (event.button !== 0) return;
                                event.preventDefault();
                                event.stopPropagation();
                                try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { }
                                window.setTimeout(() => openSource(ALL_SOURCE, target), 0);
                            }}
                            onClick={event => {
                                event.stopPropagation();
                                if (event.detail === 0) openSource(ALL_SOURCE, target);
                            }}
                        >
                            <span>{target.kind === 'value'
                                ? editorT('blockDock.target.value')
                                : editorT('blockDock.target.statement')}</span>
                            {target.label}
                        </button>
                    ))}
                </div>
            )}

            {open && (
                <div
                    className="ck-block-dock-popover"
                    data-ck-role="block-dock-popover"
                    role="dialog"
                    aria-label={activeTarget
                        ? editorT('blockDock.search.compatibleAria', { target: activeTarget.label })
                        : editorT('blockDock.search.aria')}
                    onPointerDown={event => event.stopPropagation()}
                >
                    <div className="ck-block-dock-popover-head">
                        <div className="ck-block-dock-search-wrap">
                            <Search size={15} aria-hidden="true" />
                            <input
                                ref={searchInputRef}
                                value={query}
                                onChange={event => setQuery(event.target.value)}
                                onKeyDown={event => {
                                    if (event.key === 'ArrowDown') {
                                        event.preventDefault();
                                        setSelectedResult(index => Math.min(index + 1, Math.max(0, results.length - 1)));
                                    } else if (event.key === 'ArrowUp') {
                                        event.preventDefault();
                                        setSelectedResult(index => Math.max(0, index - 1));
                                    } else if (event.key === 'Enter' && results[selectedResult]) {
                                        event.preventDefault();
                                        insertEntry(results[selectedResult]);
                                    }
                                }}
                                placeholder={activeTarget
                                    ? editorT('blockDock.search.compatiblePlaceholder', { target: activeTarget.label })
                                    : editorT('blockDock.search.placeholder')}
                                aria-label={editorT('blockDock.search.aria')}
                                autoComplete="off"
                                spellCheck={false}
                            />
                            <kbd>Ctrl K</kbd>
                        </div>
                        <button type="button" className="ck-block-dock-close" onClick={close} aria-label={editorT('blockDock.search.close')}>
                            <X size={15} />
                        </button>
                    </div>
                    <div className="ck-block-dock-context-line">
                        <span>{sourceTitle(source, catalog, blockLocale)}</span>
                        {activeTarget && <strong>{editorT('blockDock.search.compatibleOnly', { target: activeTarget.label })}</strong>}
                        <em>{editorT('blockDock.count', { count: results.length })}</em>
                    </div>
                    <div className="ck-block-dock-results" role="listbox">
                        {results.length === 0 && (
                            <div className="ck-block-dock-empty">
                                {activeTarget
                                    ? editorT('blockDock.search.emptyCompatible')
                                    : editorT('blockDock.search.empty')}
                            </div>
                        )}
                        {results.map((entry, index) => {
                            const pin = createBlockDockPin(entry);
                            const pinned = preferences.pins.some(item => item.key === pin.key);
                            return (
                                <div
                                    key={entry.type}
                                    className={`ck-block-dock-result ${index === selectedResult ? 'is-selected' : ''}`}
                                    role="option"
                                    aria-selected={index === selectedResult}
                                    onMouseEnter={() => setSelectedResult(index)}
                                    onFocusCapture={() => setSelectedResult(index)}
                                >
                                    <button type="button" className="ck-block-dock-result-main" onClick={() => insertEntry(entry)}>
                                        <span className="ck-block-dock-result-preview">
                                            {previews[entry.type] ? (
                                                <span
                                                    className="ck-block-dock-result-preview-svg"
                                                    dangerouslySetInnerHTML={{ __html: previews[entry.type].markup }}
                                                />
                                            ) : (
                                                <span className="ck-block-dock-result-preview-fallback">{entryDisplayName(entry, blockLocale)}</span>
                                            )}
                                        </span>
                                        <span className="ck-block-dock-result-meta">
                                            <strong>{entryDisplayName(entry, blockLocale)}</strong>
                                            <small>{entrySourceLabel(entry, blockLocale)}</small>
                                            <em>{editorT('discovery.insert')}</em>
                                            {index === selectedResult && <em>{editorT('blockDock.search.enterInsert')}</em>}
                                        </span>
                                    </button>
                                    <button
                                        type="button"
                                        className={`ck-block-dock-pin ${pinned ? 'is-pinned' : ''}`}
                                        onClick={() => togglePin(entry)}
                                        title={pinned
                                            ? editorT('blockDock.search.pinnedTitle')
                                            : editorT('blockDock.search.pinTitle', { label: pinDisplayLabel(pin, catalog, blockLocale) })}
                                        aria-label={pinned
                                            ? editorT('blockDock.search.unpin', { label: pinDisplayLabel(pin, catalog, blockLocale) })
                                            : editorT('blockDock.search.pin', { label: pinDisplayLabel(pin, catalog, blockLocale) })}
                                    >
                                        {pinned ? <PinOff size={14} /> : <Pin size={14} />}
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                    <div className="ck-block-dock-help">
                        <span>{editorT('blockDock.search.helpSelect')}</span><span>{editorT('blockDock.search.helpInsert')}</span><span>{editorT('blockDock.search.helpClose')}</span>
                    </div>
                </div>
            )}

            <nav className="ck-block-dock" data-ck-role="block-dock-nav" aria-label={editorT('blockDock.search.dockAria')}>
                <button
                    type="button"
                    className={sourceKey(source) === 'logic' && open ? 'is-active' : ''}
                    onClick={() => openSource(LOGIC_SOURCE)}
                    title={editorT('blockDock.search.logicTitle')}
                >
                    <span className="ck-block-dock-fixed-mark" aria-hidden="true" />
                    {getBlocklySourceLabel('logic', blockLocale)}
                </button>
                {preferences.pins.map(pin => {
                    const displayLabel = pinDisplayLabel(pin, catalog, blockLocale);
                    return (
                        <button
                            key={pin.key}
                            type="button"
                            className={source.kind === 'pin' && source.pin.key === pin.key && open ? 'is-active' : ''}
                            onClick={() => openSource({ kind: 'pin', pin })}
                            title={`${displayLabel} (${editorT('blockDock.source.pinned')})`}
                        >
                            <Pin size={12} />
                            <span>{displayLabel}</span>
                        </button>
                    );
                })}
                <button
                    type="button"
                    className={sourceKey(source) === 'recent' && open ? 'is-active' : ''}
                    onClick={() => openSource(RECENT_SOURCE)}
                    title={editorT('blockDock.search.recentTitle')}
                >
                    <History size={13} /> {getBlocklySourceLabel('recent', blockLocale)}
                </button>
                <span className="ck-block-dock-divider" />
                <button type="button" className="ck-block-dock-command" onClick={() => openSource(ALL_SOURCE)} title={editorT('blockDock.search.globalTitle')}>
                    <Command size={13} /> {editorT('blockDock.search.command')} <kbd>Ctrl K</kbd>
                </button>
            </nav>
            <div ref={previewHostRef} className="ck-block-dock-preview-workspace" aria-hidden="true" />
        </div>
    );
}
