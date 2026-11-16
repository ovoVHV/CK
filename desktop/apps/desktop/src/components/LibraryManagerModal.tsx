import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, BookOpen, Box, CheckCircle2, ChevronDown, Clock3, Cloud, Copy, Database, DownloadCloud, HardDrive, Loader2, RefreshCw, Search, ShieldCheck, Trash2, Upload, X } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useHardware } from '../contexts/HardwareContext';
import { useDialog } from '../contexts/DialogContext';
import type { LibraryInfo } from '../types/library';
import type { PackageQualityReport } from '../types/packageQuality';
import { boardPackageKey } from '../services/board_identity';
import { installCloudLibraryQueue, type CloudLibraryInstallResult } from '../services/cloud_library_install';
import { PackageQualityReportPanel, PackageQualityStatusBadge } from './PackageQualityReportPanel';
import { BlockPackagePassportBadge, BlockPackagePassportPanel } from './BlockPackagePassport';
import {
    blockRuntimeActivation,
    runtimeActivationLabelKey,
    runtimeActivationTone,
} from '../services/block_runtime_activation';
import {
    cancelPreparedBlockLibraryMigration,
    commitPreparedBlockLibraryMigration,
    formatBlockLibraryMigrationPreview,
    prepareBlockLibraryMigration,
    previewPreparedBlockLibraryMigration,
    type CommitPreparedBlockLibraryMigrationResult,
    type PreparedBlockLibraryMigration,
} from '../services/block_package_migration_transaction';
import {
    createLibraryImportQueue,
    createLibraryOperationError,
    describeLibraryOperationError,
    libraryOperationErrorCode,
    LIBRARY_OPERATION_ERROR_CODES,
    selectedLibraryImportPaths,
    type LibraryImportQueueItem,
} from '../services/library_operation_feedback';

interface LibraryManagerModalProps {
    isOpen: boolean;
    onClose: () => void;
    showToast: (msg: string, type: 'success' | 'error' | 'loading') => void;
    onExtensionImported?: () => void;
    projectPath: string;
    readBlockPackageMigrationWorkspace?: () => string | Promise<string>;
    createBlockPackageMigrationCheckpoint?: (workspaceJson: string) => Promise<string>;
    onBlockPackageMigrationCommitted?: (
        result: CommitPreparedBlockLibraryMigrationResult,
    ) => void | Promise<void>;
    initialArduinoSearch?: {
        requestId: number;
        query: string;
    } | null;
}

type TabType = 'installed' | 'discover' | 'import';
type DiscoverKind = 'blocks' | 'arduino';
type CloudProvider = 'auto' | 'github' | 'gitee';

interface RegistryLibrary {
    id?: string;
    name: string;
    version: string;
    author?: string;
    url: string;
    architectures?: string[] | string;
    architecture?: string;
    platforms?: string[] | string;
    platform?: string;
    sentence?: string;
    description?: string;
}

interface ArduinoInstalledLibrary {
    name: string;
    version: string;
    installDir?: string;
    qualityReport?: PackageQualityReport;
    installSource?: {
        source?: string;
        source_archive_sha256?: string;
    };
}

interface ActiveLibraryOperation {
    kind: 'cloud-install' | 'arduino-install' | 'arduino-uninstall' | 'index-update' | 'block-import' | 'arduino-import';
    label: string;
    stage: string;
    current: number;
    total: number;
    startedAt: number;
}

const DEFAULT_GITHUB = '';
const DEFAULT_GITEE = 'https://gitee.com/manong1234/makerlib.git';
const n = (value: unknown) => String(value || '').trim();
const k = (value: unknown) => n(value).toLowerCase();
const nk = (value: unknown) => k(value).replace(/[^a-z0-9]+/g, '');

const importQueueStatusKey = (status: LibraryImportQueueItem['status']): string => ({
    pending: 'manager.queue.pending',
    running: 'manager.queue.running',
    success: 'manager.queue.success',
    failed: 'manager.queue.failed',
    skipped: 'manager.queue.skipped',
}[status]);

const importQueueStatusClass = (status: LibraryImportQueueItem['status']): string => {
    if (status === 'success') return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/35 dark:text-emerald-300';
    if (status === 'failed') return 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/35 dark:text-red-300';
    if (status === 'running') return 'border-brand-200 bg-brand-50 text-brand-700 dark:border-brand-800 dark:bg-brand-950/35 dark:text-brand-300';
    return 'border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300';
};

const parseArch = (value: string[] | string | undefined) => {
    const out: string[] = [];
    const push = (item: string) => {
        const normalized = k(item);
        if (normalized && !out.includes(normalized)) out.push(normalized);
    };
    if (Array.isArray(value)) value.forEach((item) => push(String(item)));
    else if (typeof value === 'string') value.split(/[;,]/).forEach((item) => push(item));
    return out;
};

const libraryEntryKey = (lib: Partial<LibraryInfo>) => n((lib as any).entry_key || lib.path || lib.id);

const libraryLocationLabel = (lib: Partial<LibraryInfo>) => {
    const location = n(lib.location);
    const detail = n((lib as any).scope_detail);
    return detail ? `${location}/${detail}` : location;
};

const libraryMetaLabel = (lib: LibraryInfo) => {
    const parts = [`v${n(lib.version) || 'Unknown'}`];
    const location = libraryLocationLabel(lib);
    if (location) parts.push(location);

    const folder = n((lib as any).folder_name);
    const folderNorm = nk(folder);
    if (folder && folderNorm !== nk(lib.name) && folderNorm !== nk(lib.id)) {
        parts.push(folder);
    }

    const architectures = Array.isArray(lib.manifest?.architectures)
        ? lib.manifest.architectures.filter(Boolean)
        : [];
    if (architectures.length > 0 && !(architectures.length === 1 && architectures[0] === '*')) {
        parts.push(architectures.join('/'));
    }

    return parts.join(' · ');
};

const runtimeBadgeClass = (lib: Partial<LibraryInfo>) => {
    const tone = runtimeActivationTone(lib);
    if (tone === 'safe') return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300';
    if (tone === 'warning') return 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300';
    if (tone === 'danger') return 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300';
    return 'border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400';
};

const getArduinoName = (lib: any) => n(lib?.name || lib?.library?.name);

const getArduinoLatestVersion = (lib: any) => {
    const direct = n(lib?.version);
    if (direct) return direct;
    const latest = n(lib?.latest?.version);
    if (latest) return latest;
    const installed = n(lib?.library?.version);
    if (installed) return installed;
    return '-';
};

const getArduinoVersions = (lib: any): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (value: unknown) => {
        const normalized = n(value);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        out.push(normalized);
    };

    if (Array.isArray(lib?.available_versions)) {
        lib.available_versions.forEach(push);
    }
    if (Array.isArray(lib?.versions)) {
        lib.versions.forEach(push);
    }
    if (Array.isArray(lib?.releases)) {
        lib.releases.forEach((item: any) => push(item?.version));
    }
    push(lib?.latest?.version);
    return out;
};

