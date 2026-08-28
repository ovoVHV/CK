import { useState, memo, useEffect, useCallback, useRef, useMemo } from 'react';
import { ArrowLeft, Check, ChevronDown, CircuitBoard, Loader2, Upload, Trash2, Package, DownloadCloud, Search, Link, RefreshCw, ShieldCheck, AlertTriangle, CircleDot } from 'lucide-react';
import { CoreManagerModal } from './CoreManagerModal';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useHardware } from '../contexts/HardwareContext';
import { getBoardIcon } from '../constants/boards';
import { BoardPackage, ArduinoCoreConfig } from '../types/board';
import { Toast } from './ui/Toast';
import { useDialog } from '../contexts/DialogContext';
import ThemeModeControl from './ThemeModeControl';
import { PackageQualityReportPanel } from './PackageQualityReportPanel';
import {
    compareCoreVersions,
    coreEnvironmentBlocksUse,
    resolveBoardPassport,
    type BoardPassportView,
    type PassportStageStatus,
    type PassportStageView,
} from '../services/board_passport';
import { boardPackageKey } from '../services/board_identity';
import { summarizeBoardDeletionWarnings } from '../services/board_delete_feedback';
import {
    resolveForgeCoreSupport,
    type ForgeCoreSupportStatus,
} from '../services/ck_forge_core_support';

interface BoardSelectorProps {
    onBack: () => void;
    onCreated: (path: string, options?: { forceBoard?: string; forceBoardPackageId?: string }) => void;
}

interface GithubBoardRegistryEntry {
    id: string;
    name: string;
    description: string;
    fqbn_base: string;
    subdir: string;
    tree_url: string;
    source_repo_url: string;
}

const DEFAULT_BOARD_REPO_URL = 'https://github.com/xiaojieyueyue/packages.git';
const DEFAULT_BOARD_REPO_URL_GITEE = 'https://gitee.com/manong1234/makerpage.git';
const MAX_INSTALL_LOG_LINES = 500;
const MAX_INSTALL_LOG_LINE_CHARACTERS = 2_000;
type CloudProvider = 'auto' | 'github' | 'gitee';

const appendBoundedInstallLog = (previous: string[], value: unknown): string[] => {
    const line = String(value ?? '').slice(-MAX_INSTALL_LOG_LINE_CHARACTERS);
    const next = [...previous, line];
    return next.length > MAX_INSTALL_LOG_LINES ? next.slice(-MAX_INSTALL_LOG_LINES) : next;
};

interface BoardProfileProgress {
    profile: string;
    status: 'pending' | 'running' | 'passed' | 'failed' | 'warning';
    message?: string;
    index?: number;
    total?: number;
}

interface BoardQualificationState {
    running: boolean;
    profiles: BoardProfileProgress[];
}

interface BoardPassportFacts {
    completeFqbns: string[];
    deviceModels: string[];
    deviceVerified: boolean;
    environmentUsable: boolean;
    expirationReasons: string[];
    isExpired: boolean;
    lastVerifiedAt?: string;
    usesRecommendedCore: boolean;
    verifiedCoreVersions: string[];
}

const passportRecord = (value: unknown): Record<string, any> | undefined => (
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, any>
        : undefined
);

const passportText = (...values: unknown[]): string | undefined => {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
};

const formatPassportDate = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return value;
    return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(new Date(timestamp));
};

const expirationReasonLabel = (reason: string): string => {
    const labels: Record<string, string> = {
        installed_content_changed: '板卡包或随包库内容已变化',
        menu_schema_changed: '板卡配置菜单已变化',
        manifest_version_changed: '板卡包版本已变化',
        core_requirement_changed: 'Core 兼容策略已变化',
        core_version_changed: '当前 Core 版本已变化',
        toolchain_changed: '当前编译工具链身份已变化',
        core_missing: '上次认证使用的 Core 当前未安装',
        core_below_minimum: '当前 Core 低于板卡包最低要求',
        core_known_incompatible: '当前 Core 命中已知不兼容范围',
        installed_content_check_failed: '无法确认已安装板卡包内容',
    };
    return labels[reason] || `认证环境变化：${reason}`;
};

const passportStageDisplayLabel = (item: PassportStageView): string => {
    const labels: Record<PassportStageView['id'], Record<PassportStageStatus, string>> = {
        structure: {
            passed: '结构已检查',
            warning: '结构有提示',
            failed: '结构检查失败',
            pending: '结构待检查',
        },
        environment: {
            passed: '当前环境已就绪',
            warning: '当前环境可用 · 需复验',
            failed: '当前环境不可用',
            pending: '环境检查中',
        },
        compile: {
            passed: '已在本机编译',
            warning: '本机编译需复验',
            failed: '本机编译失败',
            pending: '尚未本机编译',
        },
        device: {
            passed: '已在真板验证',
            warning: '部分真板已验证',
            failed: '真板验证失败',
            pending: '尚未真板验证',
        },
    };
    return labels[item.id][item.status];
};

const resolveBoardPassportFacts = (
    board: BoardPackage,
    passportView: BoardPassportView,
): BoardPassportFacts => {
    const passport = passportRecord(board.passport);
    const profiles = Array.isArray(passport?.profiles)
        ? passport.profiles.map(passportRecord).filter(Boolean) as Record<string, any>[]
        : [];
    const completeFqbns = [...new Set(
        profiles
            .map(profile => passportText(profile.fqbn))
            .filter(Boolean) as string[],
    )];
    if (completeFqbns.length === 0) {
        const fallback = passportText(board.fqbn, board.fqbn_base);
        if (fallback) completeFqbns.push(fallback);
    }

    const manifest = passportRecord(board.manifest);
    const hardwareVariants = Array.isArray(manifest?.hardware_variants)
        ? manifest.hardware_variants.map(passportRecord).filter(Boolean) as Record<string, any>[]
        : [];
    const hardwareVariantNames = new Map<string, string>();
    for (const variant of hardwareVariants) {
        const id = passportText(variant.id);
        const name = passportText(variant.name, variant.model, passportRecord(variant.expected_hardware)?.chip);
        if (id && name) hardwareVariantNames.set(id, name);
    }

    const verifiedProfiles = profiles.filter(profile => String(profile.status || '').toLowerCase() === 'device_verified');
    const deviceModels = [...new Set(verifiedProfiles.map(profile => {
        const evidence = passportRecord(profile.evidence);
        const device = passportRecord(evidence?.device ?? evidence?.hardware);
        const variantId = passportText(profile.hardware_variant, evidence?.hardware_variant);
        return passportText(
            evidence?.device_model,
            evidence?.board_model,
            evidence?.hardware_model,
            device?.model,
            device?.board,
            device?.chip,
            variantId ? hardwareVariantNames.get(variantId) : undefined,
            variantId,
        );
    }).filter(Boolean) as string[])];

    const checkedTimes = profiles
        .flatMap(profile => {
            const evidence = passportRecord(profile.evidence);
            return [
                passportText(profile.checked_at),
                passportText(evidence?.checked_at, evidence?.verified_at, evidence?.completed_at),
            ].filter(Boolean) as string[];
        })
        .map(raw => ({ raw, timestamp: Date.parse(raw) }))
        .sort((left, right) => {
            const a = Number.isFinite(left.timestamp) ? left.timestamp : Number.NEGATIVE_INFINITY;
            const b = Number.isFinite(right.timestamp) ? right.timestamp : Number.NEGATIVE_INFINITY;
            return b - a;
        });
    const lastVerifiedAt = formatPassportDate(checkedTimes[0]?.raw);

    const verifiedCoreVersions = [...new Set(
        profiles
            .map(profile => passportText(profile.core_version))
            .filter(Boolean) as string[],
    )];
    const rawReasons = Array.isArray(passport?.invalidated_reasons)
        ? passport.invalidated_reasons.map((reason: unknown) => String(reason || '').trim()).filter(Boolean)
        : [];
    const profileNeedsRevalidation = profiles.some(profile => (
        ['revalidation_required', 'expired', 'pending_core_revalidation'].includes(String(profile.status || '').toLowerCase())
    ));
    const certificationStatus = String(passport?.certification_status || '').trim().toLowerCase();
    const isExpired = rawReasons.length > 0
        || ['expired', 'revalidation_required'].includes(certificationStatus)
        || profileNeedsRevalidation;
    const expirationReasons = [...new Set(rawReasons.map(expirationReasonLabel))];
    if (isExpired && expirationReasons.length === 0) {
        expirationReasons.push('当前 Core、FQBN 或板卡包证据与上次认证不一致');
    }

    const installedCore = passportView.installedCoreVersion;
    const recommendedCore = passportView.recommendedCoreVersion;
    const usesRecommendedCore = !!installedCore
        && !!recommendedCore
        && (installedCore.trim() === recommendedCore.trim()
            || compareCoreVersions(installedCore, recommendedCore) === 0);
    const environment = passportView.stages.find(item => item.id === 'environment');
    const device = passportView.stages.find(item => item.id === 'device');

    return {
        completeFqbns,
        deviceModels,
        deviceVerified: verifiedProfiles.length > 0 || device?.status === 'passed',
        environmentUsable: environment?.status === 'passed' || environment?.status === 'warning',
        expirationReasons,
        isExpired,
        lastVerifiedAt,
        usesRecommendedCore,
        verifiedCoreVersions,
    };
};

const qualificationStatusFrom = (value: unknown, coreStatus?: unknown): BoardProfileProgress['status'] => {
    const raw = String(value || '').trim().toLowerCase();
    if (['passed', 'success', 'recommended', 'tested_compatible', 'compile_passed', 'compile_certified', 'device_verified'].includes(raw)) return 'passed';
    if (raw === 'blocked_core') return coreEnvironmentBlocksUse(coreStatus) ? 'failed' : 'warning';
    if (['failed', 'error', 'blocked', 'known_incompatible', 'below_minimum', 'missing', 'core_missing'].includes(raw)) return 'failed';
    if (['warning', 'warn', 'compatible', 'compatible_untested', 'incompatible', 'tested_non_recommended', 'revalidation_required', 'needs_revalidation', 'requires_revalidation', 'unverified', 'newer_unverified', 'newer_untested', 'above_tested_range', 'above_maximum', 'outside_compatible_range', 'invalid_requirement', 'unparseable_installed_version', 'unknown'].includes(raw)) return 'warning';
    if (raw === 'running' || raw === 'compiling') return 'running';
    return 'pending';
};



