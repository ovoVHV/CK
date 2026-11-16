import {
    createGeneratedSerialField,
    createSourceSerialField,
    describeSerialField,
    isGeneratedSerialFieldId,
    normalizeSerialRecordIdentity,
    type SerialFieldDescriptor,
    type SerialFieldDescriptorMap,
    type SerialFieldId,
} from '../services/serial_field_identity';

export {
    createGeneratedSerialField,
    createSourceSerialField,
    describeSerialField,
    getSerialFieldDisplayLabel,
    isGeneratedSerialFieldId,
    isStableSerialFieldId,
    normalizeSerialRecordIdentity,
    resolveSerialPresentationLocale,
} from '../services/serial_field_identity';
export type {
    SerialFieldDescriptor,
    SerialFieldDescriptorMap,
    SerialFieldId,
    SerialPresentationLocale,
} from '../services/serial_field_identity';

export const MAX_SERIAL_CHANNELS = 8;

export type SerialDataFormat = 'json' | 'csv' | 'key-value' | 'numbers';

export interface ParsedSerialRecord {
    /** Numeric samples keyed only by locale-independent machine identity. */
    values: Record<SerialFieldId, number>;
    /** Presentation metadata; display text is resolved at render/export time. */
    fields: SerialFieldDescriptorMap;
    format: SerialDataFormat;
}

export interface SerialParserState {
    csvHeaders: SerialFieldDescriptor[] | null;
}

export interface SerialFieldStabilityUpdate {
    /** All stable field identities in this record that are safe to expose. */
    confirmedFieldIds: SerialFieldId[];
    /** Field identities that became stable and should be backfilled. */
    newlyConfirmedFieldIds: SerialFieldId[];
}

export interface SerialLineStreamBatch {
    /** Complete logical lines in their original receive order. */
    lines: string[];
    /** Text decoded from this payload, used only for transport-quality stats. */
    decodedText: string;
    /** Oversized unterminated records discarded without parsing a partial tail. */
    discardedOversizeLines: number;
}

const DEFAULT_MAX_SERIAL_LINE_CHARACTERS = 8192;
const DEFAULT_FIELD_CONFIRMATION_COUNT = 3;
const DEFAULT_FIELD_CONFIRMATION_WINDOW = 16;
const MAX_FIELD_CANDIDATES = MAX_SERIAL_CHANNELS * 4;

const NUMBER_TOKEN = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const KEY_VALUE_PATTERN = /([\p{L}_][\p{L}\p{N}_.\-/]*)\s*[:=]\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/gu;
const KEY_VALUE_SEPARATOR = /^[\s,;|]*$/u;
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

type MutableSerialRecord = {
    values: Record<SerialFieldId, number>;
    fields: SerialFieldDescriptorMap;
};

const addValue = (
    target: MutableSerialRecord,
    descriptor: SerialFieldDescriptor,
    value: number,
): void => {
    if (!Number.isFinite(value) || Object.keys(target.values).length >= MAX_SERIAL_CHANNELS) return;

    let nextDescriptor = descriptor;
    let suffix = 2;
    while (Object.prototype.hasOwnProperty.call(target.values, nextDescriptor.fieldId)) {
        const baseLabel = descriptor.kind === 'source'
            ? descriptor.sourceLabel
            : `Data ${descriptor.ordinal}`;
        nextDescriptor = createSourceSerialField(`${baseLabel} ${suffix++}`);
    }
    target.values[nextDescriptor.fieldId] = value;
    target.fields[nextDescriptor.fieldId] = nextDescriptor;
};

