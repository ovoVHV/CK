import * as Blockly from 'blockly';

type WorkspaceState = ReturnType<typeof Blockly.serialization.workspaces.save>;
export type BlocklyLoadProgress = { completed: number; total: number; phase: 'blocks' | 'code' };

export function countSerializedBlocks(state: WorkspaceState): number {
    const pending = [...(state.blocks?.blocks || [])];
    let count = 0;
    while (pending.length) {
        const block = pending.pop();
        if (!block || typeof block !== 'object') continue;
        count++;
        if (block.next?.block) pending.push(block.next.block);
        if (block.next?.shadow) pending.push(block.next.shadow);
        for (const input of Object.values(block.inputs || {}) as any[]) {
            if (input.block) pending.push(input.block);
            if (input.shadow) pending.push(input.shadow);
        }
    }
    return count;
}

/** Same registered serializers, priority ordering and block append as Blockly
 * 12.3.1. Only top-level stack scheduling changes. No alternate project format,
 * field reconstruction, ID reassignment or generator implementation.
 * Events are suppressed only inside synchronous slices, never across awaits.
 */
export async function loadBlocklyWorkspaceProgressively(
    state: WorkspaceState,
    workspace: Blockly.WorkspaceSvg,
    options: {
        signal?: AbortSignal;
        isCurrent?: () => boolean;
        onProgress?: (progress: BlocklyLoadProgress) => void;
        stageStack?: (block: Blockly.BlockSvg) => void;
        yieldToHost?: () => Promise<void>;
    } = {},
) {
    const serializers = Object.entries(Blockly.registry.getAllItems(Blockly.registry.Type.SERIALIZER, true) || {})
        .filter((entry): entry is [string, Blockly.serialization.ISerializer] => Boolean(entry[1]) && typeof entry[1] === 'object')
        .sort((a, b) => b[1].priority - a[1].priority);
    const blockSerializer = serializers.find(([name]) => name === 'blocks')?.[1];
    const total = countSerializedBlocks(state);
    const check = () => {
        if (options.signal?.aborted || options.isCurrent?.() === false) throw new DOMException('Workspace load cancelled', 'AbortError');
    };
    check();
    if (total < 2000 || !blockSerializer
        || Object.getPrototypeOf(blockSerializer) !== Blockly.serialization.blocks.BlockSerializer.prototype
        || blockSerializer.load !== Blockly.serialization.blocks.BlockSerializer.prototype.load) {
        Blockly.serialization.workspaces.load(state, workspace);
        return { progressive: false, total };
    }
    const slice = (work: () => void) => {
        check();
        const recordUndo = Blockly.Events.getRecordUndo();
        const group = Blockly.Events.getGroup();
        Blockly.Events.disable();
        Blockly.Events.setRecordUndo(false);
        try { work(); }
        finally {
            Blockly.Events.setGroup(group);
            Blockly.Events.setRecordUndo(recordUndo);
            Blockly.Events.enable();
        }
    };
    const yieldToHost = options.yieldToHost || (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    workspace.setResizesEnabled(false);
    Blockly.utils.dom.startTextWidthCache();
    let completed = 0;
    try {
        slice(() => { for (const [, serializer] of [...serializers].reverse()) serializer.clear(workspace); });
        for (const [name, serializer] of serializers) {
            if (!state[name]) continue;
            if (name !== 'blocks') { slice(() => serializer.load(state[name], workspace)); continue; }
            for (const stack of state.blocks.blocks) {
                slice(() => {
                    const block = Blockly.serialization.blocks.append(stack, workspace, { recordUndo: false });
                    options.stageStack?.(block as Blockly.BlockSvg);
                    completed += countSerializedBlocks({blocks:{blocks:[stack]}});
                });
                options.onProgress?.({completed, total, phase:'blocks'});
                await yieldToHost();
                check();
            }
        }
        check();
        Blockly.Events.fire(new Blockly.Events.FinishedLoading(workspace));
        return { progressive: true, total };
    } finally {
        Blockly.utils.dom.stopTextWidthCache();
        // The owner may have navigated away while a slice yielded.
        if (options.isCurrent?.() !== false) workspace.setResizesEnabled(true);
    }
}
