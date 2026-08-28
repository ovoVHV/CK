export const MAX_SERIAL_CHANNELS = 8;

export type SerialDataFormat = 'json' | 'csv' | 'key-value' | 'numbers';

export interface ParsedSerialRecord {
    values: Record<string, number>;
    format: SerialDataFormat;
}

export interface SerialParserState {
    csvHeaders: string[] | null;
}

const NUMBER_TOKEN = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const KEY_VALUE_PATTERN = /([\p{L}_][\p{L}\p{N}_.\-/]*)\s*[:=]\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/gu;

export const createSerialParserState = (): SerialParserState => ({
    csvHeaders: null,
});

export const resetSerialParserState = (state: SerialParserState): void => {
    state.csvHeaders = null;
};

const toFiniteNumber = (token: string): number | null => {
    const trimmed = token.trim();
    if (!NUMBER_TOKEN.test(trimmed)) return null;
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : null;
};

const safeLabel = (value: string, fallback: string): string => {
    const cleaned = value
        .trim()
        .replace(/^["']|["']$/g, '')
        .replace(/[\r\n]/g, ' ')
        .slice(0, 48);
    return cleaned || fallback;
};

const addValue = (
    target: Record<string, number>,
    rawLabel: string,
    value: number,
): void => {
    if (!Number.isFinite(value) || Object.keys(target).length >= MAX_SERIAL_CHANNELS) return;

    const baseLabel = safeLabel(rawLabel, `数据 ${Object.keys(target).length + 1}`);
    let label = baseLabel;
    let suffix = 2;
    while (Object.prototype.hasOwnProperty.call(target, label)) {
        label = `${baseLabel} ${suffix++}`;
    }
    target[label] = value;
};

const flattenJsonNumbers = (
    input: unknown,
    target: Record<string, number>,
    prefix = '',
): void => {
    if (Object.keys(target).length >= MAX_SERIAL_CHANNELS) return;

    if (typeof input === 'number') {
        addValue(target, prefix || '数据 1', input);
        return;
    }

    if (Array.isArray(input)) {
        for (let index = 0; index < input.length; index++) {
            if (Object.keys(target).length >= MAX_SERIAL_CHANNELS) break;
            const nextPrefix = prefix ? `${prefix}.${index + 1}` : `数据 ${index + 1}`;
            flattenJsonNumbers(input[index], target, nextPrefix);
        }
        return;
    }

    if (input && typeof input === 'object') {
        for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
            if (Object.keys(target).length >= MAX_SERIAL_CHANNELS) break;
            const nextPrefix = prefix ? `${prefix}.${key}` : key;
            flattenJsonNumbers(value, target, nextPrefix);
        }
    }
};

const parseJsonRecord = (line: string): ParsedSerialRecord | null => {
    if (!((line.startsWith('{') && line.endsWith('}')) || (line.startsWith('[') && line.endsWith(']')))) {
        return null;
    }

    try {
        const values: Record<string, number> = {};
        flattenJsonNumbers(JSON.parse(line), values);
        return Object.keys(values).length > 0 ? { values, format: 'json' } : null;
    } catch {
        return null;
    }
};

const parseKeyValueRecord = (line: string): ParsedSerialRecord | null => {
    const values: Record<string, number> = {};
    KEY_VALUE_PATTERN.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = KEY_VALUE_PATTERN.exec(line)) !== null) {
        const value = toFiniteNumber(match[2]);
        if (value !== null) addValue(values, match[1], value);
        if (Object.keys(values).length >= MAX_SERIAL_CHANNELS) break;
    }

    return Object.keys(values).length > 0 ? { values, format: 'key-value' } : null;
};

const detectCsvDelimiter = (line: string): string | null => {
    if (line.includes(',')) return ',';
    if (line.includes('\t')) return '\t';
    if (line.includes(';')) return ';';
    return null;
};

// Serial telemetry CSV is intentionally kept simple and deterministic. Quoted
// commas are supported, but multiline quoted fields are not useful telemetry.
const splitCsvLine = (line: string, delimiter: string): string[] => {
    const cells: string[] = [];
    let current = '';
    let quoted = false;

    for (let index = 0; index < line.length; index++) {
        const char = line[index];
        if (char === '"') {
            if (quoted && line[index + 1] === '"') {
                current += '"';
                index++;
            } else {
                quoted = !quoted;
            }
        } else if (char === delimiter && !quoted) {
            cells.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    cells.push(current.trim());
    return cells;
};

const parseCsvRecord = (
    line: string,
    state: SerialParserState,
): ParsedSerialRecord | null => {
    const delimiter = detectCsvDelimiter(line);
    if (!delimiter) return null;

    const cells = splitCsvLine(line, delimiter).slice(0, MAX_SERIAL_CHANNELS);
    if (cells.length < 2) return null;

    const numericValues = cells.map(toFiniteNumber);
    const numericCount = numericValues.filter((value) => value !== null).length;

    // A non-numeric delimited row becomes the header for following numeric rows.
    if (numericCount === 0) {
        state.csvHeaders = cells.map((cell, index) => safeLabel(cell, `数据 ${index + 1}`));
        return null;
    }

    // Mixed rows such as log messages are not treated as telemetry CSV.
    if (numericCount !== cells.length) return null;

    const values: Record<string, number> = {};
    numericValues.forEach((value, index) => {
        if (value === null) return;
        const label = state.csvHeaders?.[index] || `数据 ${index + 1}`;
        addValue(values, label, value);
    });
    return Object.keys(values).length > 0 ? { values, format: 'csv' } : null;
};

const parseNumberList = (line: string): ParsedSerialRecord | null => {
    const tokens = line.split(/[\s]+/).filter(Boolean).slice(0, MAX_SERIAL_CHANNELS);
    if (tokens.length === 0) return null;
    const numbers = tokens.map(toFiniteNumber);
    if (numbers.some((value) => value === null)) return null;

    const values: Record<string, number> = {};
    numbers.forEach((value, index) => {
        if (value !== null) addValue(values, `数据 ${index + 1}`, value);
    });
    return Object.keys(values).length > 0 ? { values, format: 'numbers' } : null;
};

export const parseStructuredSerialLine = (
    rawLine: string,
    state: SerialParserState,
): ParsedSerialRecord | null => {
    const line = rawLine.trim();
    if (!line || line.length > 2048) return null;

    return parseJsonRecord(line)
        || parseKeyValueRecord(line)
        || parseCsvRecord(line, state)
        || parseNumberList(line);
};

const isByteRecord = (payload: Record<string, unknown>): boolean => {
    const entries = Object.entries(payload);
    return entries.length > 0 && entries.every(([key, value], index) => (
        /^\d+$/.test(key)
        && Number(key) === index
        && typeof value === 'number'
        && Number.isInteger(value)
        && value >= 0
        && value <= 255
    ));
};

export const decodeSerialPayload = (payload: unknown, decoder: TextDecoder): string => {
    if (typeof payload === 'string') return payload;

    if (Array.isArray(payload)) {
        if (payload.every((value) => typeof value === 'number')) {
            return decoder.decode(new Uint8Array(payload), { stream: true });
        }
        return `${JSON.stringify(payload)}\n`;
    }

    if (payload && typeof payload === 'object') {
        const record = payload as Record<string, unknown>;
        if (isByteRecord(record)) {
            return decoder.decode(new Uint8Array(Object.values(record) as number[]), { stream: true });
        }
        return `${JSON.stringify(record)}\n`;
    }

    return payload == null ? '' : String(payload);
};

