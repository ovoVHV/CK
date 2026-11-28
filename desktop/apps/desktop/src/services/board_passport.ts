import type {
    ArduinoCoreConfig,
    BoardPackage,
    BoardPassport,
    BoardPassportCheck,
    BoardPassportLock,
} from '../types/board';
const uiText = (zh: string, en: string): string => {
    try {
        const lang = typeof document !== 'undefined' ? document.documentElement?.lang : '';
        const stored = typeof window !== 'undefined' ? window.localStorage?.getItem('ck.i18n.uiLocale') : '';
        return /^en(?:-|$)/i.test(String(lang || stored || '')) ? en : zh;
    } catch { return zh; }
};

export type PassportStageStatus = 'passed' | 'warning' | 'failed' | 'pending';
export type PassportStageId = 'structure' | 'environment' | 'compile' | 'device';

export interface PassportStageView {
    id: PassportStageId;
    label: string;
    status: PassportStageStatus;
    summary: string;
    detail?: string;
}

export interface BoardPassportView {
    stages: PassportStageView[];
    canCreateProject: boolean;
    blockedReason?: string;
    needsLocalCertification: boolean;
    installedCoreVersion?: string;
    recommendedCoreVersion?: string;
    lockSummary?: string;
    actions: string[];
}

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | undefined => (
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as UnknownRecord
        : undefined
);

const firstText = (...values: unknown[]): string | undefined => {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
};

const statusTokenFrom = (value: unknown): string => {
    const record = asRecord(value);
    return String(record?.status ?? record?.state ?? record?.compatibility ?? record?.result ?? value ?? '').trim().toLowerCase();
};

const CORE_ENVIRONMENT_BLOCK_TOKENS = new Set([
    'missing',
    'core_missing',
    'below_minimum',
    'known_incompatible',
]);

const CORE_NON_BLOCKING_VERSION_WARNING_TOKENS = new Set([
    'compatible',
    'compatible_untested',
    'incompatible',
    'tested_non_recommended',
    'revalidation_required',
    'needs_validation',
    'needs_revalidation',
    'requires_revalidation',
    'unverified',
    'unverified_compatibility',
    'newer_unverified',
    'newer_untested',
    'above_tested_range',
    'above_maximum',
    'outside_compatible_range',
    'invalid_requirement',
    'unparseable_installed_version',
]);

const coreStatusTokensFrom = (value: unknown): string[] => {
    if (typeof value === 'string') {
        const token = value.trim().toLowerCase();
        return token ? [token] : [];
    }
    const record = asRecord(value);
    if (!record) return [];
    const tokens = [
        record.compatibility,
        record.code,
        record.status,
        record.state,
        record.result,
    ].flatMap(candidate => {
        if (typeof candidate !== 'string') return [];
        const token = candidate.trim().toLowerCase();
        return token ? [token] : [];
    });
    return [...new Set(tokens)];
};

const coreStatusTokenFrom = (value: unknown): string => {
    return coreStatusTokensFrom(value)[0] || '';
};

/**
 * A missing core is an unavailable environment rather than a version-policy
 * rejection.  For installed versions, only the declared minimum and known
 * incompatibility selectors are allowed to block use.
 */
export const coreEnvironmentBlocksUse = (value: unknown): boolean => (
    coreStatusTokensFrom(value).some(token => CORE_ENVIRONMENT_BLOCK_TOKENS.has(token))
);

const hasExplicitNonBlockingCoreVersionWarning = (value: unknown): boolean => (
    coreStatusTokensFrom(value).some(token => CORE_NON_BLOCKING_VERSION_WARNING_TOKENS.has(token))
);

