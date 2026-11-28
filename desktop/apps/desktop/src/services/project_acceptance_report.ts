import type { ProjectBuildTarget } from './project_build_target';
const isEnglishLocale = (): boolean => {
    try {
        const lang = typeof document !== 'undefined' ? document.documentElement?.lang : '';
        const stored = typeof window !== 'undefined' ? window.localStorage?.getItem('ck.i18n.uiLocale') : '';
        return /^en(?:-|$)/i.test(String(lang || stored || ''));
    } catch { return false; }
};
const uiText = (zh: string, en: string): string => (isEnglishLocale() ? en : zh);
import type { CompileDoctorReport } from './compile_doctor';
import type { CompileResourceReport } from './compile_resources';
import type { DeviceHealthReport } from './device_health';
import type { LastWorkingVersion } from './last_working_version';
import type { PinPreflightReport } from './pin_preflight';
import type { ProjectCheckpointMetadata } from './project_checkpoints';
import type { BoardPackage } from '../types/board';
import { projectHealthCapabilities } from './project_health_capabilities';
import {
    explainCompileResourceGrowth,
    explainResourceGrowth,
    type ResourceGrowthEvidence,
    type ResourceGrowthExplanation,
} from './resource_growth';

export type ProjectHealthState = 'pass' | 'warning' | 'error' | 'info';

export interface ProjectHealthCheck {
    id: string;
    state: ProjectHealthState;
    title: string;
    detail: string;
    evidence: string | null;
    /** Optional machine-readable subchecks, used by the four-level board passport. */
    stages?: ProjectHealthStage[];
}

export interface ProjectHealthStage {
    id: 'structure' | 'environment' | 'compile' | 'device';
    state: ProjectHealthState;
    title: string;
    detail: string;
    checkedAt: string | null;
}

export interface ProjectHealthChecklist {
    checks: ProjectHealthCheck[];
    counts: Record<ProjectHealthState, number>;
    /** Deliberately textual: CK does not turn unlike checks into a fake score. */
    summary: string;
}

export interface ProjectAcceptanceNotes {
    circuitDescription?: string;
    testRecords?: string;
}

/**
 * Frozen identity of the foreground build that produced structured evidence.
 * It is attached to the compile and resource result objects in-memory only;
 * local paths and run identifiers are not copied into the shareable report.
 */
export interface ProjectBuildEvidenceIdentity {
    readonly schemaVersion: 1;
    readonly runId: string;
    readonly kind: 'compile' | 'upload';
    readonly boardPackageId: string;
    readonly fqbn: string;
    readonly coreId: string;
    readonly coreVersion: string;
    readonly workspaceSha256: string;
    readonly generatedCodeSha256: string;
    readonly recordedAt: string;
}

export type ProjectBuildEvidenceSeed = Omit<ProjectBuildEvidenceIdentity, 'recordedAt'>;

export interface ProjectUploadResult {
    recordedAt: string;
    baselineFailure: string | null;
    projectBuildEvidence: Readonly<ProjectBuildEvidenceIdentity>;
}

/** A notice is informational; only the verified stored baseline authorizes recovery. */
export const createProjectUploadResult = (
    log: string,
    seed: Readonly<ProjectBuildEvidenceSeed>,
    recordedAt = new Date().toISOString(),
    baselineFailure?: string | null,
): ProjectUploadResult => {
    const failures = [...log.matchAll(/^\[WARN\] 本次上传成功，但‘上一个可用版本’保存失败：([^\r\n]+)$/gm)];
    return bindProjectBuildEvidence({
        recordedAt,
        baselineFailure: baselineFailure ?? failures[failures.length - 1]?.[1] ?? null,
    }, seed, recordedAt) as ProjectUploadResult;
};

type EvidenceBound<T> = T & {
    readonly projectBuildEvidence?: Readonly<ProjectBuildEvidenceIdentity>;
};

export const bindProjectBuildEvidence = <T extends object>(
    value: T,
    seed: Readonly<ProjectBuildEvidenceSeed>,
    recordedAt: string,
): EvidenceBound<T> => Object.freeze({
    ...value,
    projectBuildEvidence: Object.freeze({ ...seed, recordedAt }),
});

export interface CreateProjectAcceptanceReportInput {
    savedConfiguration?: ProjectBuildTarget | null;
    projectName: string;
    projectPath?: string;
    workspaceJson: string;
    generatedCode: string;
    blockCount: number;
    boardName: string;
    boardId: string;
    boardPackageId: string;
    /** Backend-resolved complete FQBN; never a package alias or package ID. */
    fqbn: string;
    coreId: string;
    coreVersion: string;
    /** The currently selected exact package. Historical evidence must not select it. */
    boardPackage?: BoardPackage | null;
    compileDoctorReport: CompileDoctorReport | null;
    compileResourceReport: CompileResourceReport | null;
    deviceHealthReport: DeviceHealthReport | null;
    pinPreflightReport: PinPreflightReport | null;
    lastWorkingVersion: LastWorkingVersion | null;
    uploadResult?: ProjectUploadResult | null;
    checkpoints: ProjectCheckpointMetadata[];
    resourceGrowthEvidence?: ResourceGrowthEvidence | null;
    notes?: ProjectAcceptanceNotes;
}

export interface ProjectAcceptanceReport {
    schemaVersion: 1;
    kind: 'ck-project-acceptance-report';
    generatedAt: string;
    project: {
        name: string;
        blockCount: number;
        workspaceSha256: string;
        generatedCodeSha256: string;
        structure: {
            available: boolean;
            topLevelFlowCount: number | null;
            blockTypes: Array<{ type: string; count: number }>;
        };
        /** Local paths are omitted by default from the shareable report. */
        pathIncluded: false;
    };
    target: {
        savedConfiguration?: ProjectBuildTarget | null;
        boardName: string;
        boardId: string;
        boardPackageId: string;
        fqbn: string;
        coreId: string;
        coreVersion: string | null;
    };
    build: {
        state: 'passed' | 'failed' | 'not-run' | 'unverified-target';
        recordedAt: string | null;
        profile: string | null;
        durationMs: number | null;
        warningCount: number | null;
        flashUsedBytes: number | null;
        flashTotalBytes: number | null;
        ramUsedBytes: number | null;
        ramTotalBytes: number | null;
        resourceGrowth: ResourceGrowthExplanation;
    };
    dependencies: {
        lockAvailable: boolean;
        lockSha256: string | null;
        entries: Array<{ name: string; version: string | null; contentSha256: string }>;
        allVersioned: boolean;
    };
    hardware: {
        state: 'verified' | 'partial' | 'failed' | 'not-checked' | 'unsupported';
        observedAt: string | null;
        chip: string | null;
        revision: string | null;
        flashBytes: number | null;
        psramBytes: number | null;
        /** Stable device identifiers such as full MAC are never exported here. */
        identityIncluded: false;
    };
    history: {
        checkpointCount: number;
        latestCheckpointAt: string | null;
        modificationCount: null;
        note: string;
    };
    notes: {
        circuitDescription: string | null;
        testRecords: string | null;
    };
    health: ProjectHealthChecklist;
    limitations: string[];
}