const flattenJsonNumbers = (
    input: unknown,
    target: MutableSerialRecord,
    prefix = '',
): void => {
    if (Object.keys(target.values).length >= MAX_SERIAL_CHANNELS) return;

    if (typeof input === 'number') {
        addValue(
            target,
            prefix ? createSourceSerialField(prefix) : createGeneratedSerialField(1),
            input,
        );
        return;
    }

    if (Array.isArray(input)) {
        for (let index = 0; index < input.length; index++) {
            if (Object.keys(target.values).length >= MAX_SERIAL_CHANNELS) break;
            if (prefix) flattenJsonNumbers(input[index], target, `${prefix}.${index + 1}`);
            else if (typeof input[index] === 'number') {
                addValue(target, createGeneratedSerialField(index + 1), input[index]);
            } else {
                flattenJsonNumbers(input[index], target, String(index + 1));
            }
        }
        return;
    }

    if (input && typeof input === 'object') {
        for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
            if (Object.keys(target.values).length >= MAX_SERIAL_CHANNELS) break;
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
        const record: MutableSerialRecord = { values: {}, fields: {} };
        flattenJsonNumbers(JSON.parse(line), record);
        return Object.keys(record.values).length > 0 ? { ...record, format: 'json' } : null;
    } catch {
        return null;
    }
};

const parseKeyValueRecord = (line: string): ParsedSerialRecord | null => {
    const record: MutableSerialRecord = { values: {}, fields: {} };
    KEY_VALUE_PATTERN.lastIndex = 0;
    let consumedUntil = 0;

    let match: RegExpExecArray | null;
    while ((match = KEY_VALUE_PATTERN.exec(line)) !== null) {
        // Do not cherry-pick a plausible key=value fragment out of an
        // otherwise damaged/log line. Between complete fields we only accept
        // deterministic separators, so `junk shidu:42` cannot create a
        // telemetry series named `shidu`.
        if (!KEY_VALUE_SEPARATOR.test(line.slice(consumedUntil, match.index))) return null;
        const value = toFiniteNumber(match[2]);
        if (value !== null) addValue(record, createSourceSerialField(match[1]), value);
        consumedUntil = KEY_VALUE_PATTERN.lastIndex;
    }

    if (!KEY_VALUE_SEPARATOR.test(line.slice(consumedUntil))) return null;
    return Object.keys(record.values).length > 0 ? { ...record, format: 'key-value' } : null;
};