const statusFrom = (value: unknown): PassportStageStatus | undefined => {
    if (typeof value === 'boolean') return value ? 'passed' : 'failed';
    const record = asRecord(value);
    const raw = statusTokenFrom(value);
    if (raw && raw !== '[object object]') {
        if (['passed', 'pass', 'ready', 'verified', 'valid', 'recommended', 'tested', 'tested_compatible', 'success', 'ok'].includes(raw)) {
            return 'passed';
        }
        if (['warning', 'warn', 'stale', 'expired', 'compatible', 'compatible_untested', 'incompatible', 'tested_non_recommended', 'newer_untested', 'needs_validation', 'needs_revalidation', 'requires_revalidation', 'revalidation_required', 'unverified', 'unverified_compatibility', 'newer_unverified', 'above_tested_range', 'above_maximum', 'outside_compatible_range', 'invalid_requirement', 'unparseable_installed_version'].includes(raw)) {
            return 'warning';
        }
        if (['failed', 'fail', 'error', 'blocked', 'known_incompatible', 'below_minimum', 'core_missing', 'unavailable', 'invalid'].includes(raw)) {
            return 'failed';
        }
        if (['pending', 'not_run', 'not_verified', 'unknown', 'waiting', 'missing'].includes(raw)) {
            return 'pending';
        }
    }
    // Explicit states above take precedence.  A legacy `compatible: true`
    // flag must not turn an explicit warning such as tested_non_recommended
    // green.
    if (typeof record?.compatible === 'boolean') return record.compatible ? 'passed' : 'failed';
    return undefined;
};

const messageFrom = (value: unknown): string | undefined => {
    const record = asRecord(value);
    return firstText(record?.message, record?.reason, record?.detail, record?.summary);
};

const passportValue = (
    passport: BoardPassport | undefined,
    ...keys: string[]
): unknown => {
    const record = asRecord(passport);
    if (!record) return undefined;
    for (const key of keys) {
        if (record[key] !== undefined && record[key] !== null) return record[key];
        const statusKey = `${key}_status`;
        if (record[statusKey] !== undefined && record[statusKey] !== null) {
            return { status: record[statusKey], message: record[`${key}_message`] };
        }
    }
    return undefined;
};

const actualProfileStatus = (value: unknown, core: unknown): PassportStageStatus | undefined => {
    const raw = String(value || '').trim().toLowerCase();
    if (['compile_passed', 'device_verified'].includes(raw)) return 'passed';
    if (raw === 'blocked_core') return coreEnvironmentBlocksUse(core) ? 'failed' : 'warning';
    if (raw === 'failed') return 'failed';
    if (['revalidation_required', 'pending_core_revalidation', 'expired'].includes(raw)) return 'warning';
    if (['pending_compile', 'pending', 'not_run'].includes(raw)) return 'pending';
    return statusFrom(raw);
};

const compileCheckFromPassport = (passport: BoardPassport | undefined): BoardPassportCheck | undefined => {
    if (!passport) return undefined;
    const profiles = Array.isArray(passport.profiles) ? passport.profiles : [];
    const certification = String(passport.certification_status || '').trim().toLowerCase();
    const statuses = profiles.map(profile => actualProfileStatus(profile?.status, passport.core)).filter(Boolean) as PassportStageStatus[];
    const passed = statuses.filter(status => status === 'passed').length;
    const warned = statuses.filter(status => status === 'warning').length;
    const failed = statuses.filter(status => status === 'failed').length;
    if (failed > 0 || certification === 'failed') {
        return { status: 'failed', message: uiText(`${failed || 1} 个声明配置编译验证失败`, `${failed || 1} declared profile(s) failed compile verification`) };
    }
    if (profiles.length > 0 && passed === profiles.length) {
        return { status: 'passed', message: uiText(`${passed} 个声明配置已通过本机编译`, `${passed} declared profile(s) passed local compile`) };
    }
    if (certification === 'compile_certified' || certification === 'device_verified') {
        return { status: 'passed', message: uiText('本机声明配置编译通过', 'Local compile verification passed') };
    }
    if (passed > 0 || ['partially_certified', 'revalidation_required', 'expired'].includes(certification)) {
        return {
            status: 'warning',
            message: passed > 0 ? uiText(`${passed}/${profiles.length} 个声明配置已通过，仍需复验`, `${passed}/${profiles.length} profiles passed; revalidation required`) : uiText('缓存凭证已过期，需要重新编译认证', 'Cached certificate expired; re-compilation required'),
        };
    }
    if (certification === 'blocked_core') {
        return coreEnvironmentBlocksUse(passport.core)
            ? { status: 'failed', message: passport.core?.message || uiText('核心环境阻止本机编译认证', 'Core environment blocks local compile verification') }
            : { status: 'warning', message: passport.core?.message || uiText('核心状态需要复验，仍可继续自动认证', 'Core status needs revalidation; auto-verification can continue') };
    }
    if (warned > 0) {
        return { status: 'warning', message: uiText(`${warned}/${profiles.length} 个声明配置需要重新编译认证`, `${warned}/${profiles.length} profile(s) require compile revalidation`) };
    }
    return profiles.length > 0
        ? { status: 'pending', message: uiText(`${profiles.length} 个声明配置等待本机编译认证`, `${profiles.length} profile(s) pending local compile verification`) }
        : undefined;
};

