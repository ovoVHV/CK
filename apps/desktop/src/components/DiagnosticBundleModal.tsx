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

const CONTENT_LEVELS: ContentLevelOption[] = [
    {
        value: 'full_project',
        title: '包含完整工程',
        description: '积木工程、生成源码、环境、清单与日志。适合完整复现。',
        Icon: FolderArchive,
    },
    {
        value: 'generated_source_only',
        title: '仅包含生成源码',
        description: '不包含积木工程，只保留生成源码、环境、清单与日志。',
        Icon: FileCode2,
    },
    {
        value: 'no_source',
        title: '不包含源码',
        description: '仅包含环境、板卡、构建/上传清单和日志证据。',
        Icon: LockKeyhole,
    },
];

const PRIVACY_OPTIONS: Array<{
    key: keyof DiagnosticPrivacyOptions;
    title: string;
    description: string;
}> = [
    {
        key: 'redactWifi',
        title: '隐去 Wi-Fi 信息',
        description: '隐藏源码和日志中可识别的 SSID、密码与口令。',
    },
    {
        key: 'redactUsername',
        title: '隐去用户名',
        description: '替换本机用户目录和日志中的账户名。',
    },
    {
        key: 'redactPaths',
        title: '隐去本机路径',
        description: '清单不记录源路径，并替换文本中的绝对路径。',
    },
    {
        key: 'redactSerialContent',
        title: '不包含串口内容',
        description: '直接排除串口日志，避免设备数据或口令被带入。',
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
    return message || '发生未知错误';
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
    const { summary } = inspection;
    const coreAvailability = deriveDiagnosticCoreAvailability(summary, currentCoreVersions);
    const entries = [
        { label: '板卡', value: summary.board, Icon: CircuitBoard },
        { label: 'Core', value: summary.core, Icon: Cpu },
        { label: '完整 FQBN', value: summary.fqbn, Icon: Code2 },
        { label: 'Flash', value: summary.flash, Icon: HardDrive },
        {
            label: 'Core 状态',
            value: coreAvailability.label,
            Icon: coreAvailability.state === 'ready' ? CheckCircle2 : TriangleAlert,
        },
        { label: '失败阶段', value: summary.failureStage, Icon: ShieldCheck },
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
                title: '导出本地诊断包',
                defaultPath: suggestedFileName?.trim() || createDiagnosticBundleFileName(),
                filters: [{ name: 'CK 诊断包', extensions: ['zip'] }],
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
            setError(`导出失败：${errorMessage(cause)}`);
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
                title: '打开本地诊断包',
                multiple: false,
                directory: false,
                filters: [{ name: 'CK 诊断包', extensions: ['zip'] }],
            }));
            if (!selected) return;
            const result = await inspectDiagnosticBundle(selected);
            setInspection(result);
            setInspectedPath(selected);
            onInspected?.(result, selected);
        } catch (cause) {
            console.error('[DiagnosticBundle] Inspection failed', cause);
            setError(`无法打开诊断包：${errorMessage(cause)}`);
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
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300">
                            <FileArchive size={20} />
                        </span>
                        <div className="min-w-0">
                            <h2 id="diagnostic-bundle-title" className="text-base font-black text-slate-900 dark:text-slate-100">
                                工程体检与诊断包
                            </h2>
                            <p className="mt-0.5 text-[11px] leading-4 text-slate-500 dark:text-slate-400">
                                汇总板卡、Core、FQBN、构建、上传和环境证据，方便可靠复现问题。
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={!closeAllowed}
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                        aria-label="关闭诊断包"
                    >
                        <X size={18} />
                    </button>
                </header>

                <div className="shrink-0 border-b border-teal-200 bg-teal-50/80 px-5 py-2.5 dark:border-teal-900 dark:bg-teal-950/35">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-semibold text-teal-800 dark:text-teal-200">
                        <span className="inline-flex items-center gap-1.5"><HardDrive size={13} /> 只在本机处理</span>
                        <span className="inline-flex items-center gap-1.5"><WifiOff size={13} /> 不联网</span>
                        <span className="inline-flex items-center gap-1.5"><ShieldCheck size={13} /> 不自动上传</span>
                    </div>
                </div>

                <nav className="grid shrink-0 grid-cols-2 gap-1 border-b border-slate-200 bg-white px-5 pt-3 dark:border-slate-800 dark:bg-slate-900" aria-label="诊断包操作">
                    <button
                        type="button"
                        onClick={() => { setTab('export'); setError(null); }}
                        className={`flex h-10 items-center justify-center gap-2 rounded-t-xl border-b-2 text-xs font-bold transition-colors ${tab === 'export'
                            ? 'border-teal-600 bg-teal-50/60 text-teal-700 dark:border-teal-400 dark:bg-teal-950/35 dark:text-teal-300'
                            : 'border-transparent text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800/70'}`}
                    >
                        <FileDown size={15} /> 导出诊断包
                    </button>
                    <button
                        type="button"
                        onClick={() => { setTab('inspect'); setError(null); }}
                        className={`flex h-10 items-center justify-center gap-2 rounded-t-xl border-b-2 text-xs font-bold transition-colors ${tab === 'inspect'
                            ? 'border-violet-600 bg-violet-50/60 text-violet-700 dark:border-violet-400 dark:bg-violet-950/35 dark:text-violet-300'
                            : 'border-transparent text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800/70'}`}
                    >
                        <FileUp size={15} /> 本地打开诊断包
                    </button>
                </nav>

                <div className="min-h-0 flex-1 overflow-y-auto p-5">
                    {!nativeAvailable && (
                        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                            诊断包只在 CK 桌面软件中可用；网页预览不会读取或写入本机文件。
                        </div>
                    )}

                    {tab === 'export' && (
                        <div className="space-y-5">
                            <section>
                                <div className="mb-2.5 flex items-center justify-between gap-3">
                                    <div>
                                        <h3 className="text-xs font-black text-slate-800 dark:text-slate-100">选择包含范围</h3>
                                        <p className="mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">默认不带源码，可按排查需要明确放宽。</p>
                                    </div>
                                    <span className="rounded-full border border-slate-200 bg-white px-2 py-1 text-[9px] font-bold text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
                                        由你决定内容
                                    </span>
                                </div>
                                <div className="grid gap-2 md:grid-cols-3">
                                    {CONTENT_LEVELS.map(({ value, title, description, Icon }) => {
                                        const selected = contentLevel === value;
                                        return (
                                            <button
                                                key={value}
                                                type="button"
                                                aria-pressed={selected}
                                                onClick={() => setContentLevel(value)}
                                                disabled={Boolean(operation)}
                                                className={`min-h-[112px] rounded-xl border p-3 text-left transition-all disabled:cursor-not-allowed disabled:opacity-60 ${selected
                                                    ? 'border-teal-400 bg-teal-50 shadow-sm ring-1 ring-teal-200 dark:border-teal-700 dark:bg-teal-950/45 dark:ring-teal-900'
                                                    : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900/70 dark:hover:border-slate-600 dark:hover:bg-slate-900'}`}
                                            >
                                                <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${selected
                                                    ? 'bg-teal-600 text-white dark:bg-teal-500'
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
                                <h3 className="text-xs font-black text-slate-800 dark:text-slate-100">隐私处理</h3>
                                <p className="mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">导出前在本机完成；无法可靠脱敏的二进制文件会被排除。</p>
                                <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
                                    {PRIVACY_OPTIONS.map(option => (
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
                                                className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-teal-600 dark:border-slate-600"
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
                                    当前页面还没有提供工程证据；仍可切换到“本地打开诊断包”查看已有文件。
                                </div>
                            )}

                            {exportResult && (
                                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3 dark:border-emerald-900 dark:bg-emerald-950/35">
                                    <div className="flex items-center gap-2 text-xs font-black text-emerald-800 dark:text-emerald-200">
                                        <CheckCircle2 size={15} /> 诊断包已保存到本机
                                    </div>
                                    <p className="mt-1 break-all text-[10px] leading-4 text-emerald-700/80 dark:text-emerald-300/80">{exportResult.outputPath}</p>
                                    <p className="mt-1 text-[10px] text-emerald-700/80 dark:text-emerald-300/80">
                                        已包含 {exportResult.includedFiles} 个文件；缺失 {exportResult.missingItems} 项；按设置排除 {exportResult.omittedItems} 项。
                                    </p>
                                </div>
                            )}

                            <button
                                type="button"
                                onClick={() => void runExport()}
                                disabled={!nativeAvailable || !exportData || Boolean(operation)}
                                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-teal-700 px-4 text-xs font-black text-white shadow-sm transition-colors hover:bg-teal-600 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-teal-600 dark:hover:bg-teal-500"
                            >
                                {operation === 'export' ? <Loader2 size={16} className="animate-spin" /> : <Archive size={16} />}
                                {operation === 'export' ? '正在本机整理并校验…' : '选择位置并导出 ZIP'}
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
                                        <h3 className="text-sm font-black text-slate-900 dark:text-slate-100">打开 ZIP，生成本地中文摘要</h3>
                                        <p className="mt-1 text-[11px] leading-5 text-slate-600 dark:text-slate-300">
                                            只校验清单、文件大小、SHA-256 和安全路径并读取摘要，不解压到工程，也不会上传源码或日志。
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
                                    {operation === 'inspect' ? '正在本机校验…' : '选择本地诊断包'}
                                </button>
                            </section>

                            {inspection && (
                                <section className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-700 dark:bg-slate-900/55">
                                    <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                                        <div>
                                            <div className="flex items-center gap-2 text-sm font-black text-slate-900 dark:text-slate-100">
                                                <CheckCircle2 size={16} className="text-emerald-600 dark:text-emerald-400" />
                                                本地校验通过
                                            </div>
                                            <p className="mt-1 max-w-xl break-all text-[9px] leading-4 text-slate-400 dark:text-slate-500" title={inspectedPath}>
                                                {inspectedPath}
                                            </p>
                                        </div>
                                        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[9px] font-bold text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
                                            Schema v{inspection.schemaVersion} · {inspection.includedFiles} 个文件
                                        </span>
                                    </div>

                                    <SummaryGrid inspection={inspection} currentCoreVersions={currentCoreVersions} />

                                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                                        <div className={`rounded-xl border px-3 py-2.5 ${inspection.summary.sourceIncluded
                                            ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/35 dark:text-amber-200'
                                            : 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/35 dark:text-emerald-200'}`}
                                        >
                                            <div className="text-[10px] font-bold">源码</div>
                                            <div className="mt-0.5 text-xs font-black">
                                                {inspection.summary.sourceIncluded ? '诊断包包含源码' : '诊断包不包含源码'}
                                            </div>
                                            <div className="mt-0.5 text-[9px] opacity-75">内容档位：{inspection.summary.contentLevel}</div>
                                        </div>
                                        <div className="rounded-xl border border-teal-200 bg-teal-50 px-3 py-2.5 text-teal-800 dark:border-teal-900 dark:bg-teal-950/35 dark:text-teal-200">
                                            <div className="text-[10px] font-bold">数据处理</div>
                                            <div className="mt-0.5 text-xs font-black">未联网 · 未自动上传</div>
                                            <div className="mt-0.5 text-[9px] opacity-75">本次仅在本机读取经过校验的摘要。</div>
                                        </div>
                                    </div>

                                    {inspection.warnings.length > 0 && (
                                        <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 dark:border-amber-900 dark:bg-amber-950/35">
                                            <div className="flex items-center gap-1.5 text-[10px] font-black text-amber-800 dark:text-amber-200">
                                                <TriangleAlert size={12} /> {inspection.warnings.length} 条打包提示
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
