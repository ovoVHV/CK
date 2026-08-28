import { sha256Hex } from './compile_source_map';
import { normalizeProjectIdentityPath } from './project_identity';
import {
    forgeReasonLabel,
    resolveForgeCoreSupport,
    type ForgeCoreSupportStatus,
} from './ck_forge_core_support';

export type CompileBuildMode =
    | 'exact-match'
    | 'fast-relink'
    | 'native-relink-compile-only'
    | 'native-relink-graph-transition'
    | 'arduino-cli-core-seeded'
    | 'full-build'
    | 'arduino-cli-incremental'
    | 'arduino-cli-incremental-fallback'
    | 'arduino-cli-full-fallback'
    | 'unknown';
export type CompileDoctorStatus = 'healthy' | 'attention' | 'problem';
export type ForgeRouteDecision = 'allow-fast' | 'force-platform' | 'block';
export type ToolchainIdentitySource = 'process-memory' | 'persistent-metadata' | 'strong-content';

export interface CompileDiagnosticsPayload {
    schemaVersion?: number;
    fqbn?: string;
    profile?: string;
    buildMode?: CompileBuildMode;
    engine?: {
        id?: string;
        schemaVersion?: number;
        productVersion?: string;
        contractId?: string;
        decision?: ForgeRouteDecision;
        source?: 'builtin-matrix' | 'local-qualification' | 'conservative-fallback';
        coreVersion?: string | null;
        reasonCodes?: string[];
    };
    timing?: {
        libraryResolutionMs?: number;
        identityResolutionMs?: number;
        precompileMs?: number;
        lockWaitMs?: number;
        cliCompileMs?: number;
        totalMs?: number;
        /** Actual Arduino CLI child + stream-drain wall (not CK wrapper time). */
        arduinoCliChildWallMs?: number | null;
        /** Runtime tool-path preflight duration, when a real compile was required. */
        runtimeToolPreflightMs?: number | null;
        /** Dependency/firmware evidence seal before and after NativeRelink capture. */
        dependencyArtifactSealMs?: number | null;
        /** NativeRelink baseline capture plus authenticated manifest commit. */
        nativeRelinkBaselineCaptureCommitMs?: number | null;
        /** BuildMeta write, Core identity commit and prebuilt-Core snapshot. */
        buildMetaSnapshotMs?: number | null;
        /** Existing aggregate post-build snapshot/seal timing. */
        postBuildSnapshotMs?: number | null;
    };
    cache?: {
        exactMatch?: boolean;
        coreCache?: boolean;
        ccacheEnabled?: boolean;
        forcedRebuild?: boolean;
        warmupReused?: boolean;
        nativeRelinkCertificateMatched?: boolean;
        fastRelinkFallback?: boolean;
        missReasons?: string[];
    };
    environment?: {
        cliVersion?: string;
        toolchainKey?: string;
        toolchainIdentitySource?: ToolchainIdentitySource;
        buildSignature?: string;
        workspaceFingerprint?: string | null;
        includeHeaders?: string[];
    };
    resources?: {
        flashUsedBytes?: number | null;
        ramUsedBytes?: number | null;
        warningCount?: number | null;
        evidenceComplete?: boolean;
    };
}

export interface CurrentCompileEnvironment {
    fqbn: string;
    coreId: string;
    coreVersion: string;
    codeFingerprint: string;
    includeHeaders: string[];
}

export interface CompileEnvironmentSnapshot extends CurrentCompileEnvironment {
    schemaVersion: 2;
    projectIdentitySha256: string;
    capturedAt: string;
    profile: string;
    buildSignature: string;
    cliVersion: string;
    toolchainKey: string;
}

