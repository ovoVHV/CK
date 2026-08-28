import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    CategoryScale,
    Chart as ChartJS,
    ChartOptions,
    Decimation,
    Legend,
    LinearScale,
    LineElement,
    PointElement,
    Tooltip,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import { listen } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import {
    createSerialParserState,
    decodeSerialPayload,
    MAX_SERIAL_CHANNELS,
    parseStructuredSerialLine,
    resetSerialParserState,
    type SerialDataFormat,
} from './serial_data_parser';
import { SerialTriggerRecorderPanel } from './SerialTriggerRecorderPanel';
import {
    SerialTriggerRecorder,
    buildSerialTriggerCsv,
    type SerialTriggerConfig,
} from '../services/serial_trigger_recorder';
import { useDialog } from '../contexts/DialogContext';

ChartJS.register(
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Tooltip,
    Legend,
    Decimation,
);

interface SerialPlotterProps {
    paused: boolean;
    className?: string;
    fontSize?: number;
    port?: string | null;
    baudRate?: number | null;
}

type PlotPoint = { x: number; y: number };

type DatasetRef = {
    label: string;
    data: PlotPoint[];
    borderColor: string;
    backgroundColor: string;
    borderWidth: number;
    pointRadius: number;
    fill: boolean;
    spanGaps: boolean;
};

type PendingRecord = {
    timestamp: number;
    values: Record<string, number>;
    format: SerialDataFormat;
};

type StoredRecord = PendingRecord & { sequence: number };

type ChannelStats = {
    label: string;
    color: string;
    current: number;
    min: number;
    max: number;
    sum: number;
    count: number;
};

const MAX_POINTS_PER_CHANNEL = 1800;
const MAX_EXPORT_RECORDS = 10000;
const MAX_PENDING_RECORDS = 2000;
const MAX_PROCESS_PER_TICK = 300;
const UPDATE_INTERVAL_MS = 80;
const TRIGGER_UI_UPDATE_INTERVAL_MS = 320;
const PARSER_BUFFER_MAX = 8192;
const MAX_CHUNK_CHARACTERS = 65536;
const MAX_LINES_PER_CHUNK = 4000;

const COLORS = [
    '#0f9f94',
    '#ef4444',
    '#3b82f6',
    '#eab308',
    '#8b5cf6',
    '#f97316',
    '#ec4899',
    '#0891b2',
];

const FORMAT_LABELS: Record<SerialDataFormat, string> = {
    json: 'JSON',
    csv: 'CSV',
    'key-value': 'key=value',
    numbers: '数值行',
};

const formatValue = (value: number): string => {
    if (!Number.isFinite(value)) return '—';
    const absolute = Math.abs(value);
    if ((absolute > 0 && absolute < 0.001) || absolute >= 1_000_000) {
        return value.toExponential(3);
    }
    return Number.isInteger(value) ? String(value) : Number(value.toPrecision(7)).toString();
};

const escapeCsvCell = (value: string | number): string => {
    const text = String(value);
    return `"${text.replace(/"/g, '""')}"`;
};