const deviceCheckFromPassport = (passport: BoardPassport | undefined): BoardPassportCheck | undefined => {
    const profiles = Array.isArray(passport?.profiles) ? passport.profiles : [];
    if (profiles.length === 0) return undefined;
    const verified = profiles.filter(profile => profile?.status === 'device_verified').length;
    if (verified === profiles.length) return { status: 'passed', message: uiText(`${verified} 个配置档案已真机验证`, `${verified} profile(s) verified on hardware`) };
    if (verified > 0) return { status: 'warning', message: uiText(`${verified}/${profiles.length} 个配置档案已真机验证`, `${verified}/${profiles.length} profiles verified on hardware`) };
    return { status: 'pending', message: uiText(`${profiles.length} 个配置档案尚待真机样板验证`, `${profiles.length} profile(s) pending physical board verification`) };
};

const normalizeVersion = (value: string | undefined): number[] | undefined => {
    if (!value) return undefined;
    const match = value.trim().match(/^(?:v)?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i);
    if (!match) return undefined;
    return [Number(match[1] || 0), Number(match[2] || 0), Number(match[3] || 0)];
};

/** Compare the numeric SemVer core; prerelease/build suffixes remain compatible. */
export const compareCoreVersions = (left: string, right: string): number | undefined => {
    const a = normalizeVersion(left);
    const b = normalizeVersion(right);
    if (!a || !b) return undefined;
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        const delta = (a[i] || 0) - (b[i] || 0);
        if (delta !== 0) return delta < 0 ? -1 : 1;
    }
    return 0;
};

const coreVersionsMatch = (left: string, right: string): boolean => (
    left.trim() === right.trim() || compareCoreVersions(left, right) === 0
);

const normalizedList = (value: unknown): string[] => (
    Array.isArray(value)
        ? value.map(item => String(item || '').trim()).filter(Boolean)
        : []
);

const corePolicy = (core: ArduinoCoreConfig | undefined) => {
    const raw = asRecord(core);
    const range = asRecord(core?.version_range ?? raw?.versionRange);
    const recommended = firstText(
        core?.recommended_version,
        raw?.recommendedVersion,
        core?.version,
    );
    const minimum = firstText(core?.min_version, raw?.minVersion, raw?.minimum_version, range?.minimum, range?.min);
    const maximumExclusive = firstText(
        range?.maximum_exclusive,
        range?.maximumExclusive,
        core?.max_tested_version,
        raw?.maxTestedVersion,
    );
    const compatible = normalizedList(
        core?.compatible_versions ?? raw?.compatibleVersions ?? raw?.compatible,
    );
    const tested = normalizedList(core?.tested_versions ?? raw?.testedVersions);
    const incompatible = normalizedList(
        core?.known_incompatible_versions ?? raw?.knownIncompatibleVersions ?? raw?.incompatible_versions,
    );
    const knownIncompatible = Array.isArray(core?.known_incompatible ?? raw?.knownIncompatible)
        ? (core?.known_incompatible ?? raw?.knownIncompatible) as unknown[]
        : [];
    return {
        recommended,
        minimum,
        maximumExclusive,
        hasVersionRange: !!range,
        compatible,
        tested,
        incompatible,
        knownIncompatible,
    };
};

const versionInsideRange = (
    version: string,
    minimum?: string,
    maximumExclusive?: string,
): boolean => {
    if (minimum) {
        const comparison = compareCoreVersions(version, minimum);
        if (comparison === undefined || comparison === -1) return false;
    }
    if (maximumExclusive) {
        const comparison = compareCoreVersions(version, maximumExclusive);
        if (comparison === undefined || comparison !== -1) return false;
    }
    return true;
};

