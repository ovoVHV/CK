import { Archive, BookOpen, Copy, Eye, EyeOff, FolderOpen, RefreshCw, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import type { WorkspaceLoadInspection } from '../services/unknown_block_guard';

interface UnknownBlocksProtectionPanelProps {
    projectName: string;
    inspection: WorkspaceLoadInspection;
    busy?: boolean;
    onOpenLibraryManager: () => void;
    onRetry: () => void;
    onShowOriginal: () => void;
    onExportRawWorkspace: () => void;
}

export function UnknownBlocksProtectionPanel({
    projectName,
    inspection,
    busy = false,
    onOpenLibraryManager,
    onRetry,
    onShowOriginal,
    onExportRawWorkspace,
}: UnknownBlocksProtectionPanelProps) {
    const [showRaw, setShowRaw] = useState(false);
    const preview = inspection.rawWorkspace.serialized.slice(0, 20_000);
    const truncated = preview.length < inspection.rawWorkspace.serialized.length;
    return (
        <div className="absolute inset-0 z-[45] overflow-auto bg-slate-50 p-5 dark:bg-[#0b1220]" data-ck-role="unknown-block-protection">
            <div className="mx-auto max-w-4xl overflow-hidden rounded-2xl border border-amber-200 bg-white shadow-xl dark:border-amber-900/70 dark:bg-slate-900">
                <header className="flex items-start gap-4 border-b border-amber-100 bg-amber-50 px-6 py-5 dark:border-amber-900/50 dark:bg-amber-950/25">
                    <div className="rounded-xl bg-amber-100 p-3 text-amber-700 dark:bg-amber-900/60 dark:text-amber-200"><ShieldAlert size={26} /></div>
                    <div className="min-w-0">
                        <div className="text-xs font-bold uppercase tracking-[0.16em] text-amber-700 dark:text-amber-300">只读保护模式</div>
                        <h2 className="mt-1 break-words text-xl font-black text-slate-900 dark:text-white">{projectName || '当前工程'} 含有尚未注册的积木</h2>
                        <p className="mt-2 text-sm leading-6 text-slate-700 dark:text-slate-300">
                            CK 没有把这些积木交给 Blockly 反序列化，也不会允许普通保存覆盖原工程。原始字段、连接、坐标、mutation、extraState 与嵌套数据仍逐字节保留。
                        </p>
                    </div>
                </header>

                <div className="space-y-5 px-6 py-5">
                    <div className="grid gap-3 sm:grid-cols-3">
                        <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                            <div className="text-xs font-semibold text-slate-500">未知积木</div>
                            <div className="mt-1 text-2xl font-black text-amber-700 dark:text-amber-300">{inspection.unknownBlockCount}</div>
                        </div>
                        <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                            <div className="text-xs font-semibold text-slate-500">未知类型</div>
                            <div className="mt-1 text-2xl font-black text-slate-800 dark:text-slate-100">{inspection.unknownTypes.length}</div>
                        </div>
                        <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                            <div className="text-xs font-semibold text-slate-500">原始数据</div>
                            <div className="mt-1 text-sm font-bold text-slate-800 dark:text-slate-100">{(inspection.rawWorkspace.utf8ByteLength / 1024).toFixed(1)} KiB · {inspection.format.toUpperCase()}</div>
                        </div>
                    </div>

                    <div>
                        <div className="mb-2 text-sm font-bold text-slate-700 dark:text-slate-200">缺失类型</div>
                        <div className="flex flex-wrap gap-2">
                            {inspection.unknownTypes.map(item => (
                                <span key={item.type} title={item.paths.join('\n')} className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 font-mono text-xs font-semibold text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                                    {item.type} × {item.count}
                                </span>
                            ))}
                        </div>
                    </div>

                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-6 text-slate-600 dark:border-slate-700 dark:bg-slate-950/60 dark:text-slate-300">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <span>SHA-256：<code className="break-all">{inspection.rawWorkspace.sha256}</code></span>
                            <button type="button" onClick={() => navigator.clipboard?.writeText(inspection.rawWorkspace.sha256)} className="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 font-semibold hover:bg-white dark:border-slate-700 dark:hover:bg-slate-800"><Copy size={12} />复制</button>
                        </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={onOpenLibraryManager} disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-lg bg-amber-600 px-3 text-sm font-bold text-white hover:bg-amber-700 disabled:opacity-50"><BookOpen size={16} />安装或启用对应积木包</button>
                        <button type="button" onClick={onRetry} disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"><RefreshCw size={15} />重新检查</button>
                        <button type="button" onClick={onShowOriginal} className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"><FolderOpen size={15} />显示原工程</button>
                        <button type="button" onClick={onExportRawWorkspace} className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"><Archive size={15} />导出原始积木数据</button>
                        <button type="button" onClick={() => setShowRaw(value => !value)} className="ml-auto inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">
                            {showRaw ? <EyeOff size={15} /> : <Eye size={15} />}{showRaw ? '隐藏原始数据' : '查看原始数据'}
                        </button>
                    </div>

                    {showRaw && (
                        <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
                            <div className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-500 dark:border-slate-700 dark:bg-slate-950">只读预览{truncated ? '（界面仅显示前 20,000 字符，导出文件保持完整）' : ''}</div>
                            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all bg-white p-3 text-xs leading-5 text-slate-700 dark:bg-slate-900 dark:text-slate-200">{preview}</pre>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

