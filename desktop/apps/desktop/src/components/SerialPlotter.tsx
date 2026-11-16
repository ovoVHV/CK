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
import { Activity, Download, RotateCcw, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import {
    createSerialParserState,
    describeSerialField,
    getSerialFieldDisplayLabel,
    MAX_SERIAL_CHANNELS,
    parseStructuredSerialLine,
    resetSerialParserState,
    resolveSerialPresentationLocale,
    SerialFieldStabilityTracker,
    SerialLineStreamDecoder,
    type SerialDataFormat,
    type SerialFieldDescriptorMap,
    type SerialFieldId,
    type SerialPresentationLocale,
} from './serial_data_parser';
import { SerialTriggerRecorderPanel } from './SerialTriggerRecorderPanel';
import {
    SerialTriggerRecorder,
    buildSerialTriggerCsv,
    type SerialTriggerConfig,
} from '../services/serial_trigger_recorder';
import {
    buildSerialDataCsv,
    DEFAULT_SERIAL_CSV_LABELS,
    type SerialCsvHeaderMode,
    type SerialCsvLabels,
} from '../services/serial_csv';
import { useDialog } from '../contexts/DialogContext';
import { useTranslation } from 'react-i18next';

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
    /** Presentation-only locale. Omit to follow the document lang attribute. */
    presentationLocale?: SerialPresentationLocale;
}

type PlotPoint = { x: number; y: number };

type DatasetRef = {
    fieldId: SerialFieldId;
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
    values: Record<SerialFieldId, number>;
    fields: SerialFieldDescriptorMap;
    format: SerialDataFormat;
};

type StoredRecord = PendingRecord & { sequence: number };

