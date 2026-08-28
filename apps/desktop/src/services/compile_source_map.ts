export const CK_COMPILE_SOURCE_MAP_VERSION = 1 as const;
export const CK_COMPILE_SOURCE_MAP_SCHEMA = 'ck-sourcemap' as const;
export const CK_COMPILE_SOURCE_MAP_DEFAULT_FILE = 'sketch.ino';

export type CompileSourceSection =
    | 'setup'
    | 'loop'
    | 'definition'
    | 'expression'
    | 'unknown';

export type CompileSourceConfidence = 'exact' | 'high' | 'medium' | 'low';

export interface CompileSourceBoundary {
    boundaryId: string;
    blockId: string;
    blockType: string;
    section: CompileSourceSection;
    confidence: CompileSourceConfidence;
}

export interface CompileSourceMapMappingV1 {
    file: string;
    lineStart: number;
    lineEnd: number;
    blockId: string;
    blockType: string;
    section: CompileSourceSection;
    confidence: CompileSourceConfidence;
}

export interface CompileSourceMapV1 {
    schema: typeof CK_COMPILE_SOURCE_MAP_SCHEMA;
    version: typeof CK_COMPILE_SOURCE_MAP_VERSION;
    codeSha256: string;
    file: string;
    lineCount: number;
    mappings: readonly Readonly<CompileSourceMapMappingV1>[];
}

export interface FreezeCompileSourceMapContext {
    /** The compiler-visible sketch file. A basename accepts an absolute compiler path with that basename. */
    file?: string;
}

export interface CompileSourceMapLookupRequest {
    file: string;
    line: number;
    /** Exact code submitted to this compile session. */
    code?: string;
    /** May be supplied instead of code when the caller already froze its SHA-256. */
    codeSha256?: string;
    /** Optional caller-owned trust floor. Other mappings are ignored, not promoted. */
    acceptedConfidences?: readonly CompileSourceConfidence[];
}

export interface TrustedCompileSketchAliasV1 {
    schemaVersion: 1;
    status: 'trusted' | 'revoked';
    runId: string;
    sourceSha256: string;
    basename?: string;
    pathSha256?: string;
}

export interface TrustedCompileDiagnosticFileRequest {
    alias: TrustedCompileSketchAliasV1 | null | undefined;
    runId: string;
    sourceMap: Readonly<CompileSourceMapV1> | null | undefined;
    diagnosticFile: string;
}

interface BoundaryPayloadV1 {
    boundaryId: string;
    blockId: string;
    blockType: string;
    section: CompileSourceSection;
    confidence: CompileSourceConfidence;
}

interface OpenBoundary {
    payload: BoundaryPayloadV1;
    lineStart: number;
    depth: number;
}

interface ClosedBoundary {
    mapping: CompileSourceMapMappingV1;
    depth: number;
    closeOrder: number;
}

const SOURCE_BOUNDARY_PAYLOAD_VERSION = 'v1:';
const SOURCE_BOUNDARY_MARKER_RE = /\/\* @ck-source-(begin|end):(\S+?) \*\//g;
const SOURCE_BOUNDARY_STRIP_RE = / ?\/\* @ck-source-(?:begin|end):\S+? \*\//g;

const VALID_SECTIONS: ReadonlySet<string> = new Set<CompileSourceSection>([
    'setup',
    'loop',
    'definition',
    'expression',
    'unknown',
]);

const VALID_CONFIDENCE: ReadonlySet<string> = new Set<CompileSourceConfidence>([
    'exact',
    'high',
    'medium',
    'low',
]);

const encodeUtf8Hex = (value: string): string => (
    Array.from(
        new TextEncoder().encode(value),
        byte => byte.toString(16).padStart(2, '0'),
    ).join('')
);

const decodeUtf8Hex = (hex: string): string | null => {
    if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < hex.length; index += 2) {
        bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return null;
    }
};

const normalizeBoundary = (boundary: CompileSourceBoundary): BoundaryPayloadV1 => {
    const boundaryId = String(boundary?.boundaryId || '').trim();
    const blockId = String(boundary?.blockId || '');
    if (!boundaryId) throw new Error('源码映射边界缺少 boundaryId');
    if (!blockId) throw new Error('源码映射边界缺少 blockId');

    return {
        boundaryId,
        blockId,
        blockType: String(boundary?.blockType || 'unknown'),
        section: VALID_SECTIONS.has(boundary?.section) ? boundary.section : 'unknown',
        confidence: VALID_CONFIDENCE.has(boundary?.confidence) ? boundary.confidence : 'low',
    };
};

