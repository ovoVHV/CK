import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2, Trash2, X, Package, DownloadCloud, RefreshCw } from 'lucide-react';
import { useDialog } from '../contexts/DialogContext';
import { useTranslation } from 'react-i18next';
import { AVAILABLE_CORES, catalogFor, catalogSources, installChoice, selectedVersion, sourceKey,
    type CoreDefinition, type CoreVersions, type CatalogStates } from './coreCatalog';

interface InstalledCore {
    id: string;
    installed: string;
    name: string;
    latest: string | null;
}

interface CoreManagerModalProps {
    isOpen: boolean;
    onClose: () => void;
    onInstall: (coreId: string, version: string, indexUrl?: string) => Promise<void>;
    onUninstall: (coreId: string) => Promise<void>;
}

export const CoreManagerModal = ({ isOpen, onClose, onInstall, onUninstall }: CoreManagerModalProps) => {
    const { t: translate } = useTranslation('libraries');
    const t = translate as unknown as (key: string, options?: Record<string, unknown>) => string;
    const [activeTab, setActiveTab] = useState<'installed' | 'available'>('available'); // Default to available as requested
    const [cores, setCores] = useState<InstalledCore[]>([]);
    const [loading, setLoading] = useState(true);
    const { alert } = useDialog();
    const [processing, setProcessing] = useState<string | null>(null); // Installing or Uninstalling ID
    const [customUrls, setCustomUrls] = useState<Record<string, string>>({});
    const [selectedVersions, setSelectedVersions] = useState<Record<string, string>>({});
    const [customVersionInputs, setCustomVersionInputs] = useState<Record<string, string>>({});
    const [manualCoreInput, setManualCoreInput] = useState({ id: '', version: '', url: '' });
    const [catalogs, setCatalogs] = useState<CatalogStates>({});
    const requestIds = useRef<Record<string, number>>({});
    const active = useRef(false);

    const refreshCatalog = (onlyCore?: CoreDefinition) => {
        for (const core of onlyCore ? [onlyCore] : AVAILABLE_CORES) {
            for (const indexUrl of catalogSources(core, customUrls[core.id])) {
                const key = sourceKey(core.id, indexUrl);
                const requestId = (requestIds.current[key] || 0) + 1;
                requestIds.current[key] = requestId;
                setCatalogs(prev => ({ ...prev, [key]: { ...prev[key], loading: true, error: undefined } }));
                // Each source resolves independently, so a slow mirror cannot hide the official list.
                void invoke<CoreVersions>('get_core_versions', { coreId: core.id, indexUrl }).then(data => {
                    if (active.current && requestIds.current[key] === requestId) {
                        setCatalogs(prev => ({ ...prev, [key]: { data, loading: false } }));
                    }
                }).catch(error => {
                    if (active.current && requestIds.current[key] === requestId) {
                        setCatalogs(prev => ({ ...prev, [key]: { ...prev[key], loading: false, error: String(error) } }));
                    }
                });
            }
        }
    };

    useEffect(() => {
        active.current = isOpen;
        if (!isOpen) return;
        const timer = window.setTimeout(() => refreshCatalog(), 350);
        return () => {
            active.current = false;
            window.clearTimeout(timer);
            for (const key of Object.keys(requestIds.current)) requestIds.current[key]++;
        };
    }, [isOpen, customUrls]);

    const handleManualInstall = async () => {
        if (!manualCoreInput.id) {
            alert({ title: t('core.error.inputTitle'), message: t('core.error.coreIdRequired'), type: "warning" });
            return;
        }
        setProcessing('manual');
        try {
            await onInstall(manualCoreInput.id, manualCoreInput.version, manualCoreInput.url);
            await loadCores();
            setManualCoreInput({ id: '', version: '', url: '' });
        } catch (e) {
            console.error("Manual install failed:", e);
            alert({ title: t('core.error.installTitle'), message: String(e), type: "error" });
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
            alert({ title: t('core.error.loadTitle'), message: t('core.error.loadMessage', { error: String(e) }), type: "error" });
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

    const handleInstall = async (core: CoreDefinition) => {
        setProcessing(core.id);
        try {
            const catalog = catalogFor(core, catalogs, customUrls[core.id]);
            const selected = selectedVersion(selectedVersions[core.id], catalog);
            if (!selected || (selected === 'custom' && !customVersionInputs[core.id]?.trim())) {
                throw new Error(t('core.error.versionRequired'));
            }
            const choice = installChoice(core, catalog, selected, customVersionInputs[core.id] || '', customUrls[core.id]);
            await onInstall(core.id, choice.version, choice.indexUrl);
            await loadCores();
        } catch (e) {
            console.error("Install failed in modal:", e);
            alert({ title: t('core.error.installTitle'), message: String(e), type: "error" });
        } finally {
            setProcessing(null);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-in fade-in">
            <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-xl w-full max-w-[700px] h-[min(600px,calc(100vh-2rem))] max-h-[calc(100vh-2rem)] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200 border border-slate-200 dark:border-slate-800">
                {/* Header */}
                <div className="h-16 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between px-6 flex-shrink-0 bg-white dark:bg-slate-900 z-10">
                    <div className="flex min-w-0 items-center gap-4">
                        <div className="p-2 bg-brand-50 dark:bg-brand-900/30 rounded-lg text-brand-600 dark:text-brand-400">
                            <Package size={24} />
                        </div>
                        <div className="min-w-0">
                            <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">{t('core.title')}</h2>
                            <p className="text-xs text-slate-500 dark:text-slate-400">{t('core.subtitle')}</p>
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
                        className={`py-3 text-sm font-bold border-b-2 transition-colors ${activeTab === 'available' ? 'border-brand-500 text-brand-600 dark:text-brand-400' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
                    >
                        {t('core.available')}
                    </button>
                    <button
                        onClick={() => setActiveTab('installed')}
                        className={`py-3 text-sm font-bold border-b-2 transition-colors ${activeTab === 'installed' ? 'border-brand-500 text-brand-600 dark:text-brand-400' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
                    >
                        {t('core.installedCount', { count: cores.length })}
                    </button>
                    <button onClick={() => { void loadCores(); refreshCatalog(); }} disabled={!!processing}
                        className="ml-auto flex items-center gap-1 text-xs text-brand-600 dark:text-brand-400 disabled:opacity-50">
                        <RefreshCw size={14} className={AVAILABLE_CORES.some(core => catalogSources(core, customUrls[core.id]).some(url => catalogs[sourceKey(core.id, url)]?.loading)) ? 'animate-spin' : ''} />
                        {t('core.catalog.refresh')}
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-6 bg-slate-50 dark:bg-slate-950">
                    {loading ? (
                        <div className="flex flex-col items-center justify-center h-full text-slate-400 dark:text-slate-500">
                            <Loader2 className="animate-spin mb-3" size={32} />
                            <p>{t('core.loading')}</p>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {activeTab === 'installed' ? (
                                cores.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center py-20 text-slate-400 dark:text-slate-500">
                                        <div className="text-4xl mb-4">📦</div>
                                        <p>{t('core.noInstalled')}</p>
                                        <button onClick={() => setActiveTab('available')} className="mt-4 text-brand-600 dark:text-brand-400 hover:underline text-sm font-medium">
                                            {t('core.goDownload')}
                                        </button>
                                    </div>
                                ) : (
                                    cores.map(core => (
                                        <div key={core.id} className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-wrap items-center justify-between gap-3 group">
                                            <div className="min-w-0 flex-1">
                                                <h3 className="break-words font-bold text-slate-800 dark:text-slate-100 text-sm">{core.name}</h3>
                                                <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-400 mt-1">
                                                    <span className="max-w-full break-all bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded text-slate-600 dark:text-slate-300 font-mono">{core.id}</span>
                                                    <span className="text-brand-600 dark:text-brand-400 font-medium">v{core.installed}</span>
                                                </div>
                                            </div>

                                            <button
                                                type="button"
                                                onClick={() => handleUninstall(core)}
                                                disabled={processing === core.id}
                                                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-red-200 dark:hover:border-red-900/60 hover:bg-red-50 dark:hover:bg-red-900/30 hover:text-red-600 dark:hover:text-red-400 disabled:cursor-wait disabled:opacity-60 transition-colors"
                                                title={t('core.uninstallNamed', { name: core.name })}
                                                aria-label={t('core.uninstallNamed', { name: core.name })}
                                            >
                                                {processing === core.id ? <Loader2 className="animate-spin" size={18} /> : <Trash2 size={18} />}
                                                <span className="whitespace-nowrap">{processing === core.id ? t('core.uninstalling') : t('core.uninstall')}</span>
                                            </button>
                                        </div>
                                    ))
                                )
                            ) : (
                                // Available Cores List
                                AVAILABLE_CORES.map(core => {
                                    const isInstalled = cores.some(c => c.id === core.id);
                                    const catalog = catalogFor(core, catalogs, customUrls[core.id]);
                                    const selectedVer = selectedVersion(selectedVersions[core.id], catalog);
                                    const effectiveIndexUrl = customUrls[core.id] ??
                                        (selectedVer.endsWith('-cn') && core.mirrorIndexUrl ? core.mirrorIndexUrl : core.index_url);

                                    return (
                                        <div key={core.id} data-core-id={core.id} className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm transition-colors group hover:border-brand-200 dark:hover:border-brand-700">
                                            <div className="flex items-center justify-between mb-2">
                                                <div>
                                                    <h3 className="font-bold text-slate-800 dark:text-slate-100 text-sm flex items-center gap-2">
                                                        {core.name}
                                                        {isInstalled && <span className="bg-brand-50 dark:bg-brand-900/30 text-brand-600 dark:text-brand-400 text-[10px] px-1.5 py-0.5 rounded border border-brand-100 dark:border-brand-800">{t('core.installed')}</span>}
                                                    </h3>
                                                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{t(core.descriptionKey)}</p>
                                                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                                                        {core.accelerationVersions ? t('core.catalog.accelerationHint') : t('core.catalog.compatibilityHint')}
                                                    </p>
                                                </div>
                                            </div>

                                            {/* Version Selection & Install */}
                                            <div className="flex flex-col gap-2 mt-3">
                                                <div className="flex items-center gap-3">
                                                    <select
                                                        value={selectedVer}
                                                        aria-label={t('core.catalog.selectVersion', { name: core.name })}
                                                        disabled={!!processing}
                                                        onChange={(e) => setSelectedVersions(prev => ({ ...prev, [core.id]: e.target.value }))}
                                                        className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs rounded px-2 py-1.5 focus:outline-none focus:border-brand-500 text-slate-700 dark:text-slate-200 font-mono"
                                                    >
                                                        {!selectedVer && <option value="" disabled>{t('core.catalog.selectPlaceholder')}</option>}
                                                        {catalog.entries.map(({ version: v }) => (
                                                            <option key={v} value={v}>
                                                                v{v}{v === core.recommendedVersion
                                                                    ? t(core.accelerationVersions?.includes(v) ? 'core.catalog.defaultAcceleration' : 'core.recommendedSuffix')
                                                                    : core.accelerationVersions?.includes(v) ? t('core.catalog.accelerated') : ''}
                                                                {v === catalog.latest ? t('core.catalog.latestSuffix') : ''}
                                                            </option>
                                                        ))}
                                                        <option value="custom">{t('core.customVersion')}</option>
                                                    </select>

                                                    <button
                                                        onClick={() => handleInstall(core)}
                                                        disabled={!!processing || !selectedVer || (selectedVer === 'custom' && !customVersionInputs[core.id]?.trim())}
                                                        className={`
                                                        px-4 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-2
                                                        ${isInstalled
                                                                ? 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                                                                : 'bg-slate-800 dark:bg-slate-700 text-white hover:bg-brand-600 dark:hover:bg-brand-600 hover:shadow-brand-500/20 shadow-sm'}
                                                    `}
                                                    >
                                                        {processing === core.id ? <Loader2 className="animate-spin" size={14} /> : <DownloadCloud size={14} />}
                                                        <span>{isInstalled ? t('core.reinstall') : t('core.download')}</span>
                                                    </button>
                                                </div>

                                                {/* Custom Version Input */}
                                                {selectedVer === 'custom' && (
                                                    <input
                                                        type="text"
                                                        value={customVersionInputs[core.id] || ''}
                                                        onChange={(e) => setCustomVersionInputs(prev => ({ ...prev, [core.id]: e.target.value }))}
                                                        placeholder={t('core.versionExample')}
                                                        className="w-40 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-900/50 rounded px-2 py-1 text-xs text-slate-700 dark:text-yellow-100 focus:outline-none focus:border-yellow-400 font-mono animate-in slide-in-from-top-1"
                                                    />
                                                )}
                                                {catalog.sources.map(url => {
                                                    const status = catalogs[sourceKey(core.id, url)];
                                                    return <p key={url} title={url} className={`text-xs break-words ${status?.error ? 'text-amber-700 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400'}`}>
                                                        {url === core.mirrorIndexUrl ? t('core.catalog.mirror') : t('core.catalog.source')}{'：'}
                                                        {status?.loading ? t('core.catalog.loading')
                                                            : status?.error ? t(status.data ? 'core.catalog.stale' : 'core.catalog.failed', { error: status.error })
                                                            : status?.data ? t('core.catalog.loaded', { count: status.data.versions.length,
                                                                version: status.data.latest || '—', time: new Date(status.data.checked_at * 1000).toLocaleTimeString() })
                                                            : t('core.catalog.loading')}
                                                    </p>;
                                                })}
                                            </div>

                                            {/* Custom URL Input - Always visible if supported */}
                                            {core.index_url && (
                                                <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800">
                                                    <label className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1.5 block">
                                                        {t('core.mirrorUrl')}
                                                    </label>
                                                    <div className="flex gap-2">
                                                        <input
                                                            type="text"
                                                            value={effectiveIndexUrl || ''}
                                                            disabled={!!processing}
                                                            onChange={(e) => setCustomUrls(prev => ({ ...prev, [core.id]: e.target.value }))}
                                                            className="flex-1 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded px-2 py-1.5 text-xs text-slate-600 dark:text-slate-300 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500/30 placeholder-slate-400 font-mono"
                                                            placeholder={t('core.customIndexPlaceholder')}
                                                        />
                                                        <button
                                                            onClick={() => refreshCatalog(core)}
                                                            disabled={!!processing}
                                                            className="bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 px-3 py-1.5 rounded text-xs font-bold transition-colors flex items-center gap-2"
                                                            title={t('core.index.updateSource')}
                                                        >
                                                            <RefreshCw size={14} className={catalog.sources.some(url => catalogs[sourceKey(core.id, url)]?.loading) ? 'animate-spin' : ''} />
                                                            {t('core.catalog.refresh')}
                                                        </button>
                                                        {customUrls[core.id] !== undefined && <button disabled={!!processing}
                                                            onClick={() => setCustomUrls(prev => { const next = { ...prev }; delete next[core.id]; return next; })}
                                                            className="text-xs text-brand-600 dark:text-brand-400">{t('core.catalog.resetSource')}</button>}
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
                                            {t('core.manual.title')}
                                        </h3>
                                        <span className="text-[10px] text-slate-400 dark:text-slate-500 bg-slate-200 dark:bg-slate-700 px-2 py-0.5 rounded-full">{t('core.manual.advanced')}</span>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="col-span-1 flex flex-col">
                                            <input
                                                placeholder={t('core.manual.coreIdPlaceholder')}
                                                className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 text-xs font-mono focus:outline-none focus:border-brand-500 w-full text-slate-800 dark:text-slate-200"
                                                value={manualCoreInput.id}
                                                onChange={e => setManualCoreInput(prev => ({ ...prev, id: e.target.value }))}
                                            />
                                            <span className="text-[10px] text-slate-400 mt-0.5 ml-1">{t('core.manual.idFormat')}</span>
                                        </div>
                                        <input
                                            placeholder={t('core.manual.versionPlaceholder')}
                                            className="col-span-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 text-xs font-mono focus:outline-none focus:border-brand-500 text-slate-800 dark:text-slate-200"
                                            value={manualCoreInput.version}
                                            onChange={e => setManualCoreInput(prev => ({ ...prev, version: e.target.value }))}
                                        />
                                        <input
                                            placeholder={t('core.manual.urlPlaceholder')}
                                            className="col-span-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 text-xs font-mono focus:outline-none focus:border-brand-500 text-slate-800 dark:text-slate-200"
                                            value={manualCoreInput.url}
                                            onChange={e => setManualCoreInput(prev => ({ ...prev, url: e.target.value }))}
                                        />
                                    </div>
                                    <div className="flex justify-end">
                                        <button
                                            onClick={handleManualInstall}
                                            disabled={!!processing}
                                            className="bg-slate-800 dark:bg-slate-700 text-white hover:bg-brand-600 dark:hover:bg-brand-600 px-4 py-1.5 rounded-lg text-xs font-bold transition-colors flex items-center gap-2 shadow-sm"
                                        >
                                            {processing === 'manual' ? <Loader2 className="animate-spin" size={14} /> : <DownloadCloud size={14} />}
                                            {t('core.manual.install')}
                                        </button>
                                        <button
                                            onClick={async () => {
                                                const url = manualCoreInput.url?.trim();

                                                if (!url) {
                                                    alert({ title: t('core.error.invalidUrlTitle'), message: t('core.error.invalidUrlMessage'), type: "warning" });
                                                    return;
                                                }

                                                setProcessing('index');
                                                try {
                                                    alert({ title: t('core.index.startTitle'), message: t('core.index.updatingBackground'), type: "info" });
                                                    await invoke('update_package_index', { indexUrl: url });
                                                    alert({ title: t('core.index.successTitle'), message: t('core.index.successMessage'), type: "success" });
                                                } catch (e) {
                                                    alert({ title: t('core.index.failedTitle'), message: String(e), type: "error" });
                                                } finally {
                                                    setProcessing(null);
                                                }
                                            }}
                                            disabled={!!processing}
                                            className="ml-2 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600 px-4 py-1.5 rounded-lg text-xs font-bold transition-colors flex items-center gap-2 shadow-sm border border-slate-300 dark:border-slate-600"
                                            title={t('core.manual.indexOnlyHint')}
                                        >
                                            {processing === 'index' ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}
                                            {t('core.manual.indexOnly')}
                                        </button>
                                    </div>

                                    {/* Common Examples Quick Reference */}
                                    <details className="text-[10px] text-slate-500 dark:text-slate-400 cursor-pointer select-none group">
                                        <summary className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors list-none flex items-center gap-1 font-bold">
                                            <span className="group-open:rotate-90 transition-transform">▸</span>
                                            {t('core.manual.reference')}
                                        </summary>
                                        <div className="mt-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded p-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono select-text cursor-auto">
                                            <div className="flex justify-between border-b border-slate-100 dark:border-slate-800 pb-1 mb-1 col-span-2 font-bold text-slate-400">
                                                <span>{t('core.manual.commonBoards')}</span>
                                                <span>{t('core.manual.coreId')}</span>
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
                    {t('core.catalog.footer')}
                </div>
            </div>
        </div>
    );
};
