import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const PROJECT_OPEN_TAURI_EVENT = 'ck-project-open-requested';
export const PROJECT_OPEN_BROWSER_EVENT = 'ck-project-open-requested-in-workspace';

export interface ProjectOpenRequest {
    requestId: string;
    path: string;
    source: 'cold-start' | 'second-instance' | string;
}

export interface ProjectOpenTarget {
    path: string;
    name: string;
}

export interface ErrorDescriptor {
    code: string;
    params: Record<string, unknown>;
    message: string;
    rawCause: string | null;
}

export class ProjectOpenError extends Error {
    readonly descriptor: ErrorDescriptor;

    constructor(descriptor: ErrorDescriptor) {
        super(descriptor.message);
        this.name = 'ProjectOpenError';
        this.descriptor = descriptor;
    }
}

export interface WorkspaceProjectOpenDetail {
    request: ProjectOpenRequest;
    target: ProjectOpenTarget;
    accept?: () => void;
    /**
     * Resolves only after the workspace has finished the unsaved-work decision
     * and either accepted or explicitly declined this request. The app-level
     * open queue uses this as the completion boundary before acknowledging the
     * native request.
     */
    onSettled?: () => void | Promise<void>;
}

export interface ProjectDropInspection {
    path: string | null;
    fileName: string | null;
    error: string | null;
}

interface ProjectOpenQueueItem {
    request: ProjectOpenRequest;
    resolve: () => void;
}

export interface ProjectOpenRequestQueue {
    enqueue: (request: ProjectOpenRequest) => Promise<void>;
    pendingCount: () => number;
    dispose: () => void;
}

const PROJECT_FILE_EXTENSION_PATTERN = /\.(?:ck|maker)$/i;

export const isSupportedProjectFilePath = (path: string): boolean => (
    PROJECT_FILE_EXTENSION_PATTERN.test(path.trim())
);

const comparableProjectPath = (path: string): string => (
    path.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLocaleLowerCase('en-US')
);

export const projectPathsReferToSameFile = (left: string, right: string): boolean => {
    const comparableLeft = comparableProjectPath(left);
    const comparableRight = comparableProjectPath(right);
    return Boolean(comparableLeft) && comparableLeft === comparableRight;
};

export const inspectDroppedProjectPaths = (paths: readonly string[]): ProjectDropInspection => {
    const candidates = paths
        .map(path => path.trim())
        .filter(Boolean);

    if (candidates.length === 0) {
        return {
            path: null,
            fileName: null,
            error: '没有识别到可打开的工程文件。',
        };
    }
    if (candidates.length !== 1) {
        return {
            path: null,
            fileName: null,
            error: '一次只能拖入一个 .ck 或 .maker 工程。',
        };
    }

    const path = candidates[0];
    const fileName = path.split(/[\\/]/).pop() || path;
    if (!isSupportedProjectFilePath(path)) {
        return {
            path: null,
            fileName,
            error: `“${fileName}”不是 CK 工程，请拖入 .ck 或 .maker 文件。`,
        };
    }

    return { path, fileName, error: null };
};

const isNative = (): boolean => typeof window !== 'undefined' && Boolean(
    (window as any).__TAURI_IPC__
    || (window as any).__TAURI_INTERNALS__
    || (window as any).__TAURI__,
);

const isErrorDescriptor = (value: unknown): value is ErrorDescriptor => {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<ErrorDescriptor>;
    return typeof candidate.code === 'string'
        && candidate.code.length > 0
        && typeof candidate.message === 'string'
        && candidate.params != null
        && typeof candidate.params === 'object'
        && (candidate.rawCause == null || typeof candidate.rawCause === 'string');
};

export const projectOpenErrorDescriptor = (error: unknown): ErrorDescriptor => {
    if (error instanceof ProjectOpenError) return error.descriptor;
    if (isErrorDescriptor(error)) return error;
    if (typeof error === 'string' && error.trim()) {
        return {
            code: 'PROJECT_OPEN_FAILED',
            params: {},
            message: error.trim(),
            rawCause: error.trim(),
        };
    }
    if (error instanceof Error && error.message.trim()) {
        return {
            code: 'PROJECT_OPEN_FAILED',
            params: {},
            message: error.message.trim(),
            rawCause: error.message.trim(),
        };
    }
    return {
        code: 'PROJECT_OPEN_FAILED',
        params: {},
        message: 'CK 未能读取该工程，请确认文件仍然存在且内容完整。',
        rawCause: null,
    };
};

