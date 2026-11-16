import type * as Blockly from 'blockly';

/** Paint culling only. All Blockly models, connections and SVG geometry remain
 * intact: serialization, search, code generation and undo see the full project.
 * Park offscreen SVG outside the transformed canvas, not just display:none
 * within it (Chromium otherwise still invalidates huge subtrees on zoom).
 * Models, connections, stable IDs and serialization are never removed.
 */
export function installBlocklyViewportCulling(
    workspace: Blockly.WorkspaceSvg,
    options: { threshold?: number; overscan?: number; overviewScale?: number; overviewLabel?: () => string } = {},
) {
    const threshold = options.threshold ?? 2000;
    const overscan = options.overscan ?? 160;
    const overviewScale = options.overviewScale ?? 0.55;
    const layers = workspace.getLayerManager();
    // Blockly 12's coordinate walk stops at a recognized layer. Register only
    // this presentation layer with the workspace-local boundary predicate;
    // never patch prototypes, connections, block positions or global Blockly.
    if (!layers || typeof layers.hasLayer !== 'function') {
        return {refresh() {}, beginBulkLoad() {}, stageLoadedStack(_block: Blockly.BlockSvg) {}, endBulkLoad() {}, get stats() {return {blockCount:0,culledStacks:0,topStacks:0,overview:false};}, dispose() {}};
    }
    const hidden = new Map<SVGElement, Comment>();
    const parkingSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    parkingSvg.setAttribute('class', workspace.getParentSvg().getAttribute('class') || 'blocklySvg');
    parkingSvg.setAttribute('aria-hidden', 'true');
    parkingSvg.style.display = 'none';
    const parking = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    parking.setAttribute('class', workspace.getCanvas().getAttribute('class') || 'blocklyBlockCanvas');
    parking.setAttribute('data-ck-viewport-parking', 'true');
    parking.style.display = 'none';
    parkingSvg.appendChild(parking);
    // A separate, connected SVG keeps inherited font/CSS lookup available
    // without making Chromium revisit 300k hidden nodes on main-canvas zoom.
    workspace.getParentSvg().parentNode?.appendChild(parkingSvg);
    const previousHasLayer = layers.hasLayer;
    const hasLayer = (element: SVGElement) => element === parking || previousHasLayer.call(layers, element);
    layers.hasLayer = hasLayer;
    let roots: Blockly.BlockSvg[] = [];
    let count = 0;
    let frame = 0;
    let disposed = false;
    let rebuild = true;
    let geometryDirty = true;
    let bulkLoading = false;
    let overview = false;
    let overviewDirty = true;
    const boundsById = new Map<string, ReturnType<Blockly.BlockSvg['getBoundingRectangle']>>();
    const overviewLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    overviewLayer.setAttribute('data-ck-workspace-overview', 'true');
    overviewLayer.style.display = 'none';
    // One lightweight silhouette per stack, not 50k SVG block subtrees. This
    // transforms with Blockly's existing canvas, including wheel/pan gestures.
    workspace.getCanvas().appendChild(overviewLayer);
    const label = document.createElement('div');
    label.setAttribute('data-ck-overview-label', 'true');
    label.setAttribute('role', 'status');
    Object.assign(label.style, {display:'none',position:'absolute',top:'12px',right:'64px',maxWidth:'65%',padding:'6px 10px',borderRadius:'6px',background:'#0f172a',color:'#e2e8f0',fontSize:'12px',pointerEvents:'none',zIndex:'2'});
    workspace.getParentSvg().parentNode?.appendChild(label);
    const restore = (root: SVGElement) => {
        const anchor = hidden.get(root);
        if (!anchor) return;
        // Blockly may already have moved a selected block into its drag layer.
        // Never steal it back or reconnect a deleted/disposed SVG.
        if (root.parentNode === parking && anchor.parentNode) anchor.parentNode.insertBefore(root, anchor);
        anchor.remove();
        hidden.delete(root);
    };
    const restoreAll = () => { for (const root of hidden.keys()) restore(root); };
    const park = (block: Blockly.BlockSvg, bounds = block.getBoundingRectangle()) => {
        const root = block.getSvgRoot();
        if (!root || hidden.has(root) || root.parentNode !== workspace.getCanvas()) return;
        const anchor = document.createComment('ck-viewport-stack');
        root.parentNode.insertBefore(anchor, root);
        hidden.set(root, anchor);
        parking.appendChild(root);
        // Fail open for package-owned transforms; never change geometry.
        try {
            const after = block.getBoundingRectangle();
            if (after.left !== bounds.left || after.top !== bounds.top
                || after.right !== bounds.right || after.bottom !== bounds.bottom) restore(root);
        } catch { restore(root); }
    };
    const setOverview = (enabled: boolean) => {
        overview = enabled;
        overviewLayer.style.display = enabled ? '' : 'none';
        label.style.display = enabled ? '' : 'none';
        if (!enabled) return;
        label.textContent = options.overviewLabel?.() || 'Overview · Zoom in or double-click a stack to edit';
        for (const block of roots) {
            const bounds = boundsById.get(block.id);
            if (bounds && !block.isDisposed()) park(block, bounds);
        }
        if (!overviewDirty) return;
        overviewLayer.replaceChildren();
        const fragment = document.createDocumentFragment();
        for (const block of roots) {
            const bounds = boundsById.get(block.id);
            if (!bounds || block.isDisposed()) continue;
            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', String(bounds.left));
            rect.setAttribute('y', String(bounds.top));
            rect.setAttribute('width', String(Math.max(1, bounds.right - bounds.left)));
            rect.setAttribute('height', String(Math.max(1, bounds.bottom - bounds.top)));
            rect.setAttribute('fill', block.getColour?.() || '#0d9488');
            rect.setAttribute('fill-opacity', '0.65');
            rect.setAttribute('stroke', '#94a3b8');
            rect.setAttribute('stroke-width', '1');
            rect.setAttribute('vector-effect', 'non-scaling-stroke');
            rect.setAttribute('rx', '5');
            rect.setAttribute('data-ck-overview-id', block.id);
            fragment.appendChild(rect);
        }
        overviewLayer.appendChild(fragment);
        overviewDirty = false;
    };
    const update = () => {
        frame = 0;
        if (disposed || bulkLoading) return;
        if (workspace.isDragging()) return;
        if (rebuild) {
            count = workspace.getAllBlocks(false).length;
            roots = workspace.getTopBlocks(false);
            for (const root of hidden.keys()) if (root.parentNode !== parking) restore(root);
            rebuild = false;
            geometryDirty = true;
        }
        if (count < threshold) { setOverview(false); restoreAll(); return; }
        if (geometryDirty) {
            boundsById.clear();
            for (const block of roots) if (!block.isDisposed()) boundsById.set(block.id, block.getBoundingRectangle());
            geometryDirty = false;
            overviewDirty = true;
        }
        setOverview(workspace.scale < overviewScale);
        if (overview) return;
        const view = workspace.getMetricsManager().getViewMetrics(true);
        const margin = overscan / workspace.scale;
        const left = view.left - margin, right = view.left + view.width + margin;
        const top = view.top - margin, bottom = view.top + view.height + margin;
        for (const block of roots) {
            const root = block.getSvgRoot();
            if (!root || block.isDisposed()) continue;
            const bounds = boundsById.get(block.id);
            if (!bounds) continue;
            const visible = bounds.right >= left && bounds.left <= right
                && bounds.bottom >= top && bounds.top <= bottom;
            if (visible) restore(root);
            else park(block, bounds);
        }
    };
    // Enter overview before Blockly transforms a full visible SVG. Waiting for
    // the asynchronous viewport event allows one very expensive zoom-out paint.
    const previousSetScale = workspace.setScale;
    const setScale = (scale: number) => {
        if (!bulkLoading && count >= threshold && scale < overviewScale && !workspace.isDragging()) setOverview(true);
        previousSetScale.call(workspace, scale);
        if (!disposed && !bulkLoading) schedule();
    };
    if (typeof previousSetScale === 'function') workspace.setScale = setScale;
    const doubleClick = (event: MouseEvent) => {
        if (!overview) return;
        const id = (event.target as Element)?.closest?.('[data-ck-overview-id]')?.getAttribute('data-ck-overview-id');
        if (!id || !workspace.getBlockById(id)) return;
        event.preventDefault(); event.stopImmediatePropagation();
        workspace.setScale(Math.max(0.8, overviewScale));
        workspace.centerOnBlock(id);
        update();
    };
    workspace.getParentSvg().addEventListener('dblclick', doubleClick, true);
    const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(update); };
    const listener = (event: Blockly.Events.Abstract) => {
        if (['create', 'delete', 'move', 'finished_loading'].includes(event.type)) rebuild = true;
        if (['change','theme_change','block_field_intermediate_change'].includes(event.type)) geometryDirty = true;
        if (['viewport_change', 'selected', 'drag', 'create', 'delete', 'move', 'change', 'finished_loading','theme_change','block_field_intermediate_change'].includes(event.type)) schedule();
    };
    workspace.addChangeListener(listener);
    schedule();
    return {
        refresh() { rebuild = true; schedule(); },
        beginBulkLoad() {
            bulkLoading = true;
            setOverview(false);
            restoreAll();
            roots = []; count = 0; boundsById.clear();
        },
        stageLoadedStack(block: Blockly.BlockSvg) { if (bulkLoading && !disposed) park(block); },
        endBulkLoad() { bulkLoading = false; rebuild = true; schedule(); },
        get stats() { return { blockCount: count, culledStacks: hidden.size, topStacks: roots.length, overview }; },
        dispose() {
            disposed = true;
            cancelAnimationFrame(frame);
            workspace.removeChangeListener(listener);
            workspace.getParentSvg().removeEventListener('dblclick', doubleClick, true);
            if (workspace.setScale === setScale) workspace.setScale = previousSetScale;
            restoreAll();
            overviewLayer.remove(); label.remove();
            parking.remove();
            parkingSvg.remove();
            if (layers.hasLayer === hasLayer) layers.hasLayer = previousHasLayer;
            roots = [];
            boundsById.clear();
        },
    };
}
