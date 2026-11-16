/** Coalesce Blockly event bursts without changing events, undo or block identity. */
export interface EditSchedulerClock {
    setTimeout(callback: () => void, delay: number): unknown;
    clearTimeout(handle: unknown): void;
    now(): number;
}

export function createBlocklyEditScheduler(
    update: () => void,
    options: {
        isInteracting?: () => boolean;
        delay?: number;
        maxWait?: number;
        clock?: EditSchedulerClock;
    } = {},
) {
    const clock: EditSchedulerClock = options.clock || {
        setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
        clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
        now: () => performance.now(),
    };
    let timer: unknown;
    let pending = false;
    let disposed = false;
    let firstAt = 0;
    const cancelTimer = () => {
        if (timer !== undefined) clock.clearTimeout(timer);
        timer = undefined;
    };
    const flush = () => {
        cancelTimer();
        if (!pending || disposed) return;
        pending = false;
        update();
    };
    const run = () => {
        timer = undefined;
        if (disposed || !pending) return;
        // Never run whole-project work in the middle of a block drag.
        if (options.isInteracting?.()) {
            timer = clock.setTimeout(run, 100);
            return;
        }
        flush();
    };
    return {
        schedule() {
            if (disposed) return;
            if (!pending) firstAt = clock.now();
            pending = true;
            cancelTimer();
            const remaining = Math.max(0, (options.maxWait ?? 1000) - (clock.now() - firstAt));
            timer = clock.setTimeout(run, Math.min(options.delay ?? 160, remaining));
        },
        flush,
        get pending() { return pending; },
        cancel() { cancelTimer(); pending = false; },
        dispose() { disposed = true; cancelTimer(); pending = false; },
    };
}