type ChannelStats = {
    fieldId: SerialFieldId;
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
const QUALITY_SAMPLE_MAX = 8192;
const MAX_LINES_PER_CHUNK = 4000;
const MIN_VISIBLE_POINTS = 30;
const DEFAULT_VISIBLE_POINTS = 300;

export const collectStableFieldPoints = (
    records: ReadonlyArray<{ sequence: number; values: Record<SerialFieldId, number> }>,
    fieldId: SerialFieldId,
): PlotPoint[] => records.flatMap((record) => {
    const value = record.values[fieldId];
    return Number.isFinite(value) ? [{ x: record.sequence, y: value }] : [];
});

type SerialChartViewport = {
    visiblePoints: number;
    endSequence: number | null;
};

type ResolvedSerialChartViewport = {
    minimum: number;
    maximum: number;
    latest: number;
    followingLatest: boolean;
};

type SerialChartDrag = {
    pointerId: number;
    startX: number;
    startEndSequence: number;
    width: number;
    visiblePoints: number;
};

const clampNumber = (value: number, minimum: number, maximum: number): number => (
    Math.min(maximum, Math.max(minimum, value))
);

export const resolveSerialChartViewport = (
    viewport: SerialChartViewport,
    sequenceCount: number,
): ResolvedSerialChartViewport => {
    const latest = Math.max(0, sequenceCount - 1);
    const earliest = Math.max(0, sequenceCount - MAX_POINTS_PER_CHANNEL);
    const visiblePoints = clampNumber(
        Math.round(viewport.visiblePoints),
        MIN_VISIBLE_POINTS,
        MAX_POINTS_PER_CHANNEL,
    );
    const requestedEnd = viewport.endSequence === null
        ? latest
        : Math.round(viewport.endSequence);
    const maximum = clampNumber(requestedEnd, earliest, latest);
    const minimum = Math.max(earliest, maximum - visiblePoints + 1);
    const followingLatest = viewport.endSequence === null || maximum >= latest;

    return {
        minimum,
        maximum: Math.max(minimum + 1, maximum),
        latest,
        followingLatest,
    };
};

const normalizeVisiblePoints = (value: number): number => clampNumber(
    Math.round(value),
    MIN_VISIBLE_POINTS,
    MAX_POINTS_PER_CHANNEL,
);

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

const formatLabelKey = (format: SerialDataFormat): string => ({
    json: 'format.json',
    csv: 'format.csv',
    'key-value': 'format.keyValue',
    numbers: 'format.numbers',
}[format]);

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
    presentationLocale,
}) => {
    const dialog = useDialog();
    const { t: translate } = useTranslation('serial');
    const t = translate as unknown as (key: string, options?: Record<string, unknown>) => string;
    const rootRef = useRef<HTMLDivElement>(null);
    const chartViewportRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<any>(null);
    const dataRef = useRef<{ datasets: DatasetRef[] }>({ datasets: [] });
    const datasetIndexRef = useRef<Record<string, number>>({});
    const fieldDescriptorsRef = useRef<SerialFieldDescriptorMap>({});
    const channelStatsRef = useRef<ChannelStats[]>([]);
    const pendingRef = useRef<PendingRecord[]>([]);
    const historyRef = useRef<StoredRecord[]>([]);
    const parserStateRef = useRef(createSerialParserState());
    const fieldStabilityRef = useRef(new SerialFieldStabilityTracker());
    const lineStreamRef = useRef(new SerialLineStreamDecoder());
    const streamIdentityRef = useRef<string | null>(null);
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
    const viewportRef = useRef<SerialChartViewport>({
        visiblePoints: DEFAULT_VISIBLE_POINTS,
        endSequence: null,
    });
    const chartDragRef = useRef<SerialChartDrag | null>(null);
    if (!triggerRecorderRef.current) triggerRecorderRef.current = new SerialTriggerRecorder();

    const [chartData, setChartData] = useState<any>({ datasets: [] });
    const [cards, setCards] = useState<ChannelStats[]>([]);
    const [sampleCount, setSampleCount] = useState(0);
    const [droppedCount, setDroppedCount] = useState(0);
    const [detectedFormats, setDetectedFormats] = useState<SerialDataFormat[]>([]);
    const [qualityWarning, setQualityWarning] = useState(false);
    const [yScaleMode, setYScaleMode] = useState<'auto' | 'fixed_1023'>('auto');
    const [exportStatus, setExportStatus] = useState('');
    const [csvHeaderMode, setCsvHeaderMode] = useState<SerialCsvHeaderMode>('legacy');
    const [triggerCaptureExported, setTriggerCaptureExported] = useState(false);
    const [visiblePointCount, setVisiblePointCount] = useState(DEFAULT_VISIBLE_POINTS);
    const [followingLatest, setFollowingLatest] = useState(true);
    const [isDarkMode, setIsDarkMode] = useState(
        () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
    );
    const [documentPresentationLocale, setDocumentPresentationLocale] = useState<SerialPresentationLocale>(
        () => resolveSerialPresentationLocale(
            typeof document === 'undefined' ? undefined : document.documentElement.lang,
        ),
    );
    const activePresentationLocale = presentationLocale || documentPresentationLocale;
    const activePresentationLocaleRef = useRef(activePresentationLocale);
    activePresentationLocaleRef.current = activePresentationLocale;
    const [triggerSummary, setTriggerSummary] = useState(
        () => triggerRecorderRef.current!.getSummary(),
    );

    const csvLabels = useMemo<SerialCsvLabels>(() => ({
        ...DEFAULT_SERIAL_CSV_LABELS,
        timestamp: t('export.headers.timestamp'),
        triggerTime: t('export.headers.triggerTime'),
        sampleIndex: t('export.headers.sampleIndex'),
        relativeTriggerTime: t('export.headers.relativeTriggerTime'),
        triggerPoint: t('export.headers.triggerPoint'),
        triggerRule: t('export.headers.triggerRule'),
        actualTriggerValue: t('export.headers.actualTriggerValue'),
        preWindow: t('export.headers.preWindow'),
        postWindow: t('export.headers.postWindow'),
        windowClock: t('export.headers.windowClock'),
        freezeReason: t('export.headers.freezeReason'),
        truncated: t('export.headers.truncated'),
        droppedRecords: t('export.headers.droppedRecords'),
        serialPort: t('export.headers.serialPort'),
        baudRate: t('export.headers.baudRate'),
        captureTitle: t('export.headers.captureTitle'),
        receivedAt: t('export.headers.receivedAt'),
        yes: t('export.headers.yes'),
        no: t('export.headers.no'),
        notRecorded: t('export.headers.notRecorded'),
        freezeReasons: {
            window_complete: t('export.headers.freezeReasons.windowComplete'),
            record_limit: t('export.headers.freezeReasons.recordLimit'),
            manual: t('export.headers.freezeReasons.manual'),
        },
    }), [activePresentationLocale, t]);

    const applyChartViewport = (
        nextViewport: SerialChartViewport = viewportRef.current,
        updateUi = true,
    ) => {
        const normalizedViewport: SerialChartViewport = {
            visiblePoints: normalizeVisiblePoints(nextViewport.visiblePoints),
            endSequence: nextViewport.endSequence,
        };
        const resolved = resolveSerialChartViewport(normalizedViewport, sequenceRef.current);
        viewportRef.current = {
            visiblePoints: normalizedViewport.visiblePoints,
            endSequence: resolved.followingLatest ? null : resolved.maximum,
        };

        const chart = chartRef.current;
        if (chart) {
            chart.options.scales.x.min = resolved.minimum;
            chart.options.scales.x.max = resolved.maximum;
            chart.update('none');
        }

        if (updateUi) {
            setVisiblePointCount(normalizedViewport.visiblePoints);
            setFollowingLatest(resolved.followingLatest);
        }
        return resolved;
    };

    const zoomChartViewport = (factor: number) => {
        const nextVisiblePoints = normalizeVisiblePoints(viewportRef.current.visiblePoints * factor);
        if (nextVisiblePoints === viewportRef.current.visiblePoints) return;
        applyChartViewport({
            visiblePoints: nextVisiblePoints,
            endSequence: viewportRef.current.endSequence,
        });
    };

    const followLatestChartData = () => {
        applyChartViewport({
            visiblePoints: viewportRef.current.visiblePoints,
            endSequence: null,
        });
    };

    const registerDroppedRecords = (count: number) => {
        if (!Number.isFinite(count) || count <= 0) return;
        droppedCountRef.current += Math.floor(count);
        setDroppedCount(droppedCountRef.current);
    };

    useEffect(() => {
        pausedRef.current = paused;
        if (paused) {
            pendingRef.current = [];
            lineStreamRef.current.resynchronizeAtNextDelimiter();
            resetSerialParserState(parserStateRef.current);
            fieldStabilityRef.current.resynchronize();
        }
    }, [paused]);

    useEffect(() => {
        const nextIdentity = `${port || ''}\u0000${baudRate || ''}`;
        if (streamIdentityRef.current === nextIdentity) return;
        streamIdentityRef.current = nextIdentity;
        pendingRef.current = [];
        lineStreamRef.current.resynchronizeAtNextDelimiter();
        resetSerialParserState(parserStateRef.current);
        fieldStabilityRef.current.resynchronize();
    }, [port, baudRate]);

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

    useEffect(() => {
        if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
        const root = document.documentElement;
        const syncTheme = () => setIsDarkMode(root.classList.contains('dark'));
        syncTheme();
        const observer = new MutationObserver(syncTheme);
        observer.observe(root, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (presentationLocale || typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
            return;
        }
        const root = document.documentElement;
        const syncLocale = () => setDocumentPresentationLocale(
            resolveSerialPresentationLocale(root.lang),
        );
        syncLocale();
        const observer = new MutationObserver(syncLocale);
        observer.observe(root, { attributes: true, attributeFilter: ['lang'] });
        return () => observer.disconnect();
    }, [presentationLocale]);

    useEffect(() => {
        let changed = false;
        for (const dataset of dataRef.current.datasets) {
            const descriptor = fieldDescriptorsRef.current[dataset.fieldId]
                || describeSerialField(dataset.fieldId);
            const nextLabel = getSerialFieldDisplayLabel(descriptor, activePresentationLocale);
            if (dataset.label !== nextLabel) {
                dataset.label = nextLabel;
                changed = true;
            }
        }
        for (const stats of channelStatsRef.current) {
            const descriptor = fieldDescriptorsRef.current[stats.fieldId]
                || describeSerialField(stats.fieldId);
            const nextLabel = getSerialFieldDisplayLabel(descriptor, activePresentationLocale);
            if (stats.label !== nextLabel) {
                stats.label = nextLabel;
                changed = true;
            }
        }
        if (!changed) return;
        setChartData({ datasets: [...dataRef.current.datasets] });
        setCards(channelStatsRef.current.map((stats) => ({ ...stats })));
        chartRef.current?.update('none');
    }, [activePresentationLocale]);

    const gridColor = isDarkMode ? '#263449' : '#e5edf4';
    const textColor = isDarkMode ? '#9fb0c4' : '#64748b';

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
                    title: (items) => items.length > 0 ? t('plot.sampleTooltip', { value: items[0].parsed.x }) : '',
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
    }), [fontSize, gridColor, t, textColor, yScaleMode]);

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
            const sample = text.length > QUALITY_SAMPLE_MAX ? text.slice(-QUALITY_SAMPLE_MAX) : text;
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

        const consumePayload = (payload: unknown) => {
            const framed = lineStreamRef.current.push(payload);
            updateInputQuality(framed.decodedText);
            if (framed.discardedOversizeLines > 0) {
                registerDroppedRecords(framed.discardedOversizeLines);
            }

            let lines = framed.lines;

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
                Object.assign(fieldDescriptorsRef.current, parsed.fields);
                pendingRef.current.push({
                    timestamp: receivedAt,
                    values: parsed.values,
                    fields: parsed.fields,
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
                    consumePayload(event.payload);
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
            lineStreamRef.current.reset();
        };
    }, []);

    useEffect(() => {
        const ensureDataset = (fieldId: SerialFieldId): number => {
            const existing = datasetIndexRef.current[fieldId];
            if (typeof existing === 'number') return existing;
            if (dataRef.current.datasets.length >= MAX_SERIAL_CHANNELS) return -1;

            const index = dataRef.current.datasets.length;
            const color = COLORS[index % COLORS.length];
            const descriptor = fieldDescriptorsRef.current[fieldId] || describeSerialField(fieldId);
            fieldDescriptorsRef.current[fieldId] = descriptor;
            const label = getSerialFieldDisplayLabel(descriptor, activePresentationLocaleRef.current);
            dataRef.current.datasets.push({
                fieldId,
                label,
                data: [],
                borderColor: color,
                backgroundColor: color,
                borderWidth: 1.5,
                pointRadius: 0,
                fill: false,
                spanGaps: true,
            });
            datasetIndexRef.current[fieldId] = index;
            channelStatsRef.current[index] = {
                fieldId,
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

        const appendDatasetPoint = (index: number, sequence: number, value: number) => {
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
        };

        const timer = setInterval(() => {
            if (pausedRef.current || pendingRef.current.length === 0) return;
            const batch = pendingRef.current.splice(0, MAX_PROCESS_PER_TICK);
            let datasetAdded = false;
            let triggerStateChanged = false;

            for (const record of batch) {
                const sequence = sequenceRef.current++;
                const storedRecord = { ...record, sequence };
                const stability = fieldStabilityRef.current.observe(record);
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

                // A named field is exposed only after several identical,
                // complete records. When it becomes stable, restore its
                // earlier points from the already ordered history so the UI
                // neither reorders nor loses the first samples.
                const newlyConfirmed = new Set(stability.newlyConfirmedFieldIds);
                for (const fieldId of stability.newlyConfirmedFieldIds) {
                    const previousDatasetCount = dataRef.current.datasets.length;
                    const index = ensureDataset(fieldId);
                    if (index < 0) continue;
                    if (dataRef.current.datasets.length !== previousDatasetCount) datasetAdded = true;
                    for (const point of collectStableFieldPoints(historyRef.current, fieldId)) {
                        appendDatasetPoint(index, point.x, point.y);
                    }
                }

                for (const [fieldId, value] of Object.entries(record.values)) {
                    if (!Number.isFinite(value)) continue;
                    if (!fieldStabilityRef.current.isConfirmed(fieldId) || newlyConfirmed.has(fieldId)) continue;
                    const previousDatasetCount = dataRef.current.datasets.length;
                    const index = ensureDataset(fieldId);
                    if (index < 0) continue;
                    if (dataRef.current.datasets.length !== previousDatasetCount) datasetAdded = true;
                    appendDatasetPoint(index, sequence, value);
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

            applyChartViewport(viewportRef.current, false);
        }, UPDATE_INTERVAL_MS);

        return () => clearInterval(timer);
    }, []);

    const confirmDiscardFrozenCapture = async (actionLabel: string): Promise<boolean> => {
        const capture = triggerRecorderRef.current!.getCapture();
        if (triggerSummary.state !== 'frozen' || triggerCaptureExported || !capture) return true;
        return dialog.confirm({
            title: t('trigger.discardTitle'),
            message: t('trigger.discardMessage', { count: capture.records.length, action: actionLabel }),
            tone: 'warning',
            confirmLabel: t('trigger.discardConfirm'),
            cancelLabel: t('trigger.returnExport'),
        });
    };

    const clearData = async () => {
        if (!await confirmDiscardFrozenCapture(t('trigger.actionClear'))) return;
        dataRef.current.datasets = [];
        datasetIndexRef.current = {};
        fieldDescriptorsRef.current = {};
        channelStatsRef.current = [];
        pendingRef.current = [];
        historyRef.current = [];
        sequenceRef.current = 0;
        lineStreamRef.current.resynchronizeAtNextDelimiter();
        resetSerialParserState(parserStateRef.current);
        fieldStabilityRef.current.reset();
        detectedFormatsRef.current.clear();
        qualityRef.current = { characters: 0, invalid: 0 };
        warningDismissedRef.current = false;
        triggerRecorderRef.current!.reset();
        triggerUiUpdatedAtRef.current = 0;
        droppedCountRef.current = 0;
        triggerDroppedBaselineRef.current = 0;
        triggerDroppedFrozenRef.current = 0;
        chartDragRef.current = null;
        viewportRef.current = {
            visiblePoints: DEFAULT_VISIBLE_POINTS,
            endSequence: null,
        };
        setQualityWarning(false);
        setChartData({ datasets: [] });
        setCards([]);
        setSampleCount(0);
        setDroppedCount(0);
        setDetectedFormats([]);
        setTriggerCaptureExported(false);
        setVisiblePointCount(DEFAULT_VISIBLE_POINTS);
        setFollowingLatest(true);
        setTriggerSummary(triggerRecorderRef.current!.getSummary());
        const chart = chartRef.current;
        if (chart) {
            chart.options.scales.x.min = 0;
            chart.options.scales.x.max = 1;
            chart.update('none');
        }
    };

    const showTemporaryExportStatus = (message: string) => {
        setExportStatus(message);
        if (exportStatusTimerRef.current) clearTimeout(exportStatusTimerRef.current);
        exportStatusTimerRef.current = setTimeout(() => setExportStatus(''), 3000);
    };

    const csvFileStem = (trigger = false): string => {
        if (csvHeaderMode === 'stable') return trigger ? 'CK-serial-trigger' : 'CK-serial-data';
        if (csvHeaderMode === 'localized') {
            return trigger ? `CK-${t('export.triggerFileName')}` : `CK-${t('export.fileName')}`;
        }
        return trigger ? 'CK-串口触发录制' : 'CK-串口数据';
    };

    const exportData = async () => {
        const records = historyRef.current;
        if (records.length === 0) return;

        const channels = dataRef.current.datasets.map((dataset) => ({
            fieldId: dataset.fieldId,
            label: dataset.label,
        }));
        const rows = buildSerialDataCsv({
            records,
            channels,
            mode: csvHeaderMode,
            localizedLabels: csvLabels,
        });

        try {
            const date = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
            const target = await save({
                defaultPath: `${csvFileStem()}-${date}.csv`,
                filters: [{ name: t('export.csvFile'), extensions: ['csv'] }],
            });
            if (!target) return;
            await writeTextFile(target, `\uFEFF${rows}`);
            showTemporaryExportStatus(t('export.completed', { count: records.length }));
        } catch (error) {
            console.error('Serial data export failed', error);
            showTemporaryExportStatus(t('export.failed'));
        }
    };

    const armTriggerRecording = async (config: SerialTriggerConfig) => {
        if (!await confirmDiscardFrozenCapture(t('trigger.rearm'))) return;
        setTriggerSummary(triggerRecorderRef.current!.arm(config));
        setTriggerCaptureExported(false);
        triggerUiUpdatedAtRef.current = Date.now();
        triggerDroppedBaselineRef.current = droppedCountRef.current;
        triggerDroppedFrozenRef.current = 0;
    };

    const cancelTriggerRecording = async () => {
        if (!await confirmDiscardFrozenCapture(t('trigger.end'))) return;
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
                defaultPath: `${csvFileStem(true)}-${date}.csv`,
                filters: [{ name: t('export.csvFile'), extensions: ['csv'] }],
            });
            if (!target) return;
            await writeTextFile(target, `\uFEFF${buildSerialTriggerCsv(capture, {
                port,
                baudRate,
                droppedRecords: triggerDroppedFrozenRef.current,
                channelLabels: Object.fromEntries(
                    channelStatsRef.current.map((stats) => [stats.fieldId, stats.label]),
                ),
                headerMode: csvHeaderMode,
                localizedLabels: csvLabels,
            })}`);
            setTriggerCaptureExported(true);
            showTemporaryExportStatus(t('export.triggerCompleted', { count: capture.records.length }));
        } catch (error) {
            console.error('Serial trigger recording export failed', error);
            showTemporaryExportStatus(t('export.triggerFailed'));
        }
    };

    const handleChartWheel = (event: React.WheelEvent<HTMLDivElement>) => {
        if (sequenceRef.current <= 1 || event.deltaY === 0) return;
        event.preventDefault();
        zoomChartViewport(event.deltaY > 0 ? 1.28 : 0.78);
    };

    const handleChartPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || sequenceRef.current <= 1) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (bounds.width <= 0) return;

        const resolved = resolveSerialChartViewport(viewportRef.current, sequenceRef.current);
        chartDragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startEndSequence: resolved.maximum,
            width: bounds.width,
            visiblePoints: viewportRef.current.visiblePoints,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
    };

    const handleChartPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        const drag = chartDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;

        const draggedPixels = event.clientX - drag.startX;
        const draggedPoints = Math.round((draggedPixels / drag.width) * drag.visiblePoints);
        const latest = Math.max(0, sequenceRef.current - 1);
        const requestedEnd = drag.startEndSequence - draggedPoints;
        applyChartViewport({
            visiblePoints: drag.visiblePoints,
            endSequence: requestedEnd >= latest ? null : requestedEnd,
        });
        event.preventDefault();
    };

    const finishChartPointerDrag = (event: React.PointerEvent<HTMLDivElement>) => {
        if (chartDragRef.current?.pointerId !== event.pointerId) return;
        chartDragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };

    return (
        <div
            ref={rootRef}
            className={`ck-serial-plotter ${className}`}
            data-ck-role="serial-plotter"
        >
            <header className="ck-serial-plotter-header">
                <div className="ck-serial-plotter-heading">
                    <span className="ck-serial-plotter-heading-icon" aria-hidden="true">
                        <Activity size={15} />
                    </span>
                    <div className="ck-serial-plotter-heading-copy">
                        <div className="ck-serial-plotter-title-row">
                            <strong>{t('plot.liveData')}</strong>
                            <span className="ck-serial-status-badge is-live">
                                <span />{t('plot.autoDetect')}
                            </span>
                            {paused && <span className="ck-serial-status-badge is-paused">{t('plot.paused')}</span>}
                        </div>
                        <div className="ck-serial-plotter-meta" title={t('plot.formatsHint')}>
                            <span>
                                {detectedFormats.length > 0
                                    ? detectedFormats.map((format) => t(formatLabelKey(format))).join(' · ')
                                    : t('plot.waitingFormats')}
                            </span>
                            {sampleCount > 0 && <span>{t('plot.sampleCount', { count: sampleCount.toLocaleString() })}</span>}
                            {droppedCount > 0 && (
                                <span className="is-warning" title={t('plot.droppedHint')}>
                                    {t('plot.droppedCount', { count: droppedCount.toLocaleString() })}
                                </span>
                            )}
                            {exportStatus && <span className="is-success">{exportStatus}</span>}
                        </div>
                    </div>
                </div>

                <div className="ck-serial-plotter-actions">
                    <div className="ck-serial-zoom-control" aria-label={t('plot.timeWindow')}>
                        <button
                            type="button"
                            onClick={() => zoomChartViewport(1.5)}
                            disabled={sampleCount <= 1 || visiblePointCount >= MAX_POINTS_PER_CHANNEL}
                            title={t('plot.zoomOutHint')}
                            aria-label={t('plot.moreHistory')}
                        >
                            <ZoomOut size={13} />
                        </button>
                        <span title={t('plot.visibleHint', { count: visiblePointCount })}>
                            {t('plot.pointCount', { count: visiblePointCount })}
                        </span>
                        <button
                            type="button"
                            onClick={() => zoomChartViewport(0.67)}
                            disabled={sampleCount <= 1 || visiblePointCount <= MIN_VISIBLE_POINTS}
                            title={t('plot.zoomInHint')}
                            aria-label={t('plot.shorterWindow')}
                        >
                            <ZoomIn size={13} />
                        </button>
                    </div>
                    {!followingLatest && (
                        <button
                            type="button"
                            onClick={followLatestChartData}
                            className="ck-serial-tool-button is-accent"
                            title={t('plot.followLatestHint')}
                        >
                            <RotateCcw size={13} />
                            <span>{t('plot.followLatest')}</span>
                        </button>
                    )}
                    <select
                        value={yScaleMode}
                        onChange={(event) => setYScaleMode(event.target.value as 'auto' | 'fixed_1023')}
                        className="ck-serial-axis-select"
                        title={t('plot.yRange')}
                    >
                        <option value="auto">{t('plot.yAuto')}</option>
                        <option value="fixed_1023">{t('plot.yFixed')}</option>
                    </select>
                    <button
                        type="button"
                        onClick={() => void exportData()}
                        disabled={sampleCount === 0}
                        className="ck-serial-tool-button"
                        title={t('plot.exportHint')}
                    >
                        <Download size={13} />
                        <span>{t('plot.export')}</span>
                    </button>
                    <button
                        type="button"
                        onClick={() => void clearData()}
                        disabled={sampleCount === 0 && !qualityWarning}
                        className="ck-serial-tool-button is-danger"
                        title={t('plot.clearHint')}
                    >
                        <Trash2 size={13} />
                        <span>{t('plot.clear')}</span>
                    </button>
                </div>
            </header>

            {qualityWarning && !warningDismissedRef.current && (
                <div
                    role="status"
                    className="ck-serial-quality-warning"
                >
                    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01M10.3 4.4L2.6 18a2 2 0 001.7 3h15.4a2 2 0 001.7-3L13.7 4.4a2 2 0 00-3.4 0z" />
                    </svg>
                    <span>{t('plot.qualityWarning')}</span>
                    <button
                        type="button"
                        onClick={() => {
                            warningDismissedRef.current = true;
                            setQualityWarning(false);
                        }}
                    >
                        {t('plot.dismiss')}
                    </button>
                </div>
            )}

            <div className="ck-serial-trigger-slot">
                <SerialTriggerRecorderPanel
                    channels={cards.map(({ fieldId, label, color }) => ({ fieldId, channelId: fieldId, label, color }))}
                    summary={triggerSummary}
                    captureExported={triggerCaptureExported}
                    serialPaused={paused}
                    onArm={(config) => void armTriggerRecording(config)}
                    onCancel={() => void cancelTriggerRecording()}
                    onFreeze={freezeTriggerRecording}
                    onExport={() => void exportTriggerRecording()}
                    />
                    <select
                        value={csvHeaderMode}
                        onChange={(event) => setCsvHeaderMode(event.target.value as SerialCsvHeaderMode)}
                        className="ck-serial-axis-select"
                        title={t('export.headerModeTitle')}
                        aria-label={t('export.headerModeTitle')}
                    >
                        <option value="legacy">{t('export.headerModes.legacy')}</option>
                        <option value="localized">{t('export.headerModes.localized')}</option>
                        <option value="stable">{t('export.headerModes.stable')}</option>
                    </select>
            </div>

            {cards.length > 0 && (
                <section className="ck-serial-channel-strip" aria-label={t('plot.latestValues')}>
                    {cards.map((stats) => (
                        <div
                            key={stats.fieldId}
                            className="ck-serial-channel-card"
                            style={{ borderTopColor: stats.color }}
                            title={t('plot.rangeTitle', { label: stats.label, min: formatValue(stats.min), max: formatValue(stats.max) })}
                        >
                            <div className="ck-serial-channel-name">
                                <span style={{ backgroundColor: stats.color }} />
                                <strong>{stats.label}</strong>
                            </div>
                            <div
                                className="ck-serial-channel-value"
                                style={{ fontSize: Math.max(13, Math.round(fontSize * 0.98)) }}
                            >
                                {formatValue(stats.current)}
                            </div>
                            <div className="ck-serial-channel-range">
                                <span>{t('plot.low', { value: formatValue(stats.min) })}</span>
                                <span>{t('plot.high', { value: formatValue(stats.max) })}</span>
                            </div>
                        </div>
                    ))}
                </section>
            )}

            <section
                ref={chartViewportRef}
                className="ck-serial-chart-surface"
                style={{ touchAction: 'none' }}
                onWheel={handleChartWheel}
                onPointerDown={handleChartPointerDown}
                onPointerMove={handleChartPointerMove}
                onPointerUp={finishChartPointerDrag}
                onPointerCancel={finishChartPointerDrag}
                onLostPointerCapture={() => { chartDragRef.current = null; }}
                title={cards.length > 0 ? t('plot.chartHint') : undefined}
            >
                {cards.length === 0 && (
                    <div className="ck-serial-chart-empty">
                        <span className="ck-serial-chart-empty-icon"><Activity size={17} /></span>
                        <strong>{t('plot.waitingData')}</strong>
                        <span>
                            {t('plot.example')}
                        </span>
                    </div>
                )}
                {cards.length > 0 && (
                    <>
                        <div className="ck-serial-chart-mode">
                            {followingLatest ? t('plot.following') : t('plot.history')}
                        </div>
                        <div className="ck-serial-chart-help">{t('plot.interactionHint')}</div>
                    </>
                )}
                <Line ref={chartRef} options={options} data={chartData} />
            </section>
        </div>
    );
};
