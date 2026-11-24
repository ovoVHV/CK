import { isBuildOperationSuccessful, type BuildOperationResultCode } from './build_operation_result';

/** The run that acquired the UI lock owns its timer and any upload serial lease.
 * A stale continuation may dispose its resources, but cannot unlock another run. */
export interface ForegroundOperation {
    isCurrentSession(): boolean;
    isCancelled(): boolean;
    beforeUpload?(): Promise<void>;
    execute(): Promise<BuildOperationResultCode>;
    onFailure(error: unknown, cancelled: boolean): void;
    stopTimer(): void;
    restoreSerial(): Promise<void>;
    unlock(result: BuildOperationResultCode): void;
    afterCompile?(): void;
}

export async function runForegroundBuild(run: ForegroundOperation): Promise<boolean> {
    let result: BuildOperationResultCode = 'pending';
    try {
        if (run.beforeUpload) await run.beforeUpload();
        if (!run.isCurrentSession()) return false;
        if (run.isCancelled()) {
            result = 'cancelled';
        } else {
            result = await run.execute();
        }
    } catch (error) {
        if (run.isCurrentSession()) {
            const cancelled = run.isCancelled();
            result = cancelled ? 'cancelled' : 'failed';
            run.onFailure(error, cancelled);
        }
    } finally {
        run.stopTimer();
        try {
            if (run.isCurrentSession()) await run.restoreSerial();
        } finally {
            if (run.isCurrentSession()) run.unlock(result);
        }
    }
    if (!run.isCurrentSession()) return false;
    // This checkpoint preserves the input for recovery, including failed or cancelled
    // compiles. It is separate from a successfully built or uploaded firmware.
    run.afterCompile?.();
    return isBuildOperationSuccessful(result);
}