const knownIncompatibilityReason = (
    policy: ReturnType<typeof corePolicy>,
    version: string,
): string | undefined => {
    if (policy.incompatible.some(declared => coreVersionsMatch(declared, version))) {
        return uiText(`核心 ${version} 已知不兼容`, `Core ${version} is known incompatible`);
    }
    for (const entry of policy.knownIncompatible) {
        if (typeof entry === 'string') {
            if (coreVersionsMatch(entry, version)) return uiText(`核心 ${version} 已知不兼容`, `Core ${version} is known incompatible`);
            continue;
        }
        const record = asRecord(entry);
        if (!record) continue;
        const exact = firstText(record.version);
        const range = asRecord(record.version_range ?? record.versionRange);
        const matches = (!!exact && coreVersionsMatch(exact, version)) || (!!range && versionInsideRange(
            version,
            firstText(range.minimum, range.min),
            firstText(range.maximum_exclusive, range.maximumExclusive),
        ));
        if (matches) return firstText(record.reason, record.message) || uiText(`核心 ${version} 已知不兼容`, `Core ${version} is known incompatible`);
    }
    return undefined;
};

const stage = (
    id: PassportStageId,
    label: string,
    status: PassportStageStatus,
    summary: string,
    detail?: string,
): PassportStageView => ({ id, label, status, summary, detail });

const actionsFrom = (...values: unknown[]): string[] => {
    const output: string[] = [];
    for (const value of values) {
        const record = asRecord(value);
        const entries = Array.isArray(value) ? value : Array.isArray(record?.actions) ? record.actions : [];
        for (const entry of entries) {
            if (typeof entry === 'string' && entry.trim()) output.push(entry.trim());
            const action = asRecord(entry);
            const label = firstText(action?.label, action?.message, action?.action);
            if (label) output.push(label);
        }
    }
    return [...new Set(output)];
};

const lockFrom = (board: BoardPackage): BoardPassportLock | undefined => (
    board.passport?.ck_lock
    ?? board.passport?.lock
    ?? board.ck_lock
    ?? asRecord(board.passport)?.ckLock as BoardPassportLock | undefined
);

const fqbnLooksUsable = (fqbn: string): boolean => (
    /^[A-Za-z0-9][A-Za-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9_-]*$/.test(fqbn)
);

