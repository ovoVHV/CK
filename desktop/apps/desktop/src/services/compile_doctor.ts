import { sha256Hex } from './compile_source_map';
import { normalizeProjectIdentityPath } from './project_identity';
const isEnUi = (): boolean => {
    try {
        const lang = typeof document !== 'undefined' ? document.documentElement?.lang : '';
        const stored = typeof window !== 'undefined' ? window.localStorage?.getItem('ck.i18n.uiLocale') : '';
        return /^en(?:-|$)/i.test(String(lang || stored || ''));
    } catch { return false; }
};
const uiText = (zh: string, en: string): string => (isEnUi() ? en : zh);
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
    /** Captured target also exists for successful upload IPCs without diagnostics JSON. */
    targetFqbn?: string;
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

const REASON_LABELS: Record<string, [string, string]> = {
    code_changed: ['代码发生变化', 'Source code changed'],
    include_headers_changed: ['头文件集合发生变化', 'Included headers changed'],
    workspace_fingerprint_changed: ['积木工作区发生变化', 'Block workspace changed'],
    build_signature_changed: ['核心、工具链或依赖发生变化', 'Core, toolchain, or dependencies changed'],
    fqbn_changed: ['板卡或编译选项发生变化', 'Board or build options changed'],
    build_path_missing: ['上次构建目录不存在', 'Previous build directory is missing'],
    metadata_missing: ['缺少缓存元数据', 'Cache metadata is missing'],
    artifact_missing: ['固件产物不存在', 'Firmware artifact is missing'],
};

export const compileMissReasonLabel = (reason: string): string => {
    const normalized = reason.trim().toLowerCase();
    const pair = REASON_LABELS[normalized];
    return pair ? uiText(pair[0], pair[1]) : reason.split('_').join(' ');
};