const parseLabelledNumberRecord = (line: string): ParsedSerialRecord | null => {
    // Common classroom sketches often emit a label and number with two
    // Serial.print calls, for example `温度` followed by `24`. Accept a clear
    // whitespace separator for every language, and the unambiguous CJK+number
    // form. Do not guess arbitrary Latin log suffixes such as `error404`.
    const separated = line.match(
        /^([\p{L}_][\p{L}\p{N}_.\-/]*(?:[ \t]+))([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)$/u,
    );
    const joinedCjk = separated ? null : line.match(
        /^([\p{Script=Han}]+)([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)$/u,
    );
    const match = separated || joinedCjk;
    if (!match) return null;

    const value = toFiniteNumber(match[2]);
    if (value === null) return null;
    const record: MutableSerialRecord = { values: {}, fields: {} };
    addValue(record, createSourceSerialField(match[1]), value);
    return { ...record, format: 'key-value' };
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
        state.csvHeaders = cells.map((cell, index) => {
            const label = safeLabel(cell, '');
            return label
                ? createSourceSerialField(label)
                : createGeneratedSerialField(index + 1);
        });
        return null;
    }

    // Mixed rows such as log messages are not treated as telemetry CSV.
    if (numericCount !== cells.length) return null;

    const record: MutableSerialRecord = { values: {}, fields: {} };
    numericValues.forEach((value, index) => {
        if (value === null) return;
        const descriptor = state.csvHeaders?.[index] || createGeneratedSerialField(index + 1);
        addValue(record, descriptor, value);
    });
    return Object.keys(record.values).length > 0 ? { ...record, format: 'csv' } : null;
};

const parseNumberList = (line: string): ParsedSerialRecord | null => {
    const tokens = line.split(/[\s]+/).filter(Boolean).slice(0, MAX_SERIAL_CHANNELS);
    if (tokens.length === 0) return null;
    const numbers = tokens.map(toFiniteNumber);
    if (numbers.some((value) => value === null)) return null;

    const record: MutableSerialRecord = { values: {}, fields: {} };
    numbers.forEach((value, index) => {
        if (value !== null) addValue(record, createGeneratedSerialField(index + 1), value);
    });
    return Object.keys(record.values).length > 0 ? { ...record, format: 'numbers' } : null;
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
        || parseLabelledNumberRecord(line)
        || parseNumberList(line);
};

type SerialFieldCandidate = {
    observations: number;
    lastRecordOrdinal: number;
};

/**
 * Prevents one-off damaged labels from becoming permanent chart series.
 *
 * Complete records keep flowing in receive order. Generated numeric field ids
 * (`serial.generated.1`, ...) are deterministic and trusted immediately. Named
 * fields must appear unchanged in several nearby complete records before the
 * UI exposes them. The plotter can then backfill their earlier samples from
 * its ordered history without inventing, sorting, or dropping receive order.
 */
export class SerialFieldStabilityTracker {
    private readonly candidates = new Map<string, SerialFieldCandidate>();
    private readonly confirmed = new Set<string>();
    private recordOrdinal = 0;

    constructor(
        private readonly requiredObservations = DEFAULT_FIELD_CONFIRMATION_COUNT,
        private readonly confirmationWindowRecords = DEFAULT_FIELD_CONFIRMATION_WINDOW,
    ) {
        if (!Number.isSafeInteger(requiredObservations) || requiredObservations < 1) {
            throw new RangeError('requiredObservations must be a positive integer');
        }
        if (!Number.isSafeInteger(confirmationWindowRecords) || confirmationWindowRecords < 1) {
            throw new RangeError('confirmationWindowRecords must be a positive integer');
        }
    }

    observe(record: ParsedSerialRecord): SerialFieldStabilityUpdate {
        this.recordOrdinal += 1;
        const normalized = normalizeSerialRecordIdentity(record);
        const fieldIds = Array.from(new Set(Object.keys(normalized.values)));
        const newlyConfirmedFieldIds: SerialFieldId[] = [];

        for (const fieldId of fieldIds) {
            if (this.confirmed.has(fieldId)) continue;

            if (isGeneratedSerialFieldId(fieldId)) {
                this.confirm(fieldId, newlyConfirmedFieldIds);
                continue;
            }

            const prior = this.candidates.get(fieldId);
            const isNearby = prior
                && this.recordOrdinal - prior.lastRecordOrdinal <= this.confirmationWindowRecords;
            const next: SerialFieldCandidate = {
                observations: isNearby ? prior.observations + 1 : 1,
                lastRecordOrdinal: this.recordOrdinal,
            };
            this.candidates.set(fieldId, next);
            if (next.observations >= this.requiredObservations) {
                this.confirm(fieldId, newlyConfirmedFieldIds);
            }
        }

        this.pruneCandidates();
        return {
            confirmedFieldIds: fieldIds.filter((fieldId) => this.confirmed.has(fieldId)),
            newlyConfirmedFieldIds,
        };
    }

    isConfirmed(fieldIdOrLegacyLabel: string): boolean {
        return this.confirmed.has(describeSerialField(fieldIdOrLegacyLabel).fieldId);
    }

    reset(): void {
        this.candidates.clear();
        this.confirmed.clear();
        this.recordOrdinal = 0;
    }

    /** Drop only untrusted observations at a transport boundary. */
    resynchronize(): void {
        this.candidates.clear();
        this.recordOrdinal = 0;
    }

    private confirm(fieldId: SerialFieldId, target: SerialFieldId[]): void {
        if (this.confirmed.size >= MAX_SERIAL_CHANNELS || this.confirmed.has(fieldId)) return;
        this.confirmed.add(fieldId);
        this.candidates.delete(fieldId);
        target.push(fieldId);
    }

    private pruneCandidates(): void {
        for (const [label, candidate] of this.candidates) {
            if (this.recordOrdinal - candidate.lastRecordOrdinal > this.confirmationWindowRecords) {
                this.candidates.delete(label);
            }
        }

        if (this.candidates.size <= MAX_FIELD_CANDIDATES) return;
        const oldest = Array.from(this.candidates.entries())
            .sort((left, right) => left[1].lastRecordOrdinal - right[1].lastRecordOrdinal);
        for (let index = 0; index < oldest.length - MAX_FIELD_CANDIDATES; index++) {
            this.candidates.delete(oldest[index][0]);
        }
    }
}

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
        if (payload.every((value) => (
            typeof value === 'number'
            && Number.isInteger(value)
            && value >= 0
            && value <= 255
        ))) {
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

/**
 * Incrementally decodes raw serial event payloads and frames logical lines.
 *
 * A serial-port read is never assumed to be a line: UTF-8 code points, CRLF,
 * and records may all be split across arbitrary reads, while one read can also
 * contain many records. Oversized unterminated input is discarded up to its
 * next delimiter as one damaged record; its tail is never reinterpreted as a
 * fresh telemetry field.
 */
export class SerialLineStreamDecoder {
    private decoder = new TextDecoder('utf-8');
    private currentLine = '';
    private discardUntilDelimiter = false;
    private countDiscardAsOversize = false;
    private swallowLfAfterCr = false;

    constructor(
        private readonly maxLineCharacters = DEFAULT_MAX_SERIAL_LINE_CHARACTERS,
    ) {
        if (!Number.isSafeInteger(maxLineCharacters) || maxLineCharacters < 16) {
            throw new RangeError('maxLineCharacters must be an integer of at least 16');
        }
    }

    push(payload: unknown): SerialLineStreamBatch {
        const decodedText = decodeSerialPayload(payload, this.decoder);
        const lines: string[] = [];
        let discardedOversizeLines = 0;

        const finishLine = () => {
            if (this.discardUntilDelimiter) {
                if (this.countDiscardAsOversize) discardedOversizeLines++;
                this.discardUntilDelimiter = false;
                this.countDiscardAsOversize = false;
                this.currentLine = '';
                return;
            }
            lines.push(this.currentLine);
            this.currentLine = '';
        };

        for (const character of decodedText) {
            if (this.swallowLfAfterCr) {
                this.swallowLfAfterCr = false;
                if (character === '\n') continue;
            }

            if (character === '\r') {
                finishLine();
                this.swallowLfAfterCr = true;
                continue;
            }
            if (character === '\n') {
                finishLine();
                continue;
            }
            if (this.discardUntilDelimiter) continue;

            this.currentLine += character;
            if (this.currentLine.length > this.maxLineCharacters) {
                this.currentLine = '';
                this.discardUntilDelimiter = true;
                this.countDiscardAsOversize = true;
            }
        }

        return { lines, decodedText, discardedOversizeLines };
    }

    reset(): void {
        this.currentLine = '';
        this.discardUntilDelimiter = false;
        this.countDiscardAsOversize = false;
        this.swallowLfAfterCr = false;
        // Flush and replace the decoder so a UTF-8 prefix from the old serial
        // session cannot combine with bytes from a newly opened port.
        this.decoder.decode();
        this.decoder = new TextDecoder('utf-8');
    }

    /**
     * Start a fresh transport session without trusting that its first byte is
     * the beginning of a logical record. Bytes are ignored until the next
     * CR/LF boundary, preventing a listener attached at `sh|idu:42` from
     * inventing a permanent `idu` telemetry channel.
     */
    resynchronizeAtNextDelimiter(): void {
        this.reset();
        this.discardUntilDelimiter = true;
    }

    getPendingCharacterCount(): number {
        return this.currentLine.length;
    }
}
