export interface SuccessfulUploadResult {
    log: string;
    compileLog: string;
    fqbn: string;
    baselineFailure: string | null;
}

/** Upload completion and its measurements travel together, independent of UI log delivery. */
export const parseSuccessfulUploadResult = (
    raw: string,
    expected: { runId: string; fqbn: string },
): SuccessfulUploadResult => {
    // Older hosts and instrumented transports return a log string.
    if (!raw.trimStart().startsWith('{')) {
        return { log: raw, compileLog: '', fqbn: expected.fqbn, baselineFailure: null };
    }
    const result = JSON.parse(raw);
    if (result?.kind !== 'ck-upload-result' || result.schemaVersion !== 1
        || result.success !== true || result.runId !== expected.runId
        || result.fqbn !== expected.fqbn || typeof result.log !== 'string'
        || typeof result.compileLog !== 'string'
        || !(result.baselineFailure === null || typeof result.baselineFailure === 'string')) {
        throw new Error('上传完成记录与当前构建身份不一致，不能更新工程报告。');
    }
    return result;
};