const validSha256 = (value: string | null | undefined): boolean => (
    typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value.trim())
);

const sha256 = async (value: string): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

const baseFqbn = (value: string): string => value.trim().split(':').slice(0, 3).join(':');

const isStandardFqbn = (value: string): boolean => {
    const parts = value.trim().split(':');
    return parts.length >= 3 && parts.slice(0, 3).every(part => Boolean(part.trim()));
};

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | null => (
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as UnknownRecord
        : null
);

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const stringList = (value: unknown): string[] => Array.isArray(value)
    ? value.map(text).filter(Boolean)
    : [];

const validDate = (value: unknown): string | null => {
    const raw = text(value);
    return raw && Number.isFinite(Date.parse(raw)) ? raw : null;
};

const projectHealthStage = (
    id: ProjectHealthStage['id'],
    state: ProjectHealthState,
    title: string,
    detail: string,
    checkedAt: string | null = null,
): ProjectHealthStage => ({ id, state, title, detail, checkedAt });

const expiryFrom = (passport: UnknownRecord, profile: UnknownRecord | null): string | null => {
    const candidates = [
        passport.expires_at,
        passport.expiresAt,
        passport.valid_until,
        passport.validUntil,
        profile?.expires_at,
        profile?.expiresAt,
        profile?.valid_until,
        profile?.validUntil,
    ];
    return candidates.map(validDate).find(Boolean) || null;
};

/**
 * Resolve the selected package's four-level passport without borrowing normal
 * project compile or device-health results. Only the exact package, complete
 * FQBN and installed Core may receive a green stage.
 */
export const createBoardPassportHealthCheck = (
    input: Pick<CreateProjectAcceptanceReportInput,
        'boardId' | 'boardPackageId' | 'fqbn' | 'coreId' | 'coreVersion' | 'boardPackage'>,
    now = new Date().toISOString(),
): ProjectHealthCheck => {
    const selected = input.boardPackage;
    const passport = asRecord(selected?.passport);
    const pending = (detail: string): ProjectHealthCheck => ({
        id: 'board-passport',
        state: 'info',
        title: uiText('板卡护照待验证', 'Board passport pending verification'),
        detail,
        evidence: null,
        stages: [
            projectHealthStage('structure', 'info', uiText('结构待检查', 'Structure pending'), detail),
            projectHealthStage('environment', 'info', uiText('当前环境待确认', 'Environment pending'), uiText('没有可绑定到当前包与 Core 的环境证据。', 'No environment evidence bound to the current package and Core.')),
            projectHealthStage('compile', 'info', uiText('本机编译待验证', 'Local build pending'), uiText('没有当前完整 FQBN 的护照编译档案。', 'No passport compile profile for the current complete FQBN.')),
            projectHealthStage('device', 'info', uiText('真板待验证', 'Hardware pending'), uiText('未验证不等于失败；也不代表积木或外设已经真机验证。', 'Unverified does not mean failed, nor does it certify individual blocks or peripherals.')),
        ].filter(stage => stage.id !== 'device' || projectHealthCapabilities(input.fqbn).deviceHealth),
    });
    if (!selected || !passport) {
        return pending(selected
            ? uiText('当前板卡包没有机器可读护照；四级状态保持待验证。', 'This board package has no machine-readable passport; all four stages remain pending.')
            : uiText('无法取得当前精确板卡包；不会借用同 FQBN 的其他包证据。', 'Could not resolve the exact board package; evidence from other packages with the same FQBN is never reused.'));
    }

    const board = asRecord(passport.board);
    const core = asRecord(passport.core);
    const profiles = Array.isArray(passport.profiles)
        ? passport.profiles.map(asRecord).filter(Boolean) as UnknownRecord[]
        : [];
    const selectedPackageId = text(selected.id);
    const currentPackageId = text(input.boardPackageId);
    const currentFqbn = text(input.fqbn);
    const currentCoreId = text(input.coreId);
    const currentCoreVersion = text(input.coreVersion);
    const profile = profiles.find(item => text(item.fqbn) === currentFqbn) || null;
    const status = text(passport.certification_status).toLowerCase();
    const invalidatedReasons = stringList(passport.invalidated_reasons);
    const explicitExpiry = expiryFrom(passport, profile);
    const parsedNow = Date.parse(now);
    const nowMs = Number.isFinite(parsedNow) ? parsedNow : Date.now();
    const expired = status === 'expired'
        || status === 'revalidation_required'
        || invalidatedReasons.length > 0
        || Boolean(explicitExpiry && Date.parse(explicitExpiry) <= nowMs);
    const packageMatches = Boolean(
        selectedPackageId
        && currentPackageId
        && selectedPackageId === currentPackageId
        && text(board?.id) === selectedPackageId,
    );
    const fqbnBaseMatches = text(board?.fqbn_base) === baseFqbn(currentFqbn);
    const corePackageMatches = text(core?.package) === currentCoreId;
    const coreVersionMatches = Boolean(
        currentCoreVersion
        && text(core?.installed_version) === currentCoreVersion,
    );
    const identityMatches = packageMatches && fqbnBaseMatches && corePackageMatches && coreVersionMatches;
    const identityProblems = [
        !packageMatches ? uiText('板卡包 ID 不一致', 'board package ID mismatch') : '',
        !fqbnBaseMatches ? uiText('基础 FQBN 不一致', 'base FQBN mismatch') : '',
        !corePackageMatches ? uiText('Core 包不一致', 'Core package mismatch') : '',
        !coreVersionMatches ? uiText('Core 版本不一致或未记录', 'Core version mismatch or unrecorded') : '',
        !profile ? uiText('没有当前完整 FQBN 档案', 'no profile for current complete FQBN') : '',
    ].filter(Boolean);
    const staleDetail = expired
        ? uiText(`认证已失效${invalidatedReasons.length ? `：${invalidatedReasons.join('、')}` : explicitExpiry ? `：有效期至 ${explicitExpiry}` : ''}。`, `Certification expired${invalidatedReasons.length ? `: ${invalidatedReasons.join(', ')}` : explicitExpiry ? `: valid until ${explicitExpiry}` : ''}.`)
        : identityProblems.length ? uiText(`证据未绑定当前目标：${identityProblems.join('、')}。`, `Evidence does not match current target: ${identityProblems.join(', ')}.`) : '';

    const hashesComplete = [
        passport.source_package_sha256,
        passport.source_content_sha256,
        passport.installed_content_sha256,
        passport.menu_schema_sha256,
    ].every(value => validSha256(text(value)));
    const structurePass = identityMatches
        && Boolean(profile)
        && !expired
        && hashesComplete
        && !['failed', 'blocked_core'].includes(status);
    const structureFailed = status === 'failed' || text(selected.quality_report?.status) === 'failed';
    const environmentUsable = core?.usable === true;
    const environmentPass = structurePass && environmentUsable;
    const environmentFailed = core?.usable === false || status === 'blocked_core';
    const profileStatus = text(profile?.status).toLowerCase();
    const checkedAt = validDate(profile?.checked_at);
    const checkedAtIsCurrent = Boolean(
        checkedAt
        && Date.parse(checkedAt) <= nowMs + (5 * 60 * 1000),
    );
    const installedHashMatches = Boolean(
        validSha256(text(profile?.installed_content_sha256))
        && text(profile?.installed_content_sha256) === text(passport.installed_content_sha256),
    );
    const profileIdentityComplete = Boolean(
        checkedAtIsCurrent
        && text(profile?.core_version) === currentCoreVersion
        && text(profile?.toolchain_key)
        && installedHashMatches,
    );
    const evidence = asRecord(profile?.evidence);
    const evidenceFqbnMatches = text(evidence?.canonical_fqbn) === currentFqbn;
    const compileEvidenceKind = text(evidence?.kind) === 'compile-result'
        && text(evidence?.stage) === 'compile';
    const deviceEvidenceKind = text(evidence?.kind) === 'device-result'
        && ['device', 'runtime'].includes(text(evidence?.stage));
    const compilePass = environmentPass
        && profileIdentityComplete
        && evidenceFqbnMatches
        && (profileStatus === 'compile_passed'
            ? compileEvidenceKind
            : profileStatus === 'device_verified' && deviceEvidenceKind);
    const devicePass = environmentPass
        && profileIdentityComplete
        && evidenceFqbnMatches
        && profileStatus === 'device_verified'
        && deviceEvidenceKind;
    const profileFailed = profileStatus === 'failed';

    const stages: ProjectHealthStage[] = [
        projectHealthStage(
            'structure',
            structurePass ? 'pass' : structureFailed ? 'error' : expired || identityProblems.length ? 'warning' : 'info',
            structurePass ? uiText('结构已检查', 'Structure checked') : structureFailed ? uiText('结构检查失败', 'Structure check failed') : uiText('结构待检查', 'Structure pending'),
            structurePass
                ? uiText('目录、清单和内容身份已由当前板卡包护照绑定。', 'Directory, manifest, and content hashes are bound by the board package passport.')
                : staleDetail || uiText('缺少完整结构哈希或当前配置档案。', 'Missing complete structure hashes or profile for the current configuration.'),
            validDate(passport.generated_at),
        ),
        projectHealthStage(
            'environment',
            environmentPass ? 'pass' : environmentFailed ? 'error' : identityProblems.length || expired ? 'warning' : 'info',
            environmentPass ? uiText('当前环境已就绪', 'Environment ready') : environmentFailed ? uiText('当前环境不可用', 'Environment unavailable') : uiText('当前环境待确认', 'Environment pending'),
            environmentPass
                ? uiText(`${currentCoreId}@${currentCoreVersion} 与护照精确一致。`, `${currentCoreId}@${currentCoreVersion} matches the passport exactly.`)
                : staleDetail || uiText('护照没有确认当前 Core 环境。', 'Passport has not verified the current Core environment.'),
            checkedAt,
        ),
        projectHealthStage(
            'compile',
            compilePass ? 'pass' : profileFailed ? 'error' : identityProblems.length || expired ? 'warning' : 'info',
            compilePass ? uiText('本机编译已验证', 'Local build verified') : profileFailed ? uiText('本机编译验证失败', 'Local build verification failed') : uiText('本机编译待验证', 'Local build pending'),
            compilePass
                ? uiText(`护照档案已绑定当前完整 FQBN：${currentFqbn}。`, `Passport profile is bound to complete FQBN: ${currentFqbn}.`)
                : staleDetail || uiText('普通工程编译结果不会自动升级为板卡护照认证。', 'Regular project builds do not automatically upgrade board passport certification.'),
            compilePass ? checkedAt : null,
        ),
        projectHealthStage(
            'device',
            devicePass ? 'pass' : profileFailed ? 'error' : identityProblems.length || expired ? 'warning' : 'info',
            devicePass ? uiText('真板已验证', 'Hardware verified') : uiText('真板待验证', 'Hardware pending'),
            devicePass
                ? uiText('当前配置档案含专用 device-result 证据；该结论不扩展为积木或外设逐项真机验证。', 'Profile includes dedicated device-result evidence; this does not certify every block or peripheral.')
                : staleDetail || uiText('真机体检或普通上传不会自动冒充板卡护照的真板认证。', 'Device health checks or regular uploads do not substitute for board passport hardware certification.'),
            devicePass ? checkedAt : null,
        ),
    ];
    if (!projectHealthCapabilities(input.fqbn).deviceHealth) {
        stages.splice(stages.findIndex(stage => stage.id === 'device'), 1);
    }
    const states = stages.map(item => item.state);
    const overall: ProjectHealthState = states.includes('error')
        ? 'error'
        : states.includes('warning')
            ? 'warning'
            : states.every(item => item === 'pass')
                ? 'pass'
                : 'info';
    const passedCount = stages.filter(item => item.state === 'pass').length;
    return {
        id: 'board-passport',
        state: overall,
        title: overall === 'pass'
            ? uiText('板卡护照四级证据完整', 'Board passport complete (4/4)')
            : overall === 'error'
                ? uiText('板卡护照存在阻止项', 'Board passport has blocking issues')
                : overall === 'warning'
                    ? uiText('板卡护照证据已过期或与当前配置不匹配', 'Board passport expired or mismatched')
                    : uiText('板卡护照待补齐', 'Board passport incomplete'),
        detail: uiText(`${passedCount}/4 级已验证；证据严格绑定当前包、完整 FQBN、Core 与有效状态。`, `${passedCount}/4 stages verified; evidence is strictly bound to package, complete FQBN, Core, and validity.`),
        evidence: structurePass ? text(passport.installed_content_sha256) : null,
        stages,
    };
};

