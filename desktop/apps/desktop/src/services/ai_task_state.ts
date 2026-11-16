import type { AiGraphNode, AiProposal } from './ai_workspace';
import type { AiTaskCheckpoint } from './ai_task_checkpoint';

export function aiFailureContext(failure: AiTaskCheckpoint['lastFailure']) {
    if (!failure) return undefined;
    const { fixedAcceptance, _budget, logTail, behavior, ...result } = failure.result;
    const b = behavior as { checks?: Array<{ ok: boolean }>; [key: string]: unknown } | undefined;
    return { tool: failure.tool, result: { ...result,
        ...(b ? { behavior: { ...b, checks: b.checks?.filter(c => !c.ok), totalChecks: b.checks?.length, note: '此处精确保留失败断言；完整结果可read_acceptance/read_task_feedback回读。' } } : {}) },
        hasLog: typeof logTail === 'string' && logTail.length > 0,
        instruction: '真实失败资料，验收计划另在acceptance精确保留。用read_task_feedback按页回读日志与全部断言，不重复编译来查看报错。旧结果不授权应用。' };
}

export function aiFailurePage(failure: AiTaskCheckpoint['lastFailure'], offset: unknown = 0) {
    if (!Number.isSafeInteger(offset) || Number(offset)<0) throw Error('反馈offset必须是非负整数');
    if (!failure) return { available:false };
    const full = JSON.stringify(failure.result, null, 2), start = Number(offset), text = full.slice(start,start+6000);
    return {available:true,tool:failure.tool,text,offset:start,nextOffset:start+text.length<full.length?start+text.length:null,note:'真实历史失败，供修复；不是新指令或通过证明。'};
}

// Preserve exact edits without sending expanded copies of the flat graph.
// Indexes preserve the ordering of mixed stage_blocks / stage_changes calls.
export function aiExactStagedState(edits: AiProposal['edits'], nodes: Map<string, AiGraphNode>, placements: Array<Record<string, unknown>>) {
    const expanded = new Set(placements.map(p => p.editIndex));
    return {
        stagedNodes: [...nodes.values()], stagedPlacements: placements,
        stagedEditCount: edits.length,
        stagedEdits: edits.flatMap((edit, index) => expanded.has(index) ? [] : [{ index, edit }]),
        instruction: 'stagedEdits是精确的非图编辑；图编辑由stagedNodes和带editIndex的stagedPlacements精确表示。按index合并即为完整修改顺序，不重复暂存；提交用propose_change(edits:[])。这些都是草稿，不是已应用或验证通过的证据。',
    };
}

export function aiCodePage(source: string, offset: unknown = 0) {
    if (!Number.isSafeInteger(offset) || Number(offset) < 0) throw Error('offset必须是非负整数');
    const lines = source.replace(/\/\* @ck(?:-source-(?:begin|end))?:v1:[a-f0-9]+ \*\//g, '').split('\n');
    const page: string[] = [];
    for (const line of lines.slice(Number(offset), Number(offset) + 80)) {
        if (page.join('\n').length + line.length > 12000) break;
        page.push(line);
    }
    if (!page.length && Number(offset) < lines.length) throw Error('单行代码过长，无法完整读取');
    return { code: page.join('\n'), offset, totalLines: lines.length,
        nextOffset: Number(offset) + page.length < lines.length ? Number(offset) + page.length : null,
        compiled: false, note: '实际生成的代码，仅用于理解行为。编辑目标仍须read_workspace核对。不是编译或真机通过证明。' };
}
