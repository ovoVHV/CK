const CK_BLOCK_MARKER_VERSION = 'v1:';
const CK_BLOCK_MARKER_RE = /\/\* @ck:(\S+?) \*\//;

export interface CkBlockMarker {
    blockId: string;
    payload: string;
    index: number;
    text: string;
}

const encodeUtf8Hex = (value: string): string => (
    Array.from(
        new TextEncoder().encode(value),
        (byte) => byte.toString(16).padStart(2, '0'),
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

/** Encode a Blockly ID for safe use inside a C++ block comment. */
export const encodeBlockMarkerPayload = (blockId: string): string => (
    `${CK_BLOCK_MARKER_VERSION}${encodeUtf8Hex(String(blockId ?? ''))}`
);

/** Decode a marker payload. Unversioned payloads are legacy raw Blockly IDs. */
export const decodeBlockMarkerPayload = (payload: string): string | null => {
    const value = String(payload ?? '');
    if (!value.startsWith(CK_BLOCK_MARKER_VERSION)) return value || null;
    // A malformed versioned payload may be an older raw ID that happens to start
    // with "v1:". Preserve it rather than silently losing its source mapping.
    return decodeUtf8Hex(value.slice(CK_BLOCK_MARKER_VERSION.length)) ?? value;
};

export const createBlockMarkerComment = (blockId: string): string => (
    `/* @ck:${encodeBlockMarkerPayload(blockId)} */`
);

export const findBlockMarker = (source: string): CkBlockMarker | null => {
    const match = CK_BLOCK_MARKER_RE.exec(String(source || ''));
    if (!match || typeof match.index !== 'number') return null;

    const blockId = decodeBlockMarkerPayload(match[1]);
    if (blockId === null) return null;
    return {
        blockId,
        payload: match[1],
        index: match.index,
        text: match[0],
    };
};

export const stripBlockMarkerComments = (source: string): string => (
    String(source || '').replace(/ ?\/\* @ck:\S+? \*\//g, '')
);
