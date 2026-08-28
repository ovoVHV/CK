import { invoke } from '@tauri-apps/api/core';

export const RECOVERY_DRAFT_SCHEMA_VERSION = 1;
export const MAX_RECOVERY_DRAFTS_PER_PROJECT = 3;

export interface ProjectRecoveryBaseline {
    projectPath: string;
    projectId: string;
    sha256: string;
    modifiedAt: string | null;
    byteSize: number;
}

export interface RecoveryDraftState {
    workspaceJson: string;
    sourceCode: string;
    board: string;
    fqbn: string;
    boardPackageId?: string;
    options: string;
}

export interface SaveRecoveryDraftInput extends RecoveryDraftState {
    projectPath: string;
    /** A stable domain id when the project format provides one. */
    projectId?: string;
    /**
     * Capture this when the formal project is loaded or saved. If omitted,
     * the service asks Rust for the current on-disk baseline immediately
     * before saving the draft.
     */
    diskBaseline?: Pick<ProjectRecoveryBaseline, 'sha256' | 'modifiedAt'>;
}

export interface RecoveryDraftMetadata {
    schemaVersion: number;
    id: string;
    projectId: string;
    projectPath: string;
    projectName: string;
    createdAt: string;
    diskBaselineHash: string;
    diskBaselineModifiedAt: string | null;
    fullStateHash: string;
    board: string;
    fqbn: string;
    boardPackageId: string;
    options: string;
    byteSize: number;
}

export interface RecoveryDraft {
    schemaVersion: number;
    id: string;
    projectId: string;
    projectPath: string;
    projectName: string;
    createdAt: string;
    diskBaselineHash: string;
    diskBaselineModifiedAt: string | null;
    fullStateHash: string;
    workspaceJson: string;
    sourceCode: string;
    board: string;
    fqbn: string;
    boardPackageId: string;
    options: string;
}

export interface CurrentRecoveryComparison {
    diskBaselineHash: string;
    diskModifiedAt: string | null;
    fullStateHash: string;
}

export interface RecoveryOfferSessionDecision {
    sessionKey: string;
    suppressed: boolean;
    candidate: RecoveryDraftMetadata | null;
}

export interface RecoveryProjectSession {
    projectPath: string;
    loadKey: string;
    revision: number;
}

const requireProjectPath = (projectPath: string): string => {
    const path = String(projectPath || '').trim();
    if (!path) throw new Error('当前工程还没有可用于恢复稿的路径');
    return path;
};

const normalizeState = (input: RecoveryDraftState): Required<RecoveryDraftState> => ({
    workspaceJson: String(input.workspaceJson || ''),
    sourceCode: String(input.sourceCode || ''),
    board: String(input.board || '').trim(),
    fqbn: String(input.fqbn || '').trim(),
    boardPackageId: String(input.boardPackageId || input.board || '').trim(),
    options: String(input.options || '{}'),
});

/**
 * The array order is the recovery-drafts-v1 hash contract shared with Rust.
 * Exact opaque Blockly/options strings are intentional: recovery must not
 * normalize away third-party serializer state.
 */
export const recoveryDraftFullStatePayload = (input: RecoveryDraftState): string => {
    const state = normalizeState(input);
    return JSON.stringify([
        'recovery-draft-full-state-v1',
        state.workspaceJson,
        state.sourceCode,
        state.board,
        state.fqbn,
        state.boardPackageId,
        state.options,
    ]);
};

const sha256 = async (value: string): Promise<string> => {
    if (!globalThis.crypto?.subtle) {
        throw new Error('当前运行环境不支持恢复稿 SHA-256 校验');
    }
    const digest = await globalThis.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(value),
    );
    const hex = Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
    return `sha256:${hex}`;
};

export const computeRecoveryDraftFullStateHash = async (
    input: RecoveryDraftState,
): Promise<string> => sha256(recoveryDraftFullStatePayload(input));

export const getProjectRecoveryBaseline = async (
    projectPath: string,
    projectId?: string,
): Promise<ProjectRecoveryBaseline> => invoke<ProjectRecoveryBaseline>(
    'get_project_recovery_baseline',
    {
        projectPath: requireProjectPath(projectPath),
        projectId: String(projectId || '').trim() || null,
    },
);

export const saveRecoveryDraft = async (
    input: SaveRecoveryDraftInput,
): Promise<RecoveryDraftMetadata> => {
    const projectPath = requireProjectPath(input.projectPath);
    const state = normalizeState(input);
    if (!state.board || !state.fqbn) {
        throw new Error('恢复稿需要明确的板卡和完整 FQBN');
    }
    // Validate shape without changing the exact strings sent to Rust.
    const workspace = JSON.parse(state.workspaceJson) as unknown;
    if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
        throw new Error('恢复稿的 Blockly 数据必须是 JSON 对象');
    }
    JSON.parse(state.options);

    const projectId = String(input.projectId || '').trim() || undefined;
    const baseline = input.diskBaseline || await getProjectRecoveryBaseline(
        projectPath,
        projectId,
    );
    const expectedFullStateHash = await computeRecoveryDraftFullStateHash(state);
    return invoke<RecoveryDraftMetadata>('save_recovery_draft', {
        input: {
            projectPath,
            projectId: projectId || null,
            diskBaselineHash: baseline.sha256,
            diskBaselineModifiedAt: baseline.modifiedAt || null,
            workspaceJson: state.workspaceJson,
            sourceCode: state.sourceCode,
            board: state.board,
            fqbn: state.fqbn,
            boardPackageId: state.boardPackageId,
            options: state.options,
            expectedFullStateHash,
        },
    });
};