export const resolveBoardPassport = (
    board: BoardPackage,
    installedCoreVersions: Record<string, string>,
    options: { coreListLoading?: boolean } = {},
): BoardPassportView => {
    const passport = board.passport;
    const structureRaw = passportValue(passport, 'structure', 'structure_check', 'quality');
    const environmentRaw = passportValue(passport, 'environment', 'environment_ready', 'core');
    const compileRaw = passportValue(passport, 'compile', 'local_compile', 'local_compilation')
        ?? compileCheckFromPassport(passport);
    const deviceRaw = passportValue(passport, 'device', 'device_verification', 'hardware')
        ?? deviceCheckFromPassport(passport);

    const structureLabel = uiText('结构检查', 'Structure');
    const environmentLabel = uiText('环境就绪', 'Environment');
    const compileLabel = uiText('本机可编译', 'Local Compile');

    let structure: PassportStageView;
    const structureOverride = statusFrom(structureRaw);
    if (structureOverride) {
        structure = stage(
            'structure',
            structureLabel,
            structureOverride,
            messageFrom(structureRaw) || (structureOverride === 'passed' ? uiText('目录与清单结构有效', 'Directory and manifest structure valid') : uiText('查看结构检查报告', 'Review structure check report')),
        );
    } else if (!board.is_custom) {
        structure = stage('structure', structureLabel, 'passed', uiText('CK 内置板卡目录', 'Built-in CK board catalog'));
    } else if (board.quality_report?.status === 'passed' || board.quality_report?.status === 'passed_with_warnings') {
        const warnings = board.quality_report.warning_count || 0;
        structure = stage(
            'structure',
            structureLabel,
            warnings > 0 ? 'warning' : 'passed',
            warnings > 0 ? uiText(`结构通过，${warnings} 项提示`, `Structure passed (${warnings} warnings)`) : uiText('结构检查通过', 'Structure check passed'),
        );
    } else if (board.quality_report?.status === 'failed') {
        structure = stage('structure', structureLabel, 'failed', uiText('包结构检查失败', 'Package structure check failed'));
    } else {
        structure = stage('structure', structureLabel, 'pending', uiText('尚无结构检查报告', 'No structure report yet'));
    }

    const core = board.arduino_core;
    const coreId = String(core?.package || '').trim();
    const installedVersion = firstText(
        asRecord(board.core_status)?.installed_version,
        asRecord(board.core_status)?.installedVersion,
        passport?.core?.installed_version,
        coreId ? installedCoreVersions[coreId] : undefined,
    );
    const policy = corePolicy(core);
    const incompatibilityReason = installedVersion
        ? knownIncompatibilityReason(policy, installedVersion)
        : undefined;
    const recommendedMatches = !!installedVersion
        && !!policy.recommended
        && coreVersionsMatch(installedVersion, policy.recommended);
    const testedMatches = !!installedVersion
        && policy.tested.some(version => coreVersionsMatch(installedVersion, version));
    let environment: PassportStageView;
    const environmentReport = asRecord(board.core_status ?? environmentRaw);
    const environmentOverride = statusFrom(board.core_status)
        ?? statusFrom(environmentRaw)
        ?? (environmentReport?.requires_revalidation === true
            ? 'warning'
            : environmentReport?.usable === false
                ? 'failed'
                : environmentReport?.usable === true
                    ? 'passed'
                    : undefined);
    const environmentToken = coreStatusTokenFrom(board.core_status ?? environmentRaw);
    const environmentMessage = messageFrom(board.core_status) ?? messageFrom(environmentRaw);

    if (!fqbnLooksUsable(board.fqbn_base || board.fqbn)) {
        environment = stage('environment', environmentLabel, 'failed', uiText('缺少真实 FQBN', 'Missing valid FQBN'));
    } else if (!coreId) {
        environment = board.is_custom
            ? stage('environment', environmentLabel, 'failed', uiText('板卡包未声明 Arduino 核心', 'Board package does not declare an Arduino core'))
            : stage('environment', environmentLabel, 'pending', uiText('等待识别核心依赖', 'Waiting to identify core dependency'));
    } else if (options.coreListLoading) {
        environment = stage('environment', environmentLabel, 'pending', uiText('正在检查核心环境', 'Checking core environment'));
    } else if (!installedVersion) {
        environment = stage('environment', environmentLabel, 'failed', uiText(`缺少核心 ${coreId}`, `Missing core ${coreId}`));
    } else if (coreEnvironmentBlocksUse(board.core_status ?? environmentRaw)) {
        environment = stage('environment', environmentLabel, 'failed', environmentMessage || uiText('当前核心明确不兼容', 'Installed core is incompatible'));
    } else if (incompatibilityReason) {
        environment = stage('environment', environmentLabel, 'failed', incompatibilityReason);
    } else if (policy.minimum && compareCoreVersions(installedVersion, policy.minimum) === -1) {
        environment = stage('environment', environmentLabel, 'failed', uiText(`核心 ${installedVersion} 低于最低 ${policy.minimum}`, `Core ${installedVersion} is below minimum ${policy.minimum}`));
    } else if (environmentOverride === 'failed') {
        environment = stage('environment', environmentLabel, 'warning', environmentMessage || uiText(`核心 ${installedVersion} 需要自动复验`, `Core ${installedVersion} needs automatic revalidation`));
    } else if (environmentOverride === 'warning') {
        environment = stage('environment', environmentLabel, 'warning', environmentMessage || uiText(`核心 ${installedVersion} 需复验`, `Core ${installedVersion} needs revalidation`));
    } else if (environmentOverride === 'passed') {
        if (board.is_custom && policy.recommended && !recommendedMatches) {
            environment = stage(
                'environment',
                environmentLabel,
                'warning',
                uiText(`核心 ${installedVersion} 可用但不是推荐版本，需自动复验`, `Core ${installedVersion} works but is not the recommended version; revalidation needed`),
                uiText(`推荐版本 ${policy.recommended}`, `Recommended ${policy.recommended}`),
            );
        } else if (board.is_custom && !policy.recommended && environmentToken !== 'tested_compatible' && !testedMatches) {
            environment = stage(
                'environment',
                environmentLabel,
                'warning',
                uiText(`核心 ${installedVersion} 可用性尚未由推荐或实测声明确认，需自动复验`, `Core ${installedVersion} is not yet declared recommended or tested; revalidation needed`),
                environmentMessage,
            );
        } else {
            environment = stage('environment', environmentLabel, 'passed', environmentMessage || uiText(`核心 ${installedVersion} 可用`, `Core ${installedVersion} ready`));
        }
    } else if (recommendedMatches) {
        environment = stage('environment', environmentLabel, 'passed', uiText(`推荐核心 ${installedVersion}`, `Recommended core ${installedVersion}`));
    } else if (testedMatches) {
        environment = policy.recommended
            ? stage(
                'environment',
                environmentLabel,
                'warning',
                uiText(`已测试核心 ${installedVersion} 不是推荐版本，需自动复验`, `Tested core ${installedVersion} is not the recommended version; revalidation needed`),
                uiText(`推荐版本 ${policy.recommended}`, `Recommended ${policy.recommended}`),
            )
            : stage('environment', environmentLabel, 'passed', uiText(`已测试兼容核心 ${installedVersion}`, `Tested compatible core ${installedVersion}`));
    } else if (policy.compatible.includes(installedVersion)) {
        environment = stage('environment', environmentLabel, 'warning', uiText(`声明兼容核心 ${installedVersion}，仍需自动复验`, `Declared compatible core ${installedVersion}; revalidation needed`));
    } else if (policy.maximumExclusive && compareCoreVersions(installedVersion, policy.maximumExclusive) !== -1) {
        environment = stage(
            'environment',
            environmentLabel,
            'warning',
            uiText(`核心 ${installedVersion} 超出已测试上界，需自动复验`, `Core ${installedVersion} is newer than tested range; revalidation needed`),
            uiText(`已测试版本应低于 ${policy.maximumExclusive}；不会强制降级`, `Tested below ${policy.maximumExclusive}; downgrade is not forced`),
        );
    } else if (policy.hasVersionRange && versionInsideRange(
        installedVersion,
        policy.minimum,
        policy.maximumExclusive,
    )) {
        environment = stage('environment', environmentLabel, 'warning', uiText(`兼容范围内核心 ${installedVersion} 尚未实测，需自动复验`, `Core ${installedVersion} is within range but untested; revalidation needed`));
    } else if (policy.recommended) {
        const relation = compareCoreVersions(installedVersion, policy.recommended);
        environment = stage(
            'environment',
            environmentLabel,
            'warning',
            relation === 1
                ? uiText(`较新核心 ${installedVersion}，需自动复验`, `Newer core ${installedVersion}; revalidation needed`)
                : uiText(`核心 ${installedVersion} 尚未验证`, `Core ${installedVersion} not yet verified`),
            uiText(`推荐版本 ${policy.recommended}`, `Recommended ${policy.recommended}`),
        );
    } else {
        environment = board.is_custom
            ? stage('environment', environmentLabel, 'warning', uiText(`核心 ${installedVersion} 尚无推荐或实测声明，需自动复验`, `Core ${installedVersion} has no tested declaration; revalidation needed`))
            : stage('environment', environmentLabel, 'passed', uiText(`核心 ${installedVersion} 已安装`, `Core ${installedVersion} installed`));
    }

    const compileStatus = statusFrom(compileRaw);
    let compile: PassportStageView;
    if (compileStatus) {
        compile = stage(
            'compile',
            compileLabel,
            compileStatus,
            messageFrom(compileRaw) || (compileStatus === 'passed' ? uiText('自动编译认证通过', 'Auto compile verification passed') : uiText('自动编译认证待处理', 'Auto compile verification pending')),
        );
    } else {
        compile = stage('compile', compileLabel, 'pending', uiText('待本机自动编译认证', 'Pending local auto compile verification'));
    }

    const deviceStatus = statusFrom(deviceRaw);
    const device = deviceStatus === 'passed'
        ? stage('device', uiText('真机已验', 'Hardware Verified'), 'passed', messageFrom(deviceRaw) || uiText('真机样板验证通过', 'Physical board verification passed'))
        : stage(
            'device',
            uiText('真机待验证', 'Hardware Pending'),
            deviceStatus === 'failed' ? 'failed' : deviceStatus === 'warning' ? 'warning' : 'pending',
            messageFrom(deviceRaw) || uiText('不影响离线编译认证', 'Does not block offline compile verification'),
        );

    const lock = lockFrom(board);
    const actualCertification = String(passport?.certification_status || '').trim().toLowerCase();
    const invalidatedReasons = Array.isArray(passport?.invalidated_reasons) ? passport.invalidated_reasons : [];
    const lockStatus = statusFrom(lock)
        ?? (invalidatedReasons.length > 0 || ['expired', 'revalidation_required'].includes(actualCertification)
            ? 'warning'
            : ['compile_certified', 'device_verified'].includes(actualCertification)
                ? 'passed'
                : passport
                    ? 'pending'
                    : undefined);
    const verifiedProfileCoreVersion = Array.isArray(passport?.profiles)
        ? passport.profiles.map(profile => profile?.core_version).find(value => typeof value === 'string' && value.trim())
        : undefined;
    const lockVersion = firstText(
        lock?.verified_core_version,
        asRecord(lock)?.verifiedCoreVersion,
        lock?.core_version,
        verifiedProfileCoreVersion,
        passport?.core?.installed_version,
    );
    let lockSummary: string | undefined;
    if (lockStatus === 'passed') {
        lockSummary = uiText(`ck.lock 有效${lockVersion ? ` · 已验核心 ${lockVersion}` : ''}`, `ck.lock valid${lockVersion ? ` · Verified core ${lockVersion}` : ''}`);
    } else if (lockStatus === 'warning' || lockStatus === 'failed') {
        lockSummary = uiText(`ck.lock 已过期${lockVersion ? ` · 上次验证核心 ${lockVersion}` : ''}`, `ck.lock expired${lockVersion ? ` · Last verified core ${lockVersion}` : ''}`);
    } else if (lock || passport) {
        lockSummary = uiText(`ck.lock 待认证${lockVersion ? ` · 当前核心 ${lockVersion}` : ''}`, `ck.lock pending${lockVersion ? ` · Current core ${lockVersion}` : ''}`);
    }

    const explicitUsable = board.usable ?? passport?.usable ?? passport?.can_create_project;
    const explicitReason = firstText(
        board.availability_error,
        passport?.blocked_reason,
        asRecord(passport)?.blockedReason,
    );
    const blockedStage = [structure, environment, compile].find(item => item.status === 'failed');
    const missingStructureGate = board.is_custom && structure.status === 'pending';
    const environmentLoadingGate = options.coreListLoading === true;
    // Older backends sometimes returned usable=false for a non-recommended
    // core.  Ignore that legacy boolean only when the core report explicitly
    // identifies a non-blocking version warning.  A current backend reporting
    // core usable=true while the board remains unusable points to a different
    // gate (for example an invalid passport) and must stay blocked.
    const explicitCoreWarning = hasExplicitNonBlockingCoreVersionWarning(board.core_status ?? environmentRaw);
    const staleBlockedCorePassport = actualCertification === 'blocked_core'
        && passport?.core?.usable === true;
    const legacyCoreWarningCanOverrideUsableFalse = explicitUsable === false
        && !explicitReason
        && environment.status === 'warning'
        && explicitCoreWarning
        && (environmentReport?.usable === false || staleBlockedCorePassport);
    const explicitUnavailableGate = explicitUsable === false && !legacyCoreWarningCanOverrideUsableFalse;
    const canCreateProject = !explicitUnavailableGate && !blockedStage && !missingStructureGate && !environmentLoadingGate;
    const blockedReason = canCreateProject
        ? undefined
        : explicitReason
            || blockedStage?.summary
            || (missingStructureGate
                ? uiText('第三方板卡必须先完成结构检查', 'Third-party boards must pass structure checks first')
                : environmentLoadingGate
                    ? uiText('正在检查核心环境，请稍候', 'Checking core environment, please wait')
                    : uiText('当前板卡暂不可用', 'This board is currently unavailable'));

    return {
        stages: [structure, environment, compile, device],
        canCreateProject,
        blockedReason,
        needsLocalCertification: environment.status === 'warning' || compile.status !== 'passed' || lockStatus === 'warning' || lockStatus === 'failed',
        installedCoreVersion: installedVersion,
        recommendedCoreVersion: policy.recommended,
        lockSummary,
        actions: actionsFrom(passport?.actions, structureRaw, environmentRaw, compileRaw, deviceRaw),
    };
};

export const passportStageTone = (status: PassportStageStatus): string => {
    switch (status) {
        case 'passed': return 'emerald';
        case 'warning': return 'amber';
        case 'failed': return 'rose';
        default: return 'slate';
    }
};
