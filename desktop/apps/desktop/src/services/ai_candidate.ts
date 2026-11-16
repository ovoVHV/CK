import * as Blockly from 'blockly';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { analyzeCompileIssues } from './compile_issue_cards';
import { freezeCompileSourceMap, resolveTrustedCompileDiagnosticFile, lookupCompileSourceMap, sha256Hex, type TrustedCompileSketchAliasV1 } from './compile_source_map';
import type { AiPreview } from './ai_workspace';
import type { ProjectBuildTarget } from './project_build_target';
import type { AiFirmware } from './ai_acceptance';

export interface AiCandidateResult {
    ok: boolean;
    runId: string;
    sourceSha256: string;
    elapsedMs: number;
    log: string;
    diagnostics: Array<{ message: string; line: number | null; blockId?: string; blockType?: string; label?: string }>;
    artifactCount: number;
    firmware?: AiFirmware;
}
export interface AiValidationRecord extends AiCandidateResult { attempt: number; scope?: 'library' | 'project'; label?: string }
export interface AiTaskProgress { text: string; elapsedMs: number }
export type AiValidateCandidate = (preview: AiPreview, context: {
    candidateId: string; signal: AbortSignal; onStep: (text: string) => void; captureFirmware?: boolean;
}) => Promise<AiCandidateResult>;

// Generation runs synchronously in a headless workspace. No live Blockly
// state or generator state is held across an await.
export function generateAiCandidate(preview: AiPreview, generate: (ws: Blockly.Workspace) => string) {
    const workspace = new Blockly.Workspace();
    Blockly.Events.disable();
    try {
        Blockly.serialization.workspaces.load(JSON.parse(preview.after), workspace);
        const code = generate(workspace);
        if (!code.trim()) throw new Error('候选积木未生成可编译代码');
        const labels = new Map(workspace.getAllBlocks(false).map(b => [b.id, b.toString(120)]));
        return { code, labels, sourceMap: freezeCompileSourceMap(code, { file: 'sketch.ino' }) };
    } finally { workspace.dispose(); Blockly.Events.enable(); }
}

export async function compileAiCandidate(input: {
    preview: AiPreview; target: ProjectBuildTarget; candidateId: string; signal: AbortSignal;
    generate: (ws: Blockly.Workspace) => string; onStep: (text: string) => void; captureFirmware?: boolean;
}): Promise<AiCandidateResult> {
    const { code, labels, sourceMap } = generateAiCandidate(input.preview, input.generate);
    return compileAiSource({ ...input, code, labels, sourceMap });
}

export async function compileAiSource(input: {
    code: string; target: ProjectBuildTarget; candidateId: string; signal: AbortSignal;
    onStep: (text: string) => void; libraryToken?: string;
    labels?: Map<string, string>; sourceMap?: ReturnType<typeof freezeCompileSourceMap>; captureFirmware?: boolean;
}): Promise<AiCandidateResult> {
    const { signal, target } = input;
    signal.throwIfAborted();
    if (!target.optionsComplete || !target.coreVersion) throw new Error('板卡和核心版本尚未就绪，未开始候选编译');
    const code = input.code, labels = input.labels || new Map<string,string>();
    const sourceMap = input.sourceMap || freezeCompileSourceMap(code, { file: 'sketch.ino' });
    const runId = crypto.randomUUID();
    let alias: TrustedCompileSketchAliasV1 | undefined;
    let lastStep = '';
    const unlisten = await listen<{ runId: string; message?: string; alias?: TrustedCompileSketchAliasV1 }>('ai-candidate-progress', event => {
        if (event.payload.runId !== runId || signal.aborted) return;
        if (event.payload.alias) alias = event.payload.alias;
        if (event.payload.message && event.payload.message !== lastStep) {
            lastStep = event.payload.message;
            input.onStep(`候选编译：${lastStep}`);
        }
    });
    let cancellation: Promise<unknown> | undefined;
    let settled = false;
    // Cancellation may arrive before the native request has acquired its guards
    // and registered a run. Retry until the request settles, including that gap.
    const cancel = () => { cancellation ||= (async () => {
        while (!settled) {
            await invoke('cancel_foreground_build', { runId }).catch(() => undefined);
            if (!settled) await new Promise(resolve => setTimeout(resolve, 100));
        }
    })(); };
    signal.addEventListener('abort', cancel, { once: true });
    const start = performance.now();
    try {
        signal.throwIfAborted();
        const raw = await invoke<string>('compile_ai_candidate', {
            candidateId: input.candidateId, runId, code, fqbn: target.fqbn,
            boardPackageId: target.boardPackageId, coreVersion: target.coreVersion,
            sourceMapJson: JSON.stringify(sourceMap),
            libraryToken: input.libraryToken,
            captureFirmware: input.captureFirmware || false,
        });
        signal.throwIfAborted();
        const result = JSON.parse(raw);
        if (result.runId !== runId || result.sourceSha256 !== sha256Hex(code)
            || typeof result.ok !== 'boolean' || typeof result.log !== 'string'
            || (result.ok && !(result.artifactCount > 0))) throw new Error('候选编译结果与当前请求不一致');
        // The native response carries the final alias as well as events; event
        // delivery order cannot promote an ambiguous path into a block match.
        alias = result.alias;
        const diagnostics = analyzeCompileIssues({ log: result.log, fqbn: target.fqbn }).slice(0, 12).map(issue => {
            const file = resolveTrustedCompileDiagnosticFile({ alias, runId, sourceMap, diagnosticFile: issue.sourceFile || '' });
            const mapping = file && issue.sourceLine ? lookupCompileSourceMap(sourceMap, { file, line: issue.sourceLine, codeSha256: sourceMap.codeSha256, acceptedConfidences: ['exact', 'high'] }) : null;
            return { message: issue.rawDiagnostic, line: issue.sourceLine,
                ...(mapping ? { blockId: mapping.blockId, blockType: mapping.blockType, label: labels.get(mapping.blockId) } : {}) };
        });
        return { ok: result.ok, runId, sourceSha256: sourceMap.codeSha256, elapsedMs: Math.round(performance.now() - start),
            log: result.log, artifactCount: result.artifactCount || 0, diagnostics, ...(result.firmware ? { firmware: result.firmware } : {}) };
    } finally {
        settled = true;
        signal.removeEventListener('abort', cancel);
        await cancellation;
        unlisten();
    }
}
