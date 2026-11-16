import {
    describeSerialField,
    isStableSerialFieldId,
} from './serial_field_identity';
import {
    DEFAULT_SERIAL_CSV_LABELS,
    resolveSerialCsvLabels,
    type SerialCsvHeaderMode,
    type SerialCsvLabels,
} from './serial_csv';

export type SerialTriggerComparator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';

export type SerialTriggerRecorderState = 'idle' | 'armed' | 'capturing' | 'frozen';

export type SerialTriggerFreezeReason = 'window_complete' | 'record_limit' | 'manual';

export interface SerialTriggerRecord {
    timestamp: number;
    sequence: number;
    values: Record<string, number>;
    format?: string;
}

export interface SerialTriggerConfig {
    /** Locale-independent series identity. Never store a display label here. */
    channelId: string;
    comparator: SerialTriggerComparator;
    threshold: number;
    preWindowMs: number;
    postWindowMs: number;
    /** Pre-Phase-2A input key, retained only while an old capture is active. */
    legacyChannel?: string;
}

export type SerialTriggerConfigInput = SerialTriggerConfig | {
    /** @deprecated Pass channelId. Kept so an in-memory pre-Phase-2A draft still arms safely. */
    channel: string;
    comparator: SerialTriggerComparator;
    threshold: number;
    preWindowMs: number;
    postWindowMs: number;
};

export interface SerialTriggerRecorderSummary {
    state: SerialTriggerRecorderState;
    config: SerialTriggerConfig | null;
    bufferedRecords: number;
    triggerIndex: number | null;
    triggerTimestamp: number | null;
    triggerValue: number | null;
    freezeReason: SerialTriggerFreezeReason | null;
    truncated: boolean;
}

export interface SerialTriggerCapture {
    config: SerialTriggerConfig;
    records: SerialTriggerRecord[];
    triggerIndex: number;
    triggerTimestamp: number;
    triggerValue: number;
    freezeReason: SerialTriggerFreezeReason;
    truncated: boolean;
}

export interface SerialTriggerExportContext {
    port?: string | null;
    baudRate?: number | null;
    droppedRecords?: number;
    /** Presentation-only labels keyed by stable field id. */
    channelLabels?: Readonly<Record<string, string>>;
    /** Legacy output remains the default; localized/stable are explicit opt-ins. */
    headerMode?: SerialCsvHeaderMode;
    /** Presentation-only translated CSV labels. Never used for trigger identity. */
    localizedLabels?: SerialCsvLabels;
}

export type SerialTriggerTransition = 'none' | 'triggered' | 'frozen';

export const DEFAULT_SERIAL_TRIGGER_PRE_WINDOW_MS = 5_000;
export const DEFAULT_SERIAL_TRIGGER_POST_WINDOW_MS = 5_000;
export const MAX_SERIAL_TRIGGER_WINDOW_MS = 30_000;
export const MAX_SERIAL_TRIGGER_RECORDS = 5_000;

const COMPARATORS = new Set<SerialTriggerComparator>([
    'gt',
    'gte',
    'lt',
    'lte',
    'eq',
    'neq',
]);

class FixedRingBuffer<T> {
    private readonly storage: Array<T | undefined>;

    private start = 0;

    private length = 0;

    constructor(readonly capacity: number) {
        if (!Number.isInteger(capacity) || capacity < 1) {
            throw new Error('Ring buffer capacity must be a positive integer.');
        }
        this.storage = new Array<T | undefined>(capacity);
    }

    get size(): number {
        return this.length;
    }

    clear(): void {
        this.storage.fill(undefined);
        this.start = 0;
        this.length = 0;
    }

    peek(): T | undefined {
        return this.length > 0 ? this.storage[this.start] : undefined;
    }

    shift(): T | undefined {
        if (this.length === 0) return undefined;
        const value = this.storage[this.start];
        this.storage[this.start] = undefined;
        this.start = (this.start + 1) % this.capacity;
        this.length -= 1;
        return value;
    }

    push(value: T): boolean {
        if (this.length < this.capacity) {
            const index = (this.start + this.length) % this.capacity;
            this.storage[index] = value;
            this.length += 1;
            return false;
        }

        this.storage[this.start] = value;
        this.start = (this.start + 1) % this.capacity;
        return true;
    }

    toArray(): T[] {
        const values: T[] = [];
        for (let index = 0; index < this.length; index++) {
            const value = this.storage[(this.start + index) % this.capacity];
            if (value !== undefined) values.push(value);
        }
        return values;
    }
}

const clampWindow = (value: number): number => {
    if (!Number.isFinite(value)) return 0;
    return Math.min(MAX_SERIAL_TRIGGER_WINDOW_MS, Math.max(0, Math.round(value)));
};

