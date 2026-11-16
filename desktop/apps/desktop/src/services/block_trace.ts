export const BLOCK_TRACE_DEFAULT_MAX_BLOCKS = 128;
export const BLOCK_TRACE_HARD_MAX_BLOCKS = 256;
export const BLOCK_TRACE_DEFAULT_MAX_EVENTS_PER_SECOND = 60;
export const BLOCK_TRACE_DEFAULT_RECENT_LIMIT = 32;
export const BLOCK_TRACE_DEFAULT_UI_INTERVAL_MS = 200;

export interface BlockTraceTrackedBlock {
    blockId: string;
    label: string;
}

export interface BlockTraceAggregatorOptions {
    maxTrackedBlocks?: number;
    maxEventsPerSecond?: number;
    recentLimit?: number;
    uiPublishIntervalMs?: number;
    omittedTrackedBlockCount?: number;
}

export interface BlockTraceSample {
    blockId: string;
    deviceMicros: number;
    firstHit: boolean;
    receivedAtMs?: number;
}

export interface BlockTraceBlockStat {
    blockId: string;
    label: string;
    covered: boolean;
    sampledHits: number;
    firstSeenAtMs: number | null;
    lastSeenAtMs: number | null;
    lastDeviceMicros: number | null;
    previousBlockId: string | null;
    lastTransitionUs: number | null;
    firstHitFrameSeen: boolean;
}

export interface BlockTraceTransition {
    sequenceNumber: number;
    blockId: string;
    blockLabel: string;
    previousBlockId: string | null;
    previousBlockLabel: string | null;
    deviceMicros: number;
    transitionUs: number | null;
    receivedAtMs: number;
    firstHit: boolean;
}

export interface BlockTraceSnapshot {
    trackedBlockCount: number;
    omittedTrackedBlockCount: number;
    coveredBlockCount: number;
    coveragePercent: number;
    totalSampledHits: number;
    droppedRateLimitedEvents: number;
    droppedUnknownBlockEvents: number;
    maxEventsPerSecond: number;
    stats: BlockTraceBlockStat[];
    recent: BlockTraceTransition[];
    capturedAtMs: number;
    runNumber: number;
}

const clampInteger = (
    rawValue: unknown,
    fallback: number,
    minimum: number,
    maximum: number,
): number => {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.round(value)));
};

const normalizeOptions = (options: BlockTraceAggregatorOptions) => ({
    maxTrackedBlocks: clampInteger(
        options.maxTrackedBlocks,
        BLOCK_TRACE_DEFAULT_MAX_BLOCKS,
        1,
        BLOCK_TRACE_HARD_MAX_BLOCKS,
    ),
    maxEventsPerSecond: clampInteger(
        options.maxEventsPerSecond,
        BLOCK_TRACE_DEFAULT_MAX_EVENTS_PER_SECOND,
        1,
        200,
    ),
    recentLimit: clampInteger(
        options.recentLimit,
        BLOCK_TRACE_DEFAULT_RECENT_LIMIT,
        1,
        128,
    ),
    uiPublishIntervalMs: clampInteger(
        options.uiPublishIntervalMs,
        BLOCK_TRACE_DEFAULT_UI_INTERVAL_MS,
        50,
        2000,
    ),
});

const validDeviceMicros = (value: number): boolean => (
    Number.isSafeInteger(value) && value >= 0 && value <= 0xFFFFFFFF
);

const elapsedMicros = (current: number, previous: number): number => (
    current >= previous
        ? current - previous
        : (0x100000000 - previous) + current
);

const safeIncrement = (value: number): number => (
    value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1
);

/**
 * Returns the newest bounded window without sorting or reversing it.
 * `recent` is append-only receive order, so rendering this array from index 0
 * to the end is always oldest -> newest (top -> bottom in the trace panel).
 */
export const selectChronologicalTraceWindow = (
    snapshot: BlockTraceSnapshot | null,
    rawLimit = 8,
): BlockTraceTransition[] => {
    if (!snapshot) return [];
    const limit = clampInteger(rawLimit, 8, 1, 128);
    return snapshot.recent.slice(-limit);
};

/**
 * Fixed-memory desktop aggregation for sampled TRACE frames.
 *
 * No unbounded event list is kept: block records are capped at construction
 * and the recent path is a small ring. A second rate gate protects React and
 * memory even if malformed or future firmware ignores the on-device limit.
 */
export class BlockTraceAggregator {
    private readonly options: ReturnType<typeof normalizeOptions>;
    private readonly stats = new Map<string, BlockTraceBlockStat>();
    private readonly recent: BlockTraceTransition[] = [];
    private readonly omittedTrackedBlockCount: number;
    private totalSampledHits = 0;
    private droppedRateLimitedEvents = 0;
    private droppedUnknownBlockEvents = 0;
    private rateWindowStartedAtMs = 0;
    private acceptedInRateWindow = 0;
    private lastEventBlockId: string | null = null;
    private lastEventDeviceMicros: number | null = null;
    private lastUiPublishedAtMs = Number.NEGATIVE_INFINITY;
    private runNumber = 1;

    constructor(
        trackedBlocks: readonly BlockTraceTrackedBlock[],
        options: BlockTraceAggregatorOptions = {},
    ) {
        this.options = normalizeOptions(options);
        const unique = new Map<string, BlockTraceTrackedBlock>();
        for (const candidate of trackedBlocks) {
            const blockId = String(candidate?.blockId || '').trim();
            if (!blockId || unique.has(blockId)) continue;
            unique.set(blockId, {
                blockId,
                label: String(candidate?.label || blockId).trim() || blockId,
            });
        }

        const accepted = Array.from(unique.values()).slice(0, this.options.maxTrackedBlocks);
        this.omittedTrackedBlockCount = Math.max(0, unique.size - accepted.length)
            + clampInteger(options.omittedTrackedBlockCount, 0, 0, 1_000_000);
        for (const tracked of accepted) {
            this.stats.set(tracked.blockId, {
                blockId: tracked.blockId,
                label: tracked.label,
                covered: false,
                sampledHits: 0,
                firstSeenAtMs: null,
                lastSeenAtMs: null,
                lastDeviceMicros: null,
                previousBlockId: null,
                lastTransitionUs: null,
                firstHitFrameSeen: false,
            });
        }
    }

