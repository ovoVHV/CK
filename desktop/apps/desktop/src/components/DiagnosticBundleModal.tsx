import { useEffect, useState } from 'react';
import {
    Archive,
    CheckCircle2,
    CircuitBoard,
    Code2,
    Cpu,
    FileArchive,
    FileCode2,
    FileDown,
    FileUp,
    FolderArchive,
    HardDrive,
    Loader2,
    LockKeyhole,
    ShieldCheck,
    TriangleAlert,
    WifiOff,
    X,
} from 'lucide-react';
import { open, save } from '@tauri-apps/plugin-dialog';
import {
    DEFAULT_DIAGNOSTIC_PRIVACY,
    createDiagnosticBundleFileName,
    deriveDiagnosticCoreAvailability,
    exportDiagnosticBundle,
    inspectDiagnosticBundle,
    isNativeDiagnosticBundleAvailable,
    type DiagnosticBundleExportData,
    type DiagnosticBundleExportResult,
    type DiagnosticBundleInspection,
    type DiagnosticContentLevel,
    type DiagnosticPrivacyOptions,
} from '../services/diagnostic_bundle';
import { uiText, useUiText } from '../i18n/uiText';

export type DiagnosticBundleExportDataProvider =
    | DiagnosticBundleExportData
    | (() => DiagnosticBundleExportData | Promise<DiagnosticBundleExportData>);

export interface DiagnosticBundleModalProps {
    isOpen: boolean;
    onClose: () => void;
    /**
     * Captures current evidence only after the user has chosen to export. A
     * provider is preferred for workspace data so Blockly/source/log content is
     * read at one consistent instant rather than when the modal first opens.
     */
    exportData?: DiagnosticBundleExportDataProvider;
    suggestedFileName?: string;
    onExported?: (result: DiagnosticBundleExportResult) => void;
    onInspected?: (result: DiagnosticBundleInspection, path: string) => void;
    /** Installed package -> version map used to evaluate the imported Core on this computer. */
    currentCoreVersions?: Readonly<Record<string, string>>;
}

type ActiveOperation = 'export' | 'inspect' | null;
type ModalTab = 'export' | 'inspect';

interface ContentLevelOption {
    value: DiagnosticContentLevel;
    title: string;
    description: string;
    Icon: typeof FolderArchive;
}

const getContentLevels = (tr: (zh: string, en: string) => string): ContentLevelOption[] => [
    {
        value: 'full_project',
        title: tr('包含完整工程', 'Full project'),
        description: tr('积木工程、生成源码、环境、清单与日志。适合完整复现。', 'Blocks project, generated source, environment, manifest, and logs. Best for full reproduction.'),
        Icon: FolderArchive,
    },
    {
        value: 'generated_source_only',
        title: tr('仅包含生成源码', 'Generated source only'),
        description: tr('不包含积木工程，只保留生成源码、环境、清单与日志。', 'Excludes the blocks file; keeps generated source, environment, manifest, and logs.'),
        Icon: FileCode2,
    },
    {
        value: 'no_source',
        title: tr('不包含源码', 'No source code'),
        description: tr('仅包含环境、板卡、构建/上传清单和日志证据。', 'Includes only environment, board, build/upload manifest, and log evidence.'),
        Icon: LockKeyhole,
    },
];

const getPrivacyOptions = (tr: (zh: string, en: string) => string): Array<{
    key: keyof DiagnosticPrivacyOptions;
    title: string;
    description: string;
}> => [
    {
        key: 'redactWifi',
        title: tr('隐去 Wi-Fi 信息', 'Redact Wi-Fi credentials'),
        description: tr('隐藏源码和日志中可识别的 SSID、密码与口令。', 'Masks detectable SSIDs, passwords, and secrets in source and logs.'),
    },
    {
        key: 'redactUsername',
        title: tr('隐去用户名', 'Redact username'),
        description: tr('替换本机用户目录和日志中的账户名。', 'Replaces local account names in user directories and logs.'),
    },
    {
        key: 'redactPaths',
        title: tr('隐去本机路径', 'Redact local paths'),
        description: tr('清单不记录源路径，并替换文本中的绝对路径。', 'Omits source paths from the manifest and masks absolute paths in text.'),
    },
    {
        key: 'redactSerialContent',
        title: tr('不包含串口内容', 'Exclude serial output'),
        description: tr('直接排除串口日志，避免设备数据或口令被带入。', 'Excludes serial monitor logs so device data or tokens are not included.'),
    },
];

