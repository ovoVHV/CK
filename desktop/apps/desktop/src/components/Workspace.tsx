import { captureProjectBuildTarget, readProjectBuildTarget, projectBuildTargetDifference, targetFromRecordedFqbn, sourceWithBuildTarget, type ProjectBuildTarget, type ProjectBuildEnvironment } from '../services/project_build_target';
import { BuildActivitySpinner } from './BuildActivitySpinner';
import { clearCompileErrors, markCompileError, revealCompileError } from '../services/compile_block_feedback';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { StatusFooter } from './StatusFooter';
import { publishProjectStatus } from './project_status_session';
import { analyzeProductionResolvedResources, resourceCatalogFromLibraries } from '../services/production_resource_analysis';
import { integrateCompilerResources, currentCompilerResourcePresentation, currentCompilerObservationStatus, markCompilerObservationStale, type CompilerResourcePresentationCache, type CompilerObservationAttempt } from '../services/compiler_resource_integration';
import type { CapturedCompilerSnapshot } from '../services/compiler_api_evidence';
import {
    buildHardwareResourceInspector,
    type HardwareResourceInspectorView,
    type InspectorGap,
} from '../services/hardware_resource_inspector';
import {
    buildResourcePreflight,
    evaluateResourcePreflight,
    type ResourcePreflightReport,
} from '../services/resource_preflight';
import type { BoardResourceGraph, ResourceAnalysis, ResourceClaim } from '../services/hardware_resource_graph';
import {
    CheckCircle,
    Check,
    Loader2,
    CircuitBoard,
    ChevronDown,
    ChevronsUpDown,
    ChevronsDownUp,
    SlidersHorizontal,
    Search,
    Code,
    Terminal,
    X,
    Upload,
    Usb,
    XCircle,
    ArrowLeft,
    RefreshCw,
    Monitor,
    Ban,
    Save,
    Trash2,
    FolderOpen, FilePlus, Send, Cpu, Play, Pause, Type, Activity, BookOpen, Binary, Clock3, Copy, Bug, ArchiveRestore, AlertTriangle, HeartPulse, ShieldCheck, ExternalLink, Palette
} from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vs, vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { save, open } from '@tauri-apps/plugin-dialog'; // Native file dialogs
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { CompileLogActions } from './CompileLogActions';
import * as Blockly from 'blockly';
// Install the presentation-only Blockly locale hooks before blockly_setup
// evaluates its imperative custom block definitions.
import {
    applyBlocklyLocale,
    getBlocklyCategoryLabel,
    getEffectiveBlocklyLocale,
    getBlocklySourceLabel,
    type BlocklyLocale,
} from '../services/blockly_locale';
import {
    PROJECT_OPEN_BROWSER_EVENT,
    projectPathsReferToSameFile,
    type WorkspaceProjectOpenDetail,
} from '../services/project_open';
import 'blockly/blocks';
import { getToolbox, setBlocklyBoard, registerDetailedBoard } from './blockly_setup';
import arduinoGenerator, { setArduinoGeneratorTarget, stripBlockMarkers } from './arduino_generator';
import { composeBoardFqbn, useHardware } from '../contexts/HardwareContext';
import { baseBoardFqbn, parseBoardFqbnOptions } from '../services/board_fqbn';
import {
    boardPackageKey,
    evaluateBoardPackageBuildGate,
    resolveBoardPackage,
} from '../services/board_identity';
import {
    CORE_PIN_ALIAS_CACHE_INVALIDATED_EVENT,
    getInstalledCorePinAliasesCached,
    mergeInstalledCorePinAliases,
    type InstalledCorePinAliasCatalog,
} from '../services/core_pin_aliases';
import { preproofCompileTarget } from '../services/compile_target_preproof';
import BoardConfigModal from './BoardConfigModal';
import { BrandLogo } from './BrandLogo';
import { LibraryManagerModal } from './LibraryManagerModal';
import {
    assignExtensionVisualColours,
    fetchExtensionToolbox,
    findDisallowedExtensionBlockRuntimes,
    getAvailableExtensions,
    jsonCategoryToXml,
    prefetchExtensionFiles,
    registerExtensionBlocks,
    registerExtensionGenerator,
    registerToolboxBlockVisualColours,
    syncExtensionBlockVisualColour,
    type ExtensionInfo,
} from '../services/extension_loader';
import {
    libraryCanExecuteBlockRuntime,
    runtimeContentHashKey,
} from '../services/block_runtime_activation';
import { SerialMonitor, SerialTerminalRef } from './SerialMonitor'; // Import new component
import { SerialPlotter } from './SerialPlotter';
import { EngineeringHealthDock } from './EngineeringHealthDock';
import { CodePreviewDock } from './CodePreviewDock';
import { BuildIssueCards } from './BuildIssueCards';
import { AiAssistantPanel } from './AiAssistantPanel';
import { compileAiCandidate, generateAiCandidate } from '../services/ai_candidate';
import { createAiLibraryHost } from '../services/ai_library_host';
import { validateAiBehavior } from '../services/ai_behavior';
import type { AiIntent } from '../services/ai_assistant_runtime';
import type { AiBoardProfile } from '../services/ai_board_context';
import { Sparkles } from 'lucide-react';
import { ProjectCheckpointsModal } from './ProjectCheckpointsModal';
import { LastWorkingVersionModal } from './LastWorkingVersionModal';
import { DiagnosticBundleModal } from './DiagnosticBundleModal';
import { ProjectAcceptanceReportModal } from './ProjectAcceptanceReportModal';
import { UnknownBlocksProtectionPanel } from './UnknownBlocksProtectionPanel';
import { RecoveryDraftModal } from './RecoveryDraftModal';
import {
    CompileProgressOverlay,
    type ForegroundBuildEvidence,
} from './CompileProgressOverlay';
import { BlockDebugControls } from './BlockDebugControls';
import { BlockTracePanel, type BlockTracePhase } from './BlockTracePanel';
import { BlockDock } from './BlockDock';
import { BOARDS } from '../constants/boards';
import { BOARDS as PIN_PREFLIGHT_BOARDS } from '../config/boards';
import { buildBlockCatalog } from '../services/block_catalog';
import { searchBlockDockEntries } from '../services/block_dock';
import { hydrateBlockPackageLocales } from '../services/library_manager';
import type { BlockSearchEntry } from '../types/library';
import {
    inspectSerializedBlocklyWorkspace,
    type WorkspaceLoadInspection,
} from '../services/unknown_block_guard';
import {
    computeRecoveryDraftFullStateHash,
    deleteRecoveryDraft,
    discardProjectRecoveryDrafts,
    getProjectRecoveryBaseline,
    listRecoveryDrafts,
    loadRecoveryDraft,
    recoveryProjectSessionKey,
    recoveryProjectSessionMatches,
    resolveCompletedRecoveryProjectSession,
    saveRecoveryDraft,
    selectLatestRecoveryDraftForSession,
    type ProjectRecoveryBaseline,
    type RecoveryDraft,
    type RecoveryDraftMetadata,
    type RecoveryProjectSession,
    type RecoveryDraftState,
} from '../services/recovery_drafts';
import { createDeferredSingleFlightQueue } from '../services/deferred_single_flight';
import {
    freezeCompileSourceMap,
    lookupCompileSourceMap,
    normalizeTrustedCompileSketchAlias,
    resolveTrustedCompileDiagnosticFile,
    sha256Hex,
    type CompileSourceMapV1,
    type TrustedCompileSketchAliasV1,
} from '../services/compile_source_map';
import {
    diagnoseCompile,
    compareCompileEnvironment,
    loadCompileEnvironmentSnapshot,
    saveCompileEnvironmentSnapshot,
    type CompileDiagnosticsPayload,
    type CompileDoctorReport,
    type CompileEnvironmentSnapshot,
    type CurrentCompileEnvironment,
} from '../services/compile_doctor';
import {
    analyzeCompileIssues,
    type CompileIssueAction,
    type CompileIssueCard,
} from '../services/compile_issue_cards';
import {
    captureCompileIssueBlockPresentations,
    reconcileCompileIssueBlockContexts,
    type CompileIssueBlockPresentation,
} from '../services/compile_issue_block_context';
import {
    analyzePinPreflight,
    pinBlockRulesFromCatalog,
    type PinPreflightBoard,
    type PinPreflightReport,
} from '../services/pin_preflight';
import {
    createProjectCheckpoint,
    isNativeCheckpointStorageAvailable,
    listProjectCheckpoints,
    type CreateProjectCheckpointInput,
    type ProjectCheckpoint,
    type ProjectCheckpointReason,
} from '../services/project_checkpoints';
import { scheduleBuildCheckpoint } from '../services/build_checkpoint_scheduler';
import {
    compareWithLastWorkingVersion,
    getLastWorkingVersion,
    rebuildLastWorkingVersionLocked,
    restoreLastWorkingDependencies,
    restoreLastWorkingFirmware,
    type CurrentWorkingVersionState,
    type LastWorkingVersion,
} from '../services/last_working_version';
import {
    createStandardDiagnosticBundleItems,
    type DiagnosticBundleExportData,
} from '../services/diagnostic_bundle';
import {
    bindProjectBuildEvidence,
    createProjectUploadResult,
    createProjectAcceptanceReport,
    type ProjectUploadResult,
    type ProjectAcceptanceNotes,
} from '../services/project_acceptance_report';
import { projectHealthCapabilities } from '../services/project_health_capabilities';
import { parseSuccessfulUploadResult } from '../services/upload_result';
import {
    compileResourceSnapshotToReport,
    createCompileResourceReport,
    createCompileResourceSnapshot,
    loadCompileResourceSnapshot,
    isSameCompileResourceTarget,
    normalizeLinkerMapResourceSummary,
    parseLinkerMapResourceSummary,
    parseCompileResourceUsage,
    parseResolvedCompileFqbn,
    saveCompileResourceSnapshot,
    type CompileResourceReport,
    type CompileResourceSnapshot,
    type CompileResourceTargetIdentity,
    type LinkerMapResourceSummary,
} from '../services/compile_resources';
import {
    applyBuildLogLine,
    applyBuildProgressEvent,
    createBuildProgressState,
    createIdleBuildProgress,
    tickBuildProgress,
    type BuildProgressState,
} from '../services/compile_progress';
import {
    appendCompileLogBufferBounded,
    createCompileLogBuffer,
} from '../services/compile_log_buffer';
import { extractCompileLogDigest } from '../services/compile_log_digest';
import {
    completedBuildOperationResult,
    isBuildOperationSuccessful,
    type BuildOperationResultCode,
} from '../services/build_operation_result';
import {
    persistWorkspaceViewMode,
    readWorkspaceViewMode,
    type WorkspaceViewMode,
} from '../services/workspace_view_mode';
import {
    disposeBlocklyWorkspaceLifecycle,
    prepareBlocklyWidgetDivForInjection,
} from '../services/blockly_workspace_lifecycle';
import { installBlocklyOverlayLifecycle } from '../services/blockly_overlay_lifecycle';
import {
    BLOCK_LOCALE_PREFERENCE_CHANGED_EVENT,
    getLocalePreferences,
    normalizeUiLocale,
} from '../i18n';
import {
    createSilentPrecompileRequest,
    SilentPrecompileScheduler,
} from '../services/silent_precompile_scheduler';
import {
    createFailedDeviceHealthReport,
    deriveDeviceHealthPresentation,
    isEsp32DeviceHealthTarget,
    isSameDeviceHealthTarget,
    normalizeDeviceHealthReport,
    type DeviceHealthPublication,
    type DeviceHealthRequestIdentity,
} from '../services/device_health';
import { installNativeRegressionBridge } from '../services/native_regression_bridge';
import {
    CkDebugStreamParser,
    createDebugCommandLine,
    createDebugSketch,
    createTraceSketch,
    extractInstrumentableBlockIds,
    type CkDebugCommand,
    type CkDebugFrame,
} from '../services/block_debugger';
import {
    BlockTraceAggregator,
    type BlockTraceSnapshot,
} from '../services/block_trace';
import { refreshBlockTraceVisuals } from '../services/block_trace_visuals';
import {
    IDLE_BLOCK_DEBUG_SESSION,
    markBlockDebugSessionConnecting,
    markBlockDebugSessionStopping,
    type BlockDebugSessionState,
} from '../services/block_debug_session';
import {
    clearBlockBreakpoints,
    getBlockBreakpoints,
    hasBlockBreakpoint,
    refreshBlockBreakpointVisuals,
    subscribeBlockBreakpoints,
    toggleBlockBreakpoint,
} from '../services/block_breakpoints';
import {
    hasGeneratedCodeChanged,
    resolveCompileSource,
    shouldProcessBlocklyContentEvent,
} from '../services/blockly_change_guard';
import { useDialog } from '../contexts/DialogContext';
import { useAppTheme } from '../contexts/ThemeContext';
import AppearanceSettingsModal from './AppearanceSettingsModal';
import {
    blocklyRendererForVisualStyle,
    getBrowserBlocklyVisualStyleStorage,
    normalizeBlocklyVisualStyle,
    persistBlocklyVisualStyle,
    readBlocklyVisualStyle,
    type BlocklyVisualStyle,
} from '../services/blockly_visual_style';
import { applyBlocklyVisualSkin, applyBlocklyVisualSkinToBlocks, applyBlocklyVisualSkinToRoots } from '../services/blockly_visual_skin';
import { createBlocklyEditScheduler } from '../services/blockly_edit_scheduler';
import { installBlocklyViewportCulling } from '../services/blockly_viewport';
import { countSerializedBlocks, loadBlocklyWorkspaceProgressively, type BlocklyLoadProgress } from '../services/blockly_progressive_load';
import { createBlocklyCodePreview } from '../services/blockly_code_preview';
import { LargeCodePreview } from './LargeCodePreview';
import { getBlocklyVisualTheme } from '../theme/blockly_visual_themes';

const createForegroundBuildRunId = (): string => {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

// Toast 组件
const Toast = ({ message, type, show, onClose }: any) => {
    if (!show) return null;

    let icon = <CheckCircle size={20} className="text-green-500" />;
    let bgColor = "bg-white dark:bg-slate-900";
    let textColor = "text-slate-800 dark:text-slate-100";
    let borderColor = "border-slate-200 dark:border-slate-700";

    if (type === 'loading') {
        icon = <Loader2 size={20} className="text-blue-500 animate-spin" />;
    } else if (type === 'error') {
        icon = <XCircle size={20} className="text-red-500" />;
        borderColor = "border-red-100 dark:border-red-900";
    }

    return (
        <div className={"fixed top-20 left-1/2 transform -translate-x-1/2 z-50 flex items-center space-x-3 px-4 py-3 rounded-lg shadow-xl border " + borderColor + " " + bgColor + " " + textColor + " animate-in fade-in slide-in-from-top-4 duration-300"}>
            {icon}
            <span className="text-sm font-medium">{message}</span>
            {type !== 'loading' && (
                <button onClick={onClose} className="ml-4 text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-200" title="关闭提示" aria-label="关闭提示">
                    <X size={16} />
                </button>
            )}
        </div>
    );
};

interface WorkspaceProps {
    initialCheckOpen?: boolean;
    projectPath: string; // Initial path
    onBack: () => void;
    onProjectOpenListenerReady?: (ready: boolean) => void;
    forceBoard?: string;
    forceBoardPackageId?: string;
    missingBoard?: string;
    theme?: 'light' | 'dark' | 'system';
}

interface BlocklyRendererTransitionSnapshot {
    state: ReturnType<typeof Blockly.serialization.workspaces.save>;
    originStyle: BlocklyVisualStyle;
    revertAttempted: boolean;
    scale: number;
    scrollX: number;
    scrollY: number;
    selectedBlockId: string | null;
    /** The same reinjection path is used for renderer and Blockly locale changes. */
    reason?: 'renderer' | 'locale';
    originBlocklyLocale?: BlocklyLocale;
    targetBlocklyLocale?: BlocklyLocale;
}

/**
 * Build the read-only Inspector projection from the completed production
 * resource observation. This deliberately accepts the analysis boundary as an
 * unknown-shaped value so the UI cannot accidentally become a second resolver
 * or rely on board display names. The graph and claims are already validated by
 * the production analysis path.
 */
const inspectorViewFromProductionAnalysis = (
    value: ReturnType<typeof analyzeProductionResolvedResources> | null | undefined,
): HardwareResourceInspectorView | null => {
    if (!value || value.status !== 'ready') return null;
    const candidate = value as unknown as {
        model?: { resource_graph?: unknown };
        report?: unknown;
        claims?: unknown;
        gaps?: unknown;
        coverage?: unknown;
    };
    const graph = candidate.model?.resource_graph;
    if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return null;
    try {
        return buildHardwareResourceInspector({
            graph: graph as BoardResourceGraph,
            analysis: candidate.report && typeof candidate.report === 'object'
                ? candidate.report as ResourceAnalysis
                : null,
            claims: Array.isArray(candidate.claims) ? candidate.claims as ResourceClaim[] : undefined,
            gaps: Array.isArray(candidate.gaps) ? candidate.gaps as InspectorGap[] : undefined,
            coverage: candidate.coverage && typeof candidate.coverage === 'object'
                ? candidate.coverage as {
                    declarationCoverage?: 'full' | 'partial' | 'unknown';
                    analysisCoverage?: 'full' | 'partial' | 'unknown';
                    projectCoverage?: 'full' | 'partial' | 'unknown';
                    hardwareEvidence?: string;
                    hardwareValidation?: string;
                }
                : undefined,
        });
    } catch {
        // Inspector is presentation-only. A malformed optional snapshot must
        // never affect compile/upload or the existing health panels.
        return null;
    }
};

interface BlocklyRendererRecoveryFailure {
    message: string;
    originStyle: BlocklyVisualStyle;
}

interface EnabledBlockPackageInventoryEntry {
    packageId: string;
    version: string;
    contentSha256: string;
    packagePath: string;
}

interface LibraryBackedExtensionInfo extends ExtensionInfo {
    blockPackageInventory: EnabledBlockPackageInventoryEntry;
}

interface ActiveExtensionLocaleEntry {
    extension: ExtensionInfo;
    visualColour?: string;
    boardIdentity: {
        fqbn: string;
        packageId: string;
        isCustom: boolean;
    };
}

interface CompileRunOptions {
    codeOverride?: string;
    ensureSerialMonitor?: boolean;
    serialBaudRate?: number;
    uploadMode?: 'normal' | 'debug' | 'trace';
}

interface PendingBoardOptionBuild {
    isUpload: boolean;
    options: CompileRunOptions;
    board: string;
    boardPackageId: string;
    queuedAt: number;
}

type BlockRunMode = 'breakpoint' | 'trace' | null;
interface RecoveryBaselineCache {
    sessionKey: string;
    baseline: ProjectRecoveryBaseline;
}
type UnsavedNavigationContext = 'back' | 'open' | 'close';
type UnsavedNavigationChoice = 'save' | 'discard' | 'cancel';

const INITIAL_DEBUG_ATTACH_TIMEOUT_MS = 10_000;
const INITIAL_DEBUG_ATTACH_RETRY_MS = 500;

const normalizeFingerprintValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalizeFingerprintValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, entry]) => [key, normalizeFingerprintValue(entry)]),
        );
    }
    return value;
};

const createProjectFingerprint = (
    workspaceState: unknown,
    board: string,
    options: Record<string, unknown>,
    boardPackageId = '',
    buildTarget: ProjectBuildTarget | null = null,
): string => JSON.stringify(normalizeFingerprintValue({
    workspace: workspaceState,
    buildTarget,
    board: String(board || ''),
    boardPackageId: String(boardPackageId || ''),
    options,
}));

const pinBoardFromPackage = (board: any): PinPreflightBoard | null => {
    const fqbn = baseBoardFqbn(String(board?.fqbn_base || board?.fqbnBase || board?.fqbn || ''));
    const pins = Array.isArray(board?.pins)
        ? board.pins.flatMap((pin: any) => {
            const label = String(pin?.label || pin?.name || '').trim();
            const value = String(pin?.value ?? pin?.pin ?? '').trim();
            return label && value ? [{ ...pin, label, value }] : [];
        })
        : [];
    const runtimeGate = fqbn && board?.is_custom
        ? evaluateBoardPackageBuildGate([board], fqbn, boardPackageKey(board))
        : null;
    if (!board?.is_custom
        || !runtimeGate?.canBuild
        || !fqbn
        || pins.length === 0) return null;
    return {
        name: String(board?.name || board?.id || fqbn),
        fqbn,
        pins,
        packageId: boardPackageKey(board),
        isCustom: true,
        pinEvidenceLevel: 'publisher',
    };
};

const createPinBoardCatalog = (
    availableBoards: any[],
    activeBoardPackage: any,
    activeBoardPackageId: string,
    targetFqbn: string,
    installedCorePinAliases: InstalledCorePinAliasCatalog | null,
): PinPreflightBoard[] => {
    const targetPinFqbn = baseBoardFqbn(targetFqbn);
    const selectedCustomPinBoard = pinBoardFromPackage(activeBoardPackage);
    const customPackageOwnsTarget = activeBoardPackage?.is_custom === true
        || Boolean(activeBoardPackageId && activeBoardPackageId !== targetPinFqbn);
    return [
        ...(selectedCustomPinBoard ? [selectedCustomPinBoard] : []),
        ...PIN_PREFLIGHT_BOARDS
            .filter(board => (
                !customPackageOwnsTarget || baseBoardFqbn(board.fqbn) !== targetPinFqbn
            ))
            .map(board => mergeInstalledCorePinAliases(board, installedCorePinAliases)),
        ...availableBoards.flatMap((board: any) => {
            if (boardPackageKey(board) === activeBoardPackageId) return [];
            const candidate = pinBoardFromPackage(board);
            if (!candidate) return [];
            if (customPackageOwnsTarget && baseBoardFqbn(candidate.fqbn) === targetPinFqbn) return [];
            return [candidate];
        }),
    ];
};

const UnsavedChangesDialog = ({
    context,
    projectName,
    willCreateCheckpoint,
    onChoose,
}: {
    context: UnsavedNavigationContext;
    projectName: string;
    willCreateCheckpoint: boolean;
    onChoose: (choice: UnsavedNavigationChoice) => void;
}) => {
    const cancelRef = useRef<HTMLButtonElement>(null);
    const actionLabel = context === 'back' ? '返回项目列表' : context === 'open' ? '打开其他工程' : '退出软件';
    const saveLabel = context === 'back' ? '保存并返回' : context === 'open' ? '保存后打开' : '保存并退出';
    const discardLabel = context === 'back' ? '不保存，返回' : context === 'open' ? '不保存，继续打开' : '不保存，退出';

    useEffect(() => {
        cancelRef.current?.focus();
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            onChoose('cancel');
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onChoose]);

    return (
        <div
            className="fixed inset-0 z-[10050] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-[2px] dark:bg-black/70"
            onMouseDown={() => onChoose('cancel')}
        >
            <div
                className="w-full max-w-[540px] overflow-hidden rounded-xl border border-amber-200 bg-white shadow-2xl dark:border-amber-800/70 dark:bg-slate-900"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="ck-unsaved-title"
                aria-describedby="ck-unsaved-description"
                data-ck-role="unsaved-changes-dialog"
                onMouseDown={(event) => event.stopPropagation()}
            >
                <div className="flex items-start gap-3 border-b border-amber-100 bg-amber-50 px-5 py-4 dark:border-amber-900/60 dark:bg-amber-950/35">
                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-900/70 dark:text-amber-300">
                        <AlertTriangle size={19} />
                    </span>
                    <div className="min-w-0">
                        <h2 id="ck-unsaved-title" className="text-base font-bold text-slate-900 dark:text-slate-100">工程尚未保存</h2>
                        <p className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400" title={projectName}>{projectName}</p>
                    </div>
                </div>
                <div id="ck-unsaved-description" className="space-y-3 px-5 py-4 text-sm leading-6 text-slate-600 dark:text-slate-300">
                    <p>当前工程的积木、板卡或编译选项已经修改。要{actionLabel}，请选择如何处理这些修改。</p>
                    <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-400">
                        {willCreateCheckpoint
                            ? '选择不保存时，CK 会先创建一个本地保护检查点，之后仍可从“工程检查点”恢复。'
                            : '当前环境无法创建本地保护检查点；选择不保存后，这些修改将无法恢复。'}
                    </p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3 dark:border-slate-700 dark:bg-slate-900">
                    <button
                        type="button"
                        onClick={() => onChoose('discard')}
                        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-red-200 bg-white px-3 text-xs font-bold text-red-700 transition-colors hover:bg-red-50 dark:border-red-900 dark:bg-slate-800 dark:text-red-300 dark:hover:bg-red-950/45"
                    >
                        {context === 'open' ? <FolderOpen size={14} /> : <ArrowLeft size={14} />}
                        {discardLabel}
                    </button>
                    <button
                        ref={cancelRef}
                        type="button"
                        onClick={() => onChoose('cancel')}
                        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                    >
                        <X size={14} />
                        取消
                    </button>
                    <button
                        type="button"
                        onClick={() => onChoose('save')}
                        className="inline-flex h-9 items-center gap-1.5 rounded-md bg-brand-600 px-3 text-xs font-bold text-white transition-colors hover:bg-brand-700"
                    >
                        <Save size={14} />
                        {saveLabel}
                    </button>
                </div>
            </div>
        </div>
    );
};

const CK_FUNCTION_FLYOUT_BLOCK_TYPES = [
    'procedures_defnoreturn',
    'procedures_defreturn',
    'procedures_callnoreturn_picker',
    'procedures_callreturn_picker',
    'procedures_return_void_custom',
    'procedures_return_value_custom',
    'procedures_ifreturn_void_custom',
    'procedures_ifreturn_value_custom',
];

const TOOLBOX_CATEGORY_CLASS_BY_NAME: Record<string, string> = {
    '引脚': 'category-pins',
    '时间': 'category-timing',
    '逻辑': 'category-control',
    '循环': 'category-loop',
    '函数': 'category-function',
    '串口': 'category-serial',
    '文本': 'category-text',
    '数组': 'category-array',
    '变量': 'category-variables',
    '运算': 'category-math',
    '网络': 'category-network',
};
const TOOLBOX_CATEGORY_CLASSES = Array.from(new Set(Object.values(TOOLBOX_CATEGORY_CLASS_BY_NAME)));
const TOOLBOX_SELECTED_CLASS = 'ck-toolbox-selected';
const SERIAL_BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 500000, 921600, 1000000, 2000000] as const;
const DETACHED_CONSOLE_LABEL = 'ck-console-window';

type DetachedConsoleCommand = {
    action: 'ready' | 'open' | 'close' | 'set-settings' | 'send' | 'dock';
    port?: string;
    baud?: number;
    data?: number[];
};

type DetachedConsoleStatePayload = {
    feedbackRunId: string | null;
    compiling: boolean;
    open: boolean;
    switching: boolean;
    selectedPort: string;
    monitorPort: string;
    baud: number;
    ports: Array<{
        port_name: string;
        description?: string;
        hardware_id?: string;
    }>;
    error?: string;
};

const initialSerialBaudRate = (): number => {
    if (typeof window === 'undefined') return 115200;
    const stored = Number(window.localStorage.getItem('ck.serial.baudRate'));
    return SERIAL_BAUD_RATES.includes(stored as typeof SERIAL_BAUD_RATES[number]) ? stored : 115200;
};

const isKnownBlockType = (type: string | null | undefined): boolean => {
    if (!type) return false;
    return Boolean((Blockly as any).Blocks?.[type]);
};

const collectExtensionBlockColours = (toolboxXml: string): Map<string, string> => {
    const colours = new Map<string, string>();
    if (typeof DOMParser === 'undefined' || !toolboxXml.trim()) return colours;

    try {
        const parser = new DOMParser();
        const document = parser.parseFromString(`<xml>${toolboxXml}</xml>`, 'text/xml');
        if (document.querySelector('parsererror')) return colours;

        const visitCategory = (category: Element, inheritedColour = '') => {
            const categoryColour = String(
                category.getAttribute('colour') || category.getAttribute('color') || inheritedColour,
            ).trim();
            for (const child of Array.from(category.children)) {
                const tag = child.tagName.toLowerCase();
                if (tag === 'category') {
                    visitCategory(child, categoryColour);
                    continue;
                }
                if (tag !== 'block' || !categoryColour) continue;
                const type = String(child.getAttribute('type') || '').trim();
                if (type) colours.set(type, categoryColour);
            }
        };

        document.querySelectorAll(':scope > xml > category, xml > category').forEach((category) => {
            visitCategory(category);
        });
    } catch {
        // A malformed third-party toolbox should not block the editor.
    }
    return colours;
};

// Local SerialPortInfo interface removed, using global context

// SerialLogRow component removed as we use xterm.js now

export default function Workspace({ projectPath, onBack, onProjectOpenListenerReady, forceBoard, forceBoardPackageId, missingBoard, theme, initialCheckOpen = false }: WorkspaceProps) {
    const { t, i18n: appI18n } = useTranslation();
    const { t: buildTranslate } = useTranslation('build');
    const { t: editorTranslate } = useTranslation('editor');
    const { t: healthTranslate } = useTranslation('health');
    const buildT = buildTranslate as unknown as (key: string, options?: Record<string, unknown>) => string;
    const dialog = useDialog();
    const { resolvedTheme } = useAppTheme();
    useEffect(() => installBlocklyOverlayLifecycle(Blockly, document), []);
    const [currentPath, setCurrentPath] = useState(projectPath); // Track path internally for Save As
    const [reloadTrigger, setReloadTriggerState] = useState(0); // Force reload if opening same file
    const reloadTriggerRef = useRef(reloadTrigger);
    // A code fingerprint changes on every edit; it must never select a new
    // native build directory. Project navigation/reload gets a separate owner.
    const nativeBuildProjectRef = useRef(crypto.randomUUID());
    const [consoleOpen, setConsoleOpen] = useState(false);
    const [isConsoleDetached, setIsConsoleDetached] = useState(false);
    const [codeViewOpen, setCodeViewOpen] = useState(false);
    const [aiOpen, setAiOpen] = useState(false);
    const [aiIntent, setAiIntent] = useState<AiIntent>({ id: 0, kind: 'generate' });
    const openAi = useCallback((intent: Omit<AiIntent, 'id'> = { kind: 'generate' }) => {
        workspaceRef.current?.hideChaff();
        setCodeViewOpen(false); setIsEngineeringHealthOpen(false);
        setAiIntent({ ...intent, id: Date.now() }); setAiOpen(true);
    }, []);
    const [isPortMenuOpen, setIsPortMenuOpen] = useState(false);
    const [isFileMenuOpen, setIsFileMenuOpen] = useState(false);
    const [isViewMenuOpen, setIsViewMenuOpen] = useState(false);
    const runViewMenuAction = useCallback((action: () => void) => {
        // Close synchronously before starting an action. Window focus changes can
        // move this webview to the background before React receives another
        // pointer event, so relying on click-outside leaves the popover visible.
        setIsViewMenuOpen(false);
        action();
    }, []);
    useEffect(() => {
        if (!isViewMenuOpen) return;
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            setIsViewMenuOpen(false);
        };
        window.addEventListener('keydown', closeOnEscape);
        return () => window.removeEventListener('keydown', closeOnEscape);
    }, [isViewMenuOpen]);
    const [isAppearanceSettingsOpen, setIsAppearanceSettingsOpen] = useState(false);
    const closeAppearanceSettings = useCallback(() => setIsAppearanceSettingsOpen(false), []);
    const [isBuildMenuOpen, setIsBuildMenuOpen] = useState(false);
    const [isLibManagerOpen, setIsLibManagerOpen] = useState(false);
    const [isCheckpointsOpen, setIsCheckpointsOpen] = useState(false);
    const [isLastWorkingVersionOpen, setIsLastWorkingVersionOpen] = useState(false);
    const [isDiagnosticBundleOpen, setIsDiagnosticBundleOpen] = useState(false);
    const [isProjectAcceptanceReportOpen, setIsProjectAcceptanceReportOpen] = useState(false);
    const [isEngineeringHealthOpen, setIsEngineeringHealthOpen] = useState(false);
    const [workspaceDisplayMode, setWorkspaceDisplayMode] = useState<WorkspaceViewMode>(() => readWorkspaceViewMode());
    const [blocklyVisualStyle, setBlocklyVisualStyle] = useState<BlocklyVisualStyle>(() => (
        readBlocklyVisualStyle(getBrowserBlocklyVisualStyleStorage())
    ));
    // Blockly has its own locale preference.  Resolve it from the persisted
    // preference on every UI-language render, but keep the previous value in a
    // ref so a language change can be applied through the same controlled
    // serialize/dispose/reinject/load transaction used by renderer changes.
    const [blockLocalePreferenceRevision, setBlockLocalePreferenceRevision] = useState(0);
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const onBlockLocalePreferenceChanged = () => {
            setBlockLocalePreferenceRevision(revision => revision + 1);
        };
        window.addEventListener(
            BLOCK_LOCALE_PREFERENCE_CHANGED_EVENT,
            onBlockLocalePreferenceChanged,
        );
        return () => window.removeEventListener(
            BLOCK_LOCALE_PREFERENCE_CHANGED_EVENT,
            onBlockLocalePreferenceChanged,
        );
    }, []);
    const effectiveBlocklyLocale = useMemo(() => {
        const preferences = getLocalePreferences();
        const uiLocale = normalizeUiLocale(appI18n.language) ?? preferences.uiLocale;
        return getEffectiveBlocklyLocale(preferences.blockLocale, uiLocale);
    }, [appI18n.language, blockLocalePreferenceRevision]);
    const blocklyLocaleRef = useRef<BlocklyLocale>(effectiveBlocklyLocale);
    // Keep the currently loaded declarative package definitions available to
    // the locale transition transaction.  Re-registering these definitions
    // changes presentation fields only; generators, runtime keys and package
    // inventory remain untouched.
    const activeExtensionLocaleEntriesRef = useRef<ActiveExtensionLocaleEntry[]>([]);
    const extensionLocaleRefreshSeqRef = useRef(0);
    const refreshActiveExtensionLocales = useCallback(async (nextLocale: BlocklyLocale) => {
        const refreshSeq = ++extensionLocaleRefreshSeqRef.current;
        // Snapshot the active set for this transaction. The board loader may
        // replace the ref while the async file reads are in flight; avoid
        // mixing definitions from two boards during a locale transition.
        const boardLoadSeq = extensionLoadSeqRef.current;
        const entries = activeExtensionLocaleEntriesRef.current.slice();
        for (const entry of entries) {
            if (refreshSeq !== extensionLocaleRefreshSeqRef.current) return;
            if (boardLoadSeq !== extensionLoadSeqRef.current) return;
            const extension = entry.extension;
            if (!extension.block_package_manifest || !extension.block_locale_bundle) continue;
            try {
                await registerExtensionBlocks(
                    { ...extension, block_locale: nextLocale },
                    Blockly as any,
                    entry.visualColour,
                    entry.boardIdentity,
                );
            } catch (error) {
                // A malformed optional locale must never block the workspace
                // transaction. The package loader already preserves the raw
                // presentation as its safe fallback.
                console.warn(`[Workspace] Failed to refresh block locale for ${extension.id}`, error);
            }
        }
    }, []);
    // Toolbox callbacks are installed on Blockly-owned DOM and can outlive the
    // render that created them. Always resolve the current skin at paint time,
    // otherwise a delayed flyout refresh can restore the startup skin.
    const blocklyVisualStyleRef = useRef(blocklyVisualStyle);
    blocklyVisualStyleRef.current = blocklyVisualStyle;
    const [isBlocklyVisualStyleSwitching, setIsBlocklyVisualStyleSwitching] = useState(false);
    const [blocklyRendererRevision, setBlocklyRendererRevision] = useState(0);
    const [rendererRecoveryFailure, setRendererRecoveryFailure] = useState<BlocklyRendererRecoveryFailure | null>(null);
    const [unknownBlockProtection, setUnknownBlockProtection] = useState<{
        projectPath: string;
        projectName: string;
        inspection: WorkspaceLoadInspection;
    } | null>(null);
    const [projectLoadSafetyError, setProjectLoadSafetyError] = useState<string | null>(null);
    const [recoveryCandidate, setRecoveryCandidate] = useState<{
        metadata: RecoveryDraftMetadata;
        draft: RecoveryDraft;
        currentState: RecoveryDraftState;
        session: RecoveryProjectSession;
    } | null>(null);
    const [recoveryBusy, setRecoveryBusy] = useState(false);
    const [projectLoadedRevision, setProjectLoadedRevision] = useState(0);
    const loadedProjectWorkspaceFormatRef = useRef<'json' | 'xml' | null>(null);
    const [engineeringHealthWidth, setEngineeringHealthWidth] = useState(() => {
        try {
            const stored = Number(window.localStorage.getItem('ck_engineering_health_dock_width'));
            if (Number.isFinite(stored) && stored >= 280 && stored <= 640) return stored;
        } catch { /* Storage can be unavailable in restricted webviews. */ }
        return 350;
    });
    const [isProjectDirty, setIsProjectDirty] = useState(false);
    const [unsavedDialogContext, setUnsavedDialogContext] = useState<UnsavedNavigationContext | null>(null);
    const [librarySearchRequest, setLibrarySearchRequest] = useState<{
        requestId: number;
        query: string;
    } | null>(null);
    const librarySearchRequestIdRef = useRef(0);
    const cleanProjectFingerprintRef = useRef<string | null>(null);
    const dirtyTrackingReadyRef = useRef(false);
    const dirtyCompareTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [codePreviewPending, setCodePreviewPending] = useState(false);
    const [codePreviewError, setCodePreviewError] = useState(false);
    const [projectLoadProgress, setProjectLoadProgress] = useState<BlocklyLoadProgress | null>(null);
    const projectLoadControllerRef = useRef<AbortController | null>(null);
    const projectLoadingRef = useRef(false);
    const viewportCullingRef = useRef<ReturnType<typeof installBlocklyViewportCulling> | null>(null);
    const recoveryPreviewWorkersRef = useRef(new Set<ReturnType<typeof createBlocklyCodePreview>>());
    const unsavedChoiceResolverRef = useRef<((choice: UnsavedNavigationChoice) => void) | null>(null);
    const allowWindowCloseRef = useRef(false);

    const applyWorkspaceDisplayMode = useCallback((mode: WorkspaceViewMode) => {
        setWorkspaceDisplayMode(persistWorkspaceViewMode(mode));
    }, []);

    const openEngineeringHealth = useCallback(() => {
        setAiOpen(false);
        // At compact desktop widths two simultaneous inspectors leave too little room
        // for Blockly. Treat the health dock as the active inspector in that case.
        if (window.innerWidth < 1180) setCodeViewOpen(false);
        workspaceRef.current?.hideChaff();
        setIsEngineeringHealthOpen(true);
    }, []);

    useEffect(() => {
        if (initialCheckOpen) openEngineeringHealth();
    }, [initialCheckOpen, openEngineeringHealth]);

    const toggleCodeView = useCallback(() => {
        setAiOpen(false);
        workspaceRef.current?.hideChaff();
        if (codeViewOpen) {
            setCodeViewOpen(false);
            return;
        }
        if (window.innerWidth < 1180) setIsEngineeringHealthOpen(false);
        setCodeViewOpen(true);
    }, [codeViewOpen]);

    useEffect(() => {
        try {
            window.localStorage.setItem('ck_engineering_health_dock_width', String(engineeringHealthWidth));
        } catch { /* Width persistence is best-effort only. */ }
    }, [engineeringHealthWidth]);

    // Backend / Hardware State
    // Backend / Hardware State
    const { ports, activePort, connectDevice, scanPorts, activeBoard, activeBoardPackageId, setActiveBoard, boardOptions, resolvedBoardOptions, displayBoardOptions, boardOptionsStatus, droppedBoardOptions, setBoardOptions, availableBoards, availableLibraries, installedCoreVersions } = useHardware();
    const activeBoardDirtyRef = useRef(activeBoard);
    const activeBoardPackageIdDirtyRef = useRef(activeBoardPackageId);
    const boardOptionsDirtyRef = useRef<Record<string, unknown>>(boardOptions);
    const activeCoreId = useMemo(() => String(activeBoard || '').split(':').slice(0, 2).join(':'), [activeBoard]);
    const activeCoreVersion = installedCoreVersions[activeCoreId] || '';
    const [recordedBuildTarget, setRecordedBuildTarget] = useState<ProjectBuildTarget | null>(null);
    const recordedBuildTargetRef = useRef<ProjectBuildTarget | null>(null);
    const previousDirtyTargetRef = useRef<ProjectBuildTarget | null>(null);
    const updateRecordedBuildTarget = useCallback((target: ProjectBuildTarget | null) => {
        recordedBuildTargetRef.current = target;
        setRecordedBuildTarget(target);
    }, []);
    const buildEnvironment: ProjectBuildEnvironment = {
        board: activeBoard, boardPackageId: activeBoardPackageId, coreVersion: activeCoreVersion,
        options: boardOptions, effectiveOptions: displayBoardOptions,
        resolved: boardOptionsStatus === 'resolved' && Object.keys(droppedBoardOptions).length === 0,
    };
    const buildEnvironmentRef = useRef(buildEnvironment);
    buildEnvironmentRef.current = buildEnvironment;
    const captureBuildTarget = useCallback(() => captureProjectBuildTarget(
        buildEnvironmentRef.current, recordedBuildTargetRef.current,
    ), []);
    const buildTargetDifference = projectBuildTargetDifference(recordedBuildTarget, buildEnvironment);
    const adoptCurrentBuildEnvironment = () => {
        if (!buildEnvironment.resolved || !activeCoreVersion) return;
        setBoardOptions(displayBoardOptions);
        updateRecordedBuildTarget(captureProjectBuildTarget({ ...buildEnvironment, options: displayBoardOptions }, null));
        setIsProjectDirty(true);
    };

    const activeBoardPackage = useMemo(
        () => resolveBoardPackage(availableBoards, activeBoard, activeBoardPackageId),
        [activeBoard, activeBoardPackageId, availableBoards],
    );
    const activeBoardPackageBuildGate = useMemo(
        () => evaluateBoardPackageBuildGate(
            availableBoards,
            activeBoard,
            activeBoardPackageId,
        ),
        [activeBoard, activeBoardPackageId, availableBoards],
    );
    const effectiveCompileFqbn = useMemo(
        () => composeBoardFqbn(activeBoard, resolvedBoardOptions),
        [activeBoard, resolvedBoardOptions],
    );
    const [installedCorePinAliases, setInstalledCorePinAliases] = useState<InstalledCorePinAliasCatalog | null>(null);
    const [corePinAliasReloadSeq, setCorePinAliasReloadSeq] = useState(0);
    const corePinAliasLoadSeqRef = useRef(0);
    useEffect(() => {
        const reload = () => setCorePinAliasReloadSeq(value => value + 1);
        window.addEventListener(CORE_PIN_ALIAS_CACHE_INVALIDATED_EVENT, reload);
        return () => window.removeEventListener(CORE_PIN_ALIAS_CACHE_INVALIDATED_EVENT, reload);
    }, []);
    useEffect(() => {
        const requestId = corePinAliasLoadSeqRef.current + 1;
        corePinAliasLoadSeqRef.current = requestId;
        setInstalledCorePinAliases(null);
        if (
            !effectiveCompileFqbn
            || activeBoardPackage?.is_custom === true
            || Boolean(activeBoardPackageId && activeBoardPackageId !== baseBoardFqbn(activeBoard))
            || boardOptionsStatus === 'loading'
            || boardOptionsStatus === 'unverified'
        ) return;
        void getInstalledCorePinAliasesCached(effectiveCompileFqbn)
            .then(catalog => {
                if (corePinAliasLoadSeqRef.current === requestId) {
                    setInstalledCorePinAliases(catalog);
                }
            })
            .catch(() => {
                if (corePinAliasLoadSeqRef.current === requestId) {
                    setInstalledCorePinAliases(null);
                }
            });
    }, [
        activeBoardPackage,
        activeBoardPackageId,
        activeCoreVersion,
        boardOptionsStatus,
        corePinAliasReloadSeq,
        effectiveCompileFqbn,
    ]);
    const currentPathRef = useRef(currentPath);
    const effectiveCompileFqbnRef = useRef(effectiveCompileFqbn);
    const compileTargetPreproofSeqRef = useRef(0);
    currentPathRef.current = currentPath;
    effectiveCompileFqbnRef.current = effectiveCompileFqbn;
    useEffect(() => {
        const requestId = compileTargetPreproofSeqRef.current + 1;
        compileTargetPreproofSeqRef.current = requestId;
        const targetFqbn = String(effectiveCompileFqbn || '').trim();
        if (
            !targetFqbn
            || boardOptionsStatus === 'loading'
            || boardOptionsStatus === 'unverified'
        ) return;

        const timer = window.setTimeout(() => {
            void preproofCompileTarget(targetFqbn, activeBoardPackageId)
                .then(result => {
                    if (
                        compileTargetPreproofSeqRef.current !== requestId
                        || effectiveCompileFqbnRef.current !== targetFqbn
                    ) return;
                    console.debug('[CK Forge] compile target identity preproof ready', {
                        fqbn: result.fqbn,
                        coreVersion: result.coreVersion,
                        source: result.source,
                        elapsedMs: result.elapsedMs,
                        cacheHit: result.cacheHit,
                    });
                })
                .catch(error => {
                    if (compileTargetPreproofSeqRef.current !== requestId) return;
                    // Preproof is opportunistic. The foreground compile repeats
                    // every authoritative check and remains the only error UI.
                    console.debug('[CK Forge] compile target identity preproof skipped', error);
                });
        // Start the read-only identity proof as soon as the board/options settle.
        // A longer debounce let a fast Compile click reach the authoritative path
        // before this reusable Core/toolchain proof was warm. Fifty milliseconds
        // still collapses transient option updates without putting the scan behind
        // a human click. This never invokes CLI, compilation, upload, or warmup.
        }, 50);

        return () => {
            window.clearTimeout(timer);
            if (compileTargetPreproofSeqRef.current === requestId) {
                compileTargetPreproofSeqRef.current += 1;
            }
        };
    }, [activeBoardPackageId, boardOptionsStatus, effectiveCompileFqbn]);
    const displayConfigurationFqbn = useMemo(
        () => composeBoardFqbn(activeBoard, displayBoardOptions),
        [activeBoard, displayBoardOptions],
    );
    const [isCompiling, setIsCompiling] = useState(false);
    const [isBuildPreparing, setIsBuildPreparing] = useState(false);
    const [foregroundBuildEvidence, setForegroundBuildEvidence] = useState<ForegroundBuildEvidence | null>(null);
    const [breakpointIds, setBreakpointIds] = useState<Set<string>>(new Set());
    const [blockDebugSession, setBlockDebugSession] = useState<BlockDebugSessionState>(IDLE_BLOCK_DEBUG_SESSION);
    const [debugRecoveryNotice, setDebugRecoveryNotice] = useState('');
    const [blockRunMode, setBlockRunMode] = useState<BlockRunMode>(null);
    const [blockTraceSnapshot, setBlockTraceSnapshot] = useState<BlockTraceSnapshot | null>(null);
    const [blockTraceFirmwareFps, setBlockTraceFirmwareFps] = useState(25);

    // Board Definition-Use DYNAMIC AVAILABLE BOARDS
    const BOARDS_LIST = availableBoards.length > 0
        ? availableBoards.map(b => ({ name: b.name, fqbn: b.fqbn || b.id }))
        : BOARDS.map(b => ({ name: b.name, fqbn: b.id }));

    // Serial Settings
    const [baudRate, setBaudRate] = useState(initialSerialBaudRate);

    // Serial Monitor State
    const [isSerialMonitorOpen, setIsSerialMonitorOpen] = useState(false);
    const [monitorBaudRate, setMonitorBaudRate] = useState<number | null>(null);
    const [monitorPort, setMonitorPort] = useState<string | null>(null);
    const [isSerialMonitorSwitching, setIsSerialMonitorSwitching] = useState(false);
    const [serialInput, setSerialInput] = useState('');
    const [lineEnding, setLineEnding] = useState(''); // '' | '\n' | '\r' | '\r\n'
    const [viewMode, setViewMode] = useState<'text' | 'hex'>('text');

    // Console State
    // Console only carries serial data and raw build output. Structured engineering
    // health has its own responsive drawer so opening it never steals console state.
    const [consoleTab, setConsoleTab] = useState<'serial' | 'compile'>('serial');
    const [compileLog, setCompileLog] = useState<string>("");
    const [feedbackRunId, setFeedbackRunId] = useState<string | null>(null);
    const [compileLogViewMode, setCompileLogViewMode] = useState<'key' | 'full'>('key');
    const [compileDoctorReport, setCompileDoctorReport] = useState<CompileDoctorReport | null>(null);
    const [projectUploadResult, setProjectUploadResult] = useState<ProjectUploadResult | null>(null);
    const healthCapabilities = projectHealthCapabilities(effectiveCompileFqbn);
    const [deviceHealthPublication, setDeviceHealthPublication] = useState<DeviceHealthPublication | null>(null);
    const [isDeviceHealthRunning, setIsDeviceHealthRunning] = useState(false);
    const [compileIssues, setCompileIssues] = useState<CompileIssueCard[]>([]);
    const [pinPreflightReport, setPinPreflightReport] = useState<PinPreflightReport | null>(null);
    const [compileEnvironmentSnapshot, setCompileEnvironmentSnapshot] = useState<CompileEnvironmentSnapshot | null>(
        () => loadCompileEnvironmentSnapshot(projectPath),
    );
    const [compileResourceSnapshot, setCompileResourceSnapshot] = useState<CompileResourceSnapshot | null>(
        () => loadCompileResourceSnapshot(projectPath, effectiveCompileFqbn),
    );
    const [compileResourceReport, setCompileResourceReport] = useState<CompileResourceReport | null>(
        () => compileResourceSnapshotToReport(compileResourceSnapshot),
    );
    // Presentation-only projection of the latest completed production resource
    // observation/live preflight. It is never persisted and never participates
    // in compile requests, workspace identity, or build evidence.
    const [hardwareResourceInspector, setHardwareResourceInspector] = useState<HardwareResourceInspectorView | null>(null);
    const [resourcePreflightReport, setResourcePreflightReport] = useState<ResourcePreflightReport | null>(null);
    const [isResourcePreflightRunning, setIsResourcePreflightRunning] = useState(false);
    // Read-only session presentation for Dashboard; never part of project files
    // or the compile request/evidence. Old results are explicitly historical.
    useEffect(() => {
        publishProjectStatus(currentPath, {
            compileReport: compileDoctorReport, resourceReport: resourcePreflightReport,
            issues: compileIssues, dirty: isProjectDirty, observedAt: Date.now(),
        });
    }, [currentPath, compileDoctorReport, resourcePreflightReport, compileIssues, isProjectDirty]);
    // A committed Blockly event can change resource claim metadata even when
    // generated source stays byte-for-byte identical. Keep a presentation-only
    // revision so the debounced preflight runs for every content edit.
    const [resourcePreflightRevision, setResourcePreflightRevision] = useState(0);
    const currentDeviceHealthReport = useMemo(() => {
        if (!deviceHealthPublication) return null;
        if (deviceHealthPublication.target.fqbn !== effectiveCompileFqbn) return null;
        if (deviceHealthPublication.target.port !== (activePort || '')) return null;
        return deviceHealthPublication.report;
    }, [activePort, deviceHealthPublication, effectiveCompileFqbn]);
    const hasEngineeringHealthResults = Boolean(
        compileDoctorReport
        || currentDeviceHealthReport
        || compileResourceReport
        || pinPreflightReport
        || hardwareResourceInspector
        || resourcePreflightReport
        || compileIssues.length > 0,
    );
    const engineeringHealthHasProblem = Boolean(
        compileDoctorReport?.status === 'problem'
        || currentDeviceHealthReport?.outcome === 'failed'
        || currentDeviceHealthReport?.checks.some(check => check.state === 'error')
        || compileResourceReport?.flash?.level === 'critical'
        || compileResourceReport?.ram?.level === 'critical'
        || resourcePreflightReport?.status === 'conflict'
        || pinPreflightReport?.blockers.length
        || compileIssues.some(issue => issue.severity === 'error'),
    );
    const engineeringHealthNeedsAttention = Boolean(
        !engineeringHealthHasProblem
        && (
            compileDoctorReport?.status === 'attention'
            || currentDeviceHealthReport?.outcome === 'partial'
            || currentDeviceHealthReport?.checks.some(check => check.state === 'warning')
            || compileResourceReport?.flash?.level === 'warning'
            || compileResourceReport?.ram?.level === 'warning'
            || resourcePreflightReport?.status === 'warning'
            || pinPreflightReport?.warnings.length
            || compileIssues.some(issue => issue.severity === 'warning')
        ),
    );
    useEffect(() => {
        if (isCompiling || isDeviceHealthRunning || blockDebugSession.active) {
            setIsBuildMenuOpen(false);
        }
    }, [blockDebugSession.active, isCompiling, isDeviceHealthRunning]);
    const compileLogRef = useRef("");
    const compileLogBufferRef = useRef(createCompileLogBuffer());
    const compileLogFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => {
        if (compileLogFlushRef.current !== null) clearTimeout(compileLogFlushRef.current);
    }, []);
    const compileResourceSnapshotRef = useRef<CompileResourceSnapshot | null>(compileResourceSnapshot);
    const isCompilingRef = useRef(false);
    const compileStreamSeenRef = useRef(false);
    const compileTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const compileSessionRef = useRef(0);
    const foregroundBuildRunIdRef = useRef<string | null>(null);
    const buildCancelInFlightRef = useRef(false);
    const cancelRequestedBuildRunIdsRef = useRef<Set<string>>(new Set());
    // Ephemeral presentation analysis; never persisted or included in build evidence.
    const productionResourceAnalysisRef = useRef<ReturnType<typeof analyzeProductionResolvedResources>>(null);
    const compilerResourcePresentationRef = useRef<CompilerResourcePresentationCache | null>(null);
    const compilerObservationAttemptRef = useRef<CompilerObservationAttempt | null>(null);
    useEffect(() => () => { compilerObservationAttemptRef.current = null; }, []);
    useEffect(() => {
        // A project/target switch invalidates the prior presentation snapshot.
        // A custom board may still expose a validated graph before its first
        // compile; show that graph-only view without inventing claims.
        productionResourceAnalysisRef.current = null;
        compilerResourcePresentationRef.current = null;
        compilerObservationAttemptRef.current = null;
        setResourcePreflightReport(null);
        setIsResourcePreflightRunning(false);
        const graph = activeBoardPackage?.resource_graph;
        if (graph) {
            try {
                setHardwareResourceInspector(buildHardwareResourceInspector({ graph }));
                return;
            } catch {
                // Fall through to an empty optional panel.
            }
        }
        setHardwareResourceInspector(null);
    }, [activeBoard, activeBoardPackage?.resource_graph, activeBoardPackageId, currentPath, effectiveCompileFqbn, projectLoadedRevision]);
    const compileSourceMapSessionRef = useRef<{
        sourceMap: Readonly<CompileSourceMapV1>;
        code: string;
        runId: string;
        trustedSketchAlias: TrustedCompileSketchAliasV1 | null;
        aliasRevoked: boolean;
        blockPresentations: ReadonlyMap<string, Readonly<CompileIssueBlockPresentation>>;
    } | null>(null);
    const deviceHealthRequestIdRef = useRef(0);
    const deviceHealthRunningRef = useRef(false);
    const pendingForceRebuildRef = useRef(false);
    const pendingBoardOptionBuildRef = useRef<PendingBoardOptionBuild | null>(null);
    const silentPrecompileSchedulerRef = useRef<SilentPrecompileScheduler | null>(null);
    const breakpointIdsRef = useRef<Set<string>>(new Set());
    const blockDebugSessionRef = useRef<BlockDebugSessionState>(IDLE_BLOCK_DEBUG_SESSION);
    const blockRunModeRef = useRef<BlockRunMode>(null);
    const debugTokenToBlockIdRef = useRef<Map<string, string>>(new Map());
    const traceIndexToBlockIdRef = useRef<Map<number, string>>(new Map());
    const traceAggregatorRef = useRef<BlockTraceAggregator | null>(null);
    const debuggableBlockIdsRef = useRef<Set<string>>(new Set());
    const generatedCodeRef = useRef('');
    const debugStreamParserRef = useRef(new CkDebugStreamParser());
    const debugFrameHandlerRef = useRef<(frame: CkDebugFrame) => void>(() => undefined);
    const debugStopCommandInFlightRef = useRef(false);
    const debugAttachCommandInFlightRef = useRef(false);
    const debugAttachTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const debugAttachRetryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const debugHasAttachedRef = useRef(false);
    const cancelDebugBuildRef = useRef<() => Promise<void>>(async () => undefined);
    const debugCommandSequenceRef = useRef(0);
    const debugMinimumSequenceRef = useRef(0);
    const debugCommandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const tracePublishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingCheckpointRestoreRef = useRef<ProjectCheckpoint | null>(null);

    // New Serial Monitor Ref
    const serialMonitorRef = useRef<SerialTerminalRef>(null);
    const isConsoleDetachedRef = useRef(false);
    const detachedConsoleCommandHandlerRef = useRef<(command: DetachedConsoleCommand) => Promise<void>>(
        async () => undefined,
    );
    const desiredSerialOpenRef = useRef(false);
    const serialReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const serialReconnectAttemptsRef = useRef(0);
    const activePortRef = useRef<string | null>(activePort);
    const baudRateRef = useRef(baudRate);
    const monitorBaudRateRef = useRef<number | null>(null);
    const monitorPortRef = useRef<string | null>(null);
    const serialSettingsSeqRef = useRef(0);
    const scanPortsRef = useRef(scanPorts);
    const toolboxUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearInitialDebugAttachTimers = useCallback(() => {
        if (debugAttachTimeoutRef.current) {
            clearTimeout(debugAttachTimeoutRef.current);
            debugAttachTimeoutRef.current = null;
        }
        if (debugAttachRetryTimerRef.current) {
            clearInterval(debugAttachRetryTimerRef.current);
            debugAttachRetryTimerRef.current = null;
        }
    }, []);

    // Stats Refs & State
    const bytesReceivedRef = useRef(0);
    const linesReceivedRef = useRef(0);
    // const [monitorStats, setMonitorStats] = useState({ kbps: 0, lps: 0 }); // Moved to StatusFooter

    const [consoleExpanded, setConsoleExpanded] = useState(false);
    const [isPaused, setIsPaused] = useState(false);
    const [showTimestamp, setShowTimestamp] = useState(false);
    const [consoleViewMode, setConsoleViewMode] = useState<'text' | 'plot'>('text');
    const compileLogScrollRef = useRef<HTMLDivElement>(null);
    const compileLogLines = useMemo(() => compileLog.split(/\r?\n/), [compileLog]);
    const compileLogResultLinesRef = useRef<Map<number, BuildOperationResultCode>>(new Map());
    const compileLogDigest = useMemo(() => extractCompileLogDigest(compileLog), [compileLog]);
    const lastAutoLocatedCompileIssueRef = useRef('');

    // Helper for Board Name
    const getBoardName = () => {
        if (!activeBoard) return '未选择开发板';
        const b = activeBoardPackage || BOARDS.find(b => b.id === activeBoard);
        if (b) return b.name;
        const parts = activeBoard.split(':');
        return parts[parts.length - 1].split('=')[1] || parts[parts.length - 1];
    };

    const replaceCompileLog = useCallback((text: string) => {
        if (compileLogFlushRef.current !== null) clearTimeout(compileLogFlushRef.current);
        compileLogFlushRef.current = null;
        const next = createCompileLogBuffer(text);
        compileLogResultLinesRef.current.clear();
        compileLogBufferRef.current = next;
        compileLogRef.current = next.text;
        setCompileLog(next.text);
    }, []);

    const appendCompileLog = useCallback((
        chunk: string,
        resultCode?: BuildOperationResultCode,
    ) => {
        if (!chunk) return;
        const previous = compileLogBufferRef.current;
        const next = appendCompileLogBufferBounded(compileLogBufferRef.current, chunk);
        if (!next.text.startsWith(previous.text)) {
            // Bounded-buffer truncation changes line ordinals. Drop presentation
            // metadata instead of ever attaching a result style to the wrong
            // raw diagnostic line.
            compileLogResultLinesRef.current.clear();
        }
        if (resultCode && isBuildOperationSuccessful(resultCode)) {
            const lines = next.text.split(/\r?\n/);
            let resultLineIndex = lines.length - 1;
            while (resultLineIndex >= 0 && !lines[resultLineIndex].trim()) resultLineIndex -= 1;
            if (resultLineIndex >= 0) {
                compileLogResultLinesRef.current.set(resultLineIndex, resultCode);
            }
        }
        compileLogBufferRef.current = next;
        compileLogRef.current = next.text;
        if (compileLogFlushRef.current === null) {
            compileLogFlushRef.current = setTimeout(() => {
                compileLogFlushRef.current = null;
                setCompileLog(compileLogRef.current);
            }, 250);
        }
    }, []);

    const getCompileLineClass = useCallback((
        line: string,
        resultCode?: BuildOperationResultCode,
    ) => {
        const text = String(line || '');
        const lower = text.toLowerCase();

        if (!text.trim()) return 'text-slate-400 dark:text-slate-600';
        if (resultCode && isBuildOperationSuccessful(resultCode)) {
            return 'text-emerald-600 font-semibold dark:text-emerald-300';
        }
        if (lower.includes('[error]') || lower.includes(' error:') || lower.includes('fatal') || lower.includes('failed')) {
            return 'text-red-600 font-semibold dark:text-red-400';
        }
        if (lower.includes('[warn]') || lower.includes('warning')) {
            return 'text-amber-600 dark:text-amber-300';
        }
        if (text.includes('[Timing]')) {
            return 'text-violet-600 dark:text-violet-300';
        }
        if (text.includes('[DIAG]')) {
            return 'text-cyan-600 dark:text-cyan-300';
        }
        if (text.includes('[INFO]')) {
            if (lower.includes('artifact') || lower.includes('.hex') || lower.includes('.bin') || lower.includes('.elf') || lower.includes('.eep')) {
                return 'text-emerald-700 dark:text-emerald-300';
            }
            if (lower.includes('using libraries') || lower.includes('installed library paths') || lower.includes('resolved custom libraries')) {
                return lower.includes('(none)')
                    ? 'text-amber-700 font-medium dark:text-amber-300'
                    : 'text-indigo-700 font-medium dark:text-indigo-300';
            }
            return 'text-indigo-600 dark:text-indigo-300';
        }
        if (lower.startsWith('artifacts') || lower.startsWith('artifact:')) {
            return 'text-emerald-700 dark:text-emerald-300';
        }
        return 'text-slate-700 dark:text-slate-300';
    }, []);

    // Port polling and presentation state can rerender this component every
    // few seconds. Do not rehash an unchanged multi-megabyte sketch on every
    // render. One exact-string entry keeps identity semantics unchanged and
    // bounds retention; never cache by block count, board name or a weak hash.
    const includeSignatureCacheRef = useRef<{ source: string; value: string } | null>(null);
    const codeFingerprintCacheRef = useRef<{ source: string; value: string } | null>(null);
    const computeIncludeSignature = useCallback((code: string): string => {
        const source = String(code || '');
        if (includeSignatureCacheRef.current?.source === source) return includeSignatureCacheRef.current.value;
        const normalized = source.replace(/\r\n/g, '\n');
        const matches = normalized.matchAll(/^\s*#include\s*[<"]([^>"]+)[>"]/gm);
        const headers = Array.from(matches)
            .map(m => String(m[1] || '').trim().toLowerCase())
            .filter(Boolean)
            .sort();
        const value = headers.join('|');
        includeSignatureCacheRef.current = { source, value };
        return value;
    }, []);

    const computeCodeFingerprint = useCallback((code: string): string => {
        const source = String(code || '');
        if (codeFingerprintCacheRef.current?.source === source) return codeFingerprintCacheRef.current.value;
        const value = sha256Hex(source);
        codeFingerprintCacheRef.current = { source, value };
        return value;
    }, []);

    const getCurrentCompileEnvironment = useCallback((code: string): CurrentCompileEnvironment => ({
        fqbn: effectiveCompileFqbn,
        coreId: activeCoreId,
        coreVersion: activeCoreVersion,
        codeFingerprint: computeCodeFingerprint(code),
        includeHeaders: (computeIncludeSignature(code) || '')
            .split('|')
            .map(value => value.trim())
            .filter(Boolean),
    }), [activeCoreId, activeCoreVersion, computeCodeFingerprint, computeIncludeSignature, effectiveCompileFqbn]);

    useEffect(() => {
        setCompileEnvironmentSnapshot(loadCompileEnvironmentSnapshot(currentPath));
    }, [currentPath]);

    useEffect(() => {
        const snapshot = loadCompileResourceSnapshot(currentPath, effectiveCompileFqbn);
        compileResourceSnapshotRef.current = snapshot;
        setCompileResourceSnapshot(snapshot);
        setCompileResourceReport(compileResourceSnapshotToReport(snapshot));
        setCompileDoctorReport(null);
        setCompileIssues([]);
        setPinPreflightReport(null);
    }, [currentPath, effectiveCompileFqbn]);

    /** Parse only diagnostics emitted for an Arduino sketch translation unit.
     * Generic .cpp/.h lines are deliberately excluded so a library failure can
     * never be guessed as an unrelated Blockly block.
     */
    const parseCompileDiagnosticLocation = useCallback((logLine: string): { file: string; line: number } | null => {
        const match = String(logLine || '').match(/^\s*(.+?\.ino(?:\.cpp)?):(\d+)(?::\d+)?:\s*(?:fatal\s+error|error|warning)\s*:/i);
        if (!match) return null;
        const line = Number(match[2]);
        if (!Number.isSafeInteger(line) || line < 1) return null;
        const rawFile = String(match[1] || '').trim();
        const file = /\.ino\.cpp$/i.test(rawFile) ? rawFile.slice(0, -4) : rawFile;
        return { file, line };
    }, []);

    const lookupCompileBlock = useCallback((logLine: string) => {
        const location = parseCompileDiagnosticLocation(logLine);
        const session = compileSourceMapSessionRef.current;
        if (!location || !session) return null;
        // Editing after the compiler started invalidates this run even if an
        // old diagnostic remains visible in the console.
        if (sha256Hex(generatedCodeRef.current || '') !== session.sourceMap.codeSha256) return null;
        const logicalFile = resolveTrustedCompileDiagnosticFile({
            alias: session.trustedSketchAlias,
            runId: session.runId,
            sourceMap: session.sourceMap,
            diagnosticFile: location.file,
        });
        if (!logicalFile) return null;
        return lookupCompileSourceMap(session.sourceMap, {
            file: logicalFile,
            line: location.line,
            code: session.code,
            acceptedConfidences: ['exact', 'high'],
        });
    }, [parseCompileDiagnosticLocation]);

    const isTrustedCompileBlockMapping = useCallback((mapping: ReturnType<typeof lookupCompileBlock>) => (
        mapping?.confidence === 'exact' || mapping?.confidence === 'high'
    ), []);

    const reconcileCompileIssueBlocks = useCallback((issues: readonly CompileIssueCard[]) => {
        const session = compileSourceMapSessionRef.current;
        if (!session) {
            return issues.map(({ blockContext: _staleContext, ...issue }) => issue);
        }
        return reconcileCompileIssueBlockContexts({
            issues,
            sourceMap: session.sourceMap,
            compileCode: session.code,
            currentCode: generatedCodeRef.current || '',
            runId: session.runId,
            alias: session.trustedSketchAlias,
            presentations: session.blockPresentations,
        });
    }, []);

    /** After compilation fails, scan output log and highlight the first error block. */
    const highlightCompileErrorBlocks = useCallback((log: string) => {
        const ws = workspaceRef.current;
        if (!ws) return;

        clearCompileErrors(ws);

        const sourceMapSession = compileSourceMapSessionRef.current;
        if (!sourceMapSession || sourceMapSession.sourceMap.mappings.length === 0) return;

        const lines = log.split(/\r?\n/);
        let firstErrorBlockId: string | null = null;

        for (const line of lines) {
            if (!/(?:fatal\s+error|error)\s*:/i.test(line)) continue;
            const location = parseCompileDiagnosticLocation(line);
            const mapping = lookupCompileBlock(line);
            if (!location || !mapping || !isTrustedCompileBlockMapping(mapping)) continue;
            const blockId = mapping.blockId;

            const block = ws.getBlockById(blockId);
            if (!block) continue;

            // Extract error message
            const errMsgMatch = line.match(/(?:fatal\s+error|error):\s*(.+)/i);
            const errMsg = errMsgMatch ? errMsgMatch[1].trim() : '编译错误';
            markCompileError(block, `编译错误 (${mapping.section} · 行 ${location.line})\n${errMsg}`);

            if (!firstErrorBlockId) {
                firstErrorBlockId = blockId;
            }
        }

        // Center on first error block
        if (firstErrorBlockId) {
            revealCompileError(ws, firstErrorBlockId);
        }
    }, [isTrustedCompileBlockMapping, lookupCompileBlock, parseCompileDiagnosticLocation]);

    /** Handle clicking on a compile log error line → jump to block. */
    const handleCompileLineClick = useCallback((logLine: string) => {
        const ws = workspaceRef.current;
        if (!ws) return;

        const mapping = lookupCompileBlock(logLine);
        if (!isTrustedCompileBlockMapping(mapping)) return;
        const blockId = mapping?.blockId;
        if (!blockId) return;

        const block = ws.getBlockById(blockId);
        if (!block) return;

        revealCompileError(ws, blockId);
        // brief highlight
        block.addSelect();
        setTimeout(() => { try { block.removeSelect(); } catch {} }, 1500);
    }, [isTrustedCompileBlockMapping, lookupCompileBlock]);

    // A trusted sketch alias can arrive after the Tauri command rejects. Keep
    // block warnings synchronized with the reconciled cards so that this event
    // ordering can never leave a proven compiler error visible only in text.
    useEffect(() => {
        const ws = workspaceRef.current;
        if (!ws) return;

        clearCompileErrors(ws);

        const mappedIssues = compileIssues.filter(issue => issue.severity === 'error' && issue.blockContext);
        const messagesByBlock = new Map<string, string[]>();
        for (const issue of mappedIssues) {
            const context = issue.blockContext!;
            const messages = messagesByBlock.get(context.blockId) || [];
            messages.push(`编译错误 (${context.section} · 行 ${context.sourceLine})\n${issue.summary || issue.title}`);
            messagesByBlock.set(context.blockId, messages);
        }
        for (const [blockId, messages] of messagesByBlock) {
            const block = ws.getBlockById(blockId);
            if (!block) continue;
            markCompileError(block, [...new Set(messages)].join('\n\n'));
        }

        const first = mappedIssues[0]?.blockContext;
        if (!first) {
            if (compileIssues.length === 0) lastAutoLocatedCompileIssueRef.current = '';
            return;
        }
        const signature = `${foregroundBuildRunIdRef.current || 'no-run'}:${first.blockId}:${first.sourceLine}`;
        if (lastAutoLocatedCompileIssueRef.current === signature) return;
        lastAutoLocatedCompileIssueRef.current = signature;
        revealCompileError(ws, first.blockId);
        const block = ws.getBlockById(first.blockId);
        block?.addSelect();
        window.setTimeout(() => {
            try { block?.removeSelect(); } catch { /* workspace may have been disposed */ }
        }, 1500);
    }, [compileIssues]);

    // Auto-scroll only the compile-log pane. The DOM scroll-to-element API also
    // moves outer ancestors, which can shift the Blockly work surface while a
    // build log arrives during editing.
    useEffect(() => {
        const container = compileLogScrollRef.current;
        if (container) {
            container.scrollTop = container.scrollHeight;
        }
    }, [compileLog]);

    useEffect(() => {
        isCompilingRef.current = isCompiling;
    }, [isCompiling]);

    useEffect(() => {
        const scheduler = new SilentPrecompileScheduler({
            delayMs: 650,
            retryDelayMs: 180,
            isBlocked: () => isCompilingRef.current,
            run: async request => {
                await invoke('warmup_board', {
                    fqbn: request.fqbn,
                    code: request.code,
                });
            },
            onError: error => {
                console.warn('[SilentPrecompile] include-set warmup failed', error);
            },
        });
        silentPrecompileSchedulerRef.current = scheduler;
        return () => {
            scheduler.dispose();
            if (silentPrecompileSchedulerRef.current === scheduler) {
                silentPrecompileSchedulerRef.current = null;
            }
        };
    }, []);

    // Resize Blockly on layout change/resize
    useEffect(() => {
        if (workspaceRef.current) {
            // Delay slightly for CSS transition
            const timer = setTimeout(() => {
                Blockly.svgResize(workspaceRef.current as Blockly.WorkspaceSvg);
            }, 350);
            return () => clearTimeout(timer);
        }
    }, [consoleExpanded, consoleOpen, codeViewOpen]);

    // Cleanup Serial Monitor on Unmount/Exit
    useEffect(() => {
        return () => {
            serialSettingsSeqRef.current += 1;
            desiredSerialOpenRef.current = false;
            if (serialReconnectTimerRef.current) {
                clearTimeout(serialReconnectTimerRef.current);
                serialReconnectTimerRef.current = null;
            }
            clearInitialDebugAttachTimers();
            if (debugCommandTimerRef.current) clearTimeout(debugCommandTimerRef.current);
            if (tracePublishTimerRef.current) clearTimeout(tracePublishTimerRef.current);
            compileSessionRef.current += 1;
            isCompilingRef.current = false;
            const foregroundBuildRunId = foregroundBuildRunIdRef.current;
            foregroundBuildRunIdRef.current = null;
            if (compileTimerRef.current) {
                clearInterval(compileTimerRef.current);
                compileTimerRef.current = null;
            }
            workspaceRef.current?.highlightBlock(null);
            if (workspaceRef.current) {
                refreshBlockTraceVisuals(workspaceRef.current, null);
            }
            const debugSession = blockDebugSessionRef.current;
            // React cleanup cannot itself be async. Keep the teardown in one async
            // chain so the port is never closed in parallel with the final STOP.
            void (async () => {
                if (foregroundBuildRunId) {
                    try {
                        await invoke('cancel_foreground_build', { runId: foregroundBuildRunId });
                    } catch (error) {
                        console.error('Failed to safely stop foreground build on unmount', error);
                    }
                }
                if (debugSession.active && debugSession.sessionId) {
                    const data = new TextEncoder().encode(createDebugCommandLine(debugSession.sessionId, 'STOP', ++debugCommandSequenceRef.current));
                    try {
                        await invoke('send_serial_data', { data: Array.from(data) });
                    } catch (error) {
                        console.warn('Failed to send final block debug STOP during unmount', error);
                    }
                    // Give the serial driver and firmware a brief chance to flush
                    // STOP/STOPPED before releasing the endpoint.
                    await new Promise(resolve => setTimeout(resolve, 150));
                }
                blockDebugSessionRef.current = IDLE_BLOCK_DEBUG_SESSION;
                blockRunModeRef.current = null;
                traceIndexToBlockIdRef.current = new Map();
                traceAggregatorRef.current = null;
                try {
                    await invoke('close_serial_monitor');
                } catch (error) {
                    console.error('Failed to close serial on unmount', error);
                }
            })();
        };
    }, [clearInitialDebugAttachTimers]);

    // Board Config Modal
    const [isConfigOpen, setIsConfigOpen] = useState(false);


    const [toast, setToast] = useState<{ show: boolean, message: string, type: 'info' | 'loading' | 'success' | 'error' }>({ show: false, message: '', type: 'info' });
    const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const showToast = (message: string, type: 'info' | 'loading' | 'success' | 'error' = 'info') => {
        if (toastTimerRef.current) {
            clearTimeout(toastTimerRef.current);
            toastTimerRef.current = null;
        }
        setToast({ show: true, message, type });
        if (type !== 'loading') {
            toastTimerRef.current = setTimeout(() => {
                toastTimerRef.current = null;
                setToast(prev => ({ ...prev, show: false }));
            }, 3000);
        }
    };

    useEffect(() => () => {
        if (toastTimerRef.current) {
            clearTimeout(toastTimerRef.current);
            toastTimerRef.current = null;
        }
    }, []);

    const requestUnsavedChoice = useCallback((context: UnsavedNavigationContext) => {
        if (unsavedChoiceResolverRef.current) {
            return Promise.resolve<UnsavedNavigationChoice>('cancel');
        }
        setUnsavedDialogContext(context);
        return new Promise<UnsavedNavigationChoice>((resolve) => {
            unsavedChoiceResolverRef.current = resolve;
        });
    }, []);

    const finishUnsavedChoice = useCallback((choice: UnsavedNavigationChoice) => {
        const resolve = unsavedChoiceResolverRef.current;
        unsavedChoiceResolverRef.current = null;
        setUnsavedDialogContext(null);
        resolve?.(choice);
    }, []);

    useEffect(() => () => {
        const resolve = unsavedChoiceResolverRef.current;
        unsavedChoiceResolverRef.current = null;
        resolve?.('cancel');
    }, []);

    useEffect(() => {
        activePortRef.current = activePort;
    }, [activePort]);

    useEffect(() => {
        if (!deviceHealthPublication) return;
        const currentTarget: DeviceHealthRequestIdentity = {
            requestId: deviceHealthRequestIdRef.current,
            fqbn: effectiveCompileFqbn,
            port: activePort || '',
        };
        if (!isSameDeviceHealthTarget(deviceHealthPublication.target, currentTarget)) {
            setDeviceHealthPublication(null);
        }
    }, [activePort, deviceHealthPublication, effectiveCompileFqbn]);

    useEffect(() => () => {
        deviceHealthRequestIdRef.current += 1;
        deviceHealthRunningRef.current = false;
    }, []);

    useEffect(() => {
        baudRateRef.current = baudRate;
        window.localStorage.setItem('ck.serial.baudRate', String(baudRate));
    }, [baudRate]);

    useEffect(() => {
        isConsoleDetachedRef.current = isConsoleDetached;
    }, [isConsoleDetached]);

    useEffect(() => {
        scanPortsRef.current = scanPorts;
    }, [scanPorts]);

    const clearSerialReconnectTimer = useCallback(() => {
        if (serialReconnectTimerRef.current) {
            clearTimeout(serialReconnectTimerRef.current);
            serialReconnectTimerRef.current = null;
        }
    }, []);

    const writeBlockDebugCommand = useCallback(async (
        sessionId: string,
        command: CkDebugCommand,
        notifyFailure = true,
        sequence = ++debugCommandSequenceRef.current,
    ): Promise<boolean> => {
        try {
            const data = new TextEncoder().encode(createDebugCommandLine(sessionId, command, sequence));
            await invoke('send_serial_data', { data: Array.from(data) });
            return true;
        } catch (error) {
            console.error(`Failed to send block debug ${command} command`, error);
            if (notifyFailure) {
                showToast('调试命令发送失败，请检查串口连接', 'error');
            }
            return false;
        }
    // showToast is stable for this component lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const attachCurrentBlockDebugSession = useCallback(async (): Promise<boolean> => {
        const session = blockDebugSessionRef.current;
        if (
            !session.active
            || !session.sessionId
            || session.phase === 'stopping'
            || debugAttachCommandInFlightRef.current
        ) return false;

        debugAttachCommandInFlightRef.current = true;
        try {
            const sequence = ++debugCommandSequenceRef.current;
            debugMinimumSequenceRef.current = sequence;
            return await writeBlockDebugCommand(session.sessionId, 'ATTACH', false, sequence);
        } finally {
            debugAttachCommandInFlightRef.current = false;
        }
    }, [writeBlockDebugCommand]);

    const openSerialMonitorWithSettings = useCallback(async (
        portName: string,
        targetBaud: number,
        source: 'manual' | 'reconnect' | 'restore' | 'switch-baud' = 'manual',
        expectedSettingsSeq?: number,
    ) => {
        await invoke('open_serial_monitor', {
            port: portName,
            baud: targetBaud,
        });

        if (
            expectedSettingsSeq !== undefined
            && serialSettingsSeqRef.current !== expectedSettingsSeq
        ) {
            await invoke('close_serial_monitor');
            throw new Error('串口恢复请求已被较新的操作取代');
        }

        desiredSerialOpenRef.current = true;
        monitorBaudRateRef.current = targetBaud;
        monitorPortRef.current = portName;
        clearSerialReconnectTimer();
        serialReconnectAttemptsRef.current = 0;
        setMonitorBaudRate(targetBaud);
        setMonitorPort(portName);
        setIsSerialMonitorOpen(true);
        if (!isConsoleDetachedRef.current) {
            setConsoleOpen(true);
        }
        setConsoleTab('serial');

        const debugSession = blockDebugSessionRef.current;
        if (debugSession.active) {
            const traceMode = blockRunModeRef.current === 'trace';
            if (debugSession.phase === 'stopping') {
                serialMonitorRef.current?.write(`\r\n[${traceMode ? '轨迹' : '调试'}] 串口已恢复，正在重新发送结束命令并等待开发板确认。\r\n`);
                void writeBlockDebugCommand(debugSession.sessionId, 'STOP', false);
            } else {
                if (traceMode) traceAggregatorRef.current?.resetTiming();
                const connectingSession = markBlockDebugSessionConnecting(debugSession);
                blockDebugSessionRef.current = connectingSession;
                setBlockDebugSession(connectingSession);
                serialMonitorRef.current?.write(`\r\n[${traceMode ? '轨迹' : '调试'}] 串口已就绪，正在附加开发板上的${traceMode ? '轨迹' : '调试'}固件。\r\n`);
                void attachCurrentBlockDebugSession();
            }
        }

        if (source === 'switch-baud') {
            serialMonitorRef.current?.clear();
            serialMonitorRef.current?.write(`\r\n[系统] 波特率已切换至 ${targetBaud}\r\n`);
            return;
        }

        if (source === 'reconnect') {
            serialMonitorRef.current?.write(`\r\n[系统] 串口已自动重连：${portName} @ ${targetBaud} 波特率\r\n`);
            showToast('串口已自动重连', 'success');
            return;
        }

        if (source === 'restore') {
            serialMonitorRef.current?.write(`\r\n[系统] 已恢复串口监视器：${portName} @ ${targetBaud} 波特率\r\n`);
            showToast('已恢复串口监视器', 'info');
            return;
        }

        serialMonitorRef.current?.write(`\r\n[系统] 串口已打开：${portName} @ ${targetBaud} 波特率\r\n`);
        showToast('串口已打开', 'success');
    }, [attachCurrentBlockDebugSession, clearSerialReconnectTimer, writeBlockDebugCommand]);

    // Keep the backend endpoint synchronized with both selectors. The UI reports
    // the confirmed backend endpoint, not the value that is merely selected.
    useEffect(() => {
        if (!isSerialMonitorOpen || !activePort) return;
        if (monitorPortRef.current === activePort && monitorBaudRateRef.current === baudRate) return;

        const seq = serialSettingsSeqRef.current + 1;
        serialSettingsSeqRef.current = seq;
        let cancelled = false;
        const timer = setTimeout(async () => {
            setIsSerialMonitorSwitching(true);
            try {
                await invoke('close_serial_monitor');
                if (cancelled || serialSettingsSeqRef.current !== seq) return;
                await openSerialMonitorWithSettings(activePort, baudRate, 'switch-baud', seq);
            } catch (error) {
                if (cancelled || serialSettingsSeqRef.current !== seq) return;
                desiredSerialOpenRef.current = false;
                monitorPortRef.current = null;
                monitorBaudRateRef.current = null;
                setMonitorPort(null);
                setMonitorBaudRate(null);
                setIsSerialMonitorOpen(false);
                console.error('Failed to apply serial settings', error);
                showToast('串口端口或波特率切换失败', 'error');
            } finally {
                if (!cancelled && serialSettingsSeqRef.current === seq) {
                    setIsSerialMonitorSwitching(false);
                }
            }
        }, 120);

        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    // showToast is stable for this component lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activePort, baudRate, isSerialMonitorOpen, openSerialMonitorWithSettings]);

    const scheduleSerialReconnect = useCallback((
        reason?: string,
        preferredPort?: string | null,
        preferredBaud?: number | null,
    ) => {
        const portName = preferredPort || activePortRef.current;
        const targetBaud = preferredBaud || baudRateRef.current;
        if (!desiredSerialOpenRef.current || !portName || serialReconnectTimerRef.current) {
            return;
        }

        const nextAttempt = serialReconnectAttemptsRef.current + 1;
        const maxAttempts = 6;
        if (nextAttempt > maxAttempts) {
            desiredSerialOpenRef.current = false;
            serialMonitorRef.current?.write('\r\n[系统] 自动重连已停止，请检查设备连接后手动重新打开串口。\r\n');
            const activeRunLabel = blockRunModeRef.current === 'trace' ? '轨迹' : '调试';
            showToast(
                blockDebugSessionRef.current.active
                    ? `自动重连失败，${activeRunLabel}会话已保留，可手动重开串口`
                    : '串口自动重连失败，请检查设备连接',
                'error',
            );
            return;
        }

        serialReconnectAttemptsRef.current = nextAttempt;
        const delayMs = Math.min(1000 * nextAttempt, 5000);
        const reconnectSettingsSeq = serialSettingsSeqRef.current;
        serialMonitorRef.current?.write(`\r\n[系统] 串口断开，${(delayMs / 1000).toFixed(delayMs >= 1000 ? 0 : 1)} 秒后尝试重连 (${nextAttempt}/${maxAttempts})...\r\n`);
        if (reason) {
            serialMonitorRef.current?.write(`[系统] 断开原因: ${reason}\r\n`);
        }

        serialReconnectTimerRef.current = setTimeout(async () => {
            serialReconnectTimerRef.current = null;
            try {
                if (serialSettingsSeqRef.current !== reconnectSettingsSeq) return;
                await scanPortsRef.current?.();
                if (serialSettingsSeqRef.current !== reconnectSettingsSeq) return;
                await openSerialMonitorWithSettings(
                    portName,
                    targetBaud,
                    'reconnect',
                    reconnectSettingsSeq,
                );
            } catch (e: any) {
                serialMonitorRef.current?.write(`\r\n[系统] 第 ${nextAttempt} 次重连失败: ${String(e)}\r\n`);
                scheduleSerialReconnect(String(e), portName, targetBaud);
            }
        }, delayMs);
    }, [openSerialMonitorWithSettings]);

    // Serial Monitor & Build Progress Event Listener
    useEffect(() => {
        let unlistenSerial: (() => void) | undefined;
        let unlistenBuild: (() => void) | undefined;
        let unlistenLog: (() => void) | undefined;
        let unlistenSketchAlias: (() => void) | undefined;
        let unlistenDisconnect: (() => void) | undefined;
        let isActive = true;

        const setupListeners = async () => {
            try {
                // @ts-ignore
                const { listen } = await import('@tauri-apps/api/event');

                if (!isActive) return;

                // Serial Data (Stats Only)
                const uSerial = await listen('serial-data', (event: any) => {
                    const payload = event.payload;
                    let len = 0;
                    let lines = 0;

                    if (typeof payload === 'string') {
                        len = payload.length;
                        for (let i = 0; i < len; i++) {
                            if (payload[i] === '\n') lines++;
                        }
                    } else if (Array.isArray(payload)) {
                        len = payload.length;
                        for (let i = 0; i < len; i++) {
                            if (payload[i] === 10) lines++;
                        }
                    }

                    bytesReceivedRef.current += len;
                    linesReceivedRef.current += lines;

                    const debugOutput = debugStreamParserRef.current.push(payload);
                    debugOutput.frames.forEach((frame) => debugFrameHandlerRef.current(frame));
                });
                if (isActive) unlistenSerial = uSerial; else uSerial();

                // Build Progress
                const uBuild = await listen('build-progress', (event: any) => {
                    if (!isCompilingRef.current) return;
                    const { percentage, message } = event.payload;
                    setBuildProgress(prev => applyBuildProgressEvent(prev, percentage, message));
                });
                if (isActive) unlistenBuild = uBuild; else uBuild();

                // Build Log Streaming (Fix Leak)
                const uLog = await listen('build-log', (event: any) => {
                    const line = event.payload as string;
                    if (!isCompilingRef.current) return;
                    if (line && line.trim().length > 0) {
                        compileStreamSeenRef.current = true;
                        setBuildProgress(prev => applyBuildLogLine(prev, line));
                    }
                    appendCompileLog(line);
                });
                if (isActive) unlistenLog = uLog; else uLog();

                // This is a backend-authenticated path alias, not a log marker.
                // It contains hashes and a basename only; absolute paths never
                // cross this channel.
                const uSketchAlias = await listen('compile-sketch-alias', (event: any) => {
                    const alias = normalizeTrustedCompileSketchAlias(event.payload);
                    const session = compileSourceMapSessionRef.current;
                    if (
                        !alias
                        || !session
                        || alias.runId !== session.runId
                        || alias.sourceSha256 !== session.sourceMap.codeSha256
                    ) return;
                    if (alias.status === 'revoked') {
                        session.trustedSketchAlias = null;
                        session.aliasRevoked = true;
                        setCompileIssues(issues => reconcileCompileIssueBlocks(issues));
                        return;
                    }
                    if (session.aliasRevoked) return;
                    const previous = session.trustedSketchAlias;
                    if (
                        previous
                        && (
                            previous.pathSha256 !== alias.pathSha256
                            || previous.basename !== alias.basename
                        )
                    ) {
                        session.trustedSketchAlias = null;
                        session.aliasRevoked = true;
                        setCompileIssues(issues => reconcileCompileIssueBlocks(issues));
                        return;
                    }
                    session.trustedSketchAlias = alias;
                    // Tauri commands and events are independent async channels.
                    // Reconcile again here so a trusted alias delivered after
                    // the command's error result still enriches the card.
                    setCompileIssues(issues => reconcileCompileIssueBlocks(issues));
                });
                if (isActive) unlistenSketchAlias = uSketchAlias; else uSketchAlias();

                // Serial Disconnect Detection
                const uDisconnect = await listen('serial-disconnected', (event: any) => {
                    const reason = event.payload as string;
                    const reconnectPort = monitorPortRef.current || activePortRef.current;
                    const reconnectBaud = monitorBaudRateRef.current || baudRateRef.current;
                    serialMonitorRef.current?.write(`\r\n[系统] 串口已断开: ${reason}\r\n`);
                    monitorPortRef.current = null;
                    monitorBaudRateRef.current = null;
                    setMonitorPort(null);
                    setMonitorBaudRate(null);
                    setIsSerialMonitorSwitching(false);
                    setIsSerialMonitorOpen(false);
                    if (blockDebugSessionRef.current.active) {
                        const traceMode = blockRunModeRef.current === 'trace';
                        desiredSerialOpenRef.current = true;
                        workspaceRef.current?.highlightBlock(null);
                        if (workspaceRef.current) {
                            refreshBlockBreakpointVisuals(workspaceRef.current, breakpointIdsRef.current, null);
                        }
                        if (traceMode && traceAggregatorRef.current) {
                            traceAggregatorRef.current.resetRun();
                            setBlockTraceSnapshot(traceAggregatorRef.current.snapshot());
                        }
                        const connectingSession = markBlockDebugSessionConnecting(blockDebugSessionRef.current);
                        blockDebugSessionRef.current = connectingSession;
                        setBlockDebugSession(connectingSession);
                        debugStreamParserRef.current.reset();
                        serialMonitorRef.current?.write(`\r\n[${traceMode ? '轨迹' : '调试'}] 串口断开，会话已保留，正在自动重连。\r\n`);
                        showToast(`${traceMode ? '轨迹' : '调试'}串口断开，正在自动重连`, 'info');
                    } else {
                        showToast('串口已断开', 'error');
                    }
                    scheduleSerialReconnect(reason, reconnectPort, reconnectBaud);
                });
                if (isActive) unlistenDisconnect = uDisconnect; else uDisconnect();

            } catch (e) {
                console.error('Failed to setup event listeners', e);
            }
        };

        setupListeners();

        return () => {
            isActive = false;
            if (unlistenSerial) unlistenSerial();
            if (unlistenBuild) unlistenBuild();
            if (unlistenLog) unlistenLog();
            if (unlistenSketchAlias) unlistenSketchAlias();
            if (unlistenDisconnect) unlistenDisconnect();
        };
    }, []);

    // Stats Calculator Loop (Every 1s)
    // Stats logic moved to StatusFooter

    // Auto-Scroll for Compile Logs (Instant)
    // No more manual buffer flushing for Serial Monitor (handled by xterm)

    // Load Ports (Managed globally by HardwareContext)
    // useEffect(() => { refreshPorts(); }, []); removed

    const closeSerialMonitorConfirmed = async (source: 'main' | 'detached' = 'main') => {
        if (deviceHealthRunningRef.current) {
            throw new Error('真机体检期间串口由体检独占，请稍候');
        }
        if (blockDebugSessionRef.current.active) {
            throw new Error(
                blockRunModeRef.current === 'trace'
                    ? '运行轨迹期间需要保持串口连接，请先结束轨迹'
                    : '积木调试期间需要保持串口连接，请先结束调试',
            );
        }

        serialSettingsSeqRef.current += 1;
        setIsSerialMonitorSwitching(true);
        await invoke('close_serial_monitor');

        desiredSerialOpenRef.current = false;
        monitorBaudRateRef.current = null;
        monitorPortRef.current = null;
        clearSerialReconnectTimer();
        serialReconnectAttemptsRef.current = 0;
        setMonitorBaudRate(null);
        setMonitorPort(null);
        setIsSerialMonitorOpen(false);
        setIsSerialMonitorSwitching(false);

        if (source === 'main') {
            serialMonitorRef.current?.write('\r\n[系统] 串口已真正关闭，端口已经释放。\r\n');
            showToast('串口已关闭，端口已释放', 'success');
        }
    };

    const toggleSerialMonitor = async () => {
        try {
            if (isSerialMonitorOpen) {
                await closeSerialMonitorConfirmed('main');
            } else {
                // Open
                if (!activePort) {
                    showToast('请先选择端口', 'error');
                    return;
                }

                // Auto-Detect Baud Rate from Code
                let targetBaud = baudRate;
                const baudMatch = generatedCode.match(/Serial\.begin\((\d+)\);/);
                if (baudMatch && baudMatch[1]) {
                    targetBaud = parseInt(baudMatch[1]);
                    setBaudRate(targetBaud); // Update UI
                    console.log("[AutoBaud] Detected " + targetBaud + " from code");
                }

                serialSettingsSeqRef.current += 1;
                const manualOpenSeq = serialSettingsSeqRef.current;
                await openSerialMonitorWithSettings(
                    activePort,
                    targetBaud,
                    'manual',
                    manualOpenSeq,
                );
            }
        } catch (e: any) {
            console.error(e);
            setIsSerialMonitorSwitching(false);
            showToast(String(e?.message || e || '串口操作失败'), 'error');
            serialMonitorRef.current?.write(`\r\n[错误] ${e} \r\n`);
        }
    };

    const publishDetachedConsoleState = async (
        error?: string,
        selectedPortOverride?: string,
        baudOverride?: number,
    ) => {
        const payload: DetachedConsoleStatePayload = {
            feedbackRunId,
            compiling: isCompiling,
            open: desiredSerialOpenRef.current && monitorPortRef.current !== null,
            switching: isSerialMonitorSwitching,
            selectedPort: selectedPortOverride ?? activePortRef.current ?? monitorPortRef.current ?? '',
            monitorPort: monitorPortRef.current ?? '',
            baud: baudOverride ?? monitorBaudRateRef.current ?? baudRateRef.current,
            ports: ports.map(port => ({
                port_name: port.port_name,
                description: port.description,
                hardware_id: port.hardware_id,
            })),
            ...(error ? { error } : {}),
        };
        await emitTo(DETACHED_CONSOLE_LABEL, 'ck-console-state', payload).catch(() => undefined);
    };

    detachedConsoleCommandHandlerRef.current = async (command: DetachedConsoleCommand) => {
        try {
            if (command.action === 'ready') {
                await publishDetachedConsoleState();
                return;
            }
            if (command.action === 'dock') {
                isConsoleDetachedRef.current = false;
                setIsConsoleDetached(false);
                setConsoleOpen(true);
                setConsoleTab('serial');
                showToast('串口监视器已收回主窗口', 'info');
                return;
            }
            if (command.action === 'send') {
                if (blockDebugSessionRef.current.active) throw new Error('调试/轨迹期间 Serial 由控制协议独占，不能发送普通数据。');
                if (!desiredSerialOpenRef.current || monitorPortRef.current === null) {
                    throw new Error('串口尚未打开');
                }
                const data = Array.isArray(command.data)
                    ? command.data.filter(value => Number.isInteger(value) && value >= 0 && value <= 255)
                    : [];
                if (data.length === 0) return;
                await invoke('send_serial_data', { data });
                return;
            }
            if (command.action === 'close') {
                await closeSerialMonitorConfirmed('detached');
                await publishDetachedConsoleState();
                return;
            }

            const portName = String(command.port || activePortRef.current || '').trim();
            const targetBaud = Number(command.baud || baudRateRef.current);
            if (!portName) throw new Error('请先选择串口');
            if (!Number.isFinite(targetBaud) || targetBaud <= 0) throw new Error('波特率无效');
            if (deviceHealthRunningRef.current) throw new Error('真机体检期间串口由体检独占，请稍候');
            if (blockDebugSessionRef.current.active && command.action === 'set-settings') {
                throw new Error('运行轨迹或积木调试期间不能切换串口设置');
            }

            connectDevice(portName);
            activePortRef.current = portName;
            setBaudRate(targetBaud);
            baudRateRef.current = targetBaud;

            if (command.action === 'set-settings' && !desiredSerialOpenRef.current) {
                await publishDetachedConsoleState(undefined, portName, targetBaud);
                return;
            }

            const seq = serialSettingsSeqRef.current + 1;
            serialSettingsSeqRef.current = seq;
            setIsSerialMonitorSwitching(true);
            if (monitorPortRef.current !== null) {
                await invoke('close_serial_monitor');
                monitorPortRef.current = null;
                monitorBaudRateRef.current = null;
            }
            await openSerialMonitorWithSettings(portName, targetBaud, 'switch-baud', seq);
            setIsSerialMonitorSwitching(false);
            await publishDetachedConsoleState(undefined, portName, targetBaud);
        } catch (error) {
            setIsSerialMonitorSwitching(false);
            const message = String((error as Error)?.message || error || '串口操作失败');
            await publishDetachedConsoleState(message, command.port, command.baud);
            showToast(message, 'error');
        }
    };

    useEffect(() => {
        let unlisten: (() => void) | undefined;
        let alive = true;
        void listen<DetachedConsoleCommand>('ck-console-command', event => {
            void detachedConsoleCommandHandlerRef.current(event.payload);
        }).then(stop => {
            if (!alive) stop();
            else unlisten = stop;
        });
        return () => {
            alive = false;
            unlisten?.();
        };
    }, []);

    useEffect(() => {
        if (!isConsoleDetached) return;
        void publishDetachedConsoleState();
    // State publication is intentionally driven by confirmed monitor state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activePort, baudRate, isConsoleDetached, isSerialMonitorOpen, isSerialMonitorSwitching, monitorBaudRate, monitorPort, ports, feedbackRunId, isCompiling]);

    const openDetachedConsole = async () => {
        // `openDetachedConsole` also acts as "focus" when the window already
        // exists. Keep every caller safe, including menu actions added later.
        setIsViewMenuOpen(false);
        try {
            const existing = await WebviewWindow.getByLabel(DETACHED_CONSOLE_LABEL);
            if (existing) {
                await existing.show();
                await existing.setFocus();
                isConsoleDetachedRef.current = true;
                setIsConsoleDetached(true);
                setConsoleOpen(false);
                await publishDetachedConsoleState();
                return;
            }

            const detached = new WebviewWindow(DETACHED_CONSOLE_LABEL, {
                url: 'index.html?console=detached',
                title: 'CK 串口监视器',
                width: 920,
                height: 600,
                minWidth: 680,
                minHeight: 420,
                center: true,
                resizable: true,
            });
            void detached.once('tauri://created', () => {
                isConsoleDetachedRef.current = true;
                setIsConsoleDetached(true);
                setConsoleOpen(false);
                setConsoleTab('serial');
                showToast('串口监视器已弹出为独立窗口', 'success');
            });
            void detached.once('tauri://error', event => {
                console.error('[SerialConsole] Failed to create detached window', event.payload);
                isConsoleDetachedRef.current = false;
                setIsConsoleDetached(false);
                setConsoleOpen(true);
                showToast('串口浮窗创建失败', 'error');
            });
            void detached.once('tauri://destroyed', () => {
                isConsoleDetachedRef.current = false;
                setIsConsoleDetached(false);
                setConsoleOpen(true);
                setConsoleTab('serial');
            });
        } catch (error) {
            console.error('[SerialConsole] Failed to detach', error);
            isConsoleDetachedRef.current = false;
            setIsConsoleDetached(false);
            setConsoleOpen(true);
            showToast('串口浮窗创建失败', 'error');
        }
    };

    const handleInspectDevice = async () => {
        if (deviceHealthRunningRef.current) return;
        if (isCompilingRef.current) {
            showToast('请等待当前编译或上传结束后再进行真机体检', 'info');
            return;
        }
        if (blockDebugSessionRef.current.active) {
            showToast('请先结束积木调试或运行轨迹，再进行真机体检', 'info');
            return;
        }
        if (!activePort) {
            showToast('真机体检需要先选择串口', 'error');
            setIsPortMenuOpen(true);
            return;
        }
        if (!isEsp32DeviceHealthTarget(effectiveCompileFqbn)) {
            showToast('真机体检 P0 当前仅支持 ESP32 系列', 'error');
            return;
        }

        const requestId = deviceHealthRequestIdRef.current + 1;
        deviceHealthRequestIdRef.current = requestId;
        const target: DeviceHealthRequestIdentity = {
            requestId,
            fqbn: effectiveCompileFqbn,
            port: activePort,
        };
        const isCurrentTarget = () => isSameDeviceHealthTarget(target, {
            requestId: deviceHealthRequestIdRef.current,
            fqbn: effectiveCompileFqbnRef.current,
            port: activePortRef.current || '',
        });
        const publishIfCurrent = (report: ReturnType<typeof createFailedDeviceHealthReport>) => {
            if (!isCurrentTarget() || report.requestId !== target.requestId) return false;
            setDeviceHealthPublication({ target, report });
            return true;
        };

        const serialMonitorWasOpen = isSerialMonitorOpen || monitorPortRef.current !== null;
        const serialMonitorWasDesired = desiredSerialOpenRef.current;
        const shouldRestoreSerialMonitor = serialMonitorWasOpen || serialMonitorWasDesired;
        const restorePort = monitorPortRef.current || activePort;
        const restoreBaud = monitorBaudRateRef.current || baudRateRef.current;
        serialSettingsSeqRef.current += 1;
        const serialOperationSeq = serialSettingsSeqRef.current;
        clearSerialReconnectTimer();

        deviceHealthRunningRef.current = true;
        setIsDeviceHealthRunning(true);
        setIsPortMenuOpen(false);
        openEngineeringHealth();
        showToast('正在进行真机体检；开发板会短暂复位，但不会写入 Flash', 'loading');

        let resultToast: { message: string; type: 'info' | 'success' | 'error' } | null = null;
        try {
            if (serialMonitorWasOpen) {
                await invoke('close_serial_monitor');
                if (!isCurrentTarget()) return;
                monitorPortRef.current = null;
                monitorBaudRateRef.current = null;
                setMonitorPort(null);
                setMonitorBaudRate(null);
                setIsSerialMonitorSwitching(false);
                setIsSerialMonitorOpen(false);
            }

            const rawReport = await invoke<unknown>('inspect_device', {
                request: {
                    requestId: target.requestId,
                    fqbn: target.fqbn,
                    port: target.port,
                },
            });
            const report = normalizeDeviceHealthReport(rawReport, target);
            if (!report) throw new Error('后端返回了无法识别的真机体检结果');
            if (report.requestId !== target.requestId) throw new Error('真机体检结果与当前请求不匹配');
            if (publishIfCurrent(report)) {
                const presentation = deriveDeviceHealthPresentation(report);
                resultToast = presentation.status === 'healthy'
                    ? { message: '真机体检通过', type: 'success' }
                    : presentation.status === 'problem'
                        ? { message: '真机体检发现需要处理的问题', type: 'error' }
                        : { message: presentation.title, type: 'info' };
            }
        } catch (error) {
            const failure = createFailedDeviceHealthReport(target, error);
            if (publishIfCurrent(failure)) {
                resultToast = { message: '真机体检未完成，请查看检查结果', type: 'error' };
            }
        } finally {
            let restoreFailed = false;
            if (
                shouldRestoreSerialMonitor
                && restorePort
                && isCurrentTarget()
                && serialSettingsSeqRef.current === serialOperationSeq
            ) {
                let restoreError: unknown = null;
                let restored = false;
                for (const delayMs of [0, 150, 200, 350, 500]) {
                    if (!isCurrentTarget() || serialSettingsSeqRef.current !== serialOperationSeq) break;
                    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
                    try {
                        await openSerialMonitorWithSettings(
                            restorePort,
                            restoreBaud,
                            'restore',
                            serialOperationSeq,
                        );
                        restored = true;
                        restoreError = null;
                        break;
                    } catch (error) {
                        restoreError = error;
                    }
                }
                if (!restored && isCurrentTarget()) {
                    restoreFailed = true;
                    desiredSerialOpenRef.current = false;
                    monitorPortRef.current = null;
                    monitorBaudRateRef.current = null;
                    setMonitorPort(null);
                    setMonitorBaudRate(null);
                    setIsSerialMonitorOpen(false);
                    console.warn('[DeviceHealth] Failed to restore serial monitor', restoreError);
                }
            }

            const requestStillLatest = deviceHealthRequestIdRef.current === requestId;
            if (requestStillLatest) {
                deviceHealthRunningRef.current = false;
                setIsDeviceHealthRunning(false);
            }
            if (isCurrentTarget()) {
                openEngineeringHealth();
                if (restoreFailed) {
                    showToast('体检已结束，但串口监视器恢复失败，请手动重开', 'error');
                } else if (resultToast) {
                    showToast(resultToast.message, resultToast.type);
                }
            } else if (requestStillLatest) {
                setToast(previous => previous.type === 'loading'
                    ? { ...previous, show: false }
                    : previous);
            }
        }
    };

    const handleSendSerial = async () => {
        if (blockDebugSessionRef.current.active) { showToast('调试/轨迹期间 Serial 由控制协议独占，请先结束会话', 'info'); return; }
        if (!serialInput.trim()) return;

        try {
            // @ts-ignore
            const { invoke } = await import('@tauri-apps/api/core');
            const payload = new TextEncoder().encode(serialInput + lineEnding);
            await invoke('send_serial_data', { data: Array.from(payload) });
            // const endingsMap: Record<string, string> = { '': '', '\n': '\\n', '\r': '\\r', '\r\n': '\\r\\n' };
            // Optional: Echo sent data?
            // serialMonitorRef.current?.write(`[Sent] ${serialInput }${endingsMap[lineEnding] } \r\n`);
            setSerialInput('');
        } catch (e: any) {
            console.error(e);
            serialMonitorRef.current?.write("\\r\\n[错误] 发送失败: " + e + " \\r\\n");
        }
    };

    const handleExportSerialCapture = async () => {
        const capture = serialMonitorRef.current?.getCapture(viewMode) || '';
        if (!capture) {
            showToast('当前没有可导出的串口内容', 'info');
            return;
        }

        const isHex = viewMode === 'hex';
        const now = new Date();
        const timestamp = [
            now.getFullYear(),
            String(now.getMonth() + 1).padStart(2, '0'),
            String(now.getDate()).padStart(2, '0'),
            '-',
            String(now.getHours()).padStart(2, '0'),
            String(now.getMinutes()).padStart(2, '0'),
            String(now.getSeconds()).padStart(2, '0'),
        ].join('');
        const defaultExtension = isHex ? 'hex' : 'log';

        try {
            let selectedPath = await save({
                title: isHex ? '导出串口 HEX 捕获' : '导出串口文本捕获',
                defaultPath: `CK-serial-${timestamp}.${defaultExtension}`,
                filters: [{
                    name: isHex ? 'HEX 或文本文件' : '串口日志或文本文件',
                    extensions: isHex ? ['hex', 'txt'] : ['log', 'txt'],
                }],
            });
            if (!selectedPath) return;

            const acceptedExtension = isHex ? /\.(?:hex|txt)$/i : /\.(?:log|txt)$/i;
            if (!acceptedExtension.test(selectedPath)) {
                selectedPath += `.${defaultExtension}`;
            }
            await writeTextFile(selectedPath, capture);
            showToast(`串口${isHex ? ' HEX' : ''}内容已导出`, 'success');
        } catch (error) {
            console.error('[SerialMonitor] Failed to export capture', error);
            showToast('串口内容导出失败', 'error');
        }
    };

    const createWorkspaceCheckpointInput = useCallback((
        reason: ProjectCheckpointReason,
    ): CreateProjectCheckpointInput | null => {
        const workspace = workspaceRef.current;
        if (!workspace
            || !currentPath
            || rendererRecoveryFailure
            || !isNativeCheckpointStorageAvailable()) return null;

        // This is the same complete serializer used by normal project saves.
        // Custom serializer state (including breakpoints and mutators) stays opaque.
        const state = Blockly.serialization.workspaces.save(workspace);
        const workspaceJson = JSON.stringify(state);
        const code = arduinoGenerator.workspaceToCode(workspace);
        const blockCount = workspace.getAllBlocks(false)
            .filter(block => !(block as any).isInFlyout)
            .length;

        const buildTarget = captureBuildTarget();
        return {
            projectPath: currentPath,
            reason,
            workspaceJson,
            code,
            board: activeBoard,
            boardPackageId: activeBoardPackageId,
            options: JSON.stringify(buildTarget.options),
            buildTarget: JSON.stringify(buildTarget),
            blockCount,
        };
    }, [activeBoard, activeBoardPackageId, boardOptions, currentPath, rendererRecoveryFailure]);

    const captureWorkspaceCheckpoint = useCallback(async (
        reason: ProjectCheckpointReason,
    ) => {
        const input = createWorkspaceCheckpointInput(reason);
        return input ? createProjectCheckpoint(input) : null;
    }, [createWorkspaceCheckpointInput]);

    const readBlockPackageMigrationWorkspace = useCallback((): string => {
        if (!currentPath || projectLoadSafetyError || rendererRecoveryFailure) {
            throw new Error('当前工程尚未安全载入，不能执行包迁移');
        }
        if (loadedProjectWorkspaceFormatRef.current !== 'json') {
            throw new Error('声明式迁移 v1 不会自动清洗旧 XML 工程；原包和工程保持不变');
        }
        if (unknownBlockProtection) {
            if (unknownBlockProtection.inspection.format !== 'json') {
                throw new Error('未知积木保护中的 XML 工程不能执行声明式迁移');
            }
            return unknownBlockProtection.inspection.rawWorkspace.serialized;
        }
        const workspace = workspaceRef.current;
        if (!workspace) throw new Error('Blockly 工作区尚未准备好');
        return JSON.stringify(Blockly.serialization.workspaces.save(workspace));
    }, [currentPath, projectLoadSafetyError, rendererRecoveryFailure, unknownBlockProtection]);

    const createBlockPackageMigrationCheckpoint = useCallback(async (
        exactWorkspaceJson: string,
    ): Promise<string> => {
        if (!isNativeCheckpointStorageAvailable()) {
            throw new Error('原生工程检查点不可用，迁移已停止');
        }
        const currentWorkspaceJson = readBlockPackageMigrationWorkspace();
        if (currentWorkspaceJson !== exactWorkspaceJson) {
            throw new Error('工作区在迁移预览后发生变化，请重新预览');
        }
        const protectedWorkspace = Boolean(unknownBlockProtection);
        const workspace = workspaceRef.current;
        const buildTarget = captureBuildTarget();
        const checkpoint = await createProjectCheckpoint({
            projectPath: currentPath,
            reason: 'before_package_migration',
            workspaceJson: exactWorkspaceJson,
            code: protectedWorkspace
                ? generatedCodeRef.current
                : workspace ? arduinoGenerator.workspaceToCode(workspace) : '',
            board: activeBoard,
            boardPackageId: activeBoardPackageId,
            options: JSON.stringify(buildTarget.options),
            buildTarget: JSON.stringify(buildTarget),
            blockCount: protectedWorkspace || !workspace
                ? 0
                : workspace.getAllBlocks(false).filter(block => !(block as any).isInFlyout).length,
        });
        return checkpoint.id;
    }, [
        activeBoard,
        activeBoardPackageId,
        boardOptions,
        currentPath,
        readBlockPackageMigrationWorkspace,
        unknownBlockProtection,
    ]);

    const handleCancel = async () => {
        if (!isCompilingRef.current || buildCancelInFlightRef.current) return;
        buildCancelInFlightRef.current = true;
        const runId = foregroundBuildRunIdRef.current;
        if (runId) cancelRequestedBuildRunIdsRef.current.add(runId);
        setBuildProgress(prev => ({
            ...prev,
            message: '正在安全停止编译进程…',
            indeterminate: true,
        }));
        appendCompileLog('\n[信息] 正在终止本次 Arduino CLI/GCC 进程树，并等待它们完全退出…\n');
        try {
            if (runId) {
                const report = await invoke<string>('cancel_foreground_build', { runId });
                appendCompileLog(`[信息] ${report}\n`);
            } else {
                await invoke('cancel_upload');
            }
        } catch (error) {
            if (runId) cancelRequestedBuildRunIdsRef.current.delete(runId);
            appendCompileLog(`[错误] 无法确认后台任务已经停止：${String(error)}\n`);
            showToast('取消失败，仍在等待后台任务安全退出', 'error');
            buildCancelInFlightRef.current = false;
            return;
        }
        pendingForceRebuildRef.current = false;
        appendCompileLog('[信息] 编译或上传已安全取消；后台进程已退出。\n');
        serialMonitorRef.current?.write('\r\n[系统] 操作已被用户安全取消。\r\n');
        showToast('编译或上传已安全取消', 'info');
    };
    cancelDebugBuildRef.current = handleCancel;

    const handleCompileAndUpload = async (
        isUpload: boolean,
        options: CompileRunOptions = {},
    ): Promise<boolean> => {
        if (isCompilingRef.current || projectLoadingRef.current) return false;
        if (unknownBlockProtection || projectLoadSafetyError || rendererRecoveryFailure) {
            showToast('工程处于只读保护模式，已阻止编译和上传', 'error');
            appendCompileLog(
                rendererRecoveryFailure
                    ? '\n[工程保护] 积木外观切换后未能完整恢复工作区。CK 已保留切换前快照并阻止编译/上传，请先重试恢复。\n'
                    : '\n[工程保护] 当前工程未被安全反序列化。CK 不会基于空工作区或删减后的积木生成固件；请先补齐第三方积木包或修复工程数据。\n',
            );
            setConsoleOpen(true);
            setConsoleTab('compile');
            return false;
        }
        if (deviceHealthRunningRef.current) {
            showToast('请等待真机体检结束后再编译或上传', 'info');
            return false;
        }
        const configurationDifference = projectBuildTargetDifference(recordedBuildTargetRef.current, buildEnvironmentRef.current);
        if (configurationDifference) {
            showToast('工程记录的编译环境与当前环境不同，请先确认配置', 'error');
            appendCompileLog(`\n[工程配置] ${configurationDifference} 请安装原 Core，或在工作区明确选择“采用当前环境”后重试。\n`);
            setConsoleOpen(true);
            setConsoleTab('compile');
            return false;
        }
        if (!activeBoardPackageBuildGate.canBuild) {
            const action = isUpload ? '上传' : '编译';
            showToast(`板卡包未就绪，已阻止${action}`, 'error');
            appendCompileLog(
                `\n[板卡包门禁] 已阻止${action}：${activeBoardPackageBuildGate.reason}\n`
                + '[板卡包门禁] 工程仍可打开查看；请重新安装精确板卡包，或修复质量/Core 环境后再试。\n',
            );
            setConsoleOpen(true);
            setConsoleTab('compile');
            return false;
        }
        if (boardOptionsStatus === 'loading') {
            if (Object.keys(boardOptions).length === 0) {
                // No project option can be lost or silently rewritten here:
                // Arduino CLI owns the board/Core defaults for a base FQBN.
                // Keep the schema lookup in the background instead of making
                // a first Compile click wait or disappear.
                appendCompileLog('\n[准备] 板卡选项目录仍在后台加载；当前工程没有自定义板卡选项，直接使用 Core 默认配置开始。\n');
            } else if (options.codeOverride === undefined) {
                const action = isUpload ? '上传' : '编译';
                const existing = pendingBoardOptionBuildRef.current;
                pendingBoardOptionBuildRef.current = {
                    isUpload,
                    options: { ...options },
                    board: activeBoard,
                    boardPackageId: activeBoardPackageId,
                    queuedAt: existing?.board === activeBoard
                        && existing.boardPackageId === activeBoardPackageId
                        ? existing.queuedAt
                        : Date.now(),
                };
                setIsBuildPreparing(true);
                showToast(`正在校验板卡选项，完成后将自动${action}（无需再次点击）`, 'loading');
                if (!existing) {
                    appendCompileLog(`\n[准备] 正在校验工程保存的板卡选项；校验完成后将自动${action}，无需再次点击。\n`);
                }
                return false;
            } else {
                showToast('正在校验板卡选项；调试/轨迹固件请在完成后重试', 'info');
                appendCompileLog('\n[准备] 调试/轨迹固件包含一次性源码，板卡选项校验完成前不会排队保存。\n');
                return false;
            }
        }
        if (boardOptionsStatus === 'unverified') {
            showToast('板卡定义加载失败，工程中的编译选项尚未验证', 'error');
            appendCompileLog('\n[错误] 工程包含显式板卡选项，但当前无法加载板卡定义进行校验。为避免静默改用默认配置，已阻止编译/上传；请重新加载板卡或检查核心安装。\n');
            return false;
        }
        if (Object.keys(droppedBoardOptions).length > 0) {
            const incompatibleOptions = Object.entries(droppedBoardOptions)
                .map(([key, value]) => `${key}=${value}`)
                .join('、');
            showToast('存在当前板卡不支持的旧配置，已阻止构建', 'error');
            appendCompileLog(`\n[错误] 已阻止编译/上传：当前板卡不支持配置 ${incompatibleOptions}。CK 不会静默改用默认值；请在板卡设置中移除不兼容旧配置。\n`);
            setConsoleOpen(true);
            setConsoleTab('compile');
            setIsConfigOpen(true);
            return false;
        }
        if (isUpload && !activePort) {
            showToast('请先选择串口', 'error');
            appendCompileLog('\n错误：未选择串口。\n');
            return false;
        }

        if (!extensionsReady
            || extensionsLoadedBoard !== activeBoard
            || extensionsLoadedBoardPackageId !== activeBoardPackageId) {
            showToast('正在校验当前板卡包的积木运行时，请稍候', 'info');
            appendCompileLog('\n[积木运行时门禁] 当前精确板卡包的扩展仍在加载，本次构建尚未开始。\n');
            return false;
        }
        const disallowedExtensionRuntimes = findDisallowedExtensionBlockRuntimes(
            (workspaceRef.current?.getAllBlocks(false) || [])
                .filter(block => !(block as any).isInFlyout)
                .map(block => String(block.type || '')),
            allowedExtensionRuntimeIdsRef.current,
        );
        if (disallowedExtensionRuntimes.length > 0) {
            const summary = disallowedExtensionRuntimes
                .map(item => `${item.blockType}（来自 ${item.ownerExtensionId}）`)
                .join('、');
            showToast('工程包含其他板卡包的积木，已阻止构建', 'error');
            appendCompileLog(
                `\n[积木运行时门禁] 已阻止构建：${summary}\n`
                + '[积木运行时门禁] 请切回对应的精确板卡包，或移除/替换这些积木；同 FQBN 不代表扩展可以混用。\n',
            );
            setConsoleOpen(true);
            setConsoleTab('compile');
            return false;
        }

        // Pin safety must run before Blockly code generation. In particular,
        // the custom-board "undeclared pin" sentinel must never be allowed to
        // enter generated C++ when the active package has no trusted catalog.
        const pinBoardCatalog = createPinBoardCatalog(
            availableBoards,
            activeBoardPackage,
            activeBoardPackageId,
            effectiveCompileFqbn,
            installedCorePinAliases,
        );
        const nextPinPreflight = analyzePinPreflight({
            workspace: workspaceRef.current as any,
            boardFqbn: effectiveCompileFqbn,
            boardPackageId: activeBoardPackageId,
            boardOptions: displayBoardOptions,
            code: options.codeOverride ?? (codePreviewPending ? '' : generatedCodeRef.current || generatedCode),
            blockRules: pinBlockRulesFromCatalog(window.CK_BLOCK_CATALOG?.blocks || []),
            blockCatalog: window.CK_BLOCK_CATALOG?.blocks || [],
            officialBoards: pinBoardCatalog,
        });
        setPinPreflightReport(nextPinPreflight);
        if (!nextPinPreflight.canCompile) {
            const blockerSummary = nextPinPreflight.blockers
                .map(issue => issue.title)
                .join('；');
            const blockedLog = `[引脚体检] 已阻止${isUpload ? '上传' : '编译'}：${blockerSummary}\n`;
            replaceCompileLog(blockedLog);
            setCompileIssues([]);
            openEngineeringHealth();
            showToast('引脚体检发现确定错误，请先修正', 'error');
            return false;
        }

        // Resource preflight is advisory: it reports the existing analysis
        // before code generation but never changes the workspace or blocks a
        // compile. The exact resolved identity is reused when available;
        // otherwise the report is explicitly marked unavailable.
        setIsResourcePreflightRunning(true);
        try {
            const productionSnapshot = productionResourceAnalysisRef.current as any;
            const resolvedIdentity = productionSnapshot?.status === 'ready'
                ? productionSnapshot.model?.identity
                : undefined;
            const cached = currentCompilerResourcePresentation(
                compilerResourcePresentationRef.current,
                workspaceRef.current ? JSON.stringify(Blockly.serialization.workspaces.save(workspaceRef.current)) : '',
                effectiveCompileFqbn, generatedCodeRef.current,
            );
            let evaluation = cached || evaluateResourcePreflight({
                phase: 'compile',
                resolvedIdentity,
                workspace: workspaceRef.current as any,
                boardResourceGraph: activeBoardPackage?.resource_graph,
                catalog: resourceCatalogFromLibraries(blockCatalogLibrariesRef.current),
            });
            if (!cached && compilerResourcePresentationRef.current) evaluation = markCompilerObservationStale(evaluation);
            setResourcePreflightReport({
                ...evaluation.report, phase: 'compile',
                implementationCheck: currentCompilerObservationStatus(
                    compilerObservationAttemptRef.current,
                    workspaceRef.current ? JSON.stringify(Blockly.serialization.workspaces.save(workspaceRef.current)) : '',
                    effectiveCompileFqbn, generatedCodeRef.current,
                ),
            });
            if (evaluation.inspector) setHardwareResourceInspector(evaluation.inspector);
            if (evaluation.report.status === 'conflict') {
                appendCompileLog(`\n${buildT('resourcePreflight.conflictLog')}\n`);
                openEngineeringHealth();
            } else if (evaluation.report.status === 'warning') {
                appendCompileLog(`\n${buildT('resourcePreflight.warningLog')}\n`);
                openEngineeringHealth();
            }
        } catch (error) {
            console.warn('[ResourcePreflight] compile evaluation unavailable', error);
            setResourcePreflightReport(null);
        } finally {
            setIsResourcePreflightRunning(false);
        }

        const isForceRebuild = pendingForceRebuildRef.current;
        pendingForceRebuildRef.current = false;
        let compileCode: string;
        try {
            compileCode = resolveCompileSource(
                options.codeOverride,
                workspaceRef.current,
                workspace => arduinoGenerator.workspaceToCode(workspace),
                generatedCodeRef.current || generatedCode,
            );
        } catch (error) {
            console.error('[Workspace] Failed to generate current compile source', error);
            showToast('\u5f53\u524d\u79ef\u6728\u65e0\u6cd5\u751f\u6210\u4ee3\u7801\uff0c\u7f16\u8bd1\u5c1a\u672a\u5f00\u59cb', 'error');
            appendCompileLog(`\n[\u9519\u8bef] \u751f\u6210\u5f53\u524d\u79ef\u6728\u6e90\u7801\u5931\u8d25\uff1a${String(error)}\n`);
            setConsoleOpen(true);
            setConsoleTab('compile');
            return false;
        }
        if (options.codeOverride === undefined) {
            // Keep the preview/debug snapshot aligned with the exact source sent
            // to the backend. The visible Blockly workspace is authoritative.
            generatedCodeRef.current = compileCode;
            if (compileCode !== generatedCode) setGeneratedCode(compileCode);
        }
        const workspaceEvidenceFingerprint = (): string => {
            try {
                const serialized = workspaceRef.current
                    ? JSON.stringify(Blockly.serialization.workspaces.save(workspaceRef.current))
                    : '';
                return computeCodeFingerprint(serialized);
            } catch {
                return computeCodeFingerprint(generatedCodeRef.current || '');
            }
        };
        const workspaceFingerprintAtRunStart = workspaceEvidenceFingerprint();
        // Freeze the exact bytes sent to this compile session. The map remains
        // immutable even if the user edits the workspace while the compiler is
        // still reporting diagnostics. Debug/trace overrides are re-frozen here
        // as long as they retain the inline provenance boundaries.
        const frozenCompileSourceMap = freezeCompileSourceMap(compileCode, { file: 'sketch.ino' });
        compileSourceMapSessionRef.current = {
            sourceMap: frozenCompileSourceMap,
            code: compileCode,
            runId: '',
            trustedSketchAlias: null,
            aliasRevoked: false,
            blockPresentations: captureCompileIssueBlockPresentations(
                workspaceRef.current as any,
                frozenCompileSourceMap,
            ),
        };
        const compileSourceMapJson = JSON.stringify(compileSourceMapSessionRef.current.sourceMap);
        const foregroundWarmupRequest = createSilentPrecompileRequest(
            effectiveCompileFqbn,
            extensionsReloadSeq,
            computeIncludeSignature(compileCode),
            computeCodeFingerprint(compileCode),
            compileCode,
        );
        const uploadLabel = options.uploadMode === 'debug'
            ? buildT('uploadMode.debug')
            : options.uploadMode === 'trace'
                ? buildT('uploadMode.trace')
                : buildT('uploadMode.normal');
        const isInstrumentedUpload = isUpload && (
            options.uploadMode === 'debug' || options.uploadMode === 'trace'
        );
        let lastWorkingVersionCapture: Record<string, unknown> | null = null;
        let lastWorkingCaptureWarning = '';
        if (isUpload && !isInstrumentedUpload && healthCapabilities.lastWorkingVersion && workspaceRef.current) {
            try {
                const workspaceState = Blockly.serialization.workspaces.save(workspaceRef.current);
                const selectedBoard = activeBoardPackage as any;
                const boardPassportLock = selectedBoard?.passport?.ck_lock
                    ?? selectedBoard?.passport?.ckLock
                    ?? selectedBoard?.passport?.lock
                    ?? selectedBoard?.ck_lock
                    ?? selectedBoard?.ckLock
                    ?? null;
                lastWorkingVersionCapture = {
                    projectPath: currentPath,
                    workspaceJson: JSON.stringify(workspaceState),
                    generatedCode: compileCode,
                    board: activeBoard,
                    boardPackageId: activeBoardPackageId,
                    boardOptionsJson: JSON.stringify(captureBuildTarget().options),
                    blockCount: workspaceRef.current.getAllBlocks(false)
                        .filter(block => !(block as any).isInFlyout)
                        .length,
                    boardPassportLock,
                };
            } catch (error) {
                console.warn('[LastWorkingVersion] Failed to capture project state', error);
                lastWorkingCaptureWarning = `[上一个可用版本] 无法捕获当前完整工程，本次上传仍会继续：${String(error)}\n`;
            }
        }

        const compileEnvironment = getCurrentCompileEnvironment(compileCode);
        const nativeBuildProjectId = `${nativeBuildProjectRef.current}:${currentPathRef.current}:${reloadTriggerRef.current}`;
        const buildEvidence: ForegroundBuildEvidence = Object.freeze({
            schemaVersion: 1,
            runId: createForegroundBuildRunId(),
            kind: isUpload ? 'upload' : 'compile',
            boardPackageId: activeBoardPackageId,
            fqbn: effectiveCompileFqbn,
            coreId: compileEnvironment.coreId,
            coreVersion: compileEnvironment.coreVersion,
            workspaceSha256: workspaceFingerprintAtRunStart,
            generatedCodeSha256: compileEnvironment.codeFingerprint,
            // Compile does not consume a serial port, but retaining the selected
            // endpoint makes the pre/post-cancel workspace identity auditable.
            port: activePort || '',
            workspaceFingerprint: compileEnvironment.codeFingerprint,
        });
        const buildRunId = buildEvidence.runId;
        if (compileSourceMapSessionRef.current?.sourceMap === frozenCompileSourceMap) {
            compileSourceMapSessionRef.current.runId = buildRunId;
        }
        foregroundBuildRunIdRef.current = buildRunId;
        isCompilingRef.current = true;
        compileStreamSeenRef.current = false;
        setForegroundBuildEvidence(buildEvidence);
        setIsCompiling(true);

        const sessionId = compileSessionRef.current + 1;
        compileSessionRef.current = sessionId;
        setFeedbackRunId(buildRunId);
        const isCurrentSession = () => compileSessionRef.current === sessionId;
        const resourceTargetIdentity: CompileResourceTargetIdentity = {
            projectPath: currentPath,
            requestedFqbn: effectiveCompileFqbn,
            sessionId,
            codeFingerprint: compileEnvironment.codeFingerprint,
            runId: buildRunId,
        };
        const runEvidenceIsCurrent = () => (
            options.codeOverride === undefined
            && !isInstrumentedUpload
            && isCurrentSession()
            && currentPathRef.current === resourceTargetIdentity.projectPath
            && effectiveCompileFqbnRef.current === resourceTargetIdentity.requestedFqbn
            && workspaceEvidenceFingerprint() === workspaceFingerprintAtRunStart
        );
        let staleEvidenceNoticeWritten = false;
        const noteStaleEvidence = () => {
            if (staleEvidenceNoticeWritten) return;
            staleEvidenceNoticeWritten = true;
            appendCompileLog('[信息] 编译期间工程已编辑；本次日志与产物保留，但不会覆盖当前工程的体检、资源或错误定位证据。\n');
        };
        // Freeze the checkpoint payload at the same instant as the compiler
        // input. Ordinary compilation persists it off the critical path;
        // upload still waits for this exact snapshot before reaching backend
        // compilation or flashing.
        const checkpointInput = createWorkspaceCheckpointInput(
            isUpload ? 'before_upload' : 'before_compile',
        );

        // monitorPortRef reflects the confirmed backend endpoint and avoids
        // relying solely on a possibly one-render-old React boolean.
        const serialMonitorWasOpen = isSerialMonitorOpen || monitorPortRef.current !== null;
        const serialMonitorWasDesired = desiredSerialOpenRef.current;
        const shouldRestoreSerialMonitor = isUpload && (
            serialMonitorWasOpen
            || serialMonitorWasDesired
            || options.ensureSerialMonitor === true
        );
        const restorePort = monitorPortRef.current || activePort;
        const restoreBaud = options.serialBaudRate || monitorBaudRateRef.current || baudRateRef.current;
        let operationResultCode: BuildOperationResultCode = 'pending';
        let uploadSerialSettingsSeq: number | undefined;

        setConsoleOpen(true);
        setConsoleTab('compile');
        const initialLog = `${lastWorkingCaptureWarning}正在初始化编译环境...\n`;
        replaceCompileLog(initialLog);
        setCompileIssues([]);
        setCompileLogViewMode('key');
        const initialProgress = createBuildProgressState('compile');
        setBuildProgress(isForceRebuild
            ? {
                ...initialProgress,
                message: '正在强制重建当前配置',
                stage: 'full-build',
                indeterminate: true,
                fullBuildKind: 'rebuild',
            }
            : {
                ...initialProgress,
                message: isUpload
                    ? '正在保存上传前安全检查点'
                    : initialProgress.message,
            });

        if (compileTimerRef.current) {
            clearInterval(compileTimerRef.current);
            compileTimerRef.current = null;
        }

        const timer = setInterval(() => {
            setBuildProgress(prev => {
                if (!isCurrentSession() || !isCompilingRef.current) return prev;
                return tickBuildProgress(prev);
            });
        }, 1000);
        compileTimerRef.current = timer;

        showToast(
            isUpload
                ? buildT('status.uploadingFirmware', { firmware: uploadLabel })
                : buildT('status.compiling'),
            'loading',
        );

        const persistFrozenCheckpoint = () => checkpointInput
            ? createProjectCheckpoint(checkpointInput)
            : Promise.resolve(null);
        const reportCheckpointFailure = (error: unknown) => {
            const warning = `[检查点警告] 自动保存失败，本次操作仍会继续：${String(error)}\n`;
            console.warn('[ProjectCheckpoints] Failed to create automatic checkpoint', error);
            if (isCurrentSession()) appendCompileLog(warning);
        };
        if (isUpload) {
            const checkpointCompletion = scheduleBuildCheckpoint({
                mode: 'upload',
                persist: persistFrozenCheckpoint,
                onFailure: reportCheckpointFailure,
            });
            // Upload is intentionally stricter: no backend command can begin
            // until the safety snapshot has either persisted or emitted its
            // explicit warning.
            await checkpointCompletion;
            if (isCurrentSession()) {
                setBuildProgress(previous => ({
                    ...previous,
                    message: buildT('status.preparingFirmware', { firmware: uploadLabel }),
                }));
            }
        }

        if (!isCurrentSession()) return false;
        if (cancelRequestedBuildRunIdsRef.current.has(buildRunId)) {
            cancelRequestedBuildRunIdsRef.current.delete(buildRunId);
            if (foregroundBuildRunIdRef.current === buildRunId) {
                foregroundBuildRunIdRef.current = null;
            }
            buildCancelInFlightRef.current = false;
            isCompilingRef.current = false;
            setForegroundBuildEvidence(null);
            setIsCompiling(false);
            setBuildProgress(createIdleBuildProgress());
            return false;
        }

        const startTime = performance.now();

        // Clear previous compile-error warnings on blocks
        if (workspaceRef.current) {
            clearCompileErrors(workspaceRef.current);
        }

        const appendReturnedLogIfNeeded = (rawLog: string) => {
            const cleaned = typeof rawLog === 'string' ? rawLog.trim() : '';
            if (!cleaned) return;
            if (compileStreamSeenRef.current && compileLogRef.current.includes(cleaned)) return;
            appendCompileLog((compileLogRef.current.endsWith('\n') ? '' : '\n') + cleaned + '\n');
        };

        const publishCompileDoctor = (
            success: boolean,
            diagnostics: CompileDiagnosticsPayload | null,
            durationMs: number,
            extraLog = '',
        ): CompileDoctorReport | null => {
            if (!runEvidenceIsCurrent()) {
                noteStaleEvidence();
                return null;
            }
            const resolvedFqbn = String(diagnostics?.fqbn || '').trim()
                || parseResolvedCompileFqbn(`${compileLogRef.current}\n${extraLog}`);
            const resolvedEnvironment = resolvedFqbn
                ? { ...compileEnvironment, fqbn: resolvedFqbn }
                : compileEnvironment;
            const diagnosed = diagnoseCompile({
                success,
                log: `${compileLogRef.current}\n${extraLog}`,
                durationMs,
                diagnostics,
                currentEnvironment: resolvedEnvironment,
                previousSnapshot: compileEnvironmentSnapshot,
            });
            const report = bindProjectBuildEvidence(diagnosed, buildEvidence, diagnosed.recordedAt);
            setCompileDoctorReport(report);
            if (success) {
                const nextSnapshot = saveCompileEnvironmentSnapshot(
                    currentPath,
                    resolvedEnvironment,
                    diagnostics,
                );
                if (nextSnapshot) setCompileEnvironmentSnapshot(nextSnapshot);
            }
            return report;
        };

        const publishCompileResources = (
            extraLog = '',
            includeUploaderMemory = false,
            resolvedFqbnOverride = '',
            linkerMapSummaryOverride: LinkerMapResourceSummary | null = null,
        ) => {
            if (!runEvidenceIsCurrent()) {
                noteStaleEvidence();
                return;
            }
            const combinedLog = `${compileLogRef.current}\n${extraLog}`;
            const capturedAt = new Date().toISOString();
            const usage = parseCompileResourceUsage(
                combinedLog,
                { includeUploaderMemory, uploaderMeasuredAt: capturedAt },
            );
            if (!usage) {
                setCompileResourceReport(null);
                return;
            }

            const resolvedFqbn = String(resolvedFqbnOverride || '').trim()
                || parseResolvedCompileFqbn(combinedLog)
                || compileEnvironment.fqbn;
            const linkerMapSummary = linkerMapSummaryOverride
                || parseLinkerMapResourceSummary(combinedLog, resolvedFqbn);

            const currentTargetIdentity: CompileResourceTargetIdentity = {
                projectPath: currentPathRef.current,
                requestedFqbn: effectiveCompileFqbnRef.current,
                sessionId: compileSessionRef.current,
                codeFingerprint: computeCodeFingerprint(generatedCodeRef.current || ''),
                runId: foregroundBuildRunIdRef.current || '',
            };
            if (!isSameCompileResourceTarget(resourceTargetIdentity, currentTargetIdentity)) {
                noteStaleEvidence();
                return;
            }

            const persistedSnapshot = loadCompileResourceSnapshot(
                resourceTargetIdentity.projectPath,
                resourceTargetIdentity.requestedFqbn,
            );
            // The live ref may already belong to another project after a
            // navigation. Only the captured project/config storage key is a
            // safe comparison baseline for this async result.
            const previousSnapshot = persistedSnapshot?.fqbn === resolvedFqbn
                ? persistedSnapshot
                : null;
            const report = bindProjectBuildEvidence(createCompileResourceReport(
                usage,
                previousSnapshot,
                capturedAt,
                resolvedFqbn,
                linkerMapSummary,
            ), buildEvidence, capturedAt);
            const nextSnapshot = createCompileResourceSnapshot(
                resolvedFqbn,
                { ...usage, uploaderMemory: report.uploaderMemory },
                capturedAt,
                resourceTargetIdentity.requestedFqbn,
                linkerMapSummary,
            );
            saveCompileResourceSnapshot(resourceTargetIdentity.projectPath, nextSnapshot);

            compileResourceSnapshotRef.current = nextSnapshot;
            setCompileResourceSnapshot(nextSnapshot);
            setCompileResourceReport(report);
        };

        const publishCompileIssues = (
            operation: 'compile' | 'upload',
            extraLog = '',
            environmentChanges = compareCompileEnvironment(
                compileEnvironmentSnapshot,
                compileEnvironment,
            ),
        ) => {
            if (!runEvidenceIsCurrent()) {
                noteStaleEvidence();
                return [];
            }
            const analyzedIssues = analyzeCompileIssues({
                log: `${compileLogRef.current}\n${extraLog}`,
                operation,
                fqbn: compileEnvironment.fqbn,
                activePort,
                environmentChanges,
            });
            const issues = reconcileCompileIssueBlocks(analyzedIssues);
            setCompileIssues(issues);
            return issues;
        };

        try {
            // @ts-ignore
            const { invoke } = await import('@tauri-apps/api/core');

            if (isUpload) {
                serialSettingsSeqRef.current += 1;
                uploadSerialSettingsSeq = serialSettingsSeqRef.current;
                clearSerialReconnectTimer();
                if (serialMonitorWasOpen) {
                    appendCompileLog(`\n${uploadLabel}上传前自动关闭串口监视器...\n`);
                    try {
                        const serialCloseStarted = performance.now();
                        await invoke('close_serial_monitor');
                        appendCompileLog(
                            `[Timing] 串口监视器已同步关闭并释放端口：${Math.round(performance.now() - serialCloseStarted)}ms\n`,
                        );
                    } catch (e) {
                        console.warn('Failed to close serial monitor', e);
                    }
                    monitorPortRef.current = null;
                    monitorBaudRateRef.current = null;
                    setMonitorPort(null);
                    setMonitorBaudRate(null);
                    setIsSerialMonitorOpen(false);
                }

                if (cancelRequestedBuildRunIdsRef.current.has(buildRunId)) {
                    throw new Error('CK_FRONTEND_BUILD_CANCELED');
                }

                const uploadRaw = await invoke('upload_sketch', {
                    code: compileCode,
                    fqbn: buildEvidence.fqbn,
                    boardPackageId: activeBoardPackageId,
                    runId: buildEvidence.runId,
                    port: buildEvidence.port,
                    workspaceFingerprint: buildEvidence.workspaceFingerprint,
                    projectId: nativeBuildProjectId,
                    sourceMapJson: compileSourceMapJson,
                    probeMemory: !isInstrumentedUpload,
                    lastWorkingVersion: lastWorkingVersionCapture,
                    structuredResult: true,
                }) as string;

                if (!isCurrentSession()) return false;

                const uploadResult = parseSuccessfulUploadResult(uploadRaw, buildEvidence);
                const log = uploadResult.log;
                const evidenceLog = `${uploadResult.compileLog}\n${log}`;

                const duration = ((performance.now() - startTime) / 1000).toFixed(1);
                appendReturnedLogIfNeeded(log);

                // The native command returns Err for every failed/cancelled
                // transport. A resolved IPC Result is therefore authoritative
                // success even when its diagnostic log mentions a recovered
                // failed attempt or an optional probe failure.
                operationResultCode = completedBuildOperationResult('upload');
                if (!isInstrumentedUpload) setDebugRecoveryNotice('');
                showToast(buildT('result.uploadSuccessToast', { firmware: uploadLabel, duration }), 'success');
                appendCompileLog(
                    `\n${buildT('result.uploadSuccessLog', { firmware: uploadLabel, duration })}\n`,
                    operationResultCode,
                );
                if (isInstrumentedUpload) {
                    appendCompileLog('[信息] 调试/轨迹运行时的资源开销不写入项目 Flash/RAM 基线。\n');
                } else {
                    publishCompileDoctor(true, null, performance.now() - startTime, evidenceLog);
                    publishCompileResources(evidenceLog, true, uploadResult.fqbn);
                    if (runEvidenceIsCurrent()) {
                        setProjectUploadResult(createProjectUploadResult(
                            `${compileLogRef.current}\n${log}`, buildEvidence,
                            new Date().toISOString(), uploadResult.baselineFailure,
                        ));
                    }
                }
            } else {
                appendCompileLog(`\n[信息] 目标 FQBN: ${effectiveCompileFqbn}\n`);

                if (cancelRequestedBuildRunIdsRef.current.has(buildRunId)) {
                    throw new Error('CK_FRONTEND_BUILD_CANCELED');
                }

                productionResourceAnalysisRef.current = null;
                compilerResourcePresentationRef.current = null;
                compilerObservationAttemptRef.current = null;
                setHardwareResourceInspector(null);
                setResourcePreflightReport(report => report ? { ...report, implementationCheck: 'needs-compile' } : report);
                const resourceWorkspace = workspaceRef.current;
                let resourceWorkspaceBefore: string | null = null;
                try {
                    if (resourceWorkspace && !options.codeOverride) resourceWorkspaceBefore = JSON.stringify(Blockly.serialization.workspaces.save(resourceWorkspace));
                } catch { /* Optional analysis must not block compilation. */ }
                const resultJson = await invoke('compile_sketch', {
                    code: compileCode,
                    fqbn: buildEvidence.fqbn,
                    boardPackageId: activeBoardPackageId,
                    runId: buildEvidence.runId,
                    workspaceFingerprint: buildEvidence.workspaceFingerprint,
                    projectId: nativeBuildProjectId,
                    sourceMapJson: compileSourceMapJson,
                }) as string;

                if (!isCurrentSession()) return false;

                let path = "";
                let log = "";
                let artifacts: string[] = [];
                let diagnostics: CompileDiagnosticsPayload | null = null;
                let sourceMapPath = '';
                let linkerMapSummary: LinkerMapResourceSummary | null = null;
                try {
                    const res = JSON.parse(resultJson);
                    // This is an optional read-only consumer after compilation, not build input.
                    // Do not attach an old compile to a workspace edited while it was running.
                    try {
                        if (resourceWorkspaceBefore !== null && resourceWorkspace && resourceWorkspace === workspaceRef.current
                            && resourceWorkspaceBefore === JSON.stringify(Blockly.serialization.workspaces.save(resourceWorkspace))) {
                            productionResourceAnalysisRef.current = analyzeProductionResolvedResources(
                                res.resourceBoardIdentity,
                                resourceWorkspace,
                                {
                                    boardResourceGraph: activeBoardPackage?.resource_graph,
                                    catalog: resourceCatalogFromLibraries(blockCatalogLibrariesRef.current),
                                },
                            );
                            const inspector = inspectorViewFromProductionAnalysis(productionResourceAnalysisRef.current);
                            setHardwareResourceInspector(inspector);
                            const productionSnapshot = productionResourceAnalysisRef.current as any;
                            if (inspector && productionSnapshot?.status === 'ready' && productionSnapshot.report) {
                                const declaredReport = buildResourcePreflight({
                                    phase: 'compile',
                                    analysis: productionSnapshot.report,
                                    inspector,
                                });
                                const attempt: CompilerObservationAttempt = {
                                    workspaceJson: resourceWorkspaceBefore, fqbn: effectiveCompileFqbn,
                                    codeSha256: sha256Hex(compileCode), status: 'running',
                                };
                                compilerObservationAttemptRef.current = attempt;
                                setResourcePreflightReport({ ...declaredReport, implementationCheck: 'running' });
                                const observationIsCurrent = () => isCurrentSession()
                                    && compilerObservationAttemptRef.current === attempt
                                    && resourceWorkspace === workspaceRef.current
                                    && productionResourceAnalysisRef.current === productionSnapshot
                                    && currentCompilerObservationStatus(
                                        attempt, JSON.stringify(Blockly.serialization.workspaces.save(resourceWorkspace)),
                                        effectiveCompileFqbnRef.current, generatedCodeRef.current,
                                    ) !== 'stale';
                                const observationUnavailable = () => {
                                    if (!observationIsCurrent()) return;
                                    attempt.status = 'unavailable';
                                    setResourcePreflightReport({ ...declaredReport, implementationCheck: 'unavailable' });
                                };
                                // Bounded post-build compiler evidence. Never awaited by
                                // compilation/upload, never an input to a build signature.
                                void invoke<CapturedCompilerSnapshot>('observe_compiled_resources', {
                                    runId: buildEvidence.runId,
                                }).then(capture => {
                                    if (!observationIsCurrent()) return;
                                    const evaluation = integrateCompilerResources(
                                        productionSnapshot, capture, compileCode, JSON.parse(compileSourceMapJson),
                                        { runId: buildEvidence.runId, alias: compileSourceMapSessionRef.current?.trustedSketchAlias ?? null },
                                    );
                                    if (!evaluation) {
                                        observationUnavailable();
                                        return;
                                    }
                                    attempt.status = 'partial';
                                    compilerResourcePresentationRef.current = {
                                        workspaceJson: resourceWorkspaceBefore!, fqbn: effectiveCompileFqbn,
                                        codeSha256: sha256Hex(compileCode), evaluation,
                                    };
                                    setHardwareResourceInspector(evaluation.inspector);
                                    setResourcePreflightReport(evaluation.report);
                                    if (evaluation.report.status === 'conflict'
                                        || evaluation.report.issues.some(issue => issue.code === 'interrupt-latency-risk')) {
                                        openEngineeringHealth();
                                    }
                                }).catch(error => {
                                    // Unrecognized compiler/version/complex code remains
                                    // partial. It cannot turn a successful build into failure.
                                    console.info('[ResourceObservation] evidence unavailable', error);
                                    observationUnavailable();
                                }).finally(() => {
                                    // A result discarded during editing must not leave an
                                    // endless spinner if Undo later restores the old source.
                                    if (attempt.status === 'running') attempt.status = 'unavailable';
                                    if (compilerObservationAttemptRef.current === attempt) {
                                        setResourcePreflightRevision(revision => revision + 1);
                                    }
                                });
                            }
                        }
                    } catch {
                        productionResourceAnalysisRef.current = null;
                        setHardwareResourceInspector(null);
                        setResourcePreflightReport(null);
                    }
                    path = typeof res.path === 'string' ? res.path : "";
                    log = typeof res.log === 'string' ? res.log : "";
                    if (Array.isArray(res.artifacts)) {
                        artifacts = res.artifacts.map((item: unknown) => String(item));
                    }
                    if (res.diagnostics && typeof res.diagnostics === 'object') {
                        diagnostics = res.diagnostics as CompileDiagnosticsPayload;
                    }
                    sourceMapPath = typeof res.sourceMapPath === 'string' ? res.sourceMapPath : '';
                    linkerMapSummary = normalizeLinkerMapResourceSummary(
                        res.linkerMapSummary,
                        String(res.diagnostics?.fqbn || effectiveCompileFqbn),
                    );
                } catch (e) {
                    path = resultJson;
                }

                const durationMs = performance.now() - startTime;
                const duration = (durationMs / 1000).toFixed(1);
                operationResultCode = completedBuildOperationResult('compile');
                showToast(buildT('result.compileSuccessToast', { duration }), 'success');

                appendReturnedLogIfNeeded(log);
                appendCompileLog(
                    `\n${buildT('result.compileSuccessLog', { duration })}\n`,
                    operationResultCode,
                );
                if (artifacts.length > 0) {
                    appendCompileLog(`${buildT('result.artifactFiles', { count: artifacts.length })}:\n${artifacts.join('\n')}\n`);
                } else if (path) {
                    appendCompileLog(`${buildT('result.artifactFile')}: ${path}\n`);
                }
                if (sourceMapPath) {
                    appendCompileLog(`${buildT('result.sourceMap')}: ${sourceMapPath}\n`);
                }
                publishCompileDoctor(true, diagnostics, durationMs, log);
                publishCompileResources(
                    log,
                    false,
                    String(diagnostics?.fqbn || ''),
                    linkerMapSummary,
                );
            }
        } catch (e: any) {
            if (!isCurrentSession()) return false;
            if (cancelRequestedBuildRunIdsRef.current.has(buildRunId)) {
                operationResultCode = 'cancelled';
                appendCompileLog('\n[信息] 后端已确认本次构建取消，正在恢复串口和界面状态。\n');
            } else {
                operationResultCode = 'failed';
                console.error(e);
                showToast(buildT('result.operationFailed'), 'error');
                appendCompileLog(`\n失败: ${e}\n`);
                if (!isUpload) {
                    const report = publishCompileDoctor(
                        false,
                        null,
                        performance.now() - startTime,
                        String(e),
                    );
                    publishCompileIssues('compile', String(e), report?.environmentChanges || []);
                } else {
                    publishCompileIssues('upload', String(e));
                }
                if (runEvidenceIsCurrent()) {
                    // Immediate path when the alias is already present. The
                    // compileIssues effect repeats this after a late alias.
                    highlightCompileErrorBlocks(compileLogRef.current);
                }
            }
        } finally {
            clearInterval(timer);
            if (compileTimerRef.current === timer) {
                compileTimerRef.current = null;
            }
            if (isCurrentSession() && shouldRestoreSerialMonitor && restorePort) {
                const restoreRetryDelays = [0, 150, 200, 350, 500];
                let restoreError: unknown = null;
                let restored = false;
                try {
                    if (options.serialBaudRate) {
                        baudRateRef.current = options.serialBaudRate;
                        setBaudRate(options.serialBaudRate);
                    }
                    const restoreStarted = performance.now();
                    for (const delayMs of restoreRetryDelays) {
                        if (!isCurrentSession()) break;
                        if (delayMs > 0) {
                            await new Promise(r => setTimeout(r, delayMs));
                        }
                        if (!isCurrentSession()) break;
                        try {
                            await openSerialMonitorWithSettings(
                                restorePort,
                                restoreBaud,
                                'restore',
                                uploadSerialSettingsSeq,
                            );
                            restoreError = null;
                            restored = true;
                            break;
                        } catch (error) {
                            restoreError = error;
                        }
                    }
                    if (!isCurrentSession()) {
                        // A newer compile/upload session owns the serial endpoint now.
                    } else if (!restored) {
                        throw restoreError || new Error('串口尚未重新出现');
                    } else {
                        appendCompileLog(
                            `\n${uploadLabel}上传结束后已恢复串口监视器（${Math.round(performance.now() - restoreStarted)}ms）。\n`,
                        );
                    }
                } catch (e) {
                    if (isCurrentSession()) {
                        desiredSerialOpenRef.current = false;
                        monitorPortRef.current = null;
                        monitorBaudRateRef.current = null;
                        setMonitorPort(null);
                        setMonitorBaudRate(null);
                        appendCompileLog(`\n${uploadLabel}上传结束后恢复串口监视器失败: ${String(e)}\n`);
                    }
                }
            }
            if (!isCurrentSession()) return false;
            if (foregroundBuildRunIdRef.current === buildRunId) {
                foregroundBuildRunIdRef.current = null;
            }
            cancelRequestedBuildRunIdsRef.current.delete(buildRunId);
            buildCancelInFlightRef.current = false;
            if (isBuildOperationSuccessful(operationResultCode)) {
                // Serial restoration and other post-success awaits may have
                // allowed the same exact request to be queued again. Consume it
                // at the final blocked boundary, immediately before unlock.
                silentPrecompileSchedulerRef.current?.cancelSatisfied(foregroundWarmupRequest);
            }
            isCompilingRef.current = false;
            setForegroundBuildEvidence(null);
            setIsCompiling(false);
            setIsResourcePreflightRunning(false);
            setBuildProgress(createIdleBuildProgress());
        }
        if (!isUpload) {
            // Compile-only checkpoints preserve the payload frozen above, but
            // write it after the compiler releases its hot-path disk activity.
            // Compilation never consumes this snapshot, so delaying persistence
            // removes avoidable I/O contention without weakening upload safety.
            void scheduleBuildCheckpoint({
                mode: 'compile',
                persist: persistFrozenCheckpoint,
                onFailure: reportCheckpointFailure,
            });
        }
        return isBuildOperationSuccessful(operationResultCode);
    };

    useEffect(() => {
        const pending = pendingBoardOptionBuildRef.current;
        if (!pending || boardOptionsStatus === 'loading') return;
        pendingBoardOptionBuildRef.current = null;
        setIsBuildPreparing(false);

        if (pending.board !== activeBoard || pending.boardPackageId !== activeBoardPackageId) {
            setToast(previous => previous.type === 'loading'
                ? { ...previous, show: false }
                : previous);
            appendCompileLog('\n[准备] 板卡已变化，已取消上一块板卡等待中的构建请求。\n');
            return;
        }
        if (boardOptionsStatus === 'unverified') {
            showToast('板卡选项校验失败，未启动构建', 'error');
            appendCompileLog('\n[错误] 板卡选项校验失败；等待中的编译/上传没有启动，也没有静默改用默认值。\n');
            return;
        }

        const waitedSeconds = Math.max(0, (Date.now() - pending.queuedAt) / 1000).toFixed(1);
        appendCompileLog(`[准备] 板卡选项校验完成（等待 ${waitedSeconds} 秒），现在自动开始${pending.isUpload ? '上传' : '编译'}。\n`);
        const timer = window.setTimeout(() => {
            void handleCompileAndUpload(pending.isUpload, pending.options);
        }, 0);
        return () => window.clearTimeout(timer);
    }, [activeBoard, activeBoardPackageId, boardOptionsStatus]);

    const handleCompileIssueAction = async (
        action: CompileIssueAction,
        issue: CompileIssueCard,
    ) => {
        if (action.kind === 'library_search') {
            librarySearchRequestIdRef.current += 1;
            setLibrarySearchRequest({
                requestId: librarySearchRequestIdRef.current,
                query: action.query,
            });
            setIsLibManagerOpen(true);
            return;
        }

        if (action.kind === 'rescan_ports') {
            const scanSucceeded = await scanPorts();
            showToast(
                scanSucceeded ? '串口列表已重新扫描' : '串口扫描失败，请检查设备连接或驱动',
                scanSucceeded ? 'success' : 'error',
            );
            return;
        }

        if (action.kind === 'show_boot_help') {
            const familyName = action.boardFamily === 'esp8266' ? 'ESP8266' : 'ESP32';
            const steps = action.boardFamily === 'esp8266'
                ? [
                    '1. 关闭其他占用串口的软件，并确认 USB 数据线可传输数据。',
                    '2. 按住 FLASH/BOOT，短按一下 RESET。',
                    '3. 保持按住 FLASH/BOOT，重新点击上传；出现 Connecting 后再松开。',
                    '4. 若开发板带自动下载电路仍失败，请重新插拔设备并重新扫描串口。',
                ]
                : [
                    '1. 关闭其他占用串口的软件，并确认 USB 数据线可传输数据。',
                    '2. 按住 BOOT，短按一下 EN/RESET。',
                    '3. 保持按住 BOOT，重新点击上传；出现 Connecting 后再松开。',
                    '4. 若开发板带自动下载电路仍失败，请重新插拔设备并重新扫描串口。',
                ];
            await dialog.alert({
                title: `${familyName} 上传握手帮助`,
                message: steps.join('\n'),
                type: 'info',
                confirmLabel: '知道了',
            });
            return;
        }

        if (action.kind === 'show_resources') {
            openEngineeringHealth();
            showToast(
                compileResourceReport
                    ? '资源面板显示最近一次成功结果；本次失败请结合溢出日志判断'
                    : '本次失败没有生成资源统计，请核对分区设置与链接器日志',
                'info',
            );
            return;
        }

        setIsConfigOpen(true);
    };

    const clearCurrentBoardCompileCache = async (
        nextAction: 'clear' | 'compile' | 'upload' = 'clear',
        cacheMode: 'safe' | 'deep' = 'safe',
    ): Promise<boolean> => {
        if (isCompilingRef.current) {
            showToast('请等待当前编译结束', 'error');
            return false;
        }
        if (nextAction === 'upload' && !activePort) {
            showToast('重新烧录前请先选择串口', 'error');
            return false;
        }

        const isDeepRefresh = cacheMode === 'deep';
        const actionText = isDeepRefresh
            ? '将清除当前完整板卡配置的全部构建产物，并让下一次编译忽略已有编译器内容缓存。仅在怀疑缓存损坏、Core 升级异常或普通重建仍有问题时使用；ESP32 可能需要数分钟。'
            : nextAction === 'upload'
                ? '将清除当前板卡配置的工程构建产物，保留按源码内容校验的编译器缓存，然后重新生成固件并烧录。烧录期间会暂时关闭串口监视器。'
                : nextAction === 'compile'
                    ? '将清除当前板卡配置的工程构建产物，保留按源码内容校验的编译器缓存，然后重新生成固件。'
                    : '将清除当前板卡配置的工程构建产物，并保留按源码内容校验的编译器缓存。下次编译会重新生成固件。';
        const confirmed = await dialog.confirm({
            title: isDeepRefresh
                ? '彻底刷新编译缓存？'
                : nextAction === 'upload'
                ? '清除缓存并重新烧录？'
                : nextAction === 'compile'
                    ? '清除缓存并重新编译？'
                    : '清除当前编译缓存？',
            message: `${actionText}\n\n板卡：${getBoardName()}\n配置：${effectiveCompileFqbn}\n\n不会删除工程源码、积木、库文件或板卡核心。`,
            tone: 'warning',
            confirmLabel: isDeepRefresh
                ? '彻底刷新（较慢）'
                : nextAction === 'upload'
                ? '清除并重新烧录'
                : nextAction === 'compile'
                    ? '清除并重新编译'
                    : '确认清除缓存',
            cancelLabel: '取消',
        });
        if (!confirmed) return false;

        try {
            const cacheCommand = isDeepRefresh
                ? 'clear_board_compile_cache'
                : 'clear_board_first_project_compile_cache';
            const report: any = await invoke(cacheCommand, {
                fqbn: effectiveCompileFqbn,
            });
            const removedEntries = Number(report?.removed_entries || 0);
            const removedMiB = Number(report?.removed_bytes || 0) / (1024 * 1024);
            silentPrecompileSchedulerRef.current?.cancelPending();
            setConsoleOpen(true);
            setConsoleTab('compile');
            appendCompileLog(
                `\n[信息] 已清除 ${effectiveCompileFqbn} 的编译缓存：${removedEntries} 项，${removedMiB.toFixed(1)} MiB。\n` +
                (isDeepRefresh
                    ? '[信息] 下一次编译将忽略已有 ccache 命中并重新生成核心与依赖；ESP32 可能需要数分钟。\n'
                    : '[信息] 已保留按源码内容校验的共享 ccache；下一次编译会重新生成当前配置的固件产物。\n'),
            );
            showToast(isDeepRefresh ? '已安排彻底刷新，下一次编译会较慢' : '当前配置将在保留内容缓存的情况下重建', 'success');
            return true;
        } catch (error) {
            console.error('Failed to clear board compile cache', error);
            showToast('清除编译缓存失败', 'error');
            appendCompileLog(`\n[错误] 清除编译缓存失败：${String(error)}\n`);
            return false;
        }
    };

    const handleForceRebuild = async (uploadAfterBuild: boolean) => {
        const cleared = await clearCurrentBoardCompileCache(
            uploadAfterBuild ? 'upload' : 'compile',
        );
        if (!cleared) return;
        pendingForceRebuildRef.current = true;
        setIsConfigOpen(false);
        await handleCompileAndUpload(uploadAfterBuild);
    };
    // Blockly Workspace Ref and State
    const blocklyDiv = useRef<HTMLDivElement>(null);
    const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
    const [blocklyWorkspace, setBlocklyWorkspace] = useState<Blockly.WorkspaceSvg | null>(null);
    useEffect(() => {
        const registry = Blockly.ContextMenuRegistry.registry;
        const entries = [
            { id: 'ckAiEditBlock', kind: 'edit' as const, label: '让 AI 修改这段积木' },
            { id: 'ckAiExplainBlock', kind: 'explain' as const, label: '让 AI 解释这段积木' },
        ];
        for (const entry of entries) {
            if (registry.getItem(entry.id)) registry.unregister(entry.id);
            registry.register({ id: entry.id, scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
                weight: 8, displayText: entry.label,
                preconditionFn: scope => scope.block?.workspace === workspaceRef.current && !scope.block.isShadow() ? 'enabled' : 'hidden',
                callback: scope => { if (scope.block?.workspace === workspaceRef.current) openAi({ kind: entry.kind, blockId: scope.block.id }); },
            });
        }
        return () => { for (const entry of entries) if (registry.getItem(entry.id)) registry.unregister(entry.id); };
    }, [openAi]);
    const blocklySkinPaintFrameRef = useRef<number | null>(null);
    const scheduleBlocklyVisualSkin = useCallback((workspace: Blockly.WorkspaceSvg | null = workspaceRef.current) => {
        if (!workspace) return;
        // Keep the earliest queued paint. Cancelling and re-queuing here can
        // push a flyout repaint past the next browser frame and expose raw
        // Blockly colours for a perceptible flash.
        if (blocklySkinPaintFrameRef.current !== null) return;
        blocklySkinPaintFrameRef.current = requestAnimationFrame(() => {
            blocklySkinPaintFrameRef.current = null;
            if (workspaceRef.current === workspace) {
                applyBlocklyVisualSkin(workspace, blocklyVisualStyleRef.current);
            }
        });
    }, []);
    const repaintBlocklyVisualSkin = useCallback((workspace: Blockly.WorkspaceSvg | null = workspaceRef.current) => {
        if (!workspace) return;
        // Paint synchronously so newly-created flyout blocks never expose their
        // raw Blockly colour for one frame, then keep one frame as a fallback
        // for Blockly renderers that finish registering children asynchronously.
        applyBlocklyVisualSkin(workspace, blocklyVisualStyleRef.current);
        scheduleBlocklyVisualSkin(workspace);
    }, [scheduleBlocklyVisualSkin]);
    useEffect(() => () => {
        if (blocklySkinPaintFrameRef.current !== null) {
            cancelAnimationFrame(blocklySkinPaintFrameRef.current);
            blocklySkinPaintFrameRef.current = null;
        }
    }, []);
    const rendererTransitionRef = useRef<BlocklyRendererTransitionSnapshot | null>(null);
    const retryBlocklyRendererRecovery = useCallback(() => {
        if (!rendererTransitionRef.current) return;
        setRendererRecoveryFailure(null);
        setIsBlocklyVisualStyleSwitching(true);
        setBlocklyRendererRevision(revision => revision + 1);
    }, []);

    const exportBlocklyRendererRecoverySnapshot = useCallback(async () => {
        const transition = rendererTransitionRef.current;
        if (!transition) return;
        try {
            const selectedPath = await save({
                defaultPath: 'CK-renderer-recovery-snapshot.json',
                filters: [{ name: 'CK 工作区恢复快照', extensions: ['json'] }],
            });
            if (!selectedPath) return;
            // Export the existing Blockly serialization directly. This is a
            // recovery copy, not a new CK schema or contract/version axis.
            await writeTextFile(selectedPath, JSON.stringify(transition.state, null, 2));
            showToast('恢复快照已导出', 'success');
        } catch (error) {
            console.error('[Blockly] Failed to export renderer recovery snapshot', error);
            showToast('恢复快照导出失败', 'error');
        }
    }, []);

    const handleBlocklyVisualStyleChange = useCallback((requestedStyle: BlocklyVisualStyle) => {
        const nextStyle = normalizeBlocklyVisualStyle(requestedStyle);
        if (nextStyle === blocklyVisualStyle || isBlocklyVisualStyleSwitching || rendererRecoveryFailure) return;

        const workspace = workspaceRef.current;
        const currentRenderer = blocklyRendererForVisualStyle(blocklyVisualStyle);
        const nextRenderer = blocklyRendererForVisualStyle(nextStyle);

        // The built-in CK skins all keep the original Thrasos geometry. Apply
        // those as a live theme swap: no serialize/dispose/re-inject cycle and
        // therefore no interruption to the user's current gesture or blocks.
        if (currentRenderer === nextRenderer) {
            const persisted = persistBlocklyVisualStyle(
                nextStyle,
                getBrowserBlocklyVisualStyleStorage(),
            );
            setBlocklyVisualStyle(persisted);
            showToast(t('settings.appearance.blockSkin.changed', {
                skin: t(`settings.appearance.blockSkin.styles.${persisted}.label`),
            }), 'success');
            return;
        }

        if (workspace) {
            try {
                workspace.hideChaff();
                workspace.cancelCurrentGesture();
                const selected = Blockly.getSelected() as { id?: string; workspace?: unknown } | null;
                rendererTransitionRef.current = {
                    state: Blockly.serialization.workspaces.save(workspace),
                    originStyle: blocklyVisualStyle,
                    revertAttempted: false,
                    scale: workspace.getScale(),
                    scrollX: workspace.scrollX,
                    scrollY: workspace.scrollY,
                    selectedBlockId: selected?.workspace === workspace && selected.id
                        ? String(selected.id)
                        : null,
                    reason: 'renderer',
                    originBlocklyLocale: blocklyLocaleRef.current,
                };
            } catch (error) {
                console.error('[Blockly] Failed to capture renderer transition state', error);
                showToast('积木外观切换前无法完整保存当前工作区，已取消切换', 'error');
                return;
            }
        }

        const persisted = persistBlocklyVisualStyle(
            nextStyle,
            getBrowserBlocklyVisualStyleStorage(),
        );
        setIsBlocklyVisualStyleSwitching(Boolean(workspace));
        setBlocklyVisualStyle(persisted);
        if (!workspace) setIsBlocklyVisualStyleSwitching(false);
    }, [blocklyVisualStyle, isBlocklyVisualStyleSwitching, rendererRecoveryFailure, t]);

    // Blockly's message table is process-global and custom CK block labels are
    // authored imperatively.  A plain setLocale() therefore cannot update the
    // already-instantiated workspace safely.  Route a Blockly locale change
    // through the existing renderer transition transaction so serialization,
    // selection, viewport, breakpoints and trace overlays survive unchanged.
    useEffect(() => {
        const nextLocale = effectiveBlocklyLocale;
        const previousLocale = blocklyLocaleRef.current;

        // Keep the global message table aligned even when this is the initial
        // render (or when the preference was changed before the workspace was
        // injected).  No workspace mutation occurs in this fast path.
        if (nextLocale === previousLocale) {
            applyBlocklyLocale(nextLocale);
            return;
        }

        // A renderer transition already owns the reinjection transaction.  The
        // dependency on isBlocklyVisualStyleSwitching makes this effect retry
        // once that transition settles instead of racing two disposals.
        if (isBlocklyVisualStyleSwitching || rendererTransitionRef.current) return;

        const workspace = workspaceRef.current;
        applyBlocklyLocale(nextLocale);
        blocklyLocaleRef.current = nextLocale;
        if (!workspace) return;

        try {
            workspace.hideChaff();
            workspace.cancelCurrentGesture();
            const selected = Blockly.getSelected() as { id?: string; workspace?: unknown } | null;
            const transition: BlocklyRendererTransitionSnapshot = {
                state: Blockly.serialization.workspaces.save(workspace),
                originStyle: blocklyVisualStyle,
                revertAttempted: false,
                scale: workspace.getScale(),
                scrollX: workspace.scrollX,
                scrollY: workspace.scrollY,
                selectedBlockId: selected?.workspace === workspace && selected.id
                    ? String(selected.id)
                    : null,
                reason: 'locale',
                originBlocklyLocale: previousLocale,
                targetBlocklyLocale: nextLocale,
            };
            rendererTransitionRef.current = transition;
            setIsBlocklyVisualStyleSwitching(true);
            // Package locale overlays are applied before Blockly disposes the
            // old workspace. This keeps the existing serialization/reinject
            // transaction intact while ensuring declarative third-party block
            // labels, tooltips and dropdown labels use the selected locale.
            void refreshActiveExtensionLocales(nextLocale).then(() => {
                if (rendererTransitionRef.current !== transition) return;
                setBlocklyRendererRevision(revision => revision + 1);
            });
        } catch (error) {
            blocklyLocaleRef.current = previousLocale;
            applyBlocklyLocale(previousLocale);
            console.error('[Blockly] Failed to capture locale transition state', error);
            showToast('积木语言切换前无法完整保存当前工作区，已取消切换', 'error');
        }
    }, [
        blocklyVisualStyle,
        effectiveBlocklyLocale,
        isBlocklyVisualStyleSwitching,
        refreshActiveExtensionLocales,
    ]);

    const scheduleProjectDirtyComparison = useCallback((
        workspace: Blockly.WorkspaceSvg | null = workspaceRef.current,
        delay = 80,
    ) => {
        if (dirtyCompareTimerRef.current) clearTimeout(dirtyCompareTimerRef.current);
        dirtyCompareTimerRef.current = setTimeout(() => {
            dirtyCompareTimerRef.current = null;
            const cleanFingerprint = cleanProjectFingerprintRef.current;
            if (!workspace || !dirtyTrackingReadyRef.current || !cleanFingerprint) return;
            try {
                const currentState = Blockly.serialization.workspaces.save(workspace);
                setIsProjectDirty(
                    createProjectFingerprint(
                        currentState,
                        activeBoardDirtyRef.current,
                        boardOptionsDirtyRef.current,
                        activeBoardPackageIdDirtyRef.current,
                        recordedBuildTargetRef.current,
                    ) !== cleanFingerprint,
                );
            } catch (error) {
                console.warn('[Workspace] Failed to refresh project dirty state', error);
                setIsProjectDirty(true);
            }
        }, delay);
    }, []);
    useEffect(() => () => {
        if (dirtyCompareTimerRef.current) clearTimeout(dirtyCompareTimerRef.current);
    }, []);
    const [generatedCode, setGeneratedCode] = useState('// 正在生成代码...');
    const userReadableCode = useMemo(() => codeViewOpen ? stripBlockMarkers(generatedCode) : '', [generatedCode, codeViewOpen]);
    const [buildProgress, setBuildProgress] = useState<BuildProgressState>(createIdleBuildProgress);
    const [extensionXml, setExtensionXml] = useState('');
    const [extensionsReady, setExtensionsReady] = useState(false);
    const [extensionsLoadedBoard, setExtensionsLoadedBoard] = useState('');
    const [extensionsLoadedBoardPackageId, setExtensionsLoadedBoardPackageId] = useState('');
    const [extensionsReloadSeq, setExtensionsReloadSeq] = useState(0);
    useEffect(() => {
        // Installing/reloading an implementation invalidates source evidence
        // even when generated code and the visible board name stay identical.
        compilerResourcePresentationRef.current = null;
        compilerObservationAttemptRef.current = null;
        productionResourceAnalysisRef.current = null;
        setResourcePreflightReport(null);
        setHardwareResourceInspector(null);
    }, [extensionsReloadSeq]);
    const [toolboxLoading, setToolboxLoading] = useState(false);
    const [blockSearchQuery, setBlockSearchQuery] = useState('');
    const [blockSearchResultCount, setBlockSearchResultCount] = useState<number | null>(null);
    const [isBlockSearchActive, setIsBlockSearchActive] = useState(false);
    const blockSearchInputRef = useRef<HTMLInputElement>(null);
    const extensionLoadSeqRef = useRef(0);
    const registeredExtensionIdsRef = useRef<Set<string>>(new Set());
    const allowedExtensionRuntimeIdsRef = useRef<Set<string>>(new Set());
    const blockCatalogLibrariesRef = useRef<any[]>([]);
    const enabledBlockPackageInventoryRef = useRef<EnabledBlockPackageInventoryEntry[]>([]);
    const enabledBlockPackageInventoryErrorRef = useRef<string | null>('已启用积木包清单尚未就绪');
    const projectLoadedKeyRef = useRef<string | null>(null);
    const projectLoadSeqRef = useRef(0);
    const projectLoadedRevisionRef = useRef(0);
    const recoveryBaselineRef = useRef<RecoveryBaselineCache | null>(null);
    const recoveryDraftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const recoveryDraftWritesRef = useRef<Map<string, Promise<void>>>(new Map());
    const persistRecoveryDraftRef = useRef<(session?: RecoveryProjectSession) => Promise<void>>(async () => {});
    const scheduleRecoveryDraftRef = useRef<() => void>(() => {});
    const recoveryOfferSuppressedSessionRef = useRef<string | null>(null);
    const recoveryRestoreInProgressRef = useRef(false);
    const recoveryRestoreResumeTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
    const formalSaveOwnerTokenSequenceRef = useRef(0);
    const recoveryFormalSaveGatesRef = useRef<Map<number, Set<string>>>(new Map());
    const recoveryDraftRescheduleAfterSaveRef = useRef<Set<string>>(new Set());
    const performFormalSaveRef = useRef<(ownerToken: number) => Promise<boolean>>(async () => false);
    const finishFormalSaveOwnerRef = useRef<(ownerToken: number, lastResult: boolean) => void>(() => {});
    const formalSaveQueueRef = useRef<ReturnType<typeof createDeferredSingleFlightQueue> | null>(null);
    const saveAsBusyRef = useRef(false);
    if (!formalSaveQueueRef.current) {
        formalSaveQueueRef.current = createDeferredSingleFlightQueue({
            nextOwnerToken: () => ++formalSaveOwnerTokenSequenceRef.current,
            runLatest: ownerToken => performFormalSaveRef.current(ownerToken),
            onOwnerSettled: (ownerToken, lastResult) => (
                finishFormalSaveOwnerRef.current(ownerToken, lastResult)
            ),
        });
    }
    const currentRecoveryProjectSession = useCallback((): RecoveryProjectSession | null => {
        const projectPath = currentPathRef.current;
        return resolveCompletedRecoveryProjectSession({
            projectPath,
            requestedLoadKey: `${projectPath}::${reloadTriggerRef.current}`,
            completedLoadKey: projectLoadedKeyRef.current,
            revision: projectLoadedRevisionRef.current,
        });
    }, []);
    const recoveryProjectSessionIsCurrent = useCallback((session: RecoveryProjectSession): boolean => (
        recoveryProjectSessionMatches(session, currentRecoveryProjectSession())
    ), [currentRecoveryProjectSession]);
    const cancelRecoveryDraftTimer = useCallback(() => {
        if (recoveryDraftTimerRef.current) {
            clearTimeout(recoveryDraftTimerRef.current);
            recoveryDraftTimerRef.current = null;
        }
    }, []);
    const recoveryFormalSaveSessionIsGated = useCallback((sessionKey: string): boolean => (
        Array.from(recoveryFormalSaveGatesRef.current.values())
            .some(sessionKeys => sessionKeys.has(sessionKey))
    ), []);
    const waitForRecoveryDraftWrite = useCallback(async (session: RecoveryProjectSession | null) => {
        if (!session) return;
        const pending = recoveryDraftWritesRef.current.get(recoveryProjectSessionKey(session));
        if (pending) await pending;
    }, []);
    const beginProjectLoad = useCallback((nextProjectPath?: string) => {
        const targetPath = nextProjectPath || currentPathRef.current;
        const nextReloadTrigger = reloadTriggerRef.current + 1;
        // Invalidate the completed session synchronously. A keyboard/menu save
        // arriving before React commits the next render must not write the old
        // workspace under the new project identity.
        projectLoadedKeyRef.current = null;
        projectLoadSeqRef.current += 1;
        currentPathRef.current = targetPath;
        reloadTriggerRef.current = nextReloadTrigger;
        if (nextProjectPath) setCurrentPath(nextProjectPath);
        setReloadTriggerState(nextReloadTrigger);
    }, []);
    const handleBlockPackageMigrationCommitted = useCallback(async () => {
        const session = currentRecoveryProjectSession();
        const sessionKey = session ? recoveryProjectSessionKey(session) : null;
        const ownerToken = ++formalSaveOwnerTokenSequenceRef.current;
        if (sessionKey) {
            recoveryFormalSaveGatesRef.current.set(ownerToken, new Set([sessionKey]));
            recoveryDraftRescheduleAfterSaveRef.current.delete(sessionKey);
            cancelRecoveryDraftTimer();
        }
        setRecoveryCandidate(previous => (
            !previous || !session || recoveryProjectSessionMatches(previous.session, session)
                ? null
                : previous
        ));
        recoveryBaselineRef.current = null;
        try {
            await waitForRecoveryDraftWrite(session);
            await discardProjectRecoveryDrafts(session?.projectPath || currentPath);
        } catch (error) {
            console.warn('[BlockPackageMigration] Migrated project saved but stale recovery drafts remain isolated', error);
        } finally {
            recoveryFormalSaveGatesRef.current.delete(ownerToken);
            if (sessionKey && !recoveryFormalSaveSessionIsGated(sessionKey)) {
                recoveryDraftRescheduleAfterSaveRef.current.delete(sessionKey);
            }
        }
        beginProjectLoad();
    }, [beginProjectLoad, cancelRecoveryDraftTimer, currentPath, currentRecoveryProjectSession, recoveryFormalSaveSessionIsGated, waitForRecoveryDraftWrite]);
    const extensionBlockColours = useMemo(
        () => collectExtensionBlockColours(extensionXml),
        [extensionXml],
    );

    // Keep the engineering-health pin map live while editing. Compile/upload
    // still performs a fresh synchronous analysis immediately before building.
    useEffect(() => {
        const workspace = workspaceRef.current;
        if (!workspace || codePreviewPending) return;
        const timer = setTimeout(() => {
            if (projectLoadingRef.current) return;
            const pinBoardCatalog = createPinBoardCatalog(
                availableBoards,
                activeBoardPackage,
                activeBoardPackageId,
                effectiveCompileFqbn,
                installedCorePinAliases,
            );
            setPinPreflightReport(analyzePinPreflight({
                workspace: workspace as any,
                boardFqbn: effectiveCompileFqbn,
                boardPackageId: activeBoardPackageId,
                boardOptions: displayBoardOptions,
                code: generatedCodeRef.current || generatedCode,
                blockRules: pinBlockRulesFromCatalog(window.CK_BLOCK_CATALOG?.blocks || []),
                blockCatalog: window.CK_BLOCK_CATALOG?.blocks || [],
                officialBoards: pinBoardCatalog,
            }));

            // Reuse the last exact compiler-resolved identity for a live,
            // read-only resource check. No board name, C++ text, or guessed
            // identity enters this path. Before the first successful compile
            // the panel remains explicitly unavailable instead of pretending
            // that a board model has been resolved.
            setIsResourcePreflightRunning(true);
            try {
                const productionSnapshot = productionResourceAnalysisRef.current as any;
                const resolvedIdentity = productionSnapshot?.status === 'ready'
                    ? productionSnapshot.model?.identity
                    : undefined;
                const serializedWorkspace = JSON.stringify(Blockly.serialization.workspaces.save(workspace));
                const cached = currentCompilerResourcePresentation(
                    compilerResourcePresentationRef.current,
                    serializedWorkspace,
                    effectiveCompileFqbn, generatedCodeRef.current,
                );
                let evaluation = cached || evaluateResourcePreflight({
                    phase: 'edit',
                    resolvedIdentity,
                    workspace: workspace as any,
                    boardResourceGraph: activeBoardPackage?.resource_graph,
                    catalog: resourceCatalogFromLibraries(blockCatalogLibrariesRef.current),
                });
                if (!cached && compilerResourcePresentationRef.current) evaluation = markCompilerObservationStale(evaluation);
                setResourcePreflightReport({
                    ...evaluation.report, phase: 'edit',
                    implementationCheck: currentCompilerObservationStatus(
                        compilerObservationAttemptRef.current,
                        serializedWorkspace,
                        effectiveCompileFqbn, generatedCodeRef.current,
                    ),
                });
                if (evaluation.inspector) setHardwareResourceInspector(evaluation.inspector);
            } catch (error) {
                console.warn('[ResourcePreflight] live evaluation unavailable', error);
                setResourcePreflightReport(null);
            } finally {
                setIsResourcePreflightRunning(false);
            }
        }, 120);
        return () => clearTimeout(timer);
    }, [
        activeBoardPackage,
        activeBoardPackageId,
        availableBoards,
        displayBoardOptions,
        effectiveCompileFqbn,
        extensionXml,
        generatedCode,
        installedCorePinAliases,
        codePreviewPending,
        resourcePreflightRevision,
    ]);

    const applyProjectCheckpointState = useCallback((checkpoint: ProjectCheckpoint) => {
        const workspace = workspaceRef.current;
        if (!workspace) throw new Error('积木工作区尚未就绪');

        const inspection = inspectSerializedBlocklyWorkspace(
            checkpoint.workspaceJson,
            isKnownBlockType,
            { format: 'json' },
        );
        if (!inspection.canDeserializeIntoBlockly) {
            throw new Error(
                `检查点包含 ${inspection.unknownBlockCount} 个当前未注册积木（${inspection.unknownTypeNames.join('、')}）。原始检查点已保留；请先安装或启用对应积木包。`,
            );
        }
        const parseable = checkpoint.workspaceJson.startsWith('\uFEFF')
            ? checkpoint.workspaceJson.slice(1)
            : checkpoint.workspaceJson;
        const rawState = JSON.parse(parseable);
        let restoredOptions: Record<string, unknown> = {};
        try {
            const parsedOptions = JSON.parse(checkpoint.options || '{}');
            if (parsedOptions && typeof parsedOptions === 'object' && !Array.isArray(parsedOptions)) {
                restoredOptions = parsedOptions as Record<string, unknown>;
            }
        } catch {
            restoredOptions = {};
        }

        updateRecordedBuildTarget(readProjectBuildTarget(checkpoint.buildTarget));
        setBoardOptions(restoredOptions);
        clearBlockBreakpoints(workspace);
        workspace.clear();
        Blockly.serialization.workspaces.load(rawState, workspace);
        const restoredCode = checkpoint.code || arduinoGenerator.workspaceToCode(workspace);
        generatedCodeRef.current = restoredCode;
        setGeneratedCode(restoredCode);
        setPinPreflightReport(null);
        setCompileIssues([]);
        setCompileDoctorReport(null);
        setConsoleOpen(false);
        dirtyTrackingReadyRef.current = true;
        setIsProjectDirty(true);

        showToast('检查点已完整恢复，可确认后保存工程', 'success');
    // showToast is stable for this component lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [setBoardOptions]);

    const handleRestoreProjectCheckpoint = useCallback(async (checkpoint: ProjectCheckpoint) => {
        if (isCompilingRef.current) {
            throw new Error('请等待当前编译或上传结束后再恢复检查点');
        }

        // Restoring is destructive to the current in-memory workspace. Refuse
        // to continue if the protective checkpoint cannot be written.
        await captureWorkspaceCheckpoint('before_restore');

        const targetBoard = String(checkpoint.board || activeBoard).trim();
        const targetBoardPackageId = String(checkpoint.boardPackageId || targetBoard).trim();
        if (targetBoard !== activeBoard
            || targetBoardPackageId !== activeBoardPackageId
            || extensionsLoadedBoard !== targetBoard
            || extensionsLoadedBoardPackageId !== targetBoardPackageId) {
            pendingCheckpointRestoreRef.current = checkpoint;
            setActiveBoard(targetBoard, targetBoardPackageId);
            showToast(`正在切换到检查点板卡：${targetBoard}`, 'info');
            return;
        }

        applyProjectCheckpointState(checkpoint);
    }, [activeBoard, activeBoardPackageId, applyProjectCheckpointState, captureWorkspaceCheckpoint, extensionsLoadedBoard, extensionsLoadedBoardPackageId, setActiveBoard]);

    useEffect(() => {
        const checkpoint = pendingCheckpointRestoreRef.current;
        if (!checkpoint || !extensionsReady) return;
        const targetBoard = String(checkpoint.board || '').trim();
        const targetBoardPackageId = String(checkpoint.boardPackageId || targetBoard).trim();
        if (!targetBoard
            || activeBoard !== targetBoard
            || activeBoardPackageId !== targetBoardPackageId
            || extensionsLoadedBoard !== targetBoard
            || extensionsLoadedBoardPackageId !== targetBoardPackageId) return;

        pendingCheckpointRestoreRef.current = null;
        try {
            applyProjectCheckpointState(checkpoint);
        } catch (error) {
            console.error('[ProjectCheckpoints] Deferred restore failed', error);
            showToast(`检查点恢复失败：${String(error)}`, 'error');
        }
    // showToast is stable for this component lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeBoard, activeBoardPackageId, applyProjectCheckpointState, extensionsLoadedBoard, extensionsLoadedBoardPackageId, extensionsReady]);

    const getCurrentLastWorkingVersionState = useCallback((): CurrentWorkingVersionState => {
        const workspace = workspaceRef.current;
        if (!workspace) throw new Error('积木工作区尚未就绪');
        const workspaceJson = JSON.stringify(Blockly.serialization.workspaces.save(workspace));
        const code = arduinoGenerator.workspaceToCode(workspace);
        const profile = String(compileDoctorReport?.profile || compileEnvironmentSnapshot?.profile || '');
        const optimization = /quick-fast|shared-fast/i.test(profile) ? '-O1' : undefined;
        const comparableBuildEvidence = compileEnvironmentSnapshot
            && compileEnvironmentSnapshot.fqbn === effectiveCompileFqbn
            && compileEnvironmentSnapshot.coreId === activeCoreId
            && compileEnvironmentSnapshot.coreVersion === activeCoreVersion
            ? compileEnvironmentSnapshot
            : null;
        const dependencyInventory = availableLibraries
            .map((library: any) => ({
                name: String(library?.manifest?.name || library?.name || '').trim(),
                version: String(library?.manifest?.version || library?.version || '').trim() || null,
            }))
            .filter(item => item.name.length > 0);
        const currentDeviceHealth = deviceHealthPublication?.target.fqbn === effectiveCompileFqbn
            ? deviceHealthPublication.report
            : null;
        return {
            workspaceJson,
            generatedCode: code,
            blockCount: workspace.getAllBlocks(false).filter(block => !(block as any).isInFlyout).length,
            fqbn: effectiveCompileFqbn,
            boardPackageId: activeBoardPackageId,
            coreId: activeCoreId,
            coreVersion: activeCoreVersion,
            boardOptions,
            optimization,
            arduinoCliVersion: comparableBuildEvidence?.cliVersion,
            toolchainKey: comparableBuildEvidence?.toolchainKey,
            buildSignature: comparableBuildEvidence?.buildSignature,
            buildEvidenceRecordedAt: comparableBuildEvidence?.capturedAt,
            dependencyInventory,
            deviceHealth: currentDeviceHealth,
            resources: compileResourceReport,
        };
    }, [
        activeCoreId,
        activeCoreVersion,
        activeBoardPackageId,
        availableLibraries,
        boardOptions,
        compileDoctorReport?.profile,
        compileEnvironmentSnapshot?.profile,
        compileResourceReport,
        deviceHealthPublication,
        effectiveCompileFqbn,
    ]);

    const lastWorkingVersionAsCheckpoint = useCallback((version: LastWorkingVersion): ProjectCheckpoint => ({
        schemaVersion: 1,
        id: version.id,
        projectPath: version.project.originalPath,
        projectName: version.project.name,
        reason: 'last_working_version',
        createdAt: version.verifiedAt,
        workspaceJson: version.project.workspaceJson,
        code: version.project.generatedCode,
        board: version.project.board,
        boardPackageId: version.project.boardPackageId || version.project.board,
        options: version.project.boardOptionsJson,
        buildTarget: JSON.stringify(targetFromRecordedFqbn(version.project.board, version.project.boardPackageId || version.project.board, composeBoardFqbn(version.project.board, JSON.parse(version.project.boardOptionsJson)), version.environment.coreVersion || '')),
        blockCount: version.project.blockCount,
    }), []);

    const handleRestoreLastWorkingProject = useCallback(async (version: LastWorkingVersion) => {
        await handleRestoreProjectCheckpoint(lastWorkingVersionAsCheckpoint(version));
    }, [handleRestoreProjectCheckpoint, lastWorkingVersionAsCheckpoint]);

    const handleRestoreLastWorkingFirmware = useCallback(async (_version: LastWorkingVersion) => {
        if (isCompilingRef.current) throw new Error('请等待当前编译或上传结束');
        const uploadPort = activePortRef.current;
        if (!uploadPort) throw new Error('请先选择当前真机串口');

        isCompilingRef.current = true;
        setIsCompiling(true);
        compileStreamSeenRef.current = false;
        const serialWasOpen = monitorPortRef.current !== null || desiredSerialOpenRef.current;
        const restoreBaud = monitorBaudRateRef.current || baudRateRef.current;
        serialSettingsSeqRef.current += 1;
        const serialSequence = serialSettingsSeqRef.current;
        setConsoleOpen(true);
        setConsoleTab('compile');
        const initialLog = '正在准备恢复上一个可用固件…\n';
        replaceCompileLog(initialLog);
        setCompileIssues([]);
        setBuildProgress({
            ...createBuildProgressState('upload'),
            message: '正在重新校验真机与可用固件',
            indeterminate: true,
        });
        showToast('正在安全恢复固件…', 'loading');

        try {
            clearSerialReconnectTimer();
            if (monitorPortRef.current !== null) {
                appendCompileLog('恢复固件前自动关闭串口监视器…\n');
                await invoke('close_serial_monitor');
                monitorPortRef.current = null;
                monitorBaudRateRef.current = null;
                setMonitorPort(null);
                setMonitorBaudRate(null);
                setIsSerialMonitorOpen(false);
            }
            const returnedLog = await restoreLastWorkingFirmware(currentPathRef.current, uploadPort);
            const cleaned = String(returnedLog || '').trim();
            if (cleaned && (!compileStreamSeenRef.current || !compileLogRef.current.includes(cleaned))) {
                appendCompileLog(`${compileLogRef.current.endsWith('\n') ? '' : '\n'}${cleaned}\n`);
            }
            appendCompileLog('\n上一个可用固件恢复成功。\n');
            showToast('上一个可用固件已恢复', 'success');
        } catch (error) {
            appendCompileLog(`\n恢复失败：${String(error)}\n`);
            showToast('恢复固件失败', 'error');
            throw error;
        } finally {
            if (serialWasOpen) {
                const retryDelays = [0, 150, 300, 500];
                let restored = false;
                let lastError: unknown = null;
                for (const delay of retryDelays) {
                    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
                    try {
                        await openSerialMonitorWithSettings(
                            uploadPort,
                            restoreBaud,
                            'restore',
                            serialSequence,
                        );
                        restored = true;
                        break;
                    } catch (error) {
                        lastError = error;
                    }
                }
                if (!restored) {
                    desiredSerialOpenRef.current = false;
                    appendCompileLog(`\n固件已处理，但串口监视器恢复失败：${String(lastError)}\n`);
                }
            }
            isCompilingRef.current = false;
            setIsCompiling(false);
            setBuildProgress(createIdleBuildProgress());
        }
    // showToast and openSerialMonitorWithSettings are stable for this component lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [appendCompileLog, clearSerialReconnectTimer]);

    const handleRebuildLastWorkingVersionLocked = useCallback(async (_version: LastWorkingVersion) => {
        if (isCompilingRef.current) throw new Error('请等待当前编译或上传结束');
        if (!currentPathRef.current) throw new Error('当前工程尚未保存，无法读取可用版本锁');

        isCompilingRef.current = true;
        setIsCompiling(true);
        compileStreamSeenRef.current = false;
        setConsoleOpen(true);
        setConsoleTab('compile');
        const initialLog = '正在验证 ck.lock 并准备锁定依赖复编译…\n';
        replaceCompileLog(initialLog);
        setCompileIssues([]);
        setBuildProgress({
            ...createBuildProgressState('compile'),
            message: '正在准备隔离构建根',
            indeterminate: true,
        });
        showToast('正在执行锁定依赖复编译…', 'loading');

        try {
            const report = await rebuildLastWorkingVersionLocked(currentPathRef.current);
            const returnedLog = String(report.log || '').trim();
            if (returnedLog && (!compileStreamSeenRef.current || !compileLogRef.current.includes(returnedLog))) {
                appendCompileLog(`${compileLogRef.current.endsWith('\n') ? '' : '\n'}${returnedLog}\n`);
            }
            appendCompileLog(
                `\n[锁定依赖复编译] 通过：${report.dependencyCount} 个依赖，未读取全局 Arduino 库。\n`
                + `[锁定依赖复编译] FQBN: ${report.fqbn}\n`
                + `[锁定依赖复编译] ck.lock: ${report.lockSha256}\n`
                + `[锁定依赖复编译] 产物证据: ${report.artifactGate}\n`
                + `[锁定依赖复编译] 构建目录: ${report.buildPath}\n`,
            );
            showToast('锁定依赖复编译通过', 'success');
        } catch (error) {
            appendCompileLog(`\n锁定依赖复编译失败：${String(error)}\n`);
            showToast('锁定依赖复编译未通过', 'error');
            throw error;
        } finally {
            isCompilingRef.current = false;
            setIsCompiling(false);
            setBuildProgress(createIdleBuildProgress());
        }
    }, [appendCompileLog]);

    const handleCompleteLastWorkingRestore = useCallback(async (version: LastWorkingVersion) => {
        // Protect the current workspace before touching either side of the
        // complete restore. Firmware goes first so an asynchronous board/extension
        // switch cannot mutate Blockly while the transport is active.
        await captureWorkspaceCheckpoint('before_restore');
        const dependencyReport = await restoreLastWorkingDependencies(
            currentPathRef.current,
            activeCoreVersion,
        );
        const dependencySummary = `[上一个可用版本] 依赖恢复完成：恢复 ${dependencyReport.restored.length} 个，已一致 ${dependencyReport.alreadyMatching.length} 个。\n`;
        try {
            await handleRestoreLastWorkingFirmware(version);
        } catch (error) {
            appendCompileLog(`\n${dependencySummary}`);
            throw error;
        }
        appendCompileLog(`\n${dependencySummary}`);
        await handleRestoreLastWorkingProject(version);
    }, [activeCoreVersion, appendCompileLog, captureWorkspaceCheckpoint, handleRestoreLastWorkingFirmware, handleRestoreLastWorkingProject]);

    const createAcceptanceReportData = useCallback(async (
        notes?: ProjectAcceptanceNotes,
    ) => {
        const capturedProjectPath = currentPathRef.current;
        const current = getCurrentLastWorkingVersionState();
        const projectName = capturedProjectPath
            .split(/[\\/]/)
            .pop()
            ?.replace(/\.(maker|ck)$/i, '') || '未命名工程';
        const boardName = (activeBoardPackage as any)?.name
            || BOARDS.find(board => board.id === activeBoard)?.name
            || activeBoard;
        // The selected package and its currently resolved menu options are the
        // sole source of truth for the report target. Historical compile,
        // resource and device evidence may only be matched against this value;
        // they must never select a target after the user switches boards.
        const resolvedBaseFqbn = String(
            (activeBoardPackage as any)?.fqbn_base
            || (activeBoardPackage as any)?.fqbn
            || activeBoard,
        ).trim();
        const resolvedFqbn = composeBoardFqbn(resolvedBaseFqbn, resolvedBoardOptions);
        const resolvedCoreId = resolvedFqbn.split(':').slice(0, 2).join(':');
        const resolvedCoreVersion = installedCoreVersions[resolvedCoreId] || activeCoreVersion;
        const [lastWorking, checkpoints] = await Promise.all([
            getLastWorkingVersion(capturedProjectPath),
            isNativeCheckpointStorageAvailable()
                ? listProjectCheckpoints(capturedProjectPath).catch(() => [])
                : Promise.resolve([]),
        ]);
        const latest = getCurrentLastWorkingVersionState();
        if (currentPathRef.current !== capturedProjectPath
            || latest.workspaceJson !== current.workspaceJson
            || latest.generatedCode !== current.generatedCode
            || latest.fqbn !== current.fqbn
            || latest.boardPackageId !== current.boardPackageId
            || latest.coreId !== current.coreId
            || latest.coreVersion !== current.coreVersion) {
            throw new Error('工程、源码或编译目标在汇总证据期间发生变化，请刷新后重试');
        }
        return createProjectAcceptanceReport({
            projectName,
            projectPath: capturedProjectPath,
            workspaceJson: current.workspaceJson,
            generatedCode: current.generatedCode,
            blockCount: current.blockCount,
            boardName,
            boardId: activeBoard,
            boardPackageId: activeBoardPackageId,
            fqbn: resolvedFqbn,
            coreId: resolvedCoreId,
            coreVersion: resolvedCoreVersion,
            boardPackage: activeBoardPackage || null,
            compileDoctorReport,
            compileResourceReport,
            deviceHealthReport: currentDeviceHealthReport,
            pinPreflightReport,
            lastWorkingVersion: lastWorking,
            uploadResult: projectUploadResult,
            checkpoints,
            notes,
            savedConfiguration: captureBuildTarget(),
        });
    }, [
        activeBoard,
        activeBoardPackage,
        activeBoardPackageId,
        activeCoreId,
        activeCoreVersion,
        compileDoctorReport,
        compileResourceReport,
        currentDeviceHealthReport,
        projectUploadResult,
        currentPath,
        generatedCode,
        resourcePreflightRevision,
        getCurrentLastWorkingVersionState,
        installedCoreVersions,
        pinPreflightReport,
        resolvedBoardOptions,
    ]);

    const createDiagnosticExportData = useCallback(async (): Promise<DiagnosticBundleExportData> => {
        const capturedAt = new Date().toISOString();
        const capturedProjectPath = currentPathRef.current;
        const current = getCurrentLastWorkingVersionState();
        const [recordedLastWorking, acceptanceReport] = await Promise.all([
            getLastWorkingVersion(capturedProjectPath),
            createAcceptanceReportData(),
        ]);
        if (currentPathRef.current !== capturedProjectPath
            || current.fqbn !== effectiveCompileFqbnRef.current
            || acceptanceReport.target.fqbn !== current.fqbn
            || acceptanceReport.project.workspaceSha256 !== sha256Hex(current.workspaceJson)
            || acceptanceReport.project.generatedCodeSha256 !== sha256Hex(current.generatedCode)) {
            throw new Error('工程在生成诊断包时已变化，请重新导出');
        }
        const lastWorking = recordedLastWorking && acceptanceReport.dependencies.lockAvailable
            && acceptanceReport.dependencies.lockSha256 === recordedLastWorking.lock.sha256
            ? recordedLastWorking : null;
        const currentCompile = acceptanceReport.build.state === 'passed' || acceptanceReport.build.state === 'failed'
            ? compileDoctorReport : null;
        const currentResources = acceptanceReport.build.flashUsedBytes != null || acceptanceReport.build.ramUsedBytes != null
            ? compileResourceReport : null;
        const changeReport = lastWorking
            ? await compareWithLastWorkingVersion(lastWorking, current)
            : null;
        const selectedBoard = activeBoardPackage as any;
        const qualityReports = availableBoards
            .filter((board: any) => board.quality_report || board.qualityReport)
            .map((board: any) => ({
                id: board.id,
                name: board.name,
                report: board.quality_report ?? board.qualityReport,
            }));
        const support = {
            schemaVersion: 1,
            capturedAt,
            application: 'CK Desktop',
            savedConfiguration: captureBuildTarget(),
            projectPath: currentPathRef.current,
            board: activeBoard,
            boardPackageId: activeBoardPackageId,
            fqbn: effectiveCompileFqbn,
            core: { id: activeCoreId, version: activeCoreVersion || null },
            boardOptions,
            compileProfile: currentCompile?.profile || null,
            buildSignature: currentCompile?.diagnostics?.environment?.buildSignature || null,
            toolchainKey: currentCompile?.diagnostics?.environment?.toolchainKey || null,
        };
        const boardReport = {
            capturedAt,
            board: selectedBoard ? {
                id: selectedBoard.id,
                name: selectedBoard.name,
                vendor: selectedBoard.vendor,
                version: selectedBoard.version,
                fqbn: selectedBoard.fqbn,
                passport: selectedBoard.passport,
                coreStatus: selectedBoard.core_status ?? selectedBoard.coreStatus,
                qualityReport: selectedBoard.quality_report ?? selectedBoard.qualityReport,
            } : { id: activeBoard },
            requestedFqbn: effectiveCompileFqbn,
            options: boardOptions,
            ...(healthCapabilities.deviceHealth ? { deviceHealth: currentDeviceHealthReport } : {}),
        };
        const projectPayload = {
            buildTarget: captureBuildTarget(),
            schemaVersion: 1,
            path: currentPathRef.current,
            board: activeBoard,
            boardPackageId: activeBoardPackageId,
            options: boardOptions,
            workspace: JSON.parse(current.workspaceJson),
            generatedCode: current.generatedCode,
        };
        const serialDevice = {
            capturedAt,
            selectedPort: activePortRef.current,
            baudRate: baudRateRef.current,
            monitorPort: monitorPortRef.current,
            monitorBaudRate: monitorBaudRateRef.current,
            ...(healthCapabilities.deviceHealth ? { deviceHealth: currentDeviceHealthReport } : {}),
        };
        const evidence = {
            support: { content: JSON.stringify(support, null, 2) },
            boardReport: { content: JSON.stringify(boardReport, null, 2) },
            buildManifest: { content: JSON.stringify({
                acceptanceReport,
                compileDoctorReport: currentCompile,
                compileResourceReport: currentResources,
            }, null, 2) },
            uploadManifest: lastWorking
                ? { content: JSON.stringify({
                    verifiedAt: lastWorking.verifiedAt,
                    environment: lastWorking.environment,
                    firmware: lastWorking.firmware,
                    device: lastWorking.device,
                    resources: lastWorking.resources,
                }, null, 2) }
                : undefined,
            ckLock: lastWorking ? { content: lastWorking.lock.content } : undefined,
            compileLog: compileLogRef.current
                ? { content: compileLogRef.current }
                : undefined,
            uploadLog: /上传|upload/i.test(compileLogRef.current)
                ? { content: compileLogRef.current }
                : undefined,
            packageQualityReports: qualityReports.length
                ? { content: JSON.stringify(qualityReports, null, 2) }
                : undefined,
            projectChangeSummary: changeReport
                ? { content: JSON.stringify(changeReport, null, 2) }
                : undefined,
            serialDevice: { content: JSON.stringify(serialDevice, null, 2) },
            project: { content: JSON.stringify(projectPayload, null, 2) },
            generatedSource: { content: current.generatedCode },
            sourceMap: compileSourceMapSessionRef.current
                ? { content: JSON.stringify(compileSourceMapSessionRef.current.sourceMap, null, 2) }
                : undefined,
        };
        return {
            context: {
                boardName: selectedBoard?.name || activeBoard,
                boardId: activeBoardPackageId,
                corePackage: activeCoreId,
                coreVersion: activeCoreVersion || null,
                fqbn: effectiveCompileFqbn,
                flashUsedBytes: acceptanceReport.build.flashUsedBytes,
                flashTotalBytes: acceptanceReport.build.flashTotalBytes,
                flashConfiguration: displayConfigurationFqbn,
                coreMissing: !activeCoreVersion,
                failureStage: currentCompile && !currentCompile.success
                    ? '编译'
                    : compileIssues.length > 0 ? '编译或上传诊断' : null,
            },
            items: createStandardDiagnosticBundleItems(evidence, effectiveCompileFqbn),
        };
    }, [
        activeBoard,
        activeBoardPackage,
        activeBoardPackageId,
        activeCoreId,
        activeCoreVersion,
        availableBoards,
        boardOptions,
        compileDoctorReport,
        compileIssues.length,
        compileResourceReport,
        currentDeviceHealthReport,
        healthCapabilities.deviceHealth,
        displayConfigurationFqbn,
        effectiveCompileFqbn,
        getCurrentLastWorkingVersionState,
        createAcceptanceReportData,
    ]);

    const createProjectSubmissionMaterial = useCallback(async () => {
        const capturedProjectPath = currentPathRef.current;
        const current = getCurrentLastWorkingVersionState();
        const lastWorking = await getLastWorkingVersion(capturedProjectPath);
        const latest = getCurrentLastWorkingVersionState();
        if (currentPathRef.current !== capturedProjectPath
            || latest.workspaceJson !== current.workspaceJson
            || latest.generatedCode !== current.generatedCode
            || latest.fqbn !== current.fqbn
            || latest.boardPackageId !== current.boardPackageId
            || latest.coreId !== current.coreId
            || latest.coreVersion !== current.coreVersion) {
            throw new Error('工程、源码或编译目标在准备提交材料期间发生变化，请刷新后重试');
        }
        return {
            workspaceJson: current.workspaceJson,
            generatedSource: current.generatedCode,
            ckLock: lastWorking?.lock.content || null,
        };
    }, [getCurrentLastWorkingVersionState]);

    const updateBlockDebugSession = useCallback((
        updater: BlockDebugSessionState | ((previous: BlockDebugSessionState) => BlockDebugSessionState),
    ) => {
        const previous = blockDebugSessionRef.current;
        const next = typeof updater === 'function' ? updater(previous) : updater;
        blockDebugSessionRef.current = next;
        setBlockDebugSession(next);
    }, []);

    const updateBlockRunMode = useCallback((mode: BlockRunMode) => {
        blockRunModeRef.current = mode;
        setBlockRunMode(mode);
    }, []);

    const refreshDebugVisuals = useCallback((pausedBlockId: string | null = null) => {
        const workspace = workspaceRef.current;
        if (!workspace) return;
        refreshBlockBreakpointVisuals(workspace, breakpointIdsRef.current, pausedBlockId);
    }, []);

    const publishBlockTraceSnapshot = useCallback((force = false) => {
        const aggregator = traceAggregatorRef.current;
        const workspace = workspaceRef.current;
        if (!aggregator || !workspace || blockRunModeRef.current !== 'trace') return;
        if (!aggregator.shouldPublish(Date.now(), force)) {
            if (!tracePublishTimerRef.current) tracePublishTimerRef.current = setTimeout(() => {
                tracePublishTimerRef.current = null;
                if (traceAggregatorRef.current !== aggregator || blockRunModeRef.current !== 'trace') return;
                aggregator.shouldPublish(Date.now(), true);
                const finalSnapshot = aggregator.snapshot();
                setBlockTraceSnapshot(finalSnapshot);
                if (workspaceRef.current) refreshBlockTraceVisuals(workspaceRef.current, finalSnapshot);
            }, 200);
            return;
        }
        if (tracePublishTimerRef.current) clearTimeout(tracePublishTimerRef.current);
        tracePublishTimerRef.current = null;
        const snapshot = aggregator.snapshot();
        setBlockTraceSnapshot(snapshot);
        refreshBlockTraceVisuals(workspace, snapshot);
    }, []);

    const clearDebugHighlight = useCallback(() => {
        const workspace = workspaceRef.current;
        workspace?.highlightBlock(null);
        refreshDebugVisuals(null);
    }, [refreshDebugVisuals]);

    const revealWorkspaceBlock = useCallback((blockId: string) => {
        const workspace = workspaceRef.current;
        const block = workspace?.getBlockById(blockId);
        if (!workspace || !block) return;
        const shape = block.pathObject?.svgPath?.getBoundingClientRect();
        const view = workspace.getInjectionDiv().getBoundingClientRect();
        if (!shape || !shape.width || !shape.height) return;
        // The SVG path is this block's shape; the group's bounding box includes
        // every next block and can center a long chain far away from the target.
        const panel = document.querySelector('[data-ck-role="block-trace-panel"], [data-ck-role="block-debug-controls"]')?.getBoundingClientRect();
        const right = panel && panel.left > view.left + 150 ? Math.min(view.right, panel.left - 16) : view.right;
        const scale = workspace.getParentSvg().getBoundingClientRect().width / workspace.getParentSvg().clientWidth || 1;
        const dx = ((view.left + right) / 2 - (shape.left + shape.width / 2)) / scale;
        const dy = ((view.top + view.bottom) / 2 - (shape.top + shape.height / 2)) / scale;
        workspace.scroll(workspace.scrollX + dx, workspace.scrollY + dy);
    }, []);

    const locateWorkspaceBlock = useCallback((blockId: string) => {
        const block = workspaceRef.current?.getBlockById(blockId);
        if (!block) return;
        revealCompileError(workspaceRef.current!, blockId);
        revealWorkspaceBlock(blockId);
        block.addSelect();
        setTimeout(() => {
            try { block.removeSelect(); } catch { /* Block may have been deleted. */ }
        }, 1200);
    }, [revealWorkspaceBlock]);

    const finishBlockDebugSession = useCallback((notifyUser = false) => {
        const finishedMode = blockRunModeRef.current;
        clearDebugHighlight();
        if (workspaceRef.current) {
            refreshBlockTraceVisuals(workspaceRef.current, null);
        }
        debugStopCommandInFlightRef.current = false;
        debugAttachCommandInFlightRef.current = false;
        debugHasAttachedRef.current = false;
        if (debugCommandTimerRef.current) clearTimeout(debugCommandTimerRef.current);
        debugCommandTimerRef.current = null;
        if (tracePublishTimerRef.current) clearTimeout(tracePublishTimerRef.current);
        tracePublishTimerRef.current = null;
        debugMinimumSequenceRef.current = 0;
        clearInitialDebugAttachTimers();
        debugTokenToBlockIdRef.current = new Map();
        traceIndexToBlockIdRef.current = new Map();
        traceAggregatorRef.current = null;
        debugStreamParserRef.current.reset();
        setBlockTraceSnapshot(null);
        setBlockTraceFirmwareFps(25);
        updateBlockRunMode(null);
        updateBlockDebugSession(IDLE_BLOCK_DEBUG_SESSION);
        if (notifyUser) {
            const message = finishedMode === 'trace'
                ? '运行轨迹已结束；板上仍是轨迹固件，正式使用请点“普通上传”'
                : '调试已结束；板上仍是调试固件，正式使用请点“普通上传”';
            serialMonitorRef.current?.write(`\r\n[调试] ${message}。\r\n`);
            showToast(message, 'info');
        }
    // showToast is stable for this component lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clearDebugHighlight, clearInitialDebugAttachTimers, updateBlockDebugSession, updateBlockRunMode]);

    const startInitialDebugAttachTimeout = useCallback((expectedSessionId: string) => {
        clearInitialDebugAttachTimers();
        if (debugHasAttachedRef.current) return;

        const retryAttach = () => {
            const current = blockDebugSessionRef.current;
            if (
                !current.active
                || current.sessionId !== expectedSessionId
                || current.phase === 'stopping'
                || debugHasAttachedRef.current
            ) {
                clearInitialDebugAttachTimers();
                return;
            }
            void attachCurrentBlockDebugSession();
        };

        retryAttach();
        debugAttachRetryTimerRef.current = setInterval(
            retryAttach,
            INITIAL_DEBUG_ATTACH_RETRY_MS,
        );
        debugAttachTimeoutRef.current = setTimeout(() => {
            clearInitialDebugAttachTimers();
            const current = blockDebugSessionRef.current;
            if (
                !current.active
                || current.sessionId !== expectedSessionId
                || current.phase === 'stopping'
                || debugHasAttachedRef.current
            ) return;

            const traceMode = blockRunModeRef.current === 'trace';
            const message = traceMode
                ? '轨迹附加超时，尚未收到采样；板上仍是轨迹固件，可重置后重试或普通上传'
                : '调试附加超时，断点未启用；板上仍是调试固件，可重置后重试或普通上传';
            serialMonitorRef.current?.write(`\r\n[${traceMode ? '轨迹' : '调试'}] ${message}。\r\n`);
            finishBlockDebugSession(false);
            showToast(message, 'error');
        }, INITIAL_DEBUG_ATTACH_TIMEOUT_MS);
    // showToast is stable for this component lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [attachCurrentBlockDebugSession, clearInitialDebugAttachTimers, finishBlockDebugSession]);

    const sendBlockDebugCommand = useCallback(async (command: CkDebugCommand, sequence?: number): Promise<boolean> => {
        const session = blockDebugSessionRef.current;
        if (!session.active || !session.sessionId) return false;
        return writeBlockDebugCommand(session.sessionId, command, true, sequence);
    }, [writeBlockDebugCommand]);

    const armDebugCommandTimeout = useCallback((sessionId: string, sequence: number) => {
        if (debugCommandTimerRef.current) clearTimeout(debugCommandTimerRef.current);
        debugCommandTimerRef.current = setTimeout(() => {
            debugCommandTimerRef.current = null;
            const current = blockDebugSessionRef.current;
            if (!current.active || current.sessionId !== sessionId || debugMinimumSequenceRef.current !== sequence) return;
            updateBlockDebugSession({ ...current, phase: 'unresponsive', pendingCommand: null });
        }, 4000);
    }, [updateBlockDebugSession]);

    const handleDebugResume = useCallback(async (command: 'CONTINUE' | 'STEP') => {
        const current = blockDebugSessionRef.current;
        if (!current.active || current.phase !== 'paused' || current.pendingCommand) return;
        const sequence = ++debugCommandSequenceRef.current;
        debugMinimumSequenceRef.current = sequence;
        updateBlockDebugSession({ ...current, pendingCommand: command });
        armDebugCommandTimeout(current.sessionId, sequence);
        const sent = await sendBlockDebugCommand(command, sequence);
        // Only a device acknowledgement advances execution state. Completion of
        // this older write must never overwrite a newer PAUSED/STOPPED/READY.
        if (!sent && blockDebugSessionRef.current.sessionId === current.sessionId
            && blockDebugSessionRef.current.pendingCommand === command && debugMinimumSequenceRef.current === sequence) {
            if (debugCommandTimerRef.current) clearTimeout(debugCommandTimerRef.current);
            debugCommandTimerRef.current = null;
            updateBlockDebugSession({ ...blockDebugSessionRef.current, phase: 'unresponsive', pendingCommand: null });
        }
    }, [armDebugCommandTimeout, sendBlockDebugCommand, updateBlockDebugSession]);
    const handleDebugContinue = useCallback(() => handleDebugResume('CONTINUE'), [handleDebugResume]);
    const handleDebugStep = useCallback(() => handleDebugResume('STEP'), [handleDebugResume]);

    const handleStopBlockDebug = useCallback(async () => {
        const current = blockDebugSessionRef.current;
        if (!current.active || current.phase === 'stopping' || debugStopCommandInFlightRef.current) return;
        if (current.phase === 'compiling') { await cancelDebugBuildRef.current(); return; }

        debugStopCommandInFlightRef.current = true;
        const expectedSessionId = current.sessionId;
        const sequence = ++debugCommandSequenceRef.current;
        debugMinimumSequenceRef.current = sequence;
        clearInitialDebugAttachTimers();
        publishBlockTraceSnapshot(true);
        updateBlockDebugSession({ ...markBlockDebugSessionStopping(current, expectedSessionId), pendingCommand: null });
        armDebugCommandTimeout(expectedSessionId, sequence);
        try {
            const sent = await sendBlockDebugCommand('STOP', sequence);
            if (!sent && blockDebugSessionRef.current.active && blockDebugSessionRef.current.sessionId === expectedSessionId
                && debugMinimumSequenceRef.current === sequence) updateBlockDebugSession({ ...blockDebugSessionRef.current, phase: 'unresponsive' });
        } finally {
            debugStopCommandInFlightRef.current = false;
        }
    }, [armDebugCommandTimeout, clearInitialDebugAttachTimers, publishBlockTraceSnapshot, sendBlockDebugCommand, updateBlockDebugSession]);

    const handleAbandonBlockDebug = useCallback(() => {
        if (blockDebugSessionRef.current.phase !== 'unresponsive') return;
        finishBlockDebugSession(false);
        const notice = '仅退出桌面会话：设备尚未确认停止，板上仍是调试/轨迹固件；请普通上传或复位设备。';
        setDebugRecoveryNotice(notice);
        serialMonitorRef.current?.write(`\r\n[调试] ${notice}\r\n`);
    }, [finishBlockDebugSession]);

    const handleDebugFrame = useCallback((frame: CkDebugFrame) => {
        const current = blockDebugSessionRef.current;
        if (!current.active || frame.sessionId !== current.sessionId) return;
        if ((frame.kind === 'paused' || frame.kind === 'resumed' || frame.kind === 'stopped' || frame.kind === 'attached')
            && (frame.sequence ?? 0) < debugMinimumSequenceRef.current) return;

        if (frame.kind === 'trace') {
            if (blockRunModeRef.current !== 'trace' || current.phase === 'stopping') return;
            const blockId = traceIndexToBlockIdRef.current.get(frame.traceIndex);
            const aggregator = traceAggregatorRef.current;
            if (!blockId || !aggregator) return;
            const accepted = aggregator.ingest({
                blockId,
                deviceMicros: frame.deviceMicros,
                firstHit: frame.firstHit,
            });
            if (accepted) publishBlockTraceSnapshot(frame.firstHit);
            return;
        }

        if (frame.kind === 'stopped') {
            finishBlockDebugSession(current.phase === 'stopping');
            return;
        }
        // Once STOP has been accepted, late PAUSED/RESUMED frames must not move
        // the UI out of the acknowledgement-waiting state.
        if (current.phase === 'stopping') return;

        if (frame.kind === 'paused') {
            if (blockRunModeRef.current !== 'breakpoint') return;
            debugHasAttachedRef.current = true;
            clearInitialDebugAttachTimers();
            const blockId = debugTokenToBlockIdRef.current.get(frame.blockToken);
            const workspace = workspaceRef.current;
            const block = blockId ? workspace?.getBlockById(blockId) : null;
            if (!workspace || !block || !blockId) return;
            if (debugCommandTimerRef.current) clearTimeout(debugCommandTimerRef.current);
            debugCommandTimerRef.current = null;
            if (current.phase === 'paused' && current.pausedBlockId === blockId && !current.pendingCommand) return;

            workspace.highlightBlock(null);
            workspace.highlightBlock(blockId);
            revealWorkspaceBlock(blockId);
            refreshDebugVisuals(blockId);
            updateBlockDebugSession({
                ...current,
                phase: 'paused',
                pausedBlockId: blockId,
                pausedBlockLabel: block.toString(60),
                pendingCommand: null,
            });
            setConsoleOpen(true);
            setConsoleTab('serial');
            return;
        }

        if (frame.kind === 'ready') {
            if (debugCommandTimerRef.current) clearTimeout(debugCommandTimerRef.current);
            debugCommandTimerRef.current = null;
            debugMinimumSequenceRef.current = 0;
            debugHasAttachedRef.current = false;
            clearDebugHighlight();
            if (blockRunModeRef.current === 'trace') {
                // READY repeats during one startup handshake. Count one new run
                // after a live run, not one run for every retry announcement.
                if (current.phase !== 'connecting' && current.phase !== 'compiling') traceAggregatorRef.current?.resetRun();
                publishBlockTraceSnapshot(true);
            }
            const connectingSession = markBlockDebugSessionConnecting(current);
            if (connectingSession !== current) {
                updateBlockDebugSession(connectingSession);
            }
            void attachCurrentBlockDebugSession();
            return;
        }

        if (frame.kind === 'attached') {
            // Legacy ATTACHED without execution state is only transport proof.
            // A fresh PAUSED or an explicit RUNNING status is still required.
            if (!frame.state) return;
            debugHasAttachedRef.current = true;
            clearInitialDebugAttachTimers();
            const wasAwaitingAttach = current.phase === 'compiling' || current.phase === 'connecting';
            if (debugCommandTimerRef.current) clearTimeout(debugCommandTimerRef.current);
            debugCommandTimerRef.current = null;
            if (blockRunModeRef.current === 'trace') {
                if (frame.state !== 'running') return;
                traceAggregatorRef.current?.resetTiming();
                updateBlockDebugSession({
                    ...current,
                    phase: 'running',
                    pausedBlockId: null,
                    pausedBlockLabel: '',
                    pendingCommand: null,
                });
                publishBlockTraceSnapshot(true);
                if (wasAwaitingAttach) {
                    serialMonitorRef.current?.write('\r\n[轨迹] 已附加轨迹固件，正在非暂停采样。\r\n');
                    showToast('运行轨迹已连接，程序继续运行并采样积木路径', 'success');
                }
                return;
            }
            const pausedBlockId = frame.state === 'paused' && frame.blockToken
                ? debugTokenToBlockIdRef.current.get(frame.blockToken) || null : null;
            const workspace = workspaceRef.current;
            if (frame.state === 'paused' && (!pausedBlockId || !workspace?.getBlockById(pausedBlockId))) return;
            if (pausedBlockId && workspace?.getBlockById(pausedBlockId)) {
                workspace.highlightBlock(null);
                workspace.highlightBlock(pausedBlockId);
                refreshDebugVisuals(pausedBlockId);
                revealWorkspaceBlock(pausedBlockId);
            } else {
                clearDebugHighlight();
            }
            updateBlockDebugSession({
                ...current,
                phase: pausedBlockId ? 'paused' : 'running',
                pausedBlockId: pausedBlockId || null,
                pausedBlockLabel: pausedBlockId ? workspace?.getBlockById(pausedBlockId)?.toString(60) || '' : '',
                pendingCommand: null,
            });
            if (wasAwaitingAttach) {
                serialMonitorRef.current?.write('\r\n[调试] 已附加调试固件，断点现已生效。\r\n');
                showToast(
                    pausedBlockId ? '断点调试已重新连接，程序仍在断点暂停' : '断点调试已连接，程序正在运行',
                    'success',
                );
            }
            return;
        }

        if (frame.kind === 'resumed') {
            if (blockRunModeRef.current !== 'breakpoint') return;
            if (debugCommandTimerRef.current) clearTimeout(debugCommandTimerRef.current);
            debugCommandTimerRef.current = null;
            debugHasAttachedRef.current = true;
            clearInitialDebugAttachTimers();
            clearDebugHighlight();
            updateBlockDebugSession({
                ...current,
                phase: 'running',
                pausedBlockId: null,
                pausedBlockLabel: '',
                pendingCommand: null,
            });
            return;
        }

    }, [attachCurrentBlockDebugSession, clearDebugHighlight, clearInitialDebugAttachTimers, finishBlockDebugSession, publishBlockTraceSnapshot, refreshDebugVisuals, revealWorkspaceBlock, updateBlockDebugSession]);

    useEffect(() => {
        debugFrameHandlerRef.current = handleDebugFrame;
        return () => {
            debugFrameHandlerRef.current = () => undefined;
        };
    }, [handleDebugFrame]);

    useEffect(() => {
        generatedCodeRef.current = generatedCode;
        debuggableBlockIdsRef.current = extractInstrumentableBlockIds(generatedCode);
        refreshDebugVisuals(blockDebugSessionRef.current.pausedBlockId);
    }, [generatedCode, refreshDebugVisuals]);

    useEffect(() => {
        const workspace = workspaceRef.current;
        if (!workspace) return;
        refreshBlockTraceVisuals(
            workspace,
            blockRunMode === 'trace' ? blockTraceSnapshot : null,
        );
    }, [blockRunMode, blockTraceSnapshot]);

    useEffect(() => {
        breakpointIdsRef.current = breakpointIds;
        refreshDebugVisuals(blockDebugSession.pausedBlockId);
    }, [blockDebugSession.pausedBlockId, breakpointIds, refreshDebugVisuals]);

    useEffect(() => {
        const registry = Blockly.ContextMenuRegistry.registry;
        const menuId = 'ckBlockBreakpoint';
        try {
            if (registry.getItem(menuId)) registry.unregister(menuId);
            registry.register({
                id: menuId,
                scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
                weight: 0,
                displayText: (scope) => {
                    const block = scope.block;
                    if (!block) return '添加断点';
                    return hasBlockBreakpoint(block.workspace, block.id) ? '取消断点' : '添加断点';
                },
                preconditionFn: (scope) => {
                    const block = scope.block;
                    if (!block || block.workspace !== workspaceRef.current) return 'hidden';
                    if ((block as any).isInFlyout || block.isShadow() || !block.previousConnection) return 'hidden';
                    if (blockDebugSessionRef.current.active) return 'disabled';
                    return debuggableBlockIdsRef.current.has(block.id) ? 'enabled' : 'disabled';
                },
                callback: (scope) => {
                    const block = scope.block;
                    if (!block || block.workspace !== workspaceRef.current) return;
                    const enabled = toggleBlockBreakpoint(block.workspace, block.id);
                    refreshDebugVisuals(null);
                    showToast(enabled ? '已添加积木断点' : '已取消积木断点', 'info');
                },
            });
        } catch (error) {
            console.warn('Failed to register block breakpoint menu', error);
        }

        return () => {
            try {
                if (registry.getItem(menuId)) registry.unregister(menuId);
            } catch {
                // Registry may already have been reset during Blockly teardown.
            }
        };
    // showToast is stable for this component lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [refreshDebugVisuals]);

    const liveBreakpointIds = useMemo(() => {
        const workspace = workspaceRef.current;
        if (!workspace) return [] as string[];
        return Array.from(breakpointIds)
            .filter((blockId) => Boolean(workspace.getBlockById(blockId)))
            .sort();
    }, [breakpointIds, generatedCode]);

    const handleStartBlockDebug = async () => {
        const workspace = workspaceRef.current;
        if (!workspace || isCompilingRef.current) return;
        if (deviceHealthRunningRef.current) {
            showToast('请等待真机体检结束后再启动积木调试', 'info');
            return;
        }
        if (blockDebugSessionRef.current.active) {
            showToast('积木调试已经在运行', 'info');
            return;
        }
        if (!activePort) {
            showToast('积木调试需要先选择串口', 'error');
            return;
        }
        if (!/^(?:esp32:esp32:|esp8266:esp8266:|arduino:avr:)/i.test(effectiveCompileFqbn)) {
            showToast('积木断点当前支持 ESP32、ESP8266 与 Arduino AVR', 'error');
            return;
        }

        const breakpoints = new Set(
            Array.from(breakpointIdsRef.current)
                .filter((blockId) => Boolean(workspace.getBlockById(blockId))),
        );
        if (breakpoints.size === 0) {
            showToast('请先右键积木添加断点', 'error');
            return;
        }
        // Worker previews do not publish the compiler's global source map.
        generatedCodeRef.current = arduinoGenerator.workspaceToCode(workspace);

        const randomPart = Math.random().toString(36).slice(2, 9);
        const sessionId = `${Date.now().toString(36)}_${randomPart}`;
        let debugSketch;
        try {
            debugSketch = createDebugSketch(generatedCodeRef.current, breakpoints, sessionId);
        } catch (error) {
            showToast(String(error), 'error');
            return;
        }

        const usableBreakpoints = Array.from(breakpoints)
            .filter((blockId) => debugSketch.instrumentedBlockIds.has(blockId));
        if (usableBreakpoints.length === 0) {
            showToast('所选积木没有可安全插入的语句边界，暂不支持运行断点；普通上传不受影响', 'error');
            return;
        }
        if (debugSketch.missingBreakpointIds.length > 0) {
            showToast(`已跳过 ${debugSketch.missingBreakpointIds.length} 个没有安全插桩位置的断点`, 'info');
        }

        updateBlockRunMode('breakpoint');
        traceIndexToBlockIdRef.current = new Map();
        traceAggregatorRef.current = null;
        setBlockTraceSnapshot(null);
        if (workspaceRef.current) refreshBlockTraceVisuals(workspaceRef.current, null);
        debugTokenToBlockIdRef.current = debugSketch.tokenToBlockId;
        debugStreamParserRef.current.reset();
        debugHasAttachedRef.current = false;
        clearInitialDebugAttachTimers();
        updateBlockDebugSession({
            active: true,
            sessionId,
            phase: 'compiling',
            pausedBlockId: null,
            pausedBlockLabel: '',
        });
        setConsoleOpen(true);
        setConsoleTab('compile');

        const succeeded = await handleCompileAndUpload(true, {
            codeOverride: debugSketch.code,
            ensureSerialMonitor: true,
            serialBaudRate: debugSketch.baudRate,
            uploadMode: 'debug',
        });
        if (blockDebugSessionRef.current.sessionId !== sessionId) return;
        if (!succeeded) {
            finishBlockDebugSession(false);
            return;
        }
        startInitialDebugAttachTimeout(sessionId);
        if (monitorPortRef.current !== activePort || monitorBaudRateRef.current !== debugSketch.baudRate) {
            desiredSerialOpenRef.current = true;
            baudRateRef.current = debugSketch.baudRate;
            updateBlockDebugSession((previous) => markBlockDebugSessionConnecting(previous));
            scheduleSerialReconnect('调试固件上传后串口尚未就绪', activePort, debugSketch.baudRate);
            setConsoleOpen(true);
            setConsoleTab('serial');
            showToast('调试固件已上传，正在自动连接调试串口', 'info');
            return;
        }

        setConsoleOpen(true);
        setConsoleTab('serial');
        const currentSession = blockDebugSessionRef.current;
        if (currentSession.phase === 'running' || currentSession.phase === 'paused') return;

        updateBlockDebugSession((previous) => markBlockDebugSessionConnecting(previous));
        void attachCurrentBlockDebugSession();
        showToast('调试固件已上传，正在附加断点调试会话', 'info');
    };

    const handleStartBlockTrace = async () => {
        const workspace = workspaceRef.current;
        if (!workspace || isCompilingRef.current) return;
        generatedCodeRef.current = arduinoGenerator.workspaceToCode(workspace);
        if (deviceHealthRunningRef.current) {
            showToast('请等待真机体检结束后再启动运行轨迹', 'info');
            return;
        }
        if (blockDebugSessionRef.current.active) {
            showToast('已有积木调试或运行轨迹会话正在进行', 'info');
            return;
        }
        if (!activePort) {
            showToast('运行轨迹需要先选择串口', 'error');
            return;
        }
        if (!/^(?:esp32:esp32:|esp8266:esp8266:|arduino:avr:)/i.test(effectiveCompileFqbn)) {
            showToast('运行轨迹当前支持 ESP32、ESP8266 与 Arduino AVR', 'error');
            return;
        }

        const randomPart = Math.random().toString(36).slice(2, 9);
        const sessionId = `${Date.now().toString(36)}_${randomPart}`;
        let traceSketch;
        try {
            traceSketch = createTraceSketch(generatedCodeRef.current, sessionId);
        } catch (error) {
            showToast(String(error), 'error');
            return;
        }

        const trackedBlocks = Array.from(traceSketch.traceIndexToBlockId.entries())
            .map(([, blockId]) => {
                const block = workspace.getBlockById(blockId);
                return block ? { blockId, label: block.toString(60) } : null;
            })
            .filter((item): item is { blockId: string; label: string } => Boolean(item));
        if (trackedBlocks.length === 0) {
            showToast('当前工程没有可执行、可采样的积木', 'error');
            return;
        }
        if (traceSketch.omittedTraceBlockIds.length > 0) {
            showToast(`轨迹固件上限为 ${traceSketch.traceLimits.maxTrackedBlocks} 个积木，已跳过 ${traceSketch.omittedTraceBlockIds.length} 个`, 'info');
        }

        if (traceSketch.unsupportedBlockIds.length > 0) showToast(`有 ${traceSketch.unsupportedBlockIds.length} 个积木没有安全插桩位置，已从轨迹中排除并记录`, 'info');
        const aggregator = new BlockTraceAggregator(trackedBlocks, {
            maxTrackedBlocks: traceSketch.traceLimits.maxTrackedBlocks,
            omittedTrackedBlockCount: traceSketch.omittedTraceBlockIds.length + traceSketch.unsupportedBlockIds.length,
        });
        const initialSnapshot = aggregator.snapshot();
        updateBlockRunMode('trace');
        debugTokenToBlockIdRef.current = traceSketch.tokenToBlockId;
        traceIndexToBlockIdRef.current = traceSketch.traceIndexToBlockId;
        traceAggregatorRef.current = aggregator;
        setBlockTraceFirmwareFps(traceSketch.traceLimits.maxFramesPerSecond);
        setBlockTraceSnapshot(initialSnapshot);
        refreshBlockTraceVisuals(workspace, initialSnapshot);
        debugStreamParserRef.current.reset();
        debugHasAttachedRef.current = false;
        clearInitialDebugAttachTimers();
        updateBlockDebugSession({
            active: true,
            sessionId,
            phase: 'compiling',
            pausedBlockId: null,
            pausedBlockLabel: '',
        });
        setConsoleOpen(true);
        setConsoleTab('compile');

        const succeeded = await handleCompileAndUpload(true, {
            codeOverride: traceSketch.code,
            ensureSerialMonitor: true,
            serialBaudRate: traceSketch.baudRate,
            uploadMode: 'trace',
        });
        if (blockDebugSessionRef.current.sessionId !== sessionId) return;
        if (!succeeded) {
            finishBlockDebugSession(false);
            return;
        }
        startInitialDebugAttachTimeout(sessionId);
        if (monitorPortRef.current !== activePort || monitorBaudRateRef.current !== traceSketch.baudRate) {
            desiredSerialOpenRef.current = true;
            baudRateRef.current = traceSketch.baudRate;
            updateBlockDebugSession((previous) => markBlockDebugSessionConnecting(previous));
            scheduleSerialReconnect('轨迹固件上传后串口尚未就绪', activePort, traceSketch.baudRate);
            setConsoleOpen(true);
            setConsoleTab('serial');
            showToast('轨迹固件已上传，正在自动连接轨迹串口', 'info');
            return;
        }

        setConsoleOpen(true);
        setConsoleTab('serial');
        const currentSession = blockDebugSessionRef.current;
        if (currentSession.phase === 'running') return;

        updateBlockDebugSession((previous) => markBlockDebugSessionConnecting(previous));
        void attachCurrentBlockDebugSession();
        showToast('轨迹固件已上传，正在附加非暂停运行轨迹', 'info');
    };

    // Warm the exact generated sketch after project hydration and after real
    // edits settle. The backend v2 evidence gate can immediately skip a repeated
    // remount when source/FQBN/Core/dependencies already match, so the frontend
    // must not trade first-compile latency for a local hydration shortcut.
    // Busy foreground builds retain the latest request and retry after becoming
    // idle; a burst of edits replaces the pending request with the newest code.
    useEffect(() => {
        const scheduler = silentPrecompileSchedulerRef.current;
        if (!scheduler) return;
        const code = String(generatedCode || '');
        const board = String(effectiveCompileFqbn || '').trim();
        if (projectLoadedRevision <= 0
            || boardOptionsStatus === 'loading'
            || boardOptionsStatus === 'unverified'
            || activeBoardPackageId !== baseBoardFqbn(activeBoard)
            || !board
            || !code.trim()
            || code.includes('Generating code')) {
            scheduler.cancelPending();
            return;
        }
        if (!extensionsReady
            || extensionsLoadedBoard !== activeBoard
            || extensionsLoadedBoardPackageId !== activeBoardPackageId) {
            scheduler.cancelPending();
            return;
        }

        const includeSig = computeIncludeSignature(code);
        const codeFingerprint = computeCodeFingerprint(code);
        scheduler.schedule(createSilentPrecompileRequest(
            board,
            extensionsReloadSeq,
            includeSig,
            codeFingerprint,
            code,
        ));
    }, [activeBoard, activeBoardPackageId, boardOptionsStatus, computeCodeFingerprint, computeIncludeSignature, effectiveCompileFqbn, extensionsLoadedBoard, extensionsLoadedBoardPackageId, extensionsReady, extensionsReloadSeq, generatedCode, projectLoadedRevision]);

    const buildCkFunctionFlyout = useCallback(() => {
        return CK_FUNCTION_FLYOUT_BLOCK_TYPES
            .filter((type) => isKnownBlockType(type))
            .map((type) => ({ kind: 'block', type }));
    }, []);

    const buildLibraryExtensionInfos = useCallback((libs: any[], blockLocale?: string): LibraryBackedExtensionInfo[] => {
        // Use backend-provided has_blocks/has_toolbox/has_generator fields
        // instead of doing expensive IPC exists() probing per library.
        const results: LibraryBackedExtensionInfo[] = [];
        for (const lib of libs) {
            // Fast path: use pre-computed flags from backend. Plain Arduino
            // C/C++ libraries do not need a Blockly runtime certificate.
            const hasBlocks = !!lib?.has_blocks;
            const hasToolbox = !!lib?.has_toolbox;
            const hasGenerator = !!lib?.has_generator;
            if (!hasBlocks || !hasToolbox || !libraryCanExecuteBlockRuntime(lib)) continue;

            const errors = Array.isArray(lib?.diagnostics)
                ? lib.diagnostics.filter((item: any) => item?.severity === 'error')
                : [];
            const qualityReport = lib?.quality_report || lib?.qualityReport;
            const qualityStatus = String(qualityReport?.status || '');
            const libraryId = String(lib?.id || '').trim();
            const runtimeCertified = ['passed', 'passed_with_warnings'].includes(qualityStatus)
                && String(qualityReport?.package_kind || qualityReport?.packageKind || '') === 'block-library'
                && String(qualityReport?.package_id || qualityReport?.packageId || '') === libraryId
                && Array.isArray(qualityReport?.validated_consumers || qualityReport?.validatedConsumers)
                && (qualityReport.validated_consumers || qualityReport.validatedConsumers).includes('runtime-loader');
            if (!runtimeCertified || errors.length > 0) {
                console.warn(`[Workspace] Rejected untrusted block runtime for ${String(lib?.id || lib?.name || 'unknown')}:`, {
                    qualityStatus,
                    runtimeCertified,
                    errors,
                });
                continue;
            }
            const dirPathRaw = String(lib?.path || '').trim();
            if (!dirPathRaw) continue;
            const dirPath = dirPathRaw.replace(/\\/g, '/').replace(/\/+$/g, '');
            if (!dirPath) continue;

            const rawId = String(lib?.manifest?.id || lib?.id || lib?.name || '').trim();
            if (!rawId) continue;
            const version = String(lib?.version || lib?.manifest?.version || '').trim();
            const contentSha256 = runtimeContentHashKey(lib);
            if (!version || !/^[a-f0-9]{64}$/.test(contentSha256)) continue;
            const rawEntryKey = String(lib?.entry_key || lib?.path || rawId).trim();
            const extSuffix = rawEntryKey.replace(/[^A-Za-z0-9_-]+/g, '_');
            const extId = `lib_${extSuffix}`;
            const entrypoints = lib?.block_entrypoints || {};
            results.push({
                id: extId,
                name: String(lib?.name || rawId),
                dir_path: dirPath,
                has_generator: hasGenerator,
                blocks_path: typeof entrypoints.blocks === 'string' ? entrypoints.blocks : undefined,
                generator_path: typeof entrypoints.generator === 'string' ? entrypoints.generator : undefined,
                toolbox_path: typeof entrypoints.toolbox === 'string' ? entrypoints.toolbox : undefined,
                runtime_content_sha256: contentSha256,
                block_package_manifest: lib?.block_manifest || lib?.manifest,
                block_locale_bundle: lib?.block_locale_bundle,
                block_locale: blockLocale,
                blockPackageInventory: {
                    packageId: libraryId,
                    version,
                    contentSha256,
                    packagePath: dirPathRaw,
                },
            });

        }
        return results;
    }, []);

    const loadExtensionsForBoard = useCallback(async (
        boardFqbn: string,
        boardPackageId: string,
        allowPackageScopedExtensions: boolean,
        isCustomBoardPackage: boolean,
    ) => {
        const seq = extensionLoadSeqRef.current + 1;
        extensionLoadSeqRef.current = seq;
        // Until the new board extension set is ready, do not refresh package
        // presentation against the previous board during a locale switch.
        activeExtensionLocaleEntriesRef.current = [];
        allowedExtensionRuntimeIdsRef.current = new Set();
        enabledBlockPackageInventoryRef.current = [];
        enabledBlockPackageInventoryErrorRef.current = '已启用积木包清单正在刷新';
        // Only set extensionsReady=false on initial load (seq===1).
        // Subsequent reloads (library import/delete) must NOT toggle this flag,
        // because the Load Project effect depends on extensionsReady and would
        // re-clear + reload the workspace, destroying unsaved user work.
        const isInitialLoad = seq === 1;
        if (isInitialLoad) setExtensionsReady(false);
        setToolboxLoading(true);

        let mergedToolboxXml = '';
        let nextBlockPackageInventory: EnabledBlockPackageInventoryEntry[] = [];
        let nextBlockPackageInventoryError: string | null = null;
        try {
            // Phase 1: Fetch libraries + extension lists in ONE parallel batch.
            // Previously libraries were fetched in HardwareContext (separate
            // effect), causing a double-fire: once with stale data when
            // activeBoard changed, then again when availableLibraries updated.
            // Now we fetch libraries directly here, eliminating the extra
            // render cycle and ~200-500ms of wasted IPC latency.
            const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
            const [libs, boardBackendExts] = await Promise.all([
                tauriInvoke('get_all_libraries', {
                    board: boardFqbn,
                    boardPackageId: allowPackageScopedExtensions ? boardPackageId : null,
                }) as Promise<any[]>,
                getAvailableExtensions(boardFqbn),
            ]);
            if (extensionLoadSeqRef.current !== seq) return;
            const hydratedLibraries = await hydrateBlockPackageLocales(libs || []);
            if (extensionLoadSeqRef.current !== seq) return;
            blockCatalogLibrariesRef.current = hydratedLibraries;
            // Resolve the locale from the ref so this async board-load path
            // never captures a stale render's language preference.  Locale is
            // presentation-only; the extension runtime key and package
            // inventory remain unchanged.
            const libraryExts = buildLibraryExtensionInfos(hydratedLibraries, blocklyLocaleRef.current);
            const getExtensionRuntimeKey = (ext: ExtensionInfo) => {
                const normalizedDir = String(ext.dir_path || '')
                    .replace(/\\/g, '/')
                    .replace(/\/+$/g, '')
                    .toLowerCase();
                return normalizedDir
                    ? `path::${normalizedDir}::${String(ext.runtime_content_sha256 || 'legacy')}`
                    : `id::${String(ext.id || '').trim().toLowerCase()}`;
            };
            const extensionByKey = new Map<string, ExtensionInfo>();
            for (const ext of [...boardBackendExts, ...libraryExts]) {
                const key = getExtensionRuntimeKey(ext);
                if (!extensionByKey.has(key)) extensionByKey.set(key, ext);
            }
            const boardExts: ExtensionInfo[] = Array.from(extensionByKey.values());
            allowedExtensionRuntimeIdsRef.current = new Set(
                boardExts.map(ext => String(ext.id || '').trim()).filter(Boolean),
            );
            const extensionVisualColours = assignExtensionVisualColours(
                boardExts.map((ext) => getExtensionRuntimeKey(ext)),
            );
            const newExts = boardExts.filter(ext => !registeredExtensionIdsRef.current.has(getExtensionRuntimeKey(ext)));

            // Phase 2: Pre-read all extension files (block.json, generator.js,
            // toolbox.json) in parallel. This eliminates sequential IPC round-
            // trips that were the main bottleneck — one parallel batch instead
            // of N×3 serial reads.
            const allToPrefetch = [...newExts, ...boardExts];
            if (allToPrefetch.length > 0) {
                await prefetchExtensionFiles(allToPrefetch);
            }

            // Phase 3: Register blocks/generators sequentially (mutates global
            // Blockly state, must be serial — but now instant since files are
            // pre-cached in memory).
            for (const ext of newExts) {
                try {
                    const runtimeKey = getExtensionRuntimeKey(ext);
                    await registerExtensionBlocks(
                        ext,
                        Blockly as any,
                        extensionVisualColours.get(runtimeKey),
                        {
                            fqbn: boardFqbn,
                            packageId: boardPackageId,
                            isCustom: isCustomBoardPackage,
                        },
                    );
                    if (ext.has_generator) {
                        await registerExtensionGenerator(ext, Blockly as any);
                    }
                    registeredExtensionIdsRef.current.add(getExtensionRuntimeKey(ext));
                } catch (e) {
                    console.warn(`[Workspace] Failed to register extension runtime: ${ext.id}`, e);
                }
            }

            // A newer board/library load may have superseded this async run
            // while registration was in progress. Do not publish stale
            // entries for a later locale transition.
            if (extensionLoadSeqRef.current !== seq) return;

            // Keep only definitions that completed registration. Locale
            // refreshes must not retry a failed/unloaded extension and must
            // never mix an older board's package set into the current board.
            activeExtensionLocaleEntriesRef.current = boardExts
                .filter((extension) => registeredExtensionIdsRef.current.has(getExtensionRuntimeKey(extension)))
                .map((extension) => ({
                    extension,
                    visualColour: extensionVisualColours.get(getExtensionRuntimeKey(extension)),
                    boardIdentity: {
                        fqbn: boardFqbn,
                        packageId: boardPackageId,
                        isCustom: isCustomBoardPackage,
                    },
                }));

            // Phase 4: Build toolbox XML in parallel (reads already cached)
            const toolboxParts = await Promise.all(
                boardExts.map(async (ext) => {
                    const runtimeKey = getExtensionRuntimeKey(ext);
                    try {
                        const visualColour = extensionVisualColours.get(runtimeKey);
                        const toolboxPayload = await fetchExtensionToolbox(ext, visualColour);
                        registerToolboxBlockVisualColours(toolboxPayload, visualColour);
                        return {
                            runtimeKey,
                            xml: toolboxPayload ? jsonCategoryToXml(toolboxPayload, visualColour) : '',
                        };
                    } catch (e) {
                        console.warn(`[Workspace] Failed to load extension toolbox: ${ext.id}`, e);
                        return { runtimeKey, xml: '' };
                    }
                })
            );
            mergedToolboxXml = [...new Set(toolboxParts.map(item => item.xml).filter(Boolean))].join('');
            const enabledRuntimeKeys = new Set(
                toolboxParts
                    .filter(item => item.xml && registeredExtensionIdsRef.current.has(item.runtimeKey))
                    .map(item => item.runtimeKey),
            );
            const inventoryByPackageId = new Map<string, EnabledBlockPackageInventoryEntry>();
            for (const ext of libraryExts) {
                if (!enabledRuntimeKeys.has(getExtensionRuntimeKey(ext))) continue;
                const entry = ext.blockPackageInventory;
                const previous = inventoryByPackageId.get(entry.packageId);
                if (previous
                    && (previous.version !== entry.version
                        || previous.contentSha256 !== entry.contentSha256
                        || previous.packagePath !== entry.packagePath)) {
                    throw new Error(`已启用积木包 ${entry.packageId} 存在冲突的版本或内容，已停止建立工程证据`);
                }
                inventoryByPackageId.set(entry.packageId, entry);
            }
            nextBlockPackageInventory = Array.from(inventoryByPackageId.values())
                .sort((left, right) => left.packageId.localeCompare(right.packageId));
        } catch (e) {
            console.error('[Workspace] Failed to preload extensions', e);
            nextBlockPackageInventoryError = `无法验证已启用积木包清单：${String(e)}`;
        }

        if (extensionLoadSeqRef.current !== seq) return;
        enabledBlockPackageInventoryRef.current = nextBlockPackageInventory;
        enabledBlockPackageInventoryErrorRef.current = nextBlockPackageInventoryError;
        setExtensionXml(mergedToolboxXml);
        setExtensionsLoadedBoard(boardFqbn);
        setExtensionsLoadedBoardPackageId(boardPackageId);
        setExtensionsReady(true);
        setToolboxLoading(false);
    }, [buildLibraryExtensionInfos]);

    useEffect(() => {
        if (!activeBoard) return;
        void loadExtensionsForBoard(
            activeBoard,
            activeBoardPackageId,
            activeBoardPackageBuildGate.canBuild,
            activeBoardPackage?.is_custom === true,
        );
    }, [activeBoard, activeBoardPackage, activeBoardPackageBuildGate.canBuild, activeBoardPackageId, loadExtensionsForBoard, extensionsReloadSeq]);

    useEffect(() => {
        if (!activeBoard
            || extensionsLoadedBoard !== activeBoard
            || extensionsLoadedBoardPackageId !== activeBoardPackageId) return;
        const labelWorkspace = new Blockly.Workspace();
        const eventsWereEnabled = Blockly.Events.isEnabled();
        if (eventsWereEnabled) Blockly.Events.disable();
        try {
            const resolveDisplayName = (blockType: string): string | undefined => {
                let block: Blockly.Block | null = null;
                try {
                    block = labelWorkspace.newBlock(blockType);
                    const text = block.toString(160, '').replace(/\s+/g, ' ').trim();
                    return text && text !== blockType ? text : undefined;
                } catch {
                    return undefined;
                } finally {
                    try { block?.dispose(false); } catch { }
                }
            };
            const catalog = buildBlockCatalog(
                activeBoard,
                getToolbox(activeBoard, extensionXml, activeCoreVersion),
                blockCatalogLibrariesRef.current,
                resolveDisplayName,
                effectiveBlocklyLocale,
            );
            window.CK_BLOCK_CATALOG = catalog;
            window.dispatchEvent(new CustomEvent('ck-block-catalog-updated', { detail: catalog }));
        } finally {
            try { labelWorkspace.dispose(); } catch { }
            if (eventsWereEnabled) Blockly.Events.enable();
        }
    }, [activeBoard, activeBoardPackageId, activeCoreVersion, effectiveBlocklyLocale, extensionXml, extensionsLoadedBoard, extensionsLoadedBoardPackageId]);

    const syncLoadedExtensionBlockColours = useCallback((workspace: Blockly.WorkspaceSvg) => {
        const workspaces = new Set<any>([workspace]);
        const flyoutWorkspace = (workspace.getToolbox?.()?.getFlyout?.() as any)?.getWorkspace?.() ||
            (workspace.getFlyout?.() as any)?.getWorkspace?.();
        if (flyoutWorkspace) workspaces.add(flyoutWorkspace);

        // Blockly owns flyout workspaces separately from the main workspace.
        // Depending on the renderer lifecycle, getFlyout() can briefly return
        // no workspace while the newly selected category is being rendered.
        const registeredWorkspaces = (Blockly.Workspace as any)?.getAll?.() ||
            (Blockly as any)?.common?.getAllWorkspaces?.() || [];
        registeredWorkspaces.forEach((registered: any) => workspaces.add(registered));

        for (const target of workspaces) {
            const blocks = target?.getAllBlocks?.(false) || [];
            blocks.forEach((block: any) => {
                const visualColour = extensionBlockColours.get(String(block?.type || ''));
                if (visualColour) {
                    const currentColour = String(block?.getColour?.() || '').toLowerCase();
                    if (currentColour !== visualColour.toLowerCase()) {
                        try { block?.setColour?.(visualColour); } catch { }
                    }
                    return;
                }
                syncExtensionBlockVisualColour(block);
            });
        }
        // Theme blockStyles do not reach CK blocks that use numeric setColour()
        // calls. Paint immediately before the browser can expose the raw colour,
        // then retain a next-frame pass for deferred flyout renderer work.
        repaintBlocklyVisualSkin(workspace);
    }, [extensionBlockColours, repaintBlocklyVisualSkin]);

    const searchBlockCatalog = useCallback((rawQuery: string): BlockSearchEntry[] => {
        const entries = window.CK_BLOCK_CATALOG?.blocks || [];
        return searchBlockDockEntries(entries, {
            query: rawQuery,
            locale: effectiveBlocklyLocale,
            limit: 60,
        });
    }, [effectiveBlocklyLocale]);

    const runGlobalBlockSearch = useCallback((rawQuery: string) => {
        const workspace = workspaceRef.current;
        if (!workspace) return;
        const toolbox = workspace.getToolbox?.();
        const flyout = toolbox?.getFlyout?.() || workspace.getFlyout?.();
        const query = rawQuery.trim();

        if (!query) {
            flyout?.hide();
            workspace.getInjectionDiv?.()?.classList.remove('ck-block-search-active');
            setBlockSearchResultCount(null);
            return;
        }

        const results = searchBlockCatalog(query);
        const flyoutItems = results.flatMap((entry) => {
            let blockXml: Element | undefined;
            if (entry.xml_template) {
                try {
                    const parsed = Blockly.utils.xml.textToDom(entry.xml_template);
                    if (parsed.tagName.toLowerCase() === 'block') blockXml = parsed;
                } catch {
                    blockXml = undefined;
                }
            }
            const sourceLabel = entry.category
                ? entry.category
                    .split('/')
                    .map(part => getBlocklyCategoryLabel(part.trim(), effectiveBlocklyLocale))
                    .join(' / ')
                : String(entry.library_id || getBlocklySourceLabel('all', effectiveBlocklyLocale)).trim();
            return [
                {
                    kind: 'label',
                    text: editorTranslate('blockDock.blockSearch.source', { source: sourceLabel }),
                    'web-class': 'ck-search-source-label',
                },
                {
                    kind: 'block',
                    type: entry.type,
                    gap: 18,
                    ...(blockXml ? { blockxml: blockXml } : {}),
                },
            ];
        });

        toolbox?.clearSelection?.();
        const injectionDiv = workspace.getInjectionDiv?.();
        injectionDiv?.querySelectorAll(`.${TOOLBOX_SELECTED_CLASS}`).forEach((element) => {
            element.classList.remove(TOOLBOX_SELECTED_CLASS);
        });
        injectionDiv?.classList.add('ck-block-search-active');
        flyout?.show(results.length > 0
            ? flyoutItems as any
            : [{ kind: 'label', text: editorTranslate('blockDock.blockSearch.noResults') }] as any);
        flyout?.scrollToStart?.();
        setBlockSearchResultCount(results.length);
        requestAnimationFrame(() => {
            syncLoadedExtensionBlockColours(workspace);
            Blockly.svgResize(workspace);
        });
    }, [editorTranslate, effectiveBlocklyLocale, searchBlockCatalog, syncLoadedExtensionBlockColours]);

    useEffect(() => {
        if (!isBlockSearchActive) return;
        const timer = window.setTimeout(() => runGlobalBlockSearch(blockSearchQuery), 60);
        return () => window.clearTimeout(timer);
    }, [blockSearchQuery, isBlockSearchActive, runGlobalBlockSearch]);

    useEffect(() => {
        const refreshSearch = () => {
            if (isBlockSearchActive && blockSearchQuery.trim()) {
                runGlobalBlockSearch(blockSearchQuery);
            }
        };
        window.addEventListener('ck-block-catalog-updated', refreshSearch);
        return () => window.removeEventListener('ck-block-catalog-updated', refreshSearch);
    }, [blockSearchQuery, isBlockSearchActive, runGlobalBlockSearch]);

    const registerToolboxCallbacks = useCallback((ws: Blockly.WorkspaceSvg) => {
        try {
            ws.registerToolboxCategoryCallback('CK_FUNCTIONS', () => buildCkFunctionFlyout() as any);
        } catch (e) {
            console.warn('[Workspace] Failed to register toolbox callbacks', e);
        }
        // Patch the workspace so that registerToolboxCategoryCallback silently replaces
        // an existing callback instead of throwing. This allows:
        //  1. CK to pre-register empty fallbacks for custom categories (prevents crashes on click)
        //  2. Library blocks.js (e.g. Maker_Arduino) to later override with real callbacks
        //     without its setInterval throwing and failing silently.
        const wsAny = ws as any;
        if (!wsAny.__ckToolboxCallbackPatchApplied && typeof wsAny.registerToolboxCategoryCallback === 'function') {
            const orig = wsAny.registerToolboxCategoryCallback.bind(ws);
            wsAny.registerToolboxCategoryCallback = function (name: string, callback: Function) {
                try {
                    orig(name, callback);
                } catch (err: any) {
                    const msg = String(err?.message || err || '').toLowerCase();
                    if (msg.includes('already registered') || msg.includes('callback')) {
                        try {
                            if (typeof wsAny.removeToolboxCategoryCallback === 'function') {
                                wsAny.removeToolboxCategoryCallback(name);
                            } else if (wsAny.toolboxCategoryCallbacks_ && typeof wsAny.toolboxCategoryCallbacks_ === 'object') {
                                delete wsAny.toolboxCategoryCallbacks_[name];
                            }
                            orig(name, callback);
                        } catch {
                            // If still failing, ignore — the callback is likely already set.
                        }
                    } else {
                        throw err;
                    }
                }
            };
            wsAny.__ckToolboxCallbackPatchApplied = true;
        }
        // Pre-register empty fallback callbacks for any custom toolbox categories from
        // extension XML (e.g. Maker_Arduino's CONST_VARIATE, GLOBAL_VARIATE, etc.).
        // This prevents "Couldn't find a callback function" crashes when the user clicks
        // a category before the library's blocks.js setInterval registration fires.
        // The patched registerToolboxCategoryCallback above allows blocks.js to replace
        // these no-ops with real callbacks without throwing.
        if (extensionXml) {
            const customRe = /\bcustom=["']([^"']+)["']/g;
            let m: RegExpExecArray | null;
            while ((m = customRe.exec(extensionXml)) !== null) {
                const name = m[1];
                if (!name || name === 'CK_FUNCTIONS') continue;
                try {
                    ws.registerToolboxCategoryCallback(name, () => []);
                } catch {
                    // Ignore — already registered with a real callback.
                }
            }
        }
    }, [buildCkFunctionFlyout, extensionXml]);

    const syncToolboxSelectionClasses = useCallback((ws: Blockly.WorkspaceSvg) => {
        const injectionDiv = ws.getInjectionDiv?.();
        if (!injectionDiv) return;

        const styledNodes = injectionDiv.querySelectorAll(
            '.blocklyToolboxCategory, .blocklyToolboxCategoryContainer, .blocklyTreeRow, .blocklyTreeRowContentContainer'
        );
        styledNodes.forEach((node) => {
            node.classList.remove(TOOLBOX_SELECTED_CLASS);
        });

        const selectedNodes = injectionDiv.querySelectorAll(
            '.blocklyToolboxCategory[aria-selected="true"], ' +
            '.blocklyToolboxCategory.blocklyToolboxSelected, ' +
            '.blocklyToolboxCategoryContainer[aria-selected="true"], ' +
            '.blocklyToolboxCategoryContainer.blocklyToolboxSelected, ' +
            '.blocklyTreeRow[aria-selected="true"], ' +
            '.blocklyTreeRow.blocklyTreeSelected, ' +
            '.blocklyTreeRowContentContainer[aria-selected="true"], ' +
            '.blocklyTreeRowContentContainer.blocklyToolboxSelected'
        );

        selectedNodes.forEach((node) => {
            const element = node as Element;
            const category = element.matches('.blocklyToolboxCategory')
                ? element
                : element.closest('.blocklyToolboxCategory');
            const categoryContainer = element.matches('.blocklyToolboxCategoryContainer')
                ? element
                : element.closest('.blocklyToolboxCategoryContainer');
            const row = element.matches('.blocklyTreeRow')
                ? element
                : element.querySelector('.blocklyTreeRow');
            const rowContent = element.matches('.blocklyTreeRowContentContainer')
                ? element
                : (row?.querySelector('.blocklyTreeRowContentContainer') || element.querySelector('.blocklyTreeRowContentContainer'));

            const targets = [categoryContainer, category, row, rowContent].filter((target): target is Element => Boolean(target));
            targets.forEach((target) => {
                target.classList.add(TOOLBOX_SELECTED_CLASS);
            });
        });
    }, []);

    const applyToolboxCategoryClasses = useCallback((ws: Blockly.WorkspaceSvg) => {
        const injectionDiv = ws.getInjectionDiv?.();
        if (!injectionDiv) return;

        // First remove previous category marker classes to avoid cross-category style bleed.
        const allToolboxNodes = injectionDiv.querySelectorAll('.blocklyToolboxCategory, .blocklyToolboxCategoryContainer, .blocklyTreeRow, .blocklyTreeRowContentContainer');
        allToolboxNodes.forEach((node) => {
            TOOLBOX_CATEGORY_CLASSES.forEach((cls) => node.classList.remove(cls));
            if (node instanceof HTMLElement) {
                node.style.removeProperty('--ck-toolbox-accent');
            }
        });

        // Then add the class to the concrete row/content container so CSS can style
        // the selected category without bleeding into nested descendants.
        const labels = injectionDiv.querySelectorAll('.blocklyToolboxCategoryLabel, .blocklyTreeLabel');
        labels.forEach((label) => {
            const name = String(label.textContent || '').replace(/\s+/g, '');
            const className = TOOLBOX_CATEGORY_CLASS_BY_NAME[name];
            const targets = new Set<Element>();
            const labelElement = label as Element;
            const row = labelElement.closest('.blocklyTreeRow');
            const rowContent = labelElement.closest('.blocklyTreeRowContentContainer');
            const category = labelElement.closest('.blocklyToolboxCategory');
            const categoryContainer = labelElement.closest('.blocklyToolboxCategoryContainer');
            const categoryAccent = category instanceof HTMLElement
                ? category.style.borderLeftColor.trim()
                : '';
            if (row) targets.add(row);
            if (rowContent) targets.add(rowContent);
            if (category) targets.add(category);
            if (categoryContainer) targets.add(categoryContainer);
            targets.forEach((target) => {
                if (className) target.classList.add(className);
                if (categoryAccent && target instanceof HTMLElement) {
                    target.style.setProperty('--ck-toolbox-accent', categoryAccent);
                }
            });
        });
    }, []);

    const registerToolboxDomHooks = useCallback((ws: Blockly.WorkspaceSvg) => {
        const injectionDiv = ws.getInjectionDiv?.();
        if (!injectionDiv) return;

        const wsAny = ws as any;
        const toolboxRoot = injectionDiv.querySelector('.blocklyToolbox, .blocklyToolboxDiv');
        if (!toolboxRoot) return;
        toolboxRoot.classList.add('ck-blockly-toolbox-root');

        // Refresh this Blockly-owned listener whenever its React callbacks
        // change. Keeping the first listener forever captured the startup skin
        // and repainted every category gray after the 40/180 ms refresh.
        const previousRoot = wsAny.__ckToolboxDomRoot as Element | undefined;
        const previousHandler = wsAny.__ckToolboxDomRefreshHandler as EventListener | undefined;
        if (previousRoot && previousHandler) {
            previousRoot.removeEventListener('click', previousHandler, true);
            previousRoot.removeEventListener('pointerdown', previousHandler, true);
            previousRoot.removeEventListener('pointerup', previousHandler, true);
            previousRoot.removeEventListener('keydown', previousHandler, true);
        }

        const refresh = (event?: Event) => {
            const keyboardActivation = event instanceof KeyboardEvent &&
                (event.key === 'Enter' || event.key === ' ');
            if (event?.type === 'pointerdown' || keyboardActivation) {
                setBlockSearchQuery('');
                setBlockSearchResultCount(null);
                setIsBlockSearchActive(false);
                ws.getInjectionDiv?.()?.classList.remove('ck-block-search-active');
            }
            const refreshVisuals = () => {
                applyToolboxCategoryClasses(ws);
                syncToolboxSelectionClasses(ws);
                syncLoadedExtensionBlockColours(ws);
            };
            // Blockly commonly creates flyout SVG synchronously during the
            // remaining click handlers. A microtask paints it before the first
            // browser frame; the observer and one rAF cover deferred work.
            queueMicrotask(refreshVisuals);
            requestAnimationFrame(refreshVisuals);
        };

        // Blockly opens a category on pointerdown. Listening to pointerup/click
        // is already one visible frame too late and also duplicates every pass.
        toolboxRoot.addEventListener('pointerdown', refresh, true);
        toolboxRoot.addEventListener('keydown', refresh, true);

        wsAny.__ckToolboxDomHooksApplied = true;
        wsAny.__ckToolboxDomRoot = toolboxRoot;
        wsAny.__ckToolboxDomRefreshHandler = refresh;
    }, [applyToolboxCategoryClasses, syncLoadedExtensionBlockColours, syncToolboxSelectionClasses]);

    const refreshToolboxCategoryStyles = useCallback((ws: Blockly.WorkspaceSvg) => {
        registerToolboxCallbacks(ws);
        registerToolboxDomHooks(ws);
        requestAnimationFrame(() => {
            applyToolboxCategoryClasses(ws);
            syncToolboxSelectionClasses(ws);
            syncLoadedExtensionBlockColours(ws);
        });
        setTimeout(() => {
            applyToolboxCategoryClasses(ws);
            syncToolboxSelectionClasses(ws);
            syncLoadedExtensionBlockColours(ws);
        }, 80);
    }, [applyToolboxCategoryClasses, registerToolboxCallbacks, registerToolboxDomHooks, syncLoadedExtensionBlockColours, syncToolboxSelectionClasses]);

    // Blockly Injection — runs ONCE on mount.
    // Toolbox updates are handled separately by the "Dynamic Board Update" effect
    // via updateToolbox(). This effect must NOT depend on extensionXml / activeBoard,
    // otherwise the workspace gets disposed and re-created, destroying all user blocks.
    useEffect(() => {
        if (!blocklyDiv.current || workspaceRef.current) return;

        console.log("[Blockly] Injecting workspace...");

        // Ensure the first injection uses the persisted Blockly locale.  The
        // locale transition effect below handles subsequent changes through a
        // controlled reinjection, so this does not add the locale to the
        // injection effect dependencies (which would recreate workspaces on
        // unrelated React renders).
        applyBlocklyLocale(blocklyLocaleRef.current);
        prepareBlocklyWidgetDivForInjection(Blockly.WidgetDiv);

        const rendererName = blocklyRendererForVisualStyle(blocklyVisualStyle);
        const ws = Blockly.inject(blocklyDiv.current, {
            renderer: rendererName,
            toolbox: getToolbox(activeBoard, extensionXml, activeCoreVersion) as any,
            media: '/blockly/media/',
            theme: getBlocklyVisualTheme(blocklyVisualStyle, resolvedTheme),
            grid: {
                spacing: 20,
                length: 3,
                colour: '#cbd8e6',
                snap: true,
            },
            zoom: {
                controls: true,
                wheel: true,
                startScale: 1.0,
                maxScale: 3,
                minScale: 0.3,
                scaleSpeed: 1.2,
            },
            trashcan: true,
            move: {
                scrollbars: true,
                drag: true,
                wheel: false
            },
        });

        workspaceRef.current = ws;
        setBlocklyWorkspace(ws);
        const viewportCulling = installBlocklyViewportCulling(ws, {
            overviewLabel: () => appI18n.t('workspacePerformance.overview'),
        });
        viewportCullingRef.current = viewportCulling;
        const removeNativeRegressionBridge = installNativeRegressionBridge(window, Blockly, ws);
        const unsubscribeBreakpoints = subscribeBlockBreakpoints(ws, (nextBreakpoints) => {
            const next = new Set(nextBreakpoints);
            breakpointIdsRef.current = next;
            setBreakpointIds(next);
            refreshBlockBreakpointVisuals(ws, next, blockDebugSessionRef.current.pausedBlockId);
        });
        refreshToolboxCategoryStyles(ws);

        // Handle Resize
        const handleResize = () => {
            ws.resize();
        };
        window.addEventListener('resize', handleResize);

        // Initial Resize to fit container
        requestAnimationFrame(() => {
            handleResize();
        });

        // Whole-project consumers run once per committed burst, never per block
        // inside a paste/undo group and never during a drag gesture.
        const codePreview = createBlocklyCodePreview();
        let editRevision = 0;
        const editScheduler = createBlocklyEditScheduler(async () => {
            const revision = editRevision;
            try {
            if (workspaceRef.current === ws) {
                const previewBoard = activeBoardDirtyRef.current;
                const preview = await codePreview.request(ws, previewBoard, blocklyLocaleRef.current);
                if (!preview.current || workspaceRef.current !== ws) return;
                if (previewBoard !== activeBoardDirtyRef.current) { editScheduler.schedule(); return; }
                const code = preview.code ?? arduinoGenerator.workspaceToCode(ws);
                const codeChanged = hasGeneratedCodeChanged(generatedCodeRef.current, code);
                // Keep the ref synchronous so grouped Blockly events compare against
                // the latest generated source before React effects have flushed.
                generatedCodeRef.current = code;
                setCodePreviewPending(false);
                setCodePreviewError(false);

                if (codeChanged && blockDebugSessionRef.current.active) {
                    void handleStopBlockDebug();
                    showToast('工程已修改，正在等待开发板结束调试', 'info');
                }
                setGeneratedCode(code);
                setResourcePreflightRevision(previous => previous + 1);
                if (codeChanged) {
                    // Structured reports describe the exact source that was inspected.
                    // Keep the snapshots for the next comparison, but never present an
                    // old build/pin result as if it described the edited workspace.
                    setCompileDoctorReport(null);
                    setCompileResourceReport(null);
                    setCompileIssues([]);
                    setPinPreflightReport(null);
                    setResourcePreflightReport(null);
                }
                refreshBlockBreakpointVisuals(
                    ws,
                    breakpointIdsRef.current,
                    blockDebugSessionRef.current.pausedBlockId,
                );
                if (dirtyTrackingReadyRef.current) {
                    scheduleProjectDirtyComparison(ws);
                    if (!recoveryRestoreInProgressRef.current) {
                        scheduleRecoveryDraftRef.current();
                    }
                }
            }
            } catch (error) {
                console.error('[Blockly] Code preview failed', error);
                if (workspaceRef.current === ws && revision === editRevision) {
                    // Keep copy and derived reports gated: old code is not the
                    // current project. Formal save/compile still use live models.
                    setCodePreviewPending(true);
                    setCodePreviewError(true);
                }
            }
        }, { isInteracting: () => ws.isDragging() });
        const changeListener = (e: any) => {
            if (projectLoadingRef.current) return;
            if (e.type === 'finished_loading') {
                editRevision++;
                codePreview.invalidate();
                codePreview.seed(ws);
                editScheduler.cancel();
                setCodePreviewPending(false);
                setCodePreviewError(false);
            }
            if (!shouldProcessBlocklyContentEvent(e)) return;
            editRevision++;
            codePreview.invalidate(e, ws);
            setCodePreviewPending(true);
            setCodePreviewError(false);
            if (blockDebugSessionRef.current.active) void handleStopBlockDebug();
            // Invalidate presented conclusions immediately, even while preview
            // work is queued. Saving/compiling continues to use current models.
            if (!editScheduler.pending) {
                setCompileDoctorReport(null);
                setCompileResourceReport(null);
                setCompileIssues([]);
                setPinPreflightReport(null);
                setResourcePreflightReport(null);
                if (dirtyTrackingReadyRef.current) setIsProjectDirty(true);
            }
            const ids: string[] = Array.isArray(e.ids) ? e.ids : e.blockId ? [e.blockId] : [];
            if (e.type === 'create' || e.type === 'change') {
                const blocks = ids.map(id => ws.getBlockById(id)).filter((block): block is Blockly.BlockSvg => !!block);
                for (const block of blocks) {
                    const colour = extensionBlockColours.get(block.type);
                    if (colour && block.getColour().toLowerCase() !== colour.toLowerCase()) block.setColour(colour);
                    else if (!colour) syncExtensionBlockVisualColour(block);
                }
                applyBlocklyVisualSkinToBlocks(blocks, blocklyVisualStyleRef.current);
            }
            editScheduler.schedule();
        };
        ws.addChangeListener(changeListener);

        const rendererTransition = rendererTransitionRef.current;
        if (rendererTransition) {
            const eventsWereEnabled = Blockly.Events.isEnabled();
            try {
                if (eventsWereEnabled) Blockly.Events.disable();
                if (rendererTransition.reason === 'locale' && rendererTransition.targetBlocklyLocale) {
                    applyBlocklyLocale(rendererTransition.targetBlocklyLocale);
                    blocklyLocaleRef.current = rendererTransition.targetBlocklyLocale;
                }
                Blockly.serialization.workspaces.load(rendererTransition.state, ws);
                const restoredCode = arduinoGenerator.workspaceToCode(ws);
                generatedCodeRef.current = restoredCode;
                setGeneratedCode(restoredCode);
                refreshBlockBreakpointVisuals(
                    ws,
                    breakpointIdsRef.current,
                    blockDebugSessionRef.current.pausedBlockId,
                );
                refreshBlockTraceVisuals(
                    ws,
                    blockRunModeRef.current === 'trace' ? blockTraceSnapshot : null,
                );
                requestAnimationFrame(() => {
                    if (workspaceRef.current !== ws) return;
                    ws.setScale(rendererTransition.scale);
                    ws.scroll(rendererTransition.scrollX, rendererTransition.scrollY);
                    rendererTransition.selectedBlockId
                        && ws.getBlockById(rendererTransition.selectedBlockId)?.select();
                    Blockly.svgResize(ws);
                    refreshToolboxCategoryStyles(ws);
                });
                rendererTransitionRef.current = null;
                setRendererRecoveryFailure(null);
                setIsBlocklyVisualStyleSwitching(false);
                if (rendererTransition.reason !== 'locale') {
                    showToast(t('settings.appearance.blockSkin.changed', {
                        skin: t(`settings.appearance.blockSkin.styles.${blocklyVisualStyle}.label`),
                    }), 'success');
                }
            } catch (error) {
                console.error('[Blockly] Failed to restore renderer transition state', error);
                if (rendererTransition.reason === 'locale'
                    && !rendererTransition.revertAttempted
                    && rendererTransition.originBlocklyLocale) {
                    // A failed locale restore must not leave the global
                    // Blockly message table and the visible workspace out of
                    // sync.  Re-run the same transaction once with the known
                    // previous locale; only lock the workspace if that second
                    // recovery also fails.
                    applyBlocklyLocale(rendererTransition.originBlocklyLocale);
                    blocklyLocaleRef.current = rendererTransition.originBlocklyLocale;
                    rendererTransitionRef.current = {
                        ...rendererTransition,
                        revertAttempted: true,
                        targetBlocklyLocale: rendererTransition.originBlocklyLocale,
                    };
                    setBlocklyRendererRevision(revision => revision + 1);
                    showToast('积木语言切换失败，正在恢复原语言', 'error');
                } else if (!rendererTransition.revertAttempted
                    && rendererTransition.originStyle !== blocklyVisualStyle) {
                    rendererTransitionRef.current = {
                        ...rendererTransition,
                        revertAttempted: true,
                    };
                    persistBlocklyVisualStyle(
                        rendererTransition.originStyle,
                        getBrowserBlocklyVisualStyleStorage(),
                    );
                    setBlocklyVisualStyle(rendererTransition.originStyle);
                    showToast('新积木外观无法安全载入，正在恢复原外观', 'error');
                } else {
                    try { ws.setIsReadOnly(true); } catch { }
                    setRendererRecoveryFailure({
                        message: '新旧积木外观都未能安全恢复当前工作区。为避免空工作区覆盖工程，编辑、保存、编译和上传已锁定。',
                        originStyle: rendererTransition.originStyle,
                    });
                    setIsBlocklyVisualStyleSwitching(false);
                    showToast('积木外观恢复失败，工程已锁定保护', 'error');
                }
            } finally {
                if (eventsWereEnabled) Blockly.Events.enable();
            }
        } else {
            // Initial generation
            const initialCode = arduinoGenerator.workspaceToCode(ws);
            generatedCodeRef.current = initialCode;
            setGeneratedCode(initialCode);
            setIsBlocklyVisualStyleSwitching(false);
        }

        return () => {
            console.log("[Blockly] Disposing...");
            editScheduler.dispose();
            codePreview.dispose();
            viewportCulling.dispose();
            if (viewportCullingRef.current === viewportCulling) viewportCullingRef.current = null;
            window.removeEventListener('resize', handleResize);
            unsubscribeBreakpoints();
            const wsAny = ws as any;
            const toolboxRoot = wsAny.__ckToolboxDomRoot as Element | undefined;
            const refreshHandler = wsAny.__ckToolboxDomRefreshHandler as EventListener | undefined;
            if (toolboxRoot && refreshHandler) {
                toolboxRoot.removeEventListener('click', refreshHandler, true);
                toolboxRoot.removeEventListener('pointerdown', refreshHandler, true);
                toolboxRoot.removeEventListener('pointerup', refreshHandler, true);
                toolboxRoot.removeEventListener('keydown', refreshHandler, true);
            }
            removeNativeRegressionBridge();
            try {
                disposeBlocklyWorkspaceLifecycle(ws, {
                    getMainWorkspace: () => Blockly.getMainWorkspace(),
                    setMainWorkspace: workspace => (
                        Blockly.common.setMainWorkspace as unknown as (next: unknown | null) => void
                    )(workspace),
                });
            } finally {
                workspaceRef.current = null;
                setBlocklyWorkspace(null);
            }
        };
    // Renderer is immutable in Blockly 12. Skin-only changes are applied by
    // setTheme below; this controlled rebuild is reserved for a future skin
    // that truly requires a different renderer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [blocklyRendererRevision]);

    useEffect(() => {
        const workspace = workspaceRef.current;
        if (!workspace) return;
        const nextTheme = getBlocklyVisualTheme(blocklyVisualStyle, resolvedTheme);
        try {
            (workspace as any).setTheme?.(nextTheme);
            refreshToolboxCategoryStyles(workspace);
            repaintBlocklyVisualSkin(workspace);
            Blockly.svgResize(workspace);
        } catch (error) {
            console.warn('Failed to apply Blockly theme', error);
        }
    }, [blocklyVisualStyle, refreshToolboxCategoryStyles, repaintBlocklyVisualSkin, resolvedTheme]);

    // Blockly creates/removes SVG nodes while loading a project, opening a
    // toolbox category, and dragging a new block. Keep the paint layer in sync
    // without observing attributes (the painter itself changes fill attributes,
    // so attribute observation would create a feedback loop).
    useEffect(() => {
        const workspace = blocklyWorkspace;
        const parentSvg = workspace?.getParentSvg?.();
        if (!workspace || !parentSvg || typeof MutationObserver === 'undefined') return;
        const observer = new MutationObserver((mutations) => {
            // Theme transitions explicitly repaint the full workspace. Fresh
            // original-style SVG and viewport parking/restoration need no skin
            // work, especially not a descendant scan on every reparented stack.
            if (blocklyVisualStyleRef.current === 'original') return;
            const roots = new Set<Element>();
            for (const mutation of mutations) {
                const target = mutation.target instanceof Element
                    ? mutation.target
                    : mutation.target.parentElement;
                const owner = target?.closest('.blocklyBlock');
                if (owner) roots.add(owner);
                for (const node of mutation.addedNodes) {
                    if (!(node instanceof Element)) continue;
                    if (node.matches('.blocklyBlock')) roots.add(node);
                    for (const root of node.querySelectorAll('.blocklyBlock')) roots.add(root);
                }
            }
            applyBlocklyVisualSkinToRoots(roots, blocklyVisualStyleRef.current,
                root => workspace.getBlockById(root.getAttribute('data-id') || '') || undefined);
        });
        observer.observe(parentSvg, { childList: true, subtree: true });
        repaintBlocklyVisualSkin(workspace);
        return () => observer.disconnect();
    }, [blocklyWorkspace, repaintBlocklyVisualSkin, scheduleBlocklyVisualSkin]);

    // Dynamic Board Update (Toolbox & Pin Config)
    useEffect(() => {
        if (!activeBoard) return;

        console.log(`[Workspace] Board switched to: ${activeBoard} `);

        // Inject Pins for this board if available
        const currentBoardData = activeBoardPackage;
        const isCustomBoardPackage = currentBoardData?.is_custom === true
            || activeBoardPackageId !== activeBoard;
        registerDetailedBoard(
            activeBoard,
            activeBoardPackageBuildGate.canBuild ? currentBoardData?.pins || [] : [],
            activeBoardPackageId,
            isCustomBoardPackage,
        );

        setBlocklyBoard(activeBoard, activeBoardPackageId, isCustomBoardPackage);
        setArduinoGeneratorTarget(activeBoard, activeCoreVersion);

        // Coalesce board/library refreshes. Blockly v12 can throw when two toolbox
        // replacements overlap while the old tree still owns focus.
        if (toolboxUpdateTimerRef.current) clearTimeout(toolboxUpdateTimerRef.current);
        toolboxUpdateTimerRef.current = setTimeout(() => {
            toolboxUpdateTimerRef.current = null;
            const workspace = workspaceRef.current;
            if (!workspace) return;
            try {
                workspace.hideChaff();
                const toolbox = workspace.getToolbox?.() as any;
                toolbox?.clearSelection?.();
                workspace.updateToolbox(getToolbox(activeBoard, extensionXml, activeCoreVersion) as any);
                requestAnimationFrame(() => {
                    if (workspaceRef.current === workspace) {
                        refreshToolboxCategoryStyles(workspace);
                        Blockly.svgResize(workspace);
                    }
                });
            } catch (error) {
                console.error('[Workspace] Failed to update toolbox', error);
            }
        }, 50);
        return () => {
            if (toolboxUpdateTimerRef.current) {
                clearTimeout(toolboxUpdateTimerRef.current);
                toolboxUpdateTimerRef.current = null;
            }
        };    }, [activeBoard, activeBoardPackage, activeBoardPackageBuildGate.canBuild, activeBoardPackageId, activeCoreVersion, extensionXml, refreshToolboxCategoryStyles]);

    // Load Project
    useEffect(() => {
        if (!extensionsReady) return;
        // Prevent re-loading the same project when extensionsReady toggles (e.g. after library import).
        // Only reload when currentPath or reloadTrigger actually change.
        const loadKey = `${currentPath}::${reloadTrigger}`;
        if (projectLoadedKeyRef.current === loadKey) return;
        projectLoadedKeyRef.current = null;
        // Board/options changes made while the project is still loading are
        // initialization, not user edits and must not create recovery drafts.
        dirtyTrackingReadyRef.current = false;
        loadedProjectWorkspaceFormatRef.current = null;
        setRecoveryCandidate(null);
        // A deliberate project load/reopen starts a new recovery-offer session.
        recoveryOfferSuppressedSessionRef.current = null;
        recoveryBaselineRef.current = null;
        cancelRecoveryDraftTimer();
        if (recoveryRestoreResumeTimerRef.current) {
            window.clearTimeout(recoveryRestoreResumeTimerRef.current);
            recoveryRestoreResumeTimerRef.current = null;
        }
        recoveryRestoreInProgressRef.current = false;
        const loadSeq = projectLoadSeqRef.current + 1;
        projectLoadSeqRef.current = loadSeq;
        projectLoadControllerRef.current?.abort();
        const loadController = new AbortController();
        projectLoadControllerRef.current = loadController;
        projectLoadingRef.current = true;
        const isCurrentLoad = () => projectLoadSeqRef.current === loadSeq;
        let initialPreview: ReturnType<typeof createBlocklyCodePreview> | null = null;
        let loadingViewport: ReturnType<typeof installBlocklyViewportCulling> | null = null;
        loadController.signal.addEventListener('abort', () => initialPreview?.dispose(), { once: true });
        const load = async () => {
            // Wait for workspaceRef to be ready (up to 1s)
            for (let i = 0; i < 20; i++) {
                if (workspaceRef.current) break;
                await new Promise(r => setTimeout(r, 50));
            }

            if (!isCurrentLoad()) return;
            if (workspaceRef.current && currentPath) {
                try {
                    interface ProjectData {
                        xml: string;
                        board: string;
                        name: string;
                        options?: string;
                        board_package_id?: string;
                        build_target?: string | null;
                    }

                    let data: ProjectData | null = null;

                    // Robust Tauri v2 detection
                    const isTauri = typeof window !== 'undefined' &&
                        ((window as any).__TAURI_IPC__ || (window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);

                    if (isTauri) {
                        data = await invoke('load_project', { path: currentPath }) as ProjectData;
                    } else {
                        console.log("Simulation Mode: Loading from local storage");
                        const saved = localStorage.getItem(`ck_project_${currentPath} `);
                        data = {
                            xml: saved || '',
                            board: 'esp32:esp32:esp32c5',
                            name: currentPath.split(/[\\/]/).pop() || 'Untitled',
                            options: '{}',
                            board_package_id: '',
                        };
                    }
                    if (projectLoadSeqRef.current !== loadSeq) return;

                    let loadedBoardOptions: Record<string, unknown> = {};
                    let boardOptionsParseFailed = false;
                    if (data?.options) {
                        try {
                            const parsedOptions = JSON.parse(data.options);
                            if (parsedOptions && typeof parsedOptions === 'object' && !Array.isArray(parsedOptions)) {
                                loadedBoardOptions = parsedOptions as Record<string, unknown>;
                            }
                        } catch (error) {
                            boardOptionsParseFailed = true;
                            console.error('Failed to parse board options', error);
                        }
                    }

                    // 1. Board Compatibility Check
                    let targetBoard = forceBoard || data?.board || 'arduino:avr:uno';
                    const requestedBoardPackageId = String(forceBoardPackageId || data?.board_package_id || '').trim();

                    // Normalize target board FQBN from name if needed
                    const matchedBoard = BOARDS_LIST.find(b => b.fqbn === targetBoard || b.name === targetBoard);
                    if (matchedBoard) targetBoard = matchedBoard.fqbn;
                    const targetBoardPackageId = requestedBoardPackageId || targetBoard;
                    const inlineBoardOptions = parseBoardFqbnOptions(targetBoard);
                    if (Object.keys(inlineBoardOptions).length > 0) {
                        loadedBoardOptions = { ...inlineBoardOptions, ...loadedBoardOptions };
                    }
                    targetBoard = baseBoardFqbn(targetBoard);

                    // Switch board first, then wait until that board's extensions and toolbox
                    // have finished loading. Loading blocks against the previous board caused
                    // valid extension blocks to be dropped as "unknown".
                    if (targetBoard !== activeBoard || targetBoardPackageId !== activeBoardPackageId) {
                        console.log(`Auto-switching board from ${activeBoard} to ${targetBoard} `);
                        setActiveBoard(targetBoard, targetBoardPackageId);
                        showToast(`环境已切换为: ${matchedBoard?.name || targetBoard}`, 'success');
                        return;
                    }
                    if (extensionsLoadedBoard !== targetBoard
                        || extensionsLoadedBoardPackageId !== targetBoardPackageId) {
                        return;
                    }
                    const loadedBuildTarget = forceBoard && baseBoardFqbn(forceBoard) !== baseBoardFqbn(data?.board || '')
                        ? null : readProjectBuildTarget(data?.build_target);
                    updateRecordedBuildTarget(loadedBuildTarget);
                    // 2. Import Configuration (Options)
                    setBoardOptions(loadedBoardOptions);

                    let parseFailed = false;
                    if (data && data.xml) {
                        try {
                            const inspection = inspectSerializedBlocklyWorkspace(
                                data.xml,
                                isKnownBlockType,
                                {
                                    format: 'auto',
                                    parseXml: serialized => Blockly.utils.xml.textToDom(serialized),
                                },
                            );
                            loadedProjectWorkspaceFormatRef.current = inspection.format;
                            if (!inspection.canDeserializeIntoBlockly || !inspection.canOverwriteSource) {
                                clearBlockBreakpoints(workspaceRef.current);
                                workspaceRef.current.clear();
                                generatedCodeRef.current = '';
                                setGeneratedCode('');
                                dirtyTrackingReadyRef.current = false;
                                cleanProjectFingerprintRef.current = null;
                                setIsProjectDirty(false);
                                setProjectLoadSafetyError(null);
                                setUnknownBlockProtection({
                                    projectPath: currentPath,
                                    projectName: data.name || currentPath.split(/[\\/]/).pop() || '当前工程',
                                    inspection,
                                });
                                projectLoadedKeyRef.current = loadKey;
                                showToast(`工程已进入只读保护：保留 ${inspection.unknownBlockCount} 个未知积木`, 'error');
                                return;
                            }

                            setUnknownBlockProtection(null);
                            setProjectLoadSafetyError(null);
                            clearBlockBreakpoints(workspaceRef.current);
                            if (inspection.format === 'json') {
                                const parseable = data.xml.startsWith('\uFEFF') ? data.xml.slice(1) : data.xml;
                                const state = JSON.parse(parseable);
                                const total = countSerializedBlocks(state);
                                if (total >= 2000) {
                                    const workspace = workspaceRef.current;
                                    const viewport = viewportCullingRef.current;
                                    loadingViewport = viewport;
                                    setProjectLoadProgress({ completed: 0, total, phase: 'blocks' });
                                    await new Promise(resolve => setTimeout(resolve, 0));
                                    if (!isCurrentLoad()) return;
                                    viewport?.beginBulkLoad();
                                    try {
                                        await loadBlocklyWorkspaceProgressively(state, workspace, {
                                            signal: loadController.signal,
                                            isCurrent: () => isCurrentLoad() && workspaceRef.current === workspace,
                                            onProgress: setProjectLoadProgress,
                                            stageStack: block => viewport?.stageLoadedStack(block),
                                        });
                                    } finally {
                                        if (isCurrentLoad()) viewport?.endBulkLoad();
                                    }
                                    setProjectLoadProgress({ completed: total, total, phase: 'code' });
                                } else {
                                    Blockly.serialization.workspaces.load(state, workspaceRef.current);
                                }
                            } else {
                                workspaceRef.current.clear();
                                const xmlDom = Blockly.utils.xml.textToDom(data.xml);
                                Blockly.Xml.domToWorkspace(xmlDom, workspaceRef.current);
                            }
                        } catch (e) {
                            if (!isCurrentLoad()) return;
                            console.error('Failed to parse project state', e);
                            try {
                                workspaceRef.current?.clear();
                            } catch {
                                // ignore cleanup failures
                            }
                            setUnknownBlockProtection(null);
                            setProjectLoadSafetyError(loadController.signal.aborted
                                ? appI18n.t('workspacePerformance.loadCancelled')
                                : '工程数据无法安全解析。CK 已停止载入并禁止覆盖保存；原工程文件保持不变。');
                            showToast('工程数据无法安全解析，已停止载入并保护原文件', 'error');
                            parseFailed = true;
                        }

                        if (parseFailed) {
                            // Keep error toast only when parsing fails.
                        } else {
                            showToast('加载成功', 'success');
                        }

                    } else {
                        loadedProjectWorkspaceFormatRef.current = 'json';
                        clearBlockBreakpoints(workspaceRef.current);
                        workspaceRef.current.clear();
                        setUnknownBlockProtection(null);
                        setProjectLoadSafetyError(null);
                        showToast('已加载（空项目）', 'success');
                    }

                    if (parseFailed) {
                        generatedCodeRef.current = '';
                        setGeneratedCode('');
                        dirtyTrackingReadyRef.current = false;
                        cleanProjectFingerprintRef.current = null;
                        setIsProjectDirty(false);
                        projectLoadedKeyRef.current = loadKey;
                        return;
                    }

                    // Blockly deserialization may emit only `finished_loading`, which the
                    // edit listener deliberately ignores. Synchronize explicitly so an
                    // immediate compile cannot use the pre-load/empty workspace source.
                    const loadedWorkspace = workspaceRef.current;
                    const loadedWorkspaceState = Blockly.serialization.workspaces.save(loadedWorkspace);
                    initialPreview = createBlocklyCodePreview();
                    const preview = await initialPreview.request(loadedWorkspace, targetBoard, blocklyLocaleRef.current, loadedWorkspaceState);
                    if (!isCurrentLoad() || workspaceRef.current !== loadedWorkspace) return;
                    if (loadController.signal.aborted) throw new DOMException('Workspace load cancelled', 'AbortError');
                    const loadedCode = preview.code ?? arduinoGenerator.workspaceToCode(loadedWorkspace);
                    generatedCodeRef.current = loadedCode;
                    setGeneratedCode(loadedCode);
                    setCodePreviewPending(false);
                    setCodePreviewError(false);

                    dirtyTrackingReadyRef.current = true;
                    activeBoardDirtyRef.current = targetBoard;
                    activeBoardPackageIdDirtyRef.current = targetBoardPackageId;
                    boardOptionsDirtyRef.current = loadedBoardOptions;
                    if (boardOptionsParseFailed) {
                        cleanProjectFingerprintRef.current = '__ck_loaded_with_recovery__';
                        setIsProjectDirty(true);
                    } else {
                        cleanProjectFingerprintRef.current = createProjectFingerprint(
                            loadedWorkspaceState,
                            targetBoard,
                            loadedBoardOptions,
                            targetBoardPackageId,
                            loadedBuildTarget,
                        );
                        setIsProjectDirty(false);
                        scheduleProjectDirtyComparison(workspaceRef.current, 120);
                    }
                    projectLoadedKeyRef.current = loadKey;
                    const nextLoadedRevision = projectLoadedRevisionRef.current + 1;
                    projectLoadedRevisionRef.current = nextLoadedRevision;
                    setProjectLoadedRevision(nextLoadedRevision);
                } catch (e) {
                    if (!isCurrentLoad()) return;
                    console.error('Failed to load project', e);
                    loadedProjectWorkspaceFormatRef.current = null;
                    setUnknownBlockProtection(null);
                    setProjectLoadSafetyError(loadController.signal.aborted
                        ? appI18n.t('workspacePerformance.loadCancelled')
                        : '工程读取失败。CK 已禁止覆盖保存，原工程文件保持不变。');
                    showToast('加载项目失败，已保护原工程文件', 'error');
                    dirtyTrackingReadyRef.current = false;
                    cleanProjectFingerprintRef.current = null;
                    projectLoadedKeyRef.current = loadKey;
                }
            }
        };
        void load().finally(() => {
            initialPreview?.dispose();
            if (isCurrentLoad()) {
                projectLoadingRef.current = false;
                setProjectLoadProgress(null);
            }
        });
        return () => {
            loadController.abort();
            loadingViewport?.endBulkLoad();
            if (projectLoadSeqRef.current === loadSeq) {
                projectLoadSeqRef.current += 1;
                projectLoadingRef.current = false;
                setProjectLoadProgress(null);
            }
        };
    }, [activeBoard, activeBoardPackageId, cancelRecoveryDraftTimer, currentPath, extensionsLoadedBoard, extensionsLoadedBoardPackageId, extensionsReady, forceBoard, forceBoardPackageId, reloadTrigger, scheduleProjectDirtyComparison, setActiveBoard]);

    useEffect(() => {
        const targetMetadataChanged = JSON.stringify(previousDirtyTargetRef.current) !== JSON.stringify(recordedBuildTarget);
        previousDirtyTargetRef.current = recordedBuildTarget;
        const boardStateChanged = createProjectFingerprint(
            null,
            activeBoardDirtyRef.current,
            boardOptionsDirtyRef.current,
            activeBoardPackageIdDirtyRef.current,
        ) !== createProjectFingerprint(
            null,
            activeBoard,
            boardOptions,
            activeBoardPackageId,
        );
        activeBoardDirtyRef.current = activeBoard;
        activeBoardPackageIdDirtyRef.current = activeBoardPackageId;
        boardOptionsDirtyRef.current = boardOptions;
        scheduleProjectDirtyComparison(workspaceRef.current, 0);
        if ((boardStateChanged || targetMetadataChanged)
            && dirtyTrackingReadyRef.current
            && !recoveryRestoreInProgressRef.current) {
            // Board/options-only edits use the same bounded 12s debounce as
            // Blockly edits; persistRecoveryDraft rechecks the dirty state.
            scheduleRecoveryDraftRef.current();
        }
    }, [activeBoard, activeBoardPackageId, boardOptions, recordedBuildTarget, scheduleProjectDirtyComparison]);




    // Depend on currentPath and trigger to allow switching/reloading projects
    // Wait, the previous effect runs once on mount. workspaceRef.current is set then.
    // But this effect might run before workspaceRef is set if I don't depend on it?
    // workspaceRef is a check, but it doesn't trigger re-render.
    // Actually, I should probably put this logic inside the injection effect or use a state for 'isBlocklyReady'.

    // Better:
    // The injection effect sets `workspaceRef.current`.
    // I can modify the injection effect to calling `load()` right after injection.

    // Let's rewrite this block to use a ref-callback or just merge into the injection effect?
    // Merging is safer.

    // Blockly's document-level keyboard handlers must not mutate a half-loaded
    // project between batches. The fixed overlay also gates pointer/tool actions.
    useEffect(() => {
        if (!projectLoadProgress) return;
        const preventWorkspaceKey = (event: KeyboardEvent) => {
            if (event.target instanceof Element && event.target.closest('[data-ck-role="project-load-progress"]')
                && !event.ctrlKey && !event.metaKey && !event.altKey
                && ['Tab', 'Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        window.addEventListener('keydown', preventWorkspaceKey, true);
        return () => window.removeEventListener('keydown', preventWorkspaceKey, true);
    }, [Boolean(projectLoadProgress)]);

    const hasUnsavedProjectChanges = useCallback((): boolean => {
        const workspace = workspaceRef.current;
        const cleanFingerprint = cleanProjectFingerprintRef.current;
        if (!workspace || !dirtyTrackingReadyRef.current || !cleanFingerprint) return false;
        try {
            const currentState = Blockly.serialization.workspaces.save(workspace);
            return createProjectFingerprint(currentState, activeBoard, boardOptions, activeBoardPackageId, recordedBuildTargetRef.current) !== cleanFingerprint;
        } catch (error) {
            console.warn('[Workspace] Failed to inspect unsaved project state', error);
            return true;
        }
    }, [activeBoard, activeBoardPackageId, boardOptions]);

    const performFormalSave = useCallback(async (ownerToken: number): Promise<boolean> => {
        const formalSaveSession = currentRecoveryProjectSession();
        if (projectLoadingRef.current || !workspaceRef.current || !formalSaveSession) {
            showToast('工程仍在加载，请等待加载完成后再保存', 'error');
            return false;
        }
        if (unknownBlockProtection || projectLoadSafetyError || rendererRecoveryFailure) {
            await dialog.alert({
                title: rendererRecoveryFailure ? '积木外观恢复失败，工程已锁定' : '当前工程处于保护模式',
                message: rendererRecoveryFailure
                    ? `${rendererRecoveryFailure.message} 请先在工作区提示中重试恢复，或导出恢复快照。`
                    : unknownBlockProtection
                    ? '工程含有尚未注册的第三方积木。CK 不会用删减后的工作区覆盖原文件；请先安装或启用对应积木包，再重新检查。'
                    : '工程数据尚未安全载入。为避免覆盖原文件，普通保存和另存为已被停止。',
                type: 'warning',
            });
            return false;
        }
        if (enabledBlockPackageInventoryErrorRef.current) {
            await dialog.alert({
                title: '积木包证据尚未就绪',
                message: `${enabledBlockPackageInventoryErrorRef.current}。为避免写入错误的来源版本，CK 已停止保存；请重新检查积木包或切换板卡后重试。`,
                type: 'warning',
            });
            return false;
        }

        const formalSaveSessionKey = formalSaveSession
            ? recoveryProjectSessionKey(formalSaveSession)
            : null;
        const formalSaveProjectPath = formalSaveSession.projectPath;
        if (formalSaveSessionKey) {
            const ownerSessionKeys = recoveryFormalSaveGatesRef.current.get(ownerToken) || new Set<string>();
            if (!ownerSessionKeys.has(formalSaveSessionKey)) {
                recoveryDraftRescheduleAfterSaveRef.current.delete(formalSaveSessionKey);
                ownerSessionKeys.add(formalSaveSessionKey);
                recoveryFormalSaveGatesRef.current.set(ownerToken, ownerSessionKeys);
            }
            cancelRecoveryDraftTimer();
        }
        try {
            const savedBuildTarget = captureBuildTarget();
            const savedTargetBefore = recordedBuildTargetRef.current;
            showToast('正在保存...', 'loading');
            // @ts-ignore
            const state = Blockly.serialization.workspaces.save(workspaceRef.current);
            const json = JSON.stringify(state);
            const code = arduinoGenerator.workspaceToCode(workspaceRef.current);

            // Robust Tauri v2 detection
            const isTauri = typeof window !== 'undefined' &&
                ((window as any).__TAURI_IPC__ || (window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);

            if (isTauri) {
                if (/\.(?:maker|ck)$/i.test(formalSaveProjectPath)) {
                    // Update the file
                    await invoke('save_project_as', {
                        targetPath: formalSaveProjectPath,
                        sourcePath: formalSaveProjectPath,
                        xml: json,
                        code: code,
                        board: activeBoard,
                        options: JSON.stringify(savedBuildTarget.options),
                        boardPackageId: activeBoardPackageId,
                        blockPackageInventory: enabledBlockPackageInventoryRef.current,
                        buildTarget: JSON.stringify(savedBuildTarget),
                    });
                } else {
                    await invoke('save_project', {
                        path: formalSaveProjectPath,
                        blocklyXml: json,
                        board: activeBoard,
                        code: code,
                        options: JSON.stringify(savedBuildTarget.options), // Pass it anyway, backend handles it
                        boardPackageId: activeBoardPackageId,
                        blockPackageInventory: enabledBlockPackageInventoryRef.current,
                        buildTarget: JSON.stringify(savedBuildTarget),
                    });
                }

                showToast('保存成功', 'success');
            } else {
                console.log("Simulation Mode: Saved project to memory", { path: formalSaveProjectPath, json });
                localStorage.setItem(`ck_project_${formalSaveProjectPath} `, json);
                showToast('保存成功（仿真模式）', 'success');
            }
            const saveSessionStillCurrent = recoveryProjectSessionIsCurrent(formalSaveSession);
            if (saveSessionStillCurrent) {
                // Publish the clean fingerprint as soon as the formal write is
                // durable. Edits made while recovery cleanup finishes remain dirty.
                if (recordedBuildTargetRef.current === savedTargetBefore) {
                    updateRecordedBuildTarget(savedBuildTarget);
                    // Keep defaults pinned in this live session too. A subsequent Core install
                    // must not replace them before the user closes and reopens the project.
                    if (activeBoardDirtyRef.current === activeBoard
                        && activeBoardPackageIdDirtyRef.current === activeBoardPackageId
                        && JSON.stringify(normalizeFingerprintValue(boardOptionsDirtyRef.current)) === JSON.stringify(normalizeFingerprintValue(boardOptions))) {
                        boardOptionsDirtyRef.current = savedBuildTarget.options;
                        setBoardOptions(savedBuildTarget.options);
                    }
                }
                cleanProjectFingerprintRef.current = createProjectFingerprint(state, activeBoard, savedBuildTarget.options, activeBoardPackageId, savedBuildTarget);
                dirtyTrackingReadyRef.current = true;
                setIsProjectDirty(false);
                scheduleProjectDirtyComparison(workspaceRef.current, 0);
                setRecoveryCandidate(previous => (
                    !previous || !formalSaveSession
                        || recoveryProjectSessionMatches(previous.session, formalSaveSession)
                        ? null
                        : previous
                ));
                cancelRecoveryDraftTimer();
                recoveryBaselineRef.current = null;
            }
            if (isTauri) {
                // A write that began before the formal save may finish after it.
                // Drain that exact project session before removing its draft tree.
                await waitForRecoveryDraftWrite(formalSaveSession);
                try {
                    await discardProjectRecoveryDrafts(formalSaveProjectPath);
                } catch (error) {
                    console.warn('[RecoveryDrafts] Formal save succeeded but draft cleanup failed', error);
                }
                if (formalSaveSession && recoveryProjectSessionIsCurrent(formalSaveSession)) {
                    try {
                        const baseline = await getProjectRecoveryBaseline(formalSaveProjectPath);
                        if (recoveryProjectSessionIsCurrent(formalSaveSession)) {
                            recoveryBaselineRef.current = {
                                sessionKey: recoveryProjectSessionKey(formalSaveSession),
                                baseline,
                            };
                        }
                    } catch (error) {
                        console.warn('[RecoveryDrafts] Formal save succeeded but baseline refresh failed', error);
                    }
                }
            }
            return true;
        } catch (e) {
            console.error(e);
            showToast('保存失败', 'error');
            return false;
        }
    }, [activeBoard, activeBoardPackageId, boardOptions, cancelRecoveryDraftTimer, currentRecoveryProjectSession, dialog, projectLoadSafetyError, recoveryProjectSessionIsCurrent, rendererRecoveryFailure, scheduleProjectDirtyComparison, unknownBlockProtection, waitForRecoveryDraftWrite]);
    performFormalSaveRef.current = performFormalSave;

    const finishFormalSaveOwner = useCallback((ownerToken: number, lastResult: boolean) => {
        const ownerSessionKeys = recoveryFormalSaveGatesRef.current.get(ownerToken);
        recoveryFormalSaveGatesRef.current.delete(ownerToken);
        if (!ownerSessionKeys) return;

        const currentSession = currentRecoveryProjectSession();
        const currentSessionKey = currentSession ? recoveryProjectSessionKey(currentSession) : null;
        ownerSessionKeys.forEach(sessionKey => {
            // Another formal owner still protects this same project session.
            if (recoveryFormalSaveSessionIsGated(sessionKey)) return;
            const rescheduleRequested = recoveryDraftRescheduleAfterSaveRef.current.delete(sessionKey);
            if (currentSessionKey === sessionKey
                && hasUnsavedProjectChanges()
                && (!lastResult || rescheduleRequested)) {
                scheduleRecoveryDraftRef.current();
            }
        });
    }, [currentRecoveryProjectSession, hasUnsavedProjectChanges, recoveryFormalSaveSessionIsGated]);
    finishFormalSaveOwnerRef.current = finishFormalSaveOwner;

    const handleSave = useCallback((): Promise<boolean> => (
        formalSaveQueueRef.current!.request()
    ), []);

    // Keyboard Shortcuts
    useEffect(() => {
        const handleKeyDown = async (e: KeyboardEvent) => {
            // Save: Ctrl + S
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                await handleSave();
            }

            // Undo: Ctrl + Z
            if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                if (workspaceRef.current) {
                    workspaceRef.current.undo(false); // false = undo
                }
            }

            // Redo: Ctrl + Y OR Ctrl + Shift + Z
            if (((e.ctrlKey || e.metaKey) && e.key === 'y') ||
                ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.shiftKey)) {
                e.preventDefault();
                if (workspaceRef.current) {
                    workspaceRef.current.undo(true); // true = redo
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleSave]);

    // State for Dialog Defaults
    const [defaultDir, setDefaultDir] = useState<string | null>(null);

    // Initial Load & Config
    useEffect(() => {
        const init = async () => {
            // Robust Tauri v2 detection
            const isTauri = typeof window !== 'undefined' &&
                ((window as any).__TAURI_IPC__ || (window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);

            if (isTauri) {
                try {
                    const roots = await invoke('get_project_roots') as string[];
                    if (roots && roots.length > 0) {
                        setDefaultDir(roots[0]);
                    }
                } catch (e) {
                    console.error("Failed to get project roots", e);
                }
            }
        };
        init();
    }, []);

    const handleSaveAs = async () => {
        if (saveAsBusyRef.current) {
            showToast('另存为正在进行，请等待当前操作完成', 'error');
            return;
        }
        const saveAsSession = currentRecoveryProjectSession();
        if (projectLoadingRef.current || !workspaceRef.current || !saveAsSession) {
            showToast('工程仍在加载，请等待加载完成后再另存为', 'error');
            return;
        }
        if (unknownBlockProtection || projectLoadSafetyError || rendererRecoveryFailure) {
            await dialog.alert({
                title: rendererRecoveryFailure ? '积木外观恢复失败，工程已锁定' : '当前工程处于保护模式',
                message: rendererRecoveryFailure
                    ? `${rendererRecoveryFailure.message} 请先重试恢复或导出恢复快照。`
                    : '为避免把未知或损坏的积木数据替换成空工作区，普通另存为已停止。请使用保护面板中的“导出原始积木数据”，或先修复依赖后重新检查。',
                type: 'warning',
            });
            return;
        }
        if (enabledBlockPackageInventoryErrorRef.current) {
            await dialog.alert({
                title: '积木包证据尚未就绪',
                message: `${enabledBlockPackageInventoryErrorRef.current}。为避免把未经验证的包版本写入新工程，CK 已停止另存为；请重新检查积木包后重试。`,
                type: 'warning',
            });
            return;
        }
        saveAsBusyRef.current = true;
        try {
            const selectedPath = await save({
                defaultPath: defaultDir || undefined,
                filters: [{
                    name: 'CK 工程文件',
                    extensions: ['ck', 'maker']
                }]
            });

            if (selectedPath) {
                if (!recoveryProjectSessionIsCurrent(saveAsSession) || !workspaceRef.current) {
                    showToast('工程已切换或仍在加载，本次另存为已取消', 'error');
                    return;
                }
                // Capture after the native picker returns, only while the same
                // completed project load session is still current.
                // @ts-ignore
                const state = Blockly.serialization.workspaces.save(workspaceRef.current);
                const json = JSON.stringify(state);
                const code = arduinoGenerator.workspaceToCode(workspaceRef.current);
                const savedBuildTarget = captureBuildTarget();
                const capturedRecordedTarget = recordedBuildTargetRef.current;
                const capturedBoard = activeBoardDirtyRef.current;
                const capturedBoardPackageId = activeBoardPackageIdDirtyRef.current;
                const capturedBoardOptions = JSON.parse(
                    JSON.stringify(boardOptionsDirtyRef.current),
                ) as Record<string, unknown>;
                const savedCopyFingerprint = createProjectFingerprint(
                    state,
                    capturedBoard,
                    capturedBoardOptions,
                    capturedBoardPackageId,
                    capturedRecordedTarget,
                );
                showToast('正在另存为...', 'loading');
                await invoke('save_project_as', {
                    targetPath: selectedPath,
                    sourcePath: /\.(?:ck|maker)$/i.test(saveAsSession.projectPath)
                        ? saveAsSession.projectPath
                        : null,
                    xml: json,
                    code: code,
                    board: capturedBoard,
                    options: JSON.stringify(savedBuildTarget.options),
                    buildTarget: JSON.stringify(savedBuildTarget),
                    boardPackageId: capturedBoardPackageId,
                    blockPackageInventory: enabledBlockPackageInventoryRef.current,
                });
                if (!recoveryProjectSessionIsCurrent(saveAsSession) || !workspaceRef.current) {
                    showToast('新文件已写入，但当前工程已切换；未自动打开该文件', 'error');
                    return;
                }
                const latestState = Blockly.serialization.workspaces.save(workspaceRef.current);
                const latestFingerprint = createProjectFingerprint(
                    latestState,
                    activeBoardDirtyRef.current,
                    boardOptionsDirtyRef.current,
                    activeBoardPackageIdDirtyRef.current,
                    recordedBuildTargetRef.current,
                );
                if (latestFingerprint !== savedCopyFingerprint) {
                    showToast('副本已写入但期间有新修改，当前工程未切换，请再次另存', 'error');
                    return;
                }
                cancelRecoveryDraftTimer();
                recoveryBaselineRef.current = null;
                setRecoveryCandidate(null);
                beginProjectLoad(selectedPath); // Switch context synchronously before any further await.
                cleanProjectFingerprintRef.current = savedCopyFingerprint;
                dirtyTrackingReadyRef.current = true;
                setIsProjectDirty(false);
                showToast('另存成功', 'success');
                try {
                    await discardProjectRecoveryDrafts(selectedPath);
                } catch (error) {
                    console.warn('[RecoveryDrafts] Save-as succeeded but draft cleanup failed', error);
                }
            }
        } catch (e) {
            console.error(e);
            showToast('另存失败: ' + e, 'error');
        } finally {
            saveAsBusyRef.current = false;
        }
    };

    const retryProtectedProjectLoad = useCallback(() => {
        setProjectLoadSafetyError(null);
        beginProjectLoad();
    }, [beginProjectLoad]);

    const showProtectedProjectInFolder = useCallback(async () => {
        try {
            await invoke('show_in_folder', { path: currentPath });
        } catch (error) {
            console.error('[Workspace] Failed to show protected project', error);
            showToast('无法打开原工程所在目录', 'error');
        }
    }, [currentPath]);

    const exportProtectedRawWorkspace = useCallback(async () => {
        const protection = unknownBlockProtection;
        if (!protection) return;
        try {
            const suffix = protection.inspection.format === 'xml' ? 'xml' : 'json';
            const baseName = protection.projectName.replace(/[^\p{L}\p{N}._-]+/gu, '_') || 'protected-project';
            const selectedPath = await save({
                defaultPath: `${baseName}.unknown-blocks.${suffix}`,
                filters: [{
                    name: protection.inspection.format === 'xml' ? 'Blockly 原始 XML' : 'Blockly 原始 JSON',
                    extensions: [suffix],
                }],
            });
            if (!selectedPath) return;
            await writeTextFile(selectedPath, protection.inspection.rawWorkspace.serialized);
            showToast('原始积木数据已完整导出', 'success');
        } catch (error) {
            console.error('[Workspace] Failed to export protected workspace', error);
            showToast('导出原始积木数据失败', 'error');
        }
    }, [rendererRecoveryFailure, unknownBlockProtection]);

    const collectRecoveryDraftState = useCallback(async (): Promise<RecoveryDraftState | null> => {
        const workspace = workspaceRef.current;
        if (!workspace || unknownBlockProtection || projectLoadSafetyError || rendererRecoveryFailure) return null;
        const preview = createBlocklyCodePreview();
        recoveryPreviewWorkersRef.current.add(preview);
        try {
            const buildTarget = captureBuildTarget();
            const snapshot = Blockly.serialization.workspaces.save(workspace);
            const workspaceJson = JSON.stringify(snapshot);
            const generated = await preview.request(workspace, activeBoard, blocklyLocaleRef.current, snapshot);
            if (!generated.current || workspaceRef.current !== workspace) return null;
            // Never pair an old snapshot with newer source on extension fallback.
            if (generated.code === null && workspaceJson !== JSON.stringify(Blockly.serialization.workspaces.save(workspace))) return null;
            if (JSON.stringify(captureBuildTarget()) !== JSON.stringify(buildTarget)) return null;
            return {
                workspaceJson,
                sourceCode: generated.code ?? arduinoGenerator.workspaceToCode(workspace),
                board: activeBoard,
                fqbn: effectiveCompileFqbn,
                boardPackageId: activeBoardPackageId,
                options: JSON.stringify(buildTarget.options),
                buildTarget: JSON.stringify(buildTarget),
            };
        } catch (error) {
            console.warn('[RecoveryDrafts] Failed to capture current state', error);
            return null;
        } finally {
            preview.dispose();
            recoveryPreviewWorkersRef.current.delete(preview);
        }
    }, [activeBoard, activeBoardPackageId, boardOptions, effectiveCompileFqbn, projectLoadSafetyError, rendererRecoveryFailure, unknownBlockProtection]);

    const persistRecoveryDraft = useCallback(async (expectedSession?: RecoveryProjectSession) => {
        const session = expectedSession || currentRecoveryProjectSession();
        if (!session
            || !recoveryProjectSessionIsCurrent(session)
            || !hasUnsavedProjectChanges()) return;
        const sessionKey = recoveryProjectSessionKey(session);
        if (recoveryFormalSaveSessionIsGated(sessionKey)) {
            recoveryDraftRescheduleAfterSaveRef.current.add(sessionKey);
            return;
        }
        const existingWrite = recoveryDraftWritesRef.current.get(sessionKey);
        if (existingWrite) {
            await existingWrite;
            if (recoveryProjectSessionIsCurrent(session) && hasUnsavedProjectChanges()) {
                scheduleRecoveryDraftRef.current();
            }
            return;
        }
        const write = (async () => {
            try {
                const state = await collectRecoveryDraftState();
                if (!state || !recoveryProjectSessionIsCurrent(session) || recoveryFormalSaveSessionIsGated(sessionKey)) return;
                const cached = recoveryBaselineRef.current;
                let baseline = cached?.sessionKey === sessionKey
                    ? cached.baseline
                    : null;
                if (!baseline) {
                    baseline = await getProjectRecoveryBaseline(session.projectPath);
                    if (!recoveryProjectSessionIsCurrent(session)) return;
                    recoveryBaselineRef.current = { sessionKey, baseline };
                }
                if (!recoveryProjectSessionIsCurrent(session)) return;
                await saveRecoveryDraft({
                    projectPath: session.projectPath,
                    diskBaseline: {
                        sha256: baseline.sha256,
                        modifiedAt: baseline.modifiedAt,
                    },
                    ...state,
                });
                // Do not mutate shared session state after a write belonging to
                // an older project/load revision completes.
                if (!recoveryProjectSessionIsCurrent(session)) return;
            } catch (error) {
                // Rolling recovery is deliberately quiet during normal editing.
                // The formal project remains authoritative when a draft write fails.
                console.warn('[RecoveryDrafts] Rolling draft write failed', error);
            }
        })();
        recoveryDraftWritesRef.current.set(sessionKey, write);
        try {
            await write;
        } finally {
            if (recoveryDraftWritesRef.current.get(sessionKey) === write) {
                recoveryDraftWritesRef.current.delete(sessionKey);
            }
        }
    }, [collectRecoveryDraftState, currentRecoveryProjectSession, hasUnsavedProjectChanges, recoveryFormalSaveSessionIsGated, recoveryProjectSessionIsCurrent]);
    persistRecoveryDraftRef.current = persistRecoveryDraft;

    useEffect(() => {
        scheduleRecoveryDraftRef.current = () => {
            const session = currentRecoveryProjectSession();
            if (!session || !recoveryProjectSessionIsCurrent(session)) return;
            const sessionKey = recoveryProjectSessionKey(session);
            if (recoveryFormalSaveSessionIsGated(sessionKey)) {
                recoveryDraftRescheduleAfterSaveRef.current.add(sessionKey);
                return;
            }
            cancelRecoveryDraftTimer();
            recoveryDraftTimerRef.current = setTimeout(() => {
                recoveryDraftTimerRef.current = null;
                if (recoveryProjectSessionIsCurrent(session)) {
                    void persistRecoveryDraftRef.current(session);
                }
            }, 12_000);
        };
        return () => {
            scheduleRecoveryDraftRef.current = () => {};
            for (const worker of recoveryPreviewWorkersRef.current) worker.dispose();
            recoveryPreviewWorkersRef.current.clear();
            cancelRecoveryDraftTimer();
            if (recoveryRestoreResumeTimerRef.current) {
                window.clearTimeout(recoveryRestoreResumeTimerRef.current);
                recoveryRestoreResumeTimerRef.current = null;
            }
            recoveryRestoreInProgressRef.current = false;
            recoveryFormalSaveGatesRef.current.clear();
            recoveryDraftRescheduleAfterSaveRef.current.clear();
        };
    }, [cancelRecoveryDraftTimer, currentRecoveryProjectSession, recoveryFormalSaveSessionIsGated, recoveryProjectSessionIsCurrent]);

    useEffect(() => {
        if (!projectLoadedRevision || !currentPath || unknownBlockProtection || projectLoadSafetyError || rendererRecoveryFailure) return;
        const inspectionSession: RecoveryProjectSession = {
            projectPath: currentPath,
            loadKey: `${currentPath}::${reloadTrigger}`,
            revision: projectLoadedRevision,
        };
        if (!dirtyTrackingReadyRef.current
            || !recoveryProjectSessionIsCurrent(inspectionSession)) return;
        let cancelled = false;
        const sessionIsCurrent = () => !cancelled
            && recoveryProjectSessionIsCurrent(inspectionSession);
        const inspectCandidates = async () => {
            try {
                const state = await collectRecoveryDraftState();
                if (!state || !sessionIsCurrent()) return;
                const [baseline, fullStateHash, candidates] = await Promise.all([
                    getProjectRecoveryBaseline(currentPath),
                    computeRecoveryDraftFullStateHash(state),
                    listRecoveryDrafts(currentPath),
                ]);
                if (!sessionIsCurrent()) return;
                recoveryBaselineRef.current = {
                    sessionKey: recoveryProjectSessionKey(inspectionSession),
                    baseline,
                };
                const decision = selectLatestRecoveryDraftForSession(candidates, {
                    diskBaselineHash: baseline.sha256,
                    diskModifiedAt: baseline.modifiedAt,
                    fullStateHash,
                }, currentPath, projectLoadedRevision, recoveryOfferSuppressedSessionRef.current);
                if (decision.suppressed) {
                    // Keep an already-visible candidate stable, and never turn
                    // older rolling snapshots into an automatic modal queue.
                    return;
                }
                if (!decision.candidate) {
                    setRecoveryCandidate(null);
                    return;
                }
                const draft = await loadRecoveryDraft(currentPath, decision.candidate.id);
                if (sessionIsCurrent()) {
                    // Mark the whole project/baseline session as prompted as
                    // soon as the latest eligible recovery draft is displayed.
                    recoveryOfferSuppressedSessionRef.current = decision.sessionKey;
                    setRecoveryCandidate({
                        metadata: decision.candidate,
                        draft,
                        currentState: state,
                        session: inspectionSession,
                    });
                }
            } catch (error) {
                if (!cancelled) console.warn('[RecoveryDrafts] Candidate inspection failed', error);
            }
        };
        void inspectCandidates();
        return () => { cancelled = true; };
    }, [collectRecoveryDraftState, currentPath, projectLoadSafetyError, projectLoadedRevision, recoveryProjectSessionIsCurrent, reloadTrigger, rendererRecoveryFailure, unknownBlockProtection]);

    const validateRecoveryDraftBlocks = useCallback((draft: RecoveryDraft): WorkspaceLoadInspection => (
        inspectSerializedBlocklyWorkspace(draft.workspaceJson, isKnownBlockType, { format: 'json' })
    ), []);

    const handleDiscardRecoveryDraft = useCallback(async () => {
        const candidate = recoveryCandidate;
        if (!candidate) return;
        if (!recoveryProjectSessionIsCurrent(candidate.session)) {
            setRecoveryCandidate(null);
            showToast('工程会话已经变化，未对旧恢复稿执行操作', 'error');
            return;
        }
        setRecoveryBusy(true);
        try {
            await deleteRecoveryDraft(candidate.metadata.projectPath, candidate.metadata.id);
            if (recoveryProjectSessionIsCurrent(candidate.session)) {
                setRecoveryCandidate(previous => (
                    previous?.metadata.id === candidate.metadata.id ? null : previous
                ));
            }
            showToast('恢复稿已放弃，正式工程未修改', 'success');
        } catch (error) {
            showToast(`放弃恢复稿失败：${String(error)}`, 'error');
        } finally {
            setRecoveryBusy(false);
        }
    }, [recoveryCandidate, recoveryProjectSessionIsCurrent]);

    const handleRestoreRecoveryCurrent = useCallback(async () => {
        const candidate = recoveryCandidate;
        const workspace = workspaceRef.current;
        if (!candidate || !workspace) return;
        if (!recoveryProjectSessionIsCurrent(candidate.session)) {
            setRecoveryCandidate(null);
            showToast('工程会话已经变化，已停止恢复旧稿', 'error');
            return;
        }
        setRecoveryBusy(true);
        let recoverySchedulingPaused = false;
        try {
            const inspection = validateRecoveryDraftBlocks(candidate.draft);
            if (!inspection.canDeserializeIntoBlockly) {
                await dialog.alert({
                    title: '恢复稿包含缺失积木',
                    message: `发现 ${inspection.unknownBlockCount} 个当前未注册积木：${inspection.unknownTypeNames.join('、')}。CK 没有修改当前工作区，恢复稿也仍完整保留。请先安装或启用对应积木包。`,
                    type: 'warning',
                });
                return;
            }
            if (candidate.draft.board !== activeBoard
                || candidate.draft.boardPackageId !== activeBoardPackageId) {
                throw new Error('恢复稿绑定的物理板卡包与当前工程不同；请先恢复为新工程并从外部打开。');
            }
            const options = JSON.parse(candidate.draft.options || '{}');
            const state = JSON.parse(candidate.draft.workspaceJson);
            await captureWorkspaceCheckpoint('before_restore');
            if (!recoveryProjectSessionIsCurrent(candidate.session)) {
                throw new Error('工程会话在建立恢复前检查点时发生变化，旧稿未载入。');
            }
            recoveryRestoreInProgressRef.current = true;
            recoverySchedulingPaused = true;
            cancelRecoveryDraftTimer();
            updateRecordedBuildTarget(readProjectBuildTarget(candidate.draft.buildTarget));
            setBoardOptions(options);
            clearBlockBreakpoints(workspace);
            workspace.clear();
            Blockly.serialization.workspaces.load(state, workspace);
            const code = candidate.draft.sourceCode || arduinoGenerator.workspaceToCode(workspace);
            generatedCodeRef.current = code;
            setGeneratedCode(code);
            setCompileDoctorReport(null);
            setCompileResourceReport(null);
            setCompileIssues([]);
            setPinPreflightReport(null);
            dirtyTrackingReadyRef.current = true;
            setIsProjectDirty(true);
            setRecoveryCandidate(previous => (
                previous?.metadata.id === candidate.metadata.id ? null : previous
            ));
            showToast('恢复稿已载入当前工作区；正式工程尚未覆盖', 'success');
        } catch (error) {
            console.error('[RecoveryDrafts] Restore current failed', error);
            showToast(`恢复失败：${String(error)}`, 'error');
        } finally {
            // clear/load can emit several semantic events. They are suppressed
            // through the current task; resume with the latest callback and at
            // most one controlled timer after React has committed board options.
            if (recoverySchedulingPaused) {
                if (recoveryRestoreResumeTimerRef.current) {
                    window.clearTimeout(recoveryRestoreResumeTimerRef.current);
                }
                recoveryRestoreResumeTimerRef.current = window.setTimeout(() => {
                    recoveryRestoreResumeTimerRef.current = null;
                    recoveryRestoreInProgressRef.current = false;
                    if (recoveryProjectSessionIsCurrent(candidate.session)) {
                        scheduleRecoveryDraftRef.current();
                    }
                }, 0);
            } else {
                recoveryRestoreInProgressRef.current = false;
            }
            setRecoveryBusy(false);
        }
    }, [activeBoard, activeBoardPackageId, cancelRecoveryDraftTimer, captureWorkspaceCheckpoint, dialog, recoveryCandidate, recoveryProjectSessionIsCurrent, setBoardOptions, validateRecoveryDraftBlocks]);

    const handleRestoreRecoveryAsNew = useCallback(async () => {
        const candidate = recoveryCandidate;
        if (!candidate) return;
        if (!recoveryProjectSessionIsCurrent(candidate.session)) {
            setRecoveryCandidate(null);
            showToast('工程会话已经变化，未对旧恢复稿执行操作', 'error');
            return;
        }
        setRecoveryBusy(true);
        try {
            const selectedPath = await save({
                defaultPath: `${candidate.draft.projectName || 'recovered'}-恢复.ck`,
                filters: [{ name: 'CK 工程文件', extensions: ['ck', 'maker'] }],
            });
            if (!selectedPath) return;
            if (!recoveryProjectSessionIsCurrent(candidate.session)) {
                throw new Error('工程会话在选择保存位置时发生变化，旧稿仍完整保留。');
            }
            await invoke('save_project_as', {
                targetPath: selectedPath,
                sourcePath: null,
                xml: candidate.draft.workspaceJson,
                code: candidate.draft.sourceCode,
                board: candidate.draft.board,
                options: candidate.draft.options,
                buildTarget: candidate.draft.buildTarget || null,
                boardPackageId: candidate.draft.boardPackageId,
            });
            if (!recoveryProjectSessionIsCurrent(candidate.session)) {
                throw new Error('新工程已写入，但当前会话已经变化；原恢复稿仍完整保留。');
            }
            await deleteRecoveryDraft(candidate.metadata.projectPath, candidate.metadata.id);
            if (!recoveryProjectSessionIsCurrent(candidate.session)) return;
            setRecoveryCandidate(previous => (
                previous?.metadata.id === candidate.metadata.id ? null : previous
            ));
            beginProjectLoad(selectedPath);
            showToast('恢复稿已保存为新工程，原工程未修改', 'success');
        } catch (error) {
            console.error('[RecoveryDrafts] Restore as new failed', error);
            showToast(`恢复为新工程失败：${String(error)}`, 'error');
        } finally {
            setRecoveryBusy(false);
        }
    }, [beginProjectLoad, recoveryCandidate, recoveryProjectSessionIsCurrent]);

    const confirmUnsavedNavigation = useCallback(async (
        context: UnsavedNavigationContext,
    ): Promise<boolean> => {
        if (rendererRecoveryFailure) {
            await dialog.alert({
                title: '工程恢复保护仍在生效',
                message: `${rendererRecoveryFailure.message} 请先重试恢复；如需保留原始快照，可先在工作区提示中导出。`,
                type: 'warning',
            });
            return false;
        }
        if (isCompilingRef.current) {
            showToast('请先等待当前编译或上传结束，再离开工程', 'error');
            return false;
        }
        if (!hasUnsavedProjectChanges()) return true;

        const choice = await requestUnsavedChoice(context);
        if (choice === 'cancel') return false;
        if (choice === 'save') return handleSave();

        if (isNativeCheckpointStorageAvailable()) {
            try {
                await captureWorkspaceCheckpoint('before_leave');
            } catch (error) {
                console.error('[ProjectCheckpoints] Failed to protect discarded changes', error);
                await dialog.alert({
                    title: '保护检查点创建失败',
                    message: `为避免直接丢失修改，CK 已取消本次操作。\n\n${String(error)}`,
                    type: 'error',
                    confirmLabel: '知道了',
                });
                return false;
            }
        }
        return true;
    }, [captureWorkspaceCheckpoint, dialog, handleSave, hasUnsavedProjectChanges, rendererRecoveryFailure, requestUnsavedChoice]);

    const handleBack = useCallback(async () => {
        if (await confirmUnsavedNavigation('back')) {
            onBack();
        }
    }, [confirmUnsavedNavigation, onBack]);

    const handleOpenFile = async () => {
        if (!await confirmUnsavedNavigation('open')) return;

        try {
            const selectedPath = await open({
                defaultPath: defaultDir || undefined,
                multiple: false,
                filters: [{
                    name: 'CK 工程文件',
                    extensions: ['ck', 'maker']
                }]
            });

            if (selectedPath && typeof selectedPath === 'string') {
                showToast('正在打开...', 'loading');
                // Reload project data
                beginProjectLoad(selectedPath);
            }
        } catch (e) {
            console.error(e);
            showToast('打开失败: ' + e, 'error');
        }
    };

    useEffect(() => {
        const handleExternalProjectOpen = (event: Event) => {
            const detail = (event as CustomEvent<WorkspaceProjectOpenDetail>).detail;
            const targetPath = detail?.target?.path?.trim();
            if (!targetPath) {
                detail?.onSettled?.();
                return;
            }
            void (async () => {
                try {
                    if (!await confirmUnsavedNavigation('open')) return;
                    showToast(`正在打开 ${detail.target.name || 'CK 工程'}...`, 'loading');
                    if (projectPathsReferToSameFile(targetPath, currentPathRef.current)) {
                        // Setting the same parent route/key is a React no-op.
                        // Reload through the workspace's existing load trigger
                        // so "discard and reopen" really restores disk state.
                        beginProjectLoad(targetPath);
                    } else if (detail.accept) detail.accept();
                    else beginProjectLoad(targetPath);
                } catch (error) {
                    console.error('[ProjectOpen] Failed to complete workspace open request', error);
                    showToast(`打开失败：${String(error)}`, 'error');
                } finally {
                    // This completion callback is the acknowledgement boundary
                    // for the app-level queue and the native durable queue.
                    // It must run for accept, cancel and error alike.
                    await detail.onSettled?.();
                }
            })();
        };
        window.addEventListener(PROJECT_OPEN_BROWSER_EVENT, handleExternalProjectOpen);
        onProjectOpenListenerReady?.(true);
        return () => {
            window.removeEventListener(PROJECT_OPEN_BROWSER_EVENT, handleExternalProjectOpen);
            onProjectOpenListenerReady?.(false);
        };
    }, [beginProjectLoad, confirmUnsavedNavigation, onProjectOpenListenerReady]);

    useEffect(() => {
        const handleBeforeUnload = (event: BeforeUnloadEvent) => {
            if (allowWindowCloseRef.current || !hasUnsavedProjectChanges()) return;
            event.preventDefault();
            event.returnValue = '';
        };
        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }, [hasUnsavedProjectChanges]);

    useEffect(() => {
        const isTauri = typeof window !== 'undefined'
            && Boolean((window as any).__TAURI_IPC__ || (window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);
        if (!isTauri) return;

        let disposed = false;
        let unlisten: (() => void) | undefined;
        void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
            const appWindow = getCurrentWindow();
            const stopListening = await appWindow.onCloseRequested(async (event) => {
                if (allowWindowCloseRef.current || !hasUnsavedProjectChanges()) return;
                event.preventDefault();
                if (!await confirmUnsavedNavigation('close')) return;
                allowWindowCloseRef.current = true;
                await appWindow.close();
            });
            if (disposed) stopListening();
            else unlisten = stopListening;
        }).catch((error) => {
            console.warn('[Workspace] Failed to install native close protection', error);
        });

        return () => {
            disposed = true;
            unlisten?.();
        };
    }, [confirmUnsavedNavigation, hasUnsavedProjectChanges]);

    // Use ResizeObserver for robust layout handling
    useEffect(() => {
        if (!blocklyDiv.current) return;

        let resizeFrame: number | null = null;
        const scheduleBlocklyResize = () => {
            if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
            resizeFrame = requestAnimationFrame(() => {
                resizeFrame = null;
                const workspace = workspaceRef.current;
                if (workspace) Blockly.svgResize(workspace);
            });
        };
        const resizeObserver = new ResizeObserver(scheduleBlocklyResize);

        resizeObserver.observe(blocklyDiv.current);

        // Also handle window resize as fallback
        const handleWindowResize = scheduleBlocklyResize;
        window.addEventListener('resize', handleWindowResize);

        return () => {
            resizeObserver.disconnect();
            window.removeEventListener('resize', handleWindowResize);
            if (resizeFrame !== null) {
                cancelAnimationFrame(resizeFrame);
                resizeFrame = null;
            }
        };
    }, []); // Run once on mount (refs are stable)

    return (
        <div
            className="ck-workspace-shell flex h-full w-full min-w-0 flex-col overflow-hidden bg-[#f7f9fc] text-slate-800 font-sans relative isolate transition-colors dark:bg-slate-950 dark:text-slate-100"
            data-ck-blockly-skin={blocklyVisualStyle}
            data-ck-build-busy={isCompiling || isBuildPreparing}
        >
            {isCompiling && foregroundBuildEvidence && (
                <CompileProgressOverlay
                    progress={buildProgress}
                    buildEvidence={foregroundBuildEvidence}
                />
            )}
            {blockDebugSession.active && !isCompiling && (
                blockRunMode === 'trace' ? (
                    <BlockTracePanel
                        phase={(blockDebugSession.phase === 'paused' ? 'running' : blockDebugSession.phase) as BlockTracePhase}
                        snapshot={blockTraceSnapshot}
                        maxFirmwareFramesPerSecond={blockTraceFirmwareFps}
                        onLocateBlock={locateWorkspaceBlock}
                        onStop={() => void handleStopBlockDebug()}
                        onAbandon={handleAbandonBlockDebug}
                    />
                ) : (
                    <BlockDebugControls
                        phase={blockDebugSession.phase}
                        breakpointCount={liveBreakpointIds.length}
                        pausedBlockLabel={blockDebugSession.pausedBlockLabel}
                        pendingCommand={blockDebugSession.pendingCommand}
                        onContinue={() => void handleDebugContinue()}
                        onStep={() => void handleDebugStep()}
                        onStop={() => void handleStopBlockDebug()}
                        onAbandon={handleAbandonBlockDebug}
                    />
                )
            )}

            {debugRecoveryNotice && !blockDebugSession.active && (
                <div role="status" data-ck-role="debug-recovery-notice" className="mx-3 my-1 rounded border border-amber-400 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                    {debugRecoveryNotice}
                </div>
            )}

            <Toast show={toast.show} message={toast.message} type={toast.type} onClose={() => setToast(prev => ({ ...prev, show: false }))} />
            {unsavedDialogContext && (
                <UnsavedChangesDialog
                    context={unsavedDialogContext}
                    projectName={currentPath.split(/[\\/]/).pop() || '未命名工程'}
                    willCreateCheckpoint={isNativeCheckpointStorageAvailable()}
                    onChoose={finishUnsavedChoice}
                />
            )}

            {recoveryCandidate && (
                <RecoveryDraftModal
                    candidate={recoveryCandidate.metadata}
                    draft={recoveryCandidate.draft}
                    currentState={recoveryCandidate.currentState}
                    busy={recoveryBusy}
                    onKeepForLater={() => setRecoveryCandidate(null)}
                    onDiscard={() => void handleDiscardRecoveryDraft()}
                    onRestoreAsNew={() => void handleRestoreRecoveryAsNew()}
                    onRestoreCurrent={() => void handleRestoreRecoveryCurrent()}
                />
            )}

            <AppearanceSettingsModal
                isOpen={isAppearanceSettingsOpen}
                blocklyVisualStyle={blocklyVisualStyle}
                onBlocklyVisualStyleChange={handleBlocklyVisualStyleChange}
                blocklyVisualStyleDisabled={isBlocklyVisualStyleSwitching || Boolean(rendererRecoveryFailure)}
                onClose={closeAppearanceSettings}
            />

            <BoardConfigModal
                isOpen={isConfigOpen}
                onClose={() => setIsConfigOpen(false)}
                boardName={activeBoardPackage?.name || BOARDS.find(b => b.id === activeBoard)?.name || '未知开发板'}
                boardFqbn={effectiveCompileFqbn}
                detailsFqbn={activeBoard}
                displayMode={workspaceDisplayMode}
                configOptions={activeBoardPackage?.config_options}
                canUpload={!!activePort}
                isBusy={isCompiling || isDeviceHealthRunning}
                onClearCache={() => clearCurrentBoardCompileCache('clear')}
                onDeepClearCache={() => clearCurrentBoardCompileCache('clear', 'deep')}
                onForceRebuild={() => handleForceRebuild(false)}
                onForceRebuildAndUpload={() => handleForceRebuild(true)}
            />

            <LibraryManagerModal
                isOpen={isLibManagerOpen}
                onClose={() => setIsLibManagerOpen(false)}
                showToast={showToast}
                onExtensionImported={() => setExtensionsReloadSeq((prev) => prev + 1)}
                projectPath={currentPath}
                readBlockPackageMigrationWorkspace={readBlockPackageMigrationWorkspace}
                createBlockPackageMigrationCheckpoint={createBlockPackageMigrationCheckpoint}
                onBlockPackageMigrationCommitted={handleBlockPackageMigrationCommitted}
                initialArduinoSearch={librarySearchRequest}
            />

            <ProjectCheckpointsModal
                isOpen={isCheckpointsOpen}
                projectPath={currentPath}
                onClose={() => setIsCheckpointsOpen(false)}
                onCreate={async () => {
                    const checkpoint = await captureWorkspaceCheckpoint('manual');
                    if (!checkpoint) {
                        throw new Error('当前工程尚未准备好，无法保存检查点');
                    }
                    showToast('已保存当前工程检查点', 'success');
                }}
                onRestore={handleRestoreProjectCheckpoint}
            />

            <LastWorkingVersionModal
                isOpen={isLastWorkingVersionOpen}
                projectPath={currentPath}
                activePort={activePort}
                isBusy={isCompiling || isDeviceHealthRunning}
                getCurrentState={getCurrentLastWorkingVersionState}
                onClose={() => setIsLastWorkingVersionOpen(false)}
                onRestoreProject={handleRestoreLastWorkingProject}
                onRestoreFirmware={handleRestoreLastWorkingFirmware}
                onCompleteRestore={handleCompleteLastWorkingRestore}
                onRebuildLocked={handleRebuildLastWorkingVersionLocked}
            />

            <DiagnosticBundleModal
                isOpen={isDiagnosticBundleOpen}
                onClose={() => setIsDiagnosticBundleOpen(false)}
                exportData={createDiagnosticExportData}
                suggestedFileName={`${currentPath.split(/[\\/]/).pop()?.replace(/\.(maker|ck)$/i, '') || 'CK工程'}-诊断包.zip`}
                currentCoreVersions={installedCoreVersions}
                onExported={(result) => showToast(`诊断包已保存：${result.includedFiles} 个文件`, 'success')}
            />

            <ProjectAcceptanceReportModal
                isOpen={isProjectAcceptanceReportOpen}
                onClose={() => setIsProjectAcceptanceReportOpen(false)}
                reportProvider={createAcceptanceReportData}
                submissionMaterialProvider={createProjectSubmissionMaterial}
                suggestedBaseName={currentPath.split(/[\\/]/).pop()?.replace(/\.(maker|ck)$/i, '') || 'CK工程'}
                onExported={(path, format) => showToast(
                    `${format === 'ckpkg' ? '工程提交包' : format === 'html' ? '可打印报告' : '结构化报告'}已保存：${path}`,
                    'success',
                )}
            />

            {/* Header */}
            <header className="ck-workspace-header h-[60px] bg-[#fbfcfe] border-b border-[#dce3ec] flex items-center px-3 shrink-0 relative z-[300] gap-3 transition-colors dark:border-slate-800 dark:bg-slate-900">
                <div className="flex items-center gap-2 min-w-0">
                    <button onClick={() => void handleBack()} className="h-9 px-2 flex items-center justify-center gap-1 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors shrink-0 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100" title="返回项目列表">
                        <ArrowLeft size={19} />
                        <span className="text-xs font-bold">返回</span>
                    </button>
                    <BrandLogo className="h-8 w-[66px]" />
                    <div className="hidden min-[1200px]:flex min-w-0 flex-col justify-center mr-1">
                        <span className="flex items-center gap-1.5 font-bold text-sm text-slate-900 leading-4 whitespace-nowrap dark:text-slate-100">
                            CK
                            {isProjectDirty && (
                                <span className="inline-flex items-center gap-1 text-[9px] font-semibold text-amber-600 dark:text-amber-300" title="当前工程有未保存修改">
                                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                                    未保存
                                </span>
                            )}
                        </span>
                        <span
                            data-ck-role="workspace-project-identity"
                            data-ck-code-fingerprint={computeCodeFingerprint(generatedCode)}
                            data-ck-include-signature={computeIncludeSignature(generatedCode)}
                            data-ck-project-dirty={String(isProjectDirty)}
                            data-ck-project-name={currentPath.split(/[\\/]/).pop() || '未命名工程'}
                            className="hidden lg:block text-[10px] text-slate-400 leading-4 max-w-[150px] xl:max-w-[220px] truncate"
                            title={currentPath}
                        >
                            {currentPath.split(/[\\/]/).pop() || '未命名工程'}
                        </span>
                    </div>

                    <div className="hidden min-[1800px]:flex items-center h-9 p-0.5 bg-[#f1f4f8] border border-[#e1e7ef] rounded-md shrink-0 dark:border-slate-700 dark:bg-slate-800">
                        <button onClick={handleOpenFile} className="h-8 px-2 flex items-center gap-1.5 rounded text-slate-600 hover:text-slate-900 hover:bg-white transition-colors text-xs font-semibold whitespace-nowrap dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-slate-100" title="打开工程">
                            <FolderOpen size={15} /> <span>打开</span>
                        </button>
                        <button onClick={handleSave} className="h-8 px-2 flex items-center gap-1.5 rounded text-slate-600 hover:text-[var(--accent)] hover:bg-white transition-colors text-xs font-semibold whitespace-nowrap dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-brand-300" title="保存项目">
                            <Save size={15} /> <span>保存</span>
                        </button>
                        <button onClick={handleSaveAs} className="h-8 px-2 flex items-center gap-1.5 rounded text-slate-600 hover:text-slate-900 hover:bg-white transition-colors text-xs font-semibold whitespace-nowrap dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-slate-100" title="另存为">
                            <FilePlus size={15} /> <span>另存</span>
                        </button>
                        <button onClick={() => setIsDiagnosticBundleOpen(true)} className="h-8 px-2 flex items-center gap-1.5 rounded text-slate-600 hover:text-violet-700 hover:bg-white transition-colors text-xs font-semibold whitespace-nowrap dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-violet-300" title="导出或导入工程诊断包">
                            <HeartPulse size={15} /> <span>诊断包</span>
                        </button>
                    </div>

                    <div className="min-[1800px]:hidden flex items-center h-9 p-0.5 bg-[#f1f4f8] border border-[#e1e7ef] rounded-md shrink-0 relative dark:border-slate-700 dark:bg-slate-800">
                        <button onClick={handleOpenFile} className="hidden min-[1200px]:flex h-8 px-2 items-center gap-1.5 rounded text-slate-600 hover:text-slate-900 hover:bg-white transition-colors text-xs font-semibold whitespace-nowrap dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-slate-100" title="打开工程">
                            <FolderOpen size={15} /> 打开
                        </button>
                        <button onClick={handleSave} className="hidden min-[1200px]:flex h-8 px-2 items-center gap-1.5 rounded text-slate-600 hover:text-[var(--accent)] hover:bg-white transition-colors text-xs font-semibold whitespace-nowrap dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-brand-300" title="保存项目">
                            <Save size={15} /> 保存
                        </button>
                        <button onClick={() => setIsFileMenuOpen((value) => !value)} className="h-8 px-2 flex items-center gap-1.5 rounded text-slate-600 hover:text-slate-900 hover:bg-white transition-colors text-xs font-semibold whitespace-nowrap dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-slate-100" aria-haspopup="menu" aria-expanded={isFileMenuOpen}>
                            <FilePlus size={15} /> <span className="min-[1200px]:hidden">文件</span><span className="hidden min-[1200px]:inline">更多</span> <ChevronDown size={11} />
                        </button>
                        {isFileMenuOpen && (
                            <>
                                <div className="fixed inset-0 z-40" onClick={() => setIsFileMenuOpen(false)} />
                                <div className="absolute left-0 top-[calc(100%+8px)] z-50 w-40 bg-white border border-[#dce3ec] shadow-xl rounded-md p-1 dark:border-slate-700 dark:bg-slate-900" role="menu">
                                    <button onClick={() => { void handleOpenFile(); setIsFileMenuOpen(false); }} className="w-full h-9 px-2.5 rounded flex items-center gap-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800" role="menuitem">
                                        <FolderOpen size={15} /> 打开工程
                                    </button>
                                    <button onClick={() => { void handleSave(); setIsFileMenuOpen(false); }} className="w-full h-9 px-2.5 rounded flex items-center gap-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800" role="menuitem">
                                        <Save size={15} /> 保存项目
                                    </button>
                                    <button onClick={() => { void handleSaveAs(); setIsFileMenuOpen(false); }} className="w-full h-9 px-2.5 rounded flex items-center gap-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800" role="menuitem">
                                        <FilePlus size={15} /> 另存为
                                    </button>
                                    <button onClick={() => { setIsLibManagerOpen(true); setIsFileMenuOpen(false); }} className="w-full h-9 px-2.5 rounded flex items-center gap-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800" role="menuitem">
                                        <BookOpen size={15} /> 库管理器
                                    </button>
                                    <button onClick={() => { setIsCheckpointsOpen(true); setIsFileMenuOpen(false); }} className="w-full h-9 px-2.5 rounded flex items-center gap-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800" role="menuitem">
                                        <ArchiveRestore size={15} /> 工程检查点
                                    </button>
                                    {healthCapabilities.lastWorkingVersion && <button onClick={() => { setIsLastWorkingVersionOpen(true); setIsFileMenuOpen(false); }} className="w-full h-9 px-2.5 rounded flex items-center gap-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800" role="menuitem">
                                        <ShieldCheck size={15} /> 上一个可用版本
                                    </button>}
                                    <button onClick={() => { setIsDiagnosticBundleOpen(true); setIsFileMenuOpen(false); }} className="w-full h-9 px-2.5 rounded flex items-center gap-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800" role="menuitem">
                                        <HeartPulse size={15} /> 工程诊断包
                                    </button>
                                    <button onClick={() => { setIsProjectAcceptanceReportOpen(true); setIsFileMenuOpen(false); }} className="w-full h-9 px-2.5 rounded flex items-center gap-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800" role="menuitem">
                                        <CheckCircle size={15} /> 项目验收报告
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </div>

                <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2 shrink-0">
                    <div className="h-10 flex items-stretch bg-white border border-[#dce3ec] rounded-md relative z-20 dark:border-slate-700 dark:bg-slate-800">
                        <button
                            onClick={() => setIsConfigOpen(true)}
                            disabled={isCompiling || isDeviceHealthRunning}
                            data-ck-role="board-config-button"
                            data-ck-board-options-status={boardOptionsStatus}
                            data-ck-board-options-compatible={Object.keys(droppedBoardOptions).length === 0 ? 'true' : 'false'}
                            className="group h-full w-[112px] min-[1200px]:w-[150px] min-[1800px]:w-[190px] flex items-center gap-2 px-2.5 hover:bg-[#f5f8fa] transition-colors rounded-l-md min-w-0 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-slate-700"
                            title={`板卡设置与编译缓存\n${getBoardName()}\n${effectiveCompileFqbn}`}
                        >
                            <CircuitBoard size={17} className="text-[var(--accent)] shrink-0" />
                            <span className="flex flex-col min-w-0 text-left leading-none">
                                <span className="text-xs font-bold text-slate-700 whitespace-nowrap dark:text-slate-200">板卡设置</span>
                                <span className="hidden min-[1200px]:block text-[9px] text-slate-400 truncate mt-1">{getBoardName()}</span>
                            </span>
                            <SlidersHorizontal size={13} className="hidden min-[1800px]:block ml-auto text-slate-400 shrink-0" />
                        </button>

                        <div className="w-px bg-[#e3e8ef] dark:bg-slate-700" />

                        <div className="relative h-full">
                            <button
                                className="h-full w-[94px] min-[1800px]:w-[138px] px-2.5 flex items-center gap-2 text-left hover:bg-[#f5f8fa] transition-colors min-w-0 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-slate-700"
                                onClick={() => setIsPortMenuOpen(!isPortMenuOpen)}
                                disabled={isDeviceHealthRunning}
                                title={activePort || '选择串口'}
                                aria-haspopup="menu"
                                aria-expanded={isPortMenuOpen}
                            >
                                <Usb size={16} className={activePort ? 'text-[var(--accent)] shrink-0' : 'text-slate-400 shrink-0'} />
                                <span className="flex flex-col min-w-0 leading-none">
                                    <span className="hidden min-[1800px]:block text-[9px] font-semibold text-slate-400 uppercase">串口</span>
                                    <span className={`text-xs font-mono font-bold truncate ${activePort ? 'text-slate-700 min-[1800px]:mt-1 dark:text-slate-200' : 'text-slate-400 min-[1800px]:mt-1 dark:text-slate-500'}`}>
                                        {activePort || <><span className="min-[1800px]:hidden">未选</span><span className="hidden min-[1800px]:inline">未连接</span></>}
                                    </span>
                                </span>
                                <ChevronDown size={12} className="ml-auto text-slate-400 shrink-0" />
                            </button>

                            {isPortMenuOpen && (
                                <>
                                    <div className="fixed inset-0 z-40 cursor-default" onClick={() => setIsPortMenuOpen(false)} />
                                    <div className="absolute top-[calc(100%+8px)] right-0 w-72 bg-white border border-[#dce3ec] shadow-xl rounded-md z-50 py-1.5 max-h-[360px] overflow-y-auto flex flex-col animate-in fade-in zoom-in-95 duration-100 origin-top-right dark:border-slate-700 dark:bg-slate-900" role="menu">
                                        <div className="px-3 py-2 flex items-center justify-between border-b border-slate-100 dark:border-slate-800">
                                            <span className="text-[10px] font-bold uppercase text-slate-400">可用串口</span>
                                            <span className="text-[10px] font-mono text-slate-400">{ports.length}</span>
                                        </div>
                                        {ports.length === 0 && <div className="px-3 py-6 text-center text-slate-400 text-xs">未发现串口</div>}
                                        {ports.map((p: any) => (
                                            <button
                                                key={p.port_name}
                                                className={`px-3 py-2.5 flex items-center gap-3 text-left transition-colors ${activePort === p.port_name ? 'bg-brand-50 dark:bg-brand-950/45' : 'hover:bg-slate-50 dark:hover:bg-slate-800'}`}
                                                onClick={() => { connectDevice(p.port_name); setIsPortMenuOpen(false); }}
                                                disabled={isDeviceHealthRunning}
                                                role="menuitem"
                                            >
                                                <span className={`w-2 h-2 rotate-45 border shrink-0 ${activePort === p.port_name ? 'bg-brand-600 border-brand-600' : 'bg-white border-slate-300 dark:bg-slate-800 dark:border-slate-600'}`} />
                                                <span className="flex flex-col min-w-0 flex-1">
                                                    <span className="font-mono font-bold text-xs text-slate-700 dark:text-slate-200">{p.port_name}</span>
                                                    <span className="text-[10px] text-slate-400 truncate mt-0.5">{p.description || '串行设备'}</span>
                                                </span>
                                                {activePort === p.port_name && <Check size={14} className="text-[var(--accent)] shrink-0" />}
                                            </button>
                                        ))}
                                        {healthCapabilities.deviceHealth && <button
                                            type="button"
                                            data-ck-role="device-health-menu-action"
                                            className="mx-2 mt-1 flex min-h-11 items-center gap-2.5 border-t border-slate-100 px-2.5 py-2 text-left text-xs text-[var(--accent)] hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-800 dark:text-brand-300 dark:hover:bg-brand-950/45"
                                            onClick={() => void handleInspectDevice()}
                                            disabled={isDeviceHealthRunning || isCompiling || blockDebugSession.active || !activePort}
                                            role="menuitem"
                                            title="会短暂复位开发板，但不会擦除或写入 Flash"
                                        >
                                            {isDeviceHealthRunning ? <Loader2 size={15} className="shrink-0 animate-spin" /> : <HeartPulse size={15} className="shrink-0" />}
                                            <span className="flex min-w-0 flex-col">
                                                <span className="font-bold">真机体检</span>
                                                <span className="mt-0.5 truncate text-[9px] text-slate-400 dark:text-slate-500">短暂复位，不写 Flash</span>
                                            </span>
                                        </button>}
                                        {activePort && (
                                            <button disabled={isDeviceHealthRunning} className="mx-2 mt-1 px-2.5 py-2 border-t border-slate-100 text-xs text-slate-500 hover:text-red-600 flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-800 dark:text-slate-400 dark:hover:text-red-300" onClick={() => { connectDevice(''); setIsPortMenuOpen(false); }}>
                                                <XCircle size={14} /> 断开当前串口
                                            </button>
                                        )}
                                    </div>
                                </>
                            )}
                        </div>

                        <button onClick={() => scanPorts()} disabled={isDeviceHealthRunning} className="w-9 h-full flex items-center justify-center text-slate-400 hover:text-[var(--accent)] hover:bg-[#f5f8fa] border-l border-[#e3e8ef] rounded-r-md transition-colors disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-500 dark:hover:bg-slate-700 dark:hover:text-brand-300" title="刷新串口" aria-label="刷新串口">
                            <RefreshCw size={14} />
                        </button>
                    </div>

                    <button
                        type="button"
                        data-ck-role="engineering-health-button"
                        onClick={openEngineeringHealth}
                        className="relative inline-flex h-9 w-9 shrink-0 items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-white text-slate-600 transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 min-[1500px]:w-auto min-[1500px]:px-2.5 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-brand-700 dark:hover:bg-brand-950/45 dark:hover:text-brand-300"
                        title={healthTranslate('productV2.checkHint')}
                        aria-label={healthTranslate('productV2.check')}
                        aria-expanded={isEngineeringHealthOpen}
                    >
                        <HeartPulse size={16} />
                        <span className="hidden whitespace-nowrap text-xs font-bold min-[1500px]:inline">{healthTranslate('productV2.check')}</span>
                        {hasEngineeringHealthResults && (
                            <span
                                className={`absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full ring-2 ring-white dark:ring-slate-900 ${engineeringHealthHasProblem ? 'bg-red-500' : engineeringHealthNeedsAttention ? 'bg-amber-500' : 'bg-emerald-500'}`}
                                aria-hidden="true"
                            />
                        )}
                    </button>

                    {healthCapabilities.deviceHealth && <button
                        type="button"
                        data-ck-role="device-health-button"
                        onClick={() => void handleInspectDevice()}
                        disabled={isDeviceHealthRunning || isCompiling || blockDebugSession.active || !activePort}
                        className="hidden min-[1500px]:inline-flex h-10 items-center justify-center gap-1.5 rounded-md border border-brand-200 bg-brand-50 px-2.5 text-xs font-bold whitespace-nowrap text-[var(--accent)] transition-colors hover:bg-brand-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-brand-800 dark:bg-brand-950/40 dark:text-brand-300 dark:hover:bg-brand-950/65"
                        title={activePort ? '会短暂复位开发板，但不会擦除或写入 Flash' : '请先选择串口'}
                    >
                        {isDeviceHealthRunning ? <Loader2 size={16} className="animate-spin" /> : <HeartPulse size={16} />}
                        <span>{isDeviceHealthRunning ? '体检中' : '真机体检'}</span>
                    </button>}

                    <div className="flex shrink-0 items-center gap-1">
                        <div className="relative shrink-0" data-ck-role="build-action-group">
                            <div className="inline-flex h-10 overflow-hidden rounded-md border border-slate-300 shadow-sm dark:border-slate-600">
                                <button
                                    type="button"
                                    data-ck-role="build-compile-action"
                                    onClick={() => {
                                        setIsBuildMenuOpen(false);
                                        setIsFileMenuOpen(false);
                                        setIsPortMenuOpen(false);
                                        setIsViewMenuOpen(false);
                                        handleCompileAndUpload(false);
                                    }}
                                    disabled={isCompiling || isBuildPreparing || isDeviceHealthRunning || blockDebugSession.active}
                                    className="flex h-full items-center justify-center gap-1.5 whitespace-nowrap bg-white px-2.5 text-slate-700 transition-colors hover:bg-slate-50 focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                                    title={buildT('toolbar.compileOnlyHint')}
                                >
                                    {isCompiling || isBuildPreparing ? <BuildActivitySpinner /> : <CheckCircle size={17} />}
                                    <span className="text-xs font-bold">{isBuildPreparing ? buildT('toolbar.preparing') : buildT('toolbar.compile')}</span>
                                </button>
                                <button
                                    type="button"
                                    data-ck-role="build-normal-upload-action"
                                    onClick={() => {
                                        setIsBuildMenuOpen(false);
                                        setIsFileMenuOpen(false);
                                        setIsViewMenuOpen(false);
                                        if (!activePort) {
                                            setIsPortMenuOpen(true);
                                            return;
                                        }
                                        setIsPortMenuOpen(false);
                                        handleCompileAndUpload(true, { uploadMode: 'normal' });
                                    }}
                                    disabled={isCompiling || isBuildPreparing || isDeviceHealthRunning || blockDebugSession.active}
                                    className="flex h-full items-center justify-center gap-1.5 whitespace-nowrap border-l border-slate-300 bg-brand-600 px-2.5 text-white transition-colors hover:bg-brand-700 focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-300 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600"
                                    title={activePort ? buildT('toolbar.normalUploadHint') : buildT('toolbar.selectPort')}
                                >
                                    {isCompiling || isBuildPreparing ? <BuildActivitySpinner /> : <Upload size={17} />}
                                    <span className="text-xs font-bold">{buildT('toolbar.upload')}</span>
                                </button>
                                <button
                                    type="button"
                                    data-ck-role="build-special-upload-trigger"
                                    onClick={() => {
                                        setIsFileMenuOpen(false);
                                        setIsPortMenuOpen(false);
                                        setIsViewMenuOpen(false);
                                        setIsBuildMenuOpen(value => !value);
                                    }}
                                    disabled={isCompiling || isBuildPreparing || isDeviceHealthRunning || blockDebugSession.active}
                                    className="flex h-full w-8 shrink-0 items-center justify-center border-l border-brand-600 bg-brand-600 text-white transition-colors hover:bg-brand-700 focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-300 disabled:cursor-not-allowed disabled:opacity-50"
                                    title={buildT('toolbar.debugOptions')}
                                    aria-label={buildT('toolbar.moreUploadActions')}
                                    aria-haspopup="menu"
                                    aria-expanded={isBuildMenuOpen}
                                >
                                    <ChevronDown size={13} className={`transition-transform ${isBuildMenuOpen ? 'rotate-180' : ''}`} />
                                </button>
                            </div>
                            {isBuildMenuOpen && (
                                <>
                                    <div className="fixed inset-0 z-40" onClick={() => setIsBuildMenuOpen(false)} />
                                    <div
                                        data-ck-role="build-special-upload-menu"
                                        className="absolute right-0 top-[calc(100%+8px)] z-50 w-44 max-w-[calc(100vw-1rem)] rounded-md border border-slate-200 bg-white p-1 shadow-xl dark:border-slate-700 dark:bg-slate-900"
                                        role="menu"
                                        aria-label={buildT('toolbar.moreUploadActions')}
                                    >
                                        <button
                                            type="button"
                                            data-ck-role="build-debug-upload-action"
                                            onClick={() => {
                                                setIsBuildMenuOpen(false);
                                                setIsFileMenuOpen(false);
                                                setIsPortMenuOpen(false);
                                                setIsViewMenuOpen(false);
                                                void handleStartBlockDebug();
                                            }}
                                            className="flex min-h-9 w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-200 dark:hover:bg-slate-800"
                                            disabled={!activePort || liveBreakpointIds.length === 0 || isCompiling || isDeviceHealthRunning || blockDebugSession.active}
                                            role="menuitem"
                                            title={!activePort
                                                ? buildT('toolbar.selectPort')
                                                : liveBreakpointIds.length > 0
                                                    ? buildT('toolbar.debugUploadWithBreakpoints', { count: liveBreakpointIds.length })
                                                    : buildT('toolbar.debugUploadNeedsBreakpoint')}
                                        >
                                            <Bug size={15} className="shrink-0 text-brand-600 dark:text-brand-300" />
                                            <span className="min-w-0 flex-1">{buildT('toolbar.debugUpload')}</span>
                                            {liveBreakpointIds.length > 0 && (
                                                <span className="min-w-4 h-4 shrink-0 rounded-full bg-brand-600 px-1 text-center text-[9px] leading-4 text-white">
                                                    {liveBreakpointIds.length}
                                                </span>
                                            )}
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                        {isCompiling && (
                            <button data-ck-role="build-cancel-action" onClick={handleCancel} className="h-10 px-2.5 bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 rounded-md flex items-center justify-center gap-1.5 transition-colors dark:border-red-900 dark:bg-red-950/45 dark:text-red-300 dark:hover:bg-red-950/70" title={buildT('toolbar.cancelOperation')} aria-label={buildT('toolbar.cancelOperation')}>
                                <Ban size={16} />
                                <span className="text-xs font-bold">{buildT('toolbar.cancel')}</span>
                            </button>
                        )}
                    </div>

                    <button type="button" data-ck-role="ai-assistant-trigger" aria-label="打开 CK AI 积木助手" aria-expanded={aiOpen}
                        onClick={() => aiOpen ? setAiOpen(false) : openAi()}
                        className={`h-10 shrink-0 rounded-md border px-2.5 flex items-center gap-1.5 text-xs font-semibold transition-colors ${aiOpen ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-700 dark:bg-brand-950 dark:text-brand-300' : 'border-slate-200 text-slate-600 hover:bg-brand-50 hover:text-brand-700 dark:border-slate-700 dark:text-slate-300'}`}>
                        <Sparkles size={16} /><span>AI</span>
                    </button>
                    <div className="hidden min-[1800px]:flex items-center h-10 p-0.5 bg-[#f1f4f8] border border-[#e1e7ef] rounded-md dark:border-slate-700 dark:bg-slate-800">
                        <button onClick={toggleSerialMonitor} disabled={isSerialMonitorSwitching || isDeviceHealthRunning} className={`h-9 px-2.5 rounded flex items-center gap-1.5 text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-wait ${isSerialMonitorOpen ? 'bg-white text-[var(--accent)] dark:bg-slate-700 dark:text-brand-300' : 'text-slate-500 hover:text-slate-900 hover:bg-white dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100'}`} title={isDeviceHealthRunning ? '真机体检期间串口由体检独占' : isSerialMonitorSwitching ? '正在应用串口设置' : isSerialMonitorOpen ? '关闭串口监视器' : '打开串口监视器'}>
                            <Monitor size={16} /> 串口监视
                        </button>
                        <button onClick={toggleCodeView} className={`h-9 px-2.5 rounded flex items-center gap-1.5 text-xs font-semibold transition-colors ${codeViewOpen ? 'bg-white text-slate-900 dark:bg-slate-700 dark:text-slate-100' : 'text-slate-500 hover:text-slate-900 hover:bg-white dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100'}`} title={codeViewOpen ? '隐藏代码预览' : '显示代码预览'}>
                            <Code size={16} /> 代码预览
                        </button>
                        <button
                            onClick={() => void handleStartBlockTrace()}
                            disabled={isCompiling || isDeviceHealthRunning || blockDebugSession.active}
                            className="h-9 px-2.5 rounded flex items-center gap-1.5 text-xs font-semibold text-emerald-700 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 dark:text-emerald-300 dark:hover:bg-slate-700"
                            title="运行轨迹：上传采样固件，不暂停开发板程序"
                        >
                            <Activity size={16} /> 运行轨迹
                        </button>
                        <button
                            type="button"
                            data-ck-role="workspace-display-mode"
                            onClick={() => applyWorkspaceDisplayMode(workspaceDisplayMode === 'simple' ? 'engineering' : 'simple')}
                            className="h-9 rounded px-2.5 text-xs font-semibold text-slate-500 transition-colors hover:bg-white hover:text-brand-700 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-brand-300"
                            title={healthTranslate(`experience.modeDescription.${workspaceDisplayMode}`)}
                        >
                            {healthTranslate(`view.${workspaceDisplayMode}`)}
                        </button>
                    </div>

                    <div className="relative shrink-0">
                        <button onClick={() => setIsViewMenuOpen((value) => !value)} className="h-10 px-2.5 border border-[#dce3ec] bg-white rounded-md flex items-center gap-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700" aria-haspopup="menu" aria-expanded={isViewMenuOpen}>
                            <Code size={16} /> 视图 <ChevronDown size={12} />
                        </button>
                        {isViewMenuOpen && (
                            <>
                                <div className="fixed inset-0 z-40" onClick={() => setIsViewMenuOpen(false)} />
                                <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-56 max-h-[calc(100vh-88px)] overflow-y-auto bg-white border border-[#dce3ec] shadow-xl rounded-md p-1 dark:border-slate-700 dark:bg-slate-900" role="menu">
                                    <button
                                        type="button"
                                        data-ck-role="engineering-health-menu-action"
                                        onClick={() => runViewMenuAction(openEngineeringHealth)}
                                        className="w-full h-9 px-2.5 rounded flex items-center gap-2 text-xs font-semibold text-brand-700 hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-950/45"
                                        role="menuitem"
                                    >
                                        <HeartPulse size={15} /> {healthTranslate('productV2.check')}
                                    </button>
                                    <button
                                        type="button"
                                        data-ck-action={isConsoleDetached ? 'focus-detached-serial-console' : 'toggle-serial-monitor-from-view-menu'}
                                        onClick={() => runViewMenuAction(() => {
                                            if (isConsoleDetached) {
                                                void openDetachedConsole();
                                                return;
                                            }
                                            void toggleSerialMonitor();
                                        })}
                                        disabled={!isConsoleDetached && (isSerialMonitorSwitching || isDeviceHealthRunning)}
                                        className="w-full h-9 px-2.5 rounded flex items-center gap-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-800"
                                        role="menuitem"
                                    >
                                        {isConsoleDetached ? <ExternalLink size={15} /> : <Monitor size={15} />}
                                        {isConsoleDetached ? '聚焦串口浮窗' : isSerialMonitorOpen ? '关闭串口监视' : '打开串口监视'}
                                    </button>
                                    <button onClick={() => runViewMenuAction(toggleCodeView)} className="w-full h-9 px-2.5 rounded flex items-center gap-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800" role="menuitem">
                                        <Code size={15} /> {codeViewOpen ? '隐藏代码预览' : '显示代码预览'}
                                    </button>
                                    <button
                                        onClick={() => runViewMenuAction(() => void handleStartBlockTrace())}
                                        disabled={isCompiling || isDeviceHealthRunning || blockDebugSession.active}
                                        className="w-full h-9 px-2.5 rounded flex items-center gap-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
                                        role="menuitem"
                                        title="上传采样固件，不暂停开发板程序"
                                    >
                                        <Activity size={15} /> 运行轨迹（上传）
                                    </button>
                                    <div className="my-1 border-t border-slate-100 dark:border-slate-700" />
                                    <div className="px-2.5 pb-1 pt-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                                        {healthTranslate('experience.displayMode')}
                                    </div>
                                    {([
                                        ['simple', '简洁视图', '日常结果与需要处理的问题'],
                                        ['engineering', '工程视图', '完整 FQBN、缓存与证据细节'],
                                    ] as const).map(([mode, label, description]) => (
                                        <button
                                            key={mode}
                                            type="button"
                                            data-ck-role={'workspace-display-mode-' + mode}
                                            onClick={() => runViewMenuAction(() => applyWorkspaceDisplayMode(mode))}
                                            className={'min-h-11 w-full rounded px-2.5 py-1.5 text-left transition-colors ' + (workspaceDisplayMode === mode
                                                ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/35 dark:text-brand-200'
                                                : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800')}
                                            role="menuitemradio"
                                            aria-checked={workspaceDisplayMode === mode}
                                        >
                                            <span className="flex items-center gap-2 text-xs font-semibold">
                                                <SlidersHorizontal size={14} />
                                                <span className="flex-1">{healthTranslate(`view.${mode}`, { defaultValue: label })}</span>
                                                {workspaceDisplayMode === mode && <Check size={13} />}
                                            </span>
                                            <span className="mt-0.5 block pl-[22px] text-[9px] opacity-70">{healthTranslate(`experience.modeDescription.${mode}`, { defaultValue: description })}</span>
                                        </button>
                                    ))}
                                    <div className="my-1 border-t border-slate-100 dark:border-slate-700" />
                                    <button
                                        type="button"
                                        data-ck-role="appearance-settings-action"
                                        onClick={() => runViewMenuAction(() => {
                                            workspaceRef.current?.hideChaff();
                                            setIsAppearanceSettingsOpen(true);
                                        })}
                                        className="flex min-h-11 w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-slate-600 transition-colors hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800"
                                        role="menuitem"
                                    >
                                        <Palette size={15} className="shrink-0" />
                                        <span className="min-w-0 flex-1">
                                            <strong className="block text-xs font-semibold">{t('settings.appearance.menuTitle')}</strong>
                                            <small className="mt-0.5 block text-[9px] opacity-70">{t('settings.appearance.menuDescription')}</small>
                                        </span>
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </header>

            {currentPath && !projectLoadProgress && !projectLoadSafetyError && (
                buildTargetDifference || !recordedBuildTarget || !recordedBuildTarget.coreVersion || !recordedBuildTarget.optionsComplete
            ) && <div data-ck-build-target-notice role="status" className="flex shrink-0 flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
                <span className="flex-1">{buildTargetDifference
                    ? `${buildTargetDifference} 已保留原配置，编译和上传需要先确认。`
                    : '此工程尚未完整记录 Core 版本或默认参数；环境就绪后保存，即可补齐。'}</span>
                <button type="button" className="underline" onClick={() => setIsConfigOpen(true)}>查看板卡设置</button>
                {buildTargetDifference && <button type="button" onClick={adoptCurrentBuildEnvironment}
                    disabled={!buildEnvironment.resolved || !activeCoreVersion || isCompiling}
                    className="rounded border border-amber-400 px-2 py-1 font-semibold disabled:opacity-40">采用当前环境</button>}
            </div>}
            {/* Main Content */}
            <div className={`ck-workspace-main flex flex-1 min-h-0 overflow-hidden min-w-0 w-full max-w-full relative z-0 transition-all duration-300 ${isConfigOpen ? 'blur-[2px] opacity-90' : ''} `}>
                {/* Sidebar with Categories */}
                {/* ... (Categories logic is inside Blockly, but if there's a custom sidebar, handle it here) ... */}
                {/* In this project, the categories in the screenshot are likely the Blockly Toolbox. 
                    If they are not blurring, it might be because they are positioned absolutely outside this div.
                    HOWEVER, looking at the code structure:
                */}
                <div className="ck-workspace-stage flex-1 min-w-0 min-h-0 relative bg-[#fbfcfe] overflow-hidden flex flex-col transition-colors dark:bg-[#0b1220]">
                    <div className="absolute inset-0" ref={blocklyDiv} style={{ touchAction: 'none' }}></div>
                    <BlockDock
                        resourceView={hardwareResourceInspector}
                        workspace={blocklyWorkspace}
                        renderer={blocklyRendererForVisualStyle(blocklyVisualStyle)}
                        theme={getBlocklyVisualTheme(blocklyVisualStyle, resolvedTheme)}
                        visualStyle={blocklyVisualStyle}
                        disabled={Boolean(projectLoadProgress || unknownBlockProtection || projectLoadSafetyError || rendererRecoveryFailure)}
                        onNotice={(message, type) => showToast(message, type)}
                    />
                    {projectLoadProgress && (
                        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-950/50" data-ck-role="project-load-progress" role="dialog" aria-modal="true" aria-label={t('workspacePerformance.loading')}>
                            <div className="w-96 max-w-[90vw] rounded-xl border border-slate-300 bg-white p-6 shadow-xl dark:border-slate-700 dark:bg-slate-900">
                                <h2 className="font-semibold text-slate-900 dark:text-white">{t('workspacePerformance.loading')}</h2>
                                <p className="mt-3 text-sm text-slate-600 dark:text-slate-300" role="status">{projectLoadProgress.phase === 'code'
                                    ? t('workspacePerformance.preparingCode')
                                    : t('workspacePerformance.loadProgress', { completed: projectLoadProgress.completed.toLocaleString(), total: projectLoadProgress.total.toLocaleString() })}</p>
                                <progress className="mt-4 w-full" max={projectLoadProgress.total} value={projectLoadProgress.completed} />
                                <button type="button" autoFocus onClick={() => projectLoadControllerRef.current?.abort()} className="mt-4 rounded border border-slate-300 px-4 py-2 text-sm dark:border-slate-600 dark:text-slate-200">{t('workspacePerformance.cancelLoad')}</button>
                            </div>
                        </div>
                    )}
                    {unknownBlockProtection && (
                        <UnknownBlocksProtectionPanel
                            projectName={unknownBlockProtection.projectName}
                            inspection={unknownBlockProtection.inspection}
                            onOpenLibraryManager={() => setIsLibManagerOpen(true)}
                            onRetry={retryProtectedProjectLoad}
                            onShowOriginal={() => void showProtectedProjectInFolder()}
                            onExportRawWorkspace={() => void exportProtectedRawWorkspace()}
                        />
                    )}
                    {!unknownBlockProtection && projectLoadSafetyError && (
                        <div className="absolute inset-0 z-[45] flex items-center justify-center overflow-auto bg-slate-50 p-5 dark:bg-[#0b1220]" data-ck-role="project-load-safety-error">
                            <div className="w-full max-w-xl rounded-2xl border border-red-200 bg-white p-6 shadow-xl dark:border-red-900 dark:bg-slate-900">
                                <div className="flex items-start gap-3">
                                    <div className="rounded-xl bg-red-100 p-3 text-red-700 dark:bg-red-950/50 dark:text-red-300"><AlertTriangle size={24} /></div>
                                    <div>
                                        <h2 className="text-lg font-black text-slate-900 dark:text-white">工程已停止载入</h2>
                                        <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{projectLoadSafetyError}</p>
                                    </div>
                                </div>
                                <div className="mt-5 flex flex-wrap gap-2">
                                    <button type="button" onClick={retryProtectedProjectLoad} className="inline-flex h-10 items-center gap-2 rounded-lg bg-red-600 px-3 text-sm font-bold text-white hover:bg-red-700"><RefreshCw size={15} />重新读取</button>
                                    <button type="button" onClick={() => void showProtectedProjectInFolder()} className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"><FolderOpen size={15} />显示原工程</button>
                                </div>
                            </div>
                        </div>
                    )}
                    {rendererRecoveryFailure && (
                        <div
                            className="absolute inset-0 z-[55] flex items-center justify-center overflow-auto bg-slate-50/95 p-5 dark:bg-[#0b1220]/95"
                            data-ck-role="blockly-renderer-recovery-failure"
                        >
                            <div className="w-full max-w-xl rounded-2xl border border-amber-300 bg-white p-6 shadow-2xl dark:border-amber-700 dark:bg-slate-900">
                                <div className="flex items-start gap-3">
                                    <div className="rounded-xl bg-amber-100 p-3 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"><AlertTriangle size={24} /></div>
                                    <div>
                                        <h2 className="text-lg font-black text-slate-900 dark:text-white">积木外观恢复已停止</h2>
                                        <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{rendererRecoveryFailure.message}</p>
                                        <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">切换前的完整工作区快照仍保留在当前会话中；在恢复完成前，CK 不允许编辑、保存、编译或上传。</p>
                                    </div>
                                </div>
                                <div className="mt-5 flex flex-wrap gap-2">
                                    <button type="button" onClick={retryBlocklyRendererRecovery} className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-600 px-3 text-sm font-bold text-white hover:bg-brand-700"><RefreshCw size={15} />重试恢复</button>
                                    <button type="button" onClick={() => void exportBlocklyRendererRecoverySnapshot()} className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"><ArchiveRestore size={15} />导出恢复快照</button>
                                </div>
                            </div>
                        </div>
                    )}
                    <div
                        className={`ck-toolbox-search-dock-overlay ${isBlockSearchActive ? 'is-active' : ''}`}
                        role="search"
                        aria-label={blockSearchResultCount == null
                            ? editorTranslate('blockDock.blockSearch.aria')
                            : editorTranslate('blockDock.blockSearch.resultCount', { count: blockSearchResultCount })}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => event.stopPropagation()}
                    >
                        <Search size={15} className="ck-toolbox-search-icon" aria-hidden="true" />
                        <input
                            ref={blockSearchInputRef}
                            value={blockSearchQuery}
                            onChange={(event) => setBlockSearchQuery(event.target.value)}
                            onFocus={() => setIsBlockSearchActive(true)}
                            onKeyDown={(event) => {
                                if (event.key !== 'Escape') return;
                                setBlockSearchQuery('');
                                setBlockSearchResultCount(null);
                                setIsBlockSearchActive(false);
                                runGlobalBlockSearch('');
                                blockSearchInputRef.current?.blur();
                            }}
                            className="ck-toolbox-search-dock-input"
                            data-ck-role="global-block-search"
                            placeholder={editorTranslate('blockDock.blockSearch.placeholder')}
                            aria-label={editorTranslate('blockDock.blockSearch.aria')}
                            autoComplete="off"
                            spellCheck={false}
                        />
                        {blockSearchQuery && blockSearchResultCount != null && (
                            <span className="ck-toolbox-search-result-count" aria-live="polite">
                                {blockSearchResultCount}
                            </span>
                        )}
                        {blockSearchQuery && (
                            <button
                                type="button"
                                className="ck-toolbox-search-clear"
                                onClick={() => {
                                    setBlockSearchQuery('');
                                    setBlockSearchResultCount(null);
                                    runGlobalBlockSearch('');
                                    blockSearchInputRef.current?.focus();
                                }}
                                title={editorTranslate('blockDock.blockSearch.clear')}
                                aria-label={editorTranslate('blockDock.blockSearch.clear')}
                            >
                                <X size={13} />
                            </button>
                        )}
                    </div>
                    {toolboxLoading && (
                        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 bg-white/90 backdrop-blur-sm shadow-md rounded-full px-4 py-1.5 flex items-center gap-2 text-xs text-slate-500 border border-slate-200 animate-in fade-in duration-200 dark:border-slate-700 dark:bg-slate-900/90 dark:text-slate-400">
                            <Loader2 size={12} className="animate-spin text-brand-500" />
                            {editorTranslate('blockDock.toolbox.loading')}
                        </div>
                    )}
                </div>

                <AiAssistantPanel open={aiOpen} intent={aiIntent} projectPath={currentPath || undefined}
                    sessionKey={JSON.stringify([currentPath, nativeBuildProjectRef.current, activeBoardPackageId])}
                    projectKey={currentPath ? `file:${currentPath.replace(/\\/g,'/').toLowerCase()}` : `unsaved:${nativeBuildProjectRef.current}`}
                    host={{
                        workspace: () => workspaceRef.current,
                        catalog: () => window.CK_BLOCK_CATALOG?.blocks || [],
                        target: () => captureBuildTarget(),
                        boardProfile: (): AiBoardProfile => {
                            const target = captureBuildTarget();
                            const isCustom = activeBoardPackage?.is_custom === true || target.boardPackageId !== target.board;
                            const pinBoard = createPinBoardCatalog(availableBoards, activeBoardPackage,
                                target.boardPackageId, target.fqbn, installedCorePinAliases).find(board =>
                                    baseBoardFqbn(board.fqbn) === target.board
                                    && (isCustom ? board.packageId === target.boardPackageId : !board.isCustom));
                            return { board: target.board, boardPackageId: target.boardPackageId,
                                name: activeBoardPackage?.name || target.board, version: activeBoardPackage?.version,
                                isCustom, pins: pinBoard?.pins || [], pinSource: pinBoard?.pinEvidenceLevel || (pinBoard ? 'basic' : 'unknown'),
                                resourceGraph: activeBoardPackage?.resource_graph,
                                declarationIdentity: JSON.stringify([target.board, target.boardPackageId, isCustom,
                                    activeBoardPackage?.name, activeBoardPackage?.version, activeBoardPackage?.pins,
                                    activeBoardPackage?.resource_graph, activeBoardPackageBuildGate.canBuild,
                                    activeBoardPackageBuildGate.canBuild ? null : activeBoardPackageBuildGate.reason]),
                                compileBlockedReason: activeBoardPackageBuildGate.canBuild ? undefined : activeBoardPackageBuildGate.reason };
                        },
                        identity: () => JSON.stringify([currentPath, nativeBuildProjectRef.current, captureBuildTarget(), window.CK_BLOCK_CATALOG?.generatedAt]),
                        projectIdentity: () => JSON.stringify([currentPath, nativeBuildProjectRef.current, captureBuildTarget()]),
                        libraryInventory: () => enabledBlockPackageInventoryRef.current,
                        diagnostics: () => ({ scope: '上次编译结果，不代表当前修改已通过', issues: compileIssues.map(issue => ({ title: issue.title, diagnostic: issue.rawDiagnostic, blockId: issue.blockContext?.blockId })) }),
                        validateBehavior: validateAiBehavior,
                        library: createAiLibraryHost({ target: captureBuildTarget, reload: async (preview, verify) => {
                            await loadExtensionsForBoard(activeBoard, activeBoardPackageId, activeBoardPackageBuildGate.canBuild, activeBoardPackage?.is_custom === true);
                            const deadline = Date.now() + 5000;
                            // An overlapping board/library refresh can supersede this
                            // reload. Wait for both the inventory and rendered catalog,
                            // including when rolling an unsuccessful installation back.
                            while (true) {
                                const installed = enabledBlockPackageInventoryRef.current.find(entry => entry.packageId === preview.packageId && entry.contentSha256 === preview.contentSha256);
                                const catalog = window.CK_BLOCK_CATALOG?.blocks || [];
                                const ready = verify
                                    ? installed && preview.types.every(type => Blockly.Blocks[type] && arduinoGenerator.forBlock[type] && catalog.some(b => b.type === type && b.library_id === preview.packageId))
                                    : !installed && !catalog.some(b => b.library_id === preview.packageId);
                                if (ready) return;
                                if (Date.now() >= deadline) throw Error(verify ? '新库未完整加载，正在回滚安装' : '库已撤回，但积木目录尚未刷新，请重新打开工程');
                                await new Promise(resolve => setTimeout(resolve, 50));
                            }
                        } }),
                        inspectCandidate: preview => generateAiCandidate(preview, candidate => {
                            try { return arduinoGenerator.workspaceToCode(candidate); }
                            finally { if (workspaceRef.current) arduinoGenerator.workspaceToCode(workspaceRef.current); }
                        }).code,
                        validateCandidate: (preview, context) => compileAiCandidate({ preview, ...context, target: captureBuildTarget(),
                            generate: candidate => {
                                try { return arduinoGenerator.workspaceToCode(candidate); }
                                finally { if (workspaceRef.current) arduinoGenerator.workspaceToCode(workspaceRef.current); }
                            } }),
                    }}
                    boardLabel={`${activeBoard}${activeCoreVersion ? ` · ${activeCoreVersion}` : ''}`}
                    disabledReason={projectLoadProgress || unknownBlockProtection || projectLoadSafetyError || rendererRecoveryFailure ? '工程正在载入或处于保护状态，请先处理。' : !buildEnvironment.resolved ? '板卡参数尚未就绪，请先完成板卡设置。' : isCompiling || isBuildPreparing ? '正在编译或上传，完成后可继续发送或应用修改。' : blockDebugSession.active ? '调试中，请先结束调试。' : undefined}
                    onClose={() => setAiOpen(false)} onCode={toggleCodeView}
                    onLayout={() => { if (workspaceRef.current) Blockly.svgResize(workspaceRef.current); }}
                    beforeApply={() => captureWorkspaceCheckpoint('AI 修改前')}
                    onCompile={async () => ({ ok: await handleCompileAndUpload(false), log: compileLogRef.current })}
                />
                {/* Right: Code Preview */}
                {codeViewOpen && (
                    <CodePreviewDock onLayout={() => { if (workspaceRef.current) Blockly.svgResize(workspaceRef.current); }}>
                        <div className="h-10 bg-[#f4f7fa] border-b border-[#dce3ec] flex items-center justify-between px-3 shrink-0 dark:border-slate-700 dark:bg-slate-900">
                            <div className="flex items-center gap-2 min-w-0">
                                <Code size={14} className="text-[var(--accent)]" />
                                <span className="text-[10px] font-bold text-slate-500 uppercase">生成代码</span>
                                <span className="text-[9px] font-mono text-slate-400">sketch.ino</span>
                            </div>
                            <div className="flex items-center gap-0.5">
                                <button disabled={codePreviewPending} className="w-7 h-7 flex items-center justify-center rounded text-slate-400 hover:text-[var(--accent)] hover:bg-white dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-brand-300 disabled:opacity-40" onClick={async () => { try { await navigator.clipboard.writeText(sourceWithBuildTarget(userReadableCode, captureBuildTarget())); showToast('代码已复制，已附带板卡配置注释', 'success'); } catch { showToast('复制失败，请重试', 'error'); } }} title="复制代码（含板卡配置注释）" aria-label="复制代码">
                                    <Copy size={13} />
                                </button>
                                <button className="w-7 h-7 flex items-center justify-center rounded text-slate-400 hover:text-slate-800 hover:bg-white dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-100" onClick={() => setCodeViewOpen(false)} title="关闭代码预览" aria-label="关闭代码预览">
                                    <X size={14} />
                                </button>
                            </div>
                        </div>
                        <div className="min-h-0 min-w-0 flex-1 font-mono text-xs overflow-hidden bg-[#f8fafc] relative dark:bg-[#0b1220]">
                            {codePreviewPending && <div role="status" className="absolute top-0 right-0 z-10 rounded bg-slate-100 px-3 py-1 dark:bg-slate-800">{t(codePreviewError ? 'workspacePerformance.previewFailed' : 'workspacePerformance.previewUpdating')}</div>}
                            {userReadableCode.length > 100000 ? <LargeCodePreview code={userReadableCode} /> : <SyntaxHighlighter
                                language="cpp"
                                style={resolvedTheme === 'dark' ? vscDarkPlus : vs}
                                customStyle={{
                                    margin: 0,
                                    padding: '1rem',
                                    height: '100%',
                                    fontSize: '12px',
                                    backgroundColor: resolvedTheme === 'dark' ? '#0b1220' : '#f8fafc'
                                }}
                                showLineNumbers={true}
                                lineNumberStyle={{
                                    minWidth: '2em',
                                    paddingRight: '1em',
                                    color: resolvedTheme === 'dark' ? '#475569' : '#cbd5e1',
                                }}
                            >
                                {userReadableCode}
                            </SyntaxHighlighter>}
                        </div>
                    </CodePreviewDock>
                )}

                {isEngineeringHealthOpen && (
                    <EngineeringHealthDock
                        onOpenLibraries={() => setIsLibManagerOpen(true)}
                        onOpenCheckpoints={() => setIsCheckpointsOpen(true)}
                        onOpenLastWorking={() => setIsLastWorkingVersionOpen(true)}
                        width={engineeringHealthWidth}
                        onWidthChange={setEngineeringHealthWidth}
                        onResizeStart={() => workspaceRef.current?.hideChaff()}
                        onClose={() => setIsEngineeringHealthOpen(false)}
                        compileDoctorReport={compileDoctorReport}
                        deviceHealthReport={currentDeviceHealthReport}
                        compileResourceReport={compileResourceReport}
                        pinPreflightReport={pinPreflightReport}
                        hardwareResourceInspector={hardwareResourceInspector}
                        resourcePreflightReport={resourcePreflightReport}
                        isResourcePreflightRunning={isResourcePreflightRunning}
                        onCompileForResources={() => { void handleCompileAndUpload(false); }}
                        compileIssues={compileIssues}
                        fqbn={effectiveCompileFqbn}
                        coreVersion={activeCoreVersion}
                        customBoard={activeBoardPackage?.is_custom === true}
                        configurationFqbn={displayConfigurationFqbn}
                        configurationSource={boardOptionsStatus}
                        displayMode={workspaceDisplayMode}
                        isCompiling={isCompiling}
                        isDeviceHealthRunning={isDeviceHealthRunning}
                        onLocateBlock={(blockId) => {
                            window.requestAnimationFrame(() => {
                                locateWorkspaceBlock(blockId);
                            });
                        }}
                        onIssueAction={(action, issue) => {
                            if (action.kind !== 'show_resources') {
                                setIsEngineeringHealthOpen(false);
                            }
                            void handleCompileIssueAction(action, issue);
                        }}
                    />
                )}
            </div>

            {/* Bottom: Console / Serial Monitor */}
            {consoleOpen ? (
                <div
                    className="ck-console-panel ck-serial-console-panel bg-[#fbfcfe] border-t border-[#dce3ec] flex flex-col shrink-0 relative dark:border-slate-700 dark:bg-slate-950"
                    data-expanded={consoleExpanded}
                    style={{ height: consoleExpanded ? 'clamp(180px, calc(100vh - 420px), 340px)' : 'clamp(144px, 22vh, 176px)', maxHeight: '45%' }}
                >
                    {/* Toolbar */}
                    <div className="ck-serial-console-toolbar h-9 bg-[#f4f7fa] flex items-center px-2 select-none border-b border-[#dce3ec] shrink-0 min-w-0 dark:border-slate-700 dark:bg-slate-900">
                        <div className="ck-serial-toolbar-scroll flex flex-1 min-w-0 h-full items-center overflow-x-auto overflow-y-hidden">
                        <div className="flex items-center text-slate-500 h-full shrink-0">
                            <button
                                onClick={() => setConsoleTab('serial')}
                                className={`ck-serial-console-tab flex items-center gap-1.5 px-3 h-full transition-colors border-b-2 ${consoleTab === 'serial' ? 'is-active border-brand-600 text-[var(--accent)] bg-white dark:bg-slate-800 dark:text-brand-300' : 'border-transparent hover:bg-white/70 dark:hover:bg-slate-800/70'}`}
                            >
                                <Terminal size={14} />
                                <span className="text-xs font-bold whitespace-nowrap">串口监视器</span>
                            </button>
                            <button
                                onClick={() => setConsoleTab('compile')}
                                className={`ck-serial-console-tab ck-serial-console-tab-compile flex items-center gap-1.5 px-3 h-full transition-colors border-b-2 ${consoleTab === 'compile' ? 'is-active border-[#2563eb] text-[#1d4ed8] bg-white dark:bg-slate-800 dark:text-blue-300' : 'border-transparent hover:bg-white/70 dark:hover:bg-slate-800/70'}`}
                            >
                                <Cpu size={14} />
                                <span className="text-xs font-bold whitespace-nowrap">输出日志</span>
                            </button>
                        </div>

                        <div className="ml-auto pl-3 flex items-center gap-2 shrink-0">
                            {consoleTab === 'serial' && (
                                <>
                                    <label className="ck-serial-setting-label flex items-center gap-1 text-[10px] font-bold text-slate-500 whitespace-nowrap" title="当前串口端口">
                                        <span>端口</span>
                                        <select
                                            className="ck-serial-control-select h-7 min-w-[92px] max-w-[150px] text-xs text-slate-700 border border-slate-200 rounded bg-white outline-none cursor-pointer font-mono px-1 focus:border-brand-500 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                                            value={activePort || ''}
                                            disabled={isSerialMonitorSwitching || isDeviceHealthRunning}
                                            onChange={(event) => connectDevice(event.target.value)}
                                        >
                                            <option value="">未选择</option>
                                            {ports.map((port) => (
                                                <option key={port.port_name} value={port.port_name}>
                                                    {port.port_name}
                                                </option>
                                            ))}
                                        </select>
                                    </label>

                                    <label className="ck-serial-setting-label flex items-center gap-1 text-[10px] font-bold text-slate-500 whitespace-nowrap" title="串口波特率">
                                        <span>波特率</span>
                                        <select
                                            className="ck-serial-control-select h-7 min-w-[88px] text-xs text-slate-700 border border-slate-200 rounded bg-white outline-none cursor-pointer font-mono px-1 focus:border-brand-500 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                                            value={baudRate}
                                            disabled={isSerialMonitorSwitching}
                                            onChange={(e) => setBaudRate(Number(e.target.value))}
                                        >
                                            {!SERIAL_BAUD_RATES.includes(baudRate as typeof SERIAL_BAUD_RATES[number]) && (
                                                <option value={baudRate}>{baudRate}</option>
                                            )}
                                            {SERIAL_BAUD_RATES.map((rate) => (
                                                <option key={rate} value={rate}>{rate}</option>
                                            ))}
                                        </select>
                                    </label>

                                    <button
                                        type="button"
                                        onClick={() => void toggleSerialMonitor()}
                                        disabled={isSerialMonitorSwitching || isDeviceHealthRunning}
                                        className={`ck-serial-monitor-toggle h-7 px-2 inline-flex items-center justify-center gap-1 rounded border text-[10px] font-bold transition-colors disabled:opacity-50 disabled:cursor-wait ${isSerialMonitorOpen
                                            ? 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/35 dark:text-red-300'
                                            : 'border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100 dark:border-brand-900 dark:bg-brand-950/40 dark:text-brand-300'}`}
                                        title={isDeviceHealthRunning
                                            ? '真机体检期间串口由体检独占'
                                            : isSerialMonitorSwitching
                                                ? '正在应用串口设置'
                                                : isSerialMonitorOpen
                                                    ? '真正关闭串口并释放端口'
                                                    : '打开当前端口'}
                                        data-ck-action="toggle-serial-monitor-near-endpoint"
                                    >
                                        <Monitor size={13} />
                                        <span>{isSerialMonitorSwitching ? '处理中…' : isSerialMonitorOpen ? '关闭串口' : '打开串口'}</span>
                                    </button>

                                    <div className="ck-serial-view-switch h-7 flex items-center border border-slate-200 rounded bg-white p-0.5 dark:border-slate-700 dark:bg-slate-800" aria-label="串口显示模式">
                                        <button
                                            onClick={() => { setConsoleViewMode('text'); setViewMode('text'); }}
                                            className={`ck-serial-view-button h-6 px-2 flex items-center justify-center gap-1 rounded text-[10px] font-semibold transition-colors ${consoleViewMode === 'text' && viewMode === 'text' ? 'is-active bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300' : 'text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200'}`}
                                            title="文本模式"
                                        >
                                            <Type size={13} />
                                            <span>文本</span>
                                        </button>
                                        <button
                                            onClick={() => { setConsoleViewMode('text'); setViewMode('hex'); }}
                                            className={`ck-serial-view-button h-6 px-2 flex items-center justify-center gap-1 rounded text-[10px] font-semibold transition-colors ${consoleViewMode === 'text' && viewMode === 'hex' ? 'is-active bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300' : 'text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200'}`}
                                            title="十六进制模式"
                                        >
                                            <Binary size={13} />
                                            <span>HEX</span>
                                        </button>
                                        <button
                                            onClick={() => setConsoleViewMode('plot')}
                                            className={`ck-serial-view-button h-6 px-2 flex items-center justify-center gap-1 rounded text-[10px] font-semibold transition-colors ${consoleViewMode === 'plot' ? 'is-active bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300' : 'text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200'}`}
                                            title="结构化串口数据"
                                        >
                                            <Activity size={13} />
                                            <span>数据</span>
                                        </button>
                                    </div>

                                    <button
                                        onClick={() => setShowTimestamp((value) => !value)}
                                        className={`ck-serial-icon-button w-7 h-7 flex items-center justify-center rounded transition-colors ${showTimestamp ? 'is-active text-brand-700 bg-brand-50 dark:bg-brand-950/60 dark:text-brand-300' : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200'}`}
                                        title={showTimestamp ? '关闭时间戳' : '显示时间戳'}
                                    >
                                        <Clock3 size={14} />
                                    </button>
                                    <button
                                        onClick={() => setIsPaused((value) => !value)}
                                        className={`ck-serial-icon-button w-7 h-7 flex items-center justify-center rounded transition-colors ${isPaused ? 'is-active text-amber-600 bg-amber-50 dark:bg-amber-950/50 dark:text-amber-300' : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200'}`}
                                        title={isPaused ? '继续接收显示' : '暂停接收显示'}
                                    >
                                        {isPaused ? <Play size={14} className="fill-current" /> : <Pause size={14} className="fill-current" />}
                                    </button>
                                    {consoleViewMode === 'text' && (
                                        <button
                                            type="button"
                                            onClick={() => void handleExportSerialCapture()}
                                            className="ck-serial-action-button h-7 px-2 flex items-center justify-center gap-1 rounded text-slate-500 hover:text-brand-700 hover:bg-brand-50 transition-colors dark:text-slate-400 dark:hover:bg-brand-950/60 dark:hover:text-brand-300"
                                            title={viewMode === 'hex' ? '导出当前 HEX 捕获（.hex/.txt）' : '导出当前文本捕获（.log/.txt）'}
                                            aria-label={viewMode === 'hex' ? '导出 HEX 串口内容' : '导出文本串口内容'}
                                        >
                                            <Save size={13} />
                                            <span className="text-[10px] font-bold">导出</span>
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => void openDetachedConsole()}
                                        className="ck-serial-action-button h-7 px-2 flex items-center justify-center gap-1 rounded text-slate-500 hover:text-brand-700 hover:bg-brand-50 transition-colors dark:text-slate-400 dark:hover:bg-brand-950/60 dark:hover:text-brand-300"
                                        title="将串口监视器弹出为独立窗口"
                                        aria-label="弹出串口浮窗"
                                    >
                                        <ExternalLink size={13} />
                                        <span className="text-[10px] font-bold">浮窗</span>
                                    </button>
                                </>
                            )}

                            <button
                                onClick={() => {
                                    if (consoleTab === 'serial') {
                                        serialMonitorRef.current?.clear();
                                    } else {
                                        replaceCompileLog('');
                                    }
                                }}
                                className="ck-serial-icon-button ck-serial-clear-button w-7 h-7 flex items-center justify-center text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors dark:text-slate-500 dark:hover:bg-red-950/45 dark:hover:text-red-300"
                                title={consoleTab === 'serial' ? '清空串口内容' : '清空输出日志'}
                            >
                                <Trash2 size={14} />
                            </button>
                        </div>
                        </div>
                        <div className="ck-serial-panel-actions flex items-center shrink-0 gap-1 pl-2 h-full">
                            <button
                                type="button"
                                data-ck-action="toggle-console-size"
                                onClick={() => setConsoleExpanded(value => !value)}
                                aria-expanded={consoleExpanded}
                                aria-label={consoleExpanded ? '恢复紧凑控制台' : '展开控制台'}
                                title={consoleExpanded ? '恢复紧凑高度' : '展开查看更多输出'}
                                className="ck-serial-icon-button h-7 px-1.5 flex items-center justify-center gap-1 rounded text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                            >
                                {consoleExpanded ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
                                <span className="text-[10px] whitespace-nowrap">{consoleExpanded ? '紧凑' : '展开'}</span>
                            </button>
                            <button
                                type="button"
                                onClick={() => setConsoleOpen(false)}
                                className="ck-serial-icon-button w-7 h-7 flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                                title="收起控制台"
                                aria-label="收起控制台"
                            >
                                <X size={14} />
                            </button>
                        </div>
                    </div>

                    {/* Log Content Wrapper */}
                    {consoleTab === 'compile' && <CompileLogActions runId={feedbackRunId} busy={isCompiling} getLog={() => compileLogRef.current} />}

                    <div className="ck-serial-console-content flex-1 min-h-0 flex flex-col overflow-hidden bg-[#fbfcfe] dark:bg-slate-950">
                        {consoleTab === 'serial' ? (

                            <div className="relative w-full h-full">
                                <div className={`ck-serial-console-surface absolute inset-0 ${consoleViewMode === 'text' ? 'z-10 bg-[#fbfcfe] dark:bg-slate-950' : 'z-0 invisible'} `}>
                                    <SerialMonitor
                                        ref={serialMonitorRef}
                                        viewMode={viewMode}
                                        paused={isPaused || consoleViewMode !== 'text'}
                                        showTimestamp={showTimestamp}
                                        theme={theme}
                                        scrollback={8000}
                                        hideDebugProtocol
                                    />
                                </div>
                                {consoleViewMode === 'plot' && (
                                    <div className="ck-serial-console-surface absolute inset-0 z-10 bg-[#fbfcfe] dark:bg-slate-950">
                                        <SerialPlotter
                                            paused={isPaused}
                                            port={monitorPort}
                                            baudRate={monitorBaudRate}
                                        />
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div
                                ref={compileLogScrollRef}
                                data-ck-role="compile-log-scroll-container"
                                className="ck-serial-compile-log h-full min-h-0 overflow-auto overscroll-contain p-2 font-mono text-xs"
                            >
                                    {compileIssues.length > 0 && (
                                        <div className="-mx-2 -mt-2 mb-2 border-b border-slate-200 bg-[#f8fafc] pb-2 font-sans dark:border-slate-700 dark:bg-slate-950">
                                            <BuildIssueCards
                                                issues={compileIssues}
                                                onAskAi={issue => openAi({ kind: 'repair', blockId: issue.blockContext?.blockId, diagnostic: issue.rawDiagnostic })}
                                                compact
                                                onLocateBlock={locateWorkspaceBlock}
                                                onAction={(action, issue) => {
                                                    void handleCompileIssueAction(action, issue);
                                                }}
                                            />
                                        </div>
                                    )}
                                    {compileLogDigest.lines.length > 0 && (
                                        <div className="mb-2 flex items-center justify-between gap-2 rounded border border-red-100 bg-red-50/70 px-2 py-1.5 font-sans dark:border-red-900/70 dark:bg-red-950/25">
                                            <div className="min-w-0 text-[10px] font-semibold text-red-700 dark:text-red-300">
                                                已提炼 {compileLogDigest.errorCount} 条编译错误
                                                {compileLogDigest.omittedLineCount > 0 ? ` · 隐藏 ${compileLogDigest.omittedLineCount} 行过程日志` : ''}
                                            </div>
                                            <div className="inline-flex shrink-0 rounded border border-red-200 bg-white p-0.5 dark:border-red-800 dark:bg-slate-900">
                                                <button
                                                    type="button"
                                                    onClick={() => setCompileLogViewMode('key')}
                                                    className={`rounded px-2 py-1 text-[10px] font-bold ${compileLogViewMode === 'key' ? 'bg-red-600 text-white' : 'text-slate-500 hover:bg-red-50 dark:text-slate-300 dark:hover:bg-red-950/50'}`}
                                                >关键错误</button>
                                                <button
                                                    type="button"
                                                    onClick={() => setCompileLogViewMode('full')}
                                                    className={`rounded px-2 py-1 text-[10px] font-bold ${compileLogViewMode === 'full' ? 'bg-slate-700 text-white dark:bg-slate-200 dark:text-slate-900' : 'text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
                                                >完整日志</button>
                                            </div>
                                        </div>
                                    )}
                                    {compileLog ? (
                                        compileLogViewMode === 'key' && compileLogDigest.lines.length > 0 ? (
                                            <div className="whitespace-pre-wrap rounded border border-red-100 bg-red-50/35 px-2 py-1.5 leading-5 dark:border-red-900/60 dark:bg-red-950/15">
                                                {compileLogDigest.lines.map((entry, idx) => {
                                                    const cls = entry.kind === 'error'
                                                        ? 'text-red-700 font-bold dark:text-red-300'
                                                        : entry.kind === 'note'
                                                            ? 'text-amber-700 dark:text-amber-300'
                                                            : entry.kind === 'caret'
                                                                ? 'text-red-500 font-bold dark:text-red-400'
                                                                : 'text-slate-700 dark:text-slate-300';
                                                    const mapping = entry.kind === 'error' ? lookupCompileBlock(entry.raw) : null;
                                                    const canLocateBlock = isTrustedCompileBlockMapping(mapping);
                                                    return (
                                                        <div
                                                            key={`${idx}:${entry.text}`}
                                                            className={`${cls}${canLocateBlock ? ' cursor-pointer rounded px-0.5 -mx-0.5 hover:bg-red-100 hover:underline dark:hover:bg-red-950/50' : ''}`}
                                                            onClick={canLocateBlock ? () => handleCompileLineClick(entry.raw) : undefined}
                                                            title={canLocateBlock ? '点击定位到已确认映射的积木' : undefined}
                                                        >{entry.text || ' '}</div>
                                                    );
                                                })}
                                            </div>
                                        ) : (
                                        <div className="whitespace-pre-wrap leading-5">
                                            {compileLogLines.map((line, idx) => {
                                                const cls = getCompileLineClass(
                                                    line,
                                                    compileLogResultLinesRef.current.get(idx),
                                                );
                                                const isError = cls.includes('text-red');
                                                const mapping = isError ? lookupCompileBlock(line) : null;
                                                const canLocateBlock = isError && isTrustedCompileBlockMapping(mapping);
                                                return (
                                                    <div
                                                        key={`${idx}:${line.length}`}
                                                        className={`${cls}${canLocateBlock ? ' cursor-pointer hover:underline hover:bg-red-50/60 rounded px-0.5 -mx-0.5 dark:hover:bg-red-950/40' : ''}`}
                                                        onClick={canLocateBlock ? () => handleCompileLineClick(line) : undefined}
                                                        title={canLocateBlock ? '点击定位到已确认映射的积木' : undefined}
                                                    >
                                                        {line || ' '}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                        )
                                    ) : (
                                        <span className="text-slate-300 italic dark:text-slate-600">暂无输出日志...</span>
                                    )}
                            </div>
                        )}
                    </div>

                    {/* Serial Input-Only Show in Serial Tab */}
                    {consoleTab === 'serial' && (
                        <div className="ck-serial-input-bar bg-[#fbfcfe] border-t border-[#dce3ec] shrink-0 z-10 flex items-center h-9 dark:border-slate-700 dark:bg-slate-900">
                            {/* Input Field */}
                            <input
                                type="text"
                                value={serialInput}
                                onChange={(e) => setSerialInput(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleSendSerial()}
                                disabled={!isSerialMonitorOpen || blockDebugSession.active}
                                placeholder={blockDebugSession.active ? "调试/轨迹期间串口由控制协议独占" : isSerialMonitorOpen ? "发送数据..." : "串口监视器已关闭"}
                                className="ck-serial-input flex-1 bg-transparent border-none text-slate-700 text-xs px-3 focus:ring-0 outline-none disabled:opacity-30 placeholder:text-slate-400 h-full dark:text-slate-200 dark:placeholder:text-slate-600"
                            />

                            {/* Line Ending Selector-Compact */}
                            <div className="ck-serial-line-ending-wrap h-full border-l border-r border-slate-200 flex items-center px-1 hover:bg-slate-50 relative min-w-[60px] dark:border-slate-700 dark:hover:bg-slate-800">
                                <select
                                    className="ck-serial-line-ending-select w-full bg-transparent text-[10px] font-bold text-slate-500 outline-none cursor-pointer hover:text-brand-600 transition-colors uppercase appearance-none text-center relative z-10 pl-2 pr-4 h-full dark:text-slate-400 dark:hover:text-brand-300"
                                    value={lineEnding}
                                    onChange={(e) => setLineEnding(e.target.value)}
                                    title="行尾符"
                                >
                                    <option value="">无</option>
                                    <option value={'\n'}>换行 (LF)</option>
                                    <option value={'\r'}>回车 (CR)</option>
                                    <option value={'\r\n'}>回车换行</option>
                                </select>
                                <span className="text-slate-400 text-[8px] absolute right-1 pointer-events-none top-1/2 -translate-y-1/2">▼</span>
                            </div>

                            {/* Send Button */}
                            <button
                                onClick={handleSendSerial}
                                disabled={!isSerialMonitorOpen || !serialInput.trim() || blockDebugSession.active}
                                className="ck-serial-send-button h-full px-3 flex items-center justify-center gap-1.5 bg-brand-600 hover:bg-brand-500 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                title="发送串口数据"
                                aria-label="发送串口数据"
                            >
                                <Send size={14} />
                                <span className="text-xs font-bold">发送</span>
                            </button>
                        </div>
                    )}
                </div>

            ) : isConsoleDetached ? (
                <div
                    onClick={() => void openDetachedConsole()}
                    className="h-7 bg-brand-50 border-t border-brand-200 flex items-center justify-between px-3 cursor-pointer hover:bg-brand-100 shrink-0 transition-colors dark:border-brand-900 dark:bg-brand-950/45 dark:hover:bg-brand-950/70"
                    title="点击聚焦串口浮窗"
                >
                    <div className="flex items-center space-x-2 text-brand-700 dark:text-brand-300">
                        <ExternalLink size={12} />
                        <span className="text-[10px] font-bold">串口监视器正在浮窗运行</span>
                    </div>
                    <span className="text-[9px] font-semibold text-brand-600/80 dark:text-brand-400/80">点击聚焦</span>
                </div>
            ) : (
                // Collapsed Bar
                <div onClick={() => setConsoleOpen(true)} className="h-7 bg-[#f4f7fa] border-t border-[#dce3ec] flex items-center justify-between px-3 cursor-pointer hover:bg-white shrink-0 transition-colors dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800">
                    <div className="flex items-center space-x-2 text-slate-500">
                        <Terminal size={12} />
                        <span className="text-[10px] font-bold">打开控制台</span>
                    </div>
                </div>
            )
            }
            <StatusFooter
                bytesReceivedRef={bytesReceivedRef}
                linesReceivedRef={linesReceivedRef}
                baudRate={baudRate}
                activePort={activePort}
                monitorPort={monitorPort}
                monitorBaudRate={monitorBaudRate}
                isSerialMonitorOpen={isSerialMonitorOpen}
                isSerialMonitorSwitching={isSerialMonitorSwitching}
                boardName={getBoardName()}
            />

        </div>
    );
}




