```
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { StatusFooter } from './StatusFooter';
import {
    CheckCircle,
    Check,
    Loader2,
    Settings,
    Code,
    Terminal,
    X,
    Upload,
    Usb,
    XCircle,
    ArrowLeft,
    RefreshCw,
    Monitor,
    Ban,
    Save,
    Trash2,
    FolderOpen, FilePlus, Send, Cpu, Play, Pause, Type, Activity
} from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { invoke } from '@tauri-apps/api/core';
import { save, open, ask } from '@tauri-apps/plugin-dialog'; // Native Dialogs
import * as Blockly from 'blockly';
import 'blockly/blocks';
import { getToolbox, THEME, setBlocklyBoard, registerDetailedBoard } from './blockly_setup';
import arduinoGenerator from './arduino_generator';
import { useHardware } from '../contexts/HardwareContext';
import BoardConfigModal from './BoardConfigModal';
import { SerialMonitor, SerialTerminalRef } from './SerialMonitor'; // Import new component
import { SerialPlotter } from './SerialPlotter';
import { BOARDS } from '../constants/boards';

// Toast 组件
const Toast = ({ message, type, show, onClose }: any) => {
    if (!show) return null;

    let icon = <CheckCircle size={20} className="text-green-500" />;
    let bgColor = "bg-white";
    let textColor = "text-slate-800";
    let borderColor = "border-slate-200";

    if (type === 'loading') {
        icon = <Loader2 size={20} className="text-blue-500 animate-spin" />;
    } else if (type === 'error') {
        icon = <XCircle size={20} className="text-red-500" />;
        borderColor = "border-red-100";
    }

    return (
        <div className={"fixed top-20 left-1/2 transform -translate-x-1/2 z-50 flex items-center space-x-3 px-4 py-3 rounded-lg shadow-xl border " + borderColor + " " + bgColor + " " + textColor + " animate-in fade-in slide-in-from-top-4 duration-300"}>
            {icon}
            <span className="text-sm font-medium">{message}</span>
            {type !== 'loading' && (
                <button onClick={onClose} className="ml-4 text-slate-400 hover:text-slate-600">
                    <X size={16} />
                </button>
            )}
        </div>
    );
};

interface WorkspaceProps {
    projectPath: string; // Initial path
    onBack: () => void;
    forceBoard?: string;
    zoomLevel?: number;
    onZoomChange?: (level: number) => void;
}

// Local SerialPortInfo interface removed, using global context

// SerialLogRow component removed as we use xterm.js now

export default function Workspace({ projectPath, onBack, forceBoard, zoomLevel, onZoomChange }: WorkspaceProps) {
    const [currentPath, setCurrentPath] = useState(projectPath); // Track path internally for Save As
    const [reloadTrigger, setReloadTrigger] = useState(0); // Force reload if opening same file
    const [consoleOpen, setConsoleOpen] = useState(true);
    const [codeViewOpen, setCodeViewOpen] = useState(true);
    const [isPortMenuOpen, setIsPortMenuOpen] = useState(false);

    // Backend / Hardware State
    // Backend / Hardware State
    const { ports, activePort, connectDevice, scanPorts, activeBoard, setActiveBoard, boardOptions, setBoardOptions, availableBoards } = useHardware();
    const [isCompiling, setIsCompiling] = useState(false);

    // Board Definition - Use DYNAMIC AVAILABLE BOARDS
    const BOARDS_LIST = availableBoards.length > 0
        ? availableBoards.map(b => ({ name: b.name, fqbn: b.fqbn || b.id }))
        : BOARDS.map(b => ({ name: b.name, fqbn: b.id }));

    // Serial Settings
    const [baudRate, setBaudRate] = useState(115200);
    const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 500000, 921600, 1000000, 2000000];

    // Serial Monitor State
    const [isSerialMonitorOpen, setIsSerialMonitorOpen] = useState(false);
    const [serialInput, setSerialInput] = useState('');
    const [lineEnding, setLineEnding] = useState(''); // '' | '\n' | '\r' | '\r\n'
    const [viewMode, setViewMode] = useState<'text' | 'hex'>('text');

    // Console State
    // Console Split: 'serial' | 'compile'
    const [consoleTab, setConsoleTab] = useState<'serial' | 'compile'>('serial');
    const [compileLog, setCompileLog] = useState<string>("");

    // New Serial Monitor Ref
    const serialMonitorRef = useRef<SerialTerminalRef>(null);

    // Stats Refs & State
    const bytesReceivedRef = useRef(0);
    const linesReceivedRef = useRef(0);
    // const [monitorStats, setMonitorStats] = useState({ kbps: 0, lps: 0 }); // Moved to StatusFooter

    const [consoleHeight, setConsoleHeight] = useState(200);
    const [isResizing, setIsResizing] = useState(false);
    const [isPaused, setIsPaused] = useState(false);
    const [showTimestamp, setShowTimestamp] = useState(false);
    const [consoleViewMode, setConsoleViewMode] = useState<'text' | 'plot'>('text');
    const logEndRef = useRef<HTMLDivElement>(null);

    // Helper for Board Name
    const getBoardName = () => {
        if (!activeBoard) return 'No Board Selected';
        const b = availableBoards.find(b => b.fqbn === activeBoard || b.id === activeBoard) || BOARDS.find(b => b.id === activeBoard);
        if (b) return b.name;
        const parts = activeBoard.split(':');
        return parts[parts.length - 1].split('=')[1] || parts[parts.length - 1];
    };

    // Auto-scroll for Compile Log
    useEffect(() => {
        if (logEndRef.current) {
            logEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [compileLog]);

    // Resize Blockly on layout change/resize
    useEffect(() => {
        if (workspaceRef.current) {
            // Delay slightly for CSS transition
            const timer = setTimeout(() => {
                Blockly.svgResize(workspaceRef.current as Blockly.WorkspaceSvg);
            }, 350);
            return () => clearTimeout(timer);
        }
    }, [consoleHeight, consoleOpen, isResizing, codeViewOpen]);

    // Cleanup Serial Monitor on Unmount/Exit
    useEffect(() => {
        return () => {
            // Force close serial monitor when leaving the workspace
            invoke('close_serial_monitor').catch(e => console.error("Failed to close serial on unmount", e));
        };
    }, []);

    // Dynamic Baud Rate Switching
    useEffect(() => {
        if (isSerialMonitorOpen && activePort) {
            const switchBaud = async () => {
                try {
                    // @ts-ignore
                    const { invoke } = await import('@tauri-apps/api/core');
                    await invoke('close_serial_monitor');
                    await new Promise(r => setTimeout(r, 100)); // Brief pause
                    await invoke('open_serial_monitor', { port: activePort, baud: baudRate });

                    // Clear frontend buffers
                    serialMonitorRef.current?.clear();
                    serialMonitorRef.current?.write("\r\n[System] Switched baud rate to " + baudRate + "\r\n");
                } catch (e) {
                    console.error("Failed to switch baud rate", e);
                }
            };
            switchBaud();
        }
    }, [baudRate]);

    // Board Config Modal
    const [isConfigOpen, setIsConfigOpen] = useState(false);


    const [toast, setToast] = useState<{ show: boolean, message: string, type: 'info' | 'loading' | 'success' | 'error' }>({ show: false, message: '', type: 'info' });

    const showToast = (message: string, type: 'info' | 'loading' | 'success' | 'error' = 'info') => {
        setToast({ show: true, message, type });
        if (type !== 'loading') {
            setTimeout(() => setToast(prev => ({ ...prev, show: false })), 3000);
        }
    };

    // Serial Monitor & Build Progress Event Listener
    useEffect(() => {
        let unlistenSerial: (() => void) | undefined;
        let unlistenBuild: (() => void) | undefined;
        let unlistenLog: (() => void) | undefined;
        let isActive = true;

        const setupListeners = async () => {
            try {
                // @ts-ignore
                const { listen } = await import('@tauri-apps/api/event');

                if (!isActive) return;

                // Serial Data (Stats Only)
                const uSerial = await listen('serial-data', (event: any) => {
                    const payload = event.payload;
                    let len = 0;
                    let lines = 0;

                    if (typeof payload === 'string') {
                        len = payload.length;
                        for (let i = 0; i < len; i++) {
                            if (payload[i] === '\n') lines++;
                        }
                    } else if (Array.isArray(payload)) {
                        len = payload.length;
                        for (let i = 0; i < len; i++) {
                            if (payload[i] === 10) lines++;
                        }
                    }

                    bytesReceivedRef.current += len;
                    linesReceivedRef.current += lines;
                });
                if (isActive) unlistenSerial = uSerial; else uSerial();

                // Build Progress
                const uBuild = await listen('build-progress', (event: any) => {
                    const { percentage, message } = event.payload;
                    setBuildProgress(prev => ({
                        ...prev,
                        percentage: Math.max(prev.percentage, percentage),
                        message
                    }));
                });
                if (isActive) unlistenBuild = uBuild; else uBuild();

                // Build Log Streaming (Fix Leak)
                const uLog = await listen('build-log', (event: any) => {
                    const line = event.payload as string;
                    setCompileLog(prev => prev + line);
                });
                if (isActive) unlistenLog = uLog; else uLog();

            } catch (e) {
                console.error('Failed to setup event listeners', e);
            }
        };

        setupListeners();

        return () => {
            isActive = false;
            if (unlistenSerial) unlistenSerial();
            if (unlistenBuild) unlistenBuild();
            if (unlistenLog) unlistenLog();
        };
    }, []);

    // Stats Calculator Loop (Every 1s)
    // Stats logic moved to StatusFooter

    // Auto-Scroll for Compile Logs (Instant)
    // No more manual buffer flushing for Serial Monitor (handled by xterm)

    // Resizing Logic
    const startResizing = (e: React.MouseEvent) => {
        e.preventDefault();
        setIsResizing(true);
    };

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (isResizing) {
                const newHeight = window.innerHeight - e.clientY;
                // Min 100px, Max 60% of screen
                if (newHeight > 100 && newHeight < window.innerHeight * 0.6) {
                    setConsoleHeight(newHeight);
                }
            }
        };

        const handleMouseUp = () => {
            setIsResizing(false);
        };

        if (isResizing) {
            window.addEventListener('mousemove', handleMouseMove);
            window.addEventListener('mouseup', handleMouseUp);
        }

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isResizing]);


    // Load Ports (Managed globally by HardwareContext)
    // useEffect(() => { refreshPorts(); }, []); removed

    const toggleSerialMonitor = async () => {
        try {
            // @ts-ignore
            const { invoke } = await import('@tauri-apps/api/core');

            if (isSerialMonitorOpen) {
                // Close
                await invoke('close_serial_monitor');
                setIsSerialMonitorOpen(false);
                serialMonitorRef.current?.write('\r\n[System] Serial monitor closed.\r\n');
                showToast('串口已关闭', 'info');
            } else {
                // Open
                if (!activePort) {
                    showToast('请先选择端口', 'error');
                    return;
                }

                // Auto-Detect Baud Rate from Code
                let targetBaud = baudRate;
                const baudMatch = generatedCode.match(/Serial\.begin\((\d+)\);/);
                if (baudMatch && baudMatch[1]) {
                    targetBaud = parseInt(baudMatch[1]);
                    setBaudRate(targetBaud); // Update UI
                    setBaudRate(targetBaud); // Update UI
                    console.log("[AutoBaud] Detected " + targetBaud + " from code");
                }

                await invoke('open_serial_monitor', {
                    port: activePort,
                    baud: targetBaud
                });

                setIsSerialMonitorOpen(true);
                setIsSerialMonitorOpen(true);
                serialMonitorRef.current?.write("\\r\\n[System] Serial monitor opened on " + activePort + " @" + baudRate + " baud.\\r\\n");
                showToast('串口已打开', 'success');
                setConsoleOpen(true);
                setConsoleTab('serial');
            }
        } catch (e: any) {
            console.error(e);
            showToast('串口操作失败', 'error');
            serialMonitorRef.current?.write(`\r\n[Error] ${ e } \r\n`);
        }
    };

    const handleSendSerial = async () => {
        if (!serialInput.trim()) return;

        try {
            // @ts-ignore
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('send_serial_data', { data: serialInput + lineEnding });
            // const endingsMap: Record<string, string> = { '': '', '\n': '\\n', '\r': '\\r', '\r\n': '\\r\\n' };
            // Optional: Echo sent data?
            // serialMonitorRef.current?.write(`[Sent] ${ serialInput }${ endingsMap[lineEnding] } \r\n`);
            setSerialInput('');
        } catch (e: any) {
            console.error(e);
            serialMonitorRef.current?.write("\\r\\n[Error] Send failed: " + e + " \\r\\n");
        }
    };

    const handleCancel = () => {
        setIsCompiling(false);
        serialMonitorRef.current?.write('\r\n[System] Operation cancelled by user.\r\n');
        showToast('已取消', 'info');
    };

    const handleCompileAndUpload = async (isUpload: boolean) => {
        if (isCompiling) return;

        setIsCompiling(true);
        setConsoleOpen(true);
        setConsoleTab('compile'); // Auto-switch to compile tab
        setCompileLog('Initializing build environment...\n'); // Reset log
        setBuildProgress({ percentage: 2, message: 'Initializing...', mode: 'compile' });

        // Start fake progress timer
        const timer = setInterval(() => {
            setBuildProgress(prev => {
                if (prev.percentage >= 95) return prev; // Don't fake past 95%
                // Slow down as we get higher
                const increment = prev.percentage < 30 ? 2 : prev.percentage < 60 ? 0.5 : 0.1;
                return {
                    ...prev,
                    percentage: prev.percentage + increment,
                    message: prev.message
                };
            });
        }, 200);

        const startTime = performance.now();
        showToast(isUpload ? '正在上传...' : '正在编译...', 'loading');

        try {
            // @ts-ignore
            const { invoke } = await import('@tauri-apps/api/core');

            if (isUpload) {
                if (!activePort) {
                    showToast('请先选择端口', 'error');
                    setCompileLog(prev => prev + '\nError: No serial port selected.');
                    setIsCompiling(false);
                    clearInterval(timer); // Clear timer on early exit
                    return;
                }

                // Switch to Upload Mode Visuals
                setBuildProgress({ percentage: 0, message: 'Starting Upload...', mode: 'upload' });

                // Force close serial monitor if open to prevent access denied
                if (isSerialMonitorOpen) {
                    setCompileLog(prev => prev + '\nAuto-closing serial monitor for upload...');
                    try {
                        await invoke('close_serial_monitor');
                        // CRITICAL: Wait for OS to release handle
                        await new Promise(r => setTimeout(r, 400));
                    } catch (e) {
                        console.warn('Failed to close serial monitor', e);
                    }
                    setIsSerialMonitorOpen(false);
                }

                // Note: Real upload logic would pick up baud rate from context if we passed it
                // Phase 5 impl in lib.rs 'upload_sketch' only takes (code, fqbn, port).
                // It assumes defaults. We can upgrade this later.
                const log = await invoke('upload_sketch', {
                    code: generatedCode,
                    fqbn: activeBoard,
                    port: activePort
                }) as string;

                const duration = ((performance.now() - startTime) / 1000).toFixed(1);
                setCompileLog(prev => prev + "\\n > Output: \\n" + log + " ");

                if (log.includes("Success") || !log.includes("Error")) {
                    showToast("上传完成(" + duration + "s)", 'success');
                    setCompileLog(prev => prev + "\\nUpload finished successfully in " + duration + " s.");
                } else {
                    // Check specific error keywords if needed
                    // But usually if it returns Ok, check the log content
                    if (log.toLowerCase().includes("fail") || log.toLowerCase().includes("error")) {
                        showToast("上传可能有误(" + duration + "s)", 'error');
                        setCompileLog(prev => prev + "\\nUpload failed in " + duration + " s.");
                    } else {
                        showToast("上传完成(" + duration + "s)", 'success');
                        setCompileLog(prev => prev + "\\nUpload finished successfully in " + duration + " s.");
                    }
                }

            } else {
                setCompileLog(prev => prev + "\\n > FQBN: " + activeBoard + " ");

                const resultJson = await invoke('compile_sketch', {
                    code: generatedCode,
                    fqbn: activeBoard
                }) as string;

                let path = "";
                let log = "";
                try {
                    const res = JSON.parse(resultJson);
                    path = res.path;
                    log = res.log;
                } catch (e) {
                    path = resultJson; // Fallback if backend not updated
                }

                const duration = ((performance.now() - startTime) / 1000).toFixed(1);
                showToast(`编译成功(${ duration }s)`, 'success');

                // Set full log
                setCompileLog(log ? log : "Artifacts: " + path + " ");
                setCompileLog(prev => prev + "\\n\\nCompilation Successful in " + duration + " s.\\nArtifacts: " + path + " ");
            }

        } catch (e: any) {
            console.error(e);
            showToast('操作失败', 'error');
            setCompileLog(prev => prev + "\\nFailed: " + e + " ");
        } finally {
            setIsCompiling(false);
            clearInterval(timer); // Ensure timer is cleared on success or failure
            setBuildProgress({ percentage: 0, message: '', mode: 'compile' }); // Reset
        }
    };

    // Blockly Workspace Ref and State
    const blocklyDiv = useRef<HTMLDivElement>(null);
    const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
    const [generatedCode, setGeneratedCode] = useState('// Generating code...');
    const [buildProgress, setBuildProgress] = useState<{ percentage: number, message: string, mode: 'compile' | 'upload' }>({ percentage: 0, message: '', mode: 'compile' });

    // Blockly Injection
    // Blockly Injection
    useEffect(() => {
        if (!blocklyDiv.current || workspaceRef.current) return;

        console.log("[Blockly] Injecting workspace...");

        const ws = Blockly.inject(blocklyDiv.current, {
            renderer: 'zelos',
            toolbox: getToolbox(activeBoard) as any,
            theme: THEME,
            grid: {
                spacing: 20,
                length: 3,
                colour: '#e2e8f0', // Slate-200
                snap: true,
            },
            zoom: {
                controls: true,
                wheel: true,
                startScale: 1.0,
                maxScale: 3,
                minScale: 0.3,
                scaleSpeed: 1.2,
            },
            trashcan: true,
            move: {
                scrollbars: true,
                drag: true,
                wheel: false
            },
        });

        workspaceRef.current = ws;

        // Handle Resize
        const handleResize = () => {
            ws.resize();
        };
        window.addEventListener('resize', handleResize);

        // Initial Resize to fit container
        requestAnimationFrame(() => {
            handleResize();
        });

        // Listeners
        const changeListener = (e: any) => {
            // Only generate code on UI changes (move, create, delete, change)
            // Skip UI events like click/select unless they change code
            if (e.type !== Blockly.Events.UI && e.type !== Blockly.Events.VIEWPORT_CHANGE) {
                const code = arduinoGenerator.workspaceToCode(ws);
                setGeneratedCode(code);
            }
        };
        ws.addChangeListener(changeListener);

        // Initial generation
        setGeneratedCode(arduinoGenerator.workspaceToCode(ws));

        return () => {
            console.log("[Blockly] Disposing...");
            window.removeEventListener('resize', handleResize);
            ws.dispose();
            workspaceRef.current = null;
        };
    }, []);

    // Dynamic Board Update (Toolbox & Pin Config)
    useEffect(() => {
        if (!activeBoard) return;

        console.log(`[Workspace] Board switched to: ${ activeBoard } `);

        // Inject Pins for this board if available
        const currentBoardData = availableBoards.find(b => b.fqbn === activeBoard || b.id === activeBoard);
        if (currentBoardData && currentBoardData.pins) {
            registerDetailedBoard(activeBoard, currentBoardData.pins);
        }

        setBlocklyBoard(activeBoard);

        // Defer toolbox update to prevent "Focus unregistered tree" error
        // caused by immediate DOM updates during focus events.
        setTimeout(() => {
            if (workspaceRef.current) {
                // crucial: Close any open menus/dropdowns before updating toolbox
                workspaceRef.current.hideChaff();
                workspaceRef.current.updateToolbox(getToolbox(activeBoard) as any);
            }
        }, 50);
    }, [activeBoard]);

    // Load Project
    useEffect(() => {
        const load = async () => {
            // Wait for workspaceRef to be ready (up to 1s)
            for (let i = 0; i < 20; i++) {
                if (workspaceRef.current) break;
                await new Promise(r => setTimeout(r, 50));
            }

            if (workspaceRef.current && currentPath) {
                try {
                    interface ProjectData {
                        xml: string;
                        board: string;
                        name: string;
                        options?: string;
                    }

                    let data: ProjectData | null = null;

                    // Robust Tauri v2 detection
                    const isTauri = typeof window !== 'undefined' &&
                        ((window as any).__TAURI_IPC__ || (window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);

                    if (isTauri) {
                        data = await invoke('load_project', { path: currentPath }) as ProjectData;
                    } else {
                        console.log("Simulation Mode: Loading from local storage");
                        const saved = localStorage.getItem(`ck_project_${ currentPath } `);
                        data = {
                            xml: saved || '',
                            board: 'esp32:esp32:esp32c5',
                            name: currentPath.split(/[\\/]/).pop() || 'Untitled',
                            options: '{}'
                        };
                    }

                    // 1. Board Compatibility Check
                    let targetBoard = data?.board || 'arduino:avr:uno';

                    // Normalize target board FQBN from name if needed
                    const matchedBoard = BOARDS_LIST.find(b => b.fqbn === targetBoard || b.name === targetBoard);
                    if (matchedBoard) targetBoard = matchedBoard.fqbn;

                    // Board Compatibility Check & Enforce
                    // Always trust the project's board setting and switch the IDE context to match.
                    if (targetBoard !== activeBoard) {
                        console.log(`Auto - switching board from ${ activeBoard } to ${ targetBoard } `);
                        setActiveBoard(targetBoard);
                        showToast(`环境已切换为: ${ matchedBoard?.name || targetBoard } `, 'success');
                    } else if (forceBoard && forceBoard !== activeBoard) {
                        // Fallback for forceBoard if targetBoard comparison somehow missed (unlikely but safe)
                        setActiveBoard(forceBoard);
                    }

                    // 2. Import Configuration (Options)
                    if (data && data.options) {
                        try {
                            const opts = JSON.parse(data.options);
                            setBoardOptions(opts);
                        } catch (e) {
                            console.error("Failed to parse board options", e);
                        }
                    }

                    if (data && data.xml) {
                        try {
                            if (data.xml.trim().startsWith('{')) {
                                const state = JSON.parse(data.xml);
                                // @ts-ignore
                                Blockly.serialization.workspaces.load(state, workspaceRef.current);
                            } else {
                                const xmlDom = Blockly.utils.xml.textToDom(data.xml);
                                Blockly.Xml.domToWorkspace(xmlDom, workspaceRef.current);
                            }
                        } catch (e) {
                            console.error('Failed to parse project state', e);
                        }

                        showToast('加载成功', 'success');

                    } else {
                        showToast('已加载（空项目）', 'success');
                    }
                } catch (e) {
                    console.error('Failed to load project', e);
                    showToast('加载项目失败', 'error');
                }
            }
        };
        load();
    }, [currentPath, reloadTrigger]);




    // Depend on currentPath and trigger to allow switching/reloading projects
    // Wait, the previous effect runs once on mount. workspaceRef.current is set then.
    // But this effect might run before workspaceRef is set if I don't depend on it?
    // workspaceRef is a check, but it doesn't trigger re-render.
    // Actually, I should probably put this logic inside the injection effect or use a state for 'isBlocklyReady'.

    // Better:
    // The injection effect sets `workspaceRef.current`.
    // I can modify the injection effect to calling `load()` right after injection.

    // Let's rewrite this block to use a ref-callback or just merge into the injection effect?
    // Merging is safer.

    const handleSave = useCallback(async () => {
        if (!workspaceRef.current) return;

        try {
            showToast('正在保存...', 'loading');
            // @ts-ignore
            const state = Blockly.serialization.workspaces.save(workspaceRef.current);
            const json = JSON.stringify(state);
            const code = arduinoGenerator.workspaceToCode(workspaceRef.current);

            // Robust Tauri v2 detection
            const isTauri = typeof window !== 'undefined' &&
                ((window as any).__TAURI_IPC__ || (window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);

            if (isTauri) {
                // If it's a managed project (folder), use standard save
                // If it's a single file (.maker/.ck), use save_project_as overwrite or similar logic?
                // Actually save_project in backend writes workspace.xml/ino to the path.
                // If currentPath is a file path (ending in .maker), save_project might fail if it expects a dir?
                // Let's check backend: save_project takes path. if path exists?
                // backend save_project: PathBuf::from(path). if !exists err. join("workspace.xml").
                // If path is "D:/foo.maker", join("workspace.xml") -> "D:/foo.maker/workspace.xml" -> FAIL.

                // So we need to distinguish based on extension
                if (currentPath.endsWith('.maker') || currentPath.endsWith('.ck')) {
                    // Update the file
                    await invoke('save_project_as', {
                        targetPath: currentPath,
                        xml: json,
                        code: code,
                        board: activeBoard,
                        options: JSON.stringify(boardOptions)
                    });
                } else {
                    // Managed folder (Legacy) - Just update XML/INO code
                    // We don't support options here fully unless we update project.json
                    // For now, assume legacy behavior is preserved
                    await invoke('save_project', {
                        path: currentPath,
                        blocklyXml: json,
                        code: code,
                        options: JSON.stringify(boardOptions) // Pass it anyway, backend handles it
                    });
                }

                showToast('保存成功', 'success');
            } else {
                console.log("Simulation Mode: Saved project to memory", { path: currentPath, json });
                localStorage.setItem(`ck_project_${ currentPath } `, json);
                showToast('保存成功 (仿真模式)', 'success');
            }
        } catch (e) {
            console.error(e);
            showToast('保存失败', 'error');
        }
    }, [workspaceRef, currentPath, activeBoard, boardOptions]);

    // Keyboard Shortcuts
    useEffect(() => {
        const handleKeyDown = async (e: KeyboardEvent) => {
            // Save: Ctrl + S
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                await handleSave();
            }

            // Undo: Ctrl + Z
            if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                if (workspaceRef.current) {
                    workspaceRef.current.undo(false); // false = undo
                }
            }

            // Redo: Ctrl + Y OR Ctrl + Shift + Z
            if (((e.ctrlKey || e.metaKey) && e.key === 'y') ||
                ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.shiftKey)) {
                e.preventDefault();
                if (workspaceRef.current) {
                    workspaceRef.current.undo(true); // true = redo
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleSave]);

    // State for Dialog Defaults
    const [defaultDir, setDefaultDir] = useState<string | null>(null);

    // Initial Load & Config
    useEffect(() => {
        const init = async () => {
            // Robust Tauri v2 detection
            const isTauri = typeof window !== 'undefined' &&
                ((window as any).__TAURI_IPC__ || (window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);

            if (isTauri) {
                try {
                    const roots = await invoke('get_project_roots') as string[];
                    if (roots && roots.length > 0) {
                        setDefaultDir(roots[0]);
                    }
                } catch (e) {
                    console.error("Failed to get project roots", e);
                }
            }
        };
        init();
    }, []);

    const handleSaveAs = async () => {
        if (!workspaceRef.current) return;
        try {
            // @ts-ignore
            const state = Blockly.serialization.workspaces.save(workspaceRef.current);
            const json = JSON.stringify(state);
            const code = arduinoGenerator.workspaceToCode(workspaceRef.current);

            const selectedPath = await save({
                defaultPath: defaultDir || undefined,
                filters: [{
                    name: 'CK Project',
                    extensions: ['maker', 'ck']
                }]
            });

            if (selectedPath) {
                showToast('正在另存为...', 'loading');
                await invoke('save_project_as', {
                    targetPath: selectedPath,
                    xml: json,
                    code: code,
                    board: activeBoard,
                    options: JSON.stringify(boardOptions)
                });
                setCurrentPath(selectedPath); // Switch context to new file
                showToast('另存成功', 'success');
            }
        } catch (e) {
            console.error(e);
            showToast('另存失败: ' + e, 'error');
        }
    };

    const handleOpenFile = async () => {
        // Confirmation for non-empty workspace
        if (workspaceRef.current && workspaceRef.current.getAllBlocks(false).length > 0) {
            const yes = await ask("当前工作区不为空，打开新文件将覆盖现有内容。\n是否继续？", {
                title: 'CK Editor',
                kind: 'warning',
                okLabel: '继续',
                cancelLabel: '取消'
            });
            if (!yes) return;
        }

        try {
            const selectedPath = await open({
                defaultPath: defaultDir || undefined,
                multiple: false,
                filters: [{
                    name: 'CK Project',
                    extensions: ['maker', 'ck']
                }]
            });

            if (selectedPath && typeof selectedPath === 'string') {
                showToast('正在打开...', 'loading');
                // Reload project data
                setCurrentPath(selectedPath);
                setReloadTrigger(prev => prev + 1);
            }
        } catch (e) {
            console.error(e);
            showToast('打开失败: ' + e, 'error');
        }
    };

    // Dynamic Toolbox Update
    useEffect(() => {
        if (workspaceRef.current && activeBoard) {
            const newToolbox = getToolbox(activeBoard);
            workspaceRef.current.updateToolbox(newToolbox as any);
        }
    }, [activeBoard]);

    // Use ResizeObserver for robust layout handling
    useEffect(() => {
        if (!blocklyDiv.current) return;

        const resizeObserver = new ResizeObserver(() => {
            if (workspaceRef.current) {
                // Short delay to ensure flex layout has settled
                requestAnimationFrame(() => {
                    Blockly.svgResize(workspaceRef.current!);
                });
            }
        });

        resizeObserver.observe(blocklyDiv.current);

        // Also handle window resize as fallback
        const handleWindowResize = () => {
            if (workspaceRef.current) Blockly.svgResize(workspaceRef.current);
        };
        window.addEventListener('resize', handleWindowResize);

        return () => {
            resizeObserver.disconnect();
            window.removeEventListener('resize', handleWindowResize);
        };
    }, []); // Run once on mount (refs are stable)

    return (
        <div className="flex flex-col h-full bg-slate-50 text-slate-800 font-sans overflow-hidden relative">
            {/* Progress Bar (Real Percentage) */}
            {isCompiling && (
                <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[60] w-80 bg-white/95 backdrop-blur-md shadow-2xl rounded-2xl border border-slate-200/50 p-3 flex flex-col gap-2 animate-in fade-in slide-in-from-top-4 duration-300">
                    <div className="flex items-center justify-between px-1">
                        <span className="text-xs font-bold text-slate-700 flex items-center">
                            {buildProgress.mode === 'upload' ? <Upload size={14} className="mr-2 text-teal-500 animate-bounce" />:<Loader2 size={14} className="mr-2 text-indigo-500 animate-spin" />}
                            {buildProgress.mode === 'upload' ? 'Uploading...' : 'Compiling...'}
                        </span>
                        <span className="text-xs font-mono font-bold text-slate-500">{buildProgress.percentage.toFixed(0)}%</span>
                    </div>
                    {/* Bar Track */}
                    <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                        {/* Bar Fill */}
                        <div
                            className={`h - full transition - all duration - 300 ease - out rounded - full ${ buildProgress.mode === 'upload' ? 'bg-gradient-to-r from-teal-400 to-blue-500' : 'bg-indigo-500' } `}
                            style={{ width: `${ buildProgress.percentage }% ` }}
                        />
                    </div>
                    {/* Message */}
                    <div className="text-[10px] text-slate-400 truncate text-center px-2">
                        {buildProgress.message}
                    </div>
                </div>
            )}

            <Toast show={toast.show} message={toast.message} type={toast.type} onClose={() => setToast(prev => ({ ...prev, show: false }))} />

            <BoardConfigModal
                isOpen={isConfigOpen}
                onClose={() => setIsConfigOpen(false)}
                boardName={availableBoards?.find((b: any) => b.fqbn === activeBoard)?.name || BOARDS.find(b => b.id === activeBoard)?.name || 'Unknown Board'}
                boardFqbn={activeBoard}
                configOptions={availableBoards?.find((b: any) => b.fqbn === activeBoard)?.config_options}
            />

            {/* Header */}
            <div className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-4 shrink-0 z-20 shadow-sm gap-3">
                <div className="flex items-center space-x-2 lg:space-x-3 shrink-0 min-w-0">
                    <button onClick={onBack} className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-600 shrink-0">
                        <ArrowLeft size={20} />
                    </button>
                    <div className="w-8 h-8 bg-teal-600 rounded-lg flex items-center justify-center shadow-sm text-white shrink-0">
                        <Usb size={18} />
                    </div>
                    <span className="font-bold text-lg text-slate-800 tracking-tight hidden lg:inline shrink-0">CK Editor</span>
                    {currentPath && <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full mono max-w-[200px] sm:max-w-[300px] truncate" title={currentPath.split(/[\\/]/).pop()}>{currentPath.split(/[\\/]/).pop()}</span>}

                    <div className="h-6 w-px bg-slate-200 mx-1"></div>

                    {/* Open Button */}
                    <button
                        onClick={handleOpenFile}
                        className="p-2 hover:bg-slate-100 text-slate-500 hover:text-teal-600 rounded-full transition-colors flex items-center justify-center shrink-0"
                        title="打开工程"
                    >
                        <FolderOpen size={20} />
                    </button>

                    {/* Save Button */}
                    <button
                        onClick={handleSave}
                        className="p-2 hover:bg-slate-100 text-slate-500 hover:text-teal-600 rounded-full transition-colors flex items-center justify-center shrink-0"
                        title="保存项目"
                    >
                        <Save size={20} />
                    </button>

                    {/* Save As Button */}
                    <button
                        onClick={handleSaveAs}
                        className="p-2 hover:bg-slate-100 text-slate-500 hover:text-teal-600 rounded-full transition-colors flex items-center justify-center shrink-0"
                        title="另存为..."
                    >
                        <FilePlus size={20} />
                    </button>
                </div>

                <div className="flex items-center space-x-2 shrink min-w-0">
                    {/* Board Selector (Read-only + Config) */}
                    <div className="relative group/config">
                        <div
                            className="flex items-center bg-slate-100 rounded border border-slate-200 h-9 px-3 gap-2 shrink truncate min-w-[100px] hover:bg-slate-50 transition-colors cursor-pointer"
                            title="点击配置开发板"
                            onClick={() => setIsConfigOpen(true)}
                        >
                            <Settings size={14} className="text-slate-500 group-hover/config:text-teal-600 transition-colors" />
                            <span className="text-xs font-bold text-slate-600 group-hover/config:text-slate-800 transition-colors truncate max-w-[180px]" title={activeBoard}>
                                {(() => {
                                    const parts = activeBoard.split(':');
                                    const last = parts[parts.length - 1];
                                    return last.includes('=') ? last.split('=')[1] : last;
                                })()}
                            </span>
                        </div>
                    </div>

                    {/* Font Size Quick Slider (Only visible on larger screens) */}
                    {onZoomChange && zoomLevel !== undefined && (
                        <div className="hidden xl:flex items-center h-9 bg-white border border-slate-200 rounded px-2 gap-2 w-32 group hover:w-48 transition-all duration-300">
                            <span className="text-[10px] text-slate-400 font-bold shrink-0">Aa</span>
                            <input
                                type="range"
                                min="0.75"
                                max="1.25"
                                step="0.05"
                                value={zoomLevel}
                                onChange={(e) => {
                                    const val = parseFloat(e.target.value);
                                    onZoomChange(val);
                                    document.documentElement.style.setProperty('--font-mult', String(val));
                                }}
                                className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-slate-500 hover:accent-teal-600"
                                title={`界面字号: ${ (zoomLevel * 100).toFixed(0) }% `}
                            />
                        </div>
                    )}
                    {/* Port Selector */}
                    <div className="relative flex items-center bg-slate-100 rounded border border-slate-200 h-9 shrink-0 group hover:border-teal-300 transition-colors z-20">
                        <div className="w-8 flex items-center justify-center text-slate-500 border-r border-slate-200 h-full">
                            <Usb size={14} />
                        </div>

                        {/* Custom Dropdown Trigger */}
                        <div className="relative h-full">
                            <button
                                className="bg-transparent text-xs font-mono text-slate-700 focus:outline-none h-full px-3 min-w-[140px] max-w-[220px] text-left flex items-center hover:bg-slate-50 transition-colors"
                                onClick={() => setIsPortMenuOpen(!isPortMenuOpen)}
                                title="选择端口"
                            >
                                {activePort ? (
                                    <div className="flex items-center overflow-hidden">
                                        <span className="font-bold shrink-0">{activePort}</span>
                                        {(() => {
                                            const p = ports.find((p: any) => p.port_name === activePort);
                                            // Handle description: Remove standard redundant info if needed, but usually showing raw is safer if we truncate
                                            // Split '(' to avoid double parens if description has them, but mainly to keep it clean
                                            const desc = p?.description ? p.description.split('(')[0].trim() : '';
                                            return desc ? <span className="text-slate-500 ml-2 font-sans text-[10px] truncate opacity-80">({desc})</span>:null;
                                        })()}
                                    </div>
                                ) : (
                                    <span className="text-slate-400 italic">No Port Selected</span>
                                )}
                            </button>

                            {/* Dropdown Menu */}
                            {isPortMenuOpen && (
                                <>
                                    <div className="fixed inset-0 z-40 cursor-default" onClick={() => setIsPortMenuOpen(false)}></div>
                                    <div className="absolute top-full right-0 mt-1 w-80 bg-white border border-slate-200 shadow-xl rounded-lg z-50 py-1 max-h-[400px] overflow-y-auto flex flex-col animate-in fade-in zoom-in-95 duration-100 origin-top-right">
                                        <div
                                            className="px-3 py-2 hover:bg-slate-50 cursor-pointer flex items-center text-xs text-slate-500 border-b border-slate-100"
                                            onClick={() => { connectDevice(""); setIsPortMenuOpen(false); }}
                                        >
                                            <XCircle size={14} className="mr-2 text-slate-400" />
                                            Disconnect / No Port
                                        </div>
                                        {ports.length === 0 && <div className="px-3 py-4 text-center text-slate-400 text-xs italic">No ports found</div>}
                                        {ports.map((p: any) => (
                                            <div
                                                key={p.port_name}
                                                className={`px - 3 py - 2 hover: bg - teal - 50 cursor - pointer flex items - center justify - between text - xs group / item border - b border - slate - 50 last: border - 0 transition - colors ${ activePort === p.port_name ? 'bg-teal-50/60' : '' } `}
                                                onClick={() => { connectDevice(p.port_name); setIsPortMenuOpen(false); }}
                                            >
                                                <div className="flex flex-col overflow-hidden mr-2 flex-1">
                                                    <div className="flex items-center">
                                                        <span className={`font - bold font - mono ${ activePort === p.port_name ? 'text-teal-700' : 'text-slate-700' } `}>{p.port_name}</span>
                                                        {activePort === p.port_name && <span className="ml-2 px-1.5 py-px bg-teal-100 text-teal-700 text-[9px] rounded-full font-bold">ACTIVE</span>}
                                                    </div>
                                                    <span className="text-slate-500 text-[10px] mt-0.5 leading-tight break-words font-sans">{p.description}</span>
                                                </div>
                                                {activePort === p.port_name && <Check size={14} className="text-teal-600 shrink-0" />}
                                            </div>
                                        ))}
                                    </div>
                                </>
                            )}
                        </div>

                        <button
                            onClick={() => scanPorts()}
                            className="w-8 h-full flex items-center justify-center text-slate-500 hover:text-teal-600 hover:bg-slate-100 transition-colors rounded-r border-l border-slate-200 shrink-0"
                            title="刷新端口"
                        >
                            <RefreshCw size={14} />
                        </button>
                    </div>

                    {/* Compile Button */}
                    <button
                        onClick={() => handleCompileAndUpload(false)}
                        disabled={isCompiling}
                        className="bg-slate-800 hover:bg-slate-700 text-white h-9 px-3 rounded shadow-sm hover:shadow transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap shrink-0 flex items-center justify-center gap-2"
                        title="仅编译"
                    >
                        {isCompiling ? <Loader2 size={16} className="animate-spin" />:<CheckCircle size={16} />}
                        <span className="font-bold text-xs hidden lg:inline">编译</span>
                    </button>

                    {/* Upload Button */}
                    <button
                        onClick={() => handleCompileAndUpload(true)}
                        disabled={isCompiling}
                        className="bg-teal-600 hover:bg-teal-500 text-white h-9 px-3 rounded shadow-sm hover:shadow transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap shrink-0 flex items-center justify-center gap-2"
                        title="编译并上传"
                    >
                        {isCompiling ? <Loader2 size={16} className="animate-spin" />:<Upload size={16} />}
                        <span className="font-bold text-xs hidden lg:inline">上传</span>
                    </button>

                    {/* Cancel Button (Visible during compile) */}
                    {isCompiling && (
                        <button
                            onClick={handleCancel}
                            className="bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 h-9 w-9 rounded shadow-sm flex items-center justify-center shrink-0 transition-colors"
                            title="取消操作"
                        >
                            <Ban size={16} />
                        </button>
                    )}

                    <div className="h-4 w-px bg-slate-200 mx-1"></div>

                    {/* Serial Monitor Toggle */}
                    <button
                        onClick={toggleSerialMonitor}
                        className={`w - 9 h - 9 rounded flex items - center justify - center transition - colors shrink - 0 ${ isSerialMonitorOpen ? "bg-teal-100 text-teal-700 font-bold" : "bg-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-800" } `}
                        title={isSerialMonitorOpen ? "关闭串口监视器" : "打开串口监视器"}
                    >
                        <Monitor size={18} />
                    </button>

                    {/* Code Toggle */}
                    <button
                        onClick={() => setCodeViewOpen(!codeViewOpen)}
                        className={`w - 9 h - 9 rounded flex items - center justify - center transition - colors shrink - 0 ${ codeViewOpen ? "bg-slate-200 text-slate-700" : "bg-transparent text-slate-600 hover:bg-slate-100" } `}
                        title={codeViewOpen ? "隐藏代码" : "显示代码"}
                    >
                        <Code size={18} />
                    </button>
                </div>
            </div>

            {/* Main Content */}
            <div className={`flex flex - 1 overflow - hidden relative transition - all duration - 300 ${ isConfigOpen ? 'blur-[2px] opacity-90' : '' } `}>
                {/* Sidebar with Categories */}
                {/* ... (Categories logic is inside Blockly, but if there's a custom sidebar, handle it here) ... */}
                {/* In this project, the categories in the screenshot are likely the Blockly Toolbox. 
                    If they are not blurring, it might be because they are positioned absolutely outside this div.
                    HOWEVER, looking at the code structure:
                */}
                <div className="flex-1 relative bg-slate-100 overflow-hidden flex flex-col">
                    <div className="absolute inset-0" ref={blocklyDiv} style={{ touchAction: 'none' }}></div>
                </div>

                {/* Right: Code Preview */}
                {codeViewOpen && (
                    <div className="w-80 bg-white border-l border-slate-200 flex flex-col transition-all duration-300 z-10 shrink-0">
                        <div className="h-10 bg-slate-50 border-b border-slate-200 flex items-center justify-between px-4 shrink-0">
                            <span className="text-xs font-bold text-slate-500 uppercase">C++ Preview</span>
                            <div className="flex items-center space-x-1">
                                <button className="p-1 text-slate-500 hover:text-slate-700" onClick={() => setCodeViewOpen(false)}>
                                    <X size={14} />
                                </button>
                            </div>
                        </div>
                        <div className="flex-1 font-mono text-xs overflow-hidden bg-white relative">
                           <SyntaxHighlighter 
                                language="cpp" 
                                style={vs}
                                customStyle={{ 
                                    margin: 0, 
                                    padding: '1rem', 
                                    height: '100%', 
                                    fontSize: '12px',
                                    backgroundColor: '#ffffff'
                                }}
                                showLineNumbers={true}
                                lineNumberStyle={{ minWidth: '2em', paddingRight: '1em', color: '#cbd5e1' }}
                            >
                                {generatedCode}
                            </SyntaxHighlighter>
                        </div>
                        <div className="p-2 bg-slate-50 border-t border-slate-200 text-center shrink-0">
                            <button
                                onClick={() => { navigator.clipboard.writeText(generatedCode); showToast('代码已复制', 'success'); }}
                                className="text-xs text-slate-500 hover:text-teal-600 flex items-center justify-center w-full py-1 gap-2 border border-slate-200 rounded hover:bg-white transition-colors shadow-sm"
                            >
                                <Code size={12} /> Copy Code
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* Bottom: Console / Serial Monitor */}
            {consoleOpen ? (
                <div
                    className="bg-white border-t border-slate-200 flex flex-col shrink-0 relative"
                    style={{ height: consoleHeight }}
                >
                    {/* Drag Handle */}
                    <div
                        className="h-1.5 bg-slate-100 hover:bg-teal-500 cursor-ns-resize w-full absolute top-0 left-0 z-20 flex justify-center items-center group transition-colors border-b border-slate-200"
                        onMouseDown={startResizing}
                    >
                        <div className="w-8 h-1 bg-slate-300 rounded-full group-hover:bg-white" />
                    </div>

                    {/* Toolbar */}
                    <div className="h-8 bg-slate-50 flex items-center justify-between px-4 select-none border-b border-slate-200 shrink-0 overflow-hidden">
                        <div className="flex items-center space-x-0.5 text-slate-500 h-full">
                            {/* Tab: Serial */}
                            <div
                                onClick={() => setConsoleTab('serial')}
                                className={`flex items - center space - x - 2 px - 3 h - full cursor - pointer transition - all border - b - 2 ${ consoleTab === 'serial' ? 'border-teal-500 text-teal-600 bg-teal-50/50' : 'border-transparent hover:bg-slate-100' } `}
                            >
                                <Terminal size={14} />
                                <span className="text-xs font-bold uppercase tracking-wider">串口监视器</span>
                            </div>

                            {/* Tab: Output */}
                            <div
                                onClick={() => setConsoleTab('compile')}
                                className={`flex items - center space - x - 2 px - 3 h - full cursor - pointer transition - all border - b - 2 ${ consoleTab === 'compile' ? 'border-blue-500 text-blue-600 bg-blue-50/50' : 'border-transparent hover:bg-slate-100' } `}
                            >
                                <Cpu size={14} />
                                <span className="text-xs font-bold uppercase tracking-wider">输出日志</span>
                            </div>
                        </div>

                        <div className="h-4 w-px bg-slate-300"></div>

                        {/* Baud Selector */}
                        <div className="flex items-center space-x-1 hover:text-teal-600 transition-colors">
                            <span className="text-[10px] uppercase font-bold text-slate-500">波特率:</span>
                            <select
                                className="text-xs text-slate-600 border-none outline-none cursor-pointer font-mono py-0 focus:ring-0 bg-transparent"
                                value={baudRate}
                                onChange={(e) => setBaudRate(Number(e.target.value))}
                            >
                                {BAUD_RATES.map(r => (
                                    <option key={r} value={r}>{r}</option>
                                ))}
                            </select>
                        </div>

                        {/* Middle: View Controls (Checkbox) */}
                        <div className="flex items-center space-x-2">
                            <label className="flex items-center space-x-2 cursor-pointer group">
                                <input
                                    type="checkbox"
                                    checked={viewMode === 'hex'}
                                    onChange={(e) => setViewMode(e.target.checked ? 'hex' : 'text')}
                                    className="w-3 h-3 rounded border-slate-400 bg-transparent text-teal-600 focus:ring-0 focus:ring-offset-0 cursor-pointer"
                                />
                                <span className="text-[10px] font-bold text-slate-500 group-hover:text-teal-600 transition-colors select-none">16进制模式</span>
                            </label>

                            <div className="w-px h-3 bg-slate-300 mx-2" />

                            <label className="flex items-center space-x-2 cursor-pointer group">
                                <input
                                    type="checkbox"
                                    checked={showTimestamp}
                                    onChange={(e) => setShowTimestamp(e.target.checked)}
                                    className="w-3 h-3 rounded border-slate-400 bg-transparent text-teal-600 focus:ring-0 focus:ring-offset-0 cursor-pointer"
                                />
                                <span className="text-[10px] font-bold text-slate-500 group-hover:text-teal-600 transition-colors select-none">时间戳</span>
                            </label>
                        </div>

                        <div className="flex items-center space-x-2">
                            {/* Stats Moved to Footer */}

                            {/* View Mode Toggle */}
                            <div className="flex items-center bg-slate-100 rounded p-0.5 mr-2 h-7">
                                <button
                                    onClick={() => setConsoleViewMode('text')}
                                    className={`px - 2 h - full rounded text - [10px] font - bold flex items - center gap - 1 transition - all ${ consoleViewMode === 'text' ? 'bg-white text-teal-600 shadow-sm' : 'text-slate-400 hover:text-slate-600' } `}
                                    title="文本模式"
                                >
                                    <Type size={12} />
                                    <span>文本</span>
                                </button>
                                <button
                                    onClick={() => setConsoleViewMode('plot')}
                                    className={`px - 2 h - full rounded text - [10px] font - bold flex items - center gap - 1 transition - all ${ consoleViewMode === 'plot' ? 'bg-white text-teal-600 shadow-sm' : 'text-slate-400 hover:text-slate-600' } `}
                                    title="波形模式"
                                >
                                    <Activity size={12} />
                                    <span>绘图</span>
                                </button>
                            </div>

                            {/* Pause Toggle */}
                            <button
                                onClick={() => setIsPaused(!isPaused)}
                                className={`p - 1.5 rounded transition - colors cursor - pointer ${ isPaused ? 'text-amber-600 bg-amber-50 border border-amber-100' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-200' } `}
                                style={{ border: isPaused ? '' : 'none' }}
                                title={isPaused ? "继续滚动" : "暂停滚动"}
                            >
                                {isPaused ? <Play size={14} className="fill-current" />:<Pause size={14} className="fill-current" />}
                            </button>

                            {/* Clear Button */}
                            <button
                                onClick={() => serialMonitorRef.current?.clear()}
                                className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors cursor-pointer"
                                style={{ border: 'none' }}
                                title="清空日志"
                            >
                                <Trash2 size={14} />
                            </button>

                            {/* Close Button */}
                            <button
                                onClick={() => setConsoleOpen(false)}
                                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200 rounded transition-colors cursor-pointer"
                                style={{ border: 'none' }}
                            >
                                <X size={14} />
                            </button>
                        </div>
                    </div>

                    {/* Log Content Wrapper */}

                    <div className="flex-1 flex flex-col overflow-hidden bg-white">
                        {consoleTab === 'serial' ? (

                            <div className="relative w-full h-full">
                                <div className={`absolute inset - 0 ${ consoleViewMode === 'text' ? 'z-10 bg-white' : 'z-0 invisible' } `}>
                                    <SerialMonitor
                                        ref={serialMonitorRef}
                                        viewMode={viewMode}
                                        paused={isPaused}
                                        showTimestamp={showTimestamp}
                                    />
                                </div>
                                {consoleViewMode === 'plot' && (
                                    <div className="absolute inset-0 z-10 bg-white">
                                        <SerialPlotter
                                            paused={isPaused}
                                        />
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="h-full overflow-auto p-2 font-mono text-xs whitespace-pre-wrap">
                                <pre>{compileLog || <span className="text-slate-300 italic">暂无输出日志...</span>}</pre>
                                <div ref={logEndRef} />
                            </div>
                        )}
                    </div>

                    {/* Serial Input - Only Show in Serial Tab */}
                    {consoleTab === 'serial' && (
                        <div className="bg-white border-t border-slate-200 shrink-0 z-10 flex items-center h-8">
                            {/* Input Field */}
                            <input
                                type="text"
                                value={serialInput}
                                onChange={(e) => setSerialInput(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleSendSerial()}
                                disabled={!isSerialMonitorOpen}
                                placeholder={isSerialMonitorOpen ? "发送数据..." : "串口已关闭"}
                                className="flex-1 bg-transparent border-none text-slate-700 text-xs px-3 focus:ring-0 outline-none disabled:opacity-30 placeholder:text-slate-400 h-full"
                            />

                            {/* Line Ending Selector - Compact */}
                            <div className="h-full border-l border-r border-slate-200 flex items-center px-1 hover:bg-slate-50 relative min-w-[60px]">
                                <select
                                    className="w-full bg-transparent text-[10px] font-bold text-slate-500 outline-none cursor-pointer hover:text-teal-600 transition-colors uppercase appearance-none text-center relative z-10 pl-2 pr-4 h-full"
                                    value={lineEnding}
                                    onChange={(e) => setLineEnding(e.target.value)}
                                    title="行尾符"
                                >
                                    <option value="">无</option>
                                    <option value={'\n'}>换行 (LF)</option>
                                    <option value={'\r'}>回车 (CR)</option>
                                    <option value={'\r\n'}>回车换行</option>
                                </select>
                                <span className="text-slate-400 text-[8px] absolute right-1 pointer-events-none top-1/2 -translate-y-1/2">▼</span>
                            </div>

                            {/* Send Button */}
                            <button
                                onClick={handleSendSerial}
                                disabled={!isSerialMonitorOpen || !serialInput.trim()}
                                className="h-full w-12 flex items-center justify-center bg-teal-600 hover:bg-teal-500 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                title="发送数据"
                            >
                                <Send size={14} />
                            </button>
                        </div>
                    )}
                </div>

            ) : (
                // Collapsed Bar
                <div onClick={() => setConsoleOpen(true)} className="h-6 bg-slate-900 border-t border-slate-700 flex items-center justify-between px-4 cursor-pointer hover:bg-slate-800 shrink-0">
                    <div className="flex items-center space-x-2 text-slate-400">
                        <Terminal size={12} />
                        <span className="text-[10px] font-bold uppercase">显示控制台</span>
                    </div>
                </div>
            )
            }
            <StatusFooter
                bytesReceivedRef={bytesReceivedRef}
                linesReceivedRef={linesReceivedRef}
                baudRate={baudRate}
                activePort={activePort}
                isSerialMonitorOpen={isSerialMonitorOpen}
                boardName={getBoardName()}
            />

        </div>
    );
}