const onePath = (value: string | string[] | null): string | null => (
    typeof value === 'string'
        ? value
        : Array.isArray(value) && typeof value[0] === 'string'
            ? value[0]
            : null
);

const errorMessage = (cause: unknown): string => {
    if (cause instanceof Error && cause.message.trim()) return cause.message;
    const message = String(cause || '').trim();
    return message || uiText('发生未知错误', 'Unknown error occurred');
};

const resolveExportData = async (
    provider: DiagnosticBundleExportDataProvider,
): Promise<DiagnosticBundleExportData> => (
    typeof provider === 'function' ? provider() : provider
);

const SummaryGrid = ({
    inspection,
    currentCoreVersions,
}: {
    inspection: DiagnosticBundleInspection;
    currentCoreVersions?: Readonly<Record<string, string>>;
}) => {
    const { tr } = useUiText();
    const { summary } = inspection;
    const coreAvailability = deriveDiagnosticCoreAvailability(summary, currentCoreVersions);
    const entries = [
        { label: tr('板卡', 'Board'), value: summary.board, Icon: CircuitBoard },
        { label: 'Core', value: summary.core, Icon: Cpu },
        { label: tr('完整 FQBN', 'Full FQBN'), value: summary.fqbn, Icon: Code2 },
        { label: 'Flash', value: summary.flash, Icon: HardDrive },
        {
            label: tr('Core 状态', 'Core Status'),
            value: coreAvailability.label,
            Icon: coreAvailability.state === 'ready' ? CheckCircle2 : TriangleAlert,
        },
        { label: tr('失败阶段', 'Failure Stage'), value: summary.failureStage, Icon: ShieldCheck },
    ];
    return (
        <div className="grid gap-2 sm:grid-cols-2">
            {entries.map(({ label, value, Icon }) => (
                <div
                    key={label}
                    className="min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2.5 dark:border-slate-700 dark:bg-slate-900/70"
                >
                    <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                        <Icon size={12} /> {label}
                    </div>
                    <div className="mt-1 break-words text-xs font-semibold leading-5 text-slate-800 dark:text-slate-100">
                        {value}
                    </div>
                </div>
            ))}
        </div>
    );
};

