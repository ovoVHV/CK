export type BuildOperationResultCode =
    | 'pending'
    | 'compile_succeeded'
    | 'upload_succeeded'
    | 'failed'
    | 'cancelled';

export const isBuildOperationSuccessful = (
    code: BuildOperationResultCode,
): boolean => code === 'compile_succeeded' || code === 'upload_succeeded';

export const completedBuildOperationResult = (
    operation: 'compile' | 'upload',
): BuildOperationResultCode => (
    operation === 'upload' ? 'upload_succeeded' : 'compile_succeeded'
);
