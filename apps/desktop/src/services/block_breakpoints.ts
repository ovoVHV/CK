import * as Blockly from 'blockly';

type BreakpointListener = (breakpointIds: ReadonlySet<string>) => void;

const breakpointState = new WeakMap<Blockly.Workspace, Set<string>>();
const breakpointListeners = new WeakMap<Blockly.Workspace, Set<BreakpointListener>>();
const SERIALIZER_NAME = 'ckBreakpoints';

const getMutableState = (workspace: Blockly.Workspace): Set<string> => {
    let state = breakpointState.get(workspace);
    if (!state) {
        state = new Set<string>();
        breakpointState.set(workspace, state);
    }
    return state;
};

const notify = (workspace: Blockly.Workspace): void => {
    const snapshot = new Set(getMutableState(workspace));
    breakpointListeners.get(workspace)?.forEach((listener) => listener(snapshot));
};

const ensureSerializerRegistered = (): void => {
    const globalState = globalThis as typeof globalThis & { __ckBreakpointSerializerRegistered?: boolean };
    if (globalState.__ckBreakpointSerializerRegistered) return;

    try {
        Blockly.serialization.registry.register(SERIALIZER_NAME, {
            priority: 40,
            save(workspace) {
                const ids = Array.from(getMutableState(workspace))
                    .filter((blockId) => Boolean(workspace.getBlockById(blockId)))
                    .sort();
                return ids.length > 0 ? { ids } : null;
            },
            load(state: object, workspace) {
                const rawIds = Array.isArray((state as { ids?: unknown[] })?.ids)
                    ? (state as { ids: unknown[] }).ids
                    : [];
                breakpointState.set(workspace, new Set(
                    rawIds
                        .map((value) => String(value || ''))
                        .filter((blockId) => blockId && Boolean(workspace.getBlockById(blockId))),
                ));
                notify(workspace);
            },
            clear(workspace) {
                breakpointState.set(workspace, new Set());
                notify(workspace);
            },
        });
        globalState.__ckBreakpointSerializerRegistered = true;
    } catch (error) {
        // Vite HMR can preserve Blockly's registry while re-evaluating this module.
        if (!String(error).toLowerCase().includes('already')) throw error;
        globalState.__ckBreakpointSerializerRegistered = true;
    }
};

ensureSerializerRegistered();

export const getBlockBreakpoints = (workspace: Blockly.Workspace): Set<string> => (
    new Set(getMutableState(workspace))
);

export const hasBlockBreakpoint = (workspace: Blockly.Workspace, blockId: string): boolean => (
    getMutableState(workspace).has(blockId)
);

export const setBlockBreakpoint = (
    workspace: Blockly.Workspace,
    blockId: string,
    enabled: boolean,
): void => {
    const state = getMutableState(workspace);
    if (enabled) state.add(blockId);
    else state.delete(blockId);
    notify(workspace);
};

export const toggleBlockBreakpoint = (workspace: Blockly.Workspace, blockId: string): boolean => {
    const nextEnabled = !hasBlockBreakpoint(workspace, blockId);
    setBlockBreakpoint(workspace, blockId, nextEnabled);
    return nextEnabled;
};

export const clearBlockBreakpoints = (workspace: Blockly.Workspace): void => {
    breakpointState.set(workspace, new Set());
    notify(workspace);
};

export const subscribeBlockBreakpoints = (
    workspace: Blockly.Workspace,
    listener: BreakpointListener,
): (() => void) => {
    let listeners = breakpointListeners.get(workspace);
    if (!listeners) {
        listeners = new Set();
        breakpointListeners.set(workspace, listeners);
    }
    listeners.add(listener);
    listener(getBlockBreakpoints(workspace));
    return () => {
        listeners?.delete(listener);
    };
};

const createBreakpointDot = (root: SVGElement): SVGCircleElement => {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('class', 'ck-block-breakpoint-dot');
    dot.setAttribute('cx', '8');
    dot.setAttribute('cy', '8');
    dot.setAttribute('r', '5');
    dot.setAttribute('aria-hidden', 'true');
    root.appendChild(dot);
    return dot;
};

export const refreshBlockBreakpointVisuals = (
    workspace: Blockly.WorkspaceSvg,
    breakpointIds: ReadonlySet<string>,
    pausedBlockId: string | null = null,
): void => {
    for (const block of workspace.getAllBlocks(false)) {
        const root = block.getSvgRoot();
        if (!root) continue;
        const hasBreakpoint = breakpointIds.has(block.id);
        const isPaused = block.id === pausedBlockId;
        root.classList.toggle('ck-block-has-breakpoint', hasBreakpoint);
        root.classList.toggle('ck-block-debug-paused', isPaused);

        const existingDot = root.querySelector<SVGCircleElement>(':scope > .ck-block-breakpoint-dot');
        if (hasBreakpoint && !existingDot) createBreakpointDot(root);
        if (!hasBreakpoint && existingDot) existingDot.remove();
    }
};
