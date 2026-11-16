import { useEffect, useState } from 'react';
import { CircuitBoard, Hammer, Loader2, RefreshCcw, SlidersHorizontal, Upload, X } from 'lucide-react';
import { useHardware } from '../contexts/HardwareContext';
import { getBoardDetailsCached } from '../services/board_details_cache';
import { mergeBoardConfigOptions } from '../services/board_fqbn';
import { BoardOption } from '../types/board';
import type { WorkspaceViewMode } from '../services/workspace_view_mode';

interface BoardConfigModalProps {
    isOpen: boolean;
    onClose: () => void;
    boardName: string;
    boardFqbn?: string;
    detailsFqbn?: string;
    displayMode?: WorkspaceViewMode;
    configOptions?: BoardOption[];
    canUpload?: boolean;
    isBusy?: boolean;
    onClearCache?: () => Promise<boolean>;
    onDeepClearCache?: () => Promise<boolean>;
    onForceRebuild?: () => Promise<void>;
    onForceRebuildAndUpload?: () => Promise<void>;
}

export default function BoardConfigModal({
    isOpen,
    onClose,
    boardName,
    boardFqbn,
    detailsFqbn,
    displayMode = 'engineering',
    configOptions,
    canUpload = false,
    isBusy = false,
    onClearCache,
    onDeepClearCache,
    onForceRebuild,
    onForceRebuildAndUpload,
}: BoardConfigModalProps) {
    const {
        boardOptions,
        displayBoardOptions,
        droppedBoardOptions,
        setBoardOption,
        setBoardOptions,
    } = useHardware();
    const [configs, setConfigs] = useState<any[]>(configOptions || []);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sourceText, setSourceText] = useState('Arduino CLI');
    const [cacheAction, setCacheAction] = useState<'clear' | 'deep' | 'compile' | 'upload' | null>(null);
    const configurationLocked = isBusy || cacheAction !== null;

    const runCacheAction = async (action: 'clear' | 'deep' | 'compile' | 'upload') => {
        if (configurationLocked) return;
        setCacheAction(action);
        try {
            if (action === 'clear') await onClearCache?.();
            else if (action === 'deep') await onDeepClearCache?.();
            else if (action === 'compile') await onForceRebuild?.();
            else await onForceRebuildAndUpload?.();
        } finally {
            setCacheAction(null);
        }
    };

    const removeDroppedBoardOptions = () => {
        if (configurationLocked) return;
        const droppedKeys = new Set(Object.keys(droppedBoardOptions));
        const compatibleOptions = Object.fromEntries(
            Object.entries(boardOptions).filter(([key]) => !droppedKeys.has(key)),
        );
        setBoardOptions(compatibleOptions);
    };

    useEffect(() => {
        if (!isOpen) return;
        let active = true;

        const applyStaticFallback = () => {
            if (!active) return;
            if (configOptions && configOptions.length > 0) {
                setConfigs(configOptions);
                setSourceText('board.json');
                setError(null);
            } else {
                setConfigs([]);
            }
        };

        setError(null);
        setSourceText('Arduino CLI');

        const lookupFqbn = detailsFqbn || boardFqbn;
        if (!lookupFqbn) {
            applyStaticFallback();
            return () => {
                active = false;
            };
        }

        setLoading(true);
        Promise.resolve()
            .then(async () => {
                try {
                    const data = await getBoardDetailsCached(lookupFqbn);
                    if (!active) return;
                    const coreConfigs = Array.isArray(data?.config_options) ? data.config_options : [];
                    const nextConfigs = configOptions && configOptions.length > 0
                        ? mergeBoardConfigOptions(coreConfigs, configOptions)
                        : coreConfigs;
                    setConfigs(nextConfigs);
                    setSourceText(configOptions && configOptions.length > 0
                        ? 'Arduino CLI + board.json 约束'
                        : 'Arduino CLI');
                } catch (cause: any) {
                    if (!active) return;
                    console.warn('Failed to fetch board details, falling back to static config', cause);
                    applyStaticFallback();
                    setSourceText(configOptions && configOptions.length > 0
                        ? 'board.json（Core 未验证）'
                        : 'Arduino CLI 不可用');
                    setError(String(cause?.message || cause || '未知错误'));
                } finally {
                    if (active) setLoading(false);
                }
            });

        return () => {
            active = false;
        };
    }, [isOpen, boardFqbn, detailsFqbn, configOptions]);

    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || cacheAction) return;
            event.preventDefault();
            onClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [cacheAction, isOpen, onClose]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/45 p-4 dark:bg-black/65" onMouseDown={cacheAction ? undefined : onClose}>
            <div
                className="bg-white w-[700px] max-w-full overflow-hidden border border-[#d7dee8] flex flex-col h-[540px] max-h-[82vh] shadow-2xl rounded-lg dark:border-slate-700 dark:bg-slate-900"
                onMouseDown={(event) => event.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-labelledby="ck-board-config-title"
                data-ck-role="board-config-dialog"
            >
                <div className="h-[68px] flex items-center justify-between px-5 border-b border-[#e1e7ef] bg-[#fbfcfe] shrink-0 dark:border-slate-700 dark:bg-slate-900">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="w-9 h-9 rounded-md bg-brand-50 text-[var(--accent)] flex items-center justify-center shrink-0 dark:bg-brand-950/60 dark:text-brand-300">
                            <CircuitBoard size={18} />
                        </div>
                        <div className="flex flex-col min-w-0">
                            <span id="ck-board-config-title" className="text-sm font-bold text-slate-900 dark:text-slate-100">编译目标设置</span>
                            <span className="text-[10px] text-slate-400 font-mono truncate max-w-[560px] mt-0.5 dark:text-slate-500">
                                当前工程的板卡与编译参数
                            </span>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="w-8 h-8 flex items-center justify-center rounded-md text-slate-400 hover:text-slate-900 hover:bg-slate-100 transition-colors dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                        title="关闭"
                        aria-label="关闭板卡设置"
                    >
                        <X size={17} />
                    </button>
                </div>

                <div className="flex flex-1 min-h-0 flex-col">
                    <div className="min-h-[82px] px-5 py-4 bg-[#f6f8fb] border-b border-[#e1e7ef] flex items-start gap-5 shrink-0 dark:border-slate-700 dark:bg-slate-800/70">
                        <div className="flex flex-1 items-start gap-3 min-w-0">
                            <div className="w-11 h-11 bg-white border border-[#dce3ec] rounded-md flex items-center justify-center text-[var(--accent)] shrink-0 dark:border-slate-600 dark:bg-slate-900 dark:text-brand-300">
                                <CircuitBoard size={20} />
                            </div>
                            <div className="flex min-w-0 flex-1 flex-col">
                                <span className="text-[9px] font-bold text-slate-400 uppercase dark:text-slate-500">项目板卡</span>
                                <span className="text-sm font-bold text-slate-900 truncate mt-1 dark:text-slate-100" title={boardName}>{boardName}</span>
                                {displayMode === 'engineering' ? (
                                    <>
                                        <span className="mt-2 text-[9px] font-bold text-slate-400 dark:text-slate-500">完整编译目标</span>
                                        <code
                                            data-ck-role="board-config-effective-fqbn"
                                            className="mt-1 select-text whitespace-normal break-all [overflow-wrap:anywhere] font-mono text-[9px] leading-4 text-slate-500 dark:text-slate-400"
                                            title={boardFqbn || '未记录 FQBN'}
                                        >
                                            {boardFqbn || '未记录 FQBN'}
                                        </code>
                                    </>
                                ) : (
                                    <details data-ck-role="board-config-advanced-target" className="mt-2 text-[9px] text-slate-500 dark:text-slate-400">
                                        <summary className="cursor-pointer select-none font-bold text-brand-700 hover:text-brand-800 dark:text-brand-300 dark:hover:text-brand-200">
                                            查看完整编译目标
                                        </summary>
                                        <code
                                            data-ck-role="board-config-effective-fqbn"
                                            className="mt-1 block select-text whitespace-normal break-all [overflow-wrap:anywhere] font-mono text-[9px] leading-4"
                                            title={boardFqbn || '未记录 FQBN'}
                                        >
                                            {boardFqbn || '未记录 FQBN'}
                                        </code>
                                    </details>
                                )}
                            </div>
                        </div>
                    </div>

                    <section className="flex-1 min-w-0 min-h-0 flex flex-col bg-white dark:bg-slate-900">
                        <div className="h-12 px-5 border-b border-[#edf0f4] flex items-center justify-between shrink-0 dark:border-slate-800">
                            <div className="flex items-center gap-2 text-slate-700 dark:text-slate-200">
                                <SlidersHorizontal size={16} className="text-[var(--accent)] dark:text-brand-300" />
                                <span className="text-xs font-bold">编译选项</span>
                            </div>
                            <span className="text-[10px] text-slate-400 dark:text-slate-500">来源：{sourceText}</span>
                        </div>

                        <div className="flex-1 overflow-y-auto">
                            {loading && (
                                <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-3 dark:text-slate-500">
                                    <Loader2 size={22} className="animate-spin text-[var(--accent)] dark:text-brand-300" />
                                    <span className="text-xs">正在读取板卡定义</span>
                                </div>
                            )}

                            {!loading && error && (
                                <div className="mx-5 mt-5 px-4 py-3 border-l-2 border-red-400 bg-red-50 text-red-700 text-xs dark:border-red-500 dark:bg-red-950/45 dark:text-red-300">
                                    加载配置失败：{error}
                                </div>
                            )}

                            {!loading && Object.keys(droppedBoardOptions).length > 0 && (
                                <div className="mx-5 mt-5 px-4 py-3 border-l-2 border-red-400 bg-red-50 text-red-800 text-xs dark:border-red-500 dark:bg-red-950/45 dark:text-red-200">
                                    <div>
                                        <strong>已阻止构建：</strong>当前板卡不支持旧配置：{Object.entries(droppedBoardOptions)
                                            .map(([key, value]) => `${key}=${value}`)
                                            .join('、')}。CK 不会静默改用默认值。
                                    </div>
                                    <button
                                        type="button"
                                        onClick={removeDroppedBoardOptions}
                                        disabled={configurationLocked}
                                        className="mt-2 h-8 px-3 rounded-md border border-red-300 bg-white text-red-700 font-bold hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-700 dark:bg-slate-900 dark:text-red-300 dark:hover:bg-red-950/70"
                                    >
                                        移除不兼容旧配置
                                    </button>
                                </div>
                            )}

                            {!loading && !error && configs.length === 0 && (
                                <div className="h-full flex flex-col items-center justify-center text-center px-8 text-slate-400 dark:text-slate-500">
                                    <SlidersHorizontal size={24} className="mb-3 text-slate-300 dark:text-slate-600" />
                                    <span className="text-sm font-semibold text-slate-500 dark:text-slate-400">当前板卡无需额外配置</span>
                                    <span className="text-xs mt-1">使用核心提供的默认编译参数</span>
                                </div>
                            )}

                            {!loading && configs.map((option: any) => (
                                <div
                                    key={option.option}
                                    className="min-h-[68px] flex items-center justify-between gap-5 px-5 py-3 border-b border-[#edf0f4] last:border-0 hover:bg-[#fbfcfe] dark:border-slate-800 dark:hover:bg-slate-800/55"
                                >
                                    <div className="flex flex-col min-w-0">
                                        <span className="text-xs text-slate-800 font-bold truncate dark:text-slate-200">{option.option_label}</span>
                                        <span className="text-[9px] text-slate-400 font-mono mt-1 dark:text-slate-500">{option.option}</span>
                                    </div>
                                    <select
                                        className="h-9 bg-white border border-[#d7dee8] rounded-md px-3 text-xs text-slate-700 outline-none focus:border-brand-600 transition-colors min-w-[180px] max-w-[260px] dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:focus:border-brand-400"
                                        value={displayBoardOptions[option.option] || option.values.find((value: any) => value.selected)?.value || ''}
                                        disabled={configurationLocked}
                                        onChange={(event) => setBoardOption(option.option, event.target.value)}
                                    >
                                        {option.values.map((value: any) => (
                                            <option key={value.value} value={value.value}>{value.value_label}</option>
                                        ))}
                                    </select>
                                </div>
                            ))}
                        </div>
                    </section>
                </div>

                <div className="min-h-14 px-5 py-2 bg-[#fbfcfe] border-t border-[#e1e7ef] flex items-center justify-between gap-3 shrink-0 dark:border-slate-700 dark:bg-slate-900">
                    <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[10px] text-slate-400 dark:text-slate-500">
                            {isBusy ? '编译或上传期间配置已锁定' : loading ? '正在同步 Arduino CLI' : `已加载 ${configs.length} 个编译选项`}
                        </span>
                        <button
                            data-ck-role="deep-compile-cache-refresh"
                            onClick={() => void runCacheAction('deep')}
                            disabled={isBusy || !!cacheAction || !onDeepClearCache}
                            className="text-[10px] font-semibold text-slate-400 hover:text-amber-700 underline underline-offset-2 disabled:opacity-40 whitespace-nowrap dark:text-slate-500 dark:hover:text-amber-300"
                            title="忽略编译器内容缓存并彻底重建；仅在怀疑缓存损坏时使用，ESP32 可能需要数分钟"
                        >
                            {cacheAction === 'deep' ? '正在彻底刷新…' : '彻底刷新'}
                        </button>
                    </div>
                    <div className="flex items-center justify-end gap-2 min-w-0">
                        <button
                            onClick={() => void runCacheAction('clear')}
                            disabled={isBusy || !!cacheAction || !onClearCache}
                            className="h-8 px-3 border border-[#d7dee8] bg-white hover:bg-slate-50 text-slate-600 text-xs font-bold rounded-md transition-colors disabled:opacity-50 inline-flex items-center gap-1.5 whitespace-nowrap dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                            title="重建当前板卡配置的产物，保留按源码内容校验的编译器缓存"
                        >
                            {cacheAction === 'clear' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCcw size={14} />}
                            重建缓存
                        </button>
                        <button
                            onClick={() => void runCacheAction('compile')}
                            disabled={isBusy || !!cacheAction || !onForceRebuild}
                            className="h-8 px-3 border border-[#9fc7c2] bg-white hover:bg-[#f1f9f8] text-[var(--accent)] text-xs font-bold rounded-md transition-colors disabled:opacity-50 inline-flex items-center gap-1.5 whitespace-nowrap dark:border-brand-700 dark:bg-slate-800 dark:text-brand-300 dark:hover:bg-brand-950/45"
                        >
                            {cacheAction === 'compile' ? <Loader2 size={14} className="animate-spin" /> : <Hammer size={14} />}
                            重新编译
                        </button>
                        <button
                            onClick={() => void runCacheAction('upload')}
                            disabled={isBusy || !!cacheAction || !onForceRebuildAndUpload || !canUpload}
                            className="h-8 px-3 bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold rounded-md transition-colors disabled:opacity-50 inline-flex items-center gap-1.5 whitespace-nowrap"
                            title={canUpload ? '重建当前配置后重新编译并烧录' : '请先选择串口'}
                        >
                            {cacheAction === 'upload' ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                            重新烧录
                        </button>
                        <button
                            onClick={onClose}
                            disabled={!!cacheAction}
                            className="h-8 px-4 border border-[#d7dee8] bg-white hover:bg-slate-50 text-slate-700 text-xs font-bold rounded-md transition-colors disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                        >
                            完成
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
