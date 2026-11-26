import { useState, memo, useEffect, useCallback, useRef, useMemo } from 'react';
import { ArrowLeft, Check, ChevronDown, CircuitBoard, Loader2, Upload, Trash2, Package, DownloadCloud, Search, Link, RefreshCw, ShieldCheck, AlertTriangle, CircleDot, LayoutGrid, Building2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CoreManagerModal } from './CoreManagerModal';
import { BrandLogo } from './BrandLogo';
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
import { boardCardPassportStages, resolveBoardActivity, type BoardSuccess } from '../services/board_activity';
import { projectHealthCapabilities } from '../services/project_health_capabilities';
import { boardPackageKey } from '../services/board_identity';
import { summarizeBoardDeletionWarnings } from '../services/board_delete_feedback';
import {
    resolveForgeCoreSupport,
    type ForgeCoreSupportStatus,
} from '../services/ck_forge_core_support';
import {
    boardCategoryId,
    boardCatalogCategories,
    type CatalogCategory,
    type CatalogCategoryId,
    coreInstallPhaseForEventType,
    shouldAppendCoreInstallPhaseLog,
    type BoardCategoryId,
    type CoreInstallPhase,
    type CoreInstallProgress,
} from '../services/board_selector_identity';

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

const BOARD_CATEGORY_LABEL_KEYS: Record<BoardCategoryId, string> = {
    all: 'boardSelector.category.all',
    custom: 'boardSelector.category.custom',
    esp32: 'boardSelector.category.esp32',
    arduino: 'boardSelector.category.arduino',
    other: 'boardSelector.category.other',
};

type UiTranslator = (...args: any[]) => string;

function CatalogIcon({ category }: { category: CatalogCategory }) {
    const [failed, setFailed] = useState<string>();
    const builtin = category.id === 'arduino' ? 'arduino' : category.id === 'esp32' ? 'espressif' : undefined;
    let url = builtin ? `/brand/vendors/${builtin}.svg` : undefined;
    if (!url && category.logoPath) {
        try { url = convertFileSrc(category.logoPath); } catch { /* Browser without a native bridge */ }
    }
    if (url && url !== failed) {
        return <span className="inline-flex size-6 shrink-0 items-center justify-center rounded bg-white">
            <img src={url} alt="" className="size-5 object-contain" onError={() => setFailed(url)} />
        </span>;
    }
    const Icon = category.id === 'all' ? LayoutGrid : category.id === 'custom' ? Package :
        category.id.startsWith('vendor:') ? Building2 : CircuitBoard;
    return <span className="inline-flex size-6 shrink-0 items-center justify-center"><Icon size={17} aria-hidden="true" /></span>;
}

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
    expirationReasonCodes: string[];
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

