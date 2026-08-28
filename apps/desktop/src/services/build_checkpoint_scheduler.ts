export type BuildCheckpointMode = 'compile' | 'upload';

export interface ScheduleBuildCheckpointOptions {
    mode: BuildCheckpointMode;
    persist: () => Promise<unknown>;
    onFailure: (error: unknown) => void;
    /** Test hook; production compile checkpoints yield one task before writing. */
    deferCompile?: (task: () => void) => void;
}

/**
 * Compilation does not consume the checkpoint, so its disk write must not sit
 * on the compiler's critical path. Upload keeps the stronger ordering: its
 * checkpoint is fully persisted before the backend can compile and flash.
 *
 * The returned promise always settles successfully after reporting a write
 * failure. This prevents an opportunistic compile checkpoint from becoming an
 * unhandled rejection while preserving a visible warning for the active run.
 */
export const scheduleBuildCheckpoint = (
    options: ScheduleBuildCheckpointOptions,
): Promise<void> => {
    const persistAndReport = async (): Promise<void> => {
        try {
            await options.persist();
        } catch (error) {
            try {
                options.onFailure(error);
            } catch (reportError) {
                console.error('[ProjectCheckpoints] Failed to report checkpoint error', reportError);
            }
        }
    };

    if (options.mode === 'upload') return persistAndReport();

    const defer = options.deferCompile ?? (task => window.setTimeout(task, 0));
    return new Promise(resolve => {
        defer(() => {
            void persistAndReport().finally(resolve);
        });
    });
};