const buildEvidenceIdentity = (
    value: CompileDoctorReport | CompileResourceReport | null,
): Readonly<ProjectBuildEvidenceIdentity> | null => {
    if (!value || typeof value !== 'object') return null;
    const identity = (value as EvidenceBound<typeof value>).projectBuildEvidence;
    return identity || null;
};

const buildEvidenceMatchesCurrent = (
    identity: Readonly<ProjectBuildEvidenceIdentity> | null,
    input: Pick<CreateProjectAcceptanceReportInput,
        'boardPackageId' | 'fqbn' | 'coreId' | 'coreVersion'>,
    workspaceSha256: string | undefined,
    generatedCodeSha256: string | undefined,
    recordedAt: string | null | undefined,
): boolean => Boolean(
    identity
    && identity.schemaVersion === 1
    && identity.runId.trim()
    && validSha256(identity.workspaceSha256)
    && validSha256(identity.generatedCodeSha256)
    && identity.boardPackageId.trim() === input.boardPackageId.trim()
    && identity.fqbn.trim() === input.fqbn.trim()
    && identity.coreId.trim() === input.coreId.trim()
    && identity.coreVersion.trim() === input.coreVersion.trim()
    && identity.workspaceSha256 === workspaceSha256
    && identity.generatedCodeSha256 === generatedCodeSha256
    && identity.recordedAt === recordedAt
    && Number.isFinite(Date.parse(identity.recordedAt))
);

