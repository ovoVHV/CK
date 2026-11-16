const MAX_WARNING_LINES = 2;
const MAX_WARNING_CHARACTERS = 96;
const WARNING_PREFIX = /^\s*(?:\[(?:warning|warn|警告)\]|(?:warning|警告))\s*[:：-]?\s*/i;

const boundedWarningLine = (value: string): string => {
    const normalized = value.replace(/\s+/g, ' ').trim() || '未提供详细原因';
    if (normalized.length <= MAX_WARNING_CHARACTERS) return normalized;
    return `${normalized.slice(0, MAX_WARNING_CHARACTERS - 1)}…`;
};

/**
 * Extract backend best-effort cleanup warnings without turning a successful
 * package deletion into a failure. The returned summary is deliberately short
 * enough for the existing transient toast; the complete log remains available
 * to service callers.
 */
export const summarizeBoardDeletionWarnings = (result: unknown): string | null => {
    if (typeof result !== 'string' || !result.trim()) return null;
    const warnings: string[] = [];
    const seen = new Set<string>();
    for (const rawLine of result.split(/\r?\n/)) {
        if (!WARNING_PREFIX.test(rawLine)) continue;
        const summary = boundedWarningLine(rawLine.replace(WARNING_PREFIX, ''));
        if (seen.has(summary)) continue;
        seen.add(summary);
        warnings.push(summary);
    }
    if (warnings.length === 0) return null;
    const visible = warnings.slice(0, MAX_WARNING_LINES);
    const hiddenCount = warnings.length - visible.length;
    return `${visible.join('；')}${hiddenCount > 0 ? `（另有 ${hiddenCount} 条）` : ''}`;
};
