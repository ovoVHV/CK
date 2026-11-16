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
    buildTarget?: string | null;
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
    buildTarget?: string | null;
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
    buildTarget?: string | null;
}

export interface RecoveryDraftChangeSummary {
    currentBlockCount: number;
    draftBlockCount: number;
    currentSourceLineCount: number;
    draftSourceLineCount: number;
    workspaceChanged: boolean;
    sourceChanged: boolean;
    boardChanged: boolean;
    fqbnChanged: boolean;
    optionsChanged: boolean;
    items: string[];
    description: string;
}

export interface RecoverySourceDiffRow {
    kind: 'same' | 'added' | 'removed';
    beforeLine: number | null;
    afterLine: number | null;
    text: string;
}

export interface RecoverySourceDiff {
    rows: RecoverySourceDiffRow[];
    truncated: boolean;
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
    buildTarget: input.buildTarget || null,
});

const countSerializedBlocks = (raw: string): number => {
    try {
        const root = JSON.parse(raw) as unknown;
        let count = 0;
        const seen = new Set<unknown>();
        const visit = (value: unknown) => {
            if (!value || typeof value !== 'object' || seen.has(value)) return;
            seen.add(value);
            if (!Array.isArray(value) && typeof (value as { type?: unknown }).type === 'string') {
                count += 1;
            }
            if (Array.isArray(value)) value.forEach(visit);
            else Object.values(value as Record<string, unknown>).forEach(visit);
        };
        visit(root);
        return count;
    } catch {
        return 0;
    }
};

const sourceLines = (value: string): string[] => {
    const normalized = String(value || '').replace(/\r\n/g, '\n');
    return normalized ? normalized.split('\n') : [];
};

const comparableJson = (value: string): string => {
    try {
        const sortValue = (entry: unknown): unknown => {
            if (Array.isArray(entry)) return entry.map(sortValue);
            if (!entry || typeof entry !== 'object') return entry;
            return Object.fromEntries(
                Object.entries(entry as Record<string, unknown>)
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([key, item]) => [key, sortValue(item)]),
            );
        };
        return JSON.stringify(sortValue(JSON.parse(value || '{}')));
    } catch {
        return String(value || '');
    }
};

const signedDelta = (value: number): string => value > 0 ? `+${value}` : String(value);

/**
 * Human-readable, non-authoritative comparison for the recovery prompt. The
 * full-state hash and Rust validation remain the recovery safety contract;
 * this summary only explains that already-validated payload to the user.
 */
export const createRecoveryDraftChangeSummary = (
    current: RecoveryDraftState,
    draft: RecoveryDraftState,
): RecoveryDraftChangeSummary => {
    const currentState = normalizeState(current);
    const draftState = normalizeState(draft);
    const currentBlockCount = countSerializedBlocks(currentState.workspaceJson);
    const draftBlockCount = countSerializedBlocks(draftState.workspaceJson);
    const currentSourceLineCount = sourceLines(currentState.sourceCode).length;
    const draftSourceLineCount = sourceLines(draftState.sourceCode).length;
    const workspaceChanged = currentState.workspaceJson !== draftState.workspaceJson;
    const sourceChanged = currentState.sourceCode !== draftState.sourceCode;
    const boardChanged = currentState.board !== draftState.board
        || currentState.boardPackageId !== draftState.boardPackageId;
    const fqbnChanged = currentState.fqbn !== draftState.fqbn;
    const optionsChanged = comparableJson(currentState.options) !== comparableJson(draftState.options);
    const items: string[] = [];

    if (workspaceChanged) {
        const delta = draftBlockCount - currentBlockCount;
        items.push(delta === 0
            ? `积木内容有修改（共 ${draftBlockCount} 个）`
            : `积木数量 ${currentBlockCount} → ${draftBlockCount}（${signedDelta(delta)}）`);
    }
    if (sourceChanged) {
        const delta = draftSourceLineCount - currentSourceLineCount;
        items.push(delta === 0
            ? `生成源码有修改（共 ${draftSourceLineCount} 行）`
            : `生成源码 ${currentSourceLineCount} → ${draftSourceLineCount} 行（${signedDelta(delta)}）`);
    }
    if (boardChanged) items.push(`板卡由 ${currentState.board || '未指定'} 改为 ${draftState.board || '未指定'}`);
    if (fqbnChanged) items.push('编译目标（FQBN）有变化');
    if (optionsChanged) items.push('板卡编译选项有调整');
    if (currentState.buildTarget !== draftState.buildTarget) items.push('工程记录的 Core / 完整板卡配置有调整');
    if (items.length === 0) items.push('完整工作区序列化内容有差异');

    return {
        currentBlockCount,
        draftBlockCount,
        currentSourceLineCount,
        draftSourceLineCount,
        workspaceChanged,
        sourceChanged,
        boardChanged,
        fqbnChanged,
        optionsChanged,
        items,
        description: items.slice(0, 2).join('；') + (items.length > 2 ? `；另有 ${items.length - 2} 项配置变化` : ''),
    };
};

/**
 * A bounded line diff for the recovery comparison panel. Large generated
 * sketches are intentionally capped so opening the safety prompt cannot stall
 * the editor; the panel clearly reports when the preview is truncated.
 */
export const createRecoverySourceDiff = (
    currentSource: string,
    draftSource: string,
    maxSourceLines = 220,
    maxRows = 320,
): RecoverySourceDiff => {
    const allBefore = sourceLines(currentSource);
    const allAfter = sourceLines(draftSource);
    const before = allBefore.slice(0, maxSourceLines);
    const after = allAfter.slice(0, maxSourceLines);
    const table = Array.from({ length: before.length + 1 }, () => new Uint16Array(after.length + 1));

    for (let left = before.length - 1; left >= 0; left -= 1) {
        for (let right = after.length - 1; right >= 0; right -= 1) {
            table[left][right] = before[left] === after[right]
                ? table[left + 1][right + 1] + 1
                : Math.max(table[left + 1][right], table[left][right + 1]);
        }
    }

    const rows: RecoverySourceDiffRow[] = [];
    let left = 0;
    let right = 0;
    while ((left < before.length || right < after.length) && rows.length < maxRows) {
        if (left < before.length && right < after.length && before[left] === after[right]) {
            rows.push({ kind: 'same', beforeLine: left + 1, afterLine: right + 1, text: before[left] });
            left += 1;
            right += 1;
        } else if (right < after.length && (left >= before.length || table[left][right + 1] > table[left + 1][right])) {
            rows.push({ kind: 'added', beforeLine: null, afterLine: right + 1, text: after[right] });
            right += 1;
        } else if (left < before.length) {
            rows.push({ kind: 'removed', beforeLine: left + 1, afterLine: null, text: before[left] });
            left += 1;
        }
    }

    return {
        rows,
        truncated: allBefore.length > before.length
            || allAfter.length > after.length
            || left < before.length
            || right < after.length,
    };
};

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
        ...(state.buildTarget ? [state.buildTarget] : []),
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
            buildTarget: state.buildTarget,
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
