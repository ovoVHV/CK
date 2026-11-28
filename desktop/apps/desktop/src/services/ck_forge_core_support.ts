import bundledQualifications from '../../src-tauri/src/ck_forge_bundled_qualifications.v1.json';

const isEnUi = (): boolean => {
    try {
        const lang = typeof document !== 'undefined' ? document.documentElement?.lang : '';
        const stored = typeof window !== 'undefined' ? window.localStorage?.getItem('ck.i18n.uiLocale') : '';
        return /^en(?:-|$)/i.test(String(lang || stored || ''));
    } catch { return false; }
};
const uiText = (zh: string, en: string): string => (isEnUi() ? en : zh);

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

const versionList = (versions: string[]): string => (
    versions.join(uiText('、', ', ')) || uiText('暂无', 'none')
);

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
            label: uiText(
                `FLFE Core ${currentVersion} · 已有资格证据`,
                `FLFE Core ${currentVersion} · Qualification evidence available`,
            ),
            detail: uiText(
                `当前 Core ${currentVersion} 在此板卡的随包 FLFE 资格证据范围内；完整 FQBN、工具链和构建合同仍会在编译时复核。`,
                `Core ${currentVersion} is covered by bundled FLFE qualification evidence for this board; full FQBN, toolchain, and build contract are still verified during compilation.`,
            ),
            currentCoreVersion: currentVersion,
            certifiedCoreVersions,
            platformCertifiedCoreVersions,
        };
    }

    if (currentVersion && certifiedCoreVersions.length > 0) {
        return {
            status: 'local-certification-required',
            label: uiText(
                `FLFE Core ${currentVersion} · 待本机认证`,
                `FLFE Core ${currentVersion} · Local certification required`,
            ),
            detail: uiText(
                `当前 Core ${currentVersion} 仍可正常编译，不要求降级；此板卡随安装包已有资格证据的 Core 为 ${versionList(certifiedCoreVersions)}。当前完整身份尚未通过 A/B 不回退门禁，取得资格前使用原生安全构建。`,
                `Core ${currentVersion} compiles normally with no downgrade required; bundled qualification evidence for this board covers Core ${versionList(certifiedCoreVersions)}. This full target identity has not yet passed the A/B non-regression gate, so the native safe build route is used until qualified.`,
            ),
            currentCoreVersion: currentVersion,
            certifiedCoreVersions,
            platformCertifiedCoreVersions,
        };
    }

    if (currentVersion && platformCertifiedCoreVersions.length > 0) {
        return {
            status: 'safe-fallback',
            label: uiText(
                `FLFE Core ${currentVersion} · 安全回退`,
                `FLFE Core ${currentVersion} · Safe fallback`,
            ),
            detail: uiText(
                `当前板卡/FQBN 尚无随包 FLFE 资格；当前 Core ${currentVersion} 仍可正常编译。该平台已有资格证据的 Core 为 ${versionList(platformCertifiedCoreVersions)}；当前完整身份尚未通过 A/B 不回退门禁，取得资格前使用原生安全构建。`,
                `This board/FQBN has no bundled FLFE qualification yet; Core ${currentVersion} compiles normally. Bundled platform qualification evidence covers Core ${versionList(platformCertifiedCoreVersions)}; the native safe build route is used until this full target identity passes the A/B gate.`,
            ),
            currentCoreVersion: currentVersion,
            certifiedCoreVersions,
            platformCertifiedCoreVersions,
        };
    }

    return {
        status: 'safe-fallback',
        label: currentVersion
            ? uiText(`FLFE Core ${currentVersion} · 安全回退`, `FLFE Core ${currentVersion} · Safe fallback`)
            : uiText('FLFE Core · 待识别', 'FLFE Core · Pending detection'),
        detail: currentVersion
            ? uiText(
                `当前 Core ${currentVersion} 尚无随包 FLFE 资格证据，仍可通过平台原生路径正常编译；当前完整身份尚未通过 A/B 不回退门禁，完成本机认证后才会启用快速路径。`,
                `Core ${currentVersion} has no bundled FLFE qualification evidence yet and compiles normally via the platform-native route; fast mode enables only after local qualification passes the A/B non-regression gate.`,
            )
            : uiText(
                '安装并识别 Core 后会显示其 FLFE 资格状态；没有资格时仍可使用平台原生安全构建。',
                'FLFE qualification status appears once the Core is installed and detected; the platform-native safe build route remains available without qualification.',
            ),
        currentCoreVersion: currentVersion,
        certifiedCoreVersions,
        platformCertifiedCoreVersions,
    };
};

const REASON_LABELS: Record<string, [string, string]> = {
    'unverified-core-version': ['当前 Core 版本尚无 FLFE 资格证据', 'Current Core version has no FLFE qualification evidence'],
    'qualification-core-version-mismatch': ['本机资格证据属于另一 Core 版本', 'Local qualification evidence belongs to another Core version'],
    'missing-core-version': ['未能识别当前 Core 版本', 'Unable to detect current Core version'],
    'invalid-core-version': ['当前 Core 版本格式无法验证', 'Current Core version format cannot be validated'],
    'unverified-board-target': ['当前板卡目标尚无 FLFE 资格证据', 'Current board target has no FLFE qualification evidence'],
    'qualification-fqbn-mismatch': ['资格证据与当前完整 FQBN 不一致', 'Qualification evidence does not match the current full FQBN'],
    'qualification-toolchain-mismatch': ['资格证据与当前工具链内容不一致', 'Qualification evidence does not match the current toolchain'],
    'qualification-contract-mismatch': ['资格证据与当前构建合同不一致', 'Qualification evidence does not match the current build contract'],
    'qualification-performance-regression': ['当前环境 A/B 性能未达到快速路径门槛', 'A/B performance in this environment did not meet the fast-route threshold'],
    'qualification-performance-unavailable': ['当前身份缺少完整 A/B 性能证据', 'Complete A/B performance evidence is missing for this identity'],
    'builtin-performance-qualification-missing': ['当前完整身份缺少随包 A/B 性能资格', 'Bundled A/B performance qualification is missing for this full identity'],
    'builtin-toolchain-content-mismatch': ['当前工具链内容与随包资格证据不一致', 'Current toolchain contents do not match bundled qualification evidence'],
    'builtin-toolchain-identity-unavailable': ['暂时无法取得当前工具链强身份', 'Strong toolchain identity is temporarily unavailable'],
    'unknown-platform': ['当前平台尚未纳入随包 FLFE 资格范围', 'Current platform is not yet included in bundled FLFE qualification coverage'],
};

export const forgeReasonLabel = (reason: string, currentCoreVersion?: string): string => {
    const normalized = reason.trim().toLowerCase();
    const pair = REASON_LABELS[normalized];
    const label = pair ? uiText(pair[0], pair[1]) : reason.split('-').join(' ');
    if (currentCoreVersion && [
        'unverified-core-version',
        'qualification-core-version-mismatch',
        'missing-core-version',
        'invalid-core-version',
    ].includes(normalized)) {
        return uiText(`${label}（当前 Core ${currentCoreVersion}）`, `${label} (Current Core ${currentCoreVersion})`);
    }
    return label;
};