    ingest(sample: BlockTraceSample): boolean {
        const blockId = String(sample?.blockId || '').trim();
        const stat = this.stats.get(blockId);
        if (!stat || !validDeviceMicros(sample.deviceMicros)) {
            this.droppedUnknownBlockEvents = safeIncrement(this.droppedUnknownBlockEvents);
            return false;
        }

        const receivedAtMs = Number.isFinite(sample.receivedAtMs)
            ? Math.max(0, Number(sample.receivedAtMs))
            : Date.now();
        if (
            receivedAtMs < this.rateWindowStartedAtMs
            || receivedAtMs - this.rateWindowStartedAtMs >= 1000
        ) {
            this.rateWindowStartedAtMs = receivedAtMs;
            this.acceptedInRateWindow = 0;
        }
        // A genuine first-hit frame is bounded by the tracked-block count and
        // carries coverage/order evidence that must not disappear behind the
        // desktop steady-state rate gate. Repeated or forged F frames no longer
        // bypass the gate after the block's first accepted F frame.
        const isNewFirstHit = Boolean(sample.firstHit) && !stat.firstHitFrameSeen;
        if (
            this.acceptedInRateWindow >= this.options.maxEventsPerSecond
            && !isNewFirstHit
        ) {
            this.droppedRateLimitedEvents = safeIncrement(this.droppedRateLimitedEvents);
            return false;
        }
        this.acceptedInRateWindow++;

        const previousBlockId = this.lastEventBlockId;
        const previousStat = previousBlockId ? this.stats.get(previousBlockId) || null : null;
        const transitionUs = this.lastEventDeviceMicros == null
            ? null
            : elapsedMicros(sample.deviceMicros, this.lastEventDeviceMicros);

        stat.covered = true;
        stat.sampledHits = safeIncrement(stat.sampledHits);
        stat.firstSeenAtMs = stat.firstSeenAtMs ?? receivedAtMs;
        stat.lastSeenAtMs = receivedAtMs;
        stat.lastDeviceMicros = sample.deviceMicros;
        stat.previousBlockId = previousBlockId;
        stat.lastTransitionUs = transitionUs;
        stat.firstHitFrameSeen = stat.firstHitFrameSeen || Boolean(sample.firstHit);
        this.totalSampledHits = safeIncrement(this.totalSampledHits);

        this.recent.push({
            sequenceNumber: this.totalSampledHits,
            blockId,
            blockLabel: stat.label,
            previousBlockId,
            previousBlockLabel: previousStat?.label || null,
            deviceMicros: sample.deviceMicros,
            transitionUs,
            receivedAtMs,
            firstHit: Boolean(sample.firstHit),
        });
        if (this.recent.length > this.options.recentLimit) {
            this.recent.splice(0, this.recent.length - this.options.recentLimit);
        }

        this.lastEventBlockId = blockId;
        this.lastEventDeviceMicros = sample.deviceMicros;
        return true;
    }

    resetTiming(): void {
        this.lastEventBlockId = null;
        this.lastEventDeviceMicros = null;
        // A reconnect starts a new timing segment. It must not inherit a full
        // desktop rate window from the disconnected transport, otherwise the
        // first received frame of the new segment can be discarded.
        this.rateWindowStartedAtMs = 0;
        this.acceptedInRateWindow = 0;
    }

    resetRun(): void {
        this.resetTiming();
        this.runNumber++;
        this.recent.length = 0;
        this.totalSampledHits = 0;
        this.droppedRateLimitedEvents = 0;
        this.droppedUnknownBlockEvents = 0;
        this.lastUiPublishedAtMs = Number.NEGATIVE_INFINITY;
        for (const stat of this.stats.values()) Object.assign(stat, {
            covered: false, sampledHits: 0, firstSeenAtMs: null, lastSeenAtMs: null,
            lastDeviceMicros: null, previousBlockId: null, lastTransitionUs: null, firstHitFrameSeen: false,
        });
    }

    shouldPublish(nowMs = Date.now(), force = false): boolean {
        if (!force && nowMs - this.lastUiPublishedAtMs < this.options.uiPublishIntervalMs) {
            return false;
        }
        this.lastUiPublishedAtMs = nowMs;
        return true;
    }

    snapshot(capturedAtMs = Date.now()): BlockTraceSnapshot {
        const stats = Array.from(this.stats.values()).map(stat => ({ ...stat }));
        const coveredBlockCount = stats.reduce(
            (count, stat) => count + (stat.covered ? 1 : 0),
            0,
        );
        return {
            trackedBlockCount: stats.length,
            omittedTrackedBlockCount: this.omittedTrackedBlockCount,
            coveredBlockCount,
            coveragePercent: stats.length > 0 ? (coveredBlockCount / stats.length) * 100 : 0,
            totalSampledHits: this.totalSampledHits,
            droppedRateLimitedEvents: this.droppedRateLimitedEvents,
            droppedUnknownBlockEvents: this.droppedUnknownBlockEvents,
            maxEventsPerSecond: this.options.maxEventsPerSecond,
            stats,
            recent: this.recent.map(item => ({ ...item })),
            capturedAtMs,
            runNumber: this.runNumber,
        };
    }
}
