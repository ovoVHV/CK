import { invoke } from '@tauri-apps/api/core';

export type ProjectCheckpointReason =
    | 'before_compile'
    | 'before_upload'
    | 'before_restore'
    | 'before_leave'
    | 'manual'
    | string;

export interface CreateProjectCheckpointInput {
    projectPath: string;
    reason: ProjectCheckpointReason;
    /** Exact JSON from Blockly.serialization.workspaces.save(). */
    workspaceJson: string;
    /** Generated source at the same instant as workspaceJson. */
    code: string;
    board: string;
    /** Concrete CK package identity; the compiler target remains `board`. */
    boardPackageId: string;
    /** The project's existing board-options JSON string. */
    options: string;
    blockCount: number;
}

export interface ProjectCheckpointMetadata {
    id: string;
    projectName: string;
    reason: ProjectCheckpointReason;
    createdAt: string;
    board: string;
    boardPackageId: string;
    blockCount: number;
    byteSize: number;
}

export interface ProjectCheckpoint {
    schemaVersion: number;
    id: string;
    projectPath: string;
    projectName: string;
    reason: ProjectCheckpointReason;
    createdAt: string;
    workspaceJson: string;
    code: string;
    board: string;
    boardPackageId: string;
    options: string;
    blockCount: number;
}

export const MAX_PROJECT_CHECKPOINTS = 20;

export const isNativeCheckpointStorageAvailable = (): boolean => (
    typeof window !== 'undefined'
    && Boolean(
        (window as any).__TAURI_IPC__
        || (window as any).__TAURI_INTERNALS__
        || (window as any).__TAURI__,
    )
);

const requireProjectPath = (projectPath: string): string => {
    const path = String(projectPath || '').trim();
    if (!path) throw new Error('当前工程还没有可用于检查点的路径');
    return path;
};

export const checkpointReasonLabel = (reason: ProjectCheckpointReason): string => {
    if (reason === 'before_compile') return '编译前';
    if (reason === 'before_upload') return '上传前';
    if (reason === 'before_restore') return '恢复前保护';
    if (reason === 'before_leave') return '离开前保护';
    if (reason === 'manual') return '手动检查点';
    return String(reason || '自动保护');
};

export const formatCheckpointBytes = (bytes: number): string => {
    const safeBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    if (safeBytes < 1024) return `${Math.round(safeBytes)} B`;
    if (safeBytes < 1024 * 1024) return `${(safeBytes / 1024).toFixed(1)} KB`;
    return `${(safeBytes / 1024 / 1024).toFixed(1)} MB`;
};

export const formatCheckpointTime = (createdAt: string): string => {
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

export const createProjectCheckpoint = async (
    input: CreateProjectCheckpointInput,
): Promise<ProjectCheckpointMetadata> => {
    const normalizedInput: CreateProjectCheckpointInput = {
        ...input,
        projectPath: requireProjectPath(input.projectPath),
        reason: String(input.reason || 'manual'),
        workspaceJson: String(input.workspaceJson || ''),
        code: String(input.code || ''),
        board: String(input.board || ''),
        boardPackageId: String(input.boardPackageId || input.board || ''),
        options: String(input.options || '{}'),
        blockCount: Math.max(0, Math.floor(Number(input.blockCount) || 0)),
    };
    return invoke<ProjectCheckpointMetadata>('create_project_checkpoint', {
        input: normalizedInput,
    });
};

export const listProjectCheckpoints = async (
    projectPath: string,
): Promise<ProjectCheckpointMetadata[]> => invoke<ProjectCheckpointMetadata[]>(
    'list_project_checkpoints',
    { projectPath: requireProjectPath(projectPath) },
);

export const loadProjectCheckpoint = async (
    projectPath: string,
    checkpointId: string,
): Promise<ProjectCheckpoint> => invoke<ProjectCheckpoint>(
    'load_project_checkpoint',
    {
        projectPath: requireProjectPath(projectPath),
        checkpointId,
    },
);

export const deleteProjectCheckpoint = async (
    projectPath: string,
    checkpointId: string,
): Promise<void> => invoke<void>(
    'delete_project_checkpoint',
    {
        projectPath: requireProjectPath(projectPath),
        checkpointId,
    },
);
