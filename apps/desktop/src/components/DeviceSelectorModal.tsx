import { useEffect } from 'react';
import { X, Usb, RefreshCw, CheckCircle, AlertCircle } from 'lucide-react';
import { useHardware } from '../contexts/HardwareContext';

interface DeviceSelectorModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export default function DeviceSelectorModal({ isOpen, onClose }: DeviceSelectorModalProps) {
    const { ports, activePort, connectDevice, disconnectDevice, scanPorts, isScanning } = useHardware();

    // Auto-scan when opened
    useEffect(() => {
        if (isOpen) scanPorts();
    }, [isOpen]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 animate-in fade-in duration-200">
            <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden border border-slate-100 dark:border-slate-800 scale-100 animate-in zoom-in-95 duration-200">

                {/* Header */}
                <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-800/50">
                    <div>
                        <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">连接设备</h2>
                        <p className="text-xs text-slate-500 dark:text-slate-400">选择要连接的硬件设备</p>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-full transition-colors text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
                        <X size={20} />
                    </button>
                </div>

                {/* Body */}
                <div className="p-6">
                    {/* Status Banner */}
                    {activePort ? (
                        <div className="mb-6 p-3 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-900/50 rounded-xl flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div className="w-8 h-8 bg-emerald-100 dark:bg-emerald-900/50 rounded-full flex items-center justify-center text-emerald-600 dark:text-emerald-400">
                                    <CheckCircle size={18} />
                                </div>
                                <div>
                                    <div className="text-sm font-bold text-emerald-800 dark:text-emerald-400">已连接</div>
                                    <div className="text-xs text-emerald-600 dark:text-emerald-500 font-mono">{activePort}</div>
                                </div>
                            </div>
                            <button
                                onClick={disconnectDevice}
                                className="px-3 py-1.5 bg-white dark:bg-slate-800 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 text-xs font-bold rounded-lg hover:bg-emerald-50 dark:hover:bg-emerald-900/30 transition-colors"
                            >
                                断开
                            </button>
                        </div>
                    ) : (
                        <div className="mb-6 p-3 bg-slate-50 dark:bg-slate-800 border border-slate-100 dark:border-slate-700 rounded-xl flex items-center gap-3 text-slate-500 dark:text-slate-400">
                            <AlertCircle size={18} />
                            <span className="text-sm">未连接任何设备</span>
                        </div>
                    )}

                    {/* Port List */}
                    <div className="space-y-3">
                        <div className="flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
                            <span>可用端口 ({ports.length})</span>
                            <button
                                onClick={() => scanPorts()}
                                disabled={isScanning}
                                className={`flex items-center gap-1 hover:text-teal-600 dark:hover:text-teal-400 transition-colors ${isScanning ? 'animate-pulse' : ''}`}
                            >
                                <RefreshCw size={12} className={isScanning ? 'animate-spin' : ''} />
                                <span>刷新</span>
                            </button>
                        </div>

                        <div className="max-h-60 overflow-y-auto space-y-2 custom-scrollbar">
                            {ports.length === 0 ? (
                                <div className="text-center py-8 text-slate-400 dark:text-slate-500 border-2 border-dashed border-slate-100 dark:border-slate-700 rounded-xl">
                                    <Usb size={32} className="mx-auto mb-2 opacity-50" />
                                    <p className="text-sm">未检测到设备</p>
                                    <p className="text-xs opacity-75 mt-1">请插入 USB 线并点击刷新</p>
                                </div>
                            ) : (
                                ports.map(port => (
                                    <div
                                        key={port.port_name}
                                        onClick={() => connectDevice(port.port_name)}
                                        className={`
                                            group flex items-center justify-between p-3 rounded-xl border cursor-pointer transition-all
                                            ${activePort === port.port_name
                                                ? 'bg-teal-50 dark:bg-teal-900/20 border-teal-200 dark:border-teal-800 ring-1 ring-teal-500/20'
                                                : 'bg-white dark:bg-slate-800 border-slate-100 dark:border-slate-700 hover:border-teal-200 dark:hover:border-teal-700 hover:shadow-sm'}
                                        `}
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className={`
                                                w-8 h-8 rounded-lg flex items-center justify-center transition-colors
                                                ${activePort === port.port_name ? 'bg-teal-100 dark:bg-teal-900/50 text-teal-600 dark:text-teal-400' : 'bg-slate-100 dark:bg-slate-700 text-slate-400 dark:text-slate-500 group-hover:bg-teal-50 dark:group-hover:bg-teal-900/30 group-hover:text-teal-500'}
                                            `}>
                                                <Usb size={16} />
                                            </div>
                                            <div>
                                                <div className={`text-sm font-bold ${activePort === port.port_name ? 'text-teal-900 dark:text-teal-400' : 'text-slate-700 dark:text-slate-200'}`}>
                                                    {port.port_name}
                                                </div>
                                                <div className="text-xs text-slate-400 dark:text-slate-500 truncate max-w-[150px]">
                                                    {port.description || 'USB 串口设备'}
                                                </div>
                                            </div>
                                        </div>
                                        {activePort === port.port_name && (
                                            <div className="w-2 h-2 bg-teal-500 rounded-full shadow-[0_0_8px_rgba(20,184,166,0.5)]"></div>
                                        )}
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
