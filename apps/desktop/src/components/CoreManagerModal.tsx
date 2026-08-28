import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2, Trash2, X, Package, DownloadCloud, RefreshCw } from 'lucide-react';
import { useDialog } from '../contexts/DialogContext';

interface InstalledCore {
    id: string;
    installed: string;
    name: string;
    latest: string | null;
}

interface AvailableCore {
    name: string;
    id: string; // Package ID
    versions: string[]; // Available versions
    recommendedVersion: string; // CK's currently verified recommendation; newer index versions remain selectable
    index_url?: string;
    /** Optional version-specific package indexes (for example, a regional mirror). */
    mirrorIndexUrls?: Record<string, string>;
    description: string;
}

const ESP32_OFFICIAL_INDEX_URL = "https://espressif.github.io/arduino-esp32/package_esp32_index.json";
const ESP32_CN_INDEX_URL = "https://jihulab.com/esp-mirror/espressif/arduino-esp32/-/raw/gh-pages/package_esp32_index_cn.json";

function defaultIndexUrlForVersion(core: AvailableCore, version: string): string | undefined {
    return core.mirrorIndexUrls?.[version] || core.index_url;
}

const AVAILABLE_CORES: AvailableCore[] = [
    {
        name: "Arduino AVR",
        id: "arduino:avr",
        versions: ["1.8.8", "1.8.6"],
        recommendedVersion: "1.8.6",
        description: "经典 Arduino 开发板 (Uno, Nano, Mega)",
        index_url: undefined // Built-in
    },
    {
        name: "ESP32 (Espressif)",
        id: "esp32:esp32",
        versions: ["3.3.6", "3.3.6-cn", "3.3.5", "3.3.5-cn", "3.1.1", "3.0.7", "2.0.17"],
        recommendedVersion: "3.3.6",
        description: "ESP32 全系列芯片 (S2, S3, C3, C6)",
        index_url: ESP32_OFFICIAL_INDEX_URL,
        mirrorIndexUrls: {
            // The CN index carries the explicitly suffixed package version;
            // selecting it must not replace the official 3.3.6 source.
            "3.3.6-cn": ESP32_CN_INDEX_URL,
            "3.3.5-cn": ESP32_CN_INDEX_URL,
        },
    },
    {
        name: "STM32 (STMicroelectronics)",
        id: "STMicroelectronics:stm32",
        versions: ["2.12.0", "2.11.0", "2.10.1"],
        recommendedVersion: "2.12.0",
        description: "STM32F1/F4 系列支持",
        index_url: "https://github.com/stm32duino/BoardManagerFiles/raw/main/package_stmicroelectronics_index.json"
    },
    {
        name: "RP2040 (Raspberry Pi)",
        id: "rp2040:rp2040",
        versions: ["3.7.2", "3.6.0"],
        recommendedVersion: "3.7.2",
        description: "Raspberry Pi Pico 及其他 RP2040 开发板",
        index_url: "https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json"
    }
];

interface CoreManagerModalProps {
    isOpen: boolean;
    onClose: () => void;
    onInstall: (coreId: string, version: string, indexUrl?: string) => Promise<void>;
    onUninstall: (coreId: string) => Promise<void>;
}