export const SerialPlotter: React.FC<SerialPlotterProps> = ({
    paused,
    className = '',
    fontSize = 14,
    port = null,
    baudRate = null,
}) => {
    const dialog = useDialog();
    const rootRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<any>(null);
    const dataRef = useRef<{ datasets: DatasetRef[] }>({ datasets: [] });
    const datasetIndexRef = useRef<Record<string, number>>({});
    const channelStatsRef = useRef<ChannelStats[]>([]);
    const pendingRef = useRef<PendingRecord[]>([]);
    const historyRef = useRef<StoredRecord[]>([]);
    const parserStateRef = useRef(createSerialParserState());
    const parserResidueRef = useRef('');
    const decoderRef = useRef(new TextDecoder('utf-8'));
    const sequenceRef = useRef(0);
    const pausedRef = useRef(paused);
    const detectedFormatsRef = useRef<Set<SerialDataFormat>>(new Set());
    const qualityRef = useRef({ characters: 0, invalid: 0 });
    const warningDismissedRef = useRef(false);
    const exportStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const triggerRecorderRef = useRef<SerialTriggerRecorder | null>(null);
    const triggerUiUpdatedAtRef = useRef(0);
    const droppedCountRef = useRef(0);
    const triggerDroppedBaselineRef = useRef(0);
    const triggerDroppedFrozenRef = useRef(0);
    if (!triggerRecorderRef.current) triggerRecorderRef.current = new SerialTriggerRecorder();

    const [chartData, setChartData] = useState<any>({ datasets: [] });
    const [cards, setCards] = useState<ChannelStats[]>([]);
    const [sampleCount, setSampleCount] = useState(0);
    const [droppedCount, setDroppedCount] = useState(0);
    const [detectedFormats, setDetectedFormats] = useState<SerialDataFormat[]>([]);
    const [qualityWarning, setQualityWarning] = useState(false);
    const [yScaleMode, setYScaleMode] = useState<'auto' | 'fixed_1023'>('auto');
    const [exportStatus, setExportStatus] = useState('');
    const [triggerCaptureExported, setTriggerCaptureExported] = useState(false);
    const [triggerSummary, setTriggerSummary] = useState(
        () => triggerRecorderRef.current!.getSummary(),
    );

    const registerDroppedRecords = (count: number) => {
        if (!Number.isFinite(count) || count <= 0) return;
        droppedCountRef.current += Math.floor(count);
        setDroppedCount(droppedCountRef.current);
    };

    useEffect(() => {
        pausedRef.current = paused;
        if (paused) {
            pendingRef.current = [];
            parserResidueRef.current = '';
            decoderRef.current = new TextDecoder('utf-8');
        }
    }, [paused]);

    useEffect(() => () => {
        if (exportStatusTimerRef.current) clearTimeout(exportStatusTimerRef.current);
    }, []);

    useEffect(() => {
        const container = rootRef.current;
        if (!container || typeof ResizeObserver === 'undefined') return;

        let animationFrame = 0;
        const observer = new ResizeObserver(() => {
            cancelAnimationFrame(animationFrame);
            animationFrame = requestAnimationFrame(() => chartRef.current?.resize());
        });
        observer.observe(container);
        return () => {
            observer.disconnect();
            cancelAnimationFrame(animationFrame);
        };
    }, []);

    const isDark = typeof window !== 'undefined'
        && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const gridColor = isDark ? '#334155' : '#e8eef5';
    const textColor = isDark ? '#94a3b8' : '#64748b';

    const options: ChartOptions<'line'> = useMemo(() => ({
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        normalized: true,
        interaction: {
            mode: 'nearest',
            axis: 'x',
            intersect: false,
        },
        plugins: {
            decimation: {
                enabled: true,
                algorithm: 'min-max',
                threshold: 800,
                samples: 600,
            },
            legend: {
                position: 'bottom',
                labels: {
                    boxWidth: 12,
                    boxHeight: 2,
                    usePointStyle: true,
                    padding: 12,
                    color: textColor,
                    font: {
                        family: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                        size: Math.max(10, Math.round(fontSize * 0.76)),
                    },
                },
            },
            tooltip: {
                callbacks: {
                    title: (items) => items.length > 0 ? `采样 ${items[0].parsed.x}` : '',
                },
            },
        },
        scales: {
            x: {
                type: 'linear',
                display: false,
                grid: { display: false },
            },
            y: {
                display: true,
                min: yScaleMode === 'fixed_1023' ? 0 : undefined,
                max: yScaleMode === 'fixed_1023' ? 1023 : undefined,
                grace: yScaleMode === 'auto' ? '6%' : 0,
                grid: { color: gridColor },
                ticks: {
                    color: textColor,
                    maxTicksLimit: 6,
                    font: { size: Math.max(10, Math.round(fontSize * 0.74)) },
                },
            },
        },
        elements: {
            point: { radius: 0, hitRadius: 8 },
            line: { borderWidth: 1.5, tension: 0.08 },
        },
    }), [fontSize, gridColor, textColor, yScaleMode]);

    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;
        chart.options.scales.y.min = yScaleMode === 'fixed_1023' ? 0 : undefined;
        chart.options.scales.y.max = yScaleMode === 'fixed_1023' ? 1023 : undefined;
        chart.update('none');
    }, [yScaleMode]);

    useEffect(() => {
        let mounted = true;
        let unlisten: (() => void) | undefined;

        const updateInputQuality = (text: string) => {
            if (!text) return;
            const sample = text.length > PARSER_BUFFER_MAX ? text.slice(-PARSER_BUFFER_MAX) : text;
            const replacements = (sample.match(/\uFFFD/g) || []).length;
            const controls = Array.from(sample).reduce((count, character) => {
                const code = character.charCodeAt(0);
                return count + (code < 32 && character !== '\r' && character !== '\n' && character !== '\t' ? 1 : 0);
            }, 0);

            const quality = qualityRef.current;
            quality.characters += sample.length;
            quality.invalid += replacements + controls;
            if (quality.characters > 4096) {
                quality.characters = Math.round(quality.characters * 0.55);
                quality.invalid = Math.round(quality.invalid * 0.55);
            }

            const suspect = quality.characters >= 64
                && quality.invalid >= 3
                && quality.invalid / quality.characters >= 0.025;
            const recovered = quality.characters >= 256
                && quality.invalid / quality.characters < 0.006;

            if (suspect) setQualityWarning(true);
            if (recovered) {
                setQualityWarning(false);
                warningDismissedRef.current = false;
            }
        };

        const rememberFormat = (format: SerialDataFormat) => {
            if (detectedFormatsRef.current.has(format)) return;
            detectedFormatsRef.current.add(format);
            setDetectedFormats(Array.from(detectedFormatsRef.current));
        };

        const consumeChunk = (chunk: string) => {
            if (!chunk) return;
            updateInputQuality(chunk);

            let combined = parserResidueRef.current + chunk;
            if (combined.length > MAX_CHUNK_CHARACTERS) {
                combined = combined.slice(-MAX_CHUNK_CHARACTERS);
                const firstCompleteLine = combined.search(/\r\n|\n|\r/);
                if (firstCompleteLine >= 0) combined = combined.slice(firstCompleteLine + 1);
            }

            let lines = combined.split(/\r\n|\n|\r/);
            parserResidueRef.current = lines.pop() || '';
            if (parserResidueRef.current.length > PARSER_BUFFER_MAX) {
                parserResidueRef.current = parserResidueRef.current.slice(-PARSER_BUFFER_MAX);
            }

            if (lines.length > MAX_LINES_PER_CHUNK) {
                const overflow = lines.length - MAX_LINES_PER_CHUNK;
                lines = lines.slice(-MAX_LINES_PER_CHUNK);
                registerDroppedRecords(overflow);
            }

            const receivedAt = Date.now();
            for (const line of lines) {
                const parsed = parseStructuredSerialLine(line, parserStateRef.current);
                if (!parsed) continue;
                rememberFormat(parsed.format);
                pendingRef.current.push({
                    timestamp: receivedAt,
                    values: parsed.values,
                    format: parsed.format,
                });
            }

            if (pendingRef.current.length > MAX_PENDING_RECORDS) {
                const overflow = pendingRef.current.length - MAX_PENDING_RECORDS;
                pendingRef.current.splice(0, overflow);
                registerDroppedRecords(overflow);
            }
        };

        const setupListener = async () => {
            try {
                const stop = await listen<unknown>('serial-data', (event) => {
                    if (pausedRef.current) return;
                    consumeChunk(decodeSerialPayload(event.payload, decoderRef.current));
                });
                if (!mounted) stop();
                else unlisten = stop;
            } catch (error) {
                console.error('Structured serial data listener failed', error);
            }
        };

        void setupListener();
        return () => {
            mounted = false;
            unlisten?.();
        };
    }, []);

    useEffect(() => {
        const ensureDataset = (label: string): number => {
            const existing = datasetIndexRef.current[label];
            if (typeof existing === 'number') return existing;
            if (dataRef.current.datasets.length >= MAX_SERIAL_CHANNELS) return -1;

            const index = dataRef.current.datasets.length;
            const color = COLORS[index % COLORS.length];
            dataRef.current.datasets.push({
                label,
                data: [],
                borderColor: color,
                backgroundColor: color,
                borderWidth: 1.5,
                pointRadius: 0,
                fill: false,
                spanGaps: true,
            });
            datasetIndexRef.current[label] = index;
            channelStatsRef.current[index] = {
                label,
                color,
                current: 0,
                min: Number.POSITIVE_INFINITY,
                max: Number.NEGATIVE_INFINITY,
                sum: 0,
                count: 0,
            };
            return index;
        };

        const timer = setInterval(() => {
            if (pausedRef.current || pendingRef.current.length === 0) return;
            const batch = pendingRef.current.splice(0, MAX_PROCESS_PER_TICK);
            let datasetAdded = false;
            let triggerStateChanged = false;

            for (const record of batch) {
                const sequence = sequenceRef.current++;
                const storedRecord = { ...record, sequence };
                historyRef.current.push(storedRecord);
                const triggerTransition = triggerRecorderRef.current!.ingest(storedRecord);
                if (triggerTransition !== 'none') {
                    triggerStateChanged = true;
                }
                if (triggerTransition === 'frozen') {
                    triggerDroppedFrozenRef.current = Math.max(
                        0,
                        droppedCountRef.current - triggerDroppedBaselineRef.current,
                    );
                }

                for (const [label, value] of Object.entries(record.values)) {
                    if (!Number.isFinite(value)) continue;
                    const previousDatasetCount = dataRef.current.datasets.length;
                    const index = ensureDataset(label);
                    if (index < 0) continue;
                    if (dataRef.current.datasets.length !== previousDatasetCount) datasetAdded = true;

                    const dataset = dataRef.current.datasets[index];
                    dataset.data.push({ x: sequence, y: value });
                    if (dataset.data.length > MAX_POINTS_PER_CHANNEL) {
                        dataset.data.splice(0, dataset.data.length - MAX_POINTS_PER_CHANNEL);
                    }

                    const stats = channelStatsRef.current[index];
                    stats.current = value;
                    stats.min = Math.min(stats.min, value);
                    stats.max = Math.max(stats.max, value);
                    stats.sum += value;
                    stats.count += 1;
                }
            }

            if (historyRef.current.length > MAX_EXPORT_RECORDS) {
                historyRef.current.splice(0, historyRef.current.length - MAX_EXPORT_RECORDS);
            }

            if (datasetAdded) {
                setChartData({ datasets: [...dataRef.current.datasets] });
            }

            const nextCards = channelStatsRef.current.map((stats) => ({ ...stats }));
            setCards(nextCards);
            setSampleCount(sequenceRef.current);

            const now = Date.now();
            const triggerState = triggerRecorderRef.current!.getSummary().state;
            if (
                triggerStateChanged
                || (triggerState === 'capturing'
                    && now - triggerUiUpdatedAtRef.current >= TRIGGER_UI_UPDATE_INTERVAL_MS)
            ) {
                triggerUiUpdatedAtRef.current = now;
                setTriggerSummary(triggerRecorderRef.current!.getSummary());
            }

            const chart = chartRef.current;
            if (chart) {
                const minimum = Math.max(0, sequenceRef.current - MAX_POINTS_PER_CHANNEL);
                chart.options.scales.x.min = minimum;
                chart.options.scales.x.max = Math.max(1, sequenceRef.current - 1);
                chart.update('none');
            }
        }, UPDATE_INTERVAL_MS);

        return () => clearInterval(timer);
    }, []);

    const confirmDiscardFrozenCapture = async (actionLabel: string): Promise<boolean> => {
        const capture = triggerRecorderRef.current!.getCapture();
        if (triggerSummary.state !== 'frozen' || triggerCaptureExported || !capture) return true;
        return dialog.confirm({
            title: '丢弃未导出的触发录制？',
            message: `当前冻结录制包含 ${capture.records.length} 条数据，尚未导出。${actionLabel}会丢弃这次录制，之后无法恢复。`,
            tone: 'warning',
            confirmLabel: '丢弃录制',
            cancelLabel: '返回导出',
        });
    };

    const clearData = async () => {
        if (!await confirmDiscardFrozenCapture('清空结构化数据')) return;
        dataRef.current.datasets = [];
        datasetIndexRef.current = {};
        channelStatsRef.current = [];
        pendingRef.current = [];
        historyRef.current = [];
        sequenceRef.current = 0;
        parserResidueRef.current = '';
        decoderRef.current = new TextDecoder('utf-8');
        resetSerialParserState(parserStateRef.current);
        detectedFormatsRef.current.clear();
        qualityRef.current = { characters: 0, invalid: 0 };
        warningDismissedRef.current = false;
        triggerRecorderRef.current!.reset();
        triggerUiUpdatedAtRef.current = 0;
        droppedCountRef.current = 0;
        triggerDroppedBaselineRef.current = 0;
        triggerDroppedFrozenRef.current = 0;
        setQualityWarning(false);
        setChartData({ datasets: [] });
        setCards([]);
        setSampleCount(0);
        setDroppedCount(0);
        setDetectedFormats([]);
        setTriggerCaptureExported(false);
        setTriggerSummary(triggerRecorderRef.current!.getSummary());
        chartRef.current?.update('none');
    };

    const showTemporaryExportStatus = (message: string) => {
        setExportStatus(message);
        if (exportStatusTimerRef.current) clearTimeout(exportStatusTimerRef.current);
        exportStatusTimerRef.current = setTimeout(() => setExportStatus(''), 3000);
    };

    const exportData = async () => {
        const records = historyRef.current;
        if (records.length === 0) return;

        const labels = dataRef.current.datasets.map((dataset) => dataset.label);
        const rows = [
            ['时间', '采样序号', ...labels].map(escapeCsvCell).join(','),
            ...records.map((record) => [
                escapeCsvCell(new Date(record.timestamp).toISOString()),
                String(record.sequence),
                ...labels.map((label) => (
                    Object.prototype.hasOwnProperty.call(record.values, label)
                        ? String(record.values[label])
                        : ''
                )),
            ].join(',')),
        ];

        try {
            const date = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
            const target = await save({
                defaultPath: `CK-串口数据-${date}.csv`,
                filters: [{ name: 'CSV 数据', extensions: ['csv'] }],
            });
            if (!target) return;
            await writeTextFile(target, `\uFEFF${rows.join('\r\n')}`);
            showTemporaryExportStatus(`已导出 ${records.length} 条数据`);
        } catch (error) {
            console.error('Serial data export failed', error);
            showTemporaryExportStatus('导出失败，请检查文件权限');
        }
    };

    const armTriggerRecording = async (config: SerialTriggerConfig) => {
        if (!await confirmDiscardFrozenCapture('重新布防')) return;
        setTriggerSummary(triggerRecorderRef.current!.arm(config));
        setTriggerCaptureExported(false);
        triggerUiUpdatedAtRef.current = Date.now();
        triggerDroppedBaselineRef.current = droppedCountRef.current;
        triggerDroppedFrozenRef.current = 0;
    };

    const cancelTriggerRecording = async () => {
        if (!await confirmDiscardFrozenCapture('结束录制')) return;
        setTriggerSummary(triggerRecorderRef.current!.reset());
        setTriggerCaptureExported(false);
        triggerUiUpdatedAtRef.current = 0;
        triggerDroppedBaselineRef.current = droppedCountRef.current;
        triggerDroppedFrozenRef.current = 0;
    };

    const freezeTriggerRecording = () => {
        setTriggerSummary(triggerRecorderRef.current!.freeze());
        triggerUiUpdatedAtRef.current = Date.now();
        triggerDroppedFrozenRef.current = Math.max(
            0,
            droppedCountRef.current - triggerDroppedBaselineRef.current,
        );
    };

    const exportTriggerRecording = async () => {
        const capture = triggerRecorderRef.current!.getCapture();
        if (!capture) return;

        try {
            const date = new Date(capture.triggerTimestamp).toISOString().replace(/[:T]/g, '-').slice(0, 19);
            const target = await save({
                defaultPath: `CK-串口触发录制-${date}.csv`,
                filters: [{ name: 'CSV 数据', extensions: ['csv'] }],
            });
            if (!target) return;
            await writeTextFile(target, `\uFEFF${buildSerialTriggerCsv(capture, {
                port,
                baudRate,
                droppedRecords: triggerDroppedFrozenRef.current,
            })}`);
            setTriggerCaptureExported(true);
            showTemporaryExportStatus(`已导出触发录制 ${capture.records.length} 条数据`);
        } catch (error) {
            console.error('Serial trigger recording export failed', error);
            showTemporaryExportStatus('触发录制导出失败，请检查文件权限');
        }
    };

    return (
        <div
            ref={rootRef}
            className={`w-full h-full min-w-0 min-h-0 overflow-hidden bg-white dark:bg-slate-900 p-2 flex flex-col gap-2 ${className}`}
            data-ck-role="serial-plotter"
        >
            <div className="min-w-0 flex flex-wrap items-center gap-1.5 shrink-0">
                <div className="min-w-0 flex items-center gap-1.5 text-[10px] text-slate-500 dark:text-slate-400 mr-auto">
                    <span className="inline-flex items-center gap-1 rounded-full bg-teal-50 dark:bg-teal-950/50 px-2 py-1 font-semibold text-teal-700 dark:text-teal-300 whitespace-nowrap">
                        <span className="w-1.5 h-1.5 rounded-full bg-teal-500" />
                        自动识别
                    </span>
                    <span className="truncate" title="支持 JSON、CSV、key=value 和纯数值行">
                        {detectedFormats.length > 0
                            ? detectedFormats.map((format) => FORMAT_LABELS[format]).join(' · ')
                            : 'JSON · CSV · key=value'}
                    </span>
                    {paused && (
                        <span className="rounded bg-amber-50 dark:bg-amber-950/40 px-1.5 py-0.5 font-semibold text-amber-700 dark:text-amber-300">
                            已暂停
                        </span>
                    )}
                    {droppedCount > 0 && (
                        <span title="为保持界面流畅，输入过快时只保留最新数据">
                            已丢弃 {droppedCount} 条积压
                        </span>
                    )}
                    {exportStatus && <span className="text-teal-600 dark:text-teal-400">{exportStatus}</span>}
                </div>

                <select
                    value={yScaleMode}
                    onChange={(event) => setYScaleMode(event.target.value as 'auto' | 'fixed_1023')}
                    className="h-7 max-w-[122px] rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-1.5 text-[10px] font-semibold text-slate-600 dark:text-slate-300"
                    title="纵轴范围"
                >
                    <option value="auto">纵轴：自动</option>
                    <option value="fixed_1023">纵轴：0～1023</option>
                </select>
                <button
                    type="button"
                    onClick={() => void exportData()}
                    disabled={sampleCount === 0}
                    className="h-7 px-2 inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 text-[10px] font-semibold text-slate-600 dark:text-slate-300 hover:border-teal-300 hover:text-teal-700 disabled:opacity-40 disabled:cursor-not-allowed"
                    title="将当前保留的数据导出为 CSV"
                >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v12m0 0 4-4m-4 4-4-4M5 19h14" />
                    </svg>
                    <span>导出</span>
                </button>
                <button
                    type="button"
                    onClick={() => void clearData()}
                    disabled={sampleCount === 0 && !qualityWarning}
                    className="h-7 px-2 inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 text-[10px] font-semibold text-slate-600 dark:text-slate-300 hover:border-red-300 hover:text-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
                    title="清空结构化数据"
                >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.9 12.1A2 2 0 0116.1 21H7.9a2 2 0 01-2-1.9L5 7m4 4v6m6-6v6M4 7h16m-5 0V4H9v3" />
                    </svg>
                    <span>清空</span>
                </button>
            </div>

            {qualityWarning && !warningDismissedRef.current && (
                <div
                    role="status"
                    className="shrink-0 min-w-0 flex items-center gap-2 rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 px-2 py-1 text-[10px] text-amber-800 dark:text-amber-200"
                >
                    <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01M10.3 4.4L2.6 18a2 2 0 001.7 3h15.4a2 2 0 001.7-3L13.7 4.4a2 2 0 00-3.4 0z" />
                    </svg>
                    <span className="truncate">收到较多无法解码字符，设备程序与监视器的波特率可能不一致。</span>
                    <button
                        type="button"
                        className="ml-auto shrink-0 px-1 font-semibold hover:text-amber-950 dark:hover:text-white"
                        onClick={() => {
                            warningDismissedRef.current = true;
                            setQualityWarning(false);
                        }}
                    >
                        知道了
                    </button>
                </div>
            )}

            <SerialTriggerRecorderPanel
                channels={cards.map(({ label, color }) => ({ label, color }))}
                summary={triggerSummary}
                captureExported={triggerCaptureExported}
                serialPaused={paused}
                onArm={(config) => void armTriggerRecording(config)}
                onCancel={() => void cancelTriggerRecording()}
                onFreeze={freezeTriggerRecording}
                onExport={() => void exportTriggerRecording()}
            />

            {cards.length > 0 && (
                <div className="shrink-0 min-w-0 flex gap-2 overflow-x-auto pb-0.5" aria-label="最新串口数值">
                    {cards.map((stats) => (
                        <div
                            key={stats.label}
                            className="min-w-[116px] max-w-[190px] flex-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-800/70 px-2.5 py-1.5"
                            title={`${stats.label}：最小 ${formatValue(stats.min)}，最大 ${formatValue(stats.max)}`}
                        >
                            <div className="flex items-center gap-1.5 min-w-0">
                                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: stats.color }} />
                                <span className="truncate text-[10px] font-semibold text-slate-500 dark:text-slate-400">{stats.label}</span>
                            </div>
                            <div
                                className="truncate font-mono font-bold text-slate-800 dark:text-slate-100 leading-tight mt-0.5"
                                style={{ fontSize: Math.max(13, Math.round(fontSize * 0.98)) }}
                            >
                                {formatValue(stats.current)}
                            </div>
                            <div className="truncate text-[9px] font-mono text-slate-400 dark:text-slate-500">
                                min {formatValue(stats.min)} · max {formatValue(stats.max)}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <div className="flex-1 min-w-0 min-h-[90px] relative rounded-lg border border-slate-100 dark:border-slate-800 overflow-hidden">
                {cards.length === 0 && (
                    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center px-4 text-center pointer-events-none">
                        <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">等待可识别的串口数据</div>
                        <div className="mt-1 max-w-xl text-[10px] leading-relaxed text-slate-400 dark:text-slate-500">
                            示例：{`{"温度": 24.6, "湿度": 51}`}　·　温度=24.6 湿度=51　·　温度,湿度 / 24.6,51
                        </div>
                    </div>
                )}
                <Line ref={chartRef} options={options} data={chartData} />
            </div>
        </div>
    );
};