const compileMatchesTarget = (
    report: CompileDoctorReport | null,
    input: Pick<CreateProjectAcceptanceReportInput,
        'boardPackageId' | 'fqbn' | 'coreId' | 'coreVersion'>,
    workspaceSha256?: string,
    generatedCodeSha256?: string,
): boolean => Boolean(
    report
    && String(report.diagnostics?.fqbn || report.targetFqbn || '').trim() === input.fqbn.trim()
    && buildEvidenceMatchesCurrent(
        buildEvidenceIdentity(report),
        input,
        workspaceSha256,
        generatedCodeSha256,
        report.recordedAt,
    ),
);

const resourcesMatchTarget = (
    report: CompileResourceReport | null,
    input: Pick<CreateProjectAcceptanceReportInput,
        'boardPackageId' | 'fqbn' | 'coreId' | 'coreVersion'>,
    workspaceSha256?: string,
    generatedCodeSha256?: string,
    requiredRunId?: string,
): boolean => {
    const identity = buildEvidenceIdentity(report);
    return Boolean(
        report
        && report.fqbn.trim() === input.fqbn.trim()
        && (!requiredRunId || identity?.runId === requiredRunId)
        && buildEvidenceMatchesCurrent(
            identity,
            input,
            workspaceSha256,
            generatedCodeSha256,
            report.recordedAt,
        )
    );
};

const baselineMatchesTarget = (
    version: LastWorkingVersion | null,
    fqbn: string,
    boardPackageId: string,
    coreId: string,
    coreVersion: string,
    workspaceSha256?: string,
    generatedCodeSha256?: string,
): boolean => {
    if (!version
        || !workspaceSha256
        || !generatedCodeSha256
        || version.environment.fqbn.trim() !== fqbn.trim()
        || version.environment.coreId.trim() !== coreId.trim()
        || String(version.environment.coreVersion || '').trim() !== coreVersion.trim()
        || version.project.workspaceSha256 !== workspaceSha256
        || version.project.generatedCodeSha256 !== generatedCodeSha256) return false;
    const packageId = String(version.project.boardPackageId || version.project.board || '').trim();
    return packageId === boardPackageId.trim();
};

const summarizeWorkspaceStructure = (
    workspaceJson: string,
): ProjectAcceptanceReport['project']['structure'] => {
    try {
        const root = JSON.parse(workspaceJson) as Record<string, unknown>;
        const blocksRecord = root?.blocks && typeof root.blocks === 'object'
            ? root.blocks as Record<string, unknown>
            : null;
        const topLevel = Array.isArray(blocksRecord?.blocks) ? blocksRecord!.blocks as unknown[] : null;
        if (!topLevel) return { available: false, topLevelFlowCount: null, blockTypes: [] };
        const counts = new Map<string, number>();
        const visit = (value: unknown) => {
            if (Array.isArray(value)) {
                value.forEach(visit);
                return;
            }
            if (!value || typeof value !== 'object') return;
            const record = value as Record<string, unknown>;
            if (typeof record.type === 'string' && record.type.trim()) {
                const type = record.type.trim().slice(0, 160);
                counts.set(type, (counts.get(type) || 0) + 1);
            }
            Object.values(record).forEach(visit);
        };
        topLevel.forEach(visit);
        return {
            available: true,
            topLevelFlowCount: topLevel.length,
            blockTypes: [...counts.entries()]
                .map(([type, count]) => ({ type, count }))
                .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type))
                .slice(0, 40),
        };
    } catch {
        return { available: false, topLevelFlowCount: null, blockTypes: [] };
    }
};