export const listRecoveryDrafts = async (
    projectPath: string,
): Promise<RecoveryDraftMetadata[]> => invoke<RecoveryDraftMetadata[]>(
    'list_recovery_drafts',
    { projectPath: requireProjectPath(projectPath) },
);

export const loadRecoveryDraft = async (
    projectPath: string,
    draftId: string,
): Promise<RecoveryDraft> => invoke<RecoveryDraft>(
    'load_recovery_draft',
    {
        projectPath: requireProjectPath(projectPath),
        draftId: String(draftId || '').trim(),
    },
);

export const deleteRecoveryDraft = async (
    projectPath: string,
    draftId: string,
): Promise<void> => invoke<void>(
    'delete_recovery_draft',
    {
        projectPath: requireProjectPath(projectPath),
        draftId: String(draftId || '').trim(),
    },
);

/** Explicit user abandonment of one candidate; no process-wide shutdown flag. */
export const abandonRecoveryDraft = deleteRecoveryDraft;

/** Discard every rolling draft (including quarantined files) for one project. */
export const discardProjectRecoveryDrafts = async (
    projectPath: string,
): Promise<void> => invoke<void>(
    'discard_project_recovery_drafts',
    { projectPath: requireProjectPath(projectPath) },
);

/**
 * Startup/UI policy helper. A candidate is offered only when it belongs to
 * the still-current disk baseline, differs from the loaded state, and is
 * newer than the formal project snapshot. This remains independent of how
 * the previous process exited.
 */
export const shouldOfferRecoveryDraft = (
    candidate: RecoveryDraftMetadata,
    current: CurrentRecoveryComparison,
): boolean => {
    if (candidate.schemaVersion !== RECOVERY_DRAFT_SCHEMA_VERSION) return false;
    if (candidate.diskBaselineHash !== current.diskBaselineHash) return false;
    if (candidate.fullStateHash === current.fullStateHash) return false;
    const createdAt = Date.parse(candidate.createdAt);
    const currentDiskModifiedAt = Date.parse(current.diskModifiedAt || '');
    const capturedBaselineModifiedAt = Date.parse(candidate.diskBaselineModifiedAt || '');
    const diskModifiedAt = Number.isFinite(currentDiskModifiedAt)
        ? currentDiskModifiedAt
        : capturedBaselineModifiedAt;
    // Recovery is offered only with positive ordering evidence. A matching
    // content hash is not a substitute for proving that this draft was
    // captured after the formal project snapshot.
    return Number.isFinite(createdAt)
        && Number.isFinite(diskModifiedAt)
        && createdAt > diskModifiedAt;
};

/**
 * One automatic recovery prompt is allowed for one loaded-project revision and
 * disk baseline. The project path keeps independent editor sessions separate;
 * the revision deliberately changes when the user explicitly reopens/reloads.
 */
export const recoveryOfferSessionKey = (
    projectPath: string,
    projectLoadedRevision: number,
    diskBaselineHash: string,
): string => JSON.stringify([
    String(projectPath || '').trim(),
    Math.max(0, Math.trunc(Number(projectLoadedRevision) || 0)),
    String(diskBaselineHash || '').trim().toLowerCase(),
]);

export const recoveryProjectSessionKey = (
    session: RecoveryProjectSession,
): string => JSON.stringify([
    String(session.projectPath || '').trim(),
    String(session.loadKey || '').trim(),
    Math.max(0, Math.trunc(Number(session.revision) || 0)),
]);

export const recoveryProjectSessionMatches = (
    expected: RecoveryProjectSession | null | undefined,
    current: RecoveryProjectSession | null | undefined,
): boolean => Boolean(expected && current)
    && recoveryProjectSessionKey(expected as RecoveryProjectSession)
        === recoveryProjectSessionKey(current as RecoveryProjectSession);

export const resolveCompletedRecoveryProjectSession = (input: {
    projectPath: string;
    requestedLoadKey: string;
    completedLoadKey: string | null;
    revision: number;
}): RecoveryProjectSession | null => {
    const projectPath = input.projectPath.trim();
    if (!projectPath
        || input.revision <= 0
        || input.completedLoadKey !== input.requestedLoadKey) return null;
    return {
        projectPath,
        loadKey: input.completedLoadKey,
        revision: input.revision,
    };
};

/**
 * Select the latest eligible recovery draft only. Older rolling snapshots are
 * not an automatic modal queue; the session suppression applies to the whole
 * project/baseline decision rather than only the selected draft id.
 */
export const selectLatestRecoveryDraftForSession = (
    candidates: readonly RecoveryDraftMetadata[],
    current: CurrentRecoveryComparison,
    projectPath: string,
    projectLoadedRevision: number,
    suppressedSessionKey: string | null,
): RecoveryOfferSessionDecision => {
    const sessionKey = recoveryOfferSessionKey(
        projectPath,
        projectLoadedRevision,
        current.diskBaselineHash,
    );
    if (sessionKey === suppressedSessionKey) {
        return { sessionKey, suppressed: true, candidate: null };
    }
    const candidate = candidates
        .filter(item => shouldOfferRecoveryDraft(item, current))
        .sort((left, right) => (
            Date.parse(right.createdAt) - Date.parse(left.createdAt)
            || right.id.localeCompare(left.id)
        ))[0] || null;
    return { sessionKey, suppressed: false, candidate };
};

export const formatRecoveryDraftTime = (createdAt: string): string => {
    const time = new Date(createdAt);
    if (Number.isNaN(time.getTime())) return createdAt;
    return new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).format(time);
};