// Memoized Board Grid to prevent re-renders when parent state changes
const passportTone = (status: PassportStageStatus): string => {
    switch (status) {
        case 'passed':
            return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/45 dark:text-emerald-300';
        case 'warning':
            return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/45 dark:text-amber-300';
        case 'failed':
            return 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/45 dark:text-rose-300';
        default:
            return 'border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400';
    }
};

const forgeCoreSupportTone = (status: ForgeCoreSupportStatus): string => {
    if (status === 'certified-evidence-available') {
        return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/45 dark:text-emerald-300';
    }
    if (status === 'local-certification-required') {
        return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/45 dark:text-amber-300';
    }
    return 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300';
};

// Memoized Board Grid to prevent re-renders when parent state changes
const BoardGrid = memo(({ boards, selected, onSelect, onDelete, onInstallCore, onRefreshPassport, onQualify, qualificationByBoard, installedCoreVersions, isLoadingCores }: {
    boards: BoardPackage[],
    selected: string | null,
    onSelect: (packageId: string) => void,
    onDelete: (id: string, name: string) => void,
    onInstallCore: (config: ArduinoCoreConfig, version?: string) => void,
    onRefreshPassport: (id: string) => void,
    onQualify: (id: string) => void,
    qualificationByBoard: Record<string, BoardQualificationState>,
    installedCoreVersions: Record<string, string>,
    isLoadingCores: boolean
}) => {
    const [expandedBoardId, setExpandedBoardId] = useState<string | null>(null);

    if (boards.length === 0) {
        return (
            <div className="min-h-[260px] flex flex-col items-center justify-center border border-dashed border-[#ccd5e1] bg-white text-slate-400 rounded-md dark:border-slate-700 dark:bg-slate-900">
                <CircuitBoard size={28} strokeWidth={1.5} className="mb-3" />
                <p className="text-sm font-medium">正在扫描开发板...</p>
            </div>
        );
    }

    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-3">
            {boards.map(board => {
                // Resolve Icon
                const fallbackIcon = getBoardIcon(board.fqbn);
                let renderIcon = fallbackIcon;

                if (board.icon) {
                    if (board.icon.startsWith('/') || board.icon.startsWith('http')) {
                        renderIcon = board.icon;
                    } else {
                        // Local file -> convert to asset protocol
                        try {
                            // Handle relative paths for custom boards
                            const isAbsolute = board.icon.match(/^[a-zA-Z]:/) || board.icon.startsWith('/');
                            if (isAbsolute) {
                                renderIcon = convertFileSrc(board.icon);
                            } else if (board.path) {
                                // Join path + icon (Manual join for browser safe)
                                const cleanPath = board.path.replace(/\\/g, '/');
                                const prefix = cleanPath.endsWith('/') ? cleanPath : cleanPath + '/';
                                renderIcon = convertFileSrc(prefix + board.icon);
                            } else {
                                renderIcon = convertFileSrc(board.icon);
                            }
                        } catch (e) {
                            console.warn("Failed to convert icon src", e);
                        }
                    }
                }

                const isImage = renderIcon.startsWith('/') || renderIcon.includes('://') || renderIcon.includes('asset');
                const packageKey = boardPackageKey(board);
                const isSelected = selected === packageKey;
                const isCustom = board.is_custom;
                const passport = resolveBoardPassport(board, installedCoreVersions, { coreListLoading: isLoadingCores });
                const facts = resolveBoardPassportFacts(board, passport);
                const coreId = board.arduino_core?.package;
                const forgeCoreSupport = resolveForgeCoreSupport(
                    board.fqbn_base || board.fqbn,
                    passport.installedCoreVersion,
                );
                const showMissing = !!coreId && !passport.installedCoreVersion && !isLoadingCores;
                const expanded = expandedBoardId === board.id;
                const structure = passport.stages[0];
                const environment = passport.stages[1];
                const displayFqbn = board.fqbn_base || board.fqbn;
                const qualification = qualificationByBoard[board.id];
                const canQualify = !!board.is_custom
                    && structure.status !== 'failed'
                    && structure.status !== 'pending'
                    && environment.status !== 'failed';

                return (
                    <div
                        key={packageKey}
                        onClick={() => {
                            if (board.fqbn) onSelect(packageKey);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                if (board.fqbn) onSelect(packageKey);
                            }
                        }}
                        role="button"
                        tabIndex={0}
                        aria-pressed={isSelected}
                        className={`
                            relative min-h-[132px] rounded-md border cursor-pointer transition-colors group overflow-hidden text-left
                            ${isSelected
                                ? 'bg-[#e9f6f4] border-[#7fc6bd] dark:bg-teal-950/45 dark:border-teal-700'
                                : 'bg-white border-[#dce3ec] hover:border-[#9fb0c4] hover:bg-[#fbfcfe] dark:bg-slate-900 dark:border-slate-700 dark:hover:border-slate-500 dark:hover:bg-slate-800'}
                            ${!passport.canCreateProject ? 'border-rose-200 dark:border-rose-900/80' : ''}
                        `}
                    >
                        <span className={`absolute inset-y-0 left-0 w-[3px] transition-colors ${isSelected ? 'bg-[#0f8f83]' : 'bg-transparent group-hover:bg-[#c5d0dc]'}`} />

                        {isCustom && (
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onDelete(board.id, board.name);
                                }}
                                className="absolute top-2 right-9 h-7 px-2 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded flex items-center justify-center gap-1 transition-colors z-20 bg-white/90 border border-slate-200 text-[9px] font-bold dark:border-slate-700 dark:bg-slate-800/95 dark:text-slate-300 dark:hover:bg-red-950/40 dark:hover:text-red-300"
                                title="删除自定义开发板"
                                aria-label={`删除自定义开发板 ${board.name}`}
                            >
                                <Trash2 size={14} />
                                <span>删除</span>
                            </button>
                        )}

                        <div className="p-3 pl-4 flex items-center gap-3">
                            <div className={`w-[78px] h-[74px] shrink-0 rounded border flex items-center justify-center overflow-hidden transition-colors ${isSelected ? 'bg-white border-[#b9ddd8] dark:bg-slate-800 dark:border-teal-800' : 'bg-[#f4f6f9] border-[#e4e9f0] dark:bg-slate-800 dark:border-slate-700'} ${showMissing ? 'opacity-55 grayscale' : ''}`}>
                                {isImage ? (
                                    <img src={renderIcon} alt={board.name} className="max-w-[66px] max-h-[60px] object-contain" />
                                ) : (
                                    <span className="text-3xl">{renderIcon}</span>
                                )}
                            </div>

                            <div className="flex-1 min-w-0 pr-6">
                                <div className="flex items-center gap-2 min-w-0">
                                    <h3 className="text-sm font-bold text-slate-800 truncate dark:text-slate-100">{board.name}</h3>
                                    <span className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-bold ${passportTone(structure.status)}`}>
                                        <ShieldCheck size={10} />
                                        {passportStageDisplayLabel(structure)}
                                    </span>
                                    {!passport.canCreateProject && (
                                        <span className="shrink-0 inline-flex items-center gap-1 text-[9px] bg-rose-50 text-rose-700 px-1.5 py-0.5 rounded border border-rose-200 font-bold dark:border-rose-900 dark:bg-rose-950/45 dark:text-rose-300">
                                            <AlertTriangle size={10} /> 暂不可用
                                        </span>
                                    )}
                                </div>
                                <p className="mt-1 text-[10px] font-mono text-slate-400 truncate" title={displayFqbn || '未声明真实 FQBN'}>
                                    {displayFqbn || '未声明真实 FQBN'}
                                </p>
                                <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                                    {passport.stages.map(item => (
                                        <span
                                            key={item.id}
                                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-semibold ${passportTone(item.status)}`}
                                            title={item.summary}
                                        >
                                            <CircleDot size={8} /> {passportStageDisplayLabel(item)}
                                        </span>
                                    ))}
                                    <span
                                        data-ck-role="board-flfe-core-status"
                                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-semibold ${forgeCoreSupportTone(forgeCoreSupport.status)}`}
                                        title={forgeCoreSupport.detail}
                                    >
                                        <CircleDot size={8} /> {forgeCoreSupport.label}
                                    </span>
                                </div>
                                <div className="mt-2 flex items-center justify-between gap-2">
                                    <p className="text-[10px] text-slate-400 truncate">
                                        {[board.vendor || board.author, board.version ? `v${board.version}` : '', `${board.pins.length} 引脚`].filter(Boolean).join(' · ') || '板卡信息待补充'}
                                    </p>
                                    <button
                                        type="button"
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            setExpandedBoardId(current => current === board.id ? null : board.id);
                                        }}
                                        className="shrink-0 inline-flex items-center gap-1 text-[10px] font-bold text-[#0f766e] hover:text-[#0b5f58] dark:text-teal-300"
                                        aria-expanded={expanded}
                                    >
                                        护照详情
                                        <ChevronDown size={12} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
                                    </button>
                                </div>
                            </div>
                        </div>

                        {isSelected && (
                            <span className="absolute top-3 right-3 w-5 h-5 rounded-full bg-[#0f8f83] text-white flex items-center justify-center">
                                <Check size={12} strokeWidth={3} />
                            </span>
                        )}

                        {expanded && (
                            <div
                                className="border-t border-slate-200 bg-slate-50/80 px-4 py-3 dark:border-slate-700 dark:bg-slate-950/35"
                                onClick={(event) => event.stopPropagation()}
                            >
                                <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
                                    {passport.stages.map(item => (
                                        <div key={item.id} className="flex items-start gap-2 rounded border border-slate-200 bg-white px-2.5 py-2 dark:border-slate-700 dark:bg-slate-900">
                                            <span className={`mt-0.5 w-2 h-2 rounded-full ${item.status === 'passed' ? 'bg-emerald-500' : item.status === 'warning' ? 'bg-amber-500' : item.status === 'failed' ? 'bg-rose-500' : 'bg-slate-400'}`} />
                                            <div className="min-w-0">
                                                <p className="text-[10px] font-bold text-slate-700 dark:text-slate-200">{passportStageDisplayLabel(item)}</p>
                                                <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">{item.summary}</p>
                                                {item.detail && <p className="mt-0.5 text-[9px] text-slate-400">{item.detail}</p>}
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                {(board.is_custom || board.quality_report) && (
                                    <div className="mt-3">
                                        <PackageQualityReportPanel
                                            report={board.quality_report}
                                            metadataVersion={(board.manifest as any)?.schema_version}
                                            sourceLabel={board.is_custom ? '用户导入的第三方板卡包' : '随软件提供的板卡定义'}
                                            compact
                                        />
                                    </div>
                                )}

                                <dl className="mt-3 grid grid-cols-[92px_1fr] gap-x-2 gap-y-1 text-[10px]">
                                    <dt className="text-slate-400">完整 FQBN</dt>
                                    <dd className="space-y-0.5 font-mono text-slate-600 dark:text-slate-300 break-all">
                                        {facts.completeFqbns.length > 0
                                            ? facts.completeFqbns.map(fqbn => <div key={fqbn}>{fqbn}</div>)
                                            : '未声明'}
                                    </dd>
                                    <dt className="text-slate-400">板卡包</dt>
                                    <dd className="text-slate-600 dark:text-slate-300">{[board.vendor || board.author || '来源未声明', board.version ? `v${board.version}` : '版本未声明'].join(' · ')}</dd>
                                    <dt className="text-slate-400">当前 Core</dt>
                                    <dd className="text-slate-600 dark:text-slate-300">
                                        {coreId || '未声明'}
                                        {passport.installedCoreVersion ? ` @ ${passport.installedCoreVersion}` : ' · 未安装或未识别'}
                                    </dd>
                                    <dt className="text-slate-400">板卡包推荐 Core</dt>
                                    <dd className="text-slate-600 dark:text-slate-300">{passport.recommendedCoreVersion || '未声明；其他版本允许使用但需复验'}</dd>
                                    <dt className="text-slate-400">FLFE Core 资格</dt>
                                    <dd className="text-slate-600 dark:text-slate-300">
                                        <span className={`inline-flex rounded border px-1.5 py-0.5 text-[9px] font-bold ${forgeCoreSupportTone(forgeCoreSupport.status)}`}>
                                            {forgeCoreSupport.label}
                                        </span>
                                        <p className="mt-1 leading-4 text-slate-500 dark:text-slate-400">{forgeCoreSupport.detail}</p>
                                    </dd>
                                    <dt className="text-slate-400">验证 Core</dt>
                                    <dd className="text-slate-600 dark:text-slate-300">{facts.verifiedCoreVersions.length > 0 ? facts.verifiedCoreVersions.join('、') : '尚无本机验证记录'}</dd>
                                    <dt className="text-slate-400">最后验证</dt>
                                    <dd className="text-slate-600 dark:text-slate-300">{facts.lastVerifiedAt || '尚无验证时间'}</dd>
                                    <dt className="text-slate-400">真板型号</dt>
                                    <dd className="text-slate-600 dark:text-slate-300">{facts.deviceModels.length > 0 ? facts.deviceModels.join('、') : '尚无真板型号证据'}</dd>
                                    <dt className="text-slate-400">引脚目录</dt>
                                    <dd className="text-slate-600 dark:text-slate-300">{board.pins.length > 0 ? `${board.pins.length} 项已载入` : '未提供'}</dd>
                                    {passport.lockSummary && (
                                        <>
                                            <dt className="text-slate-400">缓存凭证</dt>
                                            <dd className="text-slate-600 dark:text-slate-300">{passport.lockSummary}</dd>
                                        </>
                                    )}
                                </dl>

                                {facts.isExpired && (
                                    <div className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] text-amber-700 dark:border-amber-900 dark:bg-amber-950/35 dark:text-amber-300">
                                        <span className="font-bold">认证已过期：</span>
                                        {facts.expirationReasons.join('；')}
                                    </div>
                                )}

                                {!passport.canCreateProject && (
                                    <div className="mt-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-[10px] text-rose-700 dark:border-rose-900 dark:bg-rose-950/35 dark:text-rose-300">
                                        <span className="font-bold">阻止创建：</span>{passport.blockedReason}
                                    </div>
                                )}
                                {passport.needsLocalCertification && passport.canCreateProject && (
                                    <div className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] text-amber-700 dark:border-amber-900 dark:bg-amber-950/35 dark:text-amber-300">
                                        当前配置可以使用，但需要自动编译复验；认证成功后会更新 ck.lock。
                                    </div>
                                )}
                                {passport.actions.length > 0 && (
                                    <ul className="mt-2 pl-4 list-disc text-[10px] text-slate-500 dark:text-slate-400">
                                        {passport.actions.map(action => <li key={action}>{action}</li>)}
                                    </ul>
                                )}
                                {qualification?.profiles.length > 0 && (
                                    <div className="mt-3 rounded border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200">声明配置档案验证</span>
                                            {qualification.running && (
                                                <span className="inline-flex items-center gap-1 text-[9px] text-teal-600 dark:text-teal-300">
                                                    <Loader2 size={10} className="animate-spin" /> 正在验证
                                                </span>
                                            )}
                                        </div>
                                        <div className="mt-2 space-y-1.5">
                                            {qualification.profiles.map((profile, index) => (
                                                <div key={`${profile.profile}-${index}`} className="flex items-start gap-2 text-[10px]">
                                                    <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${profile.status === 'passed' ? 'bg-emerald-500' : profile.status === 'failed' ? 'bg-rose-500' : profile.status === 'warning' ? 'bg-amber-500' : profile.status === 'running' ? 'bg-teal-500 animate-pulse' : 'bg-slate-300'}`} />
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-start gap-2">
                                                            <span className="font-mono text-slate-600 dark:text-slate-300 break-all">{profile.profile}</span>
                                                            <span className="ml-auto text-slate-400 shrink-0">
                                                                {profile.index && profile.total ? `${profile.index}/${profile.total} · ` : ''}
                                                                {profile.status === 'passed' ? '通过' : profile.status === 'failed' ? '失败' : profile.status === 'warning' ? '提示' : profile.status === 'running' ? '编译中' : '等待'}
                                                            </span>
                                                        </div>
                                                        {profile.message && (
                                                            <p className={`mt-0.5 leading-relaxed ${profile.status === 'failed' ? 'text-rose-600 dark:text-rose-300' : profile.status === 'warning' ? 'text-amber-600 dark:text-amber-300' : 'text-slate-400'}`}>
                                                                {profile.message}
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                <div className="mt-3 flex items-center justify-end gap-2">
                                    {board.arduino_core && (showMissing || (passport.recommendedCoreVersion && passport.recommendedCoreVersion !== passport.installedCoreVersion)) && (
                                        <button
                                            type="button"
                                            onClick={() => onInstallCore(board.arduino_core!, passport.recommendedCoreVersion)}
                                            className="h-7 px-2 text-[10px] font-bold text-[#0f766e] bg-white hover:bg-[#e4f3f1] border border-[#b9ddd8] rounded transition-colors flex items-center gap-1.5 dark:border-teal-800 dark:bg-slate-800 dark:text-teal-300 dark:hover:bg-teal-950/50"
                                        >
                                            <DownloadCloud size={12} />
                                            {showMissing ? '安装核心' : '安装推荐版本'}
                                        </button>
                                    )}
                                    {board.is_custom && (
                                        <>
                                            <button
                                                type="button"
                                                onClick={() => onQualify(board.id)}
                                                disabled={!canQualify || qualification?.running}
                                                title={!canQualify ? '请先完成结构检查并修复核心环境' : '按板卡包声明的配置档案自动编译验证'}
                                                className="h-7 px-2 text-[10px] font-bold text-white bg-[#0f766e] hover:bg-[#0d675f] disabled:bg-slate-300 disabled:cursor-not-allowed rounded transition-colors flex items-center gap-1.5 dark:disabled:bg-slate-700"
                                            >
                                                {qualification?.running ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
                                                {qualification?.running ? '自动验证中' : '自动验证配置档案'}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => onRefreshPassport(board.id)}
                                                className="h-7 px-2 text-[10px] font-bold text-slate-600 bg-white hover:bg-slate-100 border border-slate-200 rounded transition-colors flex items-center gap-1.5 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                                            >
                                                <RefreshCw size={12} /> 刷新认证状态
                                            </button>
                                        </>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
});

// Footer Component with isolated state to prevent parent re-renders
const CreateProjectFooter = ({ isBoardSelected, canCreateProject, blockedReason, selectedBoardName, onCreate, isCreating, onBack }: {
    isBoardSelected: boolean,
    canCreateProject: boolean,
    blockedReason?: string,
    selectedBoardName?: string,
    onCreate: (name: string) => void,
    isCreating: boolean,
    onBack: () => void,
}) => {
    const [name, setName] = useState('');

    return (
        <div className="bg-[#fbfcfe] border-t border-[#dce3ec] px-5 py-3 flex-shrink-0 z-10 dark:border-slate-800 dark:bg-slate-900">
            <div className="max-w-[1440px] mx-auto flex items-end gap-4">
                <div className="w-[250px] min-w-0 pb-0.5">
                    <span className="block text-[9px] font-bold text-slate-400 uppercase mb-1">目标板</span>
                    <span className={`block text-xs font-bold truncate ${isBoardSelected && canCreateProject ? 'text-[#0f766e]' : isBoardSelected ? 'text-rose-600 dark:text-rose-300' : 'text-slate-400'}`}>
                        {selectedBoardName || '尚未选择'}
                    </span>
                    {isBoardSelected && !canCreateProject && (
                        <span className="mt-1 block text-[9px] text-rose-500 truncate" title={blockedReason}>{blockedReason}</span>
                    )}
                </div>
                <label className="flex-1 max-w-[520px] min-w-[260px]">
                    <span className="block text-[9px] font-bold text-slate-400 uppercase mb-1">工程名称</span>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={!isBoardSelected ? "请先选择开发板" : canCreateProject ? "例如: MyRobot01" : "请先处理板卡护照中的阻止项"}
                        disabled={!isBoardSelected || !canCreateProject}
                        className={`
                            w-full h-10 px-3 rounded-md border outline-none text-sm font-medium transition-colors
                            ${isBoardSelected && canCreateProject
                                ? 'bg-white border-[#cfd8e3] focus:border-[#0f8f83] text-slate-800 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100'
                                : 'bg-[#f1f4f8] border-[#e2e7ee] text-slate-400 cursor-not-allowed dark:bg-slate-800/60 dark:border-slate-800'}
                        `}
                    />
                </label>

                <div className="ml-auto flex items-center gap-2">
                    <button
                        onClick={onBack}
                        className="h-10 px-4 rounded-md font-bold bg-white border border-[#d5dde7] text-slate-500 hover:bg-slate-50 hover:text-slate-800 transition-colors text-xs dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white"
                    >
                        取消
                    </button>
                    <button
                        onClick={() => onCreate(name)}
                        disabled={!name.trim() || !isBoardSelected || !canCreateProject || isCreating}
                        className={`
                            h-10 px-5 rounded-md font-bold text-white transition-colors flex items-center gap-2 text-xs
                            ${name.trim() && isBoardSelected && canCreateProject && !isCreating
                                ? 'bg-[#0f766e] hover:bg-[#0d675f]'
                                : 'bg-slate-300 cursor-not-allowed'}
                        `}
                    >
                        {isCreating && <Loader2 size={18} className="animate-spin" />}
                        创建工程
                    </button>
                </div>
            </div>
        </div>
    );
};

export default function BoardSelector({ onBack, onCreated }: BoardSelectorProps) {
    const { setActiveBoard, availableBoards, reloadBoards, activeBoard, activeBoardPackageId, installedCoreVersions, refreshInstalledCores: refreshContextCores } = useHardware();
    const [selected, setSelected] = useState<string | null>(null);
    const [isCreating, setIsCreating] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const [showCoreManager, setShowCoreManager] = useState(false);
    // const [installedCores, setInstalledCores] = useState<String[]>([]); // Removed: Use Context


    const [toast, setToast] = useState<{ show: boolean, message: string, type: 'info' | 'loading' | 'success' | 'error' }>({ show: false, message: '', type: 'info' });
    const { confirm, alert } = useDialog();

    const [progress, setProgress] = useState<{ percent: number, message: string } | null>(null);
    const [installLogs, setInstallLogs] = useState<string[]>([]);
    const logsEndRef = useRef<HTMLDivElement>(null);

    // Auto-scroll logs
    useEffect(() => {
        if (logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: "smooth" });
        }
    }, [installLogs]);

    const [isLoadingCores, setIsLoadingCores] = useState(true);

    // Search & Filter State
    const [searchQuery, setSearchQuery] = useState('');
    const [activeCategory, setActiveCategory] = useState('All');
    const [onlyDeviceVerified, setOnlyDeviceVerified] = useState(false);
    const [onlyEnvironmentUsable, setOnlyEnvironmentUsable] = useState(false);
    const [onlyRecommendedCore, setOnlyRecommendedCore] = useState(false);
    const [showExpiredCertifications, setShowExpiredCertifications] = useState(true);
    const [boardRegistryUrl, setBoardRegistryUrl] = useState(DEFAULT_BOARD_REPO_URL_GITEE);
    const [boardRegistryProvider, setBoardRegistryProvider] = useState<CloudProvider>('gitee');
    const [cloudBoardCandidates, setCloudBoardCandidates] = useState<GithubBoardRegistryEntry[]>([]);
    const [cloudBoardSearch, setCloudBoardSearch] = useState('');
    const [showCloudBoardPicker, setShowCloudBoardPicker] = useState(false);
    const [cloudBoardLoading, setCloudBoardLoading] = useState(false);
    const [cloudBoardError, setCloudBoardError] = useState('');
    const [installingCloudBoardKey, setInstallingCloudBoardKey] = useState<string | null>(null);
    const [qualificationByBoard, setQualificationByBoard] = useState<Record<string, BoardQualificationState>>({});

    // Derived Categories
    // Derived Categories
    // Let's make it dynamic + defaults
    const dynamicCategories = ['All', ...Array.from(new Set(availableBoards.map(b => {
        if (b.is_custom) return '自定义';
        if (String(b.fqbn || '').startsWith('esp32:')) return 'ESP32';
        if (String(b.fqbn || '').startsWith('arduino:')) return 'Arduino';
        return '其他'; // Group others? Or specific?
    }))).sort()];

    // Filter Logic
    const filteredBoards = useMemo(() => availableBoards.filter(b => {
        const searchLower = searchQuery.trim().toLowerCase();
        const matchSearch = [b.name, b.fqbn_base, b.fqbn, b.vendor, b.author, b.version]
            .some(value => String(value || '').toLowerCase().includes(searchLower));

        let matchCat = true;
        if (activeCategory === 'All') matchCat = true;
        else if (activeCategory === '自定义') matchCat = !!b.is_custom;
        else if (activeCategory === 'ESP32') matchCat = String(b.fqbn || '').startsWith('esp32:');
        else if (activeCategory === 'Arduino') matchCat = String(b.fqbn || '').startsWith('arduino:');
        else matchCat = !b.is_custom && !String(b.fqbn || '').startsWith('esp32:') && !String(b.fqbn || '').startsWith('arduino:');

        if (!matchSearch || !matchCat) return false;

        const passport = resolveBoardPassport(b, installedCoreVersions, { coreListLoading: isLoadingCores });
        const facts = resolveBoardPassportFacts(b, passport);
        if (onlyDeviceVerified && !facts.deviceVerified) return false;
        if (onlyEnvironmentUsable && !facts.environmentUsable) return false;
        if (onlyRecommendedCore && !facts.usesRecommendedCore) return false;
        if (!showExpiredCertifications && facts.isExpired) return false;
        return true;
    }), [
        activeCategory,
        availableBoards,
        installedCoreVersions,
        isLoadingCores,
        onlyDeviceVerified,
        onlyEnvironmentUsable,
        onlyRecommendedCore,
        searchQuery,
        showExpiredCertifications,
    ]);

    const hasPassportFilters = onlyDeviceVerified
        || onlyEnvironmentUsable
        || onlyRecommendedCore
        || !showExpiredCertifications;

    useEffect(() => {
        if (selected && !filteredBoards.some(board => boardPackageKey(board) === selected)) {
            setSelected(null);
        }
    }, [filteredBoards, selected]);

    const filteredCloudBoardCandidates = useMemo(() => {
        const q = cloudBoardSearch.trim().toLowerCase();
        if (!q) return cloudBoardCandidates;
        return cloudBoardCandidates.filter((entry) =>
            entry.name.toLowerCase().includes(q) ||
            entry.id.toLowerCase().includes(q) ||
            String(entry.description || '').toLowerCase().includes(q) ||
            entry.subdir.toLowerCase().includes(q) ||
            entry.fqbn_base.toLowerCase().includes(q)
        );
    }, [cloudBoardCandidates, cloudBoardSearch]);

    const installedBoardIdSet = useMemo(() => {
        const set = new Set<string>();
        for (const board of availableBoards || []) {
            const id = String((board as any)?.id || '').trim().toLowerCase();
            if (id) set.add(id);
        }
        return set;
    }, [availableBoards]);

    useEffect(() => {
        const rawProvider = (localStorage.getItem('ck_board_registry_provider') || 'gitee').trim().toLowerCase();
        const provider: CloudProvider = (rawProvider === 'github' || rawProvider === 'gitee' || rawProvider === 'auto')
            ? (rawProvider as CloudProvider)
            : 'gitee';
        setBoardRegistryProvider(provider);

        const stored = localStorage.getItem('ck_board_registry_url');
        const normalized = (stored || '').trim();
        const fallbackUrl = provider === 'gitee' ? DEFAULT_BOARD_REPO_URL_GITEE : DEFAULT_BOARD_REPO_URL;
        if (normalized) {
            setBoardRegistryUrl(normalized);
        } else {
            localStorage.setItem('ck_board_registry_url', fallbackUrl);
            localStorage.setItem('ck_board_registry_provider', provider);
            setBoardRegistryUrl(fallbackUrl);
        }
    }, []);

    // Fetch installed cores (Wrapper for Context)
    const refreshInstalledCores = useCallback(async (
        options: { invalidateBoardSchemas?: boolean } = {},
    ) => {
        // setIsLoadingCores(true); // Don't reset to true to prevent flicker on background refresh
        try {
            await refreshContextCores(options);
        } catch (e) {
            console.error("Failed to list cores", e);
        } finally {
            setIsLoadingCores(false); // End loading (idempotent)
        }
    }, [refreshContextCores]);

    // ...



    // ...



    useEffect(() => {
        refreshInstalledCores();
    }, [refreshInstalledCores]);

    useEffect(() => {
        let disposed = false;
        const unlisteners: Array<() => void> = [];
        const setup = async () => {
            const { listen } = await import('@tauri-apps/api/event');
            const onProgress = (event: { payload: unknown }) => {
                let payload: any = event.payload;
                if (typeof payload === 'string') {
                    try { payload = JSON.parse(payload); } catch { payload = { message: payload }; }
                }
                const boardId = String(payload?.board_id || payload?.boardId || '').trim();
                if (!boardId) return;
                const status = qualificationStatusFrom(
                    payload?.status || payload?.state || 'running',
                    payload?.core ?? payload?.core_status,
                );
                const profile = String(payload?.profile || payload?.profile_id || payload?.profileId || payload?.fqbn || '声明配置').trim();
                const next: BoardProfileProgress = {
                    profile,
                    status,
                    message: String(payload?.message || payload?.reason || '').trim() || undefined,
                    index: Number(payload?.index) || undefined,
                    total: Number(payload?.total) || undefined,
                };
                setQualificationByBoard(previous => {
                    const current = previous[boardId] || { running: true, profiles: [] };
                    const index = current.profiles.findIndex(item => item.profile === profile);
                    const profiles = [...current.profiles];
                    if (index >= 0) profiles[index] = next;
                    else profiles.push(next);
                    return { ...previous, [boardId]: { running: true, profiles } };
                });
            };
            for (const eventName of ['board-profile-qualification-progress', 'board-profile-validation-progress']) {
                const unlisten = await listen(eventName, onProgress);
                if (disposed) unlisten();
                else unlisteners.push(unlisten);
            }
        };
        void setup();
        return () => {
            disposed = true;
            unlisteners.forEach(unlisten => unlisten());
        };
    }, []);

    // Listen to install progress
    useEffect(() => {
        let unlistenProgress: (() => void) | undefined;
        let unlistenJson: (() => void) | undefined;
        let unlistenFinished: (() => void) | undefined;
        let disposed = false;

        const setupListener = async () => {
            try {
                const { listen } = await import('@tauri-apps/api/event');
                if (disposed) return;

                // Legacy text progress (for errors mostly now, AND intermediate status)
                const stopProgress = await listen('install-progress', (event) => {
                let msg = event.payload as string;

                // Simple ANSI strip
                let cleanMsg = msg.replace(/\x1b\[[\d;]*[a-zA-Z]/g, '').trim()
                    .slice(-MAX_INSTALL_LOG_LINE_CHARACTERS);

                if (cleanMsg) {
                    setInstallLogs(prev => {
                        const lastLog = prev[prev.length - 1] || "";

                        // Heuristic: Is this a progress update line? (Contains % or "Downloading")
                        const isProgress = /[\d\.]+%/.test(cleanMsg) || cleanMsg.startsWith("Downloading") || cleanMsg.startsWith("正在下载");
                        const lastIsProgress = /[\d\.]+%/.test(lastLog) || lastLog.startsWith("Downloading") || lastLog.startsWith("正在下载");

                        // If both are progress lines, probably an update -> Replace
                        // Or if they start with the same package prefix
                        if (prev.length > 0 && isProgress && lastIsProgress) {
                            // Replace last line
                            const newLogs = [...prev];
                            newLogs[newLogs.length - 1] = cleanMsg;
                            return newLogs;
                        }

                        return appendBoundedInstallLog(prev, cleanMsg);
                    });
                }
                });
                if (disposed) {
                    stopProgress();
                    return;
                }
                unlistenProgress = stopProgress;

                // JSON Progress
                let lastFile = "";
                const stopJson = await listen('install-progress-json', (event) => {
                // Debug raw
                // console.log("Raw JSON:", event.payload); 

                try {
                    const data = JSON.parse(event.payload as string);

                    // Catch-all debug for visible feedback
                    if (!data.eventType) {
                        setInstallLogs(prev => appendBoundedInstallLog(prev, `[Raw] ${(event.payload as string).substring(0, 50)}...`));
                    }

                    if (data.eventType === "download_progress") {
                        // payload: { total: int, downloaded: int, completed: bool, url?: string }
                        if (data.payload) {
                            let percent = 0;
                            let msg = "正在下载核心...";

                            // Log new file download
                            if (data.payload.url && data.payload.url !== lastFile) {
                                lastFile = data.payload.url;
                                const fileName = lastFile.split('/').pop() || lastFile;
                                setInstallLogs(prev => appendBoundedInstallLog(prev, `> 正在下载 ${fileName}...`));
                            }

                            if (data.payload.total > 0) {
                                percent = Math.round((data.payload.downloaded / data.payload.total) * 100);
                                const mb = (data.payload.downloaded / 1024 / 1024).toFixed(1);
                                const totalMb = (data.payload.total / 1024 / 1024).toFixed(1);
                                msg = `正在下载核心... ${percent}% (${mb}/${totalMb} MB)`;
                            } else {
                                // Fallback for unknown total
                                const mb = (data.payload.downloaded / 1024 / 1024).toFixed(1);
                                msg = `正在下载核心... ${mb} MB`;
                                percent = 50;
                            }
                            setProgress({ percent, message: msg });
                        }
                    } else if (data.eventType === "install_progress") {
                        setProgress({ percent: 100, message: "正在安装..." });
                        // Avoid spamming
                        setInstallLogs(prev => {
                            const last = prev[prev.length - 1];
                            if (last !== "> 正在安装包...") {
                                return appendBoundedInstallLog(prev, "> 正在安装包...");
                            }
                            return prev;
                        });
                    } else {
                        // Log unknown events to help debug
                        setInstallLogs(prev => appendBoundedInstallLog(prev, `> [${data.eventType}] ${JSON.stringify(data.payload || {})}`));
                    }
                } catch (e) {
                    // Log parse errors to UI
                    setInstallLogs(prev => appendBoundedInstallLog(prev, `> [Parse Error] ${(event.payload as string).substring(0, 50)}`));
                }
                });
                if (disposed) {
                    stopJson();
                    return;
                }
                unlistenJson = stopJson;


                const stopFinished = await listen('install-finished', () => {
                    setProgress(null);
                    setInstallLogs([]); // Clear logs on finish
                    setToast(prev => ({ ...prev, show: false })); // Dismiss toast
                    refreshInstalledCores({ invalidateBoardSchemas: true }); // Install/repair may replace boards.txt
                });
                if (disposed) {
                    stopFinished();
                    return;
                }
                unlistenFinished = stopFinished;
            } catch (error) {
                unlistenProgress?.();
                unlistenJson?.();
                unlistenFinished?.();
                unlistenProgress = undefined;
                unlistenJson = undefined;
                unlistenFinished = undefined;
                if (!disposed) console.error('[BoardSelector] Failed to install progress listeners', error);
            }
        };
        void setupListener();
        return () => {
            disposed = true;
            unlistenProgress?.();
            unlistenJson?.();
            unlistenFinished?.();
            unlistenProgress = undefined;
            unlistenJson = undefined;
            unlistenFinished = undefined;
        };
    }, [refreshInstalledCores]);

    useEffect(() => {
        if (!showCoreManager) {
            refreshInstalledCores();
        }
    }, [showCoreManager, refreshInstalledCores]);

    const showToast = (message: string, type: 'info' | 'loading' | 'success' | 'error' = 'info') => {
        setToast({ show: true, message, type });
        if (type !== 'loading') {
            setTimeout(() => setToast(prev => ({ ...prev, show: false })), 3000);
        }
    };

    const finalizeImportedBoard = async (result: any) => {
        // Parse result if it's a JSON string (backend returns serialized board info)
        let boardId = result;
        let qualityReport: BoardPackage['quality_report'];
        if (typeof result === 'string') {
            try {
                if (result.trim().startsWith('{')) {
                    const parsed = JSON.parse(result);
                    boardId = parsed.id;
                    qualityReport = parsed.quality_report;
                }
            } catch (e) {
                console.warn("Failed to parse import result", e);
            }
        } else if ((result as any).id) {
            boardId = (result as any).id;
        }

        showToast("正在刷新开发板列表...", "loading");

        // Force reload context first
        await reloadBoards();

        // Manually fetch to check dependencies
        const { BoardManager } = await import('../services/board_manager');
        const allBoards = await BoardManager.getAllBoards();

        console.log("[Import] Parsed Board ID:", boardId);
        const importedBoard = allBoards.find(b => b.id === boardId);
        console.log("[Import] Found Board:", importedBoard);

        if (!importedBoard) {
            console.error("[Import] Could not find board in registry with ID:", boardId);
            console.log("[Import] Available IDs:", allBoards.map(b => b.id));
            throw new Error(`导入文件已解压，但没有注册到板卡目录：${String(boardId || '未知 ID')}`);
        }

        let compatibilityText = '';
        if (importedBoard.arduino_core) {
                console.log("[Import] Core dependency found:", importedBoard.arduino_core);
                const core = importedBoard.arduino_core;
                showToast(`正在检查核心依赖：${core.package}...`, "loading");

                let compatibility: any;
                try {
                    compatibility = await invoke('check_core_compatibility', {
                        package: core.package,
                        requirement: core,
                    });
                } catch (error) {
                    const message = String(error || '');
                    const commandMissing = /(?:command|invoke)[^\n]*check_core_compatibility[^\n]*(?:not found|not registered)|unknown command[^\n]*check_core_compatibility/i.test(message);
                    if (commandMissing) {
                        // Compatibility with older backends: this only distinguishes
                        // installed/missing and must never be presented as certified.
                        const installed = await invoke('check_core_installed', { package: core.package });
                        compatibility = installed
                            ? { status: 'needs_revalidation', message: '旧版后端只能确认核心已安装，仍需自动复验' }
                            : { status: 'missing', message: '核心尚未安装' };
                    } else {
                        compatibility = { status: 'needs_revalidation', message: `兼容性检查暂不可用：${message}` };
                    }
                }

                if (typeof compatibility === 'string') {
                    try { compatibility = JSON.parse(compatibility); } catch { compatibility = { status: compatibility }; }
                }
                const compatibilityTokens = [
                    compatibility?.compatibility,
                    compatibility?.code,
                    compatibility?.status,
                    compatibility?.state,
                    compatibility?.result,
                ]
                    .map(value => String(value || '').trim().toLowerCase())
                    .filter(Boolean);
                if (compatibilityTokens.length === 0) {
                    compatibilityTokens.push(compatibility === false ? 'missing' : compatibility === true ? 'compatible' : 'unknown');
                }
                const compatibilityMessage = String(compatibility?.message || compatibility?.reason || '').trim();
                const recommendedVersion = core.recommended_version || core.version;
                const missingCore = compatibilityTokens.some(status => status === 'missing' || status === 'core_missing');
                const belowMinimum = compatibilityTokens.includes('below_minimum');
                const knownIncompatible = compatibilityTokens.includes('known_incompatible');
                const shouldInstallRecommended = missingCore || belowMinimum;

                if (shouldInstallRecommended && recommendedVersion) {
                    setProgress({ percent: 0, message: "开始安装核心..." });
                    try {
                        await invoke('install_core', {
                            package: core.package,
                            version: recommendedVersion,
                            indexUrl: core.index_url
                        });
                        showToast(`推荐核心 ${core.package}@${recommendedVersion} 安装成功`, "success");
                    } catch (err) {
                        console.error("Install failed", err);
                        compatibilityText = `，推荐核心安装失败，请在护照中重试`;
                        showToast(`板卡结构已导入，但核心 ${core.package} 安装失败：${String(err)}`, 'error');
                    } finally {
                        setProgress(null);
                    }
                } else if (shouldInstallRecommended) {
                    compatibilityText = `，${compatibilityMessage || `核心 ${core.package} 不满足环境要求`}，请手动安装可用版本`;
                    showToast('板卡结构已导入，但包内未声明推荐核心版本，无法自动修复', 'error');
                } else if (knownIncompatible) {
                    compatibilityText = `，当前核心已知不兼容，请在护照中选择推荐版本`;
                    showToast(compatibilityMessage || '当前核心已知不兼容，未自动替换', 'error');
                } else if (!coreEnvironmentBlocksUse(compatibility) && (compatibility?.requires_revalidation === true || compatibilityTokens.some(status => ['warning', 'incompatible', 'compatible', 'compatible_untested', 'tested_non_recommended', 'needs_revalidation', 'requires_revalidation', 'revalidation_required', 'unverified', 'unverified_compatibility', 'newer_unverified', 'newer_untested', 'above_tested_range', 'above_maximum', 'outside_compatible_range', 'invalid_requirement', 'unparseable_installed_version', 'unknown'].includes(status)))) {
                    compatibilityText = `，警告：核心版本允许继续使用，但需要自动复验`;
                    showToast(compatibilityMessage || `核心 ${core.package} 允许继续使用，但需要自动复验`, 'info');
                } else if (coreEnvironmentBlocksUse(compatibility) || compatibility?.usable === false) {
                    compatibilityText = `，核心环境暂不可用，请查看板卡护照`;
                    showToast(compatibilityMessage || `核心 ${core.package} 暂不可用`, 'error');
                } else {
                    showToast(`核心兼容环境已就绪：${core.package}`, "success");
                }
        } else {
            console.warn("[Import] importedBoard.arduino_core is missing or undefined!", importedBoard);
        }

        // Refresh cores list
        await refreshInstalledCores({ invalidateBoardSchemas: true });
        // Core installation/repair changes the backend compatibility report and
        // usable flag; refresh the board objects after the core list is current.
        await reloadBoards();
        qualityReport = qualityReport || importedBoard.quality_report;
        const warningText = qualityReport?.warning_count ? `，结构检查有 ${qualityReport.warning_count} 项提示` : '，结构检查通过';
        showToast(`开发板 '${boardId}' 导入成功${warningText}${compatibilityText}`, compatibilityText ? "info" : "success");
    };

    const importBoardFromCloudUrl = async (cloudUrl: string) => {
        showToast("正在从云端仓库导入开发板包...", "loading");
        const result = await invoke('import_board_from_github', { url: cloudUrl.trim(), provider: boardRegistryProvider });
        await finalizeImportedBoard(result);
    };

    const fetchCloudBoardCandidates = async (rawUrl: string) => {
        const cleanUrl = String(rawUrl || '').trim();
        if (!cleanUrl) {
            setCloudBoardCandidates([]);
            setCloudBoardError('请先填写仓库地址');
            return;
        }
        localStorage.setItem('ck_board_registry_url', cleanUrl);
        localStorage.setItem('ck_board_registry_provider', boardRegistryProvider);
        setBoardRegistryUrl(cleanUrl);
        setCloudBoardLoading(true);
        setCloudBoardError('');

        try {
            const candidates = await invoke('search_board_packages_from_github', { url: cleanUrl, provider: boardRegistryProvider }) as GithubBoardRegistryEntry[];
            if (!Array.isArray(candidates)) {
                throw new Error('仓库返回格式错误');
            }
            setCloudBoardCandidates(candidates);
            if (candidates.length === 0) {
                setCloudBoardError('仓库中未找到可安装的板卡包');
            }
        } catch (e: any) {
            const msg = String(e?.message || e || '未知错误');
            setCloudBoardCandidates([]);
            setCloudBoardError(msg);
        } finally {
            setCloudBoardLoading(false);
        }
    };

    const handleOpenCloudBoardPicker = async () => {
        const defaultUrl = boardRegistryProvider === 'gitee' ? DEFAULT_BOARD_REPO_URL_GITEE : DEFAULT_BOARD_REPO_URL;
        const cleanUrl = String(boardRegistryUrl || defaultUrl).trim();
        setShowCloudBoardPicker(true);
        setCloudBoardSearch('');
        setCloudBoardCandidates([]);
        setCloudBoardError('');
        await fetchCloudBoardCandidates(cleanUrl);
    };

    const handleRefreshCloudBoards = async () => {
        await fetchCloudBoardCandidates(boardRegistryUrl);
    };

    const handleInstallCloudBoard = async (entry: GithubBoardRegistryEntry) => {
        const key = `${entry.id}@${entry.subdir}`;
        setInstallingCloudBoardKey(key);
        setIsImporting(true);
        try {
            await importBoardFromCloudUrl(entry.tree_url);
        } catch (e) {
            console.error(e);
            showToast('导入失败：' + e, "error");
        } finally {
            setInstallingCloudBoardKey(null);
            setIsImporting(false);
            setProgress(null);
        }
    };

    const handleImport = async () => {
        setIsImporting(true);
        showToast("正在导入本地开发板包...", "loading");
        try {
            const selectedPath = await open({
                multiple: false,
                filters: [{
                    name: '开发板包',
                    extensions: ['zip']
                }]
            });
            if (!(selectedPath && typeof selectedPath === 'string')) {
                setToast(prev => ({ ...prev, show: false }));
                return;
            }
            const result = await invoke('import_board', { path: selectedPath });
            await finalizeImportedBoard(result);
            setShowCloudBoardPicker(false);
        } catch (e) {
            console.error(e);
            showToast('导入失败：' + e, "error");
        } finally {
            setIsImporting(false);
            setProgress(null);
        }
    };

    const handleCreate = async (projectName: string) => {
        if (!projectName.trim() || !selected) return;
        const selectedBoard = availableBoards.find((board) => boardPackageKey(board) === selected) as BoardPackage | undefined;
        if (!selectedBoard) {
            await alert({ title: '板卡不可用', message: '所选板卡已不在目录中，请刷新后重试。', type: 'warning' });
            return;
        }
        const passport = resolveBoardPassport(selectedBoard, installedCoreVersions, { coreListLoading: isLoadingCores });
        if (!passport.canCreateProject) {
            await alert({
                title: '板卡护照存在阻止项',
                message: passport.blockedReason || '请先处理板卡环境或结构问题，再创建工程。',
                type: 'warning'
            });
            return;
        }
        setIsCreating(true);

        // Optimistically set active board
        setActiveBoard(selectedBoard.fqbn, boardPackageKey(selectedBoard));

        try {
            const isTauri = typeof window !== 'undefined' &&
                ((window as any).__TAURI_IPC__ || (window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);

            if (isTauri) {
                const info = await invoke('create_project', {
                    name: projectName,
                    board: selectedBoard.fqbn,
                    boardPackageId: boardPackageKey(selectedBoard),
                    templateId: 'empty'
                }) as { path: string };
                onCreated(info.path, {
                    forceBoard: selectedBoard.fqbn,
                    forceBoardPackageId: boardPackageKey(selectedBoard),
                });
            } else {
                await alert({
                    title: '当前环境不支持',
                    message: '浏览器模式不支持本地工程创建，请在桌面应用中操作。',
                    type: 'warning'
                });
                setIsCreating(false);
                return;
            }
        } catch (e) {
            console.error(e);
            console.error(e);
            alert({
                title: '创建失败',
                message: '无法创建工程: ' + e,
                type: 'error'
            });
            setIsCreating(false); // Only reset if failed
        }
    };

    const handleDelete = async (id: string, name: string) => {
        const deletedBoard = availableBoards.find((board) => board.id === id) as BoardPackage | undefined;
        const confirmed = await confirm(
            {
                title: '删除开发板',
                message: `删除 '${name}'？此操作不可撤销。`,
                type: 'warning',
                confirmLabel: '删除',
                cancelLabel: '取消'
            }
        );

        if (!confirmed) return;

        showToast(`正在删除 '${name}'...`, "loading");
        try {
            // Use BoardManager for robust handling
            const { BoardManager } = await import('../services/board_manager');
            const deletionLog = await BoardManager.deleteBoard(id);
            const warningSummary = summarizeBoardDeletionWarnings(deletionLog);

            await reloadBoards();
            if (warningSummary) {
                showToast(`板卡已删除，但部分清理有警告：${warningSummary}`, "info");
            } else {
                showToast(`已删除 '${name}'`, "success");
            }

            // If deleted board was selected, clear selection
            if (activeBoardPackageId === deletedBoard?.id || selected === deletedBoard?.id) {
                setSelected(null);
                if (deletedBoard?.fqbn) setActiveBoard(deletedBoard.fqbn, deletedBoard.fqbn);
            }
        } catch (e) {
            console.error(e);
            showToast(`删除失败：${e}`, "error");
        }
    };

    // Core Logic
    const handle卸载Core = async (corePackage: string, boardName: string) => {
        const confirmed = await confirm({
            title: '卸载 Core',
            message: `是否卸载核心 '${corePackage}'（开发板：'${boardName}'）？`,
            type: 'warning',
            confirmLabel: '卸载',
            cancelLabel: '取消'
        });

        if (!confirmed) return;

        showToast(`正在卸载核心：${corePackage}...`, "loading");
        try {
            const output = await invoke('uninstall_core', { package: corePackage });
            console.log("卸载 output:", output);
            showToast(`核心 '${corePackage}' 已卸载`, "success");
            await refreshInstalledCores({ invalidateBoardSchemas: true });
            await reloadBoards();
        } catch (e) {
            console.error("卸载 failed", e);
            showToast(`卸载失败: ${e}`, "error");
        }
    };

    const handleInstallCore = async (core: ArduinoCoreConfig, version?: string) => {
        setInstallLogs([]);
        setProgress({ percent: 0, message: "初始化中..." });
        showToast(`正在安装核心：${core.package}...`, "loading");

        try {
            await invoke('install_core', {
                package: core.package,
                version: version || core.recommended_version || core.version,
                indexUrl: core.index_url
            });
            showToast(`核心 '${core.package}' 安装成功`, "success");
            await refreshInstalledCores({ invalidateBoardSchemas: true });
            await reloadBoards();
        } catch (err) {
            console.error("Install failed", err);
            showToast(`核心安装失败：${err}`, "error");
        } finally {
            setProgress(null);
        }
    };

    // Wrapper for Modal
    const handleModalInstall = useCallback(async (coreId: string, version: string, indexUrl?: string) => {
        // Construct a config object on the fly usually, 
        // but handleInstallCore expects ArduinoCoreConfig which has optional fields.
        // We cast or construct minimal valid object.
        const config: ArduinoCoreConfig = { package: coreId, index_url: indexUrl };
        await handleInstallCore(config, version);
    }, [handleInstallCore]);

    const handleModalUninstall = useCallback(async (coreId: string) => {
        await handle卸载Core(coreId, ""); // boardName empty as generic
    }, [handle卸载Core]);

    const handleRefreshBoardPassport = useCallback(async (boardId: string) => {
        showToast('正在刷新板卡护照...', 'loading');
        try {
            await invoke('get_board_passport', { boardId });
            await reloadBoards();
            await refreshInstalledCores();
            showToast('板卡护照已刷新', 'success');
        } catch (error) {
            // Older backends do not expose get_board_passport yet; reloading the
            // catalog still refreshes quality/core information without hiding it.
            console.warn('[BoardPassport] refresh command unavailable', error);
            await reloadBoards();
            await refreshInstalledCores();
            showToast('已刷新本地板卡状态', 'info');
        }
    }, [refreshInstalledCores, reloadBoards]);

    const handleQualifyBoard = async (boardId: string) => {
        const board = availableBoards.find(entry => entry.id === boardId) as BoardPackage | undefined;
        const rawProfiles = (
            board?.passport?.validation_profiles
            ?? board?.manifest?.validation_profiles
            ?? board?.passport?.profiles
            ?? board?.manifest?.profiles
        ) as unknown;
        const declaredProfiles: BoardProfileProgress[] = Array.isArray(rawProfiles)
            ? rawProfiles.map((item: any, index) => ({
                profile: String(item?.name || item?.id || item?.fqbn || `profile-${index + 1}`),
                status: 'pending' as const,
                index: index + 1,
                total: rawProfiles.length,
            }))
            : [{ profile: board?.fqbn_base || board?.fqbn || '默认配置', status: 'running' }];
        setQualificationByBoard(previous => ({
            ...previous,
            [boardId]: { running: true, profiles: declaredProfiles },
        }));
        showToast('正在自动编译验证板卡声明配置...', 'loading');

        try {
            let result: any = await invoke('qualify_board_profiles', { boardId });
            if (typeof result === 'string') {
                try { result = JSON.parse(result); } catch { result = { message: result }; }
            }
            const returnedProfiles = result?.profiles ?? result?.results ?? result?.passport?.profiles;
            const normalizedReturnedProfiles: BoardProfileProgress[] = Array.isArray(returnedProfiles)
                ? returnedProfiles.map((item: any, index: number) => ({
                    profile: String(item?.name || item?.profile || item?.profile_id || item?.profileId || item?.id || item?.fqbn || `profile-${index + 1}`),
                    status: qualificationStatusFrom(
                        item?.status || item?.state,
                        result?.core ?? result?.passport?.core ?? board?.core_status,
                    ),
                    message: String(item?.message || item?.reason || '').trim() || undefined,
                    index: index + 1,
                    total: returnedProfiles.length,
                }))
                : [];
            setQualificationByBoard(previous => {
                const current = previous[boardId] || { running: true, profiles: declaredProfiles };
                const profiles = normalizedReturnedProfiles.length > 0 ? normalizedReturnedProfiles : current.profiles;
                return { ...previous, [boardId]: { running: false, profiles } };
            });
            await reloadBoards();
            const overallStatus = qualificationStatusFrom(
                result?.status,
                result?.core ?? result?.passport?.core ?? board?.core_status,
            );
            const failed = overallStatus === 'failed' || normalizedReturnedProfiles.some(profile => profile.status === 'failed');
            const warned = overallStatus === 'warning' || normalizedReturnedProfiles.some(profile => profile.status === 'warning');
            showToast(
                failed ? '板卡声明配置验证完成，但存在失败项' : warned ? '板卡声明配置可继续使用，但仍有复验提示' : '板卡声明配置自动验证已完成',
                failed ? 'error' : warned ? 'info' : 'success',
            );
        } catch (error) {
            const message = String(error || '未知错误');
            const commandMissing = /(?:command|invoke)[^\n]*qualify_board_profiles[^\n]*(?:not found|not registered)|unknown command[^\n]*qualify_board_profiles/i.test(message);
            setQualificationByBoard(previous => {
                const current = previous[boardId] || { running: false, profiles: declaredProfiles };
                const profiles = current.profiles.map((profile, index) => index === 0
                    ? { ...profile, status: commandMissing ? 'warning' as const : 'failed' as const, message }
                    : profile);
                return { ...previous, [boardId]: { running: false, profiles } };
            });
            showToast(commandMissing ? '当前后端尚未提供自动验证命令，已保留待复验状态' : `自动验证失败：${message}`, commandMissing ? 'info' : 'error');
        }
    };

    const selectedBoard = availableBoards.find((board) => boardPackageKey(board) === selected) as BoardPackage | undefined;
    const selectedPassport = selectedBoard
        ? resolveBoardPassport(selectedBoard, installedCoreVersions, { coreListLoading: isLoadingCores })
        : undefined;

    return (
        <div className="h-screen flex flex-col bg-[#f7f9fc] text-slate-800 overflow-hidden dark:bg-slate-950 dark:text-slate-100">
            {/* Header */}
            <header className="h-[60px] bg-[#fbfcfe] border-b border-[#dce3ec] flex items-center justify-between px-4 flex-shrink-0 z-10 dark:border-slate-800 dark:bg-slate-900">
                <div className="flex items-center gap-3 min-w-0">
                    <button onClick={onBack} className="h-9 px-2 flex items-center justify-center gap-1 hover:bg-slate-100 rounded-md transition-colors text-slate-500 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white" title="返回工程列表">
                        <ArrowLeft size={19} />
                        <span className="text-xs font-bold">返回</span>
                    </button>
                    <div className="w-9 h-9 bg-[#0f766e] rounded-md flex items-center justify-center text-white">
                        <CircuitBoard size={17} />
                    </div>
                    <div className="flex flex-col leading-none">
                        <h1 className="text-sm font-bold text-slate-900 dark:text-slate-100">新建工程</h1>
                        <span className="text-[10px] text-slate-400 mt-1.5">硬件目标</span>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <ThemeModeControl />
                    <div className="flex items-center h-9 p-0.5 bg-[#f1f4f8] border border-[#e1e7ef] rounded-md dark:border-slate-700 dark:bg-slate-800">
                        <button
                            onClick={handleOpenCloudBoardPicker}
                            className="h-8 px-3 rounded text-slate-500 hover:bg-white hover:text-slate-900 transition-colors text-xs font-bold flex items-center gap-2 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white"
                            title={boardRegistryUrl}
                        >
                            <Link size={15} />
                            <span>第三方板卡</span>
                        </button>

                        <button
                            onClick={() => setShowCoreManager(true)}
                            className="h-8 px-3 rounded text-slate-500 hover:bg-white hover:text-slate-900 transition-colors text-xs font-bold flex items-center gap-2 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white"
                        >
                            <Package size={15} />
                            <span>核心管理</span>
                        </button>
                    </div>
                </div>
            </header>

            {/* Content */}
            <main className="flex-1 overflow-y-auto">
                <div className="max-w-[1440px] mx-auto px-5 py-5">
                    <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-4">
                        <div className="flex items-end gap-3">
                            <div>
                                <span className="text-[9px] font-bold text-[#0f8f83] uppercase">Board catalog</span>
                                <h2 className="text-base font-bold text-slate-900 mt-1 dark:text-slate-100">选择目标板</h2>
                            </div>
                            <span className="text-[10px] font-mono text-slate-400 pb-0.5">{filteredBoards.length} / {availableBoards.length}</span>
                        </div>

                        {/* Search Bar */}
                        <div className="relative group w-full md:w-[360px]">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-[#0f8f83] transition-colors" size={16} />
                            <input
                                type="text"
                                placeholder="搜索开发板型号..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="w-full h-10 pl-9 pr-3 bg-white border border-[#d7dfe9] rounded-md focus:border-[#0f8f83] outline-none transition-colors placeholder:text-slate-400 text-xs font-medium text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                            />
                        </div>
                    </div>

                    {/* Category Filter */}
                    <div className="h-10 flex items-end gap-1 mb-2 border-b border-[#dce3ec] overflow-x-auto dark:border-slate-800">
                        {dynamicCategories.map(cat => (
                            <button
                                key={cat}
                                onClick={() => setActiveCategory(cat)}
                                className={`
                                    h-10 px-4 text-xs font-bold transition-colors border-b-2 shrink-0
                                    ${activeCategory === cat
                                        ? 'text-[#0f766e] border-[#0f8f83] bg-[#eaf6f4] dark:bg-teal-950/45 dark:text-teal-300'
                                        : 'text-slate-500 border-transparent hover:text-slate-900 hover:bg-white dark:text-slate-400 dark:hover:bg-slate-900 dark:hover:text-slate-100'}
                                `}
                            >
                                {cat === 'All' ? '全部' : cat}
                            </button>
                        ))}
                    </div>

                    <div className="mb-4 flex min-h-8 flex-wrap items-center gap-2 rounded-md border border-[#dce3ec] bg-white px-2.5 py-1.5 dark:border-slate-800 dark:bg-slate-900">
                        <span className="mr-1 text-[10px] font-bold text-slate-500 dark:text-slate-300">护照筛选</span>
                        <label className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded border px-2 text-[10px] font-semibold transition-colors ${onlyDeviceVerified ? 'border-teal-300 bg-teal-50 text-teal-700 dark:border-teal-800 dark:bg-teal-950/45 dark:text-teal-300' : 'border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800'}`} title="仅显示已有真板验证证据的板卡">
                            <input
                                type="checkbox"
                                checked={onlyDeviceVerified}
                                onChange={(event) => setOnlyDeviceVerified(event.target.checked)}
                                className="h-3 w-3 accent-[#0f8f83]"
                            />
                            真板已验证
                        </label>
                        <label className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded border px-2 text-[10px] font-semibold transition-colors ${onlyEnvironmentUsable ? 'border-teal-300 bg-teal-50 text-teal-700 dark:border-teal-800 dark:bg-teal-950/45 dark:text-teal-300' : 'border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800'}`} title="警告状态仍属于可用；仅排除真正阻止使用的环境">
                            <input
                                type="checkbox"
                                checked={onlyEnvironmentUsable}
                                onChange={(event) => setOnlyEnvironmentUsable(event.target.checked)}
                                className="h-3 w-3 accent-[#0f8f83]"
                            />
                            环境可用（含警告）
                        </label>
                        <label className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded border px-2 text-[10px] font-semibold transition-colors ${onlyRecommendedCore ? 'border-teal-300 bg-teal-50 text-teal-700 dark:border-teal-800 dark:bg-teal-950/45 dark:text-teal-300' : 'border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800'}`} title="仅显示当前 Core 与板卡包推荐版本一致的板卡">
                            <input
                                type="checkbox"
                                checked={onlyRecommendedCore}
                                onChange={(event) => setOnlyRecommendedCore(event.target.checked)}
                                className="h-3 w-3 accent-[#0f8f83]"
                            />
                            正在使用推荐 Core
                        </label>
                        <label className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded border px-2 text-[10px] font-semibold transition-colors ${showExpiredCertifications ? 'border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800' : 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/45 dark:text-amber-300'}`} title="关闭后隐藏需要重新认证的板卡">
                            <input
                                type="checkbox"
                                checked={showExpiredCertifications}
                                onChange={(event) => setShowExpiredCertifications(event.target.checked)}
                                className="h-3 w-3 accent-[#0f8f83]"
                            />
                            显示过期认证
                        </label>
                        {hasPassportFilters && (
                            <button
                                type="button"
                                onClick={() => {
                                    setOnlyDeviceVerified(false);
                                    setOnlyEnvironmentUsable(false);
                                    setOnlyRecommendedCore(false);
                                    setShowExpiredCertifications(true);
                                }}
                                className="ml-auto h-7 rounded px-2 text-[10px] font-bold text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                            >
                                重置护照筛选
                            </button>
                        )}
                    </div>

                    <BoardGrid
                        boards={filteredBoards as BoardPackage[]}
                        selected={selected}
                        onSelect={setSelected}
                        onDelete={handleDelete}
                        onInstallCore={handleInstallCore}
                        onRefreshPassport={handleRefreshBoardPassport}
                        onQualify={handleQualifyBoard}
                        qualificationByBoard={qualificationByBoard}
                        installedCoreVersions={installedCoreVersions}
                        isLoadingCores={isLoadingCores}
                    />
                </div>
            </main>

            {/* Footer with Input */}
            <CreateProjectFooter
                isBoardSelected={!!selected}
                canCreateProject={!!selectedPassport?.canCreateProject}
                blockedReason={selectedPassport?.blockedReason}
                selectedBoardName={selectedBoard?.name}
                onCreate={handleCreate}
                isCreating={isCreating}
                onBack={onBack}
            />

            <CoreManagerModal
                isOpen={showCoreManager}
                onClose={() => setShowCoreManager(false)}
                onInstall={handleModalInstall}
                onUninstall={handleModalUninstall}
            />

            <Toast
                message={toast.message}
                type={toast.type}
                show={toast.show}
                onClose={() => setToast(prev => ({ ...prev, show: false }))}
            />

            {showCloudBoardPicker && (
                <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/50">
                    <div className="w-[920px] max-w-[96vw] max-h-[88vh] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-2xl flex flex-col overflow-hidden">
                        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <h3 className="text-base font-bold text-slate-800 dark:text-slate-100 truncate">导入第三方板卡</h3>
                                <p className="text-xs text-slate-500 dark:text-slate-400 truncate" title={boardRegistryUrl}>
                                    仓库：{boardRegistryUrl}
                                </p>
                            </div>
                            <button
                                onClick={() => {
                                    if (installingCloudBoardKey) return;
                                    setShowCloudBoardPicker(false);
                                }}
                                className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"
                            >
                                关闭
                            </button>
                        </div>

                        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 space-y-3">
                            <div className="rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-[10px] leading-relaxed text-teal-800 dark:border-teal-900 dark:bg-teal-950/35 dark:text-teal-200">
                                <span className="font-bold">自动质量检查：</span>
                                本地 ZIP 与仓库包使用同一套目录、路径安全、依赖、许可证、兼容性和内容哈希规则。确定性错误会阻止导入；通过或警告仅代表本机静态检查，不代表 CK 官方背书或真板认证。
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="relative flex-1">
                                    <Link className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                                    <input
                                        type="text"
                                        value={boardRegistryUrl}
                                        onChange={(e) => setBoardRegistryUrl(e.target.value)}
                                        placeholder={boardRegistryProvider === 'gitee' ? "https://gitee.com/owner/repo.git" : "https://github.com/owner/repo.git"}
                                        className="w-full pl-9 pr-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 outline-none focus:ring-2 focus:ring-teal-500"
                                    />
                                </div>
                                <select
                                    value={boardRegistryProvider}
                                    onChange={(e) => {
                                        const next = e.target.value as CloudProvider;
                                        setBoardRegistryProvider(next);
                                        localStorage.setItem('ck_board_registry_provider', next);
                                        const current = String(boardRegistryUrl || '').trim();
                                        const githubDefault = DEFAULT_BOARD_REPO_URL;
                                        const giteeDefault = DEFAULT_BOARD_REPO_URL_GITEE;
                                        if (!current || current === githubDefault || current === giteeDefault) {
                                            const nextUrl = next === 'gitee' ? giteeDefault : githubDefault;
                                            setBoardRegistryUrl(nextUrl);
                                            localStorage.setItem('ck_board_registry_url', nextUrl);
                                        }
                                    }}
                                    className="h-[38px] px-2 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs text-slate-700 dark:text-slate-200 outline-none focus:ring-2 focus:ring-teal-500"
                                >
                                    <option value="auto">自动</option>
                                    <option value="github">GitHub</option>
                                    <option value="gitee">Gitee</option>
                                </select>
                                <button
                                    onClick={handleRefreshCloudBoards}
                                    disabled={cloudBoardLoading || !!installingCloudBoardKey}
                                    className={`px-3 py-2 rounded-lg text-xs font-bold flex items-center gap-2 ${cloudBoardLoading
                                        ? 'bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-300'
                                        : 'bg-teal-600 hover:bg-teal-700 text-white'}`}
                                >
                                    {cloudBoardLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                                    {cloudBoardLoading ? '加载中...' : '刷新列表'}
                                </button>
                                <button
                                    onClick={handleImport}
                                    disabled={isImporting || !!installingCloudBoardKey}
                                    className="px-3 py-2 rounded-lg text-xs font-bold flex items-center gap-2 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                                >
                                    {isImporting ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                                    {isImporting ? '导入中...' : '选择本地 ZIP'}
                                </button>
                            </div>

                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                                <input
                                    type="text"
                                    value={cloudBoardSearch}
                                    onChange={(e) => setCloudBoardSearch(e.target.value)}
                                    placeholder="搜索板卡包名称 / ID / FQBN"
                                    className="w-full pl-9 pr-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 outline-none focus:ring-2 focus:ring-teal-500"
                                />
                            </div>
                            {cloudBoardError && (
                                <p className="text-xs text-rose-500">{cloudBoardError}</p>
                            )}
                            {!cloudBoardError && (
                                <p className="text-xs text-slate-500 dark:text-slate-400">
                                    共找到 {cloudBoardCandidates.length} 个板卡包
                                </p>
                            )}
                        </div>

                        <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
                            {!cloudBoardLoading && filteredCloudBoardCandidates.length === 0 && (
                                <div className="h-full flex items-center justify-center text-sm text-slate-400">
                                    没有匹配的开发板包
                                </div>
                            )}

                            {filteredCloudBoardCandidates.map((entry) => {
                                const key = `${entry.id}@${entry.subdir}`;
                                const installing = installingCloudBoardKey === key;
                                const installed = installedBoardIdSet.has(String(entry.id || '').trim().toLowerCase());
                                return (
                                    <div
                                        key={key}
                                        className="bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-200 dark:border-slate-700 p-4 flex items-start gap-3"
                                    >
                                        <div className="w-10 h-10 rounded-lg bg-teal-100 dark:bg-teal-900/40 text-teal-600 dark:text-teal-300 flex items-center justify-center shrink-0">
                                            <Package size={18} />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <h4 className="text-sm font-bold text-slate-800 dark:text-slate-100 truncate">{entry.name}</h4>
                                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 font-mono">
                                                    {entry.id}
                                                </span>
                                                {entry.fqbn_base && (
                                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 font-mono">
                                                        {entry.fqbn_base}
                                                    </span>
                                                )}
                                            </div>
                                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-2">
                                                {entry.description || "无描述"}
                                            </p>
                                            <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1 font-mono truncate" title={entry.subdir || '.'}>
                                                子路径：{entry.subdir || '.'}
                                            </p>
                                        </div>
                                        <button
                                            onClick={() => handleInstallCloudBoard(entry)}
                                            disabled={!!installingCloudBoardKey || installed}
                                            className={`px-3 py-2 rounded-lg text-xs font-bold transition-all shrink-0 flex items-center gap-2 ${installing
                                                ? 'bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-300'
                                                : installed
                                                    ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300'
                                                    : 'bg-teal-600 hover:bg-teal-700 text-white'}`}
                                        >
                                            {installing ? <Loader2 size={14} className="animate-spin" /> : <DownloadCloud size={14} />}
                                            {installing ? '安装中...' : installed ? '已安装' : '安装'}
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}

            {/* Progress / Log Overlay - Only Terminal Style */}
            {progress && (
                <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60">
                    <div className="bg-[#1e1e1e] w-[700px] h-[500px] rounded-xl border border-gray-700 flex flex-col shadow-2xl animate-in zoom-in-95 duration-200 overflow-hidden">
                        {/* Terminal Header */}
                        <div className="px-4 py-3 border-b border-gray-700 flex justify-between items-center bg-[#2d2d2d] select-none">
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full bg-[#ff5f56]" />
                                <div className="w-3 h-3 rounded-full bg-[#ffbd2e]" />
                                <div className="w-3 h-3 rounded-full bg-[#27c93f]" />
                                <span className="ml-3 text-gray-300 font-medium text-xs font-mono tracking-wide">终端输出日志</span>
                            </div>
                            <div className="flex items-center gap-2 text-emerald-500">
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                <span className="text-xs font-mono">正在运行...</span>
                            </div>
                        </div>

                        {/* Terminal Content */}
                        <div
                            className="flex-1 p-4 overflow-y-auto font-mono text-xs text-gray-300 space-y-1 bg-[#1e1e1e] select-text custom-scrollbar text-left"
                        >
                            {installLogs.length === 0 && <span className="text-gray-500 italic">等待进程响应...</span>}
                            {installLogs.map((log, i) => (
                                <div key={i} className="break-all border-l-2 border-transparent pl-2 hover:bg-[#252525]">
                                    <span className="text-emerald-500/50 mr-2 select-none">$</span>
                                    <span className={log.includes("Error") || log.includes("fail") ? "text-red-400" : ""}>{log}</span>
                                </div>
                            ))}
                            <div ref={logsEndRef} />
                        </div>

                        <div className="p-2 bg-[#2d2d2d] border-t border-gray-700 flex justify-end">
                            <button
                                onClick={async () => {
                                    try {
                                        await invoke('cancel_core_install');
                                        // Also try to clean cache if user wants "stop and clean"
                                        // await invoke('clean_cache');
                                    } catch (e) {
                                        console.error("Failed to cancel", e);
                                    } finally {
                                        setProgress(null);
                                    }
                                }}
                                className="px-3 py-1.5 bg-[#3a3a3a] hover:bg-[#454545] text-gray-300 hover:text-white text-xs rounded border border-gray-600 transition-colors flex items-center gap-2"
                            >
                                <span className="w-2 h-2 rounded-full bg-red-400"></span>
                                强制关闭
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}