export const CoreManagerModal = ({ isOpen, onClose, onInstall, onUninstall }: CoreManagerModalProps) => {
    const [activeTab, setActiveTab] = useState<'installed' | 'available'>('available'); // Default to available as requested
    const [cores, setCores] = useState<InstalledCore[]>([]);
    const [loading, setLoading] = useState(true);
    const { alert } = useDialog();
    const [processing, setProcessing] = useState<string | null>(null); // Installing or Uninstalling ID
    const [customUrls, setCustomUrls] = useState<Record<string, string>>({});
    const [selectedVersions, setSelectedVersions] = useState<Record<string, string>>({});
    const [customVersionInputs, setCustomVersionInputs] = useState<Record<string, string>>({});
    const [manualCoreInput, setManualCoreInput] = useState({ id: '', version: '', url: '' });

    const handleManualInstall = async () => {
        if (!manualCoreInput.id) {
            alert({ title: "输入错误", message: "请输入核心 ID (例如 arduino:mbed_nano)", type: "warning" });
            return;
        }
        setProcessing('manual');
        try {
            await onInstall(manualCoreInput.id, manualCoreInput.version, manualCoreInput.url);
            await loadCores();
            setManualCoreInput({ id: '', version: '', url: '' });
        } catch (e) {
            console.error("Manual install failed:", e);
            alert({ title: "安装失败", message: String(e), type: "error" });
        } finally {
            setProcessing(null);
        }
    };

    const loadCores = async () => {
        setLoading(true);
        try {
            const list = await invoke('get_installed_cores') as InstalledCore[];
            setCores(list);
        } catch (e) {
            console.error("Failed to load cores", e);
            alert({ title: "加载失败", message: "无法获取核心列表: " + e, type: "error" });
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (isOpen) {
            loadCores();
        }
    }, [isOpen]);

    const handleUninstall = async (core: InstalledCore) => {
        setProcessing(core.id);
        try {
            await onUninstall(core.id);
            await loadCores();
        } catch (e) {
            console.error("Uninstall failed in modal:", e);
        } finally {
            setProcessing(null);
        }
    };

    const handleInstall = async (core: AvailableCore) => {
        setProcessing(core.id);
        try {
            // Logic for version selection
            let versionToUse = selectedVersions[core.id] || core.recommendedVersion;
            if (versionToUse === 'latest') {
                // An empty version deliberately lets Arduino CLI resolve the
                // newest version from the refreshed package index. This keeps
                // the UI useful when a vendor publishes a version newer than
                // CK's verified recommendation.
                versionToUse = '';
            }
            if (versionToUse === 'custom') {
                versionToUse = customVersionInputs[core.id]?.trim();
                if (!versionToUse) {
                    throw new Error("请输入有效的版本号");
                }
            }

            // A manually entered URL always wins. Otherwise, select the
            // version-specific mirror (3.3.6-cn) and keep the official index
            // as the default for 3.3.6 and all other versions.
            const urlToUse = customUrls[core.id] !== undefined
                ? customUrls[core.id]
                : defaultIndexUrlForVersion(core, versionToUse);

            await onInstall(core.id, versionToUse, urlToUse);
            await loadCores();
        } catch (e) {
            console.error("Install failed in modal:", e);
            alert({ title: "安装失败", message: String(e), type: "error" });
        } finally {
            setProcessing(null);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-in fade-in">
            <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-xl w-[700px] h-[600px] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200 border border-slate-200 dark:border-slate-800">
                {/* Header */}
                <div className="h-16 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between px-6 flex-shrink-0 bg-white dark:bg-slate-900 z-10">
                    <div className="flex items-center gap-4">
                        <div className="p-2 bg-teal-50 dark:bg-teal-900/30 rounded-lg text-teal-600 dark:text-teal-400">
                            <Package size={24} />
                        </div>
                        <div>
                            <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">编译器核心管理</h2>
                            <p className="text-xs text-slate-500 dark:text-slate-400">管理 Arduino CLI 的编译环境</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
                        <X size={20} />
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex border-b border-slate-100 dark:border-slate-800 px-6 gap-6 bg-slate-50/50 dark:bg-slate-900/50">
                    <button
                        onClick={() => setActiveTab('available')}
                        className={`py-3 text-sm font-bold border-b-2 transition-colors ${activeTab === 'available' ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
                    >
                        可安装核心
                    </button>
                    <button
                        onClick={() => setActiveTab('installed')}
                        className={`py-3 text-sm font-bold border-b-2 transition-colors ${activeTab === 'installed' ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
                    >
                        已安装 ({cores.length})
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-6 bg-slate-50 dark:bg-slate-950">
                    {loading ? (
                        <div className="flex flex-col items-center justify-center h-full text-slate-400 dark:text-slate-500">
                            <Loader2 className="animate-spin mb-3" size={32} />
                            <p>正在加载列表...</p>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {activeTab === 'installed' ? (
                                cores.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center py-20 text-slate-400 dark:text-slate-500">
                                        <div className="text-4xl mb-4">📦</div>
                                        <p>没有检测到已安装的核心。</p>
                                        <button onClick={() => setActiveTab('available')} className="mt-4 text-teal-600 dark:text-teal-400 hover:underline text-sm font-medium">
                                            去下载核心
                                        </button>
                                    </div>
                                ) : (
                                    cores.map(core => (
                                        <div key={core.id} className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm flex items-center justify-between group">
                                            <div>
                                                <h3 className="font-bold text-slate-800 dark:text-slate-100 text-sm">{core.name}</h3>
                                                <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400 mt-1">
                                                    <span className="bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded text-slate-600 dark:text-slate-300 font-mono">{core.id}</span>
                                                    <span className="text-teal-600 dark:text-teal-400 font-medium">v{core.installed}</span>
                                                </div>
                                            </div>

                                            <button
                                                type="button"
                                                onClick={() => handleUninstall(core)}
                                                disabled={processing === core.id}
                                                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-red-200 dark:hover:border-red-900/60 hover:bg-red-50 dark:hover:bg-red-900/30 hover:text-red-600 dark:hover:text-red-400 disabled:cursor-wait disabled:opacity-60 transition-colors"
                                                title={`卸载核心 ${core.name}`}
                                                aria-label={`卸载核心 ${core.name}`}
                                            >
                                                {processing === core.id ? <Loader2 className="animate-spin" size={18} /> : <Trash2 size={18} />}
                                                <span className="whitespace-nowrap">{processing === core.id ? '卸载中...' : '卸载'}</span>
                                            </button>
                                        </div>
                                    ))
                                )
                            ) : (
                                // Available Cores List
                                AVAILABLE_CORES.map(core => {
                                    const isInstalled = cores.some(c => c.id === core.id);
                                    const selectedVer = selectedVersions[core.id] || core.recommendedVersion;
                                    const indexVersion = selectedVer === 'custom'
                                        ? customVersionInputs[core.id]?.trim() || selectedVer
                                        : selectedVer;
                                    const defaultIndexUrl = defaultIndexUrlForVersion(core, indexVersion);
                                    const effectiveIndexUrl = customUrls[core.id] !== undefined
                                        ? customUrls[core.id]
                                        : defaultIndexUrl;

                                    return (
                                        <div key={core.id} className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm transition-colors group hover:border-teal-200 dark:hover:border-teal-700">
                                            <div className="flex items-center justify-between mb-2">
                                                <div>
                                                    <h3 className="font-bold text-slate-800 dark:text-slate-100 text-sm flex items-center gap-2">
                                                        {core.name}
                                                        {isInstalled && <span className="bg-teal-50 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400 text-[10px] px-1.5 py-0.5 rounded border border-teal-100 dark:border-teal-800">已安装</span>}
                                                    </h3>
                                                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{core.description}</p>
                                                </div>
                                            </div>

                                            {/* Version Selection & Install */}
                                            <div className="flex flex-col gap-2 mt-3">
                                                <div className="flex items-center gap-3">
                                                    <select
                                                        value={selectedVer}
                                                        onChange={(e) => setSelectedVersions(prev => ({ ...prev, [core.id]: e.target.value }))}
                                                        className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs rounded px-2 py-1.5 focus:outline-none focus:border-teal-500 text-slate-700 dark:text-slate-200 font-mono"
                                                    >
                                                        <option value="latest">最新可用版本（来自包索引）</option>
                                                        {core.versions.map(v => (
                                                            <option key={v} value={v}>
                                                                v{v}{v === core.recommendedVersion ? '（推荐）' : ''}
                                                            </option>
                                                        ))}
                                                        <option value="custom">输入其他版本...</option>
                                                    </select>

                                                    <button
                                                        onClick={() => handleInstall(core)}
                                                        disabled={processing === core.id}
                                                        className={`
                                                        px-4 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-2
                                                        ${isInstalled
                                                                ? 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                                                                : 'bg-slate-800 dark:bg-slate-700 text-white hover:bg-teal-600 dark:hover:bg-teal-600 hover:shadow-teal-500/20 shadow-sm'}
                                                    `}
                                                    >
                                                        {processing === core.id ? <Loader2 className="animate-spin" size={14} /> : <DownloadCloud size={14} />}
                                                        <span>{isInstalled ? '重新安装' : '下载'}</span>
                                                    </button>
                                                </div>

                                                {/* Custom Version Input */}
                                                {selectedVer === 'custom' && (
                                                    <input
                                                        type="text"
                                                        value={customVersionInputs[core.id] || ''}
                                                        onChange={(e) => setCustomVersionInputs(prev => ({ ...prev, [core.id]: e.target.value }))}
                                                        placeholder="例如: 3.3.6-cn"
                                                        className="w-40 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-900/50 rounded px-2 py-1 text-xs text-slate-700 dark:text-yellow-100 focus:outline-none focus:border-yellow-400 font-mono animate-in slide-in-from-top-1"
                                                    />
                                                )}
                                            </div>

                                            {/* Custom URL Input - Always visible if supported */}
                                            {core.index_url && (
                                                <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800">
                                                    <label className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1.5 block">
                                                        镜像源 URL
                                                    </label>
                                                    <div className="flex gap-2">
                                                        <input
                                                            type="text"
                                                            value={effectiveIndexUrl || ''}
                                                            onChange={(e) => setCustomUrls(prev => ({ ...prev, [core.id]: e.target.value }))}
                                                            className="flex-1 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded px-2 py-1.5 text-xs text-slate-600 dark:text-slate-300 focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500/30 placeholder-slate-400 font-mono"
                                                            placeholder="输入自定义 json 链接..."
                                                        />
                                                        <button
                                                            onClick={async () => {
                                                                if (!effectiveIndexUrl || !effectiveIndexUrl.trim()) {
                                                                    alert({ title: "无效链接", message: "请输入有效的 Board Manager URL。", type: "warning" });
                                                                    return;
                                                                }

                                                                const procId = `index-${core.id}`;
                                                                setProcessing(procId);
                                                                try {
                                                                    alert({ title: "开始更新", message: `正在更新 ${core.name} 的索引...`, type: "info" });
                                                                    await invoke('update_package_index', { indexUrl: effectiveIndexUrl });
                                                                    alert({ title: "更新成功", message: "索引已更新完成。", type: "success" });
                                                                } catch (e) {
                                                                    alert({ title: "更新失败", message: String(e), type: "error" });
                                                                } finally {
                                                                    setProcessing(null);
                                                                }
                                                            }}
                                                            disabled={!!processing}
                                                            className="bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 px-3 py-1.5 rounded text-xs font-bold transition-colors flex items-center gap-2"
                                                            title="更新此源索引"
                                                        >
                                                            {processing === `index-${core.id}` ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}
                                                            更新
                                                        </button>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })
                            )}

                            {/* Manual Install Card - Only in Available Tab */}
                            {activeTab === 'available' && (
                                <div className="bg-slate-100 dark:bg-slate-800/50 p-4 rounded-xl border border-slate-200 dark:border-slate-700 border-dashed flex flex-col gap-3 mt-4 animate-in slide-in-from-bottom-2">
                                    <div className="flex justify-between items-center">
                                        <h3 className="font-bold text-slate-700 dark:text-slate-300 text-sm flex items-center gap-2">
                                            <Package size={16} />
                                            手动安装其他核心
                                        </h3>
                                        <span className="text-[10px] text-slate-400 dark:text-slate-500 bg-slate-200 dark:bg-slate-700 px-2 py-0.5 rounded-full">高级</span>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="col-span-1 flex flex-col">
                                            <input
                                                placeholder="核心 ID (如 arduino:mbed_nano)"
                                                className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 text-xs font-mono focus:outline-none focus:border-teal-500 w-full text-slate-800 dark:text-slate-200"
                                                value={manualCoreInput.id}
                                                onChange={e => setManualCoreInput(prev => ({ ...prev, id: e.target.value }))}
                                            />
                                            <span className="text-[10px] text-slate-400 mt-0.5 ml-1">格式: 厂家:架构 (例 esp8266:esp8266)</span>
                                        </div>
                                        <input
                                            placeholder="版本号 (可选)"
                                            className="col-span-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 text-xs font-mono focus:outline-none focus:border-teal-500 text-slate-800 dark:text-slate-200"
                                            value={manualCoreInput.version}
                                            onChange={e => setManualCoreInput(prev => ({ ...prev, version: e.target.value }))}
                                        />
                                        <input
                                            placeholder="镜像源 URL（可选）"
                                            className="col-span-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 text-xs font-mono focus:outline-none focus:border-teal-500 text-slate-800 dark:text-slate-200"
                                            value={manualCoreInput.url}
                                            onChange={e => setManualCoreInput(prev => ({ ...prev, url: e.target.value }))}
                                        />
                                    </div>
                                    <div className="flex justify-end">
                                        <button
                                            onClick={handleManualInstall}
                                            disabled={processing === 'manual'}
                                            className="bg-slate-800 dark:bg-slate-700 text-white hover:bg-teal-600 dark:hover:bg-teal-600 px-4 py-1.5 rounded-lg text-xs font-bold transition-colors flex items-center gap-2 shadow-sm"
                                        >
                                            {processing === 'manual' ? <Loader2 className="animate-spin" size={14} /> : <DownloadCloud size={14} />}
                                            安装自定义核心
                                        </button>
                                        <button
                                            onClick={async () => {
                                                const url = manualCoreInput.url?.trim();

                                                if (!url) {
                                                    alert({ title: "无效链接", message: "请输入有效的 Board Manager URL。", type: "warning" });
                                                    return;
                                                }

                                                setProcessing('index');
                                                try {
                                                    alert({ title: "开始更新", message: "正在后台更新核心索引，请稍候...", type: "info" });
                                                    await invoke('update_package_index', { indexUrl: url });
                                                    alert({ title: "更新成功", message: "索引已更新完成。", type: "success" });
                                                } catch (e) {
                                                    alert({ title: "更新失败", message: String(e), type: "error" });
                                                } finally {
                                                    setProcessing(null);
                                                }
                                            }}
                                            disabled={!!processing}
                                            className="ml-2 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600 px-4 py-1.5 rounded-lg text-xs font-bold transition-colors flex items-center gap-2 shadow-sm border border-slate-300 dark:border-slate-600"
                                            title="仅添加源并更新索引，不安装核心"
                                        >
                                            {processing === 'index' ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}
                                            仅添加源并更新
                                        </button>
                                    </div>

                                    {/* Common Examples Quick Reference */}
                                    <details className="text-[10px] text-slate-500 dark:text-slate-400 cursor-pointer select-none group">
                                        <summary className="hover:text-teal-600 dark:hover:text-teal-400 transition-colors list-none flex items-center gap-1 font-bold">
                                            <span className="group-open:rotate-90 transition-transform">▸</span>
                                            查看常用核心 ID 参考
                                        </summary>
                                        <div className="mt-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded p-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono select-text cursor-auto">
                                            <div className="flex justify-between border-b border-slate-100 dark:border-slate-800 pb-1 mb-1 col-span-2 font-bold text-slate-400">
                                                <span>常见开发板</span>
                                                <span>核心 ID（厂家:架构）</span>
                                            </div>

                                            <span>Arduino Uno/Nano</span>
                                            <span className="text-slate-700 dark:text-slate-300 select-all">arduino:avr</span>

                                            <span>ESP8266 Series</span>
                                            <span className="text-slate-700 dark:text-slate-300 select-all">esp8266:esp8266</span>

                                            <span>Nano 33 BLE</span>
                                            <span className="text-slate-700 dark:text-slate-300 select-all">arduino:mbed_nano</span>

                                            <span>Nano RP2040 Connect</span>
                                            <span className="text-slate-700 dark:text-slate-300 select-all">arduino:mbed_rp2040</span>

                                            <span>Seeed XIAO nRF52</span>
                                            <span className="text-slate-700 dark:text-slate-300 select-all">Seeeduino:nrf52</span>

                                            <span>Teensy Boards</span>
                                            <span className="text-slate-700 dark:text-slate-300 select-all">teensy:avr</span>
                                        </div>
                                    </details>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="h-12 bg-slate-50 dark:bg-slate-900 border-t border-slate-100 dark:border-slate-800 flex items-center justify-center text-xs text-slate-400 dark:text-slate-600">
                    ck_core_manager v2.0
                </div>
            </div>
        </div>
    );
};
