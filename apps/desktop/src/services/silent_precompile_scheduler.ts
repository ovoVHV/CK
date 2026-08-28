export interface SilentPrecompileRequest {
    key: string;
    fqbn: string;
    code: string;
}

export function createSilentPrecompileRequest(
    fqbn: string,
    extensionRevision: number,
    includeSignature: string,
    codeFingerprint: string,
    code: string,
): SilentPrecompileRequest {
    return {
        key: `${fqbn}::${extensionRevision}::${includeSignature || 'core-only'}::${codeFingerprint}`,
        fqbn,
        code,
    };
}

export interface SilentPrecompileSchedulerOptions {
    delayMs: number;
    retryDelayMs: number;
    isBlocked: () => boolean;
    run: (request: SilentPrecompileRequest) => Promise<void>;
    onError?: (error: unknown, request: SilentPrecompileRequest) => void;
    setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * Keeps at most one pending code-aware warmup and never drops it merely because
 * foreground compilation (or a previous enqueue call) is still active.
 * Scheduling a newer request replaces the pending request, so a burst of block
 * edits warms only the final generated sketch.
 */
export class SilentPrecompileScheduler {
    private readonly options: SilentPrecompileSchedulerOptions;
    private readonly setTimer: NonNullable<SilentPrecompileSchedulerOptions['setTimer']>;
    private readonly clearTimer: NonNullable<SilentPrecompileSchedulerOptions['clearTimer']>;
    private pending: SilentPrecompileRequest | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private inFlight = false;
    private disposed = false;

    constructor(options: SilentPrecompileSchedulerOptions) {
        this.options = options;
        this.setTimer = options.setTimer || ((callback, delayMs) => setTimeout(callback, delayMs));
        this.clearTimer = options.clearTimer || (timer => clearTimeout(timer));
    }

    schedule(request: SilentPrecompileRequest): void {
        if (this.disposed) return;
        this.pending = request;
        this.arm(this.options.delayMs);
    }

    cancelPending(): void {
        this.pending = null;
        this.clearArmedTimer();
    }

    /**
     * A successful foreground compile/upload already prepared the exact cache
     * represented by `key`. Drop only that redundant pending warmup. A newer
     * edit, board option change, or extension reload has a different key and
     * must remain queued.
     */
    cancelSatisfied(request: SilentPrecompileRequest): boolean {
        if (!this.pending
            || this.pending.key !== request.key
            || this.pending.fqbn !== request.fqbn
            || this.pending.code !== request.code) {
            return false;
        }
        this.cancelPending();
        return true;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.pending = null;
        this.clearArmedTimer();
    }

    private clearArmedTimer(): void {
        if (this.timer === null) return;
        this.clearTimer(this.timer);
        this.timer = null;
    }

    private arm(delayMs: number): void {
        this.clearArmedTimer();
        this.timer = this.setTimer(() => {
            this.timer = null;
            void this.flush();
        }, delayMs);
    }

    private async flush(): Promise<void> {
        if (this.disposed || !this.pending) return;
        if (this.options.isBlocked() || this.inFlight) {
            this.arm(this.options.retryDelayMs);
            return;
        }

        const request = this.pending;
        this.pending = null;
        this.inFlight = true;
        try {
            await this.options.run(request);
        } catch (error) {
            this.options.onError?.(error, request);
        } finally {
            this.inFlight = false;
            if (!this.disposed && this.pending) {
                this.arm(this.options.retryDelayMs);
            }
        }
    }
}