const encodeBeginPayload = (payload: BoundaryPayloadV1): string => (
    `${SOURCE_BOUNDARY_PAYLOAD_VERSION}${encodeUtf8Hex(JSON.stringify(payload))}`
);

const decodeBeginPayload = (rawPayload: string): BoundaryPayloadV1 | null => {
    if (!rawPayload.startsWith(SOURCE_BOUNDARY_PAYLOAD_VERSION)) return null;
    const json = decodeUtf8Hex(rawPayload.slice(SOURCE_BOUNDARY_PAYLOAD_VERSION.length));
    if (json === null) return null;

    try {
        const value = JSON.parse(json) as Partial<BoundaryPayloadV1>;
        const boundaryId = String(value?.boundaryId || '').trim();
        const blockId = String(value?.blockId || '');
        if (!boundaryId || !blockId) return null;
        return {
            boundaryId,
            blockId,
            blockType: String(value?.blockType || 'unknown'),
            section: VALID_SECTIONS.has(String(value?.section || ''))
                ? value.section as CompileSourceSection
                : 'unknown',
            confidence: VALID_CONFIDENCE.has(String(value?.confidence || ''))
                ? value.confidence as CompileSourceConfidence
                : 'low',
        };
    } catch {
        return null;
    }
};

const encodeEndPayload = (boundaryId: string): string => (
    `${SOURCE_BOUNDARY_PAYLOAD_VERSION}${encodeUtf8Hex(boundaryId)}`
);

const decodeEndPayload = (rawPayload: string): string | null => {
    if (!rawPayload.startsWith(SOURCE_BOUNDARY_PAYLOAD_VERSION)) return null;
    const boundaryId = decodeUtf8Hex(rawPayload.slice(SOURCE_BOUNDARY_PAYLOAD_VERSION.length));
    return boundaryId?.trim() ? boundaryId : null;
};

export const createCompileSourceBoundaryMarkers = (
    boundary: CompileSourceBoundary,
): { begin: string; end: string } => {
    const payload = normalizeBoundary(boundary);
    return {
        begin: `/* @ck-source-begin:${encodeBeginPayload(payload)} */`,
        end: `/* @ck-source-end:${encodeEndPayload(payload.boundaryId)} */`,
    };
};

const appendInlineMarker = (line: string, marker: string): string => {
    const trailingWhitespace = line.match(/\s*$/)?.[0] || '';
    const content = trailingWhitespace ? line.slice(0, -trailingWhitespace.length) : line;
    return `${content} ${marker}${trailingWhitespace}`;
};

const insertBeforeExistingBoundary = (line: string, marker: string): string => {
    const existingIndex = line.search(/\/\* @ck-source-(?:begin|end):/);
    if (existingIndex < 0) return appendInlineMarker(line, marker);

    const prefix = line.slice(0, existingIndex).trimEnd();
    const suffix = line.slice(existingIndex);
    return `${prefix} ${marker} ${suffix}`;
};

/**
 * Surround a generated fragment with paired inline comments without changing its
 * line count. A fragment without executable text is deliberately left unmapped.
 */
export const wrapCompileSourceBoundary = (
    code: string,
    boundary: CompileSourceBoundary,
): string => {
    const source = String(code || '');
    // Keep every original newline byte-for-byte. Generated fragments can contain
    // mixed endings when contributed by extensions; normalizing them here would
    // make marker stripping lossy and would silently change the compile hash.
    const parts = source.split(/(\r\n|\n|\r)/);
    const lines: string[] = [];
    for (let index = 0; index < parts.length; index += 2) {
        lines.push(parts[index]);
    }
    const hasSourceText = (line: string): boolean => (
        stripCompileSourceBoundaryMarkers(line).trim().length > 0
    );
    const firstLine = lines.findIndex(hasSourceText);
    if (firstLine < 0) return source;

    let lastLine = firstLine;
    for (let index = lines.length - 1; index >= firstLine; index -= 1) {
        if (hasSourceText(lines[index])) {
            lastLine = index;
            break;
        }
    }

    const markers = createCompileSourceBoundaryMarkers(boundary);
    lines[firstLine] = insertBeforeExistingBoundary(lines[firstLine], markers.begin);
    lines[lastLine] = appendInlineMarker(lines[lastLine], markers.end);
    for (let index = 0; index < lines.length; index += 1) {
        parts[index * 2] = lines[index];
    }
    return parts.join('');
};

export const stripCompileSourceBoundaryMarkers = (source: string): string => (
    String(source || '').replace(SOURCE_BOUNDARY_STRIP_RE, '')
);

