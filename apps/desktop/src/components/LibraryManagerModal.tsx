import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, BookOpen, Box, CheckCircle2, ChevronDown, Clock3, Cloud, Copy, Database, DownloadCloud, HardDrive, Loader2, RefreshCw, Search, ShieldCheck, Trash2, Upload, X } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useHardware } from '../contexts/HardwareContext';
import { useDialog } from '../contexts/DialogContext';
import type { LibraryInfo } from '../types/library';
import type { PackageQualityReport } from '../types/packageQuality';
import { boardPackageKey } from '../services/board_identity';
import { PackageQualityReportPanel, PackageQualityStatusBadge } from './PackageQualityReportPanel';
import { BlockPackagePassportBadge, BlockPackagePassportPanel } from './BlockPackagePassport';
import {
    blockRuntimeActivation,
    runtimeActivationLabel,
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
    describeLibraryOperationError,
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

const importQueueStatusLabel = (status: LibraryImportQueueItem['status']): string => ({
    pending: '等待',
    running: '处理中',
    success: '成功',
    failed: '失败',
    skipped: '已跳过',
}[status]);

const importQueueStatusClass = (status: LibraryImportQueueItem['status']): string => {
    if (status === 'success') return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/35 dark:text-emerald-300';
    if (status === 'failed') return 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/35 dark:text-red-300';
    if (status === 'running') return 'border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-800 dark:bg-teal-950/35 dark:text-teal-300';
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
    const {
        availableLibraries,
        reloadLibraries,
        activeBoard,
        activeBoardPackageId,
        availableBoards,
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

    const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
            return await new Promise<T>((resolve, reject) => {
                timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
                promise.then(resolve).catch(reject);
            });
        } finally {
            if (timer) clearTimeout(timer);
        }
    };

    const refreshInstalledLibraries = async () => {
        await reloadLibraries(activeBoard, activeBoardPackageId);
        if (onExtensionImported) onExtensionImported();
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
            showToast('请先输入仓库地址', 'error');
            return;
        }

        setRegistryLoading(true);
        try {
            const raw = await invoke<string>('fetch_custom_registry', { url: registryUrl, provider });
            const parsed = JSON.parse(String(raw || '{}'));
            setRegistryLibs(Array.isArray(parsed?.libraries) ? parsed.libraries : []);
        } catch (error: any) {
            showToast(`获取仓库失败: ${error?.message || error}`, 'error');
        } finally {
            setRegistryLoading(false);
        }
    };

    const saveAndFetchRegistry = () => {
        localStorage.setItem('ck_custom_registry_provider', provider);
        localStorage.setItem('ck_custom_registry_url', registryUrl);
        void fetchRegistry();
    };

    const cloudInstall = async (lib: RegistryLibrary) => {
        if (cloudInstallLockRef.current || installingCloud || !n(lib.url)) {
            console.warn('[cloudInstall] Blocked by guard:', { lock: cloudInstallLockRef.current, installingCloud, url: lib.url });
            showToast(
                activeLibraryOperation
                    ? `正在处理 ${activeLibraryOperation.label}：${activeLibraryOperation.stage}`
                    : '另一个库操作仍在进行，请等待完成',
                'loading',
            );
            return;
        }
        cloudInstallLockRef.current = true;
        setInstallingCloud(lib.name);
        startLibraryOperation({
            kind: 'cloud-install',
            label: lib.name,
            stage: '正在下载、检查并安装',
            current: 1,
            total: 1,
        });
        try {
            console.log('[cloudInstall] Invoking install_library_from_url:', lib.url, activeBoard);
            await invoke('install_library_from_url', {
                url: lib.url,
                board: activeBoard,
                boardPackageId: activeBoardPackageId,
            });
            console.log('[cloudInstall] Success');
            updateLibraryOperation({ stage: '安装完成，正在刷新库列表' });
            await refreshInstalledLibraries();
            showToast(`已安装 ${lib.name}`, 'success');
        } catch (error: any) {
            console.error('[cloudInstall] Error:', error);
            showToast(`安装失败: ${error?.message || error}`, 'error');
        } finally {
            setInstallingCloud(null);
            cloudInstallLockRef.current = false;
            finishLibraryOperation();
        }
    };

    const batchInstallCloud = async () => {
        if (selectedCloudLibs.length === 0) return;
        if (cloudInstallLockRef.current) {
            showToast(
                activeLibraryOperation
                    ? `正在处理 ${activeLibraryOperation.label}：${activeLibraryOperation.stage}`
                    : '另一个库操作仍在进行，请等待完成',
                'loading',
            );
            return;
        }
        cloudInstallLockRef.current = true;
        startLibraryOperation({
            kind: 'cloud-install',
            label: selectedCloudLibs[0]?.name || '批量安装',
            stage: '准备批量安装',
            current: 1,
            total: selectedCloudLibs.length,
        });
        try {
            for (let index = 0; index < selectedCloudLibs.length; index += 1) {
                const lib = selectedCloudLibs[index];
                setInstallingCloud(lib.name);
                updateLibraryOperation({
                    label: lib.name,
                    stage: '正在下载、检查并安装',
                    current: index + 1,
                    total: selectedCloudLibs.length,
                });
                showToast(`批量安装 (${index + 1}/${selectedCloudLibs.length}): ${lib.name}`, 'loading');
                await invoke('install_library_from_url', {
                    url: lib.url,
                    board: activeBoard,
                    boardPackageId: activeBoardPackageId,
                });
            }
            updateLibraryOperation({ stage: '全部安装完成，正在刷新库列表' });
            await refreshInstalledLibraries();
            setSelectedCloudLibs([]);
            showToast('批量安装完成', 'success');
        } catch (error: any) {
            showToast(`批量安装失败: ${error?.message || error}`, 'error');
        } finally {
            setInstallingCloud(null);
            cloudInstallLockRef.current = false;
            finishLibraryOperation();
        }
    };

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
                    throw new Error('当前工程尚未提供安全迁移上下文，包与工程均未修改');
                }
                const workspaceJson = await readBlockPackageMigrationWorkspace();
                const preview = await previewPreparedBlockLibraryMigration(prepared, workspaceJson);
                const confirmed = await dialog.confirm({
                    title: '预览积木包升级迁移',
                    message: formatBlockLibraryMigrationPreview(preview),
                    type: 'warning',
                    confirmLabel: `建立检查点并升级到 ${prepared.toVersion}`,
                    cancelLabel: '取消，保持原包和工程',
                });
                if (!confirmed) {
                    await cancelPreparedBlockLibraryMigration(prepared.token);
                    prepared = null;
                    return {
                        status: 'skipped' as const,
                        summary: '用户取消升级；原包和工程均未修改',
                        result: null,
                    };
                }
                updateLibraryOperation({ stage: '正在建立迁移前检查点' });
                const checkpointId = await createBlockPackageMigrationCheckpoint(
                    preview.workspaceBeforeJson,
                );
                updateLibraryOperation({ stage: '正在原子提交积木包与工程迁移' });
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
                    ? `积木包 ${result.packageId} 已是相同版本和内容`
                    : result.projectMigrated
                        ? `已升级 ${result.packageId} 并迁移工程；重新启用新哈希的第三方代码后即可编辑`
                        : `CK 积木包 ${result.packageId} 安装成功`,
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
                label: '打开文件选择器',
                status: 'failed',
                summary: feedback.summary,
                details: feedback.details,
                rawError: feedback.raw,
            }]);
            showToast(`无法选择积木包：${feedback.summary}`, 'error');
            return;
        }
        if (paths.length === 0) return;

        const queue = createLibraryImportQueue(paths, 'block-package');
        setImportQueue(queue);
        setImportingLib(true);
        startLibraryOperation({
            kind: 'block-import',
            label: queue[0].label,
            stage: '正在检查并暂存第三方积木包',
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
                updateImportQueueItem(item.id, { status: 'running', summary: '正在执行结构与质量门禁' });
                updateLibraryOperation({
                    label: item.label,
                    stage: '正在执行结构、路径、依赖与质量检查',
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
                        summary: feedback.summary,
                        details: feedback.details,
                        rawError: feedback.raw,
                    });
                }
            }

            if (successCount > 0) {
                updateLibraryOperation({ stage: '正在刷新积木库与编辑器 Toolbox' });
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
                    ? `导入完成：成功 ${successCount}，失败 ${failedCount}${skippedCount ? `，跳过 ${skippedCount}` : ''}；请查看常驻原因`
                    : `导入完成：成功 ${successCount}${skippedCount ? `，跳过 ${skippedCount}` : ''}`,
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
                label: '打开文件选择器',
                status: 'failed',
                summary: feedback.summary,
                details: feedback.details,
                rawError: feedback.raw,
            }]);
            showToast(`无法选择 Arduino ZIP：${feedback.summary}`, 'error');
            return;
        }
        if (paths.length === 0) return;

        const queue = createLibraryImportQueue(paths, 'arduino-zip');
        setImportQueue(queue);
        setImportingArduinoZip(true);
        startLibraryOperation({
            kind: 'arduino-import',
            label: queue[0].label,
            stage: '正在执行 Arduino ZIP 质量门禁',
            current: 1,
            total: queue.length,
        });
        let successCount = 0;
        let failedCount = 0;
        try {
            for (let index = 0; index < queue.length; index += 1) {
                const item = queue[index];
                updateImportQueueItem(item.id, { status: 'running', summary: '正在检查并安装' });
                updateLibraryOperation({
                    label: item.label,
                    stage: '正在检查路径、目录、源码与内容哈希',
                    current: index + 1,
                    total: queue.length,
                });
                try {
                    await invoke('install_arduino_library_zip', { path: item.path });
                    successCount += 1;
                    updateImportQueueItem(item.id, {
                        status: 'success',
                        summary: '已通过质量门禁并导入',
                    });
                } catch (error: unknown) {
                    failedCount += 1;
                    const feedback = describeLibraryOperationError(error);
                    updateImportQueueItem(item.id, {
                        status: 'failed',
                        summary: feedback.summary,
                        details: feedback.details,
                        rawError: feedback.raw,
                    });
                }
            }
            if (successCount > 0) {
                updateLibraryOperation({ stage: '正在刷新 Arduino 库清单' });
                await refreshArduinoInstalled();
            }
            if (failedCount === 0) setTab('installed');
            showToast(
                failedCount > 0
                    ? `Arduino ZIP 导入完成：成功 ${successCount}，失败 ${failedCount}；请查看常驻原因`
                    : `Arduino ZIP 导入完成：成功 ${successCount}`,
                failedCount > 0 ? 'error' : 'success',
            );
        } finally {
            setImportingArduinoZip(false);
            finishLibraryOperation();
        }
    };

    const deleteLibrary = async (lib: LibraryInfo) => {
        const ok = await dialog.confirm({
            title: '删除第三方库',
            message: `确认要删除库 “${lib.name}” 吗？`,
            type: 'warning',
            confirmLabel: '删除',
            cancelLabel: '取消',
        });
        if (!ok) return;

        const entryKey = libraryEntryKey(lib);
        setDeletingLib(entryKey);
        try {
            await invoke('delete_library', { id: lib.id, board: activeBoard, path: lib.path });
            await refreshInstalledLibraries();
            setSelectedLibs((prev) => prev.filter((item) => item !== entryKey));
            showToast(`已删除库: ${lib.name}`, 'success');
        } catch (error: any) {
            showToast(`删除失败: ${error?.message || error}`, 'error');
        } finally {
            setDeletingLib(null);
        }
    };

    const bulkDeleteLibs = async () => {
        const targets = userLibraries.filter((lib) => selectedLibs.includes(libraryEntryKey(lib)));
        if (targets.length === 0) {
            showToast('请先选择要删除的库', 'error');
            return;
        }

        const previewNames = targets.slice(0, 8).map((lib) => `• ${lib.name}`).join('\n');
        const remaining = Math.max(0, targets.length - 8);
        const confirmed = await dialog.confirm({
            title: `批量删除 ${targets.length} 个积木库？`,
            message: `${previewNames}${remaining > 0 ? `\n• 以及另外 ${remaining} 个库` : ''}\n\n删除后，引用这些库的工程可能无法完整加载或编译。此操作不会删除工程文件。`,
            tone: 'danger',
            confirmLabel: `确认删除 ${targets.length} 个库`,
            cancelLabel: '取消',
        });
        if (!confirmed) return;

        setBulkDeletingLibs(true);
        try {
            for (const lib of targets) {
                await invoke('delete_library', { id: lib.id, board: activeBoard, path: lib.path });
            }
            await refreshInstalledLibraries();
            setSelectedLibs([]);
            showToast(`批量删除完成，共 ${targets.length} 个`, 'success');
        } catch (error: any) {
            showToast(`批量删除失败: ${error?.message || error}`, 'error');
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
        setArduinoStatus(`正在搜索: ${query}`);

        try {
            const raw = await withTimeout(
                invoke<string>('search_arduino_libraries', { query }),
                15000,
                '搜索超时，请稍后重试',
            );
            if (reqId !== arduinoSearchReqIdRef.current) return;

            const parsed = JSON.parse(String(raw || '{}'));
            const libraries = Array.isArray(parsed?.libraries) ? parsed.libraries : [];
            setArduinoResults(libraries);
            setArduinoStatus(`搜索完成，共 ${libraries.length} 个结果`);
        } catch (error: any) {
            if (reqId !== arduinoSearchReqIdRef.current) return;
            const message = String(error?.message || error || '未知错误');
            setArduinoResults([]);
            setArduinoStatus(message.includes('超时') ? '搜索超时，请稍后重试' : '搜索失败');
            showToast(`搜索失败: ${message}`, 'error');
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
        return '作者未知';
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
            showToast(`正在处理 ${activeLibraryOperation.label}：${activeLibraryOperation.stage}`, 'loading');
            return;
        }

        const key = k(name);
        const version = n(arduinoVersions[key]);

        setInstallingArduino(name);
        setArduinoOpStatus(`正在安装: ${name}`);
        startLibraryOperation({
            kind: 'arduino-install',
            label: name,
            stage: 'Arduino CLI 正在下载、解压并安装',
            current: 1,
            total: 1,
        });
        try {
            showToast(`正在安装 Arduino 库 ${name}`, 'loading');
            await invoke('install_arduino_library', { name, version: version || null });
            updateLibraryOperation({ stage: '安装完成，正在刷新库清单' });
            await refreshArduinoInstalled();
            showToast(`已安装 Arduino 库 ${name}`, 'success');
            setArduinoOpStatus(`安装完成: ${name}`);
        } catch (error: any) {
            showToast(`安装失败: ${error?.message || error}`, 'error');
            setArduinoOpStatus(`安装失败: ${name}`);
        } finally {
            setInstallingArduino(null);
            finishLibraryOperation();
        }
    };

    const uninstallArduinoLib = async (lib: any) => {
        const name = getArduinoName(lib);
        if (!name) return;
        if (activeLibraryOperation) {
            showToast(`正在处理 ${activeLibraryOperation.label}：${activeLibraryOperation.stage}`, 'loading');
            return;
        }

        const version = n(lib?.version || lib?.latest?.version || lib?.installed_version);
        const confirmed = await dialog.confirm({
            title: `卸载 Arduino 库 “${name}”？`,
            message: `将从本机 Arduino 库目录卸载 ${name}${version ? ` ${version}` : ''}。\n\n依赖该库的工程会在下次编译时提示缺少库；工程源码和积木不会被删除。`,
            tone: 'warning',
            confirmLabel: '确认卸载',
            cancelLabel: '取消',
        });
        if (!confirmed) return;

        setUninstallingArduino(name);
        setArduinoOpStatus(`正在卸载: ${name}`);
        startLibraryOperation({
            kind: 'arduino-uninstall',
            label: name,
            stage: 'Arduino CLI 正在卸载库',
            current: 1,
            total: 1,
        });
        try {
            showToast(`正在卸载 Arduino 库 ${name}`, 'loading');
            await invoke('uninstall_arduino_library', { name });
            updateLibraryOperation({ stage: '卸载完成，正在刷新库清单' });
            await refreshArduinoInstalled();
            showToast(`已卸载 Arduino 库 ${name}`, 'success');
            setArduinoOpStatus(`卸载完成: ${name}`);
        } catch (error: any) {
            showToast(`卸载失败: ${error?.message || error}`, 'error');
            setArduinoOpStatus(`卸载失败: ${name}`);
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
        ? `正在处理“${activeLibraryOperation.label}”：${activeLibraryOperation.stage}`
        : importingLib
            ? '正在按队列导入 CK 积木包'
            : importingArduinoZip
                ? '正在按队列导入 Arduino ZIP'
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
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800">
                    <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-md bg-[#e7f5f3] text-[#0f766e] flex items-center justify-center"><BookOpen size={19} /></div>
                        <div>
                            <h2 id="library-manager-title" className="text-base font-bold text-slate-800 dark:text-slate-100">库与依赖</h2>
                            <p className="text-xs text-slate-400 mt-0.5">当前项目板卡：{activeBoard}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => { void refreshInstalledLibraries(); void refreshArduinoInstalled(); }}
                            disabled={Boolean(libraryBusyReason)}
                            title={libraryBusyReason || '刷新已安装库清单'}
                            className="h-9 px-3 flex items-center gap-2 rounded-md border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                        >
                            <RefreshCw size={14} /> 刷新
                        </button>
                        <button onClick={onClose} className="w-9 h-9 flex items-center justify-center rounded-md hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="关闭库管理器">
                            <X size={19} />
                        </button>
                    </div>
                </div>

                <div className="flex border-b border-slate-100 dark:border-slate-800 px-4 gap-1">
                    {(['installed', 'discover', 'import'] as TabType[]).map((item) => (
                        <button
                            key={item}
                            onClick={() => setTab(item)}
                            className={`px-3 py-3 text-sm font-bold border-b-2 transition-colors flex items-center gap-2 ${tab === item ? 'border-[#0f766e] text-[#0f766e]' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
                        >
                            {item === 'installed' ? <><Database size={15} /> 已安装</> : item === 'discover' ? <><Cloud size={15} /> 在线获取</> : <><HardDrive size={15} /> 本地导入</>}
                        </button>
                    ))}
                </div>

                {activeLibraryOperation && (
                    <div
                        className="mx-6 mt-4 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2.5 text-teal-900 dark:border-teal-800 dark:bg-teal-950/35 dark:text-teal-100"
                        role="status"
                        aria-live="polite"
                    >
                        <div className="flex items-start gap-2.5">
                            <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-teal-600 dark:text-teal-300" aria-hidden="true" />
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                                    <div className="min-w-0 truncate text-xs font-bold">{activeLibraryOperation.label}</div>
                                    <div className="flex shrink-0 items-center gap-1 text-[10px] font-semibold opacity-75">
                                        <Clock3 size={11} aria-hidden="true" /> 已等待 {operationElapsedSeconds}s
                                    </div>
                                </div>
                                <div className="mt-0.5 text-[11px] leading-4 opacity-85">
                                    {activeLibraryOperation.stage}
                                    {activeLibraryOperation.total > 1
                                        ? ` · 队列 ${activeLibraryOperation.current}/${activeLibraryOperation.total}`
                                        : ''}
                                </div>
                                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-teal-100 dark:bg-teal-900/70">
                                    {activeLibraryOperation.total > 1 ? (
                                        <div
                                            className="h-full rounded-full bg-teal-600 transition-[width] duration-300 dark:bg-teal-300"
                                            style={{ width: `${Math.max(4, Math.min(100, ((activeLibraryOperation.current - 1) / activeLibraryOperation.total) * 100))}%` }}
                                        />
                                    ) : (
                                        <div className="h-full w-1/3 animate-pulse rounded-full bg-teal-600 dark:bg-teal-300" />
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                <div className="flex-1 overflow-auto p-6 space-y-4">
                    {tab === 'discover' && (
                        <div className="inline-flex items-center h-9 p-0.5 bg-slate-100 border border-slate-200 rounded-md">
                            <button onClick={() => setDiscoverKind('blocks')} className={`h-8 px-3 rounded flex items-center gap-2 text-xs font-bold ${discoverKind === 'blocks' ? 'bg-white text-[#0f766e] shadow-sm' : 'text-slate-500'}`}>
                                <Box size={14} /> CK 积木库
                            </button>
                            <button onClick={() => setDiscoverKind('arduino')} className={`h-8 px-3 rounded flex items-center gap-2 text-xs font-bold ${discoverKind === 'arduino' ? 'bg-white text-[#0f766e] shadow-sm' : 'text-slate-500'}`}>
                                <Database size={14} /> Arduino 源码库
                            </button>
                        </div>
                    )}
                    {tab === 'installed' && (
                        <>
                            {userLibraries.length > 0 && (
                                <>
                                    <div className="flex items-center justify-between mb-2">
                                        <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2"><Box size={15} className="text-[#0f766e]" /> 你安装的 CK 积木库</h3>
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => setSelectedLibs(allLibSelected ? [] : userLibraries.map((lib) => libraryEntryKey(lib)))}
                                                className="px-2 py-1 text-xs rounded border"
                                            >
                                                {allLibSelected ? '取消全选' : '全选'}
                                            </button>
                                            <button
                                                onClick={() => void bulkDeleteLibs()}
                                                disabled={bulkDeletingLibs || selectedLibs.length === 0}
                                                className="px-2 py-1 text-xs rounded bg-red-500 text-white disabled:opacity-50"
                                            >
                                                {bulkDeletingLibs ? '删除中...' : `批量删除 (${selectedLibs.length})`}
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
                                                                            {runtimeActivationLabel(lib)}
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
                                                                质量与证据 <ChevronDown size={13} className={`transition-transform ${qualityExpanded ? 'rotate-180' : ''}`} />
                                                            </button>
                                                            <button
                                                                onClick={() => void deleteLibrary(lib)}
                                                                disabled={deleting}
                                                                className="h-8 px-2 text-xs rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50 flex items-center gap-1.5"
                                                            >
                                                                <Trash2 size={13} /> {deleting ? '删除中...' : '删除'}
                                                            </button>
                                                        </div>
                                                    </div>
                                                    {qualityExpanded && (
                                                        <div className="mt-3 space-y-3">
                                                            <BlockPackagePassportPanel library={lib} />
                                                            <PackageQualityReportPanel
                                                                report={lib.quality_report}
                                                                metadataVersion={lib.block_manifest?.schema_version ?? (lib.manifest as any)?.schema_version}
                                                                sourceLabel="用户本地导入"
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
                                    <div className="text-sm font-bold text-slate-700 mb-4 flex items-center gap-2"><ShieldCheck size={15} className="text-slate-500" /> 板卡与系统提供的积木库</div>
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
                                                                        {runtimeActivationLabel(lib)}
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
                                                                质量与证据 <ChevronDown size={13} className={`transition-transform ${qualityExpanded ? 'rotate-180' : ''}`} />
                                                            </button>
                                                            <span className="px-2 py-1 text-xs rounded border text-slate-500 flex items-center gap-1.5"><ShieldCheck size={12} /> 受保护</span>
                                                        </div>
                                                    </div>
                                                    {qualityExpanded && (
                                                        <div className="mt-3 space-y-3">
                                                            <BlockPackagePassportPanel library={lib} />
                                                            <PackageQualityReportPanel
                                                                report={lib.quality_report}
                                                                metadataVersion={lib.block_manifest?.schema_version ?? (lib.manifest as any)?.schema_version}
                                                                sourceLabel={libraryLocationLabel(lib) || '随软件或板卡提供'}
                                                            />
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </>
                            ) : (
                                <div className="text-sm text-slate-500 border rounded-lg p-3">当前板卡没有提供额外积木库</div>
                            )}

                            <div className="mt-6">
                                <div className="flex items-center justify-between mb-2">
                                    <div className="text-sm font-bold text-slate-500">Arduino 已安装库</div>
                                    <button
                                        onClick={() => {
                                            setTab('discover');
                                            setDiscoverKind('arduino');
                                            setArduinoView('installed');
                                        }}
                                        className="px-2 py-1 text-xs rounded border hover:bg-slate-50"
                                    >
                                        查看全部
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
                                                        <span className="px-2 py-1 text-xs rounded border text-emerald-700 border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">已安装</span>
                                                    </div>
                                                </div>
                                                {lib.qualityReport ? (
                                                    <details className="mt-2 border-t border-slate-200 pt-2 dark:border-slate-700">
                                                        <summary className="cursor-pointer text-[11px] font-semibold text-slate-500 dark:text-slate-400">查看 Arduino ZIP 质量报告</summary>
                                                        <div className="mt-2">
                                                            <PackageQualityReportPanel
                                                                compact
                                                                report={lib.qualityReport}
                                                                metadataVersion={lib.qualityReport.schema_version}
                                                                sourceLabel={lib.installSource?.source === 'local-arduino-zip' ? '本地 Arduino ZIP' : 'Arduino 库'}
                                                            />
                                                        </div>
                                                    </details>
                                                ) : null}
                                            </div>
                                        ))}
                                        {installedArduinoNames.length > 20 && (
                                            <div className="text-xs text-slate-500">已安装库较多，仅显示前 20 个。</div>
                                        )}
                                    </div>
                                ) : (
                                    <div className="text-sm text-slate-500 border rounded-lg p-3">暂无 Arduino 已安装库</div>
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
                                            placeholder="搜索当前板卡可用的积木库"
                                            value={cloudQuery}
                                            onChange={(event) => setCloudQuery(event.target.value)}
                                            className="w-full h-10 pl-9 pr-3 rounded border"
                                        />
                                    </div>
                                    {selectedCloudLibs.length > 0 && (
                                        <button
                                            onClick={() => void batchInstallCloud()}
                                            disabled={cloudBusy}
                                            title={cloudBusy ? libraryBusyReason : `按队列安装 ${selectedCloudLibs.length} 个库`}
                                            className="h-10 px-3 rounded bg-blue-500 text-white disabled:opacity-50 flex-none text-sm whitespace-nowrap"
                                        >
                                            批量安装 ({selectedCloudLibs.length})
                                        </button>
                                    )}
                                    <select value={provider} onChange={(event) => setProvider(event.target.value as CloudProvider)} className="h-10 px-3 rounded border">
                                        <option value="auto">自动</option>
                                        <option value="gitee">Gitee</option>
                                        <option value="github">GitHub</option>
                                    </select>
                                    <input
                                        value={registryUrl}
                                        onChange={(event) => setRegistryUrl(event.target.value)}
                                        className="flex-1 min-w-[240px] h-10 px-3 rounded border"
                                        placeholder="输入仓库地址"
                                    />
                                    <button
                                        onClick={saveAndFetchRegistry}
                                        disabled={registryLoading || cloudBusy}
                                        title={cloudBusy ? libraryBusyReason : '读取在线积木库仓库'}
                                        className="h-10 px-3 rounded bg-teal-500 text-white disabled:opacity-50"
                                    >
                                        <span className="inline-flex items-center gap-2"><DownloadCloud size={14} /> {registryLoading ? '加载中...' : '读取仓库'}</span>
                                    </button>
                                </div>
                            </div>

                            <div className="space-y-2">
                                {visibleCloud.length === 0 && (
                                    <div className="text-sm text-slate-500 border rounded-lg p-3">暂无可安装库</div>
                                )}

                                {visibleCloud.map((lib) => {
                                    const installed = [k(lib.id), k(lib.name), nk(lib.id), nk(lib.name)].some((item) => item && installedLibKeys.has(item));
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
                                                title={cloudBusy && !installing ? libraryBusyReason : installed ? '该库已经安装' : undefined}
                                                className="max-w-[210px] truncate px-2 py-1 text-xs rounded bg-teal-500 text-white disabled:opacity-50 flex-none"
                                            >
                                                {installing
                                                    ? `安装中 ${activeLibraryOperation?.current || 1}/${activeLibraryOperation?.total || 1}`
                                                    : installed
                                                        ? '已安装'
                                                        : cloudBusy
                                                            ? libraryBusyReason || '另一个库操作进行中'
                                                            : '安装'}
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
                                    placeholder="搜索 Arduino 库"
                                />
                                <button
                                    onClick={() => void searchArduino()}
                                    disabled={arduinoLoading || arduinoBusy}
                                    title={arduinoBusy ? libraryBusyReason : '搜索 Arduino 库索引'}
                                    className="h-10 px-3 rounded bg-emerald-500 text-white disabled:opacity-50"
                                >
                                    {arduinoLoading ? '搜索中...' : '搜索'}
                                </button>
                                <select
                                    value={arduinoView}
                                    onChange={(event) => setArduinoView(event.target.value as 'search' | 'installed')}
                                    disabled={arduinoBusy}
                                    title={arduinoBusy ? libraryBusyReason : '切换库列表'}
                                    className="h-10 px-3 rounded border"
                                >
                                    <option value="search">搜索结果</option>
                                    <option value="installed">已安装库</option>
                                </select>
                                <button
                                    onClick={() => void refreshArduinoInstalled()}
                                    disabled={arduinoBusy}
                                    title={arduinoBusy ? libraryBusyReason : '刷新 Arduino 已安装库'}
                                    className="h-10 px-3 rounded border disabled:opacity-50"
                                >
                                    刷新已安装
                                </button>
                                <button
                                    onClick={async () => {
                                        setUpdatingArduinoIndex(true);
                                        startLibraryOperation({
                                            kind: 'index-update',
                                            label: 'Arduino 库索引',
                                            stage: '正在下载并更新索引',
                                            current: 1,
                                            total: 1,
                                        });
                                        try {
                                            await invoke('update_arduino_library_index');
                                            showToast('Arduino 索引已更新', 'success');
                                        } catch (error: any) {
                                            showToast(`索引更新失败: ${error?.message || error}`, 'error');
                                        } finally {
                                            setUpdatingArduinoIndex(false);
                                            finishLibraryOperation();
                                        }
                                    }}
                                    disabled={updatingArduinoIndex || arduinoBusy}
                                    title={arduinoBusy ? libraryBusyReason : '更新 Arduino 库索引'}
                                    className="h-10 px-3 rounded border disabled:opacity-50"
                                >
                                    {updatingArduinoIndex ? '更新中...' : '更新索引'}
                                </button>
                            </div>

                            {arduinoStatus && <div className="text-xs text-slate-500">{arduinoStatus}</div>}
                            {arduinoOpStatus && <div className="text-xs text-slate-500">{arduinoOpStatus}</div>}
                            {arduinoBusy && (
                                <div className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
                                    {libraryBusyReason || '正在执行 Arduino 库操作'}
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
                                                {latestVersion}{installedVersion ? ` · 已安装 ${installedVersion}` : ''}
                                            </div>
                                            <div className="text-xs text-slate-500 truncate">{author}</div>
                                            {desc ? <div className="text-xs text-slate-400 truncate">{desc}</div> : null}
                                            {(isInstalling || isUninstalling) && (
                                                <div className="text-xs text-emerald-600">{isInstalling ? '安装进行中...' : '卸载进行中...'}</div>
                                            )}
                                        </div>

                                        <div className="flex items-center gap-2">
                                            {qualityReport ? <PackageQualityStatusBadge report={qualityReport} /> : null}
                                            {versions.length > 0 && (
                                                <select
                                                    value={arduinoVersions[key] || ''}
                                                    onChange={(event) => setArduinoVersions((prev) => ({ ...prev, [key]: event.target.value }))}
                                                    disabled={arduinoBusy}
                                                    title={arduinoBusy ? libraryBusyReason : '选择要安装的版本'}
                                                    className="h-8 px-2 rounded border text-xs disabled:opacity-50"
                                                >
                                                    <option value="">最新</option>
                                                    {versions.map((version) => (
                                                        <option key={version} value={version}>{version}</option>
                                                    ))}
                                                </select>
                                            )}
                                            <button
                                                onClick={() => void installArduinoLib(lib)}
                                                disabled={arduinoBusy || installed}
                                                title={arduinoBusy ? libraryBusyReason : installed ? '该库已经安装' : `安装 ${libName}`}
                                                className="px-2 py-1 text-xs rounded bg-emerald-500 text-white disabled:opacity-50"
                                            >
                                                {isInstalling ? '安装中...' : isUninstalling ? '卸载中...' : installed ? '已安装' : '安装'}
                                            </button>
                                            {installed && latestVersion !== '-' && installedVersion && installedVersion !== latestVersion && (
                                                <button
                                                    onClick={() => void installArduinoLib(lib)}
                                                    disabled={arduinoBusy}
                                                    className="px-2 py-1 text-xs rounded bg-blue-500 text-white disabled:opacity-50"
                                                    title={arduinoBusy ? libraryBusyReason : `升级到 ${latestVersion}`}
                                                >
                                                    升级
                                                </button>
                                            )}
                                            {installed && (
                                                <button
                                                    onClick={() => void uninstallArduinoLib(lib)}
                                                    disabled={arduinoBusy}
                                                    title={arduinoBusy ? libraryBusyReason : `卸载 ${libName}`}
                                                    className="px-2 py-1 text-xs rounded bg-red-500 text-white disabled:opacity-50"
                                                >
                                                    {isUninstalling ? '卸载中...' : '卸载'}
                                                </button>
                                            )}
                                        </div>
                                      </div>
                                      {qualityReport ? (
                                        <details className="mt-2 border-t border-slate-200 pt-2 dark:border-slate-700">
                                            <summary className="cursor-pointer text-[11px] font-semibold text-slate-500 dark:text-slate-400">查看 Arduino ZIP 质量报告</summary>
                                            <div className="mt-2">
                                                <PackageQualityReportPanel
                                                    compact
                                                    report={qualityReport}
                                                    metadataVersion={qualityReport.schema_version}
                                                    sourceLabel={installSource?.source === 'local-arduino-zip' ? '本地 Arduino ZIP' : 'Arduino 库'}
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
                            <div className="rounded-lg border border-teal-200 bg-teal-50 px-4 py-3 text-xs leading-relaxed text-teal-800 dark:border-teal-900 dark:bg-teal-950/35 dark:text-teal-200">
                                <div className="flex items-center gap-2 font-bold"><ShieldCheck size={14} /> 导入前自动质量检查</div>
                                <p className="mt-1 opacity-85">软件会检查目录与路径安全、依赖、积木定义和生成器一致性、许可证、兼容性及内容哈希。确定性错误会阻止安装，风险项会保留为警告；导入后可在“已安装 → 质量报告”查看完整证据。</p>
                                <p className="mt-1 text-[10px] opacity-70">本机静态检查不代表 CK 官方背书，也不等同于发布者签名或真板验证。</p>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <section className="border border-slate-200 rounded-lg p-5 flex flex-col min-h-[240px]">
                                    <div className="w-10 h-10 rounded-md bg-[#e7f5f3] text-[#0f766e] flex items-center justify-center"><Box size={20} /></div>
                                    <h3 className="font-bold text-slate-800 mt-4">CK 第三方积木库</h3>
                                    <p className="text-sm text-slate-500 mt-2 leading-6 flex-1">可一次多选 CK 积木包 ZIP，或选择包根目录中的 library.json。软件按队列逐个执行门禁，单项失败不会吞掉后续项目。</p>
                                    <button
                                        onClick={() => void importLibraryZip()}
                                        disabled={localImportBusy}
                                        title={localImportBusy ? libraryBusyReason : '一次可多选多个 CK 积木包'}
                                        className="h-10 px-4 rounded-md bg-[#0f766e] hover:bg-[#0d675f] text-white text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50 flex items-center justify-center gap-2"
                                    >
                                        <Upload size={15} /> {importingLib ? `正在导入 ${activeLibraryOperation?.current || 1}/${activeLibraryOperation?.total || 1}` : '批量选择积木库包'}
                                    </button>
                                </section>

                                <section className="border border-slate-200 rounded-lg p-5 flex flex-col min-h-[240px]">
                                    <div className="w-10 h-10 rounded-md bg-blue-50 text-blue-600 flex items-center justify-center"><Database size={20} /></div>
                                    <h3 className="font-bold text-slate-800 mt-4">Arduino 源码库</h3>
                                    <p className="text-sm text-slate-500 mt-2 leading-6 flex-1">可一次多选 Arduino 源码库 ZIP；支持递归 src/** 与旧式根目录 + utility/**。每项独立显示路径、结构、内容哈希或许可证等拒绝原因。</p>
                                    <button
                                        onClick={() => void importArduinoLibraryZip()}
                                        disabled={localImportBusy}
                                        title={localImportBusy ? libraryBusyReason : '一次可多选多个 Arduino ZIP'}
                                        className="h-10 px-4 rounded-md border border-blue-200 text-blue-700 hover:bg-blue-50 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50 flex items-center justify-center gap-2 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/35"
                                    >
                                        <Upload size={15} /> {importingArduinoZip ? `正在导入 ${activeLibraryOperation?.current || 1}/${activeLibraryOperation?.total || 1}` : '批量选择 Arduino ZIP'}
                                    </button>
                                </section>
                            </div>

                            {importQueue.length > 0 && (
                                <section className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
                                    <div className="flex items-center justify-between gap-3">
                                        <div>
                                            <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">本地导入队列</h3>
                                            <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                                                成功 {importQueue.filter(item => item.status === 'success').length} · 失败 {importQueue.filter(item => item.status === 'failed').length} · 共 {importQueue.length}
                                            </p>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => setImportQueue([])}
                                            disabled={localImportBusy}
                                            title={localImportBusy ? libraryBusyReason : '清除本次结果'}
                                            className="rounded border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-500 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300"
                                        >清除结果</button>
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
                                                            className={`mt-0.5 shrink-0 ${item.status === 'running' ? 'animate-spin text-teal-600' : item.status === 'failed' ? 'text-red-600' : item.status === 'success' ? 'text-emerald-600' : 'text-slate-400'}`}
                                                            aria-hidden="true"
                                                        />
                                                        <div className="min-w-0 flex-1">
                                                            <div className="flex flex-wrap items-center gap-2">
                                                                <div className="min-w-0 flex-1 truncate text-xs font-bold text-slate-800 dark:text-slate-100" title={item.path}>{item.label}</div>
                                                                <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold ${importQueueStatusClass(item.status)}`}>
                                                                    {importQueueStatusLabel(item.status)}
                                                                </span>
                                                            </div>
                                                            {item.summary && (
                                                                <div className={`mt-1 break-words text-[11px] leading-4 ${item.status === 'failed' ? 'font-semibold text-red-700 dark:text-red-300' : 'text-slate-600 dark:text-slate-300'}`}>
                                                                    {item.summary}
                                                                </div>
                                                            )}
                                                            {item.status === 'failed' && (item.details?.length || item.rawError) && (
                                                                <details className="mt-1.5 rounded border border-red-100 bg-red-50/50 px-2 py-1.5 dark:border-red-900/60 dark:bg-red-950/20">
                                                                    <summary className="cursor-pointer text-[10px] font-bold text-red-700 dark:text-red-300">查看完整拒绝原因</summary>
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
                                                                                        .then(() => showToast('拒绝原因已复制', 'success'))
                                                                                        .catch(error => showToast(`复制失败: ${String(error)}`, 'error'));
                                                                                }}
                                                                                className="inline-flex shrink-0 items-center gap-1 rounded border border-red-200 bg-white px-2 py-1 text-[10px] font-bold text-red-700 dark:border-red-800 dark:bg-slate-900 dark:text-red-300"
                                                                            ><Copy size={11} />复制</button>
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