export const prepareProjectOpen = async (path: string): Promise<ProjectOpenTarget> => {
    if (!path.trim()) {
        throw new ProjectOpenError({
            code: 'PROJECT_PATH_EMPTY',
            params: {},
            message: '工程路径为空，无法打开。',
            rawCause: null,
        });
    }
    try {
        return await invoke<ProjectOpenTarget>('prepare_project_open_v2', { path });
    } catch (error) {
        throw new ProjectOpenError(projectOpenErrorDescriptor(error));
    }
};

/**
 * Serializes all external project-open requests behind one async handler.
 *
 * The handler is intentionally awaited all the way through the workspace's
 * unsaved-work decision. This prevents a later double-click/drop from racing
 * the confirmation dialog and being silently discarded by the workspace.
 */
export const createProjectOpenRequestQueue = (
    handler: (request: ProjectOpenRequest) => void | Promise<void>,
): ProjectOpenRequestQueue => {
    const pending: ProjectOpenQueueItem[] = [];
    let running = false;
    let disposed = false;

    const drain = async (): Promise<void> => {
        if (running || disposed) return;
        running = true;
        try {
            while (!disposed && pending.length > 0) {
                const item = pending.shift();
                if (!item) continue;
                try {
                    await handler(item.request);
                } catch {
                    // The handler owns user-facing error reporting. Keep the
                    // queue moving and resolve the completion boundary even
                    // when a platform/dialog implementation throws.
                } finally {
                    item.resolve();
                }
            }
        } finally {
            running = false;
            if (!disposed && pending.length > 0) void drain();
        }
    };

    return {
        enqueue(request) {
            if (disposed) return Promise.resolve();
            return new Promise<void>(resolve => {
                pending.push({ request, resolve });
                void drain();
            });
        },
        pendingCount: () => pending.length + (running ? 1 : 0),
        dispose() {
            disposed = true;
            while (pending.length > 0) pending.shift()?.resolve();
        },
    };
};

export const subscribeProjectOpenRequests = async (
    handler: (request: ProjectOpenRequest) => void | Promise<void>,
): Promise<() => void> => {
    if (!isNative()) return () => undefined;

    const seen = new Set<string>();
    let disposed = false;
    let bootstrapping = true;
    const bufferedLiveRequests: ProjectOpenRequest[] = [];
    const deliver = async (request: ProjectOpenRequest) => {
        if (disposed || !request?.requestId || seen.has(request.requestId)) return;
        seen.add(request.requestId);
        try {
            await handler(request);
        } finally {
            // Event delivery and the durable startup queue deliberately overlap
            // across one race window. Acknowledgement removes the event copy;
            // drained cold-start requests are already gone, so this is harmless.
            await invoke('acknowledge_project_open', { requestId: request.requestId }).catch(() => undefined);
        }
    };

    // Register the live listener before draining startup work so a second
    // instance cannot fall into the gap between those two operations.
    const unlisten = await listen<ProjectOpenRequest>(PROJECT_OPEN_TAURI_EVENT, event => {
        if (bootstrapping) {
            bufferedLiveRequests.push(event.payload);
            return;
        }
        void deliver(event.payload);
    });
    try {
        const pending = await invoke<ProjectOpenRequest[]>('drain_pending_project_opens');
        for (const request of pending) {
            await deliver(request);
        }
        // Preserve launch order: the cold-start snapshot always enters the app
        // queue before second-instance events observed during initialization.
        // Keep buffering while awaiting handlers so newly arriving events append
        // behind earlier live events instead of overtaking them.
        while (bufferedLiveRequests.length > 0) {
            const request = bufferedLiveRequests.shift();
            if (request) await deliver(request);
        }
        bootstrapping = false;
    } catch (error) {
        // `listen` is installed before the durable snapshot on purpose. If the
        // snapshot or startup handler fails, release that listener here because
        // the caller never receives the normal unsubscribe callback.
        disposed = true;
        bufferedLiveRequests.length = 0;
        unlisten();
        throw error;
    }

    return () => {
        disposed = true;
        unlisten();
    };
};

export const projectOpenErrorMessage = (error: unknown): string => {
    return projectOpenErrorDescriptor(error).message;
};
