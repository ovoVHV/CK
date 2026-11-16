import { sha256Hex } from './compile_source_map';
import { parseAiAcceptance, type AiAcceptance } from './ai_acceptance';
import { expandAiBlockGraph, parseAiProposal, validateAiVariables, type AiGraphNode, type AiProposal } from './ai_workspace';
import type { AiLibraryDraft } from './ai_library_authoring';
import { parseAiRepairScope, checkAiRepairEdits, type AiRepairScope } from './ai_repair_scope';

// This is an encrypted local draft, not authority to apply/install or reuse
// compilation evidence. A resumed task rechecks all identities and recompiles.
export interface AiTaskCheckpoint {
    version: 1; id: string; updatedAt: number; status: 'working' | 'paused' | 'ready'; prompt: string;
    workspaceSha256: string; target: string; libraries: string;
    plan: string[]; acceptance?: AiAcceptance; edits: AiProposal['edits']; variables: NonNullable<AiProposal['variables']>;
    nodes: AiGraphNode[]; placements: Array<Record<string, unknown>>; checkedTypes: string[]; observed: string[];
    libraryDraft?: AiLibraryDraft; installedLibraries: Array<{ packageId: string; name: string; version: string; types: string[]; contentSha256: string }>;
    projectAttempts: number; libraryAttempts: number;
    lastFailure?: { tool: string; result: Record<string, unknown>; note: string };
    repairScope?: AiRepairScope;
}
export function validateAiCheckpoint(value: unknown): AiTaskCheckpoint {
    const v = value as AiTaskCheckpoint;
    if (!v || v.version !== 1 || !['working', 'paused', 'ready'].includes(v.status) || typeof v.id !== 'string'
        || typeof v.prompt !== 'string' || v.prompt.length > 12000 || !/^[a-f0-9]{64}$/.test(v.workspaceSha256)
        || typeof v.target !== 'string' || typeof v.libraries !== 'string' || JSON.stringify(v).length > 600000) throw Error('已保存任务格式无效，原记录保留');
    for (const key of ['plan','edits','variables','nodes','placements','checkedTypes','observed','installedLibraries'] as const) if (!Array.isArray(v[key])) throw Error('已保存任务缺少必要数据');
    const string = (s: unknown, max: number) => typeof s === 'string' && s.length > 0 && s.length <= max;
    const uniqueStrings = (rows: unknown[], max: number) => rows.every(s => string(s, max)) && new Set(rows).size === rows.length;
    if (!Number.isSafeInteger(v.updatedAt) || v.updatedAt < 0 || v.plan.length > 6 || v.plan.some(s => !string(s,160))
        || v.nodes.length > 256 || v.placements.length > 40 || !uniqueStrings(v.checkedTypes,128) || !uniqueStrings(v.observed,256)
        || !Number.isInteger(v.projectAttempts) || v.projectAttempts < 0 || v.projectAttempts > 3 || !Number.isInteger(v.libraryAttempts) || v.libraryAttempts < 0 || v.libraryAttempts > 3) throw Error('已保存任务超出预算');
    validateAiVariables(v.variables);
    if (v.edits.length) parseAiProposal({ summary: '恢复暂存方案', edits: v.edits, variables: v.variables });
    if (v.acceptance) parseAiAcceptance(v.acceptance);
    if (v.repairScope) {
        const scope = parseAiRepairScope(v.repairScope);
        if (scope.workspaceSha256 !== v.workspaceSha256 || scope.fields.some(f => !v.observed.includes(f.blockId))) throw Error('恢复修复范围与工程或已读目标不一致');
        checkAiRepairEdits(scope,{edits:v.edits,variables:v.variables});
        if (v.nodes.length || v.placements.length || v.libraryDraft) throw Error('字段修复范围不能恢复结构或库草稿');
    }
    // Unplaced partial graphs may reference a later batch. Placed roots must
    // expand to exactly the saved edits, with distinct indexes and no cycles.
    let nodes = new Map<string,AiGraphNode>();
    for (let i=0;i<v.nodes.length;i+=40) nodes = expandAiBlockGraph({ summary:'核对恢复节点', nodes:v.nodes.slice(i,i+40), placements:[] },nodes).nodes;
    if (v.nodes.some(n => !v.checkedTypes.includes(n.type))) throw Error('恢复节点缺少已核对类型');
    const indexes = v.placements.map(p=>p?.editIndex);
    if (indexes.some(i=>!Number.isSafeInteger(i)||Number(i)<0||Number(i)>=v.edits.length) || new Set(indexes).size !== indexes.length) throw Error('恢复放置顺序无效');
    const ordered = (x: any): any => Array.isArray(x) ? x.map(ordered) : x && typeof x==='object' ? Object.fromEntries(Object.keys(x).sort().map(k=>[k,ordered(x[k])])) : x;
    if (v.placements.length) {
        const rebuilt = expandAiBlockGraph({summary:'核对恢复放置',nodes:[],placements:v.placements.map(({editIndex,...p})=>p)},nodes);
        if (rebuilt.proposal.edits.some((edit,i)=>JSON.stringify(ordered(edit))!==JSON.stringify(ordered(v.edits[Number(indexes[i])])))) throw Error('恢复图与暂存编辑不一致');
    }
    if (v.edits.some(e=>'blockId' in e && !v.observed.includes(e.blockId))) throw Error('恢复编辑缺少已读取的目标');
    if (v.installedLibraries.length>2 || v.installedLibraries.some(l=>!l||!string(l.packageId,128)||!string(l.name,256)||!string(l.version,80)
        || !/^[a-f0-9]{64}$/.test(l.contentSha256)||!Array.isArray(l.types)||l.types.length>24||!uniqueStrings(l.types,128))) throw Error('恢复库记录无效');
    if (v.libraryDraft && (!/^ck_ai_[a-f0-9]{12}$/.test(v.libraryDraft.id) || !Array.isArray(v.libraryDraft.blocks) || v.libraryDraft.blocks.length>24
        || !v.libraryDraft.files || typeof v.libraryDraft.files!=='object' || Array.isArray(v.libraryDraft.files) || Object.keys(v.libraryDraft.files).length>16
        || Object.entries(v.libraryDraft.files).some(([path,content])=>!/^src\/[A-Za-z][A-Za-z0-9_]{0,80}\.(?:h|hpp|c|cpp)$/.test(path)||typeof content!=='string'||content.length>48001))) throw Error('恢复库草稿无效');
    if (v.lastFailure && (!['propose_change','submit_library'].includes(v.lastFailure.tool) || !v.lastFailure.result || typeof v.lastFailure.result!=='object'
        || Array.isArray(v.lastFailure.result) || JSON.stringify(v.lastFailure).length>30000 || !string(v.lastFailure.note,240))) throw Error('恢复失败资料无效');
    return structuredClone(v);
}
export function checkAiResume(v: AiTaskCheckpoint, workspace: string, target: unknown, libraries: string) {
    validateAiCheckpoint(v);
    if (v.workspaceSha256 !== sha256Hex(workspace) || v.target !== JSON.stringify(target) || v.libraries !== libraries) throw Error('工程内容、板卡配置或库内容已变化，旧任务不能自动继续。草稿已保留，请基于当前工程新发需求。');
}