export const normalizeSerialTriggerConfig = (
    config: SerialTriggerConfigInput,
): SerialTriggerConfig => {
    const usesStableIdentity = 'channelId' in config;
    const inputChannel = (usesStableIdentity ? config.channelId : config.channel).trim().slice(0, 160);
    if (!inputChannel) throw new Error('Trigger channel is required.');
    if (usesStableIdentity && !isStableSerialFieldId(inputChannel)) {
        throw new Error('Trigger channelId must be a stable serial field identity.');
    }
    if (!COMPARATORS.has(config.comparator)) throw new Error('Unsupported trigger comparator.');
    if (!Number.isFinite(config.threshold)) throw new Error('Trigger threshold must be finite.');

    // Every old display-label input is normalized through the same descriptor
    // factory as parser output. The old key is retained only as a read fallback
    // for records that were already buffered before Phase 2A.
    const channelId = usesStableIdentity
        ? inputChannel
        : describeSerialField(inputChannel).fieldId;

    return {
        channelId,
        comparator: config.comparator,
        threshold: config.threshold,
        preWindowMs: clampWindow(config.preWindowMs),
        postWindowMs: clampWindow(config.postWindowMs),
        ...(!usesStableIdentity ? { legacyChannel: inputChannel } : {}),
    };
};

export const serialTriggerMatches = (
    value: number,
    comparator: SerialTriggerComparator,
    threshold: number,
): boolean => {
    if (!Number.isFinite(value) || !Number.isFinite(threshold)) return false;
    switch (comparator) {
        case 'gt': return value > threshold;
        case 'gte': return value >= threshold;
        case 'lt': return value < threshold;
        case 'lte': return value <= threshold;
        case 'eq': return value === threshold;
        case 'neq': return value !== threshold;
    }
};

const escapeCsvCell = (value: string | number): string => {
    const text = String(value);
    return `"${text.replace(/"/g, '""')}"`;
};

const COMPARATOR_SYMBOLS: Record<SerialTriggerComparator, string> = {
    gt: '>',
    gte: '≥',
    lt: '<',
    lte: '≤',
    eq: '=',
    neq: '≠',
};

const FREEZE_REASON_LABELS: Record<SerialTriggerFreezeReason, string> = {
    window_complete: '触发后时间窗完成',
    record_limit: '达到安全记录上限',
    manual: '用户手动冻结',
};

export const buildSerialTriggerCsv = (
    capture: SerialTriggerCapture,
    context: SerialTriggerExportContext = {},
): string => {
    const fieldIds: string[] = [];
    const seen = new Set<string>();
    for (const record of capture.records) {
        for (const fieldId of Object.keys(record.values)) {
            if (seen.has(fieldId)) continue;
            seen.add(fieldId);
            fieldIds.push(fieldId);
        }
    }

    const headerMode = context.headerMode || 'legacy';
    const labels = resolveSerialCsvLabels(
        headerMode,
        context.localizedLabels || DEFAULT_SERIAL_CSV_LABELS,
    );
    const displayLabel = (fieldId: string): string => (
        context.channelLabels?.[fieldId]
        || (fieldId === capture.config.channelId ? capture.config.legacyChannel : undefined)
        || fieldId
    );
    const triggerLabel = headerMode === 'stable' ? capture.config.channelId : displayLabel(capture.config.channelId);

    const droppedRecords = Number.isFinite(context.droppedRecords)
        ? Math.max(0, Math.floor(context.droppedRecords ?? 0))
        : 0;
    const metadataRows = [
        [labels.captureTitle, ''],
        [labels.triggerRule, `${triggerLabel} ${COMPARATOR_SYMBOLS[capture.config.comparator]} ${capture.config.threshold}`],
        [labels.actualTriggerValue, capture.triggerValue],
        [labels.triggerTime, new Date(capture.triggerTimestamp).toISOString()],
        [labels.preWindow, capture.config.preWindowMs],
        [labels.postWindow, capture.config.postWindowMs],
        [labels.windowClock, labels.receivedAt],
        [labels.freezeReason, labels.freezeReasons[capture.freezeReason] || capture.freezeReason],
        [labels.truncated, capture.truncated ? labels.yes : labels.no],
        [labels.droppedRecords, droppedRecords],
        [labels.serialPort, context.port?.trim() || labels.notRecorded],
        [labels.baudRate, Number.isFinite(context.baudRate) ? Math.round(context.baudRate!) : labels.notRecorded],
    ].map((row) => row.map(escapeCsvCell).join(','));

    const rows = [
        ...metadataRows,
        '',
        [labels.timestamp, labels.relativeTriggerTime, labels.sampleIndex, labels.triggerPoint, ...fieldIds.map(fieldId => (
            headerMode === 'stable' ? fieldId : displayLabel(fieldId)
        ))]
            .map(escapeCsvCell)
            .join(','),
        ...capture.records.map((record, index) => [
            escapeCsvCell(new Date(record.timestamp).toISOString()),
            String(record.timestamp - capture.triggerTimestamp),
            String(record.sequence),
            index === capture.triggerIndex ? escapeCsvCell(labels.yes) : '',
            ...fieldIds.map((fieldId) => (
                Object.prototype.hasOwnProperty.call(record.values, fieldId)
                    ? String(record.values[fieldId])
                    : ''
            )),
        ].join(',')),
    ];

    return rows.join('\r\n');
};

