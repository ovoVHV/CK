/**
 * Stable storage identity without collapsing case-sensitive POSIX paths.
 * Windows drive/UNC paths are case-folded; POSIX and relative paths retain
 * case because `/Foo` and `/foo` may be different projects.
 */
export const normalizeProjectIdentityPath = (value: string): string => {
    const normalized = String(value || '').trim().replace(/\\/g, '/');
    return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
        ? normalized.toLowerCase()
        : normalized;
};