const sanitizeNote = (value: string | null | undefined): string | null => {
    const text = String(value || '').trim().slice(0, 10_000);
    if (!text) return null;
    return text
        // URI paths must run before plain filesystem paths so their scheme is
        // not left behind as a misleading partial value.
        .replace(/\bfile:\/{2,3}(?:[A-Za-z]:)?[^\s<>"'|?*]+/gi, '[本机路径已隐藏]')
        .replace(/\\\\[^\s\\/]+[\\/][^\r\n<>"|?*]+/g, '[本机路径已隐藏]')
        .replace(/\b[A-Za-z]:[\\/][^\r\n<>"|?*]+/g, '[本机路径已隐藏]')
        .replace(/\/(?:Users|home)\/[^\s/]+(?:\/[^\r\n<>"']*)?/gi, '[本机路径已隐藏]')
        // Colon/dash, Cisco dotted and raw twelve-hex hardware addresses.
        .replace(/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, '[MAC 已隐藏]')
        .replace(/\b[0-9a-f]{4}(?:\.[0-9a-f]{4}){2}\b/gi, '[MAC 已隐藏]')
        .replace(/\b[0-9a-f]{12}\b/gi, '[MAC 已隐藏]')
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[邮箱已隐藏]')
        .replace(/\b(?:authorization\s*:\s*bearer|bearer)\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [令牌已隐藏]')
        .replace(/\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token)\s*[:=：]\s*[^\s,;，；]+/gi, 'token: [令牌已隐藏]')
        .replace(/\b(?:password|passwd|pwd|密码)\s*[:=：]\s*[^\s,;，；]+/gi, '密码: [口令已隐藏]')
        .replace(/\bssid\s*[:=：]\s*[^\r\n,;，；]+/gi, 'SSID: [Wi-Fi 名称已隐藏]');
};

const resourceState = (
    report: CompileResourceReport | null,
    input: Pick<CreateProjectAcceptanceReportInput,
        'boardPackageId' | 'fqbn' | 'coreId' | 'coreVersion'>,
    workspaceSha256?: string,
    generatedCodeSha256?: string,
    requiredRunId?: string,
): ProjectHealthCheck => {
    if (!report || !requiredRunId || !resourcesMatchTarget(
        report,
        input,
        workspaceSha256,
        generatedCodeSha256,
        requiredRunId,
    )) {
        return {
            id: 'resource-budget',
            state: 'info',
            title: report ? uiText('已有资源结果不属于当前工程快照', 'Existing resource result does not match current snapshot') : uiText('资源预算尚未生成', 'Resource budget not yet generated'),
            detail: report
                ? uiText(`资源证据未同时绑定当前积木、源码、板卡包、完整 FQBN、Core 与构建 run，不会混用。`, 'Resource evidence is not bound to the current blocks, source, board package, complete FQBN, Core, and build run.')
                : uiText('成功编译后显示程序空间和内部 RAM 上限。', 'Program space and internal RAM limits appear after a successful build.'),
            evidence: null,
        };
    }
    const levels = [report.flash?.level, report.ram?.level];
    if (!levels.includes('critical') && (!report.flash || !report.ram
        || report.flash.capacityKnown === false || report.ram.capacityKnown === false)) {
        return {
            id: 'resource-budget', state: 'info', title: uiText('资源上限未报告', 'Resource limits not reported'),
            detail: uiText('本次编译没有完整的容量上限，不能判断资源预算是否安全。', 'This build did not report complete capacity limits, so budget safety cannot be determined.'),
            evidence: report.recordedAt || null,
        };
    }
    const state: ProjectHealthState = levels.includes('critical')
        ? 'error'
        : levels.includes('warning')
            ? 'warning'
            : 'pass';
    return {
        id: 'resource-budget',
        state,
        title: state === 'pass' ? uiText('资源预算在安全范围内', 'Resource budget is within safe limits') : state === 'error' ? uiText('资源预算接近或超过上限', 'Resource budget near or above limit') : uiText('资源预算余量偏低', 'Resource budget headroom is low'),
        detail: uiText('阈值按编译器报告的 APP 程序空间和内部静态 RAM 计算，不把实体 Flash 或 PSRAM 混入。', 'Thresholds are calculated from compiler-reported APP program space and internal static RAM, excluding physical Flash or PSRAM.'),
        evidence: report.recordedAt || null,
    };
};

export const createProjectHealthChecklist = (
    input: Omit<CreateProjectAcceptanceReportInput, 'workspaceJson' | 'generatedCode' | 'projectPath' | 'resourceGrowthEvidence'> & {
        currentWorkspaceSha256?: string;
        currentGeneratedCodeSha256?: string;
        evidenceNow?: string;
    },
): ProjectHealthChecklist => {
    const checks: ProjectHealthCheck[] = [];
    const capabilities = projectHealthCapabilities(input.fqbn);
    checks.push({
        id: 'board-target',
        state: isStandardFqbn(input.fqbn) ? 'pass' : 'error',
        title: isStandardFqbn(input.fqbn) ? uiText('板卡编译目标已明确', 'Board build target resolved') : uiText('板卡编译目标不完整', 'Board build target incomplete'),
        detail: input.fqbn || uiText('尚未选择可编译板卡。', 'No buildable board selected yet.'),
        evidence: input.boardPackageId || null,
    });
    checks.push(createBoardPassportHealthCheck(input, input.evidenceNow));

    const coreReady = Boolean(input.coreId.trim() && input.coreVersion.trim());
    checks.push({
        id: 'core-environment',
        state: coreReady ? 'pass' : 'error',
        title: coreReady ? uiText('Core 环境已就绪', 'Core environment ready') : uiText('Core 环境尚未就绪', 'Core environment not ready'),
        detail: coreReady ? `${input.coreId}@${input.coreVersion}` : uiText('缺少 Core 包或无法识别版本。', 'Core package is missing or version could not be identified.'),
        evidence: coreReady ? `${input.coreId}@${input.coreVersion}` : null,
    });

    const compile = input.compileDoctorReport;
    const compileMatches = compileMatchesTarget(
        compile,
        input,
        input.currentWorkspaceSha256,
        input.currentGeneratedCodeSha256,
    );
    const compileRunId = compileMatches ? buildEvidenceIdentity(compile)?.runId : undefined;
    checks.push({
        id: 'compile-result',
        state: !compile ? 'info' : !compileMatches ? 'warning' : compile.success ? 'pass' : 'error',
        title: !compile
            ? uiText('当前配置尚无编译证据', 'No build evidence for current target')
            : !compileMatches
                ? uiText('已有编译结果不属于当前完整 FQBN', 'Build result belongs to a different target')
                : compile.success ? uiText('当前配置最近一次编译通过', 'Latest build passed for current target') : uiText('当前配置最近一次编译失败', 'Latest build failed for current target'),
        detail: !compile
            ? uiText('请在当前完整 FQBN 下成功编译一次。', 'Run one successful build under the current complete FQBN.')
            : !compileMatches
                ? uiText('记录没有同时绑定当前积木、源码、板卡包、完整 FQBN 与 Core。', 'Record is not bound to the current blocks, source, board package, complete FQBN, and Core.')
                : compile.summary,
        evidence: compileMatches && compile ? compile.recordedAt : null,
    });
    checks.push(resourceState(
        input.compileResourceReport,
        input,
        input.currentWorkspaceSha256,
        input.currentGeneratedCodeSha256,
        compileRunId,
    ));

    const version = input.lastWorkingVersion;
    const upload = input.uploadResult;
    const uploadMatches = upload && buildEvidenceMatchesCurrent(
        upload.projectBuildEvidence, input, input.currentWorkspaceSha256,
        input.currentGeneratedCodeSha256, upload.recordedAt,
    );
    const baselineFailure = uploadMatches ? sanitizeNote(upload.baselineFailure || undefined) : null;
    const versionMatches = baselineMatchesTarget(
        version,
        input.fqbn,
        input.boardPackageId,
        input.coreId,
        input.coreVersion,
        input.currentWorkspaceSha256,
        input.currentGeneratedCodeSha256,
    );
    if (capabilities.lastWorkingVersion) checks.push({
        id: 'last-working-version',
        state: versionMatches ? 'pass' : version || baselineFailure ? 'warning' : 'info',
        title: versionMatches ? uiText('当前配置存在上一个可用版本', 'Last Working Version available') : version ? uiText('可用版本属于其他配置', 'Last Working Version belongs to another target') : uiText('尚无可恢复的可用版本', 'No Last Working Version yet'),
        detail: versionMatches && version
            ? uiText(`最近验证于 ${version.verifiedAt}`, `Last verified at ${version.verifiedAt}`)
            : baselineFailure
                ? uiText(`上传已成功，但可用版本未保存：${baselineFailure}`, `Upload succeeded, but saving Last Working Version failed: ${baselineFailure}`)
            : version
                ? uiText(`记录目标为 ${version.environment.fqbn}，不会冒充当前配置。`, `Recorded for ${version.environment.fqbn}; not applied to the current target.`)
                : capabilities.deviceHealth
                    ? uiText('普通上传成功并通过产物、芯片和实体 Flash 核验后建立；仅编译不会建立可用版本。', 'Created after a normal upload passes artifact, chip, and physical Flash verification; compiling alone does not create one.')
                    : uiText('普通上传成功并通过固件产物核验后建立；仅编译不会建立可用版本。', 'Created after a normal upload passes firmware artifact verification; compiling alone does not create one.'),
        evidence: versionMatches && version ? version.id : null,
    });

    const dependencies = versionMatches && version ? version.lock.dependencies : [];
    const lockAvailable = Boolean(versionMatches && version && validSha256(version.lock.sha256));
    const allVersioned = lockAvailable
        && dependencies.every(item => Boolean(item.version) && validSha256(item.contentSha256));
    if (capabilities.dependencyLock) checks.push({
        id: 'dependency-lock',
        state: lockAvailable && allVersioned ? 'pass' : lockAvailable ? 'warning' : 'info',
        title: lockAvailable && allVersioned ? uiText('依赖已锁定', 'Dependencies locked') : lockAvailable ? uiText('依赖锁缺少可复核条目、版本或哈希', 'Dependency lock incomplete') : uiText('依赖尚未形成可信锁定', 'No trusted dependency lock yet'),
        detail: lockAvailable
            ? uiText(`${dependencies.length} 个依赖记录；${allVersioned ? '版本与内容哈希完整' : '存在不可精确复现项'}。`, `${dependencies.length} locked dependencies; ${allVersioned ? 'versions and content hashes complete' : 'some entries cannot be reproduced exactly'}.`)
            : uiText('建立上一个可用版本后，CK 才能保存 ck.lock 与依赖内容证据。', 'CK records ck.lock and dependency content evidence once a Last Working Version is created.'),
        evidence: lockAvailable && version ? version.lock.sha256 : null,
    });

    const rawDevice = input.deviceHealthReport;
    const rawDeviceTarget = String(
        rawDevice?.target.resolvedFqbn || rawDevice?.target.requestedFqbn || '',
    ).trim();
    const deviceTargetMatches = Boolean(rawDevice && rawDeviceTarget === input.fqbn.trim());
    const device = deviceTargetMatches ? rawDevice : null;
    const deviceErrors = device?.checks.some(item => item.state === 'error') ?? false;
    const deviceState: ProjectHealthState = rawDevice && !deviceTargetMatches
        ? 'warning'
        : !device
        ? 'info'
        : deviceErrors || device.outcome === 'failed'
            ? 'error'
            : device.outcome === 'complete'
                ? 'pass'
                : 'warning';
    if (capabilities.deviceHealth) checks.push({
        id: 'device-health',
        state: deviceState,
        title: rawDevice && !deviceTargetMatches
            ? uiText('已有真机体检属于其他完整 FQBN', 'Device check belongs to a different target')
            : !device
            ? uiText('真机尚未体检', 'Hardware not checked yet')
            : deviceState === 'pass'
                ? uiText('真机体检完成', 'Hardware check passed')
                : deviceState === 'error'
                    ? uiText('真机证据与当前目标不一致或存在错误', 'Hardware evidence mismatch or error')
                    : uiText('真机体检只有部分结果', 'Partial hardware check result'),
        detail: rawDevice && !deviceTargetMatches
            ? uiText(`记录目标为 ${rawDeviceTarget || '未绑定'}，当前目标为 ${input.fqbn}；该证据不会写入当前报告。`, `Recorded for ${rawDeviceTarget || 'unbound'}, current target is ${input.fqbn}; omitted from this report.`)
            : device
            ? `${device.device.chip || uiText('芯片未识别', 'Unidentified chip')} · ${device.outcome}`
            : uiText('未验证不等于失败，也不能标记为真机通过。', 'Unchecked does not mean failed, and is never marked as hardware-verified.'),
        evidence: device?.observedAt || null,
    });

    const pins = input.pinPreflightReport;
    if (pins?.status !== 'unsupported-board') checks.push({
        id: 'pin-preflight',
        state: !pins
            ? 'info'
            : pins.boardFqbn.trim() !== input.fqbn.trim()
                ? 'warning'
                : pins.canCompile ? (pins.warnings.length > 0 ? 'warning' : 'pass') : 'error',
        title: !pins
            ? uiText('引脚尚未检查', 'Pins not checked yet')
            : pins.boardFqbn.trim() !== input.fqbn.trim()
                    ? uiText('引脚检查属于其他完整 FQBN', 'Pin check belongs to a different target')
                : pins.canCompile ? (pins.warnings.length ? uiText('引脚检查存在提示', 'Pin check has notices') : uiText('引脚检查通过', 'Pin check passed')) : uiText('引脚检查存在阻止项', 'Pin check has blocking issues'),
        detail: pins
            ? uiText(`${pins.usages.length} 个占用，${pins.blockers.length} 个阻止项，${pins.warnings.length} 个警告。`, `${pins.usages.length} usages, ${pins.blockers.length} blockers, ${pins.warnings.length} warnings.`)
            : uiText('编译前会按当前板卡和积木资源声明检查。', 'Checked against board and block declarations before compiling.'),
        evidence: pins?.boardFqbn || null,
    });

    checks.push({
        id: 'project-checkpoints',
        state: input.checkpoints.length > 0 ? 'pass' : 'info',
        title: input.checkpoints.length > 0 ? uiText('存在工程检查点', 'Project checkpoints available') : uiText('尚无工程检查点', 'No project checkpoints yet'),
        detail: uiText(`${input.checkpoints.length} 个本地检查点；检查点数量不是修改次数。`, `${input.checkpoints.length} local checkpoints; checkpoint count is not an edit count.`),
        evidence: input.checkpoints[0]?.createdAt || null,
    });

    const counts: Record<ProjectHealthState, number> = { pass: 0, warning: 0, error: 0, info: 0 };
    checks.forEach(check => { counts[check.state] += 1; });
    const summary = counts.error > 0
        ? uiText(`${counts.error} 个确定问题，${counts.warning} 个警告`, `${counts.error} confirmed issues, ${counts.warning} warnings`)
        : counts.warning > 0
            ? uiText(`无确定错误，${counts.warning} 个警告`, `No confirmed errors, ${counts.warning} warnings`)
            : uiText('当前检查项未发现确定问题', 'No confirmed issues found in current checks');
    return { checks, counts, summary };
};

const hardwareState = (report: DeviceHealthReport | null): ProjectAcceptanceReport['hardware']['state'] => {
    if (!report) return 'not-checked';
    if (report.outcome === 'complete') return 'verified';
    if (report.outcome === 'partial') return 'partial';
    if (report.outcome === 'unsupported') return 'unsupported';
    return 'failed';
};

export const createProjectAcceptanceReport = async (
    input: CreateProjectAcceptanceReportInput,
    generatedAt = new Date().toISOString(),
): Promise<ProjectAcceptanceReport> => {
    const [workspaceSha256, generatedCodeSha256] = await Promise.all([
        sha256(input.workspaceJson),
        sha256(input.generatedCode),
    ]);
    const health = createProjectHealthChecklist({
        ...input,
        currentWorkspaceSha256: workspaceSha256,
        currentGeneratedCodeSha256: generatedCodeSha256,
        evidenceNow: generatedAt,
    });
    const capabilities = projectHealthCapabilities(input.fqbn);
    const matchingBaseline = baselineMatchesTarget(
        input.lastWorkingVersion,
        input.fqbn,
        input.boardPackageId,
        input.coreId,
        input.coreVersion,
        workspaceSha256,
        generatedCodeSha256,
    ) ? input.lastWorkingVersion : null;
    const dependencies = matchingBaseline?.lock.dependencies || [];
    const lockSha256 = matchingBaseline?.lock.sha256 || null;
    const rawCompile = input.compileDoctorReport;
    const compile = compileMatchesTarget(
        rawCompile,
        input,
        workspaceSha256,
        generatedCodeSha256,
    ) ? rawCompile : null;
    const compileRunId = buildEvidenceIdentity(compile)?.runId;
    const resources = resourcesMatchTarget(
        input.compileResourceReport,
        input,
        workspaceSha256,
        generatedCodeSha256,
        compileRunId,
    ) && compileRunId
        ? input.compileResourceReport
        : null;
    const rawDevice = input.deviceHealthReport;
    const rawDeviceTarget = String(
        rawDevice?.target.resolvedFqbn || rawDevice?.target.requestedFqbn || '',
    ).trim();
    const device = capabilities.deviceHealth && rawDevice && rawDeviceTarget === input.fqbn.trim() ? rawDevice : null;
    const checkpoints = [...input.checkpoints].sort((left, right) => (
        right.createdAt.localeCompare(left.createdAt)
    ));
    const buildState: ProjectAcceptanceReport['build']['state'] = compile
        ? (compile.success ? 'passed' : 'failed')
        : rawCompile ? 'unverified-target' : 'not-run';
    const warningEvidence = compile?.diagnostics?.resources;
    const warningCount = warningEvidence?.evidenceComplete === true
        && typeof warningEvidence.warningCount === 'number'
        && Number.isSafeInteger(warningEvidence.warningCount)
        && warningEvidence.warningCount >= 0
        ? warningEvidence.warningCount
        : null;

    return {
        schemaVersion: 1,
        kind: 'ck-project-acceptance-report',
        generatedAt,
        project: {
            name: input.projectName.trim() || '未命名工程',
            blockCount: Math.max(0, Math.floor(input.blockCount)),
            workspaceSha256,
            generatedCodeSha256,
            structure: summarizeWorkspaceStructure(input.workspaceJson),
            pathIncluded: false,
        },
        target: {
            savedConfiguration: input.savedConfiguration || null,
            boardName: input.boardName || input.boardId || '未选择',
            boardId: input.boardId,
            boardPackageId: input.boardPackageId,
            fqbn: input.fqbn,
            coreId: input.coreId,
            coreVersion: input.coreVersion || null,
        },
        build: {
            state: buildState,
            recordedAt: compile?.recordedAt || null,
            profile: compile?.profile || null,
            durationMs: compile ? compile.totalMs : null,
            warningCount,
            flashUsedBytes: resources?.flash?.usedBytes ?? null,
            flashTotalBytes: resources?.flash && resources.flash.capacityKnown !== false ? resources.flash.totalBytes : null,
            ramUsedBytes: resources?.ram?.usedBytes ?? null,
            ramTotalBytes: resources?.ram && resources.ram.capacityKnown !== false ? resources.ram.totalBytes : null,
            resourceGrowth: input.resourceGrowthEvidence === undefined
                ? explainCompileResourceGrowth(resources)
                : explainResourceGrowth(resources, input.resourceGrowthEvidence),
        },
        dependencies: {
            lockAvailable: Boolean(matchingBaseline && validSha256(lockSha256)),
            lockSha256: validSha256(lockSha256) ? lockSha256 : null,
            entries: dependencies.map(item => ({
                name: item.name,
                version: item.version,
                contentSha256: item.contentSha256,
            })),
            allVersioned: Boolean(matchingBaseline && validSha256(lockSha256))
                && dependencies.every(item => Boolean(item.version) && validSha256(item.contentSha256)),
        },
        hardware: {
            state: capabilities.deviceHealth ? hardwareState(device) : 'unsupported',
            observedAt: device?.observedAt || null,
            chip: device?.device.chip || null,
            revision: device?.device.revision || null,
            flashBytes: device?.memory.flashBytes ?? null,
            psramBytes: device?.memory.psramBytes ?? null,
            identityIncluded: false,
        },
        history: {
            checkpointCount: checkpoints.length,
            latestCheckpointAt: checkpoints[0]?.createdAt || null,
            modificationCount: null,
            note: uiText('CK 1.0 未启用逐操作审计历史；检查点数量不能解释为修改次数。', 'Per-action audit history is disabled; checkpoint count does not represent edit count.'),
        },
        notes: {
            circuitDescription: sanitizeNote(input.notes?.circuitDescription),
            testRecords: sanitizeNote(input.notes?.testRecords),
        },
        health,
        limitations: [
            uiText('编译通过不等同于物理外设功能已经验证。', 'A passing build does not verify physical peripheral behavior.'),
            ...(capabilities.deviceHealth ? [uiText('真机未体检时保持“未检查”，不会推断为通过或失败。', 'Hardware remains "not-checked" until inspected; it is never inferred as passed or failed.')] : []),
            uiText('资源来源只有在 linker/section 证据与总量完全一致时才会展示。', 'Resource attribution is shown only when linker/section evidence reconciles exactly with compiler totals.'),
            uiText('报告默认不包含工程路径、源码、完整 MAC 或串口内容。', 'Project paths, source code, full MAC addresses, and serial logs are excluded by default.'),
            uiText('修改次数未启用审计事件历史，因此保持未知。', 'Edit count remains unknown because per-action audit logging is not enabled.'),
            ...(capabilities.deviceHealth && rawDevice && !device
                ? [uiText(`已有真机体检属于其他完整 FQBN（${rawDeviceTarget || '未绑定'}），未纳入当前目标报告。`, `Existing hardware check belongs to another complete FQBN (${rawDeviceTarget || 'unbound'}) and was excluded.`)]
                : []),
        ],
    };
};

const escapeHtml = (value: unknown): string => String(value ?? '')
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
    .split("'").join('&#39;');

const bytes = (value: number | null): string => {
    if (value == null || !Number.isFinite(value)) return uiText('未报告', 'Not reported');
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
    return `${(value / 1024 ** 2).toFixed(2)} MiB`;
};

const stateLabelFor = (state: ProjectHealthState): string => {
    if (state === 'pass') return uiText('通过', 'Pass');
    if (state === 'warning') return uiText('警告', 'Warning');
    if (state === 'error') return uiText('问题', 'Issue');
    return uiText('未检查/提示', 'Info');
};

/** Standalone, printable and script-free HTML for local review or PDF printing. */
export const projectAcceptanceReportToHtml = (report: ProjectAcceptanceReport): string => {
    const en = isEnglishLocale();
    const checks = report.health.checks.map(check => {
        const stages = check.stages?.length
            ? `<div class="passport-stages">${check.stages.map(stage => `<div class="passport-stage"><span class="state ${escapeHtml(stage.state)}">${stateLabelFor(stage.state)}</span> <strong>${escapeHtml(stage.title)}</strong><br><small>${escapeHtml(stage.detail)}</small></div>`).join('')}</div>`
            : '';
        return `
        <tr><td><span class="state ${escapeHtml(check.state)}">${stateLabelFor(check.state)}</span></td><td><strong>${escapeHtml(check.title)}</strong><br><small>${escapeHtml(check.detail)}</small>${stages}</td><td><code>${escapeHtml(check.evidence || '—')}</code></td></tr>`;
    }).join('');
    const dependencies = report.dependencies.entries.length
        ? report.dependencies.entries.map(item => `<li>${escapeHtml(item.name)} @ ${escapeHtml(item.version || uiText('未标版本', 'Unversioned'))} <code>${escapeHtml(item.contentSha256.slice(0, 12))}…</code></li>`).join('')
        : `<li>${uiText('无已记录的第三方依赖', 'No recorded third-party dependencies')}</li>`;
    const limitations = report.limitations.map(item => `<li>${escapeHtml(item)}</li>`).join('');
    const structure = report.project.structure.available
        ? uiText(
            `${report.project.structure.topLevelFlowCount} 条顶层流程；${report.project.structure.blockTypes.map(item => `${escapeHtml(item.type)} × ${item.count}`).join('、') || '未识别积木类型'}`,
            `${report.project.structure.topLevelFlowCount} top-level flows; ${report.project.structure.blockTypes.map(item => `${escapeHtml(item.type)} × ${item.count}`).join(', ') || 'No recognized block types'}`,
        )
        : uiText('工作区结构不可解析，未生成软件结构摘要', 'Workspace structure could not be parsed; summary omitted');
    const projectNotes = report.notes.circuitDescription || report.notes.testRecords
        ? `<h2>${uiText('项目说明与测试记录', 'Project Notes & Test Records')}</h2>
<div class="grid"><div class="card"><div class="label">${uiText('电路说明', 'Circuit Notes')}</div><div>${escapeHtml(report.notes.circuitDescription || uiText('未填写', 'Not provided')).replace(/\r?\n/g, '<br>')}</div></div><div class="card"><div class="label">${uiText('测试记录', 'Test Records')}</div><div>${escapeHtml(report.notes.testRecords || uiText('未填写', 'Not provided')).replace(/\r?\n/g, '<br>')}</div></div></div>`
        : '';
    return `<!doctype html>
<html lang="${en ? 'en-US' : 'zh-CN'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(report.project.name)} - ${uiText('CK 项目验收报告', 'CK Project Acceptance Report')}</title>
<style>
body{font:14px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;color:#172033;max-width:980px;margin:32px auto;padding:0 24px;background:#fff}h1{margin-bottom:4px}h2{margin-top:28px;border-bottom:1px solid #dbe3ec;padding-bottom:6px}.meta{color:#64748b}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.card{border:1px solid #dbe3ec;border-radius:10px;padding:12px;overflow-wrap:anywhere}.label{font-size:11px;color:#64748b;text-transform:uppercase}.value{font-weight:700;margin-top:3px}table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #e5eaf0;padding:9px 6px}code{font:12px ui-monospace,monospace;overflow-wrap:anywhere}.state{display:inline-block;border-radius:999px;padding:1px 7px;font-size:12px}.pass{background:#dcfce7;color:#166534}.warning{background:#fef3c7;color:#92400e}.error{background:#fee2e2;color:#991b1b}.info{background:#e2e8f0;color:#475569}.passport-stages{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:8px}.passport-stage{border:1px solid #e5eaf0;border-radius:8px;padding:7px;overflow-wrap:anywhere}small{color:#64748b}@media(max-width:640px){.grid,.passport-stages{grid-template-columns:1fr}}@media print{body{margin:0;max-width:none}.card,.passport-stage{break-inside:avoid}h2{break-after:avoid}}
</style></head><body>
<h1>${uiText('CK 项目验收报告', 'CK Project Acceptance Report')}</h1><div class="meta">${uiText('生成时间：', 'Generated: ')}${escapeHtml(report.generatedAt)} · Schema v${report.schemaVersion}</div>
<p class="meta">${uiText('这是可打印 HTML：请在浏览器中打开后选择“打印 / 另存为 PDF”。CK 当前没有声称直接生成 PDF。', 'Printable HTML: open in a browser and choose Print / Save as PDF.')}</p>
<h2>${uiText('工程与目标', 'Project & Target')}</h2><div class="grid">
<div class="card"><div class="label">${uiText('工程', 'Project')}</div><div class="value">${escapeHtml(report.project.name)}</div><div>${uiText(`${report.project.blockCount} 个积木`, `${report.project.blockCount} blocks`)}</div></div>
<div class="card"><div class="label">${uiText('板卡', 'Board')}</div><div class="value">${escapeHtml(report.target.boardName)}</div><code>${escapeHtml(report.target.fqbn)}</code></div>
<div class="card"><div class="label">Core</div><div class="value">${escapeHtml(report.target.coreId)} @ ${escapeHtml(report.target.coreVersion || uiText('未识别', 'Unknown'))}</div></div>
${report.target.savedConfiguration ? `<div class="card"><div class="label">${uiText('工程保存的配置', 'Saved Project Configuration')}</div><div class="value">${escapeHtml(report.target.savedConfiguration.coreId)} @ ${escapeHtml(report.target.savedConfiguration.coreVersion || uiText('未记录', 'Not recorded'))}</div><code>${escapeHtml(report.target.savedConfiguration.fqbn)}</code><div>${report.target.savedConfiguration.optionsComplete ? uiText('已记录全部有效选项（含默认值）', 'All effective options recorded (including defaults)') : uiText('选项目录尚未完整记录', 'Option list not completely recorded')}</div><small>${uiText('环境记录不等于依赖锁；导入不会自动安装 Core 或工具链。', 'Recorded target is not a dependency lock; opening does not auto-install Cores or toolchains.')}</small></div>` : ''}
<div class="card"><div class="label">${uiText('编译', 'Build')}</div><div class="value">${escapeHtml(report.build.state)}</div><div>${escapeHtml(report.build.recordedAt || uiText('尚无证据', 'No evidence yet'))}</div></div>
</div>
<h2>${uiText('软件结构摘要', 'Software Structure Summary')}</h2><p>${structure}</p><p class="meta">${uiText('积木截图未自动生成，避免依赖不稳定的 Blockly 私有接口。', 'Block screenshots are not auto-generated.')}</p>
<h2>${uiText('资源证据', 'Resource Evidence')}</h2><div class="grid">
<div class="card"><div class="label">${uiText('程序空间', 'Program Space')}</div><div class="value">${bytes(report.build.flashUsedBytes)} / ${bytes(report.build.flashTotalBytes)}</div></div>
<div class="card"><div class="label">${uiText('内部 RAM', 'Internal RAM')}</div><div class="value">${bytes(report.build.ramUsedBytes)} / ${bytes(report.build.ramTotalBytes)}</div></div>
<div class="card"><div class="label">${uiText('增长解释', 'Resource Growth')}</div><div class="value">${escapeHtml(report.build.resourceGrowth.summary)}</div><small>${escapeHtml(report.build.resourceGrowth.detail)}</small></div>
${report.hardware.state !== 'unsupported' ? `<div class="card"><div class="label">${uiText('真机', 'Hardware')}</div><div class="value">${escapeHtml(report.hardware.state)}</div><div>${escapeHtml(report.hardware.chip || uiText('未识别', 'Unknown'))} · Flash ${bytes(report.hardware.flashBytes)}${report.hardware.psramBytes != null ? ` · PSRAM ${bytes(report.hardware.psramBytes)}` : ''}</div></div>` : ''}
</div>
<h2>${uiText('工程健康检查', 'Project Health Checks')}</h2><p>${escapeHtml(report.health.summary)}${uiText('。本报告不计算综合分数。', '. No composite score is computed.')}</p><table><thead><tr><th>${uiText('状态', 'Status')}</th><th>${uiText('检查项', 'Check')}</th><th>${uiText('证据', 'Evidence')}</th></tr></thead><tbody>${checks}</tbody></table>
${projectHealthCapabilities(report.target.fqbn).dependencyLock ? `<h2>${uiText('依赖锁', 'Dependency Lock')}</h2><p>${report.dependencies.lockAvailable ? uiText('已找到内容哈希绑定的 ck.lock。', 'Found content-hashed ck.lock.') : uiText('尚无可信 ck.lock。', 'No trusted ck.lock yet.')}</p><ul>${dependencies}</ul>` : ''}
${projectNotes}
<h2>${uiText('历史与边界', 'History & Scope')}</h2><p>${uiText(`本地工程检查点：${report.history.checkpointCount}；修改次数：未启用审计，不能推断。`, `Local checkpoints: ${report.history.checkpointCount}; edit count: audit logging disabled.`)}</p><ul>${limitations}</ul>
<hr><div class="meta">workspace SHA-256: <code>${report.project.workspaceSha256}</code><br>generated code SHA-256: <code>${report.project.generatedCodeSha256}</code></div>
</body></html>`;
};
