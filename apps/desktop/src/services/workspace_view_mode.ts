export const WORKSPACE_VIEW_MODE_STORAGE_KEY = 'ck.workspace.viewMode';

export type WorkspaceViewMode = 'simple' | 'engineering';

export const normalizeWorkspaceViewMode = (value: unknown): WorkspaceViewMode => (
    value === 'engineering' ? 'engineering' : 'simple'
);

const browserStorage = (): Storage | null => {
    try {
        return typeof window !== 'undefined' ? window.localStorage : null;
    } catch {
        return null;
    }
};

export const readWorkspaceViewMode = (storage: Pick<Storage, 'getItem'> | null = browserStorage()): WorkspaceViewMode => {
    try {
        return normalizeWorkspaceViewMode(storage?.getItem(WORKSPACE_VIEW_MODE_STORAGE_KEY));
    } catch {
        return 'simple';
    }
};

export const persistWorkspaceViewMode = (
    mode: WorkspaceViewMode,
    storage: Pick<Storage, 'setItem'> | null = browserStorage(),
): WorkspaceViewMode => {
    const normalized = normalizeWorkspaceViewMode(mode);
    try {
        storage?.setItem(WORKSPACE_VIEW_MODE_STORAGE_KEY, normalized);
    } catch {
        // Display preferences must never block editing or compilation.
    }
    return normalized;
};

export const workspaceViewModeLabel = (mode: WorkspaceViewMode): string => (
    mode === 'engineering' ? '工程视图' : '简洁视图'
);

