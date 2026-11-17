import * as Blockly from 'blockly';

/** Saved by the workspace serializer so saves, checkpoints and recovery drafts
 * keep both programs together. Never attempt to translate arbitrary C++ to blocks. */
export interface WorkspaceSource {
    version: 1;
    mode: 'blocks' | 'source';
    code: string;
    generatedBase: string;
}
export const SOURCE_SERIALIZER = 'ckSource';
const states = new WeakMap<Blockly.Workspace, WorkspaceSource>();
const listeners = new WeakMap<Blockly.Workspace, (state: WorkspaceSource | null) => void>();

export function readWorkspaceSource(value: unknown): WorkspaceSource {
    const v = value as WorkspaceSource;
    if (!v || v.version !== 1 || !['blocks', 'source'].includes(v.mode)
        || typeof v.code !== 'string' || typeof v.generatedBase !== 'string'
        || [v.code, v.generatedBase].some(code => code.includes('\0') || new TextEncoder().encode(code).length > 1024 * 1024)) {
        throw new Error('工程中的源码编辑数据无效或版本不受支持，已停止载入以保护原文件。');
    }
    return { version: 1, mode: v.mode, code: v.code, generatedBase: v.generatedBase };
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
    // Refresh an untouched preview, but retain every manual edit even after blocks change.
    return readWorkspaceSource(previous && previous.code !== previous.generatedBase
        ? { ...previous, mode: 'source' }
        : { version: 1, mode: 'source', code: generated, generatedBase: generated });
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