const SHA256_INITIAL_STATE = [
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
] as const;

const SHA256_ROUND_CONSTANTS = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

const rotateRight = (value: number, amount: number): number => (
    (value >>> amount) | (value << (32 - amount))
);

/** Synchronous UTF-8 SHA-256 for browser and node compile-session snapshots. */
export const sha256Hex = (source: string): string => {
    const input = new TextEncoder().encode(String(source ?? ''));
    const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(input);
    padded[input.length] = 0x80;

    const bitLength = input.length * 8;
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(paddedLength - 4, bitLength >>> 0, false);

    const state = Array.from(SHA256_INITIAL_STATE, value => value >>> 0);
    const schedule = new Uint32Array(64);

    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let index = 0; index < 16; index += 1) {
            schedule[index] = view.getUint32(offset + index * 4, false);
        }
        for (let index = 16; index < 64; index += 1) {
            const previous15 = schedule[index - 15];
            const previous2 = schedule[index - 2];
            const sigma0 = rotateRight(previous15, 7)
                ^ rotateRight(previous15, 18)
                ^ (previous15 >>> 3);
            const sigma1 = rotateRight(previous2, 17)
                ^ rotateRight(previous2, 19)
                ^ (previous2 >>> 10);
            schedule[index] = (
                schedule[index - 16]
                + sigma0
                + schedule[index - 7]
                + sigma1
            ) >>> 0;
        }

        let a = state[0];
        let b = state[1];
        let c = state[2];
        let d = state[3];
        let e = state[4];
        let f = state[5];
        let g = state[6];
        let h = state[7];

        for (let index = 0; index < 64; index += 1) {
            const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
            const choose = (e & f) ^ (~e & g);
            const temp1 = (
                h
                + sum1
                + choose
                + SHA256_ROUND_CONSTANTS[index]
                + schedule[index]
            ) >>> 0;
            const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (sum0 + majority) >>> 0;

            h = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }

        state[0] = (state[0] + a) >>> 0;
        state[1] = (state[1] + b) >>> 0;
        state[2] = (state[2] + c) >>> 0;
        state[3] = (state[3] + d) >>> 0;
        state[4] = (state[4] + e) >>> 0;
        state[5] = (state[5] + f) >>> 0;
        state[6] = (state[6] + g) >>> 0;
        state[7] = (state[7] + h) >>> 0;
    }

    return state.map(value => value.toString(16).padStart(8, '0')).join('');
};

const normalizeDeclaredFile = (file: string | undefined): string => {
    const normalized = String(file || CK_COMPILE_SOURCE_MAP_DEFAULT_FILE)
        .trim()
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/');
    return normalized || CK_COMPILE_SOURCE_MAP_DEFAULT_FILE;
};

