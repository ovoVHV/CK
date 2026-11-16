export const MAX_COMPILE_LOG_CHARACTERS = 2_000_000;
export const MAX_COMPILE_LOG_LINES = 8_000;

export const COMPILE_LOG_TRUNCATION_NOTICE =
    '[CK] 较早的构建日志已从界面内存中截断；当前保留最新日志。\n';

export interface CompileLogBuffer {
    text: string;
    newlineCount: number;
}

const countNewlines = (value: string): number => {
    let count = 0;
    for (let index = 0; index < value.length; index += 1) {
        if (value.charCodeAt(index) === 10) count += 1;
    }
    return count;
};

export const createCompileLogBuffer = (text = ''): CompileLogBuffer => ({
    text,
    newlineCount: countNewlines(text),
});

const retainLatestLines = (
    text: string,
    newlineCount: number,
    maxLines: number,
): CompileLogBuffer => {
    const maxNewlines = Math.max(0, maxLines - 1);
    if (newlineCount <= maxNewlines) return { text, newlineCount };

    const markerNewlines = countNewlines(COMPILE_LOG_TRUNCATION_NOTICE);
    const newlinesToRemove = newlineCount - maxNewlines + markerNewlines;
    let tail = text;

    if (newlinesToRemove <= 256) {
        let cut = -1;
        for (let removed = 0; removed < newlinesToRemove; removed += 1) {
            cut = text.indexOf('\n', cut + 1);
            if (cut < 0) break;
        }
        if (cut >= 0) tail = text.slice(cut + 1);
    } else {
        // A single huge chunk may contain hundreds of thousands of short lines.
        // Scan backward only for the bounded tail instead of walking every line
        // that will be discarded.
        const tailNewlineLimit = Math.max(0, maxNewlines - markerNewlines);
        let cut = text.length;
        for (let kept = 0; kept <= tailNewlineLimit; kept += 1) {
            cut = text.lastIndexOf('\n', cut - 1);
            if (cut < 0) break;
        }
        if (cut >= 0) tail = text.slice(cut + 1);
    }

    const nextText = COMPILE_LOG_TRUNCATION_NOTICE + tail;
    return { text: nextText, newlineCount: countNewlines(nextText) };
};

/**
 * Append streamed compiler output without allowing a long verbose build to
 * retain an ever-growing React string. The newest evidence is authoritative:
 * compiler diagnostics, size output and final artifact lines are emitted near
 * the end of a build.
 */
export const appendCompileLogBufferBounded = (
    current: CompileLogBuffer,
    chunk: string,
    maxCharacters = MAX_COMPILE_LOG_CHARACTERS,
    maxLines = MAX_COMPILE_LOG_LINES,
): CompileLogBuffer => {
    if (!chunk) return current;
    const safeLimit = Math.max(COMPILE_LOG_TRUNCATION_NOTICE.length + 1, Math.floor(maxCharacters));
    let text: string;
    let newlineCount: number;
    if (current.text.length + chunk.length <= safeLimit) {
        text = current.text + chunk;
        newlineCount = current.newlineCount + countNewlines(chunk);
    } else {
        const tailLimit = safeLimit - COMPILE_LOG_TRUNCATION_NOTICE.length;
        let tail = chunk.length >= tailLimit
            ? chunk.slice(-tailLimit)
            : current.text.slice(-(tailLimit - chunk.length)) + chunk;

        // When possible, begin at a complete line. Do not scan an unbounded
        // prefix: a very long tool-output line is valid evidence and stays capped.
        const firstNewline = tail.indexOf('\n');
        if (firstNewline >= 0 && firstNewline < Math.min(512, tail.length - 1)) {
            tail = tail.slice(firstNewline + 1);
        }
        text = COMPILE_LOG_TRUNCATION_NOTICE + tail;
        newlineCount = countNewlines(text);
    }
    return retainLatestLines(text, newlineCount, Math.max(2, Math.floor(maxLines)));
};

export const appendCompileLogBounded = (
    current: string,
    chunk: string,
    maxCharacters = MAX_COMPILE_LOG_CHARACTERS,
    maxLines = MAX_COMPILE_LOG_LINES,
): string => appendCompileLogBufferBounded(
    createCompileLogBuffer(current),
    chunk,
    maxCharacters,
    maxLines,
).text;
