import bundledQualifications from '../../src-tauri/src/ck_forge_bundled_qualifications.v1.json';

export type ForgeCoreSupportStatus =
    | 'certified-evidence-available'
    | 'local-certification-required'
    | 'safe-fallback';

export interface ForgeCoreSupportView {
    status: ForgeCoreSupportStatus;
    label: string;
    detail: string;
    currentCoreVersion?: string;
    certifiedCoreVersions: string[];
    platformCertifiedCoreVersions: string[];
}

interface BundledQualificationEntry {
    fqbn: string;
    coreVersion: string;
}

const entries = bundledQualifications.entries as BundledQualificationEntry[];

const fqbnBase = (fqbn: string): string => fqbn.trim().split(':').slice(0, 3).join(':');
const fqbnPlatform = (fqbn: string): string => fqbn.trim().split(':').slice(0, 2).join(':');
const defaultCompleteFqbn = (fqbn: string): string => {
    const normalized = fqbn.trim();
    if (normalized.split(':').length > 3) return normalized;
    const defaults: Record<string, string> = {
        'arduino:avr:diecimila': 'arduino:avr:diecimila:cpu=atmega328',
        'arduino:avr:mega': 'arduino:avr:mega:cpu=atmega2560',
        'arduino:avr:nano': 'arduino:avr:nano:cpu=atmega328',
    };
    return defaults[normalized] || normalized;
};

const sortedVersions = (values: string[]): string[] => [...new Set(
    values.map(value => value.trim()).filter(Boolean),
)].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

const versionsFor = (predicate: (entry: BundledQualificationEntry) => boolean): string[] => (
    sortedVersions(entries.filter(predicate).map(entry => entry.coreVersion))
);

const versionList = (versions: string[]): string => versions.join('、') || '暂无';

/**
 * Describes bundled FLFE Core evidence only. Board-package compatibility and
 * its recommended Core remain separate policies: an unlisted version is still
 * allowed to compile through the platform-native safe route.
 */
export const resolveForgeCoreSupport = (
    fqbn: string,
    currentCoreVersion?: string | null,
): ForgeCoreSupportView => {
    const normalizedFqbn = fqbn.trim();
    const currentVersion = String(currentCoreVersion || '').trim() || undefined;
    const base = fqbnBase(normalizedFqbn);
    const platform = fqbnPlatform(normalizedFqbn);
    const exactFqbn = defaultCompleteFqbn(normalizedFqbn);
    const exactCertifiedCoreVersions = versionsFor(entry => entry.fqbn === exactFqbn);
    const certifiedCoreVersions = versionsFor(entry => fqbnBase(entry.fqbn) === base);
    const platformCertifiedCoreVersions = versionsFor(entry => fqbnPlatform(entry.fqbn) === platform);

    if (currentVersion && exactCertifiedCoreVersions.includes(currentVersion)) {
        return {
            status: 'certified-evidence-available',
            label: `FLFE Core ${currentVersion} · 已有资格证据`,
            detail: `当前 Core ${currentVersion} 在此板卡的随包 FLFE 资格证据范围内；完整 FQBN、工具链和构建合同仍会在编译时复核。`,
            currentCoreVersion: currentVersion,
            certifiedCoreVersions,
            platformCertifiedCoreVersions,
        };
    }

    if (currentVersion && certifiedCoreVersions.length > 0) {
        return {
            status: 'local-certification-required',
            label: `FLFE Core ${currentVersion} · 待本机认证`,
            detail: `当前 Core ${currentVersion} 仍可正常编译，不要求降级；此板卡随安装包已有资格证据的 Core 为 ${versionList(certifiedCoreVersions)}。当前完整身份尚未通过 A/B 不回退门禁，取得资格前使用原生安全构建。`,
            currentCoreVersion: currentVersion,
            certifiedCoreVersions,
            platformCertifiedCoreVersions,
        };
    }

    if (currentVersion && platformCertifiedCoreVersions.length > 0) {
        return {
            status: 'safe-fallback',
            label: `FLFE Core ${currentVersion} · 安全回退`,
            detail: `当前板卡/FQBN 尚无随包 FLFE 资格；当前 Core ${currentVersion} 仍可正常编译。该平台已有资格证据的 Core 为 ${versionList(platformCertifiedCoreVersions)}；当前完整身份尚未通过 A/B 不回退门禁，取得资格前使用原生安全构建。`,
            currentCoreVersion: currentVersion,
            certifiedCoreVersions,
            platformCertifiedCoreVersions,
        };
    }

    return {
        status: 'safe-fallback',
        label: currentVersion ? `FLFE Core ${currentVersion} · 安全回退` : 'FLFE Core · 待识别',
        detail: currentVersion
            ? `当前 Core ${currentVersion} 尚无随包 FLFE 资格证据，仍可通过平台原生路径正常编译；当前完整身份尚未通过 A/B 不回退门禁，完成本机认证后才会启用快速路径。`
            : '安装并识别 Core 后会显示其 FLFE 资格状态；没有资格时仍可使用平台原生安全构建。',
        currentCoreVersion: currentVersion,
        certifiedCoreVersions,
        platformCertifiedCoreVersions,
    };
};

const REASON_LABELS: Record<string, string> = {
    'unverified-core-version': '当前 Core 版本尚无 FLFE 资格证据',
    'qualification-core-version-mismatch': '本机资格证据属于另一 Core 版本',
    'missing-core-version': '未能识别当前 Core 版本',
    'invalid-core-version': '当前 Core 版本格式无法验证',
    'unverified-board-target': '当前板卡目标尚无 FLFE 资格证据',
    'qualification-fqbn-mismatch': '资格证据与当前完整 FQBN 不一致',
    'qualification-toolchain-mismatch': '资格证据与当前工具链内容不一致',
    'qualification-contract-mismatch': '资格证据与当前构建合同不一致',
    'qualification-performance-regression': '当前环境 A/B 性能未达到快速路径门槛',
    'qualification-performance-unavailable': '当前身份缺少完整 A/B 性能证据',
    'builtin-performance-qualification-missing': '当前完整身份缺少随包 A/B 性能资格',
    'builtin-toolchain-content-mismatch': '当前工具链内容与随包资格证据不一致',
    'builtin-toolchain-identity-unavailable': '暂时无法取得当前工具链强身份',
    'unknown-platform': '当前平台尚未纳入随包 FLFE 资格范围',
};

export const forgeReasonLabel = (reason: string, currentCoreVersion?: string): string => {
    const normalized = reason.trim().toLowerCase();
    const label = REASON_LABELS[normalized] || reason.split('-').join(' ');
    if (currentCoreVersion && [
        'unverified-core-version',
        'qualification-core-version-mismatch',
        'missing-core-version',
        'invalid-core-version',
    ].includes(normalized)) {
        return `${label}（当前 Core ${currentCoreVersion}）`;
    }
    return label;
};
