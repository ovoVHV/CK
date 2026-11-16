export type SerialCsvHeaderMode = 'legacy' | 'localized' | 'stable';

export interface SerialCsvLabels {
    timestamp: string;
    triggerTime: string;
    sampleIndex: string;
    relativeTriggerTime: string;
    triggerPoint: string;
    triggerRule: string;
    actualTriggerValue: string;
    preWindow: string;
    postWindow: string;
    windowClock: string;
    freezeReason: string;
    truncated: string;
    droppedRecords: string;
    serialPort: string;
    baudRate: string;
    captureTitle: string;
    receivedAt: string;
    yes: string;
    no: string;
    notRecorded: string;
    freezeReasons: Record<string, string>;
}

export const DEFAULT_SERIAL_CSV_LABELS: SerialCsvLabels = {
    timestamp: '时间',
    triggerTime: '触发时间',
    sampleIndex: '采样序号',
    relativeTriggerTime: '相对触发时间(ms)',
    triggerPoint: '触发点',
    triggerRule: '触发规则',
    actualTriggerValue: '实际触发值',
    preWindow: '触发前窗口(ms)',
    postWindow: '触发后窗口(ms)',
    windowClock: '窗口计时依据',
    freezeReason: '冻结原因',
    truncated: '达到录制上限并截断',
    droppedRecords: '录制期间输入积压丢弃(条)',
    serialPort: '串口端口',
    baudRate: '波特率',
    captureTitle: 'CK 串口触发录制',
    receivedAt: 'CK 收到结构化串口数据的时间',
    yes: '是',
    no: '否',
    notRecorded: '未记录',
    freezeReasons: {
        window_complete: '触发后时间窗完成',
        record_limit: '达到安全记录上限',
        manual: '用户手动冻结',
    },
};

export const STABLE_SERIAL_CSV_LABELS: SerialCsvLabels = {
    timestamp: 'timestamp',
    triggerTime: 'trigger_time',
    sampleIndex: 'sample_index',
    relativeTriggerTime: 'relative_trigger_time_ms',
    triggerPoint: 'trigger_point',
    triggerRule: 'trigger_rule',
    actualTriggerValue: 'trigger_value',
    preWindow: 'pre_window_ms',
    postWindow: 'post_window_ms',
    windowClock: 'window_clock',
    freezeReason: 'freeze_reason',
    truncated: 'truncated',
    droppedRecords: 'dropped_records',
    serialPort: 'serial_port',
    baudRate: 'baud_rate',
    captureTitle: 'ck_serial_trigger_capture',
    receivedAt: 'ck_received_structured_serial_time',
    yes: 'true',
    no: 'false',
    notRecorded: 'not_recorded',
    freezeReasons: {
        window_complete: 'window_complete',
        record_limit: 'record_limit',
        manual: 'manual',
    },
};

export const resolveSerialCsvLabels = (
    mode: SerialCsvHeaderMode,
    localized: SerialCsvLabels,
): SerialCsvLabels => mode === 'stable'
    ? STABLE_SERIAL_CSV_LABELS
    : mode === 'localized'
        ? localized
        : DEFAULT_SERIAL_CSV_LABELS;

export interface SerialDataCsvRecord {
    timestamp: number;
    sequence: number;
    values: Readonly<Record<string, number>>;
}

export interface SerialDataCsvChannel {
    fieldId: string;
    label: string;
}

const escapeCsvCell = (value: string | number): string => {
    const text = String(value);
    return `"${text.replace(/"/g, '""')}"`;
};

export const buildSerialDataCsv = (input: {
    records: readonly SerialDataCsvRecord[];
    channels: readonly SerialDataCsvChannel[];
    mode?: SerialCsvHeaderMode;
    localizedLabels?: SerialCsvLabels;
}): string => {
    const mode = input.mode || 'legacy';
    const labels = resolveSerialCsvLabels(mode, input.localizedLabels || DEFAULT_SERIAL_CSV_LABELS);
    const channelHeaders = input.channels.map(channel => mode === 'stable' ? channel.fieldId : channel.label);
    const rows = [
        [labels.timestamp, labels.sampleIndex, ...channelHeaders].map(escapeCsvCell).join(','),
        ...input.records.map(record => [
            escapeCsvCell(new Date(record.timestamp).toISOString()),
            String(record.sequence),
            ...input.channels.map(channel => (
                Object.prototype.hasOwnProperty.call(record.values, channel.fieldId)
                    ? String(record.values[channel.fieldId])
                    : ''
            )),
        ].join(',')),
    ];
    return rows.join('\r\n');
};