export interface CompileDoctorReport {
    status: CompileDoctorStatus;
    success: boolean;
    summary: string;
    explanation: string;
    recommendation: string;
    buildMode: CompileBuildMode;
    profile: string;
    totalMs: number;
    cliCompileMs: number;
    lockWaitMs: number;
    libraryResolutionMs: number;
    identityResolutionMs: number;
    precompileMs: number;
    forgeDecision: ForgeRouteDecision | null;
    forgeEvidenceCurrent: boolean;
    forgeFastAuthorized: boolean;
    forgeReasonCodes: string[];
    forgeReasonDetails: string[];
    forgeCoreStatus: ForgeCoreSupportStatus;
    forgeCoreStatusLabel: string;
    forgeCoreStatusDetail: string;
    forgeCertifiedCoreVersions: string[];
    toolchainIdentitySource: ToolchainIdentitySource | null;
    exactMatch: boolean;
    coreCache: boolean;
    ccacheEnabled: boolean;
    forcedRebuild: boolean;
    warmupReused: boolean;
    missReasons: string[];
    environmentChanges: string[];
    diagnostics?: CompileDiagnosticsPayload;
    recordedAt: string;
}

interface DiagnoseCompileInput {
    success: boolean;
    log: string;
    durationMs: number;
    diagnostics?: CompileDiagnosticsPayload | null;
    currentEnvironment: CurrentCompileEnvironment;
    previousSnapshot?: CompileEnvironmentSnapshot | null;
}

const finiteNumber = (value: unknown, fallback = 0): number => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
};

// Keep the UI fail-closed when a backend build contract changes before its evidence display is updated.
const CURRENT_CK_FORGE_CONTRACT_ID = 'ck-fast-build-contract-v9:command-scoped-ccache-native-file-paths-O1-final-g0-no-lto-expanded-ccdb-core-deps-portable-response-guard';
const FAST_BUILD_MODES = new Set<CompileBuildMode>([
    'fast-relink',
    'native-relink-compile-only',
    'native-relink-graph-transition',
]);

const currentForgeEngineEvidence = (
    diagnostics: CompileDiagnosticsPayload | null | undefined,
    currentEnvironment: CurrentCompileEnvironment,
): boolean => {
    const engine = diagnostics?.engine;
    const environment = diagnostics?.environment;
    return diagnostics?.schemaVersion === 1
        && diagnostics.fqbn === currentEnvironment.fqbn
        && engine?.id === 'ck-forge'
        && engine.schemaVersion === 1
        && engine.productVersion === '1'
        && engine.contractId === CURRENT_CK_FORGE_CONTRACT_ID
        && engine.coreVersion === currentEnvironment.coreVersion
        && ['builtin-matrix', 'local-qualification', 'conservative-fallback'].includes(String(engine.source || ''))
        && Array.isArray(engine.reasonCodes)
        && engine.reasonCodes.length > 0
        && typeof environment?.cliVersion === 'string'
        && environment.cliVersion.trim().length > 0
        && typeof environment.toolchainKey === 'string'
        && environment.toolchainKey.trim().length > 0
        && typeof environment.buildSignature === 'string'
        && environment.buildSignature.trim().length > 0;
};

const secondsFromLog = (log: string, label: string): number | null => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = log.match(new RegExp(`${escaped}:\\s*([0-9.]+)s`, 'i'));
    return match ? finiteNumber(match[1]) * 1000 : null;
};

const millisecondsFromLog = (log: string, label: string): number | null => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = log.match(new RegExp(`${escaped}:\\s*([0-9.]+)ms`, 'i'));
    return match ? finiteNumber(match[1]) : null;
};

const buildModeFromLog = (log: string): CompileBuildMode => {
    if (/Cached build \(Exact Match\)/i.test(log)) return 'exact-match';
    if (/Fast Relink path:/i.test(log)) return 'fast-relink';
    const fastRelinkFallback = /Fast Relink (?:bypassed, falling back|fallback:)/i.test(log);
    const incremental = /Build cache directory detected|Arduino CLI incremental build:/i.test(log);
    if (/Full Build:/i.test(log) && fastRelinkFallback) return 'arduino-cli-full-fallback';
    if (/Full Build:/i.test(log)) return 'full-build';
    if (incremental && fastRelinkFallback) return 'arduino-cli-incremental-fallback';
    if (incremental) return 'arduino-cli-incremental';
    return 'unknown';
};

const missReasonsFromLog = (log: string): string[] => {
    const match = log.match(/Exact-match cache MISS:\s*([^\r\n]+)/i);
    if (!match) return [];
    return match[1].split(',').map(value => value.trim()).filter(Boolean);
};

