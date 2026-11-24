import { invoke } from '@tauri-apps/api/core';
import type { ForegroundBuildEvidence } from '../components/CompileProgressOverlay';
import { normalizeLinkerMapResourceSummary } from './compile_resources';
import type { CompileDiagnosticsPayload } from './compile_doctor';
import { parseSuccessfulUploadResult } from './upload_result';

export function createNativeBuildRequest(buildEvidence: ForegroundBuildEvidence, code: string,
    projectId: string, projectPath: string, sourceMapJson: string | null) {
    return Object.freeze({code, fqbn: buildEvidence.fqbn, boardPackageId: buildEvidence.boardPackageId,
        runId: buildEvidence.runId, workspaceFingerprint: buildEvidence.workspaceFingerprint, projectId, projectPath, sourceMapJson});
}
type NativeBuildRequest = ReturnType<typeof createNativeBuildRequest>;

export async function compileProject(request: NativeBuildRequest) {
    const raw = await invoke<string>('compile_sketch', {...request});
    // Older hosts returned the artifact path directly.
    let result;
    try { result = JSON.parse(raw); } catch { result = {path: raw}; }
    return {
        path: typeof result?.path === 'string' ? result.path as string : '',
        log: typeof result?.log === 'string' ? result.log as string : '',
        artifacts: Array.isArray(result?.artifacts) ? result.artifacts.map(String) as string[] : [],
        diagnostics: result?.diagnostics && typeof result.diagnostics === 'object' ? result.diagnostics as CompileDiagnosticsPayload : null,
        sourceMapPath: typeof result?.sourceMapPath === 'string' ? result.sourceMapPath as string : '',
        linkerMapSummary: normalizeLinkerMapResourceSummary(result?.linkerMapSummary, String(result?.diagnostics?.fqbn || request.fqbn)),
        resourceBoardIdentity: result?.resourceBoardIdentity as unknown,
    };
}

export async function uploadProject(request: NativeBuildRequest, options: {port: string; probeMemory: boolean;
    lastWorkingVersion: Record<string, unknown> | null; expectedMemberIdentity?: string}) {
    const raw = await invoke<string>('upload_sketch', {...request, ...options, structuredResult: true});
    return parseSuccessfulUploadResult(raw, request);
}
