import { useEffect, useRef, useState } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Activity, Cpu, ExternalLink, Monitor, Pause, Play, Send, Terminal, Trash2, Type, X } from 'lucide-react';
import { SerialMonitor, SerialTerminalRef } from './SerialMonitor';
import { SerialPlotter } from './SerialPlotter';
import { useTranslation } from 'react-i18next';
import { CompileLogActions } from './CompileLogActions';

type DetachedConsoleProps = {
    theme: 'light' | 'dark' | 'system';
};

type SerialPortInfo = {
    port_name: string;
    description?: string;
    hardware_id?: string;
};

type DetachedConsoleStatePayload = {
    feedbackRunId?: string | null;
    compiling?: boolean;
    open: boolean;
    switching: boolean;
    selectedPort: string;
    monitorPort: string;
    baud: number;
    ports: SerialPortInfo[];
    error?: string;
};

type DetachedConsoleCommand = {
    action: 'ready' | 'open' | 'close' | 'set-settings' | 'send' | 'dock';
    port?: string;
    baud?: number;
    data?: number[];
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
    const { t } = useTranslation('serial');
    const serialMonitorRef = useRef<SerialTerminalRef>(null);
    const dockingRef = useRef(false);
    const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingCompileLinesRef = useRef<string[]>([]);
    const compileLogContainerRef = useRef<HTMLDivElement | null>(null);
    const stickCompileBottomRef = useRef(true);

    const [ports, setPorts] = useState<SerialPortInfo[]>([]);
    const [selectedPort, setSelectedPort] = useState('');
    const [isSerialMonitorOpen, setIsSerialMonitorOpen] = useState(false);
    const [isSerialMonitorSwitching, setIsSerialMonitorSwitching] = useState(true);
    const [baudRate, setBaudRate] = useState(115200);
    const [consoleTab, setConsoleTab] = useState<'serial' | 'compile'>('serial');
    const [compileLog, setCompileLog] = useState<string[]>(() => readPersistedCompileLog());
    const [feedbackRunId, setFeedbackRunId] = useState<string | null>(null);
    const [compiling, setCompiling] = useState(false);
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

                const stopConfig = await listen<DetachedConsoleStatePayload>('ck-console-state', (event) => {
                    const payload = event.payload;
                    setFeedbackRunId(payload.feedbackRunId ?? null);
                    setCompiling(payload.compiling === true);
                    setPorts(Array.isArray(payload.ports) ? payload.ports : []);
                    const nextPort = String(payload.monitorPort || payload.selectedPort || '').trim();
                    if (nextPort) setSelectedPort(nextPort);
                    const nextBaud = Number(payload.baud);
                    if (Number.isFinite(nextBaud) && nextBaud > 0) setBaudRate(nextBaud);
                    setIsSerialMonitorOpen(payload.open === true);
                    setIsSerialMonitorSwitching(payload.switching === true);
                    if (payload.error) notify(payload.error);
                });
                if (!alive) {
                    stopConfig();
                    return;
                }
                unlistenConfig = stopConfig;
                await emitTo<DetachedConsoleCommand>('main', 'ck-console-command', { action: 'ready' });
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

    const sendCommand = async (command: DetachedConsoleCommand) => {
        await emitTo<DetachedConsoleCommand>('main', 'ck-console-command', command);
    };

    const toggleSerialMonitor = async () => {
        if (!selectedPort && !isSerialMonitorOpen) {
            notify(t('errors.selectPort'));
            return;
        }
        setIsSerialMonitorSwitching(true);
        await sendCommand({
            action: isSerialMonitorOpen ? 'close' : 'open',
            port: selectedPort,
            baud: baudRate,
        }).catch(error => {
            setIsSerialMonitorSwitching(false);
            console.error('[DetachedConsole] serial toggle request failed', error);
            notify(t('errors.operationRequest'));
        });
    };

    const applySerialSettings = async (port: string, baud: number) => {
        setSelectedPort(port);
        setBaudRate(baud);
        setIsSerialMonitorSwitching(true);
        await sendCommand({
            action: 'set-settings',
            port,
            baud,
        }).catch(error => {
            setIsSerialMonitorSwitching(false);
            console.error('[DetachedConsole] serial settings request failed', error);
            notify(t('errors.settingsRequest'));
        });
    };

    const handleSendSerial = async () => {
        if (!selectedPort) {
            notify(t('errors.connectFirst'));
            return;
        }
        if (!isSerialMonitorOpen) {
            notify(t('errors.openFirst'));
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
                notify(t('errors.hexEven'));
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
            await sendCommand({ action: 'send', data: payload });
            setSerialInput('');
        } catch (e) {
            console.error('[DetachedConsole] send serial failed', e);
            notify(t('errors.sendFailed'));
        }
    };

    const handleBackToMain = async () => {
        if (dockingRef.current) return;
        dockingRef.current = true;
        try {
            await sendCommand({ action: 'dock' });
            await getCurrentWindow().destroy();
        } catch (e) {
            console.error('[DetachedConsole] close window failed', e);
            dockingRef.current = false;
        }
    };

    useEffect(() => {
        let unlisten: (() => void) | undefined;
        let alive = true;
        void getCurrentWindow().onCloseRequested(event => {
            event.preventDefault();
            void handleBackToMain();
        }).then(stop => {
            if (!alive) stop();
            else unlisten = stop;
        });
        return () => {
            alive = false;
            unlisten?.();
        };
    // `handleBackToMain` intentionally uses refs and current state only for a one-shot dock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div className="ck-detached-console-root h-screen w-screen bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 overflow-hidden flex flex-col">
            <div className="ck-serial-console-titlebar min-h-10 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 shrink-0 flex flex-wrap items-center justify-between px-3 py-1 gap-2">
                <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300 min-w-0">
                    <ExternalLink size={14} />
                    <span className="text-xs font-bold uppercase tracking-wide whitespace-nowrap">{t('window.detached')}</span>
                    <span className="text-[11px] text-slate-500 whitespace-nowrap hidden sm:inline">{selectedPort ? t('monitor.portValue', { port: selectedPort }) : t('monitor.noPort')}</span>
                </div>
                <div className="flex items-center gap-2 whitespace-nowrap flex-wrap justify-end">
                    <button
                        onClick={handleBackToMain}
                        className="h-7 px-2 rounded text-xs font-bold bg-indigo-100 text-indigo-700 hover:bg-indigo-200 transition-colors"
                        title={t('window.returnHint')}
                    >
                        {t('window.returnToMain')}
                    </button>
                    <button
                        onClick={handleBackToMain}
                        className="h-7 w-7 rounded text-slate-500 hover:text-slate-800 hover:bg-slate-200 transition-colors"
                        title={t('window.closeHint')}
                    >
                        <X size={14} className="mx-auto" />
                    </button>
                </div>
            </div>

            <div className="ck-serial-console-toolbar min-h-10 bg-slate-50 dark:bg-slate-800 flex flex-wrap items-center px-3 py-1 select-none border-b border-slate-200 dark:border-slate-700 shrink-0 gap-2">
                <div className="flex items-center space-x-0.5 text-slate-500 dark:text-slate-400 h-8 shrink-0 whitespace-nowrap">
                    <div
                        onClick={() => setConsoleTab('serial')}
                        className={"ck-serial-console-tab flex items-center space-x-2 px-3 h-full cursor-pointer transition-all border-b-2 " + (consoleTab === 'serial' ? 'is-active border-brand-500 text-brand-600 dark:text-brand-400 bg-brand-50/50 dark:bg-brand-900/20' : 'border-transparent hover:bg-slate-100 dark:hover:bg-slate-700')}
                    >
                        <Terminal size={14} />
                        <span className="text-xs font-bold uppercase tracking-wider whitespace-nowrap hidden sm:inline">{t('monitor.title')}</span>
                        <span className="text-xs font-bold uppercase tracking-wider whitespace-nowrap sm:hidden">{t('monitor.shortTitle')}</span>
                    </div>

                    <div
                        onClick={() => setConsoleTab('compile')}
                        className={"ck-serial-console-tab ck-serial-console-tab-compile flex items-center space-x-2 px-3 h-full cursor-pointer transition-all border-b-2 " + (consoleTab === 'compile' ? 'is-active border-blue-500 text-blue-600 dark:text-blue-400 bg-blue-50/50 dark:bg-blue-900/20' : 'border-transparent hover:bg-slate-100 dark:hover:bg-slate-700')}
                    >
                        <Cpu size={14} />
                        <span className="text-xs font-bold uppercase tracking-wider whitespace-nowrap hidden sm:inline">{t('monitor.buildLog')}</span>
                        <span className="text-xs font-bold uppercase tracking-wider whitespace-nowrap sm:hidden">{t('monitor.logShort')}</span>
                    </div>
                </div>

                <div className="flex items-center gap-2 shrink-0 whitespace-nowrap flex-wrap ml-auto">
                    {ports.length > 0 && (
                        <select
                            className="ck-serial-control-select h-7 text-xs bg-transparent border border-slate-200 dark:border-slate-700 rounded px-1 py-0.5"
                            value={selectedPort}
                            disabled={isSerialMonitorSwitching}
                            onChange={(e) => void applySerialSettings(e.target.value, baudRate)}
                        >
                            {ports.map((port) => (
                                <option key={port.port_name} value={port.port_name}>
                                    {port.port_name}
                                </option>
                            ))}
                        </select>
                    )}

                    <div className="flex items-center space-x-1 hover:text-brand-600 dark:hover:text-brand-400 transition-colors whitespace-nowrap">
                        <span className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400 whitespace-nowrap">{t('monitor.baud')}:</span>
                        <select
                            className="ck-serial-control-select h-7 text-xs text-slate-600 dark:text-slate-300 border-none outline-none cursor-pointer font-mono py-0 focus:ring-0 bg-transparent"
                            value={baudRate}
                            disabled={isSerialMonitorSwitching}
                            onChange={(e) => void applySerialSettings(selectedPort, Number(e.target.value))}
                        >
                            {BAUD_RATES.map((rate) => (
                                <option key={rate} value={rate} className="text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-800">
                                    {rate}
                                </option>
                            ))}
                        </select>
                    </div>

                    <button
                        type="button"
                        onClick={() => void toggleSerialMonitor()}
                        disabled={isSerialMonitorSwitching}
                        className={"ck-serial-monitor-toggle h-7 px-2 inline-flex items-center justify-center gap-1 rounded border text-[10px] font-bold transition-colors disabled:opacity-50 disabled:cursor-wait " + (isSerialMonitorOpen
                            ? "border-red-200 bg-red-50 text-red-600 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/35 dark:text-red-300"
                            : "border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100 dark:border-brand-900 dark:bg-brand-950/40 dark:text-brand-300")}
                        title={isSerialMonitorSwitching ? t('monitor.waiting') : isSerialMonitorOpen ? t('monitor.closeReal') : t('monitor.openCurrent')}
                        data-ck-action="toggle-serial-monitor-near-endpoint"
                    >
                        <Monitor size={12} />
                        <span>{isSerialMonitorSwitching ? t('monitor.processing') : isSerialMonitorOpen ? t('monitor.close') : t('monitor.open')}</span>
                    </button>

                    <label className="flex items-center space-x-1 cursor-pointer whitespace-nowrap">
                        <input
                            type="checkbox"
                            checked={viewMode === 'hex'}
                            onChange={(e) => setViewMode(e.target.checked ? 'hex' : 'text')}
                            className="w-3 h-3 rounded border-slate-400 bg-transparent text-brand-600 focus:ring-0"
                        />
                        <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 whitespace-nowrap">{t('mode.hexMode')}</span>
                    </label>

                    <label className="flex items-center space-x-1 cursor-pointer whitespace-nowrap">
                        <input
                            type="checkbox"
                            checked={showTimestamp}
                            onChange={(e) => setShowTimestamp(e.target.checked)}
                            className="w-3 h-3 rounded border-slate-400 bg-transparent text-brand-600 focus:ring-0"
                        />
                        <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 whitespace-nowrap">{t('mode.timestamp')}</span>
                    </label>

                    <div className="ck-serial-view-switch flex items-center bg-slate-100 dark:bg-slate-700 rounded p-0.5 h-7">
                        <button
                            onClick={() => setConsoleViewMode('text')}
                            className={"ck-serial-view-button px-2 h-full rounded text-[10px] font-bold flex items-center gap-1 transition-all " + (consoleViewMode === 'text' ? 'is-active bg-white dark:bg-slate-600 text-brand-600 shadow-sm' : 'text-slate-400 hover:text-slate-600')}
                        >
                            <Type size={12} />
                            {t('mode.text')}
                        </button>
                        <button
                            onClick={() => setConsoleViewMode('plot')}
                            className={"ck-serial-view-button px-2 h-full rounded text-[10px] font-bold flex items-center gap-1 transition-all " + (consoleViewMode === 'plot' ? 'is-active bg-white dark:bg-slate-600 text-brand-600 shadow-sm' : 'text-slate-400 hover:text-slate-600')}
                        >
                            <Activity size={12} />
                            {t('mode.data')}
                        </button>
                    </div>

                    <button
                        onClick={() => setIsPaused(!isPaused)}
                        className={"ck-serial-icon-button p-1.5 rounded transition-colors " + (isPaused ? 'is-active text-amber-600 bg-amber-50 border border-amber-100' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-200')}
                        title={isPaused ? t('monitor.resumeScroll') : t('monitor.pauseScroll')}
                    >
                        {isPaused ? <Play size={14} className="fill-current" /> : <Pause size={14} className="fill-current" />}
                    </button>

                    <button
                        onClick={() => serialMonitorRef.current?.clear()}
                        className="ck-serial-icon-button ck-serial-clear-button p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                        title={t('monitor.clearLog')}
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

            {consoleTab === 'compile' && <CompileLogActions runId={feedbackRunId} busy={compiling} getLog={() => [...compileLog, ...pendingCompileLinesRef.current].join('\n')} />}
            <div className="ck-serial-console-content flex-1 flex flex-col overflow-hidden bg-white dark:bg-slate-900">
                {consoleTab === 'serial' ? (
                    <div className="relative w-full h-full">
                        {consoleViewMode === 'text' ? (
                            <div className="ck-serial-console-surface absolute inset-0 z-10 bg-white dark:bg-slate-900">
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
                            <div className="ck-serial-console-surface absolute inset-0 z-10 bg-white dark:bg-slate-900">
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
                        className="ck-serial-compile-log h-full overflow-auto p-2 font-mono whitespace-pre-wrap text-xs"
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
                                        colorClass = "text-brand-600 dark:text-brand-400 font-bold";
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
                            <span className="text-slate-400 dark:text-slate-600 italic">{t('monitor.noBuildLog')}</span>
                        )}
                    </div>
                )}
            </div>

            {consoleTab === 'serial' && (
                    <div className="ck-serial-input-bar bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 shrink-0 z-10 flex items-center h-8">
                    <input
                        type="text"
                        value={serialInput}
                        onChange={(e) => setSerialInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && void handleSendSerial()}
                        disabled={!isSerialMonitorOpen}
                        placeholder={isSerialMonitorOpen ? (isHexSend ? t('monitor.sendHexPlaceholder') : t('monitor.sendPlaceholder')) : t('monitor.closedPlaceholder')}
                        className="ck-serial-input flex-1 bg-transparent border-none text-slate-700 dark:text-slate-200 text-xs px-3 focus:ring-0 outline-none disabled:opacity-30 placeholder:text-slate-400 dark:placeholder:text-slate-600 h-full font-mono"
                    />

                    <div className="flex items-center space-x-1 px-2 border-l border-slate-100 dark:border-slate-800 h-4/5 my-auto">
                        <span
                            className={"text-[10px] font-bold cursor-pointer select-none " + (isHexSend ? "text-brand-600 dark:text-brand-300" : "text-slate-400")}
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
                            className="w-full bg-transparent text-[10px] font-bold text-slate-500 dark:text-slate-400 outline-none cursor-pointer hover:text-brand-600 dark:hover:text-brand-400 transition-colors uppercase appearance-none text-center relative z-10 pl-2 pr-4 h-full"
                            value={lineEnding}
                            onChange={(e) => setLineEnding(e.target.value)}
                            title={t('mode.lineEnding')}
                        >
                            <option value="" className="bg-white dark:bg-slate-800">{t('lineEnding.none')}</option>
                            <option value={'\n'} className="bg-white dark:bg-slate-800">{t('lineEnding.lf')}</option>
                            <option value={'\r'} className="bg-white dark:bg-slate-800">{t('lineEnding.cr')}</option>
                            <option value={'\r\n'} className="bg-white dark:bg-slate-800">{t('lineEnding.crlf')}</option>
                        </select>
                        <span className="text-slate-400 text-[8px] absolute right-1 pointer-events-none top-1/2 -translate-y-1/2">▼</span>
                    </div>

                    <button
                        onClick={() => void handleSendSerial()}
                        disabled={!isSerialMonitorOpen || !serialInput.trim()}
                        className="h-full w-12 flex items-center justify-center bg-brand-600 hover:bg-brand-500 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        title={t('monitor.send')}
                    >
                        <Send size={14} />
                    </button>
                </div>
            )}
        </div>
    );
}