const REASON_LABELS: Record<string, string> = {
    code_changed: '代码发生变化',
    include_headers_changed: '头文件集合发生变化',
    workspace_fingerprint_changed: '积木工作区发生变化',
    build_signature_changed: '核心、工具链或依赖发生变化',
    fqbn_changed: '板卡或编译选项发生变化',
    build_path_missing: '上次构建目录不存在',
    metadata_missing: '缺少缓存元数据',
    artifact_missing: '固件产物不存在',
};

export const compileMissReasonLabel = (reason: string): string => {
    const normalized = reason.trim().toLowerCase();
    return REASON_LABELS[normalized] || reason.split('_').join(' ');
};

export const compileBuildModeLabel = (mode: CompileBuildMode): string => {
    if (mode === 'exact-match') return '完整缓存命中';
    if (mode === 'fast-relink') return '重链接构建';
    if (mode === 'native-relink-compile-only') return 'NativeRelink 局部构建';
    if (mode === 'native-relink-graph-transition') return 'NativeRelink 依赖图重构';
    if (mode === 'arduino-cli-core-seeded') return 'Arduino CLI Core 复用构建';
    if (mode === 'full-build') return '完整构建';
    if (mode === 'arduino-cli-incremental') return 'Arduino CLI 增量构建';
    if (mode === 'arduino-cli-incremental-fallback') return 'Arduino CLI 增量回退';
    if (mode === 'arduino-cli-full-fallback') return 'Arduino CLI 完整回退';
    return '常规编译';
};

export const formatCompileDuration = (milliseconds: number): string => {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '—';
    if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
    return `${(milliseconds / 1000).toFixed(milliseconds >= 10000 ? 1 : 2)} s`;
};

export const compareCompileEnvironment = (
    previous: CompileEnvironmentSnapshot | null | undefined,
    current: CurrentCompileEnvironment,
): string[] => {
    if (!previous) return [];
    const changes: string[] = [];
    if (previous.fqbn !== current.fqbn) changes.push('板卡或编译选项已变化');
    if (previous.coreVersion && current.coreVersion && previous.coreVersion !== current.coreVersion) {
        changes.push(`核心版本由 ${previous.coreVersion} 变为 ${current.coreVersion}`);
    }
    if (previous.includeHeaders.join('|') !== current.includeHeaders.join('|')) {
        changes.push('使用的头文件集合已变化');
    }
    return changes;
};

