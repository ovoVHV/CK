import React, { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { CkDebugStreamParser } from '../services/block_debugger';

export interface SerialTerminalRef {
    clear: () => void;
    scrollToBottom: () => void;
    write: (data: string) => void;
}

interface SerialTerminalProps {
    className?: string;
    style?: React.CSSProperties;
    viewMode?: 'text' | 'hex';
    paused?: boolean;
    showTimestamp?: boolean;
    theme?: 'light' | 'dark' | 'system';
    fontSize?: number;
    scrollback?: number;
    bufferCap?: number;
    hideDebugProtocol?: boolean;
}

export const SerialMonitor = forwardRef<SerialTerminalRef, SerialTerminalProps>(({ className, style, viewMode = 'text', paused = false, showTimestamp = false, theme = 'light', fontSize = 14, scrollback = 20000, bufferCap = 200000, hideDebugProtocol = false }, ref) => {
    const terminalRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const isInitializedRef = useRef(false);

    // State refs
    const viewModeRef = useRef(viewMode);
    const pausedRef = useRef(paused);
    const showTimestampRef = useRef(showTimestamp);
    const hideDebugProtocolRef = useRef(hideDebugProtocol);
    const debugProtocolParserRef = useRef(new CkDebugStreamParser());

    // Logic refs
    const atLineStartRef = useRef(true);
    const decoderRef = useRef(new TextDecoder('utf-8')); // Stream decoder

    // Sync refs immediately during render (before any async operations)
    viewModeRef.current = viewMode;
    pausedRef.current = paused;
    showTimestampRef.current = showTimestamp;
    hideDebugProtocolRef.current = hideDebugProtocol;

    useEffect(() => {
        debugProtocolParserRef.current.reset();
    }, [hideDebugProtocol]);

    // Font Size Update Effect
    useEffect(() => {
        if (xtermRef.current) {
            xtermRef.current.options.fontSize = fontSize;
            fitAddonRef.current?.fit();
        }
    }, [fontSize]);

    useImperativeHandle(ref, () => ({
        clear: () => {
            xtermRef.current?.clear();
            atLineStartRef.current = true;
        },
        scrollToBottom: () => {
            xtermRef.current?.scrollToBottom();
        },
        write: (data: string) => {
            if (!pausedRef.current && xtermRef.current) {
                xtermRef.current.write(data);
                if (data.length > 0) atLineStartRef.current = data.endsWith('\n');
            }
        }
    }));

    useEffect(() => {
        if (!terminalRef.current || isInitializedRef.current) return;

        console.log("[SerialTerminal] Initializing xterm (Debug Mode)...");

        const terminal = new Terminal({
            theme: {
                background: '#ffffff',
                foreground: '#334155',
                cursor: '#0d9488',
                selectionBackground: '#ccfbf1',
                cursorAccent: '#ffffff',
            },
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            fontSize: fontSize,
            lineHeight: 1.15,
            scrollback,
            convertEol: true,
            cursorBlink: true,
            cursorStyle: 'block',
            disableStdin: true,
            allowProposedApi: true,
        });

        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(terminalRef.current);

        try {
            fitAddon.fit();
        } catch (e) {
            console.warn("Fit addon failed initial fit:", e);
        }

        xtermRef.current = terminal;
        fitAddonRef.current = fitAddon;
        isInitializedRef.current = true;

        const handleResize = () => {
            fitAddonRef.current?.fit();
        };
        window.addEventListener('resize', handleResize);
        const resizeObserver = new ResizeObserver(() => handleResize());
        resizeObserver.observe(terminalRef.current);

        return () => {
            window.removeEventListener('resize', handleResize);
            resizeObserver.disconnect();
            terminal.dispose();
            xtermRef.current = null;
            fitAddonRef.current = null;
            isInitializedRef.current = false;
        };
    }, []);

    // Theme Update Effect
    useEffect(() => {
        if (!xtermRef.current) return;
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        const applyTheme = () => {
            if (!xtermRef.current) return;
            const isDark = theme === 'dark' || (theme === 'system' && media.matches);
            xtermRef.current.options.theme = isDark ? {
                background: '#0f172a',
                foreground: '#e2e8f0',
                cursor: '#14b8a6',
                selectionBackground: '#1e293b',
                cursorAccent: '#ffffff',
            } : {
                background: '#ffffff',
                foreground: '#334155',
                cursor: '#0d9488',
                selectionBackground: '#ccfbf1',
                cursorAccent: '#ffffff',
            };
        };
        applyTheme();
        if (theme === 'system') media.addEventListener('change', applyTheme);
        return () => media.removeEventListener('change', applyTheme);
    }, [theme]);

    const generateTimestamp = (date: Date) => {
        const time = date.toLocaleTimeString('en-GB', { hour12: false });
        const ms = date.getMilliseconds().toString().padStart(3, '0');
        return `${time}.${ms} -> `;
    };

    // Serial Data Listener (event-driven flush, no idle RAF loop)
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        let rafId: number | null = null;
        let incomingBuffer = '';
        let destroyed = false;
        let flushScheduled = false;

        const flushBuffer = () => {
            flushScheduled = false;
            if (destroyed || incomingBuffer.length === 0) return;

            const chunk = incomingBuffer;
            incomingBuffer = '';

            if (xtermRef.current && !pausedRef.current && chunk.length > 0) {
                if (showTimestampRef.current) {
                    const now = new Date();
                    const tsString = `\x1b[2m${generateTimestamp(now)}\x1b[0m`;
                    let processed = '';
                    const segments = chunk.split('\n');

                    for (let i = 0; i < segments.length; i++) {
                        // Strip trailing \r from segment (handle \r\n properly)
                        let seg = segments[i];
                        if (seg.endsWith('\r')) {
                            seg = seg.slice(0, -1);
                        }

                        // For segments after the first, we need a newline before
                        if (i > 0) {
                            processed += '\r\n';
                            atLineStartRef.current = true;
                        }

                        // Skip empty trailing segment (from data ending with \n)
                        const isLastSegment = i === segments.length - 1;
                        const isEmpty = seg.length === 0;
                        if (isLastSegment && isEmpty) {
                            continue;
                        }

                        // Add timestamp at line start
                        if (atLineStartRef.current) {
                            processed += tsString;
                            atLineStartRef.current = false;
                        }
                        processed += seg;
                    }
                    xtermRef.current.write(processed);
                } else {
                    xtermRef.current.write(chunk);
                    atLineStartRef.current = chunk.endsWith('\n');
                }
            }

            // If new data arrived during this flush, schedule one more frame.
            if (incomingBuffer.length > 0 && !destroyed && !flushScheduled) {
                flushScheduled = true;
                rafId = requestAnimationFrame(flushBuffer);
            }
        };

        const scheduleFlush = () => {
            if (destroyed || flushScheduled) return;
            flushScheduled = true;
            rafId = requestAnimationFrame(flushBuffer);
        };

        async function setupListener() {
            try {
                const stopListening = await listen<any>('serial-data', (event) => {
                    if (pausedRef.current) return;

                    const payload = hideDebugProtocolRef.current
                        ? debugProtocolParserRef.current.push(event.payload).visibleText
                        : event.payload;
                    if (payload === '') return;
                    let textToAdd = '';

                    // 1. Normalize Input (Universal Handler)
                    if (typeof payload === 'string') {
                        textToAdd = payload;
                        if (viewModeRef.current === 'hex') {
                            const raw = new TextEncoder().encode(payload);
                            let hex = '';
                            for (let i = 0; i < raw.length; i++) {
                                hex += raw[i].toString(16).padStart(2, '0').toUpperCase() + ' ';
                                if (raw[i] === 0x0A) hex += '\r\n';
                            }
                            textToAdd = hex;
                        }
                    } else if (Array.isArray(payload)) {
                        const rawBytes = new Uint8Array(payload);
                        if (viewModeRef.current === 'hex') {
                            let hex = '';
                            for (let i = 0; i < rawBytes.length; i++) {
                                hex += rawBytes[i].toString(16).padStart(2, '0').toUpperCase() + ' ';
                                if (rawBytes[i] === 0x0A) hex += '\r\n';
                            }
                            textToAdd = hex;
                        } else {
                            textToAdd = decoderRef.current.decode(rawBytes, { stream: true });
                        }
                    } else if (payload && typeof payload === 'object') {
                        try {
                            const values = Object.values(payload) as number[];
                            if (values.length > 0 && typeof values[0] === 'number') {
                                const rawBytes = new Uint8Array(values);
                                if (viewModeRef.current === 'hex') {
                                    let hex = '';
                                    for (let i = 0; i < rawBytes.length; i++) {
                                        hex += rawBytes[i].toString(16).padStart(2, '0').toUpperCase() + ' ';
                                        if (rawBytes[i] === 0x0A) hex += '\r\n';
                                    }
                                    textToAdd = hex + '\r\n';
                                } else {
                                    textToAdd = decoderRef.current.decode(rawBytes, { stream: true });
                                }
                            } else {
                                textToAdd = "\r\n[JSON] " + JSON.stringify(payload) + "\r\n";
                            }
                        } catch (e) {
                            textToAdd = "\r\n[ObjError] " + JSON.stringify(payload) + "\r\n";
                        }
                    } else {
                        textToAdd = String(payload);
                    }

                    // 2. Buffer and schedule one flush frame.
                    if (textToAdd) {
                        incomingBuffer += textToAdd;
                        if (incomingBuffer.length > bufferCap) {
                            incomingBuffer = incomingBuffer.substring(incomingBuffer.length - bufferCap);
                        }
                        scheduleFlush();
                    }
                });
                if (destroyed) stopListening();
                else unlisten = stopListening;
            } catch (e) {
                if (!destroyed) console.error("Failed to setup serial listener", e);
            }
        }

        setupListener();

        return () => {
            destroyed = true;
            unlisten?.();
            unlisten = undefined;
            if (rafId !== null) cancelAnimationFrame(rafId);
            incomingBuffer = '';
            debugProtocolParserRef.current.reset();
        };
    }, [bufferCap]);

    return (
        <div
            ref={terminalRef}
            className={className}
            style={{
                width: '100%',
                height: '100%',
                overflow: 'hidden',
                ...style
            }}
        />
    );
});
