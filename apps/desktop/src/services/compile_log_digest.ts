export type CompileLogDigestLineKind = 'error' | 'source' | 'caret' | 'note' | 'context';

export interface CompileLogDigestLine {
    kind: CompileLogDigestLineKind;
    text: string;
    raw: string;
}

export interface CompileLogDigest {
    lines: CompileLogDigestLine[];
    errorCount: number;
    omittedLineCount: number;
}

const MAX_DIGEST_LINES = 18;
const SOURCE_MARKER_RE = /\s*\/\*\s*@ck-(?:source-(?:begin|end)|source)(?::v\d+)?:[^*]*\*\//gi;
const LEGACY_SOURCE_MARKER_RE = /\s*\/\*\s*@ck:v\d+:[^*]*\*\//gi;

const compactSourceLine = (value: string): string => String(value || '')
    .replace(SOURCE_MARKER_RE, '')
    .replace(LEGACY_SOURCE_MARKER_RE, '')
    .replace(/\s+$/g, '')
    .slice(0, 520);

const isLocatedDiagnostic = (line: string): boolean => (
    /^\s*.+?\.(?:ino(?:\.cpp)?|c|cc|cpp|cxx|h|hpp):\d+(?::\d+)?:\s*(?:fatal\s+error|error|note)\s*:/i.test(line)
);

const isPrimaryError = (line: string): boolean => (
    /^\s*.+?\.(?:ino(?:\.cpp)?|c|cc|cpp|cxx|h|hpp):\d+(?::\d+)?:\s*(?:fatal\s+error|error)\s*:/i.test(line)
    || /^\s*(?:fatal\s+error|error)\s*:/i.test(line)
    || /^\s*\[ERROR\]/i.test(line)
    || /^\s*(?:Error during build|Build failed|失败:)\b/i.test(line)
);

const isFunctionContext = (line: string): boolean => (
    /^\s*.+?:\s+In (?:function|member function|lambda function)\b/i.test(line)
);

const isCaret = (line: string): boolean => /^\s*[|~^\- ]*\^+[~^\- ]*\s*$/.test(line);

const classify = (line: string): CompileLogDigestLineKind => {
    if (isPrimaryError(line)) return 'error';
    if (isLocatedDiagnostic(line) && /:\s*note\s*:/i.test(line)) return 'note';
    if (isCaret(line)) return 'caret';
    if (isFunctionContext(line)) return 'context';
    return 'source';
};

const pushUnique = (
    output: CompileLogDigestLine[],
    seen: Set<string>,
    rawLine: string,
) => {
    const text = compactSourceLine(rawLine);
    if (!text.trim()) return;
    const key = `${classify(rawLine)}\u0000${text.trim()}`;
    if (seen.has(key) || output.length >= MAX_DIGEST_LINES) return;
    seen.add(key);
    output.push({ kind: classify(rawLine), text, raw: rawLine });
};

/**
 * Extract compiler-owned error groups while leaving the complete bounded log
 * untouched. This is presentation-only: it never guesses a cause or grants a
 * source-map authorization.
 */
export const extractCompileLogDigest = (log: string): CompileLogDigest => {
    const rawLines = String(log || '').split(/\r?\n/);
    const output: CompileLogDigestLine[] = [];
    const seen = new Set<string>();

    for (let index = 0; index < rawLines.length; index += 1) {
        const line = rawLines[index];
        if (!isPrimaryError(line)) continue;

        if (index > 0 && isFunctionContext(rawLines[index - 1])) {
            pushUnique(output, seen, rawLines[index - 1]);
        }
        pushUnique(output, seen, line);

        if (!isLocatedDiagnostic(line)) continue;

        // GCC/clang normally follow a located diagnostic with the source and
        // caret, optionally followed by a located note and its source/caret.
        for (let offset = 1; offset <= 5 && index + offset < rawLines.length; offset += 1) {
            const following = rawLines[index + offset];
            const trimmed = following.trim();
            if (!trimmed) break;
            if (isPrimaryError(following)) break;
            if (
                isCaret(following)
                || isFunctionContext(following)
                || (isLocatedDiagnostic(following) && /:\s*note\s*:/i.test(following))
                || offset <= 2
            ) {
                pushUnique(output, seen, following);
                continue;
            }
            break;
        }
    }

    return {
        lines: output,
        errorCount: output.filter(line => line.kind === 'error').length,
        omittedLineCount: Math.max(0, rawLines.filter(line => line.trim()).length - output.length),
    };
};