export const compileBuildModeLabel = (mode: CompileBuildMode): string => {
    if (mode === 'exact-match') return uiText('完整缓存命中', 'Exact cache hit');
    if (mode === 'fast-relink') return uiText('重链接构建', 'Fast relink build');
    if (mode === 'native-relink-compile-only') return uiText('NativeRelink 局部构建', 'NativeRelink partial build');
    if (mode === 'native-relink-graph-transition') return uiText('NativeRelink 依赖图重构', 'NativeRelink graph rebuild');
    if (mode === 'arduino-cli-core-seeded') return uiText('Arduino CLI Core 复用构建', 'Arduino CLI core-seeded build');
    if (mode === 'full-build') return uiText('完整构建', 'Full build');
    if (mode === 'arduino-cli-incremental') return uiText('Arduino CLI 增量构建', 'Arduino CLI incremental build');
    if (mode === 'arduino-cli-incremental-fallback') return uiText('Arduino CLI 增量回退', 'Arduino CLI incremental fallback');
    if (mode === 'arduino-cli-full-fallback') return uiText('Arduino CLI 完整回退', 'Arduino CLI full fallback');
    return uiText('常规编译', 'Standard build');
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
    if (previous.fqbn !== current.fqbn) changes.push(uiText('板卡或编译选项已变化', 'Board or build options changed'));
    if (previous.coreVersion && current.coreVersion && previous.coreVersion !== current.coreVersion) {
        changes.push(uiText(`核心版本由 ${previous.coreVersion} 变为 ${current.coreVersion}`, `Core version changed from ${previous.coreVersion} to ${current.coreVersion}`));
    }
    if (previous.includeHeaders.join('|') !== current.includeHeaders.join('|')) {
        changes.push(uiText('使用的头文件集合已变化', 'Included header set changed'));
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
    const esp32LibraryBaselineCommitted = /ESP32 library NativeRelink baseline committed;.*authorization=certified/i.test(log);
    const esp32LibraryBaselineSkipped = /ESP32 library NativeRelink baseline commit skipped/i.test(log);
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
            label: uiText(
                `FLFE Core ${currentCoreVersion || '当前版本'} · 已认证`,
                `FLFE Core ${currentCoreVersion || 'current'} · Certified`,
            ),
            detail: uiText(
                `当前 Core ${currentCoreVersion || '版本'}、完整 FQBN、工具链和构建合同的资格证据已经匹配。`,
                `Qualification evidence matches Core ${currentCoreVersion || 'current'}, full FQBN, toolchain, and build contract.`,
            ),
        }
        : reportedForgeDecision === 'force-platform'
            && bundledCoreSupport.status === 'certified-evidence-available'
            ? {
                ...bundledCoreSupport,
                status: 'safe-fallback' as const,
                label: uiText(
                    `FLFE Core ${currentCoreVersion || '当前版本'} · 安全回退`,
                    `FLFE Core ${currentCoreVersion || 'current'} · Safe fallback`,
                ),
                detail: uiText(
                    `当前 Core ${currentCoreVersion || '版本'} 有随包版本证据，但当前完整 FQBN、工具链或 A/B 资格尚未全部匹配，因此本次使用原生安全构建。`,
                    `Core ${currentCoreVersion || 'current'} has bundled version evidence, but full FQBN, toolchain, or A/B qualification did not fully match, so the native safe build route was used.`,
                ),
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
    let summary = success ? uiText('编译链路正常', 'Build pipeline healthy') : uiText('编译失败', 'Compilation failed');
    let explanation = success
        ? uiText(
            `${compileBuildModeLabel(buildMode)}，实际编译 ${formatCompileDuration(cliCompileMs || totalMs)}。`,
            `${compileBuildModeLabel(buildMode)}, compile time ${formatCompileDuration(cliCompileMs || totalMs)}.`,
        )
        : uiText(
            '编译器返回错误，请查看下方第一条红色日志。',
            'The compiler returned an error. Inspect the first red error entry below.',
        );
    let recommendation = success
        ? uiText('当前无需处理。', 'No action needed.')
        : uiText('先按错误位置修复代码或依赖，再重新编译。', 'Fix the reported code or dependency error and compile again.');

    if (success && lockWaitMs >= 5000) {
        status = 'problem';
        summary = uiText('后台任务严重阻塞前台编译', 'Background task heavily delayed foreground build');
        explanation = uiText(
            `真正编译只用了 ${formatCompileDuration(cliCompileMs)}，但等待编译锁用了 ${formatCompileDuration(lockWaitMs)}。`,
            `Actual compilation took ${formatCompileDuration(cliCompileMs)}, while waiting for the compile lock took ${formatCompileDuration(lockWaitMs)}.`,
        );
        recommendation = uiText(
            '应取消或让路同板卡后台预热；无需清空代码缓存。',
            'Cancel or yield same-board background warmup; clearing the code cache is unnecessary.',
        );
    } else if (success && lockWaitMs >= 1000) {
        status = 'attention';
        summary = uiText('编译锁等待偏长', 'Long compile lock wait');
        explanation = uiText(
            `等待后台编译任务释放锁用了 ${formatCompileDuration(lockWaitMs)}。`,
            `Waited ${formatCompileDuration(lockWaitMs)} for a background compile task to release the lock.`,
        );
        recommendation = uiText(
            '再次出现时使用“重建当前配置”前先确认没有后台预热。',
            'Check that no background warmup is running before triggering a rebuild.',
        );
    } else if (success && FAST_BUILD_MODES.has(buildMode)) {
        if (forgeFastAuthorized) {
            summary = uiText('CK Forge · 热构建', 'CK Forge · Hot build');
            explanation = uiText(
                `当前 CK Forge 引擎证据与完整目标身份匹配；本次复用了核心与依赖，只重新编译变化部分并链接，用时 ${formatCompileDuration(cliCompileMs || totalMs)}。`,
                `CK Forge engine evidence matched the full target identity; core and dependencies were reused and only changed units were recompiled and linked in ${formatCompileDuration(cliCompileMs || totalMs)}.`,
            );
        } else {
            status = 'attention';
            summary = reportedForgeDecision === 'allow-fast'
                ? uiText('CK Forge · 快速资格证据不完整', 'CK Forge · Incomplete fast-route evidence')
                : reportedForgeDecision === 'force-platform'
                    ? uiText('CK Forge · 构建路由证据不一致', 'CK Forge · Inconsistent build route evidence')
                    : uiText('CK Forge · 快速资格待验证', 'CK Forge · Fast route unverified');
            explanation = reportedForgeDecision === 'force-platform'
                ? uiText(
                    '结构化 CK Forge 决策要求使用原生构建，但本次记录同时出现了重链接路径；为避免误报，本次不会标记为 Fast。',
                    'Structured CK Forge routing requested a native build, while a relink marker also appeared; to prevent false claims, this build is not marked as Fast.',
                )
                : uiText(
                    '本次记录出现了重链接路径，但没有同时提供与当前 EXE、合同、Core、工具链和完整 FQBN 一致的 CK Forge 授权证据，因此不能说明快速编译已经生效。',
                    'A relink path appeared without matching CK Forge authorization evidence for the current binary, contract, Core, toolchain, and full FQBN, so fast compilation cannot be claimed.',
                );
            recommendation = uiText(
                '保持原生 Arduino CLI 安全路径；完成当前完整身份的四阶段 A/B 并取得有效证书后，界面才会显示已认证热构建。',
                'Keep the native Arduino CLI safe route; certified hot build appears only after four-stage A/B qualification completes for this full identity.',
            );
        }
    } else if (success && forgeDecision === 'force-platform' && forgeFastAuthorized && nativeRelinkCertificateMatched) {
        if (esp32LibraryBaselineCommitted) {
            summary = uiText('CK Forge · 已认证依赖基线', 'CK Forge · Certified dependency baseline');
            explanation = uiText(
                `本次由平台原生构建确认并封存了当前 ESP32 Core 内置库的真实依赖图，用时 ${formatCompileDuration(cliCompileMs || totalMs)}；后续只修改源码且库依赖不变时可进入 NativeRelink。`,
                `Platform-native build verified and sealed the ESP32 Core built-in library dependency graph in ${formatCompileDuration(cliCompileMs || totalMs)}; subsequent source-only edits with unchanged libraries can use NativeRelink.`,
            );
            recommendation = uiText(
                '无需重复重建；下一次保持相同库依赖修改代码，即可验证局部构建路径。',
                'No rebuild needed; edit your sketch with the same libraries next time to verify the partial build path.',
            );
        } else if (buildMode === 'exact-match') {
            summary = uiText('CK Forge · 已认证产物复用', 'CK Forge · Certified artifact reuse');
            explanation = uiText(
                '当前目标的 NativeRelink 资格证书与完整身份匹配；本次代码和编译环境未变化，直接复用了已认证基线产物。',
                'The NativeRelink certificate matched this full target identity; code and environment were unchanged, so the certified baseline artifact was reused.',
            );
            recommendation = uiText(
                '当前无需处理；修改代码后，符合门禁的编辑会进入 NativeRelink 快速路径。',
                'No action needed; qualifying code edits will enter the NativeRelink fast path.',
            );
        } else if (buildMode === 'full-build') {
            summary = forcedRebuild
                ? uiText('CK Forge · 已认证 · 重建基线', 'CK Forge · Certified · Rebuilding baseline')
                : uiText('CK Forge · 已认证 · 首次建立基线', 'CK Forge · Certified · Initial baseline');
            explanation = uiText(
                `当前目标已通过 NativeRelink 资格认证；本次先执行完整 Release 构建以建立安全基线，用时 ${formatCompileDuration(cliCompileMs || totalMs)}，后续符合门禁的编辑将进入快速路径。`,
                `This target is certified for NativeRelink; a full Release build established the safe baseline in ${formatCompileDuration(cliCompileMs || totalMs)}, and subsequent qualifying edits will use the fast path.`,
            );
            recommendation = uiText(
                '这是认证目标首次建立或主动重建基线的正常过程，不代表快速资格缺失。',
                'This is normal for establishing or rebuilding a certified target baseline and does not indicate missing fast qualification.',
            );
        } else {
            status = 'attention';
            summary = uiText('CK Forge · 已认证安全构建', 'CK Forge · Certified safe build');
            explanation = esp32LibraryBaselineSkipped
                ? uiText(
                    `当前目标资格证书有效，但本次 ESP32 库依赖基线未能安全封存，因此继续使用平台原生路径，用时 ${formatCompileDuration(cliCompileMs || totalMs)}。`,
                    `Target qualification is valid, but the ESP32 library dependency baseline could not be safely sealed, so the platform-native route was used (${formatCompileDuration(cliCompileMs || totalMs)}).`,
                )
                : uiText(
                    `当前目标资格证书有效，但当前构建输入还没有匹配的依赖基线，因此本次使用平台原生路径，用时 ${formatCompileDuration(cliCompileMs || totalMs)}。`,
                    `Target qualification is valid, but no matching dependency baseline exists for these build inputs yet, so the platform-native route was used (${formatCompileDuration(cliCompileMs || totalMs)}).`,
                );
            recommendation = esp32LibraryBaselineSkipped
                ? uiText(
                    '展开技术日志查看“baseline commit skipped”的明确原因；未通过门禁前不会冒充为热构建。',
                    'Expand the technical log for the exact "baseline commit skipped" reason; hot build is not claimed until all gates pass.',
                )
                : uiText(
                    '资格只证明当前目标可使用快速路线，不代表任意依赖图已自动授权；CK 会在可安全封存依赖基线后启用局部构建。',
                    'Qualification certifies the target for the fast route once a dependency baseline is safely sealed.',
                );
        }
    } else if (success && forgeDecision === 'force-platform') {
        status = 'attention';
        summary = buildMode === 'exact-match'
            ? uiText('CK Forge · 原生产物复用', 'CK Forge · Native artifact reuse')
            : uiText('CK Forge · 原生安全构建', 'CK Forge · Native safe build');
        explanation = buildMode === 'exact-match'
            ? uiText(
                `${forgeCoreSupport.detail} 本次复用了既有原生产物，但不会标记为 Fast。`,
                `${forgeCoreSupport.detail} Existing native artifacts were reused without claiming Fast mode.`,
            )
            : uiText(
                `${forgeCoreSupport.detail} 本次平台原生构建用时 ${formatCompileDuration(cliCompileMs || totalMs)}。`,
                `${forgeCoreSupport.detail} Platform-native build completed in ${formatCompileDuration(cliCompileMs || totalMs)}.`,
            );
        recommendation = forgeCoreSupport.status === 'local-certification-required'
            ? uiText(
                `当前版本仍可正常使用，不要求降级。随安装包已有资格证据的 Core：${forgeCoreSupport.certifiedCoreVersions.join('、') || '暂无'}；当前完整身份通过本机 A/B 后会自动启用快速路径。`,
                `This Core works normally with no downgrade required. Bundled qualification evidence covers Core: ${forgeCoreSupport.certifiedCoreVersions.join(', ') || 'none'}; the fast route enables automatically after local A/B qualification.`,
            )
            : uiText(
                '当前版本仍可正常使用；这是防止第三方或新版 Core 被优化得更慢的安全路径，当前完整身份通过性能资格后才会启用快速路径。',
                'This Core works normally; the safe route prevents regressions on third-party or newer Cores until performance qualification passes.',
            );
    } else if (success && buildMode === 'full-build' && !forcedRebuild) {
        status = 'attention';
        summary = forgeDecision === 'allow-fast'
            ? uiText('CK Forge · 首次构建', 'CK Forge · Initial build')
            : uiText('本次执行了完整构建', 'Full build performed');
        explanation = uiText(
            '没有可安全复用的完整缓存，核心和依赖可能被重新编译。',
            'No reusable complete cache was available, so core and dependencies may have been recompiled.',
        );
        recommendation = uiText(
            '首次构建属于正常情况；若连续发生，请查看下方缓存失效原因。',
            'Normal for a first build; if this happens repeatedly, inspect the cache miss reasons below.',
        );
    } else if (success && buildMode === 'exact-match') {
        summary = forgeDecision === 'allow-fast'
            ? uiText('CK Forge · 产物直达', 'CK Forge · Direct artifact hit')
            : uiText('完整缓存命中', 'Exact cache hit');
        explanation = uiText(
            '代码和编译环境均未变化，直接复用了上次固件产物。',
            'Source code and build environment were unchanged, so the previous firmware artifact was reused.',
        );
    } else if (success && buildMode === 'arduino-cli-incremental') {
        status = 'attention';
        summary = uiText('Arduino CLI 执行了增量构建', 'Arduino CLI incremental build');
        explanation = uiText(
            `缓存目录可用，但本次由 Arduino CLI 按当前输入重新确认依赖并构建，用时 ${formatCompileDuration(cliCompileMs || totalMs)}。`,
            `Build cache was available, and Arduino CLI re-verified dependencies and compiled changes in ${formatCompileDuration(cliCompileMs || totalMs)}.`,
        );
        recommendation = uiText(
            '这是依赖变化时的安全路径；若没有修改依赖却频繁出现，可检查下方缓存未命中原因。',
            'This is the safe route when dependencies change; if it happens without dependency edits, check the cache miss reasons below.',
        );
    } else if (success && (
        buildMode === 'arduino-cli-incremental-fallback'
        || buildMode === 'arduino-cli-full-fallback'
    )) {
        status = 'attention';
        summary = uiText('快速路径已安全回退', 'Fast route safely fell back');
        explanation = uiText(
            `快速重链接未通过安全门禁，已改由 Arduino CLI ${buildMode === 'arduino-cli-full-fallback' ? '完整' : '增量'}构建，用时 ${formatCompileDuration(cliCompileMs || totalMs)}。`,
            `Fast relink did not pass safety checks and fell back to an Arduino CLI ${buildMode === 'arduino-cli-full-fallback' ? 'full' : 'incremental'} build (${formatCompileDuration(cliCompileMs || totalMs)}).`,
        );
        recommendation = uiText(
            '产物以 Arduino CLI 当前依赖解析为准；若连续发生，可查看回退原因优化缓存。',
            'Output matches Arduino CLI dependency resolution; inspect the fallback reason if this happens repeatedly.',
        );
    }

    if (success && environmentChanges.length > 0 && status === 'healthy') {
        status = 'attention';
        recommendation = uiText(
            '环境变化会让旧缓存安全失效，这是正常保护，不建议强行复用。',
            'Environment changes safely invalidate old caches; forcing reuse is not recommended.',
        );
    }

    return {
        status,
        targetFqbn: diagnostics?.fqbn || currentEnvironment.fqbn,
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
