import { invoke } from '@tauri-apps/api/core';

export interface CompileTargetPreproof {
    fqbn: string;
    coreVersion: string;
    toolchainKey: string;
    source: 'process-memory' | 'persistent-metadata' | 'strong-content';
    elapsedMs: number;
    cacheHit: boolean;
}

const boundedText = (value: unknown, maxLength: number): string => {
    const text = typeof value === 'string' ? value.trim() : '';
    return text && text.length <= maxLength ? text : '';
};

/**
 * Accept only the bounded response emitted by the local read-only preproof
 * command. The result is diagnostic evidence, never an authorization to skip
 * the identity checks performed by a real compile or upload.
 */
export const parseCompileTargetPreproof = (raw: unknown): CompileTargetPreproof => {
    const value = raw as Record<string, unknown> | null;
    const fqbn = boundedText(value?.fqbn, 2048);
    const coreVersion = boundedText(value?.coreVersion, 128);
    const toolchainKey = boundedText(value?.toolchainKey, 8192);
    const source = boundedText(value?.source, 64);
    const elapsedMs = Number(value?.elapsedMs);
    if (
        !fqbn
        || fqbn.split(':').length < 3
        || !coreVersion
        || !toolchainKey
        || !['process-memory', 'persistent-metadata', 'strong-content'].includes(source)
        || !Number.isSafeInteger(elapsedMs)
        || elapsedMs < 0
    ) {
        throw new Error('Invalid compile-target preproof response');
    }
    return {
        fqbn,
        coreVersion,
        toolchainKey,
        source: source as CompileTargetPreproof['source'],
        elapsedMs,
        cacheHit: value?.cacheHit === true,
    };
};

export const preproofCompileTarget = async (
    fqbn: string,
    boardPackageId?: string | null,
): Promise<CompileTargetPreproof> => {
    const raw = await invoke<unknown>('preproof_compile_target', {
        fqbn,
        boardPackageId: boardPackageId || null,
    });
    return parseCompileTargetPreproof(raw);
};
