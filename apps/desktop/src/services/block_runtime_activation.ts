import type {
    BlockRuntimeActivation,
    LibraryInfo,
} from '../types/library';
import { isCompleteDeclarativeRuntime } from './declarative_block_runtime';

export function blockRuntimeActivation(lib: Partial<LibraryInfo>): BlockRuntimeActivation {
    const raw = lib.runtime_activation;
    if (raw && typeof raw === 'object') {
        return {
            state: raw.state,
            executablePresent: Boolean(raw.executablePresent),
            packageId: String(raw.packageId || lib.id || '').trim(),
            contentSha256: raw.contentSha256 || null,
            approvedAt: raw.approvedAt || null,
            reason: String(raw.reason || '').trim(),
        };
    }
    const executablePresent = Boolean(lib.has_blocks || lib.has_toolbox || lib.has_generator);
    return {
        state: executablePresent ? 'quality-blocked' : 'not-applicable',
        executablePresent,
        packageId: String(lib.id || '').trim(),
        contentSha256: null,
        approvedAt: null,
        reason: executablePresent
            ? 'The backend did not provide an exact-hash runtime activation decision.'
            : 'This package has no executable Blockly JavaScript.',
    };
}

export function libraryCanExecuteBlockRuntime(lib: Partial<LibraryInfo>): boolean {
    const activation = blockRuntimeActivation(lib);
    if (!lib.has_blocks || !lib.has_toolbox || !lib.has_generator) return false;
    if (!isCompleteDeclarativeRuntime(lib.block_entrypoints)) return false;
    return activation.state === 'declarative-safe' && !activation.executablePresent;
}

export function libraryCanRequestRuntimeApproval(_lib: Partial<LibraryInfo>): boolean {
    // CK 1.0 has no isolated legacy-JavaScript worker. Exact-hash approval is
    // provenance, not a sandbox, so it must never make main-WebView JS runnable.
    return false;
}

export function runtimeActivationLabel(lib: Partial<LibraryInfo>): string {
    const activation = blockRuntimeActivation(lib);
    switch (activation.state) {
        case 'declarative-safe': return '声明式运行时';
        case 'approved': return '本机已信任';
        case 'ck-allowlisted': return 'CK 允许执行';
        case 'approval-required': return '代码未启用';
        case 'quality-blocked': return '代码已阻止';
        case 'legacy-disabled': return 'Legacy JavaScript 已禁用';
        default: return '无可执行积木代码';
    }
}

export function runtimeActivationTone(lib: Partial<LibraryInfo>): 'safe' | 'warning' | 'danger' | 'neutral' {
    const state = blockRuntimeActivation(lib).state;
    if (state === 'declarative-safe' || state === 'approved' || state === 'ck-allowlisted') return 'safe';
    if (state === 'approval-required') return 'warning';
    if (state === 'quality-blocked' || state === 'legacy-disabled') return 'danger';
    return 'neutral';
}

export function runtimeContentHashKey(lib: Partial<LibraryInfo>): string {
    const hash = String(blockRuntimeActivation(lib).contentSha256 || '').trim().toLowerCase();
    return /^[a-f0-9]{64}$/.test(hash) ? hash : 'no-certified-hash';
}