const comparableFile = (file: string): string => (
    normalizeDeclaredFile(file).replace(/^\.\//, '').toLocaleLowerCase('en-US')
);

const fileMatches = (expectedFile: string, candidateFile: string): boolean => {
    const expected = comparableFile(expectedFile);
    const candidate = comparableFile(candidateFile);
    if (expected === candidate) return true;
    if (expected.includes('/')) return false;
    return candidate.slice(candidate.lastIndexOf('/') + 1) === expected;
};

const normalizeTrustedAbsolutePath = (rawPath: string): string | null => {
    let normalized = String(rawPath || '')
        .trim()
        .replace(/^['"]+|['"]+$/g, '')
        .replace(/\\/g, '/');
    if (/\.ino\.cpp$/i.test(normalized)) normalized = normalized.slice(0, -4);
    if (!/\.ino$/i.test(normalized)) return null;

    // Windows canonicalize() can add the extended-path prefix. The compiler
    // normally omits it, so both sides remove it before hashing.
    if (/^\/\/\?\/UNC\//i.test(normalized)) {
        normalized = `//${normalized.slice('//?/UNC/'.length)}`;
    } else if (/^\/\/\?\//.test(normalized)) {
        normalized = normalized.slice('//?/'.length);
    }

    if (normalized.startsWith('//')) {
        normalized = `//${normalized.slice(2).replace(/\/+/g, '/')}`;
    } else {
        normalized = normalized.replace(/\/+/g, '/');
    }

    const isWindowsDrive = /^[a-z]:\//i.test(normalized);
    const isUnixAbsolute = normalized.startsWith('/') && !normalized.startsWith('//');
    const isUnc = normalized.startsWith('//');
    if (!isWindowsDrive && !isUnixAbsolute && !isUnc) return null;

    const pathParts = normalized.split('/');
    if (pathParts.some(part => part === '.' || part === '..' || part.includes('\0'))) return null;
    // Windows paths are case-insensitive; matching the backend's canonical key
    // prevents harmless drive/directory casing differences from breaking trust.
    return isWindowsDrive || isUnc ? normalized.toLocaleLowerCase('en-US') : normalized;
};

export const normalizeTrustedCompileSketchAlias = (
    payload: unknown,
): TrustedCompileSketchAliasV1 | null => {
    if (!payload || typeof payload !== 'object') return null;
    const value = payload as Record<string, unknown>;
    if (value.schemaVersion !== 1) return null;
    const status = value.status === 'trusted' || value.status === 'revoked'
        ? value.status
        : null;
    const runId = typeof value.runId === 'string' ? value.runId.trim() : '';
    const sourceSha256 = typeof value.sourceSha256 === 'string'
        ? value.sourceSha256.trim().toLocaleLowerCase('en-US')
        : '';
    if (!status || !runId || !/^[0-9a-f]{64}$/.test(sourceSha256)) return null;

    if (status === 'revoked') {
        return Object.freeze({ schemaVersion: 1, status, runId, sourceSha256 });
    }
    const basename = typeof value.basename === 'string' ? value.basename.trim() : '';
    const pathSha256 = typeof value.pathSha256 === 'string'
        ? value.pathSha256.trim().toLocaleLowerCase('en-US')
        : '';
    if (
        !basename
        || basename.includes('/')
        || basename.includes('\\')
        || !/\.ino$/i.test(basename)
        || !/^[0-9a-f]{64}$/.test(pathSha256)
    ) return null;
    return Object.freeze({
        schemaVersion: 1,
        status,
        runId,
        sourceSha256,
        basename,
        pathSha256,
    });
};

/**
 * Convert a compiler-owned dynamic sketch path to the logical source-map file.
 * A basename match alone is intentionally insufficient: the backend must have
 * emitted a current-run alias after validating the exact file on disk.
 */
export const resolveTrustedCompileDiagnosticFile = (
    request: TrustedCompileDiagnosticFileRequest,
): string | null => {
    const alias = request.alias;
    const sourceMap = request.sourceMap;
    if (
        !alias
        || alias.status !== 'trusted'
        || !sourceMap
        || sourceMap.schema !== CK_COMPILE_SOURCE_MAP_SCHEMA
        || sourceMap.version !== CK_COMPILE_SOURCE_MAP_VERSION
        || alias.runId !== String(request.runId || '').trim()
        || alias.sourceSha256 !== String(sourceMap.codeSha256 || '').toLocaleLowerCase('en-US')
    ) return null;

    const normalizedPath = normalizeTrustedAbsolutePath(request.diagnosticFile);
    if (!normalizedPath) return null;
    const basename = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1);
    const basenameMatches = /^[a-z]:\//i.test(normalizedPath) || normalizedPath.startsWith('//')
        ? basename.toLocaleLowerCase('en-US') === alias.basename?.toLocaleLowerCase('en-US')
        : basename === alias.basename;
    if (!basenameMatches || sha256Hex(normalizedPath) !== alias.pathSha256) return null;
    return sourceMap.file;
};

const mappingWidth = (mapping: CompileSourceMapMappingV1): number => (
    mapping.lineEnd - mapping.lineStart
);

const findMappingForLine = (
    sourceMap: CompileSourceMapV1,
    line: number,
    acceptedConfidences?: ReadonlySet<CompileSourceConfidence>,
): Readonly<CompileSourceMapMappingV1> | null => {
    let best: Readonly<CompileSourceMapMappingV1> | null = null;
    for (const mapping of sourceMap.mappings) {
        if (line < mapping.lineStart || line > mapping.lineEnd) continue;
        if (acceptedConfidences && !acceptedConfidences.has(mapping.confidence)) continue;
        if (best === null || mappingWidth(mapping) < mappingWidth(best)) {
            best = mapping;
        }
    }
    return best;
};

/**
 * Freeze mappings from paired markers in the exact code submitted to a compile
 * session. Unclosed boundaries are ignored; they never run through EOF.
 */
export const freezeCompileSourceMap = (
    code: string,
    context: FreezeCompileSourceMapContext = {},
): Readonly<CompileSourceMapV1> => {
    const source = String(code ?? '');
    const file = normalizeDeclaredFile(context.file);
    const lines = source.split(/\r\n|\n|\r/);
    const openBoundaries = new Map<string, OpenBoundary>();
    const closedBoundaries: ClosedBoundary[] = [];
    let closeOrder = 0;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        SOURCE_BOUNDARY_MARKER_RE.lastIndex = 0;
        let markerMatch: RegExpExecArray | null;
        while ((markerMatch = SOURCE_BOUNDARY_MARKER_RE.exec(lines[lineIndex])) !== null) {
            const markerKind = markerMatch[1];
            const rawPayload = markerMatch[2];
            if (markerKind === 'begin') {
                const payload = decodeBeginPayload(rawPayload);
                if (!payload || openBoundaries.has(payload.boundaryId)) continue;
                openBoundaries.set(payload.boundaryId, {
                    payload,
                    lineStart: lineIndex + 1,
                    depth: openBoundaries.size,
                });
                continue;
            }

            const boundaryId = decodeEndPayload(rawPayload);
            if (!boundaryId) continue;
            const opened = openBoundaries.get(boundaryId);
            if (!opened) continue;
            openBoundaries.delete(boundaryId);
            closedBoundaries.push({
                mapping: {
                    file,
                    lineStart: opened.lineStart,
                    lineEnd: lineIndex + 1,
                    blockId: opened.payload.blockId,
                    blockType: opened.payload.blockType,
                    section: opened.payload.section,
                    confidence: opened.payload.confidence,
                },
                depth: opened.depth,
                closeOrder,
            });
            closeOrder += 1;
        }
    }

    closedBoundaries.sort((left, right) => (
        left.mapping.lineStart - right.mapping.lineStart
        || mappingWidth(left.mapping) - mappingWidth(right.mapping)
        || right.depth - left.depth
        || left.closeOrder - right.closeOrder
    ));

    const mappings = Object.freeze(closedBoundaries.map(({ mapping }) => Object.freeze(mapping)));
    return Object.freeze({
        schema: CK_COMPILE_SOURCE_MAP_SCHEMA,
        version: CK_COMPILE_SOURCE_MAP_VERSION,
        codeSha256: sha256Hex(source),
        file,
        lineCount: lines.length,
        mappings,
    });
};

/**
 * Safe compile-diagnostic lookup. File identity and exact compile-code SHA-256
 * are mandatory so stale editor code and library diagnostics cannot hit blocks.
 */
export const lookupCompileSourceMap = (
    sourceMap: Readonly<CompileSourceMapV1> | null | undefined,
    request: CompileSourceMapLookupRequest,
): Readonly<CompileSourceMapMappingV1> | null => {
    if (
        !sourceMap
        || sourceMap.schema !== CK_COMPILE_SOURCE_MAP_SCHEMA
        || sourceMap.version !== CK_COMPILE_SOURCE_MAP_VERSION
        || !/^[0-9a-f]{64}$/i.test(String(sourceMap.codeSha256 || ''))
    ) return null;
    if (!request || !fileMatches(sourceMap.file, request.file)) return null;
    if (!Number.isSafeInteger(request.line) || request.line < 1) return null;

    const suppliedHash = typeof request.codeSha256 === 'string'
        ? request.codeSha256.trim().toLocaleLowerCase('en-US')
        : '';
    const computedHash = typeof request.code === 'string' ? sha256Hex(request.code) : '';
    if (!suppliedHash && !computedHash) return null;
    if (suppliedHash && !/^[0-9a-f]{64}$/.test(suppliedHash)) return null;
    if (suppliedHash && computedHash && suppliedHash !== computedHash) return null;
    const compileHash = computedHash || suppliedHash;
    if (compileHash !== sourceMap.codeSha256.toLocaleLowerCase('en-US')) return null;

    const requestedConfidences = Array.isArray(request.acceptedConfidences)
        ? request.acceptedConfidences.filter(value => VALID_CONFIDENCE.has(value))
        : [];
    if (Array.isArray(request.acceptedConfidences) && requestedConfidences.length === 0) return null;
    const mapping = findMappingForLine(
        sourceMap as CompileSourceMapV1,
        request.line,
        requestedConfidences.length > 0
            ? new Set(requestedConfidences as CompileSourceConfidence[])
            : undefined,
    );
    if (!mapping || !fileMatches(mapping.file, request.file)) return null;
    return mapping;
};

/** Backward-compatible adapter for the legacy in-memory line -> block API. */
export const compileSourceMapToLegacyLineMap = (
    sourceMap: Readonly<CompileSourceMapV1>,
): ReadonlyMap<number, string> => {
    const lineMap = new Map<number, string>();
    for (let line = 1; line <= sourceMap.lineCount; line += 1) {
        const mapping = findMappingForLine(sourceMap as CompileSourceMapV1, line);
        if (mapping) lineMap.set(line, mapping.blockId);
    }
    return lineMap;
};
