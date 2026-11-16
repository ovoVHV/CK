/**
 * Dashboard project pin preferences.
 *
 * Pins are a local UI preference, not part of a .ck project document. Keeping
 * them outside the project format means copying or submitting a project does
 * not accidentally carry a user's private dashboard layout with it.
 */
export const PROJECT_PINS_STORAGE_KEY = 'ck.dashboard.pinnedProjects.v1';

export interface ProjectPinStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

const browserStorage = (): ProjectPinStorage | null => {
    try {
        return typeof window !== 'undefined' ? window.localStorage : null;
    } catch {
        return null;
    }
};

/** Stable comparison for Windows paths returned by the Tauri project scanner. */
export const projectPinKey = (path: unknown): string => (
    String(path ?? '')
        .trim()
        .replace(/[\\/]+/g, '\\')
        .replace(/\\+$/, '')
        .toLocaleLowerCase('en-US')
);

export const normalizePinnedProjectPaths = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    const result: string[] = [];
    const seen = new Set<string>();
    for (const candidate of value) {
        const path = String(candidate ?? '').trim();
        const key = projectPinKey(path);
        if (!path || !key || seen.has(key)) continue;
        seen.add(key);
        result.push(path);
    }
    return result;
};

export const readPinnedProjectPaths = (
    storage: Pick<ProjectPinStorage, 'getItem'> | null = browserStorage(),
): string[] => {
    try {
        const raw = storage?.getItem(PROJECT_PINS_STORAGE_KEY);
        return raw ? normalizePinnedProjectPaths(JSON.parse(raw)) : [];
    } catch {
        // A corrupt or unavailable preference must never block the dashboard.
        return [];
    }
};

export const writePinnedProjectPaths = (
    paths: readonly string[],
    storage: Pick<ProjectPinStorage, 'setItem'> | null = browserStorage(),
): string[] => {
    const normalized = normalizePinnedProjectPaths(paths);
    try {
        storage?.setItem(PROJECT_PINS_STORAGE_KEY, JSON.stringify(normalized));
    } catch {
        // Dashboard preferences are best-effort only.
    }
    return normalized;
};

export const togglePinnedProjectPath = (
    paths: readonly string[],
    path: string,
): string[] => {
    const key = projectPinKey(path);
    if (!key) return normalizePinnedProjectPaths(paths);
    const current = normalizePinnedProjectPaths(paths);
    const exists = current.some(item => projectPinKey(item) === key);
    return exists
        ? current.filter(item => projectPinKey(item) !== key)
        : [path.trim(), ...current];
};

export const prunePinnedProjectPaths = (
    paths: readonly string[],
    projects: readonly { path: string }[],
): string[] => {
    const available = new Set(projects.map(project => projectPinKey(project.path)).filter(Boolean));
    return normalizePinnedProjectPaths(paths).filter(path => available.has(projectPinKey(path)));
};