export const LibraryManagerModal = ({
    isOpen,
    onClose,
    showToast,
    onExtensionImported,
    projectPath,
    readBlockPackageMigrationWorkspace,
    createBlockPackageMigrationCheckpoint,
    onBlockPackageMigrationCommitted,
    initialArduinoSearch = null,
}: LibraryManagerModalProps) => {
    // This component builds a number of dynamic namespace paths (for example
    // `manager.operation.*`). Keep the runtime translator typed broadly here;
    // the resource parity tests still validate every concrete key.
    const { t: translate } = useTranslation('libraries');
    const t = translate as unknown as (key: string, options?: Record<string, unknown>) => string;
    const {
        availableLibraries,
        reloadLibraries,
        activeBoard,
        activeBoardPackageId,
        availableBoards,
        setActiveBoard,
    } = useHardware();
    const dialog = useDialog();

    const [tab, setTab] = useState<TabType>('installed');
    const [discoverKind, setDiscoverKind] = useState<DiscoverKind>('blocks');
    const [selectedLibs, setSelectedLibs] = useState<string[]>([]);
    const [deletingLib, setDeletingLib] = useState<string | null>(null);
    const [bulkDeletingLibs, setBulkDeletingLibs] = useState(false);
    const [expandedQualityKey, setExpandedQualityKey] = useState<string | null>(null);

    const [provider, setProvider] = useState<CloudProvider>('gitee');
    const [registryUrl, setRegistryUrl] = useState('');
    const [registryLoading, setRegistryLoading] = useState(false);
    const [registryLibs, setRegistryLibs] = useState<RegistryLibrary[]>([]);
    const [cloudQuery, setCloudQuery] = useState('');
    const [installingCloud, setInstallingCloud] = useState<string | null>(null);
    const [selectedCloudLibs, setSelectedCloudLibs] = useState<RegistryLibrary[]>([]);
    const [cloudInstallResults, setCloudInstallResults] = useState<CloudLibraryInstallResult[]>([]);

    const [importingLib, setImportingLib] = useState(false);
    const [importingArduinoZip, setImportingArduinoZip] = useState(false);
    const [importQueue, setImportQueue] = useState<LibraryImportQueueItem[]>([]);
    const [activeLibraryOperation, setActiveLibraryOperation] = useState<ActiveLibraryOperation | null>(null);
    const [operationElapsedMs, setOperationElapsedMs] = useState(0);

    const [arduinoQuery, setArduinoQuery] = useState('');
    const [arduinoResults, setArduinoResults] = useState<any[]>([]);
    const [installedArduino, setInstalledArduino] = useState<Record<string, string>>({});
    const [installedArduinoNames, setInstalledArduinoNames] = useState<ArduinoInstalledLibrary[]>([]);
    const [arduinoView, setArduinoView] = useState<'search' | 'installed'>('search');
    const [arduinoVersions, setArduinoVersions] = useState<Record<string, string>>({});
    const [arduinoLoading, setArduinoLoading] = useState(false);
    const [installingArduino, setInstallingArduino] = useState<string | null>(null);
    const [uninstallingArduino, setUninstallingArduino] = useState<string | null>(null);
    const [updatingArduinoIndex, setUpdatingArduinoIndex] = useState(false);
    const [arduinoStatus, setArduinoStatus] = useState('');
    const [arduinoOpStatus, setArduinoOpStatus] = useState('');

    const cloudAutoLoadKeyRef = useRef('');
    const cloudInstallLockRef = useRef(false);
    const arduinoSearchReqIdRef = useRef(0);
    const arduinoInstalledReqIdRef = useRef(0);
    const appliedInitialArduinoSearchRef = useRef<number | null>(null);
    const arduinoSearchInputRef = useRef<HTMLInputElement | null>(null);
    const focusInitialArduinoSearchRef = useRef(false);

    const startLibraryOperation = (
        operation: Omit<ActiveLibraryOperation, 'startedAt'>,
    ) => {
        setOperationElapsedMs(0);
        setActiveLibraryOperation({ ...operation, startedAt: Date.now() });
    };

    const updateLibraryOperation = (patch: Partial<Omit<ActiveLibraryOperation, 'startedAt'>>) => {
        setActiveLibraryOperation(previous => previous ? { ...previous, ...patch } : previous);
    };

    const finishLibraryOperation = () => {
        setActiveLibraryOperation(null);
        setOperationElapsedMs(0);
    };

    const updateImportQueueItem = (
        id: string,
        patch: Partial<LibraryImportQueueItem>,
    ) => {
        setImportQueue(previous => previous.map(item => item.id === id ? { ...item, ...patch } : item));
    };

    const userLibraries = useMemo(
        () => availableLibraries.filter((lib) => Boolean(lib.user_installed)),
        [availableLibraries],
    );

    const protectedLibraries = useMemo(
        () => availableLibraries.filter((lib) => !lib.user_installed),
        [availableLibraries],
    );

    const installedLibKeys = useMemo(() => {
        const out = new Set<string>();
        for (const lib of availableLibraries) {
            [lib.id, lib.name, (lib as any).folder_name].forEach((value) => {
                const lower = k(value);
                const normalized = nk(value);
                if (lower) out.add(lower);
                if (normalized) out.add(normalized);
            });
        }
        return out;
    }, [availableLibraries]);

    const boardTags = useMemo(() => {
        const out: string[] = [];
        const push = (value: unknown) => {
            const normalized = k(value);
            if (!normalized || out.includes(normalized)) return;
            out.push(normalized);
            normalized.split(/[:_/.-]/).forEach((part) => {
                const token = k(part);
                if (token && !out.includes(token)) out.push(token);
            });
        };

        push(activeBoard);
        const active = (availableBoards || []).find((item: any) => (
            boardPackageKey(item) === activeBoardPackageId && item?.fqbn === activeBoard
        ));
        push(active?.id);
        push(active?.fqbn);
        push(active?.arduino_core?.package);
        return out;
    }, [activeBoard, activeBoardPackageId, availableBoards]);

    const visibleCloud = useMemo(() => {
        const filtered = registryLibs.filter((lib) => {
            const tags = [
                ...parseArch(lib.architectures),
                ...parseArch(lib.architecture),
                ...parseArch(lib.platforms),
                ...parseArch(lib.platform),
            ];

            let matched = false;
            if (tags.length === 0 || tags.includes('*') || tags.includes('all') || tags.includes('any')) {
                matched = true;
            } else {
                matched = tags.some((item) => boardTags.some((tag) => item === tag || item.includes(tag) || tag.includes(item)));
            }

            if (!matched) return false;
            if (!cloudQuery) return true;
            const query = k(cloudQuery);
            return [lib.name, lib.author, lib.sentence, lib.description].some((value) => k(value).includes(query));
        });

        return cloudQuery ? filtered.slice(0, 300) : filtered.slice(0, 100);
    }, [boardTags, cloudQuery, registryLibs]);

    const installedArduinoNormalized = useMemo(() => {
        const out: Record<string, string> = {};
        for (const [name, version] of Object.entries(installedArduino)) {
            const normalized = nk(name);
            if (normalized && !out[normalized]) out[normalized] = version;
        }
        return out;
    }, [installedArduino]);

    const withTimeout = async <T,>(
        promise: Promise<T>,
        timeoutMs: number,
        timeoutCode: typeof LIBRARY_OPERATION_ERROR_CODES.SEARCH_TIMEOUT,
        timeoutMessage: string,
    ): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
            return await new Promise<T>((resolve, reject) => {
                timer = setTimeout(() => reject(createLibraryOperationError(timeoutCode, timeoutMessage)), timeoutMs);
                promise.then(resolve).catch(reject);
            });
        } finally {
            if (timer) clearTimeout(timer);
        }
    };

    const refreshInstalledLibraries = async () => {
        const inventory = await reloadLibraries(activeBoard, activeBoardPackageId);
        if (onExtensionImported) onExtensionImported();
        return inventory;
    };

    const refreshArduinoInstalled = async (): Promise<Record<string, string> | null> => {
        const reqId = ++arduinoInstalledReqIdRef.current;
        try {
            const raw = await invoke<string>('list_arduino_libraries');
            const parsed = JSON.parse(String(raw || '{}'));
            const list = Array.isArray(parsed?.installed_libraries)
                ? parsed.installed_libraries
                : Array.isArray(parsed?.libraries)
                    ? parsed.libraries
                    : [];

            const next: Record<string, string> = {};
            const names: ArduinoInstalledLibrary[] = [];
            const seen = new Set<string>();

            for (const item of list) {
                const name = getArduinoName(item);
                if (!name) continue;
                const version = n(item?.library?.version || item?.version || item?.latest?.version) || 'latest';
                next[k(name)] = version;
                if (!seen.has(k(name))) {
                    seen.add(k(name));
                    names.push({
                        name,
                        version,
                        installDir: n(item?.library?.install_dir) || undefined,
                        qualityReport: item?.library?.ck_quality_report,
                        installSource: item?.library?.ck_install_source,
                    });
                }
            }

            names.sort((a, b) => a.name.localeCompare(b.name));

            if (reqId !== arduinoInstalledReqIdRef.current) return next;
            setInstalledArduino(next);
            setInstalledArduinoNames(names);
            return next;
        } catch {
            return null;
        }
    };

    const fetchRegistry = async () => {
        if (!n(registryUrl)) {
            showToast(t('manager.errors.enterRepository'), 'error');
            return;
        }

        setRegistryLoading(true);
        try {
            const raw = await invoke<string>('fetch_custom_registry', { url: registryUrl, provider });
            const parsed = JSON.parse(String(raw || '{}'));
            setRegistryLibs(Array.isArray(parsed?.libraries) ? parsed.libraries : []);
        } catch (error: any) {
            showToast(t('manager.errors.repositoryFailed', { error: String(error?.message || error) }), 'error');
        } finally {
            setRegistryLoading(false);
        }
    };

    const saveAndFetchRegistry = () => {
        localStorage.setItem('ck_custom_registry_provider', provider);
        localStorage.setItem('ck_custom_registry_url', registryUrl);
        void fetchRegistry();
    };

    const runCloudInstall = async (items: RegistryLibrary[]) => {
        if (!items.length) return;
        if (cloudInstallLockRef.current || activeLibraryOperation) {
            showToast(
                activeLibraryOperation
                    ? t('manager.operation.processing', { label: activeLibraryOperation.label, stage: activeLibraryOperation.stage })
                    : t('manager.operation.busy'),
                'loading',
            );
            return;
        }
        cloudInstallLockRef.current = true;
        setCloudInstallResults([]);
        setInstallingCloud(items[0].name);
        startLibraryOperation({
            kind: 'cloud-install',
            label: items[0].name,
            stage: t('manager.operation.downloadCheckInstall'),
            current: 1,
            total: items.length,
        });
        try {
            const results = await installCloudLibraryQueue(items, {
                install: item => invoke<string>('install_library_from_url', {
                    url: item.url,
                    board: activeBoard,
                    boardPackageId: activeBoardPackageId,
                }),
                refresh: refreshInstalledLibraries,
                onStart: (item, index) => {
                    setInstallingCloud(item.name);
                    updateLibraryOperation({
                        label: item.name,
                        stage: t('manager.operation.downloadCheckInstall'),
                        current: index + 1,
                    });
                },
                onRefresh: () => updateLibraryOperation({ stage: t('manager.operation.refreshing') }),
                onResults: setCloudInstallResults,
            });
            const installed = results.filter(result => result.status === 'installed');
            setSelectedCloudLibs(previous => previous.filter(item => !installed.some(result => result.url === item.url)));
            showToast(t('manager.cloud.resultSummary', {
                success: installed.length,
                failed: results.filter(result => result.status === 'failed').length,
                unconfirmed: results.filter(result => result.status === 'unconfirmed').length,
            }), installed.length === results.length ? 'success' : 'error');
        } finally {
            setInstallingCloud(null);
            cloudInstallLockRef.current = false;
            finishLibraryOperation();
        }
    };

    const cloudInstall = (lib: RegistryLibrary) => runCloudInstall([lib]);
    const batchInstallCloud = () => runCloudInstall([...selectedCloudLibs]);

    const importSingleBlockPackage = async (path: string) => {
        let prepared: PreparedBlockLibraryMigration | null = null;
        let committed = false;
        try {
            prepared = await prepareBlockLibraryMigration({
                path,
                board: activeBoard,
                boardPackageId: activeBoardPackageId,
                projectPath,
            });
            let result: CommitPreparedBlockLibraryMigrationResult;
            if (prepared.requiresProjectMigration) {
                if (!readBlockPackageMigrationWorkspace || !createBlockPackageMigrationCheckpoint) {
                    throw new Error(t('manager.errors.migrationContextMissing'));
                }
                const workspaceJson = await readBlockPackageMigrationWorkspace();
                const preview = await previewPreparedBlockLibraryMigration(prepared, workspaceJson);
                const confirmed = await dialog.confirm({
                    title: t('manager.migration.previewTitle'),
                    message: formatBlockLibraryMigrationPreview(preview),
                    type: 'warning',
                    confirmLabel: t('manager.migration.confirm', { version: prepared.toVersion }),
                    cancelLabel: t('manager.migration.cancel'),
                });
                if (!confirmed) {
                    await cancelPreparedBlockLibraryMigration(prepared.token);
                    prepared = null;
                    return {
                        status: 'skipped' as const,
                        summary: t('manager.migration.cancelled'),
                        result: null,
                    };
                }
                updateLibraryOperation({ stage: t('manager.operation.createCheckpoint') });
                const checkpointId = await createBlockPackageMigrationCheckpoint(
                    preview.workspaceBeforeJson,
                );
                updateLibraryOperation({ stage: t('manager.operation.commitMigration') });
                result = await commitPreparedBlockLibraryMigration(
                    prepared,
                    preview,
                    checkpointId,
                );
            } else {
                result = await commitPreparedBlockLibraryMigration(prepared);
            }
            committed = true;
            return {
                status: 'success' as const,
                result,
                summary: result.status === 'identical'
                    ? t('manager.migration.identical', { packageId: result.packageId })
                    : result.projectMigrated
                        ? t('manager.migration.migrated', { packageId: result.packageId })
                        : t('manager.migration.installed', { packageId: result.packageId }),
            };
        } catch (error: unknown) {
            if (prepared && !committed) {
                try {
                    await cancelPreparedBlockLibraryMigration(prepared.token);
                } catch {
                    // Backend recovery owns any transaction that already began committing.
                }
            }
            throw error;
        }
    };

    const importLibraryZip = async () => {
        if (!projectPath.trim()) {
            showToast(t('manager.import.projectRequired'), 'error');
            return;
        }
        let paths: string[] = [];
        try {
            paths = selectedLibraryImportPaths(await open({
                multiple: true,
                directory: false,
                filters: [{ name: 'CK library packages', extensions: ['zip', 'json'] }],
            }));
        } catch (error: unknown) {
            const feedback = describeLibraryOperationError(error);
            setImportQueue([{
                id: 'block-package:dialog-error',
                kind: 'block-package',
                path: '',
                label: t('manager.import.filePicker'),
                status: 'failed',
                ...(feedback.summaryCode ? { summaryCode: feedback.summaryCode, summaryParams: feedback.summaryParams } : {}),
                summary: feedback.summary,
                details: feedback.details,
                rawError: feedback.raw,
            }]);
            showToast(t('manager.import.chooseFailed', { error: feedback.summaryCode ? t(feedback.summaryCode, feedback.summaryParams) : feedback.summary }), 'error');
            return;
        }
        if (paths.length === 0) return;

        const queue = createLibraryImportQueue(paths, 'block-package');
        setImportQueue(queue);
        setImportingLib(true);
        startLibraryOperation({
            kind: 'block-import',
            label: queue[0].label,
                    stage: t('manager.operation.stageBlockPackage'),
            current: 1,
            total: queue.length,
        });
        const committedResults: CommitPreparedBlockLibraryMigrationResult[] = [];
        let successCount = 0;
        let failedCount = 0;
        let skippedCount = 0;
        try {
            for (let index = 0; index < queue.length; index += 1) {
                const item = queue[index];
                updateImportQueueItem(item.id, { status: 'running', summary: t('manager.operation.runningQualityGate') });
                updateLibraryOperation({
                    label: item.label,
                    stage: t('manager.operation.stageQualityChecks'),
                    current: index + 1,
                    total: queue.length,
                });
                try {
                    const outcome = await importSingleBlockPackage(item.path);
                    if (outcome.status === 'skipped') {
                        skippedCount += 1;
                        updateImportQueueItem(item.id, { status: 'skipped', summary: outcome.summary });
                        continue;
                    }
                    successCount += 1;
                    committedResults.push(outcome.result);
                    updateImportQueueItem(item.id, { status: 'success', summary: outcome.summary });
                } catch (error: unknown) {
                    failedCount += 1;
                    const feedback = describeLibraryOperationError(error);
                    updateImportQueueItem(item.id, {
                        status: 'failed',
                        ...(feedback.summaryCode ? { summaryCode: feedback.summaryCode, summaryParams: feedback.summaryParams } : {}),
                        summary: feedback.summary,
                        details: feedback.details,
                        rawError: feedback.raw,
                    });
                }
            }

            if (successCount > 0) {
                updateLibraryOperation({ stage: t('manager.operation.refreshingBlocks') });
                await refreshInstalledLibraries();
                for (const result of committedResults) {
                    if (result.projectMigrated && onBlockPackageMigrationCommitted) {
                        await onBlockPackageMigrationCommitted(result);
                    }
                }
            }
            if (failedCount === 0 && skippedCount === 0) setTab('installed');
            showToast(
                failedCount > 0
                    ? t('manager.import.completedWithFailures', { success: successCount, failed: failedCount, skipped: skippedCount })
                    : t('manager.import.completed', { success: successCount, skipped: skippedCount }),
                failedCount > 0 ? 'error' : 'success',
            );
        } finally {
            setImportingLib(false);
            finishLibraryOperation();
        }
    };

    const importArduinoLibraryZip = async () => {
        let paths: string[] = [];
        try {
            paths = selectedLibraryImportPaths(await open({
                multiple: true,
                directory: false,
                filters: [{ name: 'Arduino library ZIP', extensions: ['zip'] }],
            }));
        } catch (error: unknown) {
            const feedback = describeLibraryOperationError(error);
            setImportQueue([{
                id: 'arduino-zip:dialog-error',
                kind: 'arduino-zip',
                path: '',
                label: t('manager.import.filePicker'),
                status: 'failed',
                ...(feedback.summaryCode ? { summaryCode: feedback.summaryCode, summaryParams: feedback.summaryParams } : {}),
                summary: feedback.summary,
                details: feedback.details,
                rawError: feedback.raw,
            }]);
            showToast(t('manager.import.chooseArduinoFailed', { error: feedback.summaryCode ? t(feedback.summaryCode, feedback.summaryParams) : feedback.summary }), 'error');
            return;
        }
        if (paths.length === 0) return;

        const queue = createLibraryImportQueue(paths, 'arduino-zip');
        setImportQueue(queue);
        setImportingArduinoZip(true);
        startLibraryOperation({
            kind: 'arduino-import',
            label: queue[0].label,
                    stage: t('manager.operation.stageArduinoQuality'),
            current: 1,
            total: queue.length,
        });
        let successCount = 0;
        let failedCount = 0;
        try {
            for (let index = 0; index < queue.length; index += 1) {
                const item = queue[index];
                updateImportQueueItem(item.id, { status: 'running', summary: t('manager.operation.checkingAndInstalling') });
                updateLibraryOperation({
                    label: item.label,
                    stage: t('manager.operation.stageArduinoChecks'),
                    current: index + 1,
                    total: queue.length,
                });
                try {
                    await invoke('install_arduino_library_zip', { path: item.path });
                    successCount += 1;
                    updateImportQueueItem(item.id, {
                        status: 'success',
                        summary: t('manager.operation.qualityImported'),
                    });
                } catch (error: unknown) {
                    failedCount += 1;
                    const feedback = describeLibraryOperationError(error);
                    updateImportQueueItem(item.id, {
                        status: 'failed',
                        ...(feedback.summaryCode ? { summaryCode: feedback.summaryCode, summaryParams: feedback.summaryParams } : {}),
                        summary: feedback.summary,
                        details: feedback.details,
                        rawError: feedback.raw,
                    });
                }
            }
            if (successCount > 0) {
                updateLibraryOperation({ stage: t('manager.operation.refreshingArduino') });
                await refreshArduinoInstalled();
            }
            if (failedCount === 0) setTab('installed');
            showToast(
                failedCount > 0
                    ? t('manager.import.arduinoCompletedWithFailures', { success: successCount, failed: failedCount })
                    : t('manager.import.arduinoCompleted', { success: successCount }),
                failedCount > 0 ? 'error' : 'success',
            );
        } finally {
            setImportingArduinoZip(false);
            finishLibraryOperation();
        }
    };

    const deleteLibrary = async (lib: LibraryInfo) => {
        const ok = await dialog.confirm({
            title: t('manager.dialog.deleteTitle'),
            message: t('manager.dialog.deletePrompt', { name: lib.name }),
            type: 'warning',
            confirmLabel: t('manager.deleteConfirm'),
            cancelLabel: t('manager.cancel'),
        });
        if (!ok) return;

        const entryKey = libraryEntryKey(lib);
        setDeletingLib(entryKey);
        try {
            await invoke('delete_library', { id: lib.id, board: activeBoard, path: lib.path });
            await refreshInstalledLibraries();
            setSelectedLibs((prev) => prev.filter((item) => item !== entryKey));
            showToast(t('manager.operation.deleted', { name: lib.name }), 'success');
        } catch (error: any) {
            showToast(t('manager.errors.operationFailed', { error: String(error?.message || error) }), 'error');
        } finally {
            setDeletingLib(null);
        }
    };

    const bulkDeleteLibs = async () => {
        const targets = userLibraries.filter((lib) => selectedLibs.includes(libraryEntryKey(lib)));
        if (targets.length === 0) {
            showToast(t('manager.errors.selectLibrary'), 'error');
            return;
        }

        const previewNames = targets.slice(0, 8).map((lib) => `• ${lib.name}`).join('\n');
        const remaining = Math.max(0, targets.length - 8);
        const confirmed = await dialog.confirm({
            title: t('manager.dialog.bulkDeleteTitle', { count: targets.length }),
            message: t('manager.dialog.bulkDeletePrompt', { names: previewNames, remaining }),
            tone: 'danger',
            confirmLabel: t('manager.bulkDeleteConfirm', { count: targets.length }),
            cancelLabel: t('manager.cancel'),
        });
        if (!confirmed) return;

        setBulkDeletingLibs(true);
        try {
            for (const lib of targets) {
                await invoke('delete_library', { id: lib.id, board: activeBoard, path: lib.path });
            }
            await refreshInstalledLibraries();
            setSelectedLibs([]);
            showToast(t('manager.operation.bulkDeleted', { count: targets.length }), 'success');
        } catch (error: any) {
            showToast(t('manager.errors.operationFailed', { error: String(error?.message || error) }), 'error');
        } finally {
            setBulkDeletingLibs(false);
        }
    };

    const searchArduino = async (queryOverride?: string) => {
        const query = n(queryOverride ?? arduinoQuery);
        if (!query) {
            setArduinoResults([]);
            setArduinoStatus('');
            return;
        }

        const reqId = ++arduinoSearchReqIdRef.current;
        setArduinoLoading(true);
        setArduinoStatus(t('manager.search.searching', { query }));

        try {
            const raw = await withTimeout(
                invoke<string>('search_arduino_libraries', { query }),
                15000,
                LIBRARY_OPERATION_ERROR_CODES.SEARCH_TIMEOUT,
                t('manager.errors.searchTimeout'),
            );
            if (reqId !== arduinoSearchReqIdRef.current) return;

            const parsed = JSON.parse(String(raw || '{}'));
            const libraries = Array.isArray(parsed?.libraries) ? parsed.libraries : [];
            setArduinoResults(libraries);
            setArduinoStatus(t('manager.search.completed', { count: libraries.length }));
        } catch (error: any) {
            if (reqId !== arduinoSearchReqIdRef.current) return;
        const message = String(error?.message || error || t('manager.errors.unknown'));
            setArduinoResults([]);
            const errorCode = libraryOperationErrorCode(error);
            setArduinoStatus(
                errorCode === LIBRARY_OPERATION_ERROR_CODES.SEARCH_TIMEOUT
                    ? t('manager.errors.searchTimeout')
                    : t('manager.search.failed'),
            );
            showToast(t('manager.errors.searchFailed', { error: message }), 'error');
        } finally {
            if (reqId === arduinoSearchReqIdRef.current) setArduinoLoading(false);
        }
    };

    const getArduinoAuthor = (lib: any): string => {
        const candidates = [
            lib?.author,
            lib?.maintainer,
            lib?.latest?.author,
            lib?.library?.author,
            lib?.library?.maintainer,
        ];
        for (const candidate of candidates) {
            const value = n(candidate);
            if (value) return value;
        }
        return t('manager.search.unknownAuthor');
    };

    const getArduinoDesc = (lib: any): string => {
        const candidates = [lib?.sentence, lib?.paragraph, lib?.description, lib?.latest?.sentence];
        for (const candidate of candidates) {
            const value = n(candidate);
            if (value) return value;
        }
        return '';
    };

    const installArduinoLib = async (lib: any) => {
        const name = getArduinoName(lib);
        if (!name) return;
        if (activeLibraryOperation) {
            showToast(t('manager.operation.processing', { label: activeLibraryOperation.label, stage: activeLibraryOperation.stage }), 'loading');
            return;
        }

        const key = k(name);
        const version = n(arduinoVersions[key]);

        setInstallingArduino(name);
        setArduinoOpStatus(t('manager.operation.installingName', { name }));
        startLibraryOperation({
            kind: 'arduino-install',
            label: name,
            stage: t('manager.operation.arduinoInstalling'),
            current: 1,
            total: 1,
        });
        try {
            showToast(t('manager.operation.installingArduino', { name }), 'loading');
            await invoke('install_arduino_library', { name, version: version || null });
            updateLibraryOperation({ stage: t('manager.operation.refreshingArduino') });
            await refreshArduinoInstalled();
            showToast(t('manager.operation.installedArduino', { name }), 'success');
            setArduinoOpStatus(t('manager.operation.installComplete', { name }));
        } catch (error: any) {
            showToast(t('manager.errors.operationFailed', { error: String(error?.message || error) }), 'error');
            setArduinoOpStatus(t('manager.operation.installFailed', { name }));
        } finally {
            setInstallingArduino(null);
            finishLibraryOperation();
        }
    };

    const uninstallArduinoLib = async (lib: any) => {
        const name = getArduinoName(lib);
        if (!name) return;
        if (activeLibraryOperation) {
            showToast(t('manager.operation.processing', { label: activeLibraryOperation.label, stage: activeLibraryOperation.stage }), 'loading');
            return;
        }

        const version = n(lib?.version || lib?.latest?.version || lib?.installed_version);
        const confirmed = await dialog.confirm({
            title: t('manager.dialog.uninstallTitle', { name }),
            message: t('manager.dialog.uninstallPrompt', { name, version: version ? ` ${version}` : '' }),
            tone: 'warning',
            confirmLabel: t('manager.uninstallConfirm'),
            cancelLabel: t('manager.cancel'),
        });
        if (!confirmed) return;

        setUninstallingArduino(name);
        setArduinoOpStatus(t('manager.operation.uninstallingName', { name }));
        startLibraryOperation({
            kind: 'arduino-uninstall',
            label: name,
            stage: t('manager.operation.arduinoUninstalling'),
            current: 1,
            total: 1,
        });
        try {
            showToast(t('manager.operation.uninstallingArduino', { name }), 'loading');
            await invoke('uninstall_arduino_library', { name });
            updateLibraryOperation({ stage: t('manager.operation.refreshingArduino') });
            await refreshArduinoInstalled();
            showToast(t('manager.operation.uninstalledArduino', { name }), 'success');
            setArduinoOpStatus(t('manager.operation.uninstallComplete', { name }));
        } catch (error: any) {
            showToast(t('manager.errors.operationFailed', { error: String(error?.message || error) }), 'error');
            setArduinoOpStatus(t('manager.operation.uninstallFailed', { name }));
        } finally {
            setUninstallingArduino(null);
            finishLibraryOperation();
        }
    };

    useEffect(() => {
        const providerValue = k(localStorage.getItem('ck_custom_registry_provider'));
        const chosen: CloudProvider = providerValue === 'github' || providerValue === 'gitee' || providerValue === 'auto'
            ? providerValue
            : 'gitee';
        setProvider(chosen);
        const url = n(localStorage.getItem('ck_custom_registry_url'));
        setRegistryUrl(url || (chosen === 'github' ? DEFAULT_GITHUB : DEFAULT_GITEE));
    }, []);

    useEffect(() => {
        if (!isOpen) {
            cloudAutoLoadKeyRef.current = '';
            arduinoSearchReqIdRef.current += 1;
            arduinoInstalledReqIdRef.current += 1;
            appliedInitialArduinoSearchRef.current = null;
            focusInitialArduinoSearchRef.current = false;
            setInstallingCloud(null);
            setArduinoLoading(false);
            setArduinoStatus('');
            setArduinoOpStatus('');
            return;
        }

        void reloadLibraries(activeBoard, activeBoardPackageId);
        void refreshArduinoInstalled();
    }, [activeBoard, activeBoardPackageId, isOpen]);

    useEffect(() => {
        setSelectedLibs((prev) => prev.filter((item) => userLibraries.some((lib) => libraryEntryKey(lib) === item)));
    }, [userLibraries]);

    useEffect(() => {
        if (!isOpen || tab !== 'discover' || discoverKind !== 'blocks') return;
        const url = n(registryUrl);
        if (!url || registryLoading) return;

        const key = `${provider}|${url}`;
        if (cloudAutoLoadKeyRef.current === key) return;
        cloudAutoLoadKeyRef.current = key;
        void fetchRegistry();
    }, [discoverKind, isOpen, provider, registryLoading, registryUrl, tab]);

    useEffect(() => {
        if (!isOpen || !initialArduinoSearch) return;
        if (appliedInitialArduinoSearchRef.current === initialArduinoSearch.requestId) return;
        const query = n(initialArduinoSearch.query);
        if (!query) return;

        appliedInitialArduinoSearchRef.current = initialArduinoSearch.requestId;
        setTab('discover');
        setDiscoverKind('arduino');
        setArduinoView('search');
        setArduinoQuery(query);
        focusInitialArduinoSearchRef.current = true;
        void searchArduino(query);
    }, [initialArduinoSearch, isOpen]);

    useEffect(() => {
        if (
            !isOpen
            || tab !== 'discover'
            || discoverKind !== 'arduino'
            || arduinoView !== 'search'
            || !focusInitialArduinoSearchRef.current
        ) return;

        const frameId = window.requestAnimationFrame(() => {
            arduinoSearchInputRef.current?.focus();
            focusInitialArduinoSearchRef.current = false;
        });
        return () => window.cancelAnimationFrame(frameId);
    }, [arduinoView, discoverKind, initialArduinoSearch?.requestId, isOpen, tab]);

    useEffect(() => {
        if (!activeLibraryOperation) {
            setOperationElapsedMs(0);
            return;
        }
        const update = () => setOperationElapsedMs(
            Math.max(0, Date.now() - activeLibraryOperation.startedAt),
        );
        update();
        const timer = window.setInterval(update, 500);
        return () => window.clearInterval(timer);
    }, [activeLibraryOperation?.startedAt]);

    if (!isOpen) return null;

    const allLibSelected = userLibraries.length > 0 && userLibraries.every((lib) => selectedLibs.includes(libraryEntryKey(lib)));
    const arduinoBusy = !!installingArduino || !!uninstallingArduino || !!activeLibraryOperation;
    const cloudBusy = !!installingCloud || !!activeLibraryOperation;
    const localImportBusy = importingLib || importingArduinoZip || !!activeLibraryOperation;
    const libraryBusyReason = activeLibraryOperation
        ? t('manager.operation.processing', { label: activeLibraryOperation.label, stage: activeLibraryOperation.stage })
        : importingLib
            ? t('manager.operation.importingBlocks')
            : importingArduinoZip
                ? t('manager.operation.importingArduino')
                : '';
    const operationElapsedSeconds = (operationElapsedMs / 1000).toFixed(1);

    return (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50" onClick={onClose}>
            <div
                className="bg-white dark:bg-slate-900 rounded-lg shadow-2xl w-[940px] h-[85vh] max-w-[95vw] flex flex-col border border-slate-200 dark:border-slate-800 overflow-hidden"
                onClick={(event) => event.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-labelledby="library-manager-title"
            >
                <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-slate-100 dark:border-slate-800">
                    <div className="flex min-w-0 items-center gap-3">
                        <div className="w-9 h-9 rounded-md bg-brand-50 text-[var(--accent)] flex items-center justify-center"><BookOpen size={19} /></div>
                        <div className="min-w-0">
                            <h2 id="library-manager-title" className="text-base font-bold text-slate-800 dark:text-slate-100">{t('manager.title')}</h2>
                            {projectPath.trim() ? <p className="truncate text-xs text-slate-400 mt-0.5" title={t('manager.currentBoard', { board: activeBoard })}>{t('manager.currentBoard', { board: activeBoard })}</p> : <label className="mt-1 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                                {t('manager.browsingBoard')}
                                <select aria-label={t('manager.browsingBoard')} value={activeBoardPackageId || activeBoard} disabled={Boolean(libraryBusyReason)} onChange={event => {
                                    const board = availableBoards.find(item => boardPackageKey(item) === event.target.value);
                                    if (board) setActiveBoard(String(board.fqbn), boardPackageKey(board));
                                }} className="max-w-[250px] rounded border border-slate-200 bg-white px-2 py-1 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                                    {!availableBoards.some(item => boardPackageKey(item) === (activeBoardPackageId || activeBoard)) && <option value={activeBoardPackageId || activeBoard}>{activeBoard}</option>}
                                    {availableBoards.map(board => <option key={boardPackageKey(board)} value={boardPackageKey(board)}>{board.name || board.fqbn}</option>)}
                                </select>
                            </label>}
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => { void refreshInstalledLibraries(); void refreshArduinoInstalled(); }}
                            disabled={Boolean(libraryBusyReason)}
                            title={libraryBusyReason || t('manager.refreshInstalled')}
                            className="h-9 px-3 flex items-center gap-2 rounded-md border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                        >
                            <RefreshCw size={14} /> {t('manager.refresh')}
                        </button>
                        <button onClick={onClose} className="w-9 h-9 flex items-center justify-center rounded-md hover:bg-slate-100 dark:hover:bg-slate-800" aria-label={t('manager.closeAria')}>
                            <X size={19} />
                        </button>
                    </div>
                </div>

                <div className="flex border-b border-slate-100 dark:border-slate-800 px-4 gap-1">
                    {(['installed', 'discover', 'import'] as TabType[]).map((item) => (
                        <button
                            key={item}
                            onClick={() => setTab(item)}
                            className={`px-3 py-3 text-sm font-bold border-b-2 transition-colors flex items-center gap-2 ${tab === item ? 'border-brand-600 text-[var(--accent)]' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
                        >
                            {item === 'installed' ? <><Database size={15} /> {t('manager.tabs.installed')}</> : item === 'discover' ? <><Cloud size={15} /> {t('manager.tabs.discover')}</> : <><HardDrive size={15} /> {t('manager.tabs.import')}</>}
                        </button>
                    ))}
                </div>

                {activeLibraryOperation && (
                    <div
                        className="mx-6 mt-4 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2.5 text-brand-900 dark:border-brand-800 dark:bg-brand-950/35 dark:text-brand-100"
                        role="status"
                        aria-live="polite"
                    >
                        <div className="flex items-start gap-2.5">
                            <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-brand-600 dark:text-brand-300" aria-hidden="true" />
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                                    <div className="min-w-0 truncate text-xs font-bold">{activeLibraryOperation.label}</div>
                                    <div className="flex shrink-0 items-center gap-1 text-[10px] font-semibold opacity-75">
                                        <Clock3 size={11} aria-hidden="true" /> {t('manager.waited', { seconds: operationElapsedSeconds })}
                                    </div>
                                </div>
                                <div className="mt-0.5 text-[11px] leading-4 opacity-85">
                                    {activeLibraryOperation.stage}
                                    {activeLibraryOperation.total > 1
                                        ? ` · ${t('manager.queueProgress', { current: activeLibraryOperation.current, total: activeLibraryOperation.total })}`
                                        : ''}
                                </div>
                                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-brand-100 dark:bg-brand-900/70">
                                    {activeLibraryOperation.total > 1 ? (
                                        <div
                                            className="h-full rounded-full bg-brand-600 transition-[width] duration-300 dark:bg-brand-300"
                                            style={{ width: `${Math.max(4, Math.min(100, ((activeLibraryOperation.current - 1) / activeLibraryOperation.total) * 100))}%` }}
                                        />
                                    ) : (
                                        <div className="h-full w-1/3 animate-pulse rounded-full bg-brand-600 dark:bg-brand-300" />
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                <div className="flex-1 overflow-auto p-6 space-y-4">
                    {cloudInstallResults.length > 0 && (
                        <section className="rounded-lg border border-slate-200 p-3 dark:border-slate-700" aria-live="polite">
                            <div className="flex items-center justify-between gap-2">
                                <h3 className="text-sm font-bold">{t('manager.cloud.results')}</h3>
                                <button disabled={!!installingCloud} onClick={() => setCloudInstallResults([])} className="text-xs text-slate-500 disabled:opacity-50">{t('manager.import.clearResults')}</button>
                            </div>
                            {cloudInstallResults.map((result, index) => {
                                const feedback = result.error ? describeLibraryOperationError(result.error) : null;
                                return (
                                    <article key={`${result.url}:${index}`} className="mt-2 border-t border-slate-100 pt-2 text-xs dark:border-slate-800">
                                        <div className="flex items-start gap-2">
                                            {result.status === 'installed' ? <CheckCircle2 size={14} className="shrink-0 text-emerald-600 dark:text-emerald-300" /> : result.status === 'checking' ? <Loader2 size={14} className="shrink-0 animate-spin" /> : <AlertCircle size={14} className="shrink-0 text-amber-600" />}
                                            <div className="min-w-0 flex-1 break-words">
                                                <div className="font-semibold">{result.name} · {t(`manager.cloud.resultStatus.${result.status}`)}</div>
                                                {result.reason && <p className="mt-1">{t(`manager.cloud.${result.reason}`)}</p>}
                                                {feedback && <p className="mt-1">{feedback.summaryCode ? t(feedback.summaryCode, feedback.summaryParams) : feedback.summary}</p>}
                                                {feedback && <details className="mt-1"><summary className="cursor-pointer text-slate-500">{t('manager.import.fullReason')}</summary><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-100 p-2 dark:bg-slate-900">{feedback.raw}</pre></details>}
                                            </div>
                                        </div>
                                    </article>
                                );
                            })}
                        </section>
                    )}
                    {tab === 'discover' && (
                        <div className="inline-flex items-center h-9 p-0.5 bg-slate-100 border border-slate-200 rounded-md">
                            <button onClick={() => setDiscoverKind('blocks')} className={`h-8 px-3 rounded flex items-center gap-2 text-xs font-bold ${discoverKind === 'blocks' ? 'bg-white text-[var(--accent)] shadow-sm' : 'text-slate-500'}`}>
                                <Box size={14} /> {t('manager.kinds.blocks')}
                            </button>
                            <button onClick={() => setDiscoverKind('arduino')} className={`h-8 px-3 rounded flex items-center gap-2 text-xs font-bold ${discoverKind === 'arduino' ? 'bg-white text-[var(--accent)] shadow-sm' : 'text-slate-500'}`}>
                                <Database size={14} /> {t('manager.kinds.arduino')}
                            </button>
                        </div>
                    )}
                    {tab === 'installed' && (
                        <>
                            {userLibraries.length > 0 && (
                                <>
                                    <div className="flex items-center justify-between mb-2">
                                        <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2"><Box size={15} className="text-[var(--accent)]" /> {t('manager.installedBlocks')}</h3>
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => setSelectedLibs(allLibSelected ? [] : userLibraries.map((lib) => libraryEntryKey(lib)))}
                                                className="px-2 py-1 text-xs rounded border"
                                            >
                                                {allLibSelected ? t('manager.none') : t('manager.all')}
                                            </button>
                                            <button
                                                onClick={() => void bulkDeleteLibs()}
                                                disabled={bulkDeletingLibs || selectedLibs.length === 0}
                                                className="px-2 py-1 text-xs rounded bg-red-500 text-white disabled:opacity-50"
                                            >
                                                {bulkDeletingLibs ? t('manager.bulkDeleting') : t('manager.bulkDelete', { count: selectedLibs.length })}
                                            </button>
                                        </div>
                                    </div>

                                    <div className="space-y-2 mb-6">
                                        {userLibraries.map((lib) => {
                                            const entryKey = libraryEntryKey(lib);
                                            const deleting = deletingLib === entryKey;
                                            const qualityExpanded = expandedQualityKey === entryKey;
                                            const activation = blockRuntimeActivation(lib);
                                            return (
                                                <div key={entryKey} className="border border-slate-200 dark:border-slate-700 rounded-lg p-3">
                                                    <div className="flex items-center justify-between gap-3">
                                                        <div className="flex items-center gap-2 min-w-0">
                                                            <input
                                                                type="checkbox"
                                                                checked={selectedLibs.includes(entryKey)}
                                                                onChange={(event) => setSelectedLibs((prev) => event.target.checked ? [...new Set([...prev, entryKey])] : prev.filter((item) => item !== entryKey))}
                                                            />
                                                            <div className="min-w-0">
                                                                <div className="flex flex-wrap items-center gap-2 min-w-0">
                                                                    <div className="font-semibold truncate">{lib.name}</div>
                                                                    <PackageQualityStatusBadge report={lib.quality_report} />
                                                                    <BlockPackagePassportBadge library={lib} />
                                                                    {(activation.executablePresent || activation.state === 'declarative-safe') && (
                                                                        <span className={`px-1.5 py-0.5 text-[11px] rounded border whitespace-nowrap ${runtimeBadgeClass(lib)}`}>
                                                                            {t(runtimeActivationLabelKey(lib))}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                <div className="text-xs text-slate-500 truncate">{libraryMetaLabel(lib)}</div>
                                                            </div>
                                                        </div>
                                                        <div className="flex shrink-0 items-center gap-2">
                                                            <button
                                                                type="button"
                                                                onClick={() => setExpandedQualityKey(current => current === entryKey ? null : entryKey)}
                                                                className="h-8 px-2 text-xs rounded border border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 flex items-center gap-1.5"
                                                                aria-expanded={qualityExpanded}
                                                            >
                                                                {t('manager.qualityEvidence')} <ChevronDown size={13} className={`transition-transform ${qualityExpanded ? 'rotate-180' : ''}`} />
                                                            </button>
                                                            <button
                                                                onClick={() => void deleteLibrary(lib)}
                                                                disabled={deleting}
                                                                className="h-8 px-2 text-xs rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50 flex items-center gap-1.5"
                                                            >
                                                                <Trash2 size={13} /> {deleting ? t('manager.deleting') : t('manager.delete')}
                                                            </button>
                                                        </div>
                                                    </div>
                                                    {qualityExpanded && (
                                                        <div className="mt-3 space-y-3">
                                                            <BlockPackagePassportPanel library={lib} />
                                                            <PackageQualityReportPanel
                                                                report={lib.quality_report}
                                                                metadataVersion={lib.block_manifest?.schema_version ?? (lib.manifest as any)?.schema_version}
                                                                sourceLabel={t('manager.import.localUser')}
                                                            />
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </>
                            )}

                            {protectedLibraries.length > 0 ? (
                                <>
                                    <div className="text-sm font-bold text-slate-700 mb-4 flex items-center gap-2"><ShieldCheck size={15} className="text-slate-500" /> {t('manager.bundledBlocks')}</div>
                                    <div className="space-y-2">
                                        {protectedLibraries.map((lib) => {
                                            const entryKey = `protected:${libraryEntryKey(lib)}`;
                                            const qualityExpanded = expandedQualityKey === entryKey;
                                            const activation = blockRuntimeActivation(lib);
                                            return (
                                                <div key={entryKey} className="border border-slate-200 dark:border-slate-700 rounded-lg p-3">
                                                    <div className="flex items-center justify-between gap-3">
                                                        <div className="min-w-0">
                                                            <div className="flex flex-wrap items-center gap-2 min-w-0">
                                                                <div className="font-semibold truncate">{lib.name}</div>
                                                                <PackageQualityStatusBadge report={lib.quality_report} />
                                                                <BlockPackagePassportBadge library={lib} />
                                                                {(activation.executablePresent || activation.state === 'declarative-safe') && (
                                                                    <span className={`px-1.5 py-0.5 text-[11px] rounded border whitespace-nowrap ${runtimeBadgeClass(lib)}`}>
                                                                        {t(runtimeActivationLabelKey(lib))}
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <div className="text-xs text-slate-500 truncate">{libraryMetaLabel(lib)}</div>
                                                        </div>
                                                        <div className="flex shrink-0 items-center gap-2">
                                                            <button
                                                                type="button"
                                                                onClick={() => setExpandedQualityKey(current => current === entryKey ? null : entryKey)}
                                                                className="h-8 px-2 text-xs rounded border border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 flex items-center gap-1.5"
                                                                aria-expanded={qualityExpanded}
                                                            >
                                                                {t('manager.qualityEvidence')} <ChevronDown size={13} className={`transition-transform ${qualityExpanded ? 'rotate-180' : ''}`} />
                                                            </button>
                                                            <span className="px-2 py-1 text-xs rounded border text-slate-500 flex items-center gap-1.5"><ShieldCheck size={12} /> {t('manager.protected')}</span>
                                                        </div>
                                                    </div>
                                                    {qualityExpanded && (
                                                        <div className="mt-3 space-y-3">
                                                            <BlockPackagePassportPanel library={lib} />
                                                            <PackageQualityReportPanel
                                                                report={lib.quality_report}
                                                                metadataVersion={lib.block_manifest?.schema_version ?? (lib.manifest as any)?.schema_version}
                                                                sourceLabel={libraryLocationLabel(lib) || t('manager.import.bundledSource')}
                                                            />
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </>
                            ) : (
                                <div className="text-sm text-slate-500 border rounded-lg p-3">{t('manager.noExtraBlocks')}</div>
                            )}

                            <div className="mt-6">
                                <div className="flex items-center justify-between mb-2">
                                    <div className="text-sm font-bold text-slate-500">{t('manager.installedArduino')}</div>
                                    <button
                                        onClick={() => {
                                            setTab('discover');
                                            setDiscoverKind('arduino');
                                            setArduinoView('installed');
                                        }}
                                        className="px-2 py-1 text-xs rounded border hover:bg-slate-50"
                                    >
                                        {t('manager.viewAll')}
                                    </button>
                                </div>

                                {installedArduinoNames.length > 0 ? (
                                    <div className="space-y-2">
                                        {installedArduinoNames.slice(0, 20).map((lib) => (
                                            <div key={`arduino:${lib.installDir || lib.name}`} className="border rounded-lg p-3">
                                                <div className="flex items-center justify-between gap-3">
                                                    <div className="min-w-0">
                                                        <div className="font-semibold truncate">{lib.name}</div>
                                                        <div className="text-xs text-slate-500 truncate">v{lib.version}</div>
                                                    </div>
                                                    <div className="flex shrink-0 items-center gap-2">
                                                        {lib.qualityReport ? <PackageQualityStatusBadge report={lib.qualityReport} /> : null}
                                                        <span className="px-2 py-1 text-xs rounded border text-emerald-700 border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">{t('manager.installed')}</span>
                                                    </div>
                                                </div>
                                                {lib.qualityReport ? (
                                                    <details className="mt-2 border-t border-slate-200 pt-2 dark:border-slate-700">
                                                        <summary className="cursor-pointer text-[11px] font-semibold text-slate-500 dark:text-slate-400">{t('manager.quality.view')}</summary>
                                                        <div className="mt-2">
                                                            <PackageQualityReportPanel
                                                                compact
                                                                report={lib.qualityReport}
                                                                metadataVersion={lib.qualityReport.schema_version}
                                                                sourceLabel={lib.installSource?.source === 'local-arduino-zip' ? t('manager.import.localArduino') : t('manager.kinds.arduino')}
                                                            />
                                                        </div>
                                                    </details>
                                                ) : null}
                                            </div>
                                        ))}
                                        {installedArduinoNames.length > 20 && (
                                            <div className="text-xs text-slate-500">{t('manager.installedMany')}</div>
                                        )}
                                    </div>
                                ) : (
                                    <div className="text-sm text-slate-500 border rounded-lg p-3">{t('manager.noInstalledArduino')}</div>
                                )}
                            </div>
                        </>
                    )}

                    {tab === 'discover' && discoverKind === 'blocks' && (
                        <>
                            <div className="flex flex-col gap-2">
                                <div className="flex gap-2 flex-wrap">
                                    <div className="relative flex-1 min-w-[220px]">
                                        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                        <input
                                            type="text"
                                            placeholder={t('manager.searchBlocks')}
                                            value={cloudQuery}
                                            onChange={(event) => setCloudQuery(event.target.value)}
                                            className="w-full h-10 pl-9 pr-3 rounded border"
                                        />
                                    </div>
                                    {selectedCloudLibs.length > 0 && (
                                        <button
                                            onClick={() => void batchInstallCloud()}
                                            disabled={cloudBusy}
                                            title={cloudBusy ? libraryBusyReason : t('manager.cloud.batchInstall', { count: selectedCloudLibs.length })}
                                            className="h-10 px-3 rounded bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-50 flex-none text-sm whitespace-nowrap"
                                        >
                                            {t('manager.batchInstall', { count: selectedCloudLibs.length })}
                                        </button>
                                    )}
                                    <select value={provider} onChange={(event) => setProvider(event.target.value as CloudProvider)} className="h-10 px-3 rounded border">
                                        <option value="auto">{t('manager.cloud.auto')}</option>
                                        <option value="gitee">Gitee</option>
                                        <option value="github">GitHub</option>
                                    </select>
                                    <input
                                        value={registryUrl}
                                        onChange={(event) => setRegistryUrl(event.target.value)}
                                        className="flex-1 min-w-[240px] h-10 px-3 rounded border"
                                        placeholder={t('manager.cloud.repository')}
                                    />
                                    <button
                                        onClick={saveAndFetchRegistry}
                                        disabled={registryLoading || cloudBusy}
                                        title={cloudBusy ? libraryBusyReason : t('manager.cloud.readRepository')}
                                        className="h-10 px-3 rounded bg-brand-500 text-white disabled:opacity-50"
                                    >
                                        <span className="inline-flex items-center gap-2"><DownloadCloud size={14} /> {registryLoading ? t('manager.loading') : t('manager.readRepository')}</span>
                                    </button>
                                </div>
                            </div>

                            <div className="space-y-2">
                                {visibleCloud.length === 0 && (
                                    <div className="text-sm text-slate-500 border rounded-lg p-3">{t('manager.noInstallable')}</div>
                                )}

                                {visibleCloud.map((lib) => {
                                    const needsReinstall = availableLibraries.some(item => (
                                        item.user_installed && item.id === lib.id && item.runtime_activation?.state === 'quality-blocked'
                                    ));
                                    const installed = !needsReinstall && [k(lib.id), k(lib.name), nk(lib.id), nk(lib.name)].some((item) => item && installedLibKeys.has(item));
                                    const installing = installingCloud === lib.name;
                                    const selected = selectedCloudLibs.some((item) => item.url === lib.url);
                                    return (
                                        <div key={`${lib.id || lib.name}:${lib.version}:${lib.url}`} className="border rounded-lg p-3 flex items-center justify-between gap-3">
                                            <input
                                                type="checkbox"
                                                className="form-checkbox h-4 w-4 text-blue-600 rounded flex-none"
                                                checked={selected}
                                                onChange={(event) => {
                                                    if (event.target.checked) {
                                                        setSelectedCloudLibs((prev) => [...prev, lib].filter((item, index, arr) => arr.findIndex((candidate) => candidate.url === item.url) === index));
                                                    } else {
                                                        setSelectedCloudLibs((prev) => prev.filter((item) => item.url !== lib.url));
                                                    }
                                                }}
                                                disabled={installed || installing || cloudBusy || !n(lib.url)}
                                                title={cloudBusy ? libraryBusyReason : undefined}
                                            />
                                            <div className="min-w-0 flex-1">
                                                <div className="font-semibold truncate">{lib.name}</div>
                                                <div className="text-xs text-slate-500 truncate">v{lib.version}{lib.author ? ` · ${lib.author}` : ''}</div>
                                            </div>
                                            <button
                                                onClick={() => void cloudInstall(lib)}
                                                disabled={cloudBusy || installing || installed || !n(lib.url)}
                                                title={cloudBusy && !installing ? libraryBusyReason : installed ? t('manager.alreadyInstalled') : undefined}
                                                className="max-w-[210px] truncate px-2 py-1 text-xs rounded bg-brand-500 text-white disabled:opacity-50 flex-none"
                                            >
                                                {installing
                                                    ? `${t('manager.installing')} ${activeLibraryOperation?.current || 1}/${activeLibraryOperation?.total || 1}`
                                                    : installed
                                                        ? t('manager.installed')
                                                        : cloudBusy
                                                            ? libraryBusyReason || t('manager.operation.busy')
                                                            : needsReinstall ? t('manager.cloud.reinstall') : t('manager.install')}
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        </>
                    )}

                    {tab === 'discover' && discoverKind === 'arduino' && (
                        <>
                            <div className="flex gap-2 flex-wrap">
                                <input
                                    ref={arduinoSearchInputRef}
                                    value={arduinoQuery}
                                    onChange={(event) => setArduinoQuery(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter') {
                                            event.preventDefault();
                                            void searchArduino();
                                        }
                                    }}
                                    className="flex-1 min-w-[220px] h-10 px-3 rounded border"
                                    placeholder={t('manager.searchArduino')}
                                />
                                <button
                                    onClick={() => void searchArduino()}
                                    disabled={arduinoLoading || arduinoBusy}
                                    title={arduinoBusy ? libraryBusyReason : t('manager.discoverIndex')}
                                    className="h-10 px-3 rounded bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-50"
                                >
                                    {arduinoLoading ? t('manager.searching') : t('manager.searchAction')}
                                </button>
                                <select
                                    value={arduinoView}
                                    onChange={(event) => setArduinoView(event.target.value as 'search' | 'installed')}
                                    disabled={arduinoBusy}
                                    title={arduinoBusy ? libraryBusyReason : t('manager.switchList')}
                                    className="h-10 px-3 rounded border"
                                >
                                    <option value="search">{t('manager.searchResults')}</option>
                                    <option value="installed">{t('manager.installedLibraries')}</option>
                                </select>
                                <button
                                    onClick={() => void refreshArduinoInstalled()}
                                    disabled={arduinoBusy}
                                    title={arduinoBusy ? libraryBusyReason : t('manager.refreshArduino')}
                                    className="h-10 px-3 rounded border disabled:opacity-50"
                                >
                                    {t('manager.refresh')}
                                </button>
                                <button
                                    onClick={async () => {
                                        setUpdatingArduinoIndex(true);
                                        startLibraryOperation({
                                            kind: 'index-update',
                                            label: t('manager.arduinoIndex'),
                                            stage: t('manager.operation.updatingIndex'),
                                            current: 1,
                                            total: 1,
                                        });
                                        try {
                                            await invoke('update_arduino_library_index');
                                            showToast(t('manager.indexUpdated'), 'success');
                                        } catch (error: any) {
                                            showToast(t('manager.indexUpdateFailed', { error: error?.message || error }), 'error');
                                        } finally {
                                            setUpdatingArduinoIndex(false);
                                            finishLibraryOperation();
                                        }
                                    }}
                                    disabled={updatingArduinoIndex || arduinoBusy}
                                    title={arduinoBusy ? libraryBusyReason : t('manager.updateIndex')}
                                    className="h-10 px-3 rounded border disabled:opacity-50"
                                >
                                    {updatingArduinoIndex ? t('manager.updating') : t('manager.updateIndex')}
                                </button>
                            </div>

                            {arduinoStatus && <div className="text-xs text-slate-500">{arduinoStatus}</div>}
                            {arduinoOpStatus && <div className="text-xs text-slate-500">{arduinoOpStatus}</div>}
                            {arduinoBusy && (
                                <div className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
                                    {libraryBusyReason || t('manager.operation.arduinoBusy')}
                                </div>
                            )}

                            {(arduinoView === 'search'
                                ? arduinoResults
                                : installedArduinoNames.map((lib) => ({
                                    name: lib.name,
                                    latest: { version: lib.version },
                                    available_versions: [],
                                    ckQualityReport: lib.qualityReport,
                                    ckInstallSource: lib.installSource,
                                }))
                            ).map((lib: any) => {
                                const libName = getArduinoName(lib);
                                const key = k(libName);
                                const normalizedKey = nk(libName);
                                const installedVersion = installedArduino[key] || (normalizedKey ? installedArduinoNormalized[normalizedKey] : '');
                                const versions = getArduinoVersions(lib);
                                const author = getArduinoAuthor(lib);
                                const desc = getArduinoDesc(lib);
                                const latestVersion = getArduinoLatestVersion(lib);
                                const installed = !!installedVersion;
                                const installedDetails = installedArduinoNames.find((item) => k(item.name) === key || nk(item.name) === normalizedKey);
                                const qualityReport = lib?.ckQualityReport || installedDetails?.qualityReport;
                                const installSource = lib?.ckInstallSource || installedDetails?.installSource;
                                const isInstalling = installingArduino === libName;
                                const isUninstalling = uninstallingArduino === libName;

                                return (
                                    <div key={libName} className="border rounded-lg p-3">
                                      <div className="flex items-center justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="font-semibold truncate">{libName}</div>
                                            <div className="text-xs text-slate-500 truncate">
                                                {latestVersion}{installedVersion ? ` · ${t('manager.versionInstalled', { version: installedVersion })}` : ''}
                                            </div>
                                            <div className="text-xs text-slate-500 truncate">{author}</div>
                                            {desc ? <div className="text-xs text-slate-400 truncate">{desc}</div> : null}
                                            {(isInstalling || isUninstalling) && (
                                                <div className="text-xs text-brand-600 dark:text-brand-300">{isInstalling ? t('manager.installing') : t('manager.uninstalling')}</div>
                                            )}
                                        </div>

                                        <div className="flex items-center gap-2">
                                            {qualityReport ? <PackageQualityStatusBadge report={qualityReport} /> : null}
                                            {versions.length > 0 && (
                                                <select
                                                    value={arduinoVersions[key] || ''}
                                                    onChange={(event) => setArduinoVersions((prev) => ({ ...prev, [key]: event.target.value }))}
                                                    disabled={arduinoBusy}
                                                    title={arduinoBusy ? libraryBusyReason : t('manager.selectVersion')}
                                                    className="h-8 px-2 rounded border text-xs disabled:opacity-50"
                                                >
                                                    <option value="">{t('manager.latest')}</option>
                                                    {versions.map((version) => (
                                                        <option key={version} value={version}>{version}</option>
                                                    ))}
                                                </select>
                                            )}
                                            <button
                                                onClick={() => void installArduinoLib(lib)}
                                                disabled={arduinoBusy || installed}
                                                title={arduinoBusy ? libraryBusyReason : installed ? t('manager.alreadyInstalled') : t('manager.installNamed', { name: libName })}
                                                className="px-2 py-1 text-xs rounded bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-50"
                                            >
                                                {isInstalling ? t('manager.installing') : isUninstalling ? t('manager.uninstalling') : installed ? t('manager.installed') : t('manager.install')}
                                            </button>
                                            {installed && latestVersion !== '-' && installedVersion && installedVersion !== latestVersion && (
                                                <button
                                                    onClick={() => void installArduinoLib(lib)}
                                                    disabled={arduinoBusy}
                                                    className="px-2 py-1 text-xs rounded bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-50"
                                                    title={arduinoBusy ? libraryBusyReason : t('manager.updateTo', { version: latestVersion })}
                                                >
                                                    {t('manager.update')}
                                                </button>
                                            )}
                                            {installed && (
                                                <button
                                                    onClick={() => void uninstallArduinoLib(lib)}
                                                    disabled={arduinoBusy}
                                                    title={arduinoBusy ? libraryBusyReason : t('manager.uninstallNamed', { name: libName })}
                                                    className="px-2 py-1 text-xs rounded bg-red-500 text-white disabled:opacity-50"
                                                >
                                                    {isUninstalling ? t('manager.uninstalling') : t('manager.uninstall')}
                                                </button>
                                            )}
                                        </div>
                                      </div>
                                      {qualityReport ? (
                                        <details className="mt-2 border-t border-slate-200 pt-2 dark:border-slate-700">
                                            <summary className="cursor-pointer text-[11px] font-semibold text-slate-500 dark:text-slate-400">{t('manager.quality.view')}</summary>
                                            <div className="mt-2">
                                                <PackageQualityReportPanel
                                                    compact
                                                    report={qualityReport}
                                                    metadataVersion={qualityReport.schema_version}
                                                    sourceLabel={installSource?.source === 'local-arduino-zip' ? t('manager.import.localArduino') : t('manager.kinds.arduino')}
                                                />
                                            </div>
                                        </details>
                                      ) : null}
                                    </div>
                                );
                            })}
                        </>
                    )}

                    {tab === 'import' && (
                        <div className="space-y-4 pt-2">
                            <div className="rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-xs leading-relaxed text-brand-800 dark:border-brand-900 dark:bg-brand-950/35 dark:text-brand-200">
                                <div className="flex items-center gap-2 font-bold"><ShieldCheck size={14} /> {t('manager.quality.title')}</div>
                                <p className="mt-1 opacity-85">{t('manager.quality.description')}</p>
                                <p className="mt-1 text-[10px] opacity-70">{t('manager.quality.notice')}</p>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <section className="border border-slate-200 rounded-lg p-5 flex flex-col min-h-[240px]">
                                    <div className="w-10 h-10 rounded-md bg-brand-50 text-[var(--accent)] flex items-center justify-center"><Box size={20} /></div>
                                    <h3 className="font-bold text-slate-800 mt-4">{t('manager.import.ckTitle')}</h3>
                                    <p className="text-sm text-slate-500 mt-2 leading-6 flex-1">{t('manager.import.ckDescription')}</p>
                                    {!projectPath.trim() && <p className="my-3 text-xs leading-5 text-brand-700 dark:text-brand-300">{t('manager.import.projectRequired')}</p>}
                                    <button
                                        onClick={() => void importLibraryZip()}
                                        disabled={localImportBusy || !projectPath.trim()}
                                        title={!projectPath.trim() ? t('manager.import.projectRequired') : localImportBusy ? libraryBusyReason : t('manager.import.chooseCk')}
                                        className="h-10 px-4 rounded-md bg-brand-600 hover:bg-brand-700 text-white text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50 flex items-center justify-center gap-2"
                                    >
                                        <Upload size={15} /> {importingLib ? `${t('manager.importingBlocks')} ${activeLibraryOperation?.current || 1}/${activeLibraryOperation?.total || 1}` : t('manager.import.chooseCk')}
                                    </button>
                                </section>

                                <section className="border border-slate-200 rounded-lg p-5 flex flex-col min-h-[240px]">
                                    <div className="w-10 h-10 rounded-md bg-blue-50 text-blue-600 flex items-center justify-center"><Database size={20} /></div>
                                    <h3 className="font-bold text-slate-800 mt-4">{t('manager.import.arduinoTitle')}</h3>
                                    <p className="text-sm text-slate-500 mt-2 leading-6 flex-1">{t('manager.import.arduinoDescription')}</p>
                                    <button
                                        onClick={() => void importArduinoLibraryZip()}
                                        disabled={localImportBusy}
                                        title={localImportBusy ? libraryBusyReason : t('manager.import.chooseArduino')}
                                        className="h-10 px-4 rounded-md border border-blue-200 text-blue-700 hover:bg-blue-50 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50 flex items-center justify-center gap-2 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/35"
                                    >
                                        <Upload size={15} /> {importingArduinoZip ? `${t('manager.importingArduino')} ${activeLibraryOperation?.current || 1}/${activeLibraryOperation?.total || 1}` : t('manager.import.chooseArduino')}
                                    </button>
                                </section>
                            </div>

                            {importQueue.length > 0 && (
                                <section className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
                                    <div className="flex items-center justify-between gap-3">
                                        <div>
                                            <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">{t('manager.import.queueTitle')}</h3>
                                            <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                                                {t('manager.import.queueSummary', { success: importQueue.filter(item => item.status === 'success').length, failed: importQueue.filter(item => item.status === 'failed').length, total: importQueue.length })}
                                            </p>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => setImportQueue([])}
                                            disabled={localImportBusy}
                                            title={localImportBusy ? libraryBusyReason : t('manager.import.clearResults')}
                                            className="rounded border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-500 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300"
                                        >{t('manager.import.clearResults')}</button>
                                    </div>

                                    <div className="mt-3 space-y-2">
                                        {importQueue.map(item => {
                                            const StatusIcon = item.status === 'success'
                                                ? CheckCircle2
                                                : item.status === 'failed'
                                                    ? AlertCircle
                                                    : item.status === 'running'
                                                        ? Loader2
                                                        : Clock3;
                                            return (
                                                <article key={item.id} className="rounded-md border border-slate-200 px-3 py-2 dark:border-slate-700">
                                                    <div className="flex items-start gap-2">
                                                        <StatusIcon
                                                            size={15}
                                                            className={`mt-0.5 shrink-0 ${item.status === 'running' ? 'animate-spin text-brand-600 dark:text-brand-300' : item.status === 'failed' ? 'text-red-600' : item.status === 'success' ? 'text-emerald-600' : 'text-slate-400'}`}
                                                            aria-hidden="true"
                                                        />
                                                        <div className="min-w-0 flex-1">
                                                            <div className="flex flex-wrap items-center gap-2">
                                                                <div className="min-w-0 flex-1 truncate text-xs font-bold text-slate-800 dark:text-slate-100" title={item.path}>{item.label}</div>
                                                                <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold ${importQueueStatusClass(item.status)}`}>
                                                                    {t(importQueueStatusKey(item.status))}
                                                                </span>
                                                            </div>
                                                            {(item.summary || item.summaryCode) && (
                                                                <div className={`mt-1 break-words text-[11px] leading-4 ${item.status === 'failed' ? 'font-semibold text-red-700 dark:text-red-300' : 'text-slate-600 dark:text-slate-300'}`}>
                                                                    {item.summaryCode ? t(item.summaryCode, item.summaryParams) : item.summary}
                                                                </div>
                                                            )}
                                                            {item.status === 'failed' && (item.details?.length || item.rawError) && (
                                                                <details className="mt-1.5 rounded border border-red-100 bg-red-50/50 px-2 py-1.5 dark:border-red-900/60 dark:bg-red-950/20">
                                                                    <summary className="cursor-pointer text-[10px] font-bold text-red-700 dark:text-red-300">{t('manager.import.fullReason')}</summary>
                                                                    {item.details && item.details.length > 0 && (
                                                                        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[10px] leading-4 text-red-700 dark:text-red-300">
                                                                            {item.details.map((detail, index) => <li key={`${index}:${detail}`}>{detail}</li>)}
                                                                        </ul>
                                                                    )}
                                                                    {item.rawError && (
                                                                        <div className="mt-1.5 flex items-start gap-2">
                                                                            <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded bg-white/80 p-1.5 text-[9px] leading-4 text-slate-600 dark:bg-slate-950/70 dark:text-slate-300">{item.rawError}</pre>
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => {
                                                                                    void navigator.clipboard.writeText(item.rawError || '')
                                                                                        .then(() => showToast(t('manager.import.copied'), 'success'))
                                                                                        .catch(error => showToast(t('manager.import.copyFailed', { error: String(error) }), 'error'));
                                                                                }}
                                                                                className="inline-flex shrink-0 items-center gap-1 rounded border border-red-200 bg-white px-2 py-1 text-[10px] font-bold text-red-700 dark:border-red-800 dark:bg-slate-900 dark:text-red-300"
                                                                            ><Copy size={11} />{t('manager.import.copy')}</button>
                                                                        </div>
                                                                    )}
                                                                </details>
                                                            )}
                                                        </div>
                                                    </div>
                                                </article>
                                            );
                                        })}
                                    </div>
                                </section>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default LibraryManagerModal;