export function DiagnosticBundleModal({
    isOpen,
    onClose,
    exportData,
    suggestedFileName,
    onExported,
    onInspected,
    currentCoreVersions,
}: DiagnosticBundleModalProps) {
    const { tr } = useUiText();
    const contentLevels = getContentLevels(tr);
    const privacyOptions = getPrivacyOptions(tr);
    const [tab, setTab] = useState<ModalTab>('export');
    const [contentLevel, setContentLevel] = useState<DiagnosticContentLevel>('no_source');
    const [privacy, setPrivacy] = useState<DiagnosticPrivacyOptions>({
        ...DEFAULT_DIAGNOSTIC_PRIVACY,
    });
    const [operation, setOperation] = useState<ActiveOperation>(null);
    const [error, setError] = useState<string | null>(null);
    const [exportResult, setExportResult] = useState<DiagnosticBundleExportResult | null>(null);
    const [inspection, setInspection] = useState<DiagnosticBundleInspection | null>(null);
    const [inspectedPath, setInspectedPath] = useState<string>('');

    const nativeAvailable = isNativeDiagnosticBundleAvailable();

    useEffect(() => {
        if (!isOpen) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && operation === null) onClose();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [isOpen, onClose, operation]);

    if (!isOpen) return null;

    const runExport = async () => {
        if (operation || !exportData || !nativeAvailable) return;
        setError(null);
        setExportResult(null);
        setOperation('export');
        try {
            const outputPath = await save({
                title: tr('导出本地诊断包', 'Export Local Diagnostic Bundle'),
                defaultPath: suggestedFileName?.trim() || createDiagnosticBundleFileName(),
                filters: [{ name: tr('CK 诊断包', 'CK Diagnostic Bundle'), extensions: ['zip'] }],
            });
            if (!outputPath) return;
            const data = await resolveExportData(exportData);
            const result = await exportDiagnosticBundle({
                outputPath,
                contentLevel,
                privacy,
                context: data.context,
                items: data.items,
            });
            setExportResult(result);
            onExported?.(result);
        } catch (cause) {
            console.error('[DiagnosticBundle] Export failed', cause);
            setError(tr(`导出失败：${errorMessage(cause)}`, `Export failed: ${errorMessage(cause)}`));
        } finally {
            setOperation(null);
        }
    };

    const runInspection = async () => {
        if (operation || !nativeAvailable) return;
        setError(null);
        setInspection(null);
        setOperation('inspect');
        try {
            const selected = onePath(await open({
                title: tr('打开本地诊断包', 'Open Local Diagnostic Bundle'),
                multiple: false,
                directory: false,
                filters: [{ name: tr('CK 诊断包', 'CK Diagnostic Bundle'), extensions: ['zip'] }],
            }));
            if (!selected) return;
            const result = await inspectDiagnosticBundle(selected);
            setInspection(result);
            setInspectedPath(selected);
            onInspected?.(result, selected);
        } catch (cause) {
            console.error('[DiagnosticBundle] Inspection failed', cause);
            setError(tr(`无法打开诊断包：${errorMessage(cause)}`, `Unable to open diagnostic bundle: ${errorMessage(cause)}`));
        } finally {
            setOperation(null);
        }
    };

    const closeAllowed = operation === null;

    return (
        <div
            className="fixed inset-0 z-[540] flex items-center justify-center bg-slate-950/45 p-3 backdrop-blur-sm dark:bg-black/70"
            role="dialog"
            aria-modal="true"
            aria-labelledby="diagnostic-bundle-title"
            data-ck-role="diagnostic-bundle-modal"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget && closeAllowed) onClose();
            }}
        >
            <section className="flex max-h-[min(820px,calc(100vh-24px))] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/80 bg-[#f8fafc] shadow-2xl dark:border-slate-700 dark:bg-slate-950">
                <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 bg-white px-5 py-4 dark:border-slate-800 dark:bg-slate-900">
                    <div className="flex min-w-0 items-start gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
                            <FileArchive size={20} />
                        </span>
                        <div className="min-w-0">
                            <h2 id="diagnostic-bundle-title" className="text-base font-black text-slate-900 dark:text-slate-100">
                                {tr('工程体检与诊断包', 'Project Health & Diagnostic Bundle')}
                            </h2>
                            <p className="mt-0.5 text-[11px] leading-4 text-slate-500 dark:text-slate-400">
                                {tr('汇总板卡、Core、FQBN、构建、上传和环境证据，方便可靠复现问题。', 'Bundles board, Core, FQBN, build, upload, and environment evidence for reliable troubleshooting.')}
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={!closeAllowed}
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                        aria-label={tr('关闭诊断包', 'Close diagnostic bundle')}
                    >
                        <X size={18} />
                    </button>
                </header>

                <div className="shrink-0 border-b border-brand-200 bg-brand-50/80 px-5 py-2.5 dark:border-brand-900 dark:bg-brand-950/35">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-semibold text-brand-800 dark:text-brand-200">
                        <span className="inline-flex items-center gap-1.5"><HardDrive size={13} /> {tr('只在本机处理', 'Processed locally only')}</span>
                        <span className="inline-flex items-center gap-1.5"><WifiOff size={13} /> {tr('不联网', 'Offline')}</span>
                        <span className="inline-flex items-center gap-1.5"><ShieldCheck size={13} /> {tr('不自动上传', 'No auto-upload')}</span>
                    </div>
                </div>

                <nav className="grid shrink-0 grid-cols-2 gap-1 border-b border-slate-200 bg-white px-5 pt-3 dark:border-slate-800 dark:bg-slate-900" aria-label={tr('诊断包操作', 'Diagnostic bundle actions')}>
                    <button
                        type="button"
                        onClick={() => { setTab('export'); setError(null); }}
                        className={`flex h-10 items-center justify-center gap-2 rounded-t-xl border-b-2 text-xs font-bold transition-colors ${tab === 'export'
                            ? 'border-brand-600 bg-brand-50/60 text-brand-700 dark:border-brand-400 dark:bg-brand-950/35 dark:text-brand-300'
                            : 'border-transparent text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800/70'}`}
                    >
                        <FileDown size={15} /> {tr('导出诊断包', 'Export Bundle')}
                    </button>
                    <button
                        type="button"
                        onClick={() => { setTab('inspect'); setError(null); }}
                        className={`flex h-10 items-center justify-center gap-2 rounded-t-xl border-b-2 text-xs font-bold transition-colors ${tab === 'inspect'
                            ? 'border-violet-600 bg-violet-50/60 text-violet-700 dark:border-violet-400 dark:bg-violet-950/35 dark:text-violet-300'
                            : 'border-transparent text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800/70'}`}
                    >
                        <FileUp size={15} /> {tr('本地打开诊断包', 'Inspect Local Bundle')}
                    </button>
                </nav>

                <div className="min-h-0 flex-1 overflow-y-auto p-5">
                    {!nativeAvailable && (
                        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                            {tr('诊断包只在 CK 桌面软件中可用；网页预览不会读取或写入本机文件。', 'Diagnostic bundles are only available in the CK desktop app; web preview does not read or write local files.')}
                        </div>
                    )}

                    {tab === 'export' && (
                        <div className="space-y-5">
                            <section>
                                <div className="mb-2.5 flex items-center justify-between gap-3">
                                    <div>
                                        <h3 className="text-xs font-black text-slate-800 dark:text-slate-100">{tr('选择包含范围', 'Included Content')}</h3>
                                        <p className="mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">{tr('默认不带源码，可按排查需要明确放宽。', 'Source code is excluded by default; expand only when needed for troubleshooting.')}</p>
                                    </div>
                                    <span className="rounded-full border border-slate-200 bg-white px-2 py-1 text-[9px] font-bold text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
                                        {tr('由你决定内容', 'You choose what to share')}
                                    </span>
                                </div>
                                <div className="grid gap-2 md:grid-cols-3">
                                    {contentLevels.map(({ value, title, description, Icon }) => {
                                        const selected = contentLevel === value;
                                        return (
                                            <button
                                                key={value}
                                                type="button"
                                                aria-pressed={selected}
                                                onClick={() => setContentLevel(value)}
                                                disabled={Boolean(operation)}
                                                className={`min-h-[112px] rounded-xl border p-3 text-left transition-all disabled:cursor-not-allowed disabled:opacity-60 ${selected
                                                    ? 'border-brand-400 bg-brand-50 shadow-sm ring-1 ring-brand-200 dark:border-brand-700 dark:bg-brand-950/45 dark:ring-brand-900'
                                                    : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900/70 dark:hover:border-slate-600 dark:hover:bg-slate-900'}`}
                                            >
                                                <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${selected
                                                    ? 'bg-brand-600 text-white dark:bg-brand-500'
                                                    : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}`}
                                                >
                                                    <Icon size={15} />
                                                </span>
                                                <strong className="mt-2 block text-xs text-slate-800 dark:text-slate-100">{title}</strong>
                                                <span className="mt-1 block text-[10px] leading-4 text-slate-500 dark:text-slate-400">{description}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </section>

                            <section>
                                <h3 className="text-xs font-black text-slate-800 dark:text-slate-100">{tr('隐私处理', 'Privacy Redaction')}</h3>
                                <p className="mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">{tr('导出前在本机完成；无法可靠脱敏的二进制文件会被排除。', 'Applied locally before export; binary files that cannot be safely redacted are excluded.')}</p>
                                <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
                                    {privacyOptions.map(option => (
                                        <label
                                            key={option.key}
                                            className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-slate-200 bg-white px-3 py-2.5 dark:border-slate-700 dark:bg-slate-900/70"
                                        >
                                            <input
                                                type="checkbox"
                                                checked={privacy[option.key]}
                                                disabled={Boolean(operation)}
                                                onChange={(event) => setPrivacy(current => ({
                                                    ...current,
                                                    [option.key]: event.target.checked,
                                                }))}
                                                className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-brand-600 dark:border-slate-600"
                                            />
                                            <span>
                                                <strong className="block text-[11px] text-slate-700 dark:text-slate-200">{option.title}</strong>
                                                <span className="mt-0.5 block text-[9px] leading-4 text-slate-400 dark:text-slate-500">{option.description}</span>
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            </section>

                            {!exportData && (
                                <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[10px] leading-4 text-amber-800 dark:border-amber-900 dark:bg-amber-950/35 dark:text-amber-200">
                                    {tr('当前页面还没有提供工程证据；仍可切换到“本地打开诊断包”查看已有文件。', 'No project evidence is available on this screen yet; you can still switch to "Inspect Local Bundle" to open an existing ZIP.')}
                                </div>
                            )}

                            {exportResult && (
                                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3 dark:border-emerald-900 dark:bg-emerald-950/35">
                                    <div className="flex items-center gap-2 text-xs font-black text-emerald-800 dark:text-emerald-200">
                                        <CheckCircle2 size={15} /> {tr('诊断包已保存到本机', 'Diagnostic bundle saved locally')}
                                    </div>
                                    <p className="mt-1 break-all text-[10px] leading-4 text-emerald-700/80 dark:text-emerald-300/80">{exportResult.outputPath}</p>
                                    <p className="mt-1 text-[10px] text-emerald-700/80 dark:text-emerald-300/80">
                                        {tr(`已包含 ${exportResult.includedFiles} 个文件；缺失 ${exportResult.missingItems} 项；按设置排除 ${exportResult.omittedItems} 项。`, `Included ${exportResult.includedFiles} files; ${exportResult.missingItems} missing; ${exportResult.omittedItems} omitted by settings.`)}
                                    </p>
                                </div>
                            )}

                            <button
                                type="button"
                                onClick={() => void runExport()}
                                disabled={!nativeAvailable || !exportData || Boolean(operation)}
                                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-brand-700 px-4 text-xs font-black text-white shadow-sm transition-colors hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-brand-600 dark:hover:bg-brand-500"
                            >
                                {operation === 'export' ? <Loader2 size={16} className="animate-spin" /> : <Archive size={16} />}
                                {operation === 'export' ? tr('正在本机整理并校验…', 'Packaging and verifying locally…') : tr('选择位置并导出 ZIP', 'Choose Location & Export ZIP')}
                            </button>
                        </div>
                    )}

                    {tab === 'inspect' && (
                        <div className="space-y-4">
                            <section className="rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 via-white to-slate-50 p-4 dark:border-violet-900 dark:from-violet-950/35 dark:via-slate-900 dark:to-slate-950">
                                <div className="flex items-start gap-3">
                                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-600 text-white">
                                        <FileUp size={17} />
                                    </span>
                                    <div>
                                        <h3 className="text-sm font-black text-slate-900 dark:text-slate-100">{tr('打开 ZIP，生成本地摘要', 'Open ZIP & Generate Local Summary')}</h3>
                                        <p className="mt-1 text-[11px] leading-5 text-slate-600 dark:text-slate-300">
                                            {tr('只校验清单、文件大小、SHA-256 和安全路径并读取摘要，不解压到工程，也不会上传源码或日志。', 'Verifies manifest, sizes, SHA-256 hashes, and safe paths to read a summary without extracting into projects or uploading any data.')}
                                        </p>
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => void runInspection()}
                                    disabled={!nativeAvailable || Boolean(operation)}
                                    className="mt-4 flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-violet-700 px-4 text-xs font-black text-white transition-colors hover:bg-violet-600 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-violet-600 dark:hover:bg-violet-500"
                                >
                                    {operation === 'inspect' ? <Loader2 size={15} className="animate-spin" /> : <FileArchive size={15} />}
                                    {operation === 'inspect' ? tr('正在本机校验…', 'Verifying locally…') : tr('选择本地诊断包', 'Select Local Diagnostic Bundle')}
                                </button>
                            </section>

                            {inspection && (
                                <section className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-700 dark:bg-slate-900/55">
                                    <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                                        <div>
                                            <div className="flex items-center gap-2 text-sm font-black text-slate-900 dark:text-slate-100">
                                                <CheckCircle2 size={16} className="text-emerald-600 dark:text-emerald-400" />
                                                {tr('本地校验通过', 'Local Verification Passed')}
                                            </div>
                                            <p className="mt-1 max-w-xl break-all text-[9px] leading-4 text-slate-400 dark:text-slate-500" title={inspectedPath}>
                                                {inspectedPath}
                                            </p>
                                        </div>
                                        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[9px] font-bold text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
                                            Schema v{inspection.schemaVersion} · {tr(`${inspection.includedFiles} 个文件`, `${inspection.includedFiles} files`)}
                                        </span>
                                    </div>

                                    <SummaryGrid inspection={inspection} currentCoreVersions={currentCoreVersions} />

                                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                                        <div className={`rounded-xl border px-3 py-2.5 ${inspection.summary.sourceIncluded
                                            ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/35 dark:text-amber-200'
                                            : 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/35 dark:text-emerald-200'}`}
                                        >
                                            <div className="text-[10px] font-bold">{tr('源码', 'Source Code')}</div>
                                            <div className="mt-0.5 text-xs font-black">
                                                {inspection.summary.sourceIncluded ? tr('诊断包包含源码', 'Source code included') : tr('诊断包不包含源码', 'No source code included')}
                                            </div>
                                            <div className="mt-0.5 text-[9px] opacity-75">{tr('内容档位：', 'Content level: ')}{inspection.summary.contentLevel}</div>
                                        </div>
                                        <div className="rounded-xl border border-brand-200 bg-brand-50 px-3 py-2.5 text-brand-800 dark:border-brand-900 dark:bg-brand-950/35 dark:text-brand-200">
                                            <div className="text-[10px] font-bold">{tr('数据处理', 'Data Handling')}</div>
                                            <div className="mt-0.5 text-xs font-black">{tr('未联网 · 未自动上传', 'Offline · Not uploaded')}</div>
                                            <div className="mt-0.5 text-[9px] opacity-75">{tr('本次仅在本机读取经过校验的摘要。', 'Only a locally verified summary was read on this device.')}</div>
                                        </div>
                                    </div>

                                    {inspection.warnings.length > 0 && (
                                        <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 dark:border-amber-900 dark:bg-amber-950/35">
                                            <div className="flex items-center gap-1.5 text-[10px] font-black text-amber-800 dark:text-amber-200">
                                                <TriangleAlert size={12} /> {tr(`${inspection.warnings.length} 条打包提示`, `${inspection.warnings.length} packaging warnings`)}
                                            </div>
                                            <ul className="mt-1.5 space-y-1 text-[9px] leading-4 text-amber-700 dark:text-amber-300">
                                                {inspection.warnings.map((warning, index) => (
                                                    <li key={`${warning}-${index}`} className="break-words">• {warning}</li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                </section>
                            )}
                        </div>
                    )}

                    {error && (
                        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-[11px] leading-5 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300" role="alert">
                            {error}
                        </div>
                    )}
                </div>
            </section>
        </div>
    );
}

export default DiagnosticBundleModal;
