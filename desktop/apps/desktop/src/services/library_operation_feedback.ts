export type LibraryImportKind = 'block-package' | 'arduino-zip';
export type LibraryImportQueueStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export const LIBRARY_OPERATION_ERROR_CODES = {
    SEARCH_TIMEOUT: 'LIBRARY_SEARCH_TIMEOUT',
} as const;

export type LibraryOperationErrorCode = typeof LIBRARY_OPERATION_ERROR_CODES[keyof typeof LIBRARY_OPERATION_ERROR_CODES];

export type LibraryOperationError = Error & {
    code: LibraryOperationErrorCode;
    rawCause?: unknown;
};

export interface LibraryOperationErrorFeedback {
    code?: string;
    summaryCode?: string;
    summaryParams?: Record<string, unknown>;
    summary: string;
    details: string[];
    raw: string;
}

export const createLibraryOperationError = (
    code: LibraryOperationErrorCode,
    message: string,
    rawCause?: unknown,
): LibraryOperationError => Object.assign(new Error(message), {
    name: 'LibraryOperationError',
    code,
    ...(rawCause === undefined ? {} : { rawCause }),
});

export const libraryOperationErrorCode = (error: unknown): string | undefined => {
    if (!error || typeof error !== 'object') return undefined;
    const code = (error as Record<string, unknown>).code;
    return typeof code === 'string' && code.trim() ? code.trim() : undefined;
};

export interface LibraryImportQueueItem {
    id: string;
    kind: LibraryImportKind;
    path: string;
    label: string;
    status: LibraryImportQueueStatus;
    summaryCode?: string;
    summaryParams?: Record<string, unknown>;
    summary?: string;
    details?: string[];
    rawError?: string;
}

export const selectedLibraryImportPaths = (value: string | string[] | null): string[] => {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const entry of values) {
        const path = String(entry || '').trim();
        const key = path.replace(/\\/g, '/').toLocaleLowerCase('en-US');
        if (!path || seen.has(key)) continue;
        seen.add(key);
        paths.push(path);
    }
    return paths;
};

export const libraryImportPathLabel = (path: string): string => {
    const normalized = String(path || '').replace(/\\/g, '/').replace(/\/+$/g, '');
    return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized || '未命名导入项';
};

export const createLibraryImportQueue = (
    paths: readonly string[],
    kind: LibraryImportKind,
): LibraryImportQueueItem[] => paths.map((path, index) => ({
    id: `${kind}:${index}:${String(path).replace(/\\/g, '/')}`,
    kind,
    path,
    label: libraryImportPathLabel(path),
    status: 'pending',
}));

const extractErrorText = (error: unknown): string => {
    if (typeof error === 'string') return error;
    if (error instanceof Error) return error.message || String(error);
    if (error && typeof error === 'object') {
        const object = error as Record<string, unknown>;
        for (const key of ['message', 'error', 'reason', 'details']) {
            const value = object[key];
            if (typeof value === 'string' && value.trim()) return value;
            if (Array.isArray(value) && value.length > 0) return value.map(String).join('\n');
        }
        try { return JSON.stringify(error); } catch { /* fall through */ }
    }
    return String(error || '未知错误');
};

const stripTransportPrefix = (value: string): string => value
    .replace(/^\s*(?:Error|InvokeError|Command failed)\s*:\s*/i, '')
    .trim();

/** Keep backend quality-gate evidence visible instead of reducing it to a toast. */
export const describeLibraryOperationError = (error: unknown): LibraryOperationErrorFeedback => {
    const code = libraryOperationErrorCode(error);
    let raw = extractErrorText(error).trim();
    if (!raw) raw = '导入被拒绝，但后端没有返回可读原因';

    if (/^[{[]/.test(raw)) {
        try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            raw = extractErrorText(parsed).trim() || raw;
        } catch {
            // Plain compiler/validator output can also start with '['.
        }
    }

    const lines = raw
        .split(/\r?\n/)
        .map(stripTransportPrefix)
        .filter(Boolean);
    const unique = Array.from(new Set(lines));
    const summary = (unique[0] || '导入失败，原因未知').slice(0, 420);
    const details = unique.slice(1, 40);
    const summaryCode = code === LIBRARY_OPERATION_ERROR_CODES.SEARCH_TIMEOUT
        ? 'manager.errors.searchTimeout'
        : undefined;
    return { code, ...(summaryCode ? { summaryCode } : {}), summary, details, raw };
};
