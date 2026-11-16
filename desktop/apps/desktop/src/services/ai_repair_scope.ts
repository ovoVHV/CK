import type { AiPreview, AiProposal } from './ai_workspace';
import { sha256Hex } from './compile_source_map';

// This is an immutable repair boundary, not an interpretation of the user's
// whole request. It is established from the first candidate sent for validation.
export interface AiRepairScope {
    version: 1; mode: 'fields'; workspaceSha256: string;
    fields: Array<{ blockId: string; field: string }>;
}
const key = (r: { blockId: string; field: string }) => JSON.stringify([r.blockId, r.field]);
export function parseAiRepairScope(value: unknown): AiRepairScope {
    const s = value as AiRepairScope;
    if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).some(k => !['version','mode','workspaceSha256','fields'].includes(k))
        || s.version !== 1 || s.mode !== 'fields' || !/^[a-f0-9]{64}$/.test(s.workspaceSha256)
        || !Array.isArray(s.fields) || !s.fields.length || s.fields.length > 80
        || s.fields.some(r => !r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(k => !['blockId','field'].includes(k))
            || typeof r.blockId !== 'string' || !r.blockId || r.blockId.length > 256
            || typeof r.field !== 'string' || !r.field || r.field.length > 128)
        || new Set(s.fields.map(key)).size !== s.fields.length) throw Error('已保存的修复范围无效');
    return structuredClone(s);
}
export function checkAiRepairEdits(scope: AiRepairScope, proposal: Pick<AiProposal,'edits'|'variables'>) {
    const allowed = new Set(scope.fields.map(key));
    if (proposal.variables?.length || proposal.edits.some(e => e.action !== 'set_field' || !allowed.has(key(e)))) {
        throw Error('修复范围已固定：首次送验只修改既有字段，本任务只能修正这些字段；不能新增变量、积木、改连接或改其他字段来迎合测试。原工程未改。若固定测试有误或需求需要扩展，请report_blocker说明冲突，由用户新发需求；不能重置或降低验收。');
    }
}
function maskedState(snapshot: string, scope: AiRepairScope): string {
    const state = JSON.parse(snapshot), found = new Set<string>();
    const visitBlock = (b: any) => {
        if (!b) return;
        for (const target of scope.fields.filter(t => t.blockId === b.id)) {
            if (!b.fields || !Object.prototype.hasOwnProperty.call(b.fields,target.field)) throw Error('修复范围中的字段不存在');
            delete b.fields[target.field]; found.add(key(target));
        }
        for (const slot of Object.values(b.inputs || {}) as any[]) { visitBlock(slot.block); visitBlock(slot.shadow); }
        visitBlock(b.next?.block);
    };
    for (const b of state.blocks?.blocks || []) visitBlock(b);
    if (found.size !== scope.fields.length) throw Error('修复范围中的积木不存在');
    const ordered = (v: any): any => Array.isArray(v) ? v.map(ordered) : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map(k => [k,ordered(v[k])])) : v;
    return JSON.stringify(ordered(state));
}
export function lockAiRepairScope(prior: AiRepairScope | undefined, preview: AiPreview): AiRepairScope | undefined {
    if (!prior && (!preview.proposal.edits.length || preview.proposal.variables?.length || preview.proposal.edits.some(e => e.action !== 'set_field'))) return undefined;
    const scope = prior ? parseAiRepairScope(prior) : { version: 1 as const, mode: 'fields' as const, workspaceSha256: sha256Hex(preview.before),
        fields: [...new Map(preview.proposal.edits.filter(e => e.action === 'set_field').map(e => [key(e),{blockId:e.blockId,field:e.field}])).values()] };
    if (scope.workspaceSha256 !== sha256Hex(preview.before)) throw Error('修复范围与原工程身份不一致');
    checkAiRepairEdits(scope,preview.proposal);
    // A third-party field validator can mutate unrelated state. Check the real
    // serialized candidate too, rather than trusting the edit operation labels.
    if (maskedState(preview.before,scope) !== maskedState(preview.after,scope)) throw Error('字段修改引起范围外的结构或状态变化，未送验；请检查积木字段联动，不能把额外变化当作仅改字段。');
    return scope;
}
