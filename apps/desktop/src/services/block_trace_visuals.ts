import type { BlockTraceSnapshot } from './block_trace';

interface TraceVisualBlockLike {
    id: string;
    getSvgRoot: () => SVGElement | null;
}

interface TraceVisualWorkspaceLike {
    getAllBlocks: (ordered?: boolean) => TraceVisualBlockLike[];
}

/** Apply or remove the sampled coverage overlay without changing block colour data. */
export const refreshBlockTraceVisuals = (
    workspace: TraceVisualWorkspaceLike,
    snapshot: BlockTraceSnapshot | null,
): void => {
    const stats = new Map(snapshot?.stats.map(stat => [stat.blockId, stat]) || []);
    for (const block of workspace.getAllBlocks(false)) {
        const root = block.getSvgRoot();
        if (!root) continue;
        const stat = stats.get(block.id);
        root.classList.toggle('ck-block-trace-pending', Boolean(stat && !stat.covered));
        root.classList.toggle('ck-block-trace-covered', Boolean(stat?.covered));
        if (stat) {
            root.setAttribute('data-ck-trace-hits', String(stat.sampledHits));
            root.setAttribute(
                'data-ck-trace-label',
                `${stat.label}，${stat.covered ? `采样命中 ${stat.sampledHits} 次` : '尚未采样命中'}`,
            );
        } else {
            root.removeAttribute('data-ck-trace-hits');
            root.removeAttribute('data-ck-trace-label');
        }
    }
};