const formatPassportDate = (value: string | undefined, locale: string = 'zh-CN'): string | undefined => {
    if (!value) return undefined;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return value;
    return new Intl.DateTimeFormat(locale === 'en-US' ? 'en-US' : 'zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(new Date(timestamp));
};

const expirationReasonLabel = (reason: string, t: UiTranslator): string => {
    const key = `boardSelector.passport.expiration.${reason}`;
    const translated = t(key, { reason });
    return translated === key ? t('boardSelector.passport.expiration.unknown', { reason }) : translated;
};

const passportStageDisplayLabel = (item: PassportStageView, t: UiTranslator): string => {
    const key = `boardSelector.passport.stage.${item.id}.${item.status}`;
    const translated = t(key);
    return translated === key ? item.status : translated;
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
    const lastVerifiedAt = checkedTimes[0]?.raw;

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
    const expirationReasonCodes = [...new Set(rawReasons)];
    if (isExpired && expirationReasonCodes.length === 0) {
        expirationReasonCodes.push('unknown');
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
        expirationReasonCodes,
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
    return 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300';
};

const forgeCoreSupportLabel = (status: ForgeCoreSupportStatus, t: UiTranslator): string => {
    if (status === 'certified-evidence-available') return t('boardSelector.passport.forge.certified');
    if (status === 'local-certification-required') return t('boardSelector.passport.forge.revalidation');
    return t('boardSelector.passport.forge.unavailable');
};

const forgeCoreSupportDetail = (
    support: ReturnType<typeof resolveForgeCoreSupport>,
    t: UiTranslator,
): string => {
    if (support.status === 'certified-evidence-available') {
        return t('boardSelector.passport.forge.certifiedDetail', {
            versions: support.certifiedCoreVersions.join(', '),
        });
    }
    if (support.status === 'local-certification-required') {
        return t('boardSelector.passport.forge.revalidationDetail', {
            version: support.currentCoreVersion || t('boardSelector.passport.notInstalled'),
        });
    }
    return t('boardSelector.passport.forge.unavailableDetail');
};

// Memoized Board Grid to prevent re-renders when parent state changes
const BoardGrid = memo(({ boards, activity, activityState, selected, onSelect, onDelete, onInstallCore, onRefreshPassport, onQualify, qualificationByBoard, installedCoreVersions, isLoadingCores }: {
    boards: BoardPackage[],
    activity: BoardSuccess[],
    activityState: "loading" | "ready" | "error",
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
    const { t, i18n } = useTranslation();

    if (boards.length === 0) {
        return (
            <div className="min-h-[260px] flex flex-col items-center justify-center border border-dashed border-[#ccd5e1] bg-white text-slate-400 rounded-md dark:border-slate-700 dark:bg-slate-900">
                <CircuitBoard size={28} strokeWidth={1.5} className="mb-3" />
                <p className="text-sm font-medium">{t('boardSelector.empty.scanning')}</p>
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
                const visibleStages = boardCardPassportStages(board, passport);
                const observations = resolveBoardActivity(board, passport.installedCoreVersion, activity);
                const observationLabel = (item: typeof observations[number]) => (t as UiTranslator)(
                    activityState !== 'ready' ? 'boardSelector.activity.' + activityState
                        : 'boardSelector.activity.' + item.operation + (item.count ? 'Passed' : 'Pending'),
                    { count: item.count },
                );
                const observationDetail = (item: typeof observations[number]) => item.history.map(record =>
                    record.fqbn + ' · Core ' + record.coreVersion + ' · ' + formatPassportDate(record.completedAt, i18n.resolvedLanguage)
                ).join('\n') || t('boardSelector.activity.noRecord');
                const showDeviceDetails = !!board.is_custom && projectHealthCapabilities(board.fqbn_base || board.fqbn).deviceHealth;
                const coreId = board.arduino_core?.package;
                const forgeCoreSupport = resolveForgeCoreSupport(
                    board.fqbn_base || board.fqbn,
                    passport.installedCoreVersion,
                );
                const forgeLabel = forgeCoreSupportLabel(forgeCoreSupport.status, t);
                const forgeDetail = forgeCoreSupportDetail(forgeCoreSupport, t);
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
                        data-ck-role="board-card"
                        data-ck-board-id={packageKey}
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
                                ? 'bg-[#e9f6f4] border-[#7fc6bd] dark:bg-brand-950/45 dark:border-brand-700'
                                : 'bg-white border-[#dce3ec] hover:border-[#9fb0c4] hover:bg-[#fbfcfe] dark:bg-slate-900 dark:border-slate-700 dark:hover:border-slate-500 dark:hover:bg-slate-800'}
                            ${!passport.canCreateProject ? 'border-rose-200 dark:border-rose-900/80' : ''}
                        `}
                    >
                        <span className={`absolute inset-y-0 left-0 w-[3px] transition-colors ${isSelected ? 'bg-brand-600' : 'bg-transparent group-hover:bg-[#c5d0dc]'}`} />

                        {isCustom && (
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onDelete(board.id, board.name);
                                }}
                                className="absolute top-2 right-9 h-7 px-2 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded flex items-center justify-center gap-1 transition-colors z-20 bg-white/90 border border-slate-200 text-[9px] font-bold dark:border-slate-700 dark:bg-slate-800/95 dark:text-slate-300 dark:hover:bg-red-950/40 dark:hover:text-red-300"
                                title={t('boardSelector.actions.deleteCustomBoard')}
                                aria-label={`${t('boardSelector.actions.deleteCustomBoard')} ${board.name}`}
                            >
                                <Trash2 size={14} />
                                <span>{t('common.actions.delete')}</span>
                            </button>
                        )}

                        <div className="p-3 pl-4 flex items-center gap-3">
                            <div className={`w-[78px] h-[74px] shrink-0 rounded border flex items-center justify-center overflow-hidden transition-colors ${isSelected ? 'bg-white border-brand-200 dark:bg-slate-800 dark:border-brand-800' : 'bg-[#f4f6f9] border-[#e4e9f0] dark:bg-slate-800 dark:border-slate-700'} ${showMissing ? 'opacity-55 grayscale' : ''}`}>
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
                                        {passportStageDisplayLabel(structure, t)}
                                    </span>
                                    {!passport.canCreateProject && (
                                        <span className="shrink-0 inline-flex items-center gap-1 text-[9px] bg-rose-50 text-rose-700 px-1.5 py-0.5 rounded border border-rose-200 font-bold dark:border-rose-900 dark:bg-rose-950/45 dark:text-rose-300">
                                            <AlertTriangle size={10} /> {t('boardSelector.status.unavailable')}
                                        </span>
                                    )}
                                </div>
                                <p className="mt-1 text-[10px] font-mono text-slate-400 truncate" title={displayFqbn || t('boardSelector.empty.notDeclared')}>
                                    {displayFqbn || t('boardSelector.empty.notDeclared')}
                                </p>
                                <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                                    {visibleStages.map(item => (
                                        <span
                                            key={item.id}
                                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-semibold ${passportTone(item.status)}`}
                                            title={item.summary}
                                        >
                                            <CircleDot size={8} /> {passportStageDisplayLabel(item, t)}
                                        </span>
                                    ))}
                                    {observations.map(item => (
                                        <span key={item.operation}
                                            data-ck-role={'board-activity-' + item.operation}
                                            data-status={activityState === 'ready' && item.count ? 'passed' : 'pending'}
                                            className={'inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-semibold ' + passportTone(activityState === 'ready' && item.count ? 'passed' : 'pending')}
                                            title={observationDetail(item)}>
                                            <CircleDot size={8} /> {observationLabel(item)}
                                        </span>
                                    ))}
                                    <span
                                        data-ck-role="board-flfe-core-status"
                                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-semibold ${forgeCoreSupportTone(forgeCoreSupport.status)}`}
                                        title={forgeDetail}
                                    >
                                        <CircleDot size={8} /> {forgeLabel}
                                    </span>
                                </div>
                                <div className="mt-2 flex items-center justify-between gap-2">
                                    <p className="text-[10px] text-slate-400 truncate">
                                        {[board.vendor || board.author, board.version ? `v${board.version}` : '', t('boardSelector.meta.pinCount', { count: board.pins.length })].filter(Boolean).join(' · ') || t('boardSelector.empty.pendingInfo')}
                                    </p>
                                    <button
                                        type="button"
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            setExpandedBoardId(current => current === board.id ? null : board.id);
                                        }}
                                        className="shrink-0 inline-flex items-center gap-1 text-[10px] font-bold text-[var(--accent)] hover:text-brand-800 dark:text-brand-300"
                                        aria-expanded={expanded}
                                    >
                                        {t('boardSelector.passport.details')}
                                        <ChevronDown size={12} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
                                    </button>
                                </div>
                            </div>
                        </div>

                        {isSelected && (
                            <span className="absolute top-3 right-3 w-5 h-5 rounded-full bg-brand-600 text-white flex items-center justify-center">
                                <Check size={12} strokeWidth={3} />
                            </span>
                        )}

                        {expanded && (
                            <div
                                className="border-t border-slate-200 bg-slate-50/80 px-4 py-3 dark:border-slate-700 dark:bg-slate-950/35"
                                onClick={(event) => event.stopPropagation()}
                            >
                                <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
                                    {visibleStages.map(item => (
                                        <div key={item.id} className="flex items-start gap-2 rounded border border-slate-200 bg-white px-2.5 py-2 dark:border-slate-700 dark:bg-slate-900">
                                            <span className={`mt-0.5 w-2 h-2 rounded-full ${item.status === 'passed' ? 'bg-emerald-500' : item.status === 'warning' ? 'bg-amber-500' : item.status === 'failed' ? 'bg-rose-500' : 'bg-slate-400'}`} />
                                            <div className="min-w-0">
                                                <p className="text-[10px] font-bold text-slate-700 dark:text-slate-200">{passportStageDisplayLabel(item, t)}</p>
                                                <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">{item.summary}</p>
                                                {item.detail && <p className="mt-0.5 text-[9px] text-slate-400">{item.detail}</p>}
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                <div className="mt-3 rounded border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900" data-ck-role="board-activity-details">
                                    <p className="text-[10px] font-bold text-slate-700 dark:text-slate-200">{t('boardSelector.activity.title')}</p>
                                    <p className="mt-1 text-[10px] text-slate-500">{t('boardSelector.activity.scope')}</p>
                                    {observations.map(item => (
                                        <div key={item.operation} className="mt-2 text-[10px]">
                                            <p className="font-semibold">{observationLabel(item)}</p>
                                            <p className="whitespace-pre-wrap break-all font-mono text-slate-500">{observationDetail(item)}</p>
                                        </div>
                                    ))}
                                </div>
                                {(board.is_custom || board.quality_report) && (
                                    <div className="mt-3">
                                        <PackageQualityReportPanel
                                            report={board.quality_report}
                                            metadataVersion={(board.manifest as any)?.schema_version}
                                            sourceLabel={board.is_custom ? t('boardSelector.passport.sourceCustom') : t('boardSelector.passport.sourceBundled')}
                                            compact
                                        />
                                    </div>
                                )}

                                <dl className="mt-3 grid grid-cols-[92px_1fr] gap-x-2 gap-y-1 text-[10px]">
                                    <dt className="text-slate-400">{t('boardSelector.passport.completeFqbn')}</dt>
                                    <dd className="space-y-0.5 font-mono text-slate-600 dark:text-slate-300 break-all">
                                        {facts.completeFqbns.length > 0
                                            ? facts.completeFqbns.map(fqbn => <div key={fqbn}>{fqbn}</div>)
                                            : t('boardSelector.passport.notDeclared')}
                                    </dd>
                                    <dt className="text-slate-400">{t('boardSelector.passport.package')}</dt>
                                    <dd className="text-slate-600 dark:text-slate-300">{[board.vendor || board.author || t('boardSelector.passport.sourceUndeclared'), board.version ? `v${board.version}` : t('boardSelector.passport.versionNotDeclared')].join(' · ')}</dd>
                                    <dt className="text-slate-400">{t('boardSelector.passport.currentCore')}</dt>
                                    <dd className="text-slate-600 dark:text-slate-300">
                                        {coreId || t('boardSelector.passport.notDeclared')}
                                        {passport.installedCoreVersion ? ` @ ${passport.installedCoreVersion}` : ` · ${t('boardSelector.passport.notInstalled')}`}
                                    </dd>
                                    <dt className="text-slate-400">{t('boardSelector.passport.recommendedCore')}</dt>
                                    <dd className="text-slate-600 dark:text-slate-300">{passport.recommendedCoreVersion || t('boardSelector.passport.revalidateOther')}</dd>
                                    <dt className="text-slate-400">{t('boardSelector.passport.flfe')}</dt>
                                    <dd className="text-slate-600 dark:text-slate-300">
                                        <span className={`inline-flex rounded border px-1.5 py-0.5 text-[9px] font-bold ${forgeCoreSupportTone(forgeCoreSupport.status)}`}>
                                            {forgeLabel}
                                        </span>
                                        <p className="mt-1 leading-4 text-slate-500 dark:text-slate-400">{forgeDetail}</p>
                                    </dd>
                                    {board.is_custom && <>
                                    <dt className="text-slate-400">{t('boardSelector.passport.verifiedCore')}</dt>
                                    <dd className="text-slate-600 dark:text-slate-300">{facts.verifiedCoreVersions.length > 0 ? facts.verifiedCoreVersions.join('、') : t('boardSelector.passport.noDeviceRecord')}</dd>
                                    <dt className="text-slate-400">{t('boardSelector.passport.lastVerified')}</dt>
                                    <dd className="text-slate-600 dark:text-slate-300">{facts.lastVerifiedAt ? formatPassportDate(facts.lastVerifiedAt, i18n.resolvedLanguage) : t('boardSelector.passport.noVerificationTime')}</dd>
                                    </>}
                                    {showDeviceDetails && <>
                                        <dt className="text-slate-400">{t('boardSelector.passport.deviceModel')}</dt>
                                        <dd className="text-slate-600 dark:text-slate-300">{facts.deviceModels.length > 0 ? facts.deviceModels.join('、') : t('boardSelector.passport.noDeviceEvidence')}</dd>
                                    </>}
                                    <dt className="text-slate-400">{t('boardSelector.passport.pinCatalog')}</dt>
                                    <dd className="text-slate-600 dark:text-slate-300">{board.pins.length > 0 ? t('boardSelector.passport.loadedPins', { count: board.pins.length }) : t('boardSelector.empty.notProvided')}</dd>
                                    {passport.lockSummary && (
                                        <>
                                            <dt className="text-slate-400">{t('boardSelector.passport.cacheCredential')}</dt>
                                            <dd className="text-slate-600 dark:text-slate-300">{passport.lockSummary}</dd>
                                        </>
                                    )}
                                </dl>

                                {facts.isExpired && (
                                    <div className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] text-amber-700 dark:border-amber-900 dark:bg-amber-950/35 dark:text-amber-300">
                                        <span className="font-bold">{t('boardSelector.passport.expired')}：</span>
                                        {facts.expirationReasonCodes.map(reason => expirationReasonLabel(reason, t)).join('；')}
                                    </div>
                                )}

                                {!passport.canCreateProject && (
                                    <div className="mt-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-[10px] text-rose-700 dark:border-rose-900 dark:bg-rose-950/35 dark:text-rose-300">
                                        <span className="font-bold">{t('boardSelector.passport.blocked')}：</span>{passport.blockedReason}
                                    </div>
                                )}
                                {board.is_custom && passport.needsLocalCertification && passport.canCreateProject && (
                                    <div className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] text-amber-700 dark:border-amber-900 dark:bg-amber-950/35 dark:text-amber-300">
                                        {t('boardSelector.passport.revalidateNotice')}
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
                                            <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200">{t('boardSelector.passport.qualification.title')}</span>
                                            {qualification.running && (
                                                <span className="inline-flex items-center gap-1 text-[9px] text-brand-600 dark:text-brand-300">
                                                    <Loader2 size={10} className="animate-spin" /> {t('boardSelector.passport.qualification.running')}
                                                </span>
                                            )}
                                        </div>
                                        <div className="mt-2 space-y-1.5">
                                            {qualification.profiles.map((profile, index) => (
                                                <div key={`${profile.profile}-${index}`} className="flex items-start gap-2 text-[10px]">
                                                    <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${profile.status === 'passed' ? 'bg-emerald-500' : profile.status === 'failed' ? 'bg-rose-500' : profile.status === 'warning' ? 'bg-amber-500' : profile.status === 'running' ? 'bg-brand-500 animate-pulse' : 'bg-slate-300'}`} />
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-start gap-2">
                                                            <span className="font-mono text-slate-600 dark:text-slate-300 break-all">{profile.profile}</span>
                                                            <span className="ml-auto text-slate-400 shrink-0">
                                                                {profile.index && profile.total ? `${profile.index}/${profile.total} · ` : ''}
                                                                {profile.status === 'passed'
                                                                    ? t('boardSelector.passport.qualification.passed')
                                                                    : profile.status === 'failed'
                                                                        ? t('boardSelector.passport.qualification.failed')
                                                                        : profile.status === 'warning'
                                                                            ? t('boardSelector.passport.qualification.warning')
                                                                            : profile.status === 'running'
                                                                                ? t('boardSelector.passport.qualification.compiling')
                                                                                : t('boardSelector.passport.qualification.pending')}
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
                                            className="h-7 px-2 text-[10px] font-bold text-[var(--accent)] bg-white hover:bg-brand-50 border border-brand-200 rounded transition-colors flex items-center gap-1.5 dark:border-brand-800 dark:bg-slate-800 dark:text-brand-300 dark:hover:bg-brand-950/50"
                                        >
                                            <DownloadCloud size={12} />
                                            {showMissing ? t('boardSelector.passport.qualification.installCore') : t('boardSelector.passport.qualification.installRecommended')}
                                        </button>
                                    )}
                                    {board.is_custom && (
                                        <>
                                            <button
                                                type="button"
                                                onClick={() => onQualify(board.id)}
                                                disabled={!canQualify || qualification?.running}
                                                title={!canQualify ? t('boardSelector.passport.qualification.fixFirstTitle') : t('boardSelector.passport.qualification.verifyTitle')}
                                                className="h-7 px-2 text-[10px] font-bold text-white bg-brand-600 hover:bg-brand-700 disabled:bg-slate-300 disabled:cursor-not-allowed rounded transition-colors flex items-center gap-1.5 dark:disabled:bg-slate-700"
                                            >
                                                {qualification?.running ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
                                                {qualification?.running ? t('boardSelector.passport.qualification.verifyRunning') : t('boardSelector.passport.qualification.verify')}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => onRefreshPassport(board.id)}
                                                className="h-7 px-2 text-[10px] font-bold text-slate-600 bg-white hover:bg-slate-100 border border-slate-200 rounded transition-colors flex items-center gap-1.5 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                                            >
                                                <RefreshCw size={12} /> {t('boardSelector.passport.qualification.refresh')}
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
    const { t } = useTranslation();

    return (
        <div className="bg-[#fbfcfe] border-t border-[#dce3ec] px-5 py-3 flex-shrink-0 z-10 dark:border-slate-800 dark:bg-slate-900">
            <div className="max-w-[1440px] mx-auto flex items-end gap-4">
                <div className="w-[250px] min-w-0 pb-0.5">
                    <span className="block text-[9px] font-bold text-slate-400 uppercase mb-1">{t('boardSelector.footer.targetBoard')}</span>
                    <span className={`block text-xs font-bold truncate ${isBoardSelected && canCreateProject ? 'text-[var(--accent)]' : isBoardSelected ? 'text-rose-600 dark:text-rose-300' : 'text-slate-400'}`}>
                        {selectedBoardName || t('boardSelector.footer.notSelected')}
                    </span>
                    {isBoardSelected && !canCreateProject && (
                        <span className="mt-1 block text-[9px] text-rose-500 truncate" title={blockedReason}>{blockedReason}</span>
                    )}
                </div>
                <label className="flex-1 max-w-[520px] min-w-[260px]">
                    <span className="block text-[9px] font-bold text-slate-400 uppercase mb-1">{t('boardSelector.footer.projectName')}</span>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={!isBoardSelected ? t('boardSelector.footer.chooseBoardFirst') : canCreateProject ? t('boardSelector.footer.nameExample') : t('boardSelector.footer.resolvePassport')}
                        disabled={!isBoardSelected || !canCreateProject}
                        className={`
                            w-full h-10 px-3 rounded-md border outline-none text-sm font-medium transition-colors
                            ${isBoardSelected && canCreateProject
                                ? 'bg-white border-[#cfd8e3] focus:border-brand-600 text-slate-800 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100'
                                : 'bg-[#f1f4f8] border-[#e2e7ee] text-slate-400 cursor-not-allowed dark:bg-slate-800/60 dark:border-slate-800'}
                        `}
                    />
                </label>

                <div className="ml-auto flex items-center gap-2">
                    <button
                        onClick={onBack}
                        className="h-10 px-4 rounded-md font-bold bg-white border border-[#d5dde7] text-slate-500 hover:bg-slate-50 hover:text-slate-800 transition-colors text-xs dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white"
                    >
                        {t('boardSelector.footer.cancel')}
                    </button>
                    <button
                        onClick={() => onCreate(name)}
                        disabled={!name.trim() || !isBoardSelected || !canCreateProject || isCreating}
                        className={`
                            h-10 px-5 rounded-md font-bold text-white transition-colors flex items-center gap-2 text-xs
                            ${name.trim() && isBoardSelected && canCreateProject && !isCreating
                                ? 'bg-brand-600 hover:bg-brand-700'
                                : 'bg-slate-300 cursor-not-allowed'}
                        `}
                    >
                        {isCreating && <Loader2 size={18} className="animate-spin" />}
                        {t('boardSelector.footer.create')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default function BoardSelector({ onBack, onCreated }: BoardSelectorProps) {
    const { t, i18n } = useTranslation();
    const { setActiveBoard, availableBoards, reloadBoards, activeBoard, activeBoardPackageId, installedCoreVersions, refreshInstalledCores: refreshContextCores } = useHardware();
    const [selected, setSelected] = useState<string | null>(null);
    const [activity, setActivity] = useState<BoardSuccess[]>([]);
    const [activityState, setActivityState] = useState<'loading' | 'ready' | 'error'>('loading');
    useEffect(() => {
        let disposed = false;
        let revision = 0;
        let unlisten: (() => void) | undefined;
        const refresh = async () => {
            const request = ++revision;
            try {
                const records = await invoke<BoardSuccess[]>('get_board_success_history');
                if (!disposed && request === revision) { setActivity(records); setActivityState('ready'); }
            } catch {
                if (!disposed && request === revision) { setActivity([]); setActivityState('error'); }
            }
        };
        void (async () => {
            try {
                const { listen } = await import('@tauri-apps/api/event');
                const stop = await listen('board-success-history-changed', refresh);
                if (disposed) { stop(); return; }
                unlisten = stop;
            } catch { /* Browser previews have no native event transport. */ }
            if (!disposed) await refresh();
        })();
        return () => { disposed = true; unlisten?.(); };
    }, []);
    const [isCreating, setIsCreating] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const [showCoreManager, setShowCoreManager] = useState(false);
    // const [installedCores, setInstalledCores] = useState<String[]>([]); // Removed: Use Context


    const [toast, setToast] = useState<{ show: boolean, message: string, type: 'info' | 'loading' | 'success' | 'error' }>({ show: false, message: '', type: 'info' });
    const { confirm, alert } = useDialog();

    const [progress, setProgress] = useState<CoreInstallProgress | null>(null);
    const [installLogs, setInstallLogs] = useState<string[]>([]);
    const logsEndRef = useRef<HTMLDivElement>(null);
    const installLogPhaseRef = useRef<CoreInstallPhase | null>(null);

    // Auto-scroll logs
    useEffect(() => {
        if (logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: "smooth" });
        }
    }, [installLogs]);

    const [isLoadingCores, setIsLoadingCores] = useState(true);

    // Search & Filter State
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedCategoryId, setActiveCategoryId] = useState<CatalogCategoryId>('all');
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

    const categories = useMemo(() => boardCatalogCategories(availableBoards), [availableBoards]);
    const activeCategoryId = categories.some(c => c.id === selectedCategoryId) ? selectedCategoryId : 'all';

    // Filter Logic
    const filteredBoards = useMemo(() => availableBoards.filter(b => {
        const searchLower = searchQuery.trim().toLowerCase();
        const matchSearch = [b.name, b.fqbn_base, b.fqbn, b.vendor, b.author, b.version]
            .some(value => String(value || '').toLowerCase().includes(searchLower));

        const matchCat = activeCategoryId === 'all' || boardCategoryId(b) === activeCategoryId;

        if (!matchSearch || !matchCat) return false;

        const passport = resolveBoardPassport(b, installedCoreVersions, { coreListLoading: isLoadingCores });
        const facts = resolveBoardPassportFacts(b, passport);
        if (onlyDeviceVerified && !facts.deviceVerified) return false;
        if (onlyEnvironmentUsable && !facts.environmentUsable) return false;
        if (onlyRecommendedCore && !facts.usesRecommendedCore) return false;
        if (!showExpiredCertifications && facts.isExpired) return false;
        return true;
    }), [
        activeCategoryId,
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
                const profile = String(payload?.profile || payload?.profile_id || payload?.profileId || payload?.fqbn || 'declared-profile').trim();
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
                    // This legacy event has no machine-readable phase. Keep it as
                    // evidence only; never infer state from localized log text.
                    setInstallLogs(prev => appendBoundedInstallLog(prev, cleanMsg));
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

                    const eventPhase = coreInstallPhaseForEventType(data.eventType);
                    if (eventPhase === 'downloading') {
                        installLogPhaseRef.current = 'downloading';
                        // payload: { total: int, downloaded: int, completed: bool, url?: string }
                        if (data.payload) {
                            let percent = 0;
                            let msg = i18n.t('boardSelector.progress.downloading');

                            // Log new file download
                            if (data.payload.url && data.payload.url !== lastFile) {
                                lastFile = data.payload.url;
                                const fileName = lastFile.split('/').pop() || lastFile;
                                setInstallLogs(prev => appendBoundedInstallLog(prev, `> ${i18n.t('boardSelector.progress.downloadingFile', { file: fileName })}`));
                            }

                            if (data.payload.total > 0) {
                                percent = Math.round((data.payload.downloaded / data.payload.total) * 100);
                                const mb = (data.payload.downloaded / 1024 / 1024).toFixed(1);
                                const totalMb = (data.payload.total / 1024 / 1024).toFixed(1);
                                msg = i18n.t('boardSelector.progress.downloadPercent', { percent, mb, totalMb });
                            } else {
                                // Fallback for unknown total
                                const mb = (data.payload.downloaded / 1024 / 1024).toFixed(1);
                                msg = i18n.t('boardSelector.progress.downloadBytes', { mb });
                                percent = 50;
                            }
                            setProgress({ phase: 'downloading', percent, message: msg });
                        }
                    } else if (eventPhase === 'installing') {
                        setProgress({ phase: 'installing', percent: 100, message: i18n.t('boardSelector.progress.installing') });
                        // Stable phase identity prevents duplicate status rows.
                        setInstallLogs(prev => {
                            if (shouldAppendCoreInstallPhaseLog(installLogPhaseRef.current, eventPhase)) {
                                installLogPhaseRef.current = 'installing';
                                return appendBoundedInstallLog(prev, `> ${i18n.t('boardSelector.progress.installingPackage')}`);
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
                    installLogPhaseRef.current = null;
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

        showToast(t('boardSelector.import.refreshingBoards'), "loading");

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
            throw new Error(`Board package was extracted but not registered: ${String(boardId || t('boardSelector.import.unknownId'))}`);
        }

        let compatibilityText = '';
        if (importedBoard.arduino_core) {
                console.log("[Import] Core dependency found:", importedBoard.arduino_core);
                const core = importedBoard.arduino_core;
                showToast(t('boardSelector.import.dependencyCheck', { package: core.package }), "loading");

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
                            ? { status: 'needs_revalidation', message: t('boardSelector.import.compatibility.legacyInstalled') }
                            : { status: 'missing', message: t('boardSelector.import.compatibility.coreMissing') };
                    } else {
                        compatibility = { status: 'needs_revalidation', message: t('boardSelector.import.compatibility.unavailable', { error: message }) };
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
                    installLogPhaseRef.current = 'initializing';
                    setProgress({ phase: 'initializing', percent: 0, message: i18n.t('boardSelector.progress.startingInstall') });
                    try {
                        await invoke('install_core', {
                            package: core.package,
                            version: recommendedVersion,
                            indexUrl: core.index_url
                        });
                    showToast(t('boardSelector.toast.coreInstallSuccess', { package: `${core.package}@${recommendedVersion}` }), "success");
                    } catch (err) {
                        console.error("Install failed", err);
                        compatibilityText = t('boardSelector.import.compatibility.installFailedSuffix');
                        showToast(t('boardSelector.import.compatibility.importedCoreFailed', { package: core.package, error: String(err) }), 'error');
                    } finally {
                        setProgress(null);
                    }
                } else if (shouldInstallRecommended) {
                    compatibilityText = t('boardSelector.import.compatibility.missingRecommended', { message: compatibilityMessage || t('boardSelector.import.compatibility.coreUnsuitable', { package: core.package }) });
                    showToast(t('boardSelector.import.compatibility.noRecommended'), 'error');
                } else if (knownIncompatible) {
                    compatibilityText = t('boardSelector.import.compatibility.knownIncompatibleSuffix');
                    showToast(compatibilityMessage || t('boardSelector.import.compatibility.knownIncompatible'), 'error');
                } else if (!coreEnvironmentBlocksUse(compatibility) && (compatibility?.requires_revalidation === true || compatibilityTokens.some(status => ['warning', 'incompatible', 'compatible', 'compatible_untested', 'tested_non_recommended', 'needs_revalidation', 'requires_revalidation', 'revalidation_required', 'unverified', 'unverified_compatibility', 'newer_unverified', 'newer_untested', 'above_tested_range', 'above_maximum', 'outside_compatible_range', 'invalid_requirement', 'unparseable_installed_version', 'unknown'].includes(status)))) {
                    compatibilityText = t('boardSelector.import.compatibility.revalidateSuffix');
                    showToast(compatibilityMessage || t('boardSelector.import.compatibility.revalidate', { package: core.package }), 'info');
                } else if (coreEnvironmentBlocksUse(compatibility) || compatibility?.usable === false) {
                    compatibilityText = t('boardSelector.import.compatibility.unusableSuffix');
                    showToast(compatibilityMessage || t('boardSelector.import.compatibility.unusable', { package: core.package }), 'error');
                } else {
                    showToast(t('boardSelector.toast.compatibilityReady', { package: core.package }), "success");
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
        const warningText = qualityReport?.warning_count
            ? t('boardSelector.toast.qualityWarning', { count: qualityReport.warning_count })
            : t('boardSelector.toast.qualityPassed');
        showToast(t('boardSelector.toast.importSuccess', { id: boardId, warning: warningText, compatibility: compatibilityText }), compatibilityText ? "info" : "success");
    };

    const importBoardFromCloudUrl = async (cloudUrl: string) => {
        showToast(t('boardSelector.import.importCloud'), "loading");
        const result = await invoke('import_board_from_github', { url: cloudUrl.trim(), provider: boardRegistryProvider });
        await finalizeImportedBoard(result);
    };

    const fetchCloudBoardCandidates = async (rawUrl: string) => {
        const cleanUrl = String(rawUrl || '').trim();
        if (!cleanUrl) {
            setCloudBoardCandidates([]);
            setCloudBoardError(t('boardSelector.import.fillRepository'));
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
                throw new Error(t('boardSelector.import.invalidRegistry'));
            }
            setCloudBoardCandidates(candidates);
            if (candidates.length === 0) {
                setCloudBoardError(t('boardSelector.import.registryEmpty'));
            }
        } catch (e: any) {
            const msg = String(e?.message || e || t('boardSelector.import.compatibility.unknownError'));
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
            showToast(t('boardSelector.toast.importFailed', { error: String(e) }), "error");
        } finally {
            setInstallingCloudBoardKey(null);
            setIsImporting(false);
            setProgress(null);
        }
    };

    const handleImport = async () => {
        setIsImporting(true);
        showToast(t('boardSelector.import.importLocal'), "loading");
        try {
            const selectedPath = await open({
                multiple: false,
                filters: [{
                    name: t('boardSelector.import.boardPackageFilter'),
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
            showToast(t('boardSelector.toast.importFailed', { error: String(e) }), "error");
        } finally {
            setIsImporting(false);
            setProgress(null);
        }
    };

    const handleCreate = async (projectName: string) => {
        if (!projectName.trim() || !selected) return;
        const selectedBoard = availableBoards.find((board) => boardPackageKey(board) === selected) as BoardPackage | undefined;
        if (!selectedBoard) {
            await alert({ title: t('boardSelector.dialog.boardUnavailable'), message: t('boardSelector.dialog.boardUnavailableMessage'), type: 'warning' });
            return;
        }
        const passport = resolveBoardPassport(selectedBoard, installedCoreVersions, { coreListLoading: isLoadingCores });
        if (!passport.canCreateProject) {
            await alert({
                title: t('boardSelector.dialog.passportBlocked'),
                message: passport.blockedReason || t('boardSelector.dialog.passportBlockedMessage'),
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
                    title: t('boardSelector.dialog.unsupportedEnvironment'),
                    message: t('boardSelector.dialog.unsupportedEnvironmentMessage'),
                    type: 'warning'
                });
                setIsCreating(false);
                return;
            }
        } catch (e) {
            console.error(e);
            console.error(e);
            alert({
                title: t('boardSelector.dialog.createFailed'),
                message: t('boardSelector.dialog.createFailedMessage', { error: String(e) }),
                type: 'error'
            });
            setIsCreating(false); // Only reset if failed
        }
    };

    const handleDelete = async (id: string, name: string) => {
        const deletedBoard = availableBoards.find((board) => board.id === id) as BoardPackage | undefined;
        const confirmed = await confirm(
            {
                title: t('boardSelector.dialog.deleteBoard'),
                message: t('boardSelector.dialog.deletePrompt', { name }),
                type: 'warning',
                confirmLabel: t('common.actions.delete'),
                cancelLabel: t('common.actions.cancel')
            }
        );

        if (!confirmed) return;

        showToast(t('boardSelector.toast.deleteRunning', { name }), "loading");
        try {
            // Use BoardManager for robust handling
            const { BoardManager } = await import('../services/board_manager');
            const deletionLog = await BoardManager.deleteBoard(id);
            const warningSummary = summarizeBoardDeletionWarnings(deletionLog);

            await reloadBoards();
            if (warningSummary) {
                showToast(t('boardSelector.toast.deleteWarning', { summary: warningSummary }), "info");
            } else {
                showToast(t('boardSelector.toast.deleteSuccess', { name }), "success");
            }

            // If deleted board was selected, clear selection
            if (activeBoardPackageId === deletedBoard?.id || selected === deletedBoard?.id) {
                setSelected(null);
                if (deletedBoard?.fqbn) setActiveBoard(deletedBoard.fqbn, deletedBoard.fqbn);
            }
        } catch (e) {
            console.error(e);
            showToast(t('boardSelector.toast.deleteFailed', { error: String(e) }), "error");
        }
    };

    // Core Logic
    const handle卸载Core = async (corePackage: string, boardName: string) => {
        const confirmed = await confirm({
            title: t('boardSelector.dialog.uninstallCore'),
            message: t('boardSelector.dialog.uninstallPrompt', { package: corePackage, board: boardName || t('boardSelector.header.selectTarget') }),
            type: 'warning',
            confirmLabel: t('boardSelector.dialog.uninstallAction'),
            cancelLabel: t('common.actions.cancel')
        });

        if (!confirmed) return;

        showToast(t('boardSelector.toast.uninstallCore', { package: corePackage }), "loading");
        try {
            const output = await invoke('uninstall_core', { package: corePackage });
            console.log("卸载 output:", output);
            showToast(t('boardSelector.toast.coreUninstallSuccess', { package: corePackage }), "success");
            await refreshInstalledCores({ invalidateBoardSchemas: true });
            await reloadBoards();
        } catch (e) {
            console.error("卸载 failed", e);
            showToast(t('boardSelector.toast.coreUninstallFailed', { error: String(e) }), "error");
        }
    };

    const handleInstallCore = async (core: ArduinoCoreConfig, version?: string) => {
        setInstallLogs([]);
        installLogPhaseRef.current = 'initializing';
        setProgress({ phase: 'initializing', percent: 0, message: i18n.t('boardSelector.progress.initializing') });
        showToast(t('boardSelector.toast.installCore', { package: core.package }), "loading");

        try {
            await invoke('install_core', {
                package: core.package,
                version: version || core.recommended_version || core.version,
                indexUrl: core.index_url
            });
            showToast(t('boardSelector.toast.coreInstallSuccess', { package: core.package }), "success");
            await refreshInstalledCores({ invalidateBoardSchemas: true });
            await reloadBoards();
        } catch (err) {
            console.error("Install failed", err);
            showToast(t('boardSelector.toast.coreInstallFailed', { error: String(err) }), "error");
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
        showToast(t('boardSelector.toast.refreshPassport'), 'loading');
        try {
            await invoke('get_board_passport', { boardId });
            await reloadBoards();
            await refreshInstalledCores();
            showToast(t('boardSelector.toast.passportRefreshed'), 'success');
        } catch (error) {
            // Older backends do not expose get_board_passport yet; reloading the
            // catalog still refreshes quality/core information without hiding it.
            console.warn('[BoardPassport] refresh command unavailable', error);
            await reloadBoards();
            await refreshInstalledCores();
            showToast(t('boardSelector.toast.localBoardRefreshed'), 'info');
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
            : [{ profile: board?.fqbn_base || board?.fqbn || 'default', status: 'running' }];
        setQualificationByBoard(previous => ({
            ...previous,
            [boardId]: { running: true, profiles: declaredProfiles },
        }));
        showToast(t('boardSelector.toast.qualifyRunning'), 'loading');

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
                failed ? t('boardSelector.toast.qualifyFailed') : warned ? t('boardSelector.toast.qualifyWarning') : t('boardSelector.toast.qualifySuccess'),
                failed ? 'error' : warned ? 'info' : 'success',
            );
        } catch (error) {
            const message = String(error || t('boardSelector.import.compatibility.unknownError'));
            const commandMissing = /(?:command|invoke)[^\n]*qualify_board_profiles[^\n]*(?:not found|not registered)|unknown command[^\n]*qualify_board_profiles/i.test(message);
            setQualificationByBoard(previous => {
                const current = previous[boardId] || { running: false, profiles: declaredProfiles };
                const profiles = current.profiles.map((profile, index) => index === 0
                    ? { ...profile, status: commandMissing ? 'warning' as const : 'failed' as const, message }
                    : profile);
                return { ...previous, [boardId]: { running: false, profiles } };
            });
            showToast(commandMissing ? t('boardSelector.toast.qualifyCommandMissing') : t('boardSelector.toast.qualifyFailedWithError', { error: message }), commandMissing ? 'info' : 'error');
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
                    <button onClick={onBack} className="h-9 px-2 flex items-center justify-center gap-1 hover:bg-slate-100 rounded-md transition-colors text-slate-500 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white" title={t('boardSelector.header.backTitle')}>
                        <ArrowLeft size={19} />
                        <span className="text-xs font-bold">{t('boardSelector.header.back')}</span>
                    </button>
                    <BrandLogo className="h-8 w-[66px]" />
                    <div className="flex flex-col leading-none">
                        <h1 className="text-sm font-bold text-slate-900 dark:text-slate-100">{t('boardSelector.header.newProject')}</h1>
                        <span className="text-[10px] text-slate-400 mt-1.5">{t('boardSelector.header.hardwareTarget')}</span>
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
                            <span>{t('boardSelector.header.thirdPartyBoards')}</span>
                        </button>

                        <button
                            onClick={() => setShowCoreManager(true)}
                            className="h-8 px-3 rounded text-slate-500 hover:bg-white hover:text-slate-900 transition-colors text-xs font-bold flex items-center gap-2 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white"
                        >
                            <Package size={15} />
                            <span>{t('boardSelector.header.coreManager')}</span>
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
                                <span className="text-[9px] font-bold text-[var(--accent)] uppercase">Board catalog</span>
                                <h2 className="text-base font-bold text-slate-900 mt-1 dark:text-slate-100">{t('boardSelector.header.selectTarget')}</h2>
                            </div>
                            <span className="text-[10px] font-mono text-slate-400 pb-0.5">{filteredBoards.length} / {availableBoards.length}</span>
                        </div>

                        {/* Search Bar */}
                        <div className="relative group w-full md:w-[360px]">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-[var(--accent)] transition-colors" size={16} />
                            <input
                                type="text"
                                placeholder={t('boardSelector.header.searchPlaceholder')}
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="w-full h-10 pl-9 pr-3 bg-white border border-[#d7dfe9] rounded-md focus:border-brand-600 outline-none transition-colors placeholder:text-slate-400 text-xs font-medium text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                            />
                        </div>
                    </div>

                    {/* Category Filter */}
                    <div className="flex items-stretch gap-1 mb-2 border-b border-[#dce3ec] overflow-x-auto dark:border-slate-800">
                        {categories.map(category => {
                            const categoryId = category.id;
                            const label = category.name || t(BOARD_CATEGORY_LABEL_KEYS[categoryId as BoardCategoryId] as any);
                            return (
                            <button
                                key={categoryId}
                                type="button"
                                aria-pressed={activeCategoryId === categoryId}
                                title={label}
                                onClick={() => setActiveCategoryId(categoryId)}
                                className={`
                                    inline-flex h-10 max-w-52 items-center gap-2 px-3 text-xs font-bold transition-colors border-b-2 shrink-0 focus-visible:outline-offset-[-3px]
                                    ${activeCategoryId === categoryId
                                        ? 'text-[var(--accent)] border-brand-600 bg-brand-50 dark:bg-brand-950/45 dark:text-brand-300'
                                        : 'text-slate-500 border-transparent hover:text-slate-900 hover:bg-white dark:text-slate-400 dark:hover:bg-slate-900 dark:hover:text-slate-100'}
                                `}
                            >
                                <CatalogIcon category={category} />
                                <span className="truncate">{label}</span>
                            </button>
                            );
                        })}
                    </div>

                    <div className="mb-4 flex min-h-8 flex-wrap items-center gap-2 rounded-md border border-[#dce3ec] bg-white px-2.5 py-1.5 dark:border-slate-800 dark:bg-slate-900">
                        <span className="mr-1 text-[10px] font-bold text-slate-500 dark:text-slate-300">{t('boardSelector.filters.title')}</span>
                        <label className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded border px-2 text-[10px] font-semibold transition-colors ${onlyDeviceVerified ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-800 dark:bg-brand-950/45 dark:text-brand-300' : 'border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800'}`} title={t('boardSelector.filters.deviceVerifiedTitle')}>
                            <input
                                type="checkbox"
                                checked={onlyDeviceVerified}
                                onChange={(event) => setOnlyDeviceVerified(event.target.checked)}
                                className="h-3 w-3 accent-brand-600"
                            />
                            {t('boardSelector.filters.deviceVerified')}
                        </label>
                        <label className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded border px-2 text-[10px] font-semibold transition-colors ${onlyEnvironmentUsable ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-800 dark:bg-brand-950/45 dark:text-brand-300' : 'border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800'}`} title={t('boardSelector.filters.environmentUsableTitle')}>
                            <input
                                type="checkbox"
                                checked={onlyEnvironmentUsable}
                                onChange={(event) => setOnlyEnvironmentUsable(event.target.checked)}
                                className="h-3 w-3 accent-brand-600"
                            />
                            {t('boardSelector.filters.environmentUsable')}
                        </label>
                        <label className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded border px-2 text-[10px] font-semibold transition-colors ${onlyRecommendedCore ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-800 dark:bg-brand-950/45 dark:text-brand-300' : 'border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800'}`} title={t('boardSelector.filters.recommendedCoreTitle')}>
                            <input
                                type="checkbox"
                                checked={onlyRecommendedCore}
                                onChange={(event) => setOnlyRecommendedCore(event.target.checked)}
                                className="h-3 w-3 accent-brand-600"
                            />
                            {t('boardSelector.filters.recommendedCore')}
                        </label>
                        <label className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded border px-2 text-[10px] font-semibold transition-colors ${showExpiredCertifications ? 'border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800' : 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/45 dark:text-amber-300'}`} title={t('boardSelector.filters.showExpiredTitle')}>
                            <input
                                type="checkbox"
                                checked={showExpiredCertifications}
                                onChange={(event) => setShowExpiredCertifications(event.target.checked)}
                                className="h-3 w-3 accent-brand-600"
                            />
                            {t('boardSelector.filters.showExpired')}
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
                                {t('boardSelector.filters.reset')}
                            </button>
                        )}
                    </div>

                    <BoardGrid
                        boards={filteredBoards as BoardPackage[]}
                        activity={activity}
                        activityState={activityState}
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
                                <h3 className="text-base font-bold text-slate-800 dark:text-slate-100 truncate">{t('boardSelector.import.importThirdParty')}</h3>
                                <p className="text-xs text-slate-500 dark:text-slate-400 truncate" title={boardRegistryUrl}>
                                    {t('boardSelector.import.repository', { url: boardRegistryUrl })}
                                </p>
                            </div>
                            <button
                                onClick={() => {
                                    if (installingCloudBoardKey) return;
                                    setShowCloudBoardPicker(false);
                                }}
                                className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"
                            >
                                {t('boardSelector.import.close')}
                            </button>
                        </div>

                        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 space-y-3">
                            <div className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-[10px] leading-relaxed text-brand-800 dark:border-brand-900 dark:bg-brand-950/35 dark:text-brand-200">
                                <span className="font-bold">{t('boardSelector.import.qualityTitle')}</span>
                                {t('boardSelector.import.qualityDescription')}
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="relative flex-1">
                                    <Link className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                                    <input
                                        type="text"
                                        value={boardRegistryUrl}
                                        onChange={(e) => setBoardRegistryUrl(e.target.value)}
                                        placeholder={boardRegistryProvider === 'gitee' ? "https://gitee.com/owner/repo.git" : "https://github.com/owner/repo.git"}
                                        className="w-full pl-9 pr-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 outline-none focus:ring-2 focus:ring-brand-500"
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
                                    className="h-[38px] px-2 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs text-slate-700 dark:text-slate-200 outline-none focus:ring-2 focus:ring-brand-500"
                                >
                                    <option value="auto">{t('boardSelector.import.providerAuto')}</option>
                                    <option value="github">GitHub</option>
                                    <option value="gitee">Gitee</option>
                                </select>
                                <button
                                    onClick={handleRefreshCloudBoards}
                                    disabled={cloudBoardLoading || !!installingCloudBoardKey}
                                    className={`px-3 py-2 rounded-lg text-xs font-bold flex items-center gap-2 ${cloudBoardLoading
                                        ? 'bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-300'
                                        : 'bg-brand-600 hover:bg-brand-700 text-white'}`}
                                >
                                    {cloudBoardLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                                    {cloudBoardLoading ? t('boardSelector.import.loading') : t('boardSelector.import.refreshList')}
                                </button>
                                <button
                                    onClick={handleImport}
                                    disabled={isImporting || !!installingCloudBoardKey}
                                    className="px-3 py-2 rounded-lg text-xs font-bold flex items-center gap-2 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                                >
                                    {isImporting ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                                    {isImporting ? t('boardSelector.import.importing') : t('boardSelector.import.selectZip')}
                                </button>
                            </div>

                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                                <input
                                    type="text"
                                    value={cloudBoardSearch}
                                    onChange={(e) => setCloudBoardSearch(e.target.value)}
                                    placeholder={t('boardSelector.import.searchPlaceholder')}
                                    className="w-full pl-9 pr-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 outline-none focus:ring-2 focus:ring-brand-500"
                                />
                            </div>
                            {cloudBoardError && (
                                <p className="text-xs text-rose-500">{cloudBoardError}</p>
                            )}
                            {!cloudBoardError && (
                                <p className="text-xs text-slate-500 dark:text-slate-400">
                                    {t('boardSelector.import.found', { count: cloudBoardCandidates.length })}
                                </p>
                            )}
                        </div>

                        <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
                            {!cloudBoardLoading && filteredCloudBoardCandidates.length === 0 && (
                                <div className="h-full flex items-center justify-center text-sm text-slate-400">
                                    {t('boardSelector.import.noMatch')}
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
                                        <div className="w-10 h-10 rounded-lg bg-brand-100 dark:bg-brand-900/40 text-brand-600 dark:text-brand-300 flex items-center justify-center shrink-0">
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
                                                {entry.description || t('boardSelector.import.noDescription')}
                                            </p>
                                            <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1 font-mono truncate" title={entry.subdir || '.'}>
                                                {t('boardSelector.import.subpath', { path: entry.subdir || '.' })}
                                            </p>
                                        </div>
                                        <button
                                            onClick={() => handleInstallCloudBoard(entry)}
                                            disabled={!!installingCloudBoardKey || installed}
                                            className={`px-3 py-2 rounded-lg text-xs font-bold transition-all shrink-0 flex items-center gap-2 ${installing
                                                ? 'bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-300'
                                                : installed
                                                    ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300'
                                                    : 'bg-brand-600 hover:bg-brand-700 text-white'}`}
                                        >
                                            {installing ? <Loader2 size={14} className="animate-spin" /> : <DownloadCloud size={14} />}
                                            {installing ? t('boardSelector.import.installing') : installed ? t('boardSelector.import.installed') : t('boardSelector.import.install')}
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
                                <span className="ml-3 text-gray-300 font-medium text-xs font-mono tracking-wide">{t('boardSelector.progress.terminal')}</span>
                            </div>
                            <div className="flex items-center gap-2 text-emerald-500">
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                <span className="text-xs font-mono">{t('boardSelector.progress.running')}</span>
                            </div>
                        </div>

                        {/* Terminal Content */}
                        <div
                            className="flex-1 p-4 overflow-y-auto font-mono text-xs text-gray-300 space-y-1 bg-[#1e1e1e] select-text custom-scrollbar text-left"
                        >
                            {installLogs.length === 0 && <span className="text-gray-500 italic">{t('boardSelector.progress.waiting')}</span>}
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
                                {t('boardSelector.progress.forceClose')}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}





