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
    channel: string;
    comparator: SerialTriggerComparator;
    threshold: number;
    preWindowMs: number;
    postWindowMs: number;
}

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
    config: SerialTriggerConfig,
): SerialTriggerConfig => {
    const channel = config.channel.trim().slice(0, 48);
    if (!channel) throw new Error('Trigger channel is required.');
    if (!COMPARATORS.has(config.comparator)) throw new Error('Unsupported trigger comparator.');
    if (!Number.isFinite(config.threshold)) throw new Error('Trigger threshold must be finite.');

    return {
        channel,
        comparator: config.comparator,
        threshold: config.threshold,
        preWindowMs: clampWindow(config.preWindowMs),
        postWindowMs: clampWindow(config.postWindowMs),
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
    const labels: string[] = [];
    const seen = new Set<string>();
    for (const record of capture.records) {
        for (const label of Object.keys(record.values)) {
            if (seen.has(label)) continue;
            seen.add(label);
            labels.push(label);
        }
    }

    const droppedRecords = Number.isFinite(context.droppedRecords)
        ? Math.max(0, Math.floor(context.droppedRecords ?? 0))
        : 0;
    const metadataRows = [
        ['CK 串口触发录制', ''],
        ['触发规则', `${capture.config.channel} ${COMPARATOR_SYMBOLS[capture.config.comparator]} ${capture.config.threshold}`],
        ['实际触发值', capture.triggerValue],
        ['触发时间', new Date(capture.triggerTimestamp).toISOString()],
        ['触发前窗口(ms)', capture.config.preWindowMs],
        ['触发后窗口(ms)', capture.config.postWindowMs],
        ['窗口计时依据', 'CK 收到结构化串口数据的时间'],
        ['冻结原因', FREEZE_REASON_LABELS[capture.freezeReason]],
        ['达到录制上限并截断', capture.truncated ? '是' : '否'],
        ['录制期间输入积压丢弃(条)', droppedRecords],
        ['串口端口', context.port?.trim() || '未记录'],
        ['波特率', Number.isFinite(context.baudRate) ? Math.round(context.baudRate!) : '未记录'],
    ].map((row) => row.map(escapeCsvCell).join(','));

    const rows = [
        ...metadataRows,
        '',
        ['时间', '相对触发时间(ms)', '采样序号', '触发点', ...labels]
            .map(escapeCsvCell)
            .join(','),
        ...capture.records.map((record, index) => [
            escapeCsvCell(new Date(record.timestamp).toISOString()),
            String(record.timestamp - capture.triggerTimestamp),
            String(record.sequence),
            index === capture.triggerIndex ? escapeCsvCell('是') : '',
            ...labels.map((label) => (
                Object.prototype.hasOwnProperty.call(record.values, label)
                    ? String(record.values[label])
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

    arm(config: SerialTriggerConfig): SerialTriggerRecorderSummary {
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

            const value = record.values[this.config.channel];
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
