import * as Blockly from 'blockly';
import { MAX_SOURCE_BYTES, mergeSource, resolveSourceMerge } from './source_merge';

/** Saved by the workspace serializer so saves, checkpoints and recovery drafts
 * keep both programs together. Never attempt to translate arbitrary C++ to blocks. */
export interface WorkspaceSource {
    version: 1;
    mode: 'blocks' | 'source';
    code: string;
    generatedBase: string;
    pendingGenerated?: string;
}
export const SOURCE_SERIALIZER = 'ckSource';
const states = new WeakMap<Blockly.Workspace, WorkspaceSource>();
const listeners = new WeakMap<Blockly.Workspace, (state: WorkspaceSource | null) => void>();

export function readWorkspaceSource(value: unknown): WorkspaceSource {
    const v = value as WorkspaceSource;
    if (!v || v.version !== 1 || !['blocks', 'source'].includes(v.mode)
        || typeof v.code !== 'string' || typeof v.generatedBase !== 'string'
        || (v.pendingGenerated !== undefined && typeof v.pendingGenerated !== 'string')
        || [v.code, v.generatedBase, ...(v.pendingGenerated === undefined ? [] : [v.pendingGenerated])].some(code => code.includes('\0') || new TextEncoder().encode(code).length > MAX_SOURCE_BYTES)) {
        throw new Error('工程中的源码编辑数据无效或版本不受支持，已停止载入以保护原文件。');
    }
    return { version: 1, mode: v.mode, code: v.code, generatedBase: v.generatedBase,
        ...(v.pendingGenerated === undefined ? {} : { pendingGenerated: v.pendingGenerated }) };
}
export const getWorkspaceSource = (workspace: Blockly.Workspace | null) => workspace ? states.get(workspace) || null : null;
export function setWorkspaceSource(workspace: Blockly.Workspace, state: WorkspaceSource | null) {
    const next = state ? readWorkspaceSource(state) : null;
    if (next) states.set(workspace, next); else states.delete(workspace);
    listeners.get(workspace)?.(next);
}
export function subscribeWorkspaceSource(workspace: Blockly.Workspace, listener: (state: WorkspaceSource | null) => void) {
    listeners.set(workspace, listener);
    listener(getWorkspaceSource(workspace));
    return () => { listeners.delete(workspace); };
}
export function selectSourceMode(previous: WorkspaceSource | null, generated: string): WorkspaceSource {
    return { ...syncSourceWithBlocks(previous, generated), mode: 'source' };
}
export function syncSourceWithBlocks(previous: WorkspaceSource | null, generated: string): WorkspaceSource {
    if (!previous) return readWorkspaceSource({ version: 1, mode: 'blocks', code: generated, generatedBase: generated });
    if (previous.generatedBase === generated) {
        const { pendingGenerated: _pending, ...state } = previous;
        return previous.pendingGenerated === undefined ? previous : state;
    }
    if (previous.pendingGenerated === generated) return previous;
    const merged = mergeSource(previous.generatedBase, previous.code, generated);
    if (merged.conflicts.length) return readWorkspaceSource({ ...previous, pendingGenerated: generated });
    const { pendingGenerated: _pending, ...state } = previous;
    const code = resolveSourceMerge(merged, {});
    return readWorkspaceSource({ ...state, code, generatedBase: generated });
}
export function syncWorkspaceSource(workspace: Blockly.Workspace, generated: string) {
    const previous = getWorkspaceSource(workspace);
    if (!previous) return;
    const next = syncSourceWithBlocks(previous, generated);
    if (next !== previous) setWorkspaceSource(workspace, next);
}
export function resolveWorkspaceSource(previous: WorkspaceSource, choices: Record<number, 'manual' | 'generated'>): WorkspaceSource {
    if (previous.pendingGenerated === undefined) return previous;
    const code = resolveSourceMerge(mergeSource(previous.generatedBase, previous.code, previous.pendingGenerated), choices);
    return readWorkspaceSource({ version: 1, mode: previous.mode, code, generatedBase: previous.pendingGenerated });
}
export function workspaceCompileCode(workspace: Blockly.Workspace, generate: (ws: Blockly.Workspace) => string): string {
    const state = getWorkspaceSource(workspace);
    return state?.mode === 'source' ? state.code : generate(workspace);
}

Blockly.serialization.registry.register(SOURCE_SERIALIZER, {
    priority: 0,
    save: workspace => { const state = getWorkspaceSource(workspace); return state ? { ...state } : null; },
    load: (state, workspace) => setWorkspaceSource(workspace, readWorkspaceSource(state)),
    clear: workspace => setWorkspaceSource(workspace, null),
});