export const diagnoseCompile = ({
    success,
    log,
    durationMs,
    diagnostics,
    currentEnvironment,
    previousSnapshot,
}: DiagnoseCompileInput): CompileDoctorReport => {
    const timing = diagnostics?.timing || {};
    const cache = diagnostics?.cache || {};
    const buildMode = diagnostics?.buildMode || buildModeFromLog(log);
    const totalMs = finiteNumber(timing.totalMs, durationMs);
    const cliCompileMs = finiteNumber(timing.cliCompileMs, secondsFromLog(log, 'CLI compile phase') ?? 0);
    const lockWaitMs = finiteNumber(timing.lockWaitMs, secondsFromLog(log, 'Compile lock wait') ?? 0);
    const libraryResolutionMs = finiteNumber(
        timing.libraryResolutionMs,
        secondsFromLog(log, 'Library resolution') ?? millisecondsFromLog(log, 'resolve_ck_library_candidates') ?? 0,
    );
    const identityResolutionMs = finiteNumber(timing.identityResolutionMs, 0);
    const precompileMs = finiteNumber(timing.precompileMs, libraryResolutionMs + identityResolutionMs);
    const reportedForgeDecision = diagnostics?.engine?.id === 'ck-forge'
        ? diagnostics.engine.decision || null
        : null;
    const forgeReasonCodes = Array.isArray(diagnostics?.engine?.reasonCodes)
        ? diagnostics.engine.reasonCodes.map(String)
        : [];
    const toolchainIdentitySource = diagnostics?.environment?.toolchainIdentitySource || null;
    const forgeEvidenceCurrent = currentForgeEngineEvidence(diagnostics, currentEnvironment);
    // NativeRelink is an independently authenticated Release capability. Its
    // backend decision remains `force-platform` by design because it does not
    // alter the Core's recipes. A matched target may still need one full
    // Release build to establish its baseline before a later edit can use a
    // NativeRelink build mode, so certificate state must not depend on the
    // current build mode.
    const nativeRelinkCertificateMatched = Boolean(cache.nativeRelinkCertificateMatched)
        || /CK Forge NativeRelinkCompileOnly certificate matched/i.test(log);
    const forgeFastAuthorized = forgeEvidenceCurrent
        && (
            (reportedForgeDecision === 'allow-fast'
                && ['builtin-matrix', 'local-qualification'].includes(String(diagnostics?.engine?.source || '')))
            || nativeRelinkCertificateMatched
        );
    const forgeDecision = reportedForgeDecision === 'allow-fast' && !forgeFastAuthorized
        ? null
        : reportedForgeDecision;
    const currentCoreVersion = String(
        diagnostics?.engine?.coreVersion || currentEnvironment.coreVersion || '',
    ).trim();
    const bundledCoreSupport = resolveForgeCoreSupport(
        diagnostics?.fqbn || currentEnvironment.fqbn,
        currentCoreVersion,
    );
    const forgeReasonDetails = forgeReasonCodes.map(reason => (
        forgeReasonLabel(reason, currentCoreVersion)
    ));
    const forgeCoreSupport = forgeFastAuthorized
        ? {
            ...bundledCoreSupport,
            status: 'certified-evidence-available' as const,
            label: `FLFE Core ${currentCoreVersion || '当前版本'} · 已认证`,
            detail: `当前 Core ${currentCoreVersion || '版本'}、完整 FQBN、工具链和构建合同的资格证据已经匹配。`,
        }
        : reportedForgeDecision === 'force-platform'
            && bundledCoreSupport.status === 'certified-evidence-available'
            ? {
                ...bundledCoreSupport,
                status: 'safe-fallback' as const,
                label: `FLFE Core ${currentCoreVersion || '当前版本'} · 安全回退`,
                detail: `当前 Core ${currentCoreVersion || '版本'} 有随包版本证据，但当前完整 FQBN、工具链或 A/B 资格尚未全部匹配，因此本次使用原生安全构建。`,
            }
            : bundledCoreSupport;
    const exactMatch = Boolean(cache.exactMatch ?? buildMode === 'exact-match');
    const coreCache = Boolean(cache.coreCache ?? /Core cache injected directly/i.test(log));
    const ccacheEnabled = Boolean(cache.ccacheEnabled ?? /ccache compile acceleration enabled/i.test(log));
    const forcedRebuild = Boolean(cache.forcedRebuild ?? /Forced rebuild/i.test(log));
    const warmupReused = Boolean(cache.warmupReused ?? /Reusing compatible same-board warmup/i.test(log));
    const missReasons = Array.isArray(cache.missReasons) && cache.missReasons.length > 0
        ? cache.missReasons.map(String)
        : missReasonsFromLog(log);
    const environmentChanges = compareCompileEnvironment(previousSnapshot, currentEnvironment);

    let status: CompileDoctorStatus = success ? 'healthy' : 'problem';
    let summary = success ? '编译链路正常' : '编译失败';
    let explanation = success
        ? `${compileBuildModeLabel(buildMode)}，实际编译 ${formatCompileDuration(cliCompileMs || totalMs)}。`
        : '编译器返回错误，请查看下方第一条红色日志。';
    let recommendation = success ? '当前无需处理。' : '先按错误位置修复代码或依赖，再重新编译。';

    if (success && lockWaitMs >= 5000) {
        status = 'problem';
        summary = '后台任务严重阻塞前台编译';
        explanation = `真正编译只用了 ${formatCompileDuration(cliCompileMs)}，但等待编译锁用了 ${formatCompileDuration(lockWaitMs)}。`;
        recommendation = '应取消或让路同板卡后台预热；无需清空代码缓存。';
    } else if (success && lockWaitMs >= 1000) {
        status = 'attention';
        summary = '编译锁等待偏长';
        explanation = `等待后台编译任务释放锁用了 ${formatCompileDuration(lockWaitMs)}。`;
        recommendation = '再次出现时使用“重建当前配置”前先确认没有后台预热。';
    } else if (success && FAST_BUILD_MODES.has(buildMode)) {
        if (forgeFastAuthorized) {
            summary = 'CK Forge · 热构建';
            explanation = `当前 CK Forge 引擎证据与完整目标身份匹配；本次复用了核心与依赖，只重新编译变化部分并链接，用时 ${formatCompileDuration(cliCompileMs || totalMs)}。`;
        } else {
            status = 'attention';
            summary = reportedForgeDecision === 'allow-fast'
                ? 'CK Forge · 快速资格证据不完整'
                : reportedForgeDecision === 'force-platform'
                    ? 'CK Forge · 构建路由证据不一致'
                    : 'CK Forge · 快速资格待验证';
            explanation = reportedForgeDecision === 'force-platform'
                ? '结构化 CK Forge 决策要求使用原生构建，但本次记录同时出现了重链接路径；为避免误报，本次不会标记为 Fast。'
                : '本次记录出现了重链接路径，但没有同时提供与当前 EXE、合同、Core、工具链和完整 FQBN 一致的 CK Forge 授权证据，因此不能说明快速编译已经生效。';
            recommendation = '保持原生 Arduino CLI 安全路径；完成当前完整身份的四阶段 A/B 并取得有效证书后，界面才会显示已认证热构建。';
        }
    } else if (success && forgeDecision === 'force-platform' && forgeFastAuthorized && nativeRelinkCertificateMatched) {
        if (buildMode === 'exact-match') {
            summary = 'CK Forge · 已认证产物复用';
            explanation = '当前目标的 NativeRelink 资格证书与完整身份匹配；本次代码和编译环境未变化，直接复用了已认证基线产物。';
            recommendation = '当前无需处理；修改代码后，符合门禁的编辑会进入 NativeRelink 快速路径。';
        } else if (buildMode === 'full-build') {
            summary = forcedRebuild
                ? 'CK Forge · 已认证 · 重建基线'
                : 'CK Forge · 已认证 · 首次建立基线';
            explanation = `当前目标已通过 NativeRelink 资格认证；本次先执行完整 Release 构建以建立安全基线，用时 ${formatCompileDuration(cliCompileMs || totalMs)}，后续符合门禁的编辑将进入快速路径。`;
            recommendation = '这是认证目标首次建立或主动重建基线的正常过程，不代表快速资格缺失。';
        } else {
            status = 'attention';
            summary = 'CK Forge · 已认证安全构建';
            explanation = `当前目标的 NativeRelink 资格证书与完整身份匹配；本次因构建输入需要平台原生路径，未冒充为热构建，用时 ${formatCompileDuration(cliCompileMs || totalMs)}。`;
            recommendation = '资格仍然有效；后续符合 NativeRelink 门禁的编辑会自动进入快速路径。';
        }
    } else if (success && forgeDecision === 'force-platform') {
        status = 'attention';
        summary = buildMode === 'exact-match'
            ? 'CK Forge · 原生产物复用'
            : 'CK Forge · 原生安全构建';
        explanation = buildMode === 'exact-match'
            ? `${forgeCoreSupport.detail} 本次复用了既有原生产物，但不会标记为 Fast。`
            : `${forgeCoreSupport.detail} 本次平台原生构建用时 ${formatCompileDuration(cliCompileMs || totalMs)}。`;
        recommendation = forgeCoreSupport.status === 'local-certification-required'
            ? `当前版本仍可正常使用，不要求降级。随安装包已有资格证据的 Core：${forgeCoreSupport.certifiedCoreVersions.join('、') || '暂无'}；当前完整身份通过本机 A/B 后会自动启用快速路径。`
            : '当前版本仍可正常使用；这是防止第三方或新版 Core 被优化得更慢的安全路径，当前完整身份通过性能资格后才会启用快速路径。';
    } else if (success && buildMode === 'full-build' && !forcedRebuild) {
        status = 'attention';
        summary = forgeDecision === 'allow-fast' ? 'CK Forge · 首次构建' : '本次执行了完整构建';
        explanation = '没有可安全复用的完整缓存，核心和依赖可能被重新编译。';
        recommendation = '首次构建属于正常情况；若连续发生，请查看下方缓存失效原因。';
    } else if (success && buildMode === 'exact-match') {
        summary = forgeDecision === 'allow-fast' ? 'CK Forge · 产物直达' : '完整缓存命中';
        explanation = '代码和编译环境均未变化，直接复用了上次固件产物。';
    } else if (success && buildMode === 'arduino-cli-incremental') {
        status = 'attention';
        summary = 'Arduino CLI 执行了增量构建';
        explanation = `缓存目录可用，但本次由 Arduino CLI 按当前输入重新确认依赖并构建，用时 ${formatCompileDuration(cliCompileMs || totalMs)}。`;
        recommendation = '这是依赖变化时的安全路径；若没有修改依赖却频繁出现，可检查下方缓存未命中原因。';
    } else if (success && (
        buildMode === 'arduino-cli-incremental-fallback'
        || buildMode === 'arduino-cli-full-fallback'
    )) {
        status = 'attention';
        summary = '快速路径已安全回退';
        explanation = `快速重链接未通过安全门禁，已改由 Arduino CLI ${buildMode === 'arduino-cli-full-fallback' ? '完整' : '增量'}构建，用时 ${formatCompileDuration(cliCompileMs || totalMs)}。`;
        recommendation = '产物以 Arduino CLI 当前依赖解析为准；若连续发生，可查看回退原因优化缓存。';
    }

    if (success && environmentChanges.length > 0 && status === 'healthy') {
        status = 'attention';
        recommendation = '环境变化会让旧缓存安全失效，这是正常保护，不建议强行复用。';
    }

    return {
        status,
        success,
        summary,
        explanation,
        recommendation,
        buildMode,
        profile: diagnostics?.profile || 'unknown',
        totalMs,
        cliCompileMs,
        lockWaitMs,
        libraryResolutionMs,
        identityResolutionMs,
        precompileMs,
        forgeDecision,
        forgeEvidenceCurrent,
        forgeFastAuthorized,
        forgeReasonCodes,
        forgeReasonDetails,
        forgeCoreStatus: forgeCoreSupport.status,
        forgeCoreStatusLabel: forgeCoreSupport.label,
        forgeCoreStatusDetail: forgeCoreSupport.detail,
        forgeCertifiedCoreVersions: forgeCoreSupport.certifiedCoreVersions,
        toolchainIdentitySource,
        exactMatch,
        coreCache,
        ccacheEnabled,
        forcedRebuild,
        warmupReused,
        missReasons,
        environmentChanges,
        diagnostics: diagnostics || undefined,
        recordedAt: new Date().toISOString(),
    };
};

