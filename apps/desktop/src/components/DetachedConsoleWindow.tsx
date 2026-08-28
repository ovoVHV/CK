import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Activity, Cpu, ExternalLink, Monitor, Pause, Play, Send, Terminal, Trash2, Type, X } from 'lucide-react';
import { SerialMonitor, SerialTerminalRef } from './SerialMonitor';
import { SerialPlotter } from './SerialPlotter';

type DetachedConsoleProps = {
    theme: 'light' | 'dark' | 'system';
};

type SerialPortInfo = {
    port_name: string;
    description?: string;
    hardware_id?: string;
};

const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 500000, 921600, 1000000, 2000000];
const MAX_LOG_LINES = 2000;
const MAX_VISIBLE_COMPILE_LINES = 300;
const CONSOLE_FONT_SIZE = 14;

const readPersistedCompileLog = (): string[] => {
    try {
        const raw = localStorage.getItem('ck_console_compile_log');
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.map((line) => String(line));
    } catch {
        return [];
    }
};

export default function DetachedConsoleWindow({ theme }: DetachedConsoleProps) {
    const query = useMemo(() => new URLSearchParams(window.location.search), []);
    const initialPort = query.get('port') || '';
    const initialBaud = Number(query.get('baud') || 115200);
    const initialOpen = query.get('open') === '1';

    const serialMonitorRef = useRef<SerialTerminalRef>(null);
    const monitorStateRef = useRef<string>('closed');
    const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingCompileLinesRef = useRef<string[]>([]);
    const compileLogContainerRef = useRef<HTMLDivElement | null>(null);
    const stickCompileBottomRef = useRef(true);

    const [ports, setPorts] = useState<SerialPortInfo[]>([]);
    const [selectedPort, setSelectedPort] = useState(initialPort);
    const [isSerialMonitorOpen, setIsSerialMonitorOpen] = useState(initialOpen);
    const [baudRate, setBaudRate] = useState(Number.isFinite(initialBaud) ? initialBaud : 115200);
    const [consoleTab, setConsoleTab] = useState<'serial' | 'compile'>('serial');
    const [compileLog, setCompileLog] = useState<string[]>(() => readPersistedCompileLog());
    const [serialInput, setSerialInput] = useState('');
    const [lineEnding, setLineEnding] = useState('\r\n');
    const [viewMode, setViewMode] = useState<'text' | 'hex'>('text');
    const [consoleViewMode, setConsoleViewMode] = useState<'text' | 'plot'>('text');
    const [isHexSend, setIsHexSend] = useState(false);
    const [showTimestamp, setShowTimestamp] = useState(false);
    const [isPaused, setIsPaused] = useState(false);
    const [hint, setHint] = useState('');

    const notify = (message: string) => {
        setHint(message);
        if (hintTimerRef.current) {
            clearTimeout(hintTimerRef.current);
        }
        hintTimerRef.current = setTimeout(() => setHint(''), 2500);
    };

    const scanPorts = async () => {
        try {
            const list = await invoke<SerialPortInfo[]>('list_serial_ports');
            setPorts(list);
        } catch (e) {
            console.warn('[DetachedConsole] list_serial_ports failed', e);
        }
    };

    useEffect(() => {
        void scanPorts();
        const timer = setInterval(() => {
            if (!document.hidden) {
                void scanPorts();
            }
        }, 8000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        if (!selectedPort) {
            if (ports.length > 0) {
                setSelectedPort(ports[0].port_name);
            }
            return;
        }
        const found = ports.some((p) => p.port_name === selectedPort);
        if (!found && ports.length > 0) {
            setSelectedPort(ports[0].port_name);
        }
    }, [ports, selectedPort]);

    useEffect(() => {
        const timer = setTimeout(() => {
            try {
                const tail = compileLog.length > MAX_VISIBLE_COMPILE_LINES
                    ? compileLog.slice(-MAX_VISIBLE_COMPILE_LINES)
                    : compileLog;
                localStorage.setItem('ck_console_compile_log', JSON.stringify(tail));
            } catch {
                // ignore
            }
        }, 1200);
        return () => clearTimeout(timer);
    }, [compileLog]);

    useEffect(() => {
        let unlistenBuildLog: (() => void) | undefined;
        let unlistenConfig: (() => void) | undefined;
        let alive = true;

        const setup = async () => {
            try {
                const stopBuildLog = await listen<string>('build-log', (event) => {
                    const chunk = String(event.payload ?? '');
                    if (!chunk) return;
                    const incoming = chunk.split('\n').slice(-MAX_LOG_LINES);
                    const pending = pendingCompileLinesRef.current;
                    pending.push(...incoming);
                    if (pending.length > MAX_LOG_LINES) {
                        pending.splice(0, pending.length - MAX_LOG_LINES);
                    }
                });
                if (!alive) {
                    stopBuildLog();
                    return;
                }
                unlistenBuildLog = stopBuildLog;

                const stopConfig = await listen<any>('ck-console-config', (event) => {
                    const payload = event.payload || {};
                    if (typeof payload.port === 'string') {
                        setSelectedPort(payload.port);
                    }
                    const nextBaud = Number(payload.baud);
                    if (Number.isFinite(nextBaud)) {
                        setBaudRate(nextBaud);
                    }
                    if (typeof payload.open === 'boolean') {
                        setIsSerialMonitorOpen(payload.open);
                    }
                });
                if (!alive) {
                    stopConfig();
                    return;
                }
                unlistenConfig = stopConfig;
            } catch (e) {
                if (alive) {
                    console.error('[DetachedConsole] Failed to setup listeners', e);
                }
            }
        };

        void setup();

        return () => {
            alive = false;
            unlistenBuildLog?.();
            unlistenConfig?.();
            unlistenBuildLog = undefined;
            unlistenConfig = undefined;
            pendingCompileLinesRef.current = [];
        };
    }, []);

    useEffect(() => {
        const timer = setInterval(() => {
            if (pendingCompileLinesRef.current.length === 0) return;
            const incoming = pendingCompileLinesRef.current.splice(0, pendingCompileLinesRef.current.length);
            setCompileLog((prev) => {
                const next = [...prev, ...incoming];
                return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
            });
        }, 120);

        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        if (consoleTab !== 'compile') return;
        if (!stickCompileBottomRef.current) return;
        const container = compileLogContainerRef.current;
        if (!container) return;
        requestAnimationFrame(() => {
            container.scrollTop = container.scrollHeight;
        });
    }, [compileLog.length, consoleTab]);

    useEffect(() => {
        return () => {
            if (hintTimerRef.current) {
                clearTimeout(hintTimerRef.current);
            }
        };
    }, []);

    useEffect(() => {
        let canceled = false;
        const syncMonitor = async () => {
            try {
                if (!isSerialMonitorOpen) {
                    if (monitorStateRef.current !== 'closed') {
                        await invoke('close_serial_monitor');
                        monitorStateRef.current = 'closed';
                    }
                    return;
                }

                if (!selectedPort) {
                    setIsSerialMonitorOpen(false);
                    return;
                }

                const next = `${selectedPort}@${baudRate}`;
                if (monitorStateRef.current === next) {
                    return;
                }

                await invoke('close_serial_monitor').catch(() => undefined);
                if (canceled) return;
                await invoke('open_serial_monitor', { port: selectedPort, baud: baudRate });
                monitorStateRef.current = next;
            } catch (e) {
                console.error('[DetachedConsole] sync monitor failed', e);
                if (!canceled) {
                    setIsSerialMonitorOpen(false);
                    monitorStateRef.current = 'closed';
                    notify('串口打开失败');
                }
            }
        };
        void syncMonitor();
        return () => {
            canceled = true;
        };
    }, [baudRate, isSerialMonitorOpen, selectedPort]);

    useEffect(() => {
        return () => {
            void invoke('close_serial_monitor').catch(() => undefined);
        };
    }, []);

    const toggleSerialMonitor = () => {
        if (!selectedPort && !isSerialMonitorOpen) {
            notify('请先选择串口');
            return;
        }
        setIsSerialMonitorOpen((prev) => !prev);
        notify(isSerialMonitorOpen ? '串口已关闭' : '串口已打开');
    };

    const handleSendSerial = async () => {
        if (!selectedPort) {
            notify('请先连接串口');
            return;
        }
        if (!isSerialMonitorOpen) {
            notify('请先打开串口');
            return;
        }
        if (!serialInput) return;

        let payload: number[] = [];
        if (isHexSend) {
            if (viewMode !== 'hex') {
                setViewMode('hex');
            }
            const clean = serialInput.replace(/[^0-9A-Fa-f]/g, '');
            if (clean.length % 2 !== 0) {
                notify('Hex 长度必须是偶数');
                return;
            }
            for (let i = 0; i < clean.length; i += 2) {
                payload.push(parseInt(clean.substring(i, i + 2), 16));
            }
        } else {
            if (viewMode !== 'text') {
                setViewMode('text');
            }
            payload = Array.from(new TextEncoder().encode(serialInput + lineEnding));
        }

        try {
            await invoke('send_serial_data', { data: payload });
            setSerialInput('');
        } catch (e) {
            console.error('[DetachedConsole] send serial failed', e);
            notify('发送失败');
        }
    };

    const handleBackToMain = async () => {
        try {
            await invoke('close_serial_monitor').catch(() => undefined);
            await getCurrentWindow().close();
        } catch (e) {
            console.error('[DetachedConsole] close window failed', e);
        }
    };

    return (
        <div className="h-screen w-screen bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 overflow-hidden flex flex-col">
            <div className="min-h-10 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 shrink-0 flex flex-wrap items-center justify-between px-3 py-1 gap-2">
                <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300 min-w-0">
                    <ExternalLink size={14} />
                    <span className="text-xs font-bold uppercase tracking-wide whitespace-nowrap">独立控制台</span>
                    <span className="text-[11px] text-slate-500 whitespace-nowrap hidden sm:inline">{selectedPort ? `端口: ${selectedPort}` : '端口未选择'}</span>
                </div>
                <div className="flex items-center gap-2 whitespace-nowrap flex-wrap justify-end">
                    <button
                        onClick={toggleSerialMonitor}
                        className={"h-7 px-2 rounded text-xs font-bold transition-colors " + (isSerialMonitorOpen ? "bg-teal-100 text-teal-700" : "bg-slate-100 text-slate-600 hover:bg-slate-200")}
                    >
                        <span className="inline-flex items-center gap-1">
                            <Monitor size={12} />
                            <span className="hidden sm:inline">{isSerialMonitorOpen ? '关闭串口' : '打开串口'}</span>
                            <span className="sm:hidden">{isSerialMonitorOpen ? '关闭' : '打开'}</span>
                        </span>
                    </button>
                    <button
                        onClick={handleBackToMain}
                        className="h-7 px-2 rounded text-xs font-bold bg-indigo-100 text-indigo-700 hover:bg-indigo-200 transition-colors"
                        title="关闭此窗口并回到主窗口"
                    >
                        回到主窗口
                    </button>
                    <button
                        onClick={handleBackToMain}
                        className="h-7 w-7 rounded text-slate-500 hover:text-slate-800 hover:bg-slate-200 transition-colors"
                        title="关闭"
                    >
                        <X size={14} className="mx-auto" />
                    </button>
                </div>
            </div>

            <div className="min-h-10 bg-slate-50 dark:bg-slate-800 flex flex-wrap items-center px-3 py-1 select-none border-b border-slate-200 dark:border-slate-700 shrink-0 gap-2">
                <div className="flex items-center space-x-0.5 text-slate-500 dark:text-slate-400 h-8 shrink-0 whitespace-nowrap">
                    <div
                        onClick={() => setConsoleTab('serial')}
                        className={"flex items-center space-x-2 px-3 h-full cursor-pointer transition-all border-b-2 " + (consoleTab === 'serial' ? 'border-teal-500 text-teal-600 dark:text-teal-400 bg-teal-50/50 dark:bg-teal-900/20' : 'border-transparent hover:bg-slate-100 dark:hover:bg-slate-700')}
                    >
                        <Terminal size={14} />
                        <span className="text-xs font-bold uppercase tracking-wider whitespace-nowrap hidden sm:inline">串口监视器</span>
                        <span className="text-xs font-bold uppercase tracking-wider whitespace-nowrap sm:hidden">串口</span>
                    </div>

                    <div
                        onClick={() => setConsoleTab('compile')}
                        className={"flex items-center space-x-2 px-3 h-full cursor-pointer transition-all border-b-2 " + (consoleTab === 'compile' ? 'border-blue-500 text-blue-600 dark:text-blue-400 bg-blue-50/50 dark:bg-blue-900/20' : 'border-transparent hover:bg-slate-100 dark:hover:bg-slate-700')}
                    >
                        <Cpu size={14} />
                        <span className="text-xs font-bold uppercase tracking-wider whitespace-nowrap hidden sm:inline">输出日志</span>
                        <span className="text-xs font-bold uppercase tracking-wider whitespace-nowrap sm:hidden">日志</span>
                    </div>
                </div>

                <div className="flex items-center gap-2 shrink-0 whitespace-nowrap flex-wrap ml-auto">
                    {ports.length > 0 && (
                        <select
                            className="h-7 text-xs bg-transparent border border-slate-200 dark:border-slate-700 rounded px-1 py-0.5"
                            value={selectedPort}
                            onChange={(e) => setSelectedPort(e.target.value)}
                        >
                            {ports.map((port) => (
                                <option key={port.port_name} value={port.port_name}>
                                    {port.port_name}
                                </option>
                            ))}
                        </select>
                    )}

                    <div className="flex items-center space-x-1 hover:text-teal-600 dark:hover:text-teal-400 transition-colors whitespace-nowrap">
                        <span className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400 whitespace-nowrap">波特率:</span>
                        <select
                            className="h-7 text-xs text-slate-600 dark:text-slate-300 border-none outline-none cursor-pointer font-mono py-0 focus:ring-0 bg-transparent"
                            value={baudRate}
                            onChange={(e) => setBaudRate(Number(e.target.value))}
                        >
                            {BAUD_RATES.map((rate) => (
                                <option key={rate} value={rate} className="text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-800">
                                    {rate}
                                </option>
                            ))}
                        </select>
                    </div>

                    <label className="flex items-center space-x-1 cursor-pointer whitespace-nowrap">
                        <input
                            type="checkbox"
                            checked={viewMode === 'hex'}
                            onChange={(e) => setViewMode(e.target.checked ? 'hex' : 'text')}
                            className="w-3 h-3 rounded border-slate-400 bg-transparent text-teal-600 focus:ring-0"
                        />
                        <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 whitespace-nowrap">16进制模式</span>
                    </label>

                    <label className="flex items-center space-x-1 cursor-pointer whitespace-nowrap">
                        <input
                            type="checkbox"
                            checked={showTimestamp}
                            onChange={(e) => setShowTimestamp(e.target.checked)}
                            className="w-3 h-3 rounded border-slate-400 bg-transparent text-teal-600 focus:ring-0"
                        />
                        <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 whitespace-nowrap">时间戳</span>
                    </label>

                    <div className="flex items-center bg-slate-100 dark:bg-slate-700 rounded p-0.5 h-7">
                        <button
                            onClick={() => setConsoleViewMode('text')}
                            className={"px-2 h-full rounded text-[10px] font-bold flex items-center gap-1 transition-all " + (consoleViewMode === 'text' ? 'bg-white dark:bg-slate-600 text-teal-600 shadow-sm' : 'text-slate-400 hover:text-slate-600')}
                        >
                            <Type size={12} />
                            文本
                        </button>
                        <button
                            onClick={() => setConsoleViewMode('plot')}
                            className={"px-2 h-full rounded text-[10px] font-bold flex items-center gap-1 transition-all " + (consoleViewMode === 'plot' ? 'bg-white dark:bg-slate-600 text-teal-600 shadow-sm' : 'text-slate-400 hover:text-slate-600')}
                        >
                            <Activity size={12} />
                            数据
                        </button>
                    </div>

                    <button
                        onClick={() => setIsPaused(!isPaused)}
                        className={"p-1.5 rounded transition-colors " + (isPaused ? 'text-amber-600 bg-amber-50 border border-amber-100' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-200')}
                        title={isPaused ? "继续滚动" : "暂停滚动"}
                    >
                        {isPaused ? <Play size={14} className="fill-current" /> : <Pause size={14} className="fill-current" />}
                    </button>

                    <button
                        onClick={() => serialMonitorRef.current?.clear()}
                        className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                        title="清空日志"
                    >
                        <Trash2 size={14} />
                    </button>

                </div>
            </div>

            {hint && (
                <div className="h-7 shrink-0 px-3 flex items-center bg-blue-50 dark:bg-blue-900/20 border-b border-blue-100 dark:border-blue-900 text-xs text-blue-700 dark:text-blue-300">
                    {hint}
                </div>
            )}

            <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-slate-900">
                {consoleTab === 'serial' ? (
                    <div className="relative w-full h-full">
                        {consoleViewMode === 'text' ? (
                            <div className="absolute inset-0 z-10 bg-white dark:bg-slate-900">
                                <SerialMonitor
                                    ref={serialMonitorRef}
                                    viewMode={viewMode}
                                    paused={isPaused}
                                    showTimestamp={showTimestamp}
                                    theme={theme}
                                    fontSize={CONSOLE_FONT_SIZE}
                                    scrollback={8000}
                                    bufferCap={120000}
                                />
                            </div>
                        ) : (
                            <div className="absolute inset-0 z-10 bg-white dark:bg-slate-900">
                                <SerialPlotter
                                    paused={isPaused}
                                    fontSize={CONSOLE_FONT_SIZE}
                                    port={selectedPort}
                                    baudRate={baudRate}
                                />
                            </div>
                        )}
                    </div>
                ) : (
                    <div
                        ref={compileLogContainerRef}
                        onScroll={(event) => {
                            const target = event.currentTarget;
                            const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
                            stickCompileBottomRef.current = distanceFromBottom < 48;
                        }}
                        className="h-full overflow-auto p-2 font-mono whitespace-pre-wrap text-xs"
                        style={{ fontSize: CONSOLE_FONT_SIZE }}
                    >
                        {compileLog.length > 0 ? (
                            (() => {
                                let inSummary = false;
                                    const visibleLines = compileLog.length > MAX_VISIBLE_COMPILE_LINES
                                        ? compileLog.slice(-MAX_VISIBLE_COMPILE_LINES)
                                        : compileLog;
                                const offset = compileLog.length - visibleLines.length;
                                return visibleLines.map((line, index) => {
                                    const lower = line.toLowerCase();
                                    let colorClass = "text-slate-600 dark:text-slate-400";
                                    const isInfo = line.startsWith("[INFO]");
                                    const isTiming = line.startsWith("[Timing]");

                                    if (line.includes("Using library") || line.includes("Using platform") || line.includes("Using board") || line.includes("Using core") ||
                                        line.includes("Used library") || line.includes("Used platform")) {
                                        inSummary = true;
                                    }
                                    if (inSummary && line.trim() === "") {
                                        inSummary = false;
                                    }

                                    if (lower.includes(": error") || lower.startsWith("error:") || lower.includes("fatal error") || lower.includes("failed with error")) {
                                        colorClass = "text-red-600 dark:text-red-400 font-bold";
                                    } else if (lower.includes(": warning") || lower.startsWith("warning:")) {
                                        colorClass = "text-amber-600 dark:text-amber-400";
                                    } else if (inSummary) {
                                        colorClass = "text-purple-600 dark:text-purple-400 font-bold";
                                    } else if (isTiming) {
                                        colorClass = "text-slate-500 dark:text-slate-400";
                                    } else if (isInfo && (line.includes("Firmware Artifacts") || line.includes("Artifact:"))) {
                                        colorClass = "text-orange-600 dark:text-orange-400 font-semibold";
                                    } else if (isInfo && (line.includes("Arduino installed library paths used") || line.includes("Arduino Library Path:") || line.includes("Arduino Include Match:"))) {
                                        colorClass = "text-emerald-600 dark:text-emerald-400 font-semibold";
                                    } else if (isInfo && (line.includes("Include Header:") || line.includes("Sketch include headers"))) {
                                        colorClass = "text-cyan-700 dark:text-cyan-400";
                                    } else if (isInfo && (line.includes("CK resolved custom libraries") || line.includes("CK Library Path:") || line.includes("Include Match:"))) {
                                        colorClass = "text-violet-700 dark:text-violet-400";
                                    } else if (isInfo && line.includes("did not emit dependency summary")) {
                                        colorClass = "text-amber-700 dark:text-amber-400 font-semibold";
                                    } else if (isInfo && line.includes("Build Directory:")) {
                                        colorClass = "text-indigo-700 dark:text-indigo-400";
                                    } else if (line.startsWith("Sketch uses") || line.startsWith("Global variables use")) {
                                        colorClass = "text-cyan-700 dark:text-cyan-400 font-semibold";
                                    } else if (lower.includes("success") || lower.includes("complete") || lower.includes("done")) {
                                        colorClass = "text-teal-600 dark:text-teal-400 font-bold";
                                    } else if (lower.includes("info") || lower.includes("downloading") || lower.startsWith("compiling sketch...") || lower.startsWith("compiling libraries...")) {
                                        colorClass = "text-blue-600 dark:text-blue-400";
                                    } else if (line.startsWith("[LibShim]")) {
                                        colorClass = "text-purple-600 dark:text-purple-400 font-bold";
                                    }

                                    const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, '');
                                    return (
                                        <div key={offset + index} className={`${colorClass} min-h-[1.2em]`}>
                                            {cleanLine}
                                        </div>
                                    );
                                });
                            })()
                        ) : (
                            <span className="text-slate-400 dark:text-slate-600 italic">暂无输出日志...</span>
                        )}
                    </div>
                )}
            </div>

            {consoleTab === 'serial' && (
                <div className="bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 shrink-0 z-10 flex items-center h-8">
                    <input
                        type="text"
                        value={serialInput}
                        onChange={(e) => setSerialInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && void handleSendSerial()}
                        disabled={!isSerialMonitorOpen}
                        placeholder={isSerialMonitorOpen ? (isHexSend ? "发送 Hex (如 AA BB)" : "发送数据...") : "串口已关闭"}
                        className="flex-1 bg-transparent border-none text-slate-700 dark:text-slate-200 text-xs px-3 focus:ring-0 outline-none disabled:opacity-30 placeholder:text-slate-400 dark:placeholder:text-slate-600 h-full font-mono"
                    />

                    <div className="flex items-center space-x-1 px-2 border-l border-slate-100 dark:border-slate-800 h-4/5 my-auto">
                        <span
                            className={"text-[10px] font-bold cursor-pointer select-none " + (isHexSend ? "text-teal-600" : "text-slate-400")}
                            onClick={() => {
                                const next = !isHexSend;
                                setIsHexSend(next);
                                if (next) setViewMode('hex');
                            }}
                        >
                            HEX
                        </span>
                    </div>

                    <div className="h-full border-l border-r border-slate-200 dark:border-slate-800 flex items-center px-1 hover:bg-slate-50 dark:hover:bg-slate-800 relative min-w-[60px]">
                        <select
                            className="w-full bg-transparent text-[10px] font-bold text-slate-500 dark:text-slate-400 outline-none cursor-pointer hover:text-teal-600 dark:hover:text-teal-400 transition-colors uppercase appearance-none text-center relative z-10 pl-2 pr-4 h-full"
                            value={lineEnding}
                            onChange={(e) => setLineEnding(e.target.value)}
                            title="行尾符"
                        >
                            <option value="" className="bg-white dark:bg-slate-800">无</option>
                            <option value={'\n'} className="bg-white dark:bg-slate-800">换行 (LF)</option>
                            <option value={'\r'} className="bg-white dark:bg-slate-800">回车 (CR)</option>
                            <option value={'\r\n'} className="bg-white dark:bg-slate-800">回车换行</option>
                        </select>
                        <span className="text-slate-400 text-[8px] absolute right-1 pointer-events-none top-1/2 -translate-y-1/2">▼</span>
                    </div>

                    <button
                        onClick={() => void handleSendSerial()}
                        disabled={!isSerialMonitorOpen || !serialInput.trim()}
                        className="h-full w-12 flex items-center justify-center bg-teal-600 hover:bg-teal-500 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        title="发送数据"
                    >
                        <Send size={14} />
                    </button>
                </div>
            )}
        </div>
    );
}