export class SerialTriggerRecorder {
    private readonly buffer: FixedRingBuffer<SerialTriggerRecord>;

    private state: SerialTriggerRecorderState = 'idle';

    private config: SerialTriggerConfig | null = null;

    private triggerIndex: number | null = null;

    private triggerTimestamp: number | null = null;

    private triggerValue: number | null = null;

    private freezeReason: SerialTriggerFreezeReason | null = null;

    private truncated = false;

    constructor(capacity = MAX_SERIAL_TRIGGER_RECORDS) {
        this.buffer = new FixedRingBuffer<SerialTriggerRecord>(capacity);
    }

    arm(config: SerialTriggerConfigInput): SerialTriggerRecorderSummary {
        this.buffer.clear();
        this.config = normalizeSerialTriggerConfig(config);
        this.state = 'armed';
        this.triggerIndex = null;
        this.triggerTimestamp = null;
        this.triggerValue = null;
        this.freezeReason = null;
        this.truncated = false;
        return this.getSummary();
    }

    reset(): SerialTriggerRecorderSummary {
        this.buffer.clear();
        this.config = null;
        this.state = 'idle';
        this.triggerIndex = null;
        this.triggerTimestamp = null;
        this.triggerValue = null;
        this.freezeReason = null;
        this.truncated = false;
        return this.getSummary();
    }

    ingest(record: SerialTriggerRecord): SerialTriggerTransition {
        if ((this.state !== 'armed' && this.state !== 'capturing') || !this.config) {
            return 'none';
        }
        if (!Number.isFinite(record.timestamp) || !Number.isFinite(record.sequence)) {
            return 'none';
        }

        if (this.state === 'armed') {
            const minimumTimestamp = record.timestamp - this.config.preWindowMs;
            while ((this.buffer.peek()?.timestamp ?? minimumTimestamp) < minimumTimestamp) {
                this.buffer.shift();
            }

            this.buffer.push(record);

            const value = record.values[this.config.channelId]
                ?? (this.config.legacyChannel ? record.values[this.config.legacyChannel] : undefined);
            if (!serialTriggerMatches(value, this.config.comparator, this.config.threshold)) {
                return 'none';
            }

            this.state = 'capturing';
            this.triggerIndex = this.buffer.size - 1;
            this.triggerTimestamp = record.timestamp;
            this.triggerValue = value;

            if (this.config.postWindowMs === 0) {
                this.finish('window_complete');
                return 'frozen';
            }
            if (this.buffer.size >= this.buffer.capacity) {
                this.truncated = true;
                this.finish('record_limit');
                return 'frozen';
            }
            return 'triggered';
        }

        if (this.buffer.size >= this.buffer.capacity) {
            this.truncated = true;
            this.finish('record_limit');
            return 'frozen';
        }

        this.buffer.push(record);
        if (record.timestamp - (this.triggerTimestamp ?? record.timestamp) >= this.config.postWindowMs) {
            this.finish('window_complete');
            return 'frozen';
        }
        if (this.buffer.size >= this.buffer.capacity) {
            this.truncated = true;
            this.finish('record_limit');
            return 'frozen';
        }
        return 'none';
    }

    freeze(): SerialTriggerRecorderSummary {
        if (this.state === 'capturing') this.finish('manual');
        return this.getSummary();
    }

    getSummary(): SerialTriggerRecorderSummary {
        return {
            state: this.state,
            config: this.config ? { ...this.config } : null,
            bufferedRecords: this.buffer.size,
            triggerIndex: this.triggerIndex,
            triggerTimestamp: this.triggerTimestamp,
            triggerValue: this.triggerValue,
            freezeReason: this.freezeReason,
            truncated: this.truncated,
        };
    }

    getCapture(): SerialTriggerCapture | null {
        if (
            this.state !== 'frozen'
            || !this.config
            || this.triggerIndex === null
            || this.triggerTimestamp === null
            || this.triggerValue === null
            || !this.freezeReason
        ) {
            return null;
        }

        return {
            config: { ...this.config },
            records: this.buffer.toArray(),
            triggerIndex: this.triggerIndex,
            triggerTimestamp: this.triggerTimestamp,
            triggerValue: this.triggerValue,
            freezeReason: this.freezeReason,
            truncated: this.truncated,
        };
    }

    private finish(reason: SerialTriggerFreezeReason): void {
        this.state = 'frozen';
        this.freezeReason = reason;
    }
}