const snapshotStorageKey = (projectPath: string): string => {
    const normalized = normalizeProjectIdentityPath(projectPath);
    return `ck.compile.environment.v2.${sha256Hex(normalized)}`;
};

const projectIdentitySha256 = (projectPath: string): string => (
    sha256Hex(normalizeProjectIdentityPath(projectPath))
);

export const loadCompileEnvironmentSnapshot = (projectPath: string): CompileEnvironmentSnapshot | null => {
    if (typeof window === 'undefined' || !projectPath) return null;
    try {
        const raw = window.localStorage.getItem(snapshotStorageKey(projectPath));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as CompileEnvironmentSnapshot;
        return parsed?.schemaVersion === 2
            && parsed.projectIdentitySha256 === projectIdentitySha256(projectPath)
            && typeof parsed.fqbn === 'string'
            ? parsed
            : null;
    } catch {
        return null;
    }
};

export const saveCompileEnvironmentSnapshot = (
    projectPath: string,
    current: CurrentCompileEnvironment,
    diagnostics?: CompileDiagnosticsPayload | null,
): CompileEnvironmentSnapshot | null => {
    if (typeof window === 'undefined' || !projectPath) return null;
    const snapshot: CompileEnvironmentSnapshot = {
        schemaVersion: 2,
        projectIdentitySha256: projectIdentitySha256(projectPath),
        capturedAt: new Date().toISOString(),
        ...current,
        profile: diagnostics?.profile || 'unknown',
        buildSignature: String(diagnostics?.environment?.buildSignature || ''),
        cliVersion: String(diagnostics?.environment?.cliVersion || ''),
        toolchainKey: String(diagnostics?.environment?.toolchainKey || ''),
    };
    try {
        window.localStorage.setItem(snapshotStorageKey(projectPath), JSON.stringify(snapshot));
        return snapshot;
    } catch {
        return null;
    }
};
