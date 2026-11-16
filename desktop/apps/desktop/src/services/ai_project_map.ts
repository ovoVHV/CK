import type * as Blockly from 'blockly';
import type { BlockSearchEntry } from '../types/library';
import { sha256Hex } from './compile_source_map';
import { aiWorkspaceSnapshot } from './ai_workspace';

// Index live facts once per read; return only the requested page. Author
// metadata remains a declaration and never becomes a hardware-test result.
export function aiProjectMap(workspace: Blockly.Workspace, catalog: BlockSearchEntry[], target: unknown,
    args: { section?: unknown; offset?: unknown; query?: unknown } = {}) {
    const section = args.section || 'overview', offset = args.offset ?? 0;
    if (!['overview', 'variables', 'functions', 'libraries', 'hardware', 'blocks'].includes(String(section)) || !Number.isSafeInteger(offset) || Number(offset) < 0
        || (args.query != null && (typeof args.query !== 'string' || args.query.length > 160))) throw Error('工程地图查询参数无效');
    const all = workspace.getAllBlocks(false), entries = new Map(catalog.map(b => [b.type, b]));
    const typeCounts = new Map<string, number>();
    for (const b of all) typeCounts.set(b.type, (typeCounts.get(b.type) || 0) + 1);
    const variables = workspace.getVariableMap().getAllVariables().map(v => ({ name: v.getName(), type: v.getType(),
        references: workspace.getVariableUsesById(v.getId()).map(b => b.id) }));
    const functions = all.filter(b => typeof (b as any).getProcedureDef === 'function').map(b => ({ id: b.id, type: b.type, definition: (b as any).getProcedureDef() }));
    const libraries = new Map<string, { libraryId: string; types: string[]; blocks: number; dependencies: unknown[] }>();
    for (const [type, count] of typeCounts) {
        const entry = entries.get(type), id = entry?.library_id || '@toolbox';
        const row = libraries.get(id) || { libraryId: id, types: [], blocks: 0, dependencies: [] };
        row.types.push(type); row.blocks += count;
        for (const dep of entry?.dependencies || []) if (!row.dependencies.some(d => JSON.stringify(d) === JSON.stringify(dep))) row.dependencies.push(dep);
        libraries.set(id, row);
    }
    const summary = { workspaceSha256: sha256Hex(aiWorkspaceSnapshot(workspace)), target, blocks: all.length, types: typeCounts.size,
        variables: variables.length, functions: functions.length, libraries: libraries.size,
        roots: workspace.getTopBlocks(true).map(b => ({ id: b.id, type: b.type, label: b.toString(100), blocks: b.getDescendants(false).length })),
        note: '当前工作区事实；库依赖与资源来自作者声明，缺失不等于没有占用。不是编译/行为/硬件通过证明。' };
    if (section === 'overview') return { ...summary, sections: ['variables', 'functions', 'libraries', 'hardware', 'blocks'] };
    const rows = section === 'variables' ? variables : section === 'functions' ? functions : section === 'libraries' ? [...libraries.values()]
        : section === 'hardware' ? [...typeCounts].map(([type, count]) => ({ type, blocks: count, libraryId: entries.get(type)?.library_id || '@toolbox',
            resources: entries.get(type)?.hardware || null, status: entries.get(type)?.hardware ? 'author-declared' : 'undeclared' }))
        : all.map(b => ({ id: b.id, type: b.type, label: b.toString(100), rootId: b.getRootBlock().id }));
    const query = String(args.query || '').toLowerCase();
    const filtered = query ? rows.filter(r => JSON.stringify(r).toLowerCase().includes(query)) : rows;
    const page: unknown[] = [];
    for (const row of filtered.slice(Number(offset), Number(offset) + 16)) {
        if (JSON.stringify([...page, row]).length > 18000) break;
        page.push(row);
    }
    if (!page.length && Number(offset) < filtered.length) throw Error('单项信息过大，请通过积木文档工具分页查看');
    return { workspaceSha256: summary.workspaceSha256, section, total: filtered.length, rows: page,
        nextOffset: Number(offset) + page.length < filtered.length ? Number(offset) + page.length : null, note: summary.note };
}
