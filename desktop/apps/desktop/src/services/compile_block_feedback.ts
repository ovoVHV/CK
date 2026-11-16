import { Events, type BlockSvg, type WorkspaceSvg } from 'blockly';

const WARNING_ID = 'ck-compile-error';
const ERROR_CLASS = 'ck-block-compile-error';

/** Keep compiler feedback separate from warnings supplied by block libraries. */
export function markCompileError(block: BlockSvg, message: string): void {
    block.setWarningText(message, WARNING_ID);
    (block as BlockSvg & { __ckCompileError?: boolean }).__ckCompileError = true;
    block.getSvgRoot()?.classList.add(ERROR_CLASS);
}

export function clearCompileErrors(workspace: WorkspaceSvg): void {
    for (const block of workspace.getAllBlocks(false)) {
        const marked = block as BlockSvg & { __ckCompileError?: boolean };
        if (!marked.__ckCompileError) continue;
        block.setWarningText(null, WARNING_ID);
        marked.__ckCompileError = false;
        block.getSvgRoot()?.classList.remove(ERROR_CLASS);
    }
}

export function revealCompileError(workspace: WorkspaceSvg, blockId: string): void {
    const block = workspace.getBlockById(blockId);
    if (!block) return;
    // A diagnostic in a collapsed statement must be visible when located.
    // This is presentation-only. Emitting a change event would invalidate the
    // just-proved compile result and clear its warning while revealing it.
    Events.disable();
    try {
        const visited = new Set<BlockSvg>();
        for (let parent = block.getSurroundParent(); parent && !visited.has(parent); parent = parent.getSurroundParent()) {
            visited.add(parent);
            if (parent.isCollapsed()) parent.setCollapsed(false);
        }
        if (block.isCollapsed()) block.setCollapsed(false);
    } finally {
        Events.enable();
    }
    workspace.centerOnBlock(blockId);
}
