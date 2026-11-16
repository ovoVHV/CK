import React, { useEffect, useRef, useImperativeHandle, forwardRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ITheme, Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { ArrowDown } from 'lucide-react';
import 'xterm/css/xterm.css';
import { CkDebugStreamParser } from '../services/block_debugger';
import { useTranslation } from 'react-i18next';

export type SerialCaptureMode = 'text' | 'hex';

/**
 * Keep the terminal palette explicit instead of relying on xterm's default
 * ANSI colours.  The defaults are tuned for a light editor surface and make
 * several normal serial colours (notably blue/black) disappear on CK's dark
 * surface.  This palette is display-only; it does not alter captured bytes.
 */
export const getSerialTerminalTheme = (isDark: boolean): ITheme => isDark ? {
    background: '#0b1220',
    foreground: '#e8f0f7',
    cursor: '#fdba74',
    cursorAccent: '#08131e',
    selectionBackground: '#652b18',
    selectionInactiveBackground: '#35241c',
    black: '#64748b',
    red: '#fb7185',
    green: '#4ade80',
    yellow: '#facc15',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#2dd4bf',
    white: '#e2e8f0',
    brightBlack: '#94a3b8',
    brightRed: '#fda4af',
    brightGreen: '#86efac',
    brightYellow: '#fde68a',
    brightBlue: '#93c5fd',
    brightMagenta: '#d8b4fe',
    brightCyan: '#99f6e4',
    brightWhite: '#f8fafc',
} : {
    background: '#f8fafc',
    foreground: '#1e293b',
    cursor: '#c2410c',
    cursorAccent: '#ffffff',
    selectionBackground: '#fed7aa',
    selectionInactiveBackground: '#ffedd5',
    black: '#334155',
    red: '#dc2626',
    green: '#15803d',
    yellow: '#a16207',
    blue: '#1d4ed8',
    magenta: '#7e22ce',
    cyan: '#0f766e',
    white: '#e2e8f0',
    brightBlack: '#64748b',
    brightRed: '#b91c1c',
    brightGreen: '#166534',
    brightYellow: '#854d0e',
    brightBlue: '#1e40af',
    brightMagenta: '#6b21a8',
    brightCyan: '#115e59',
    brightWhite: '#0f172a',
};

// Repainting an unbounded xterm scrollback can itself take seconds at 2 Mbps
// because xterm parses writes in small asynchronous slices. Mode switching is
// a display operation, so keep it responsive by repainting a recent window;
// the complete capture remains available through getCapture()/export.
const SERIAL_MODE_SWITCH_REPAINT_BYTES = 32 * 1024;
const SERIAL_MODE_SWITCH_REPAINT_TEXT = 96 * 1024;

export interface SerialTerminalRef {
    clear: () => void;
    scrollToBottom: () => void;
    write: (data: string) => void;
    getCapture: (mode: SerialCaptureMode) => string;
}

/**
 * Render captured bytes in the same compact form used by the live HEX view.
 *
 * This is intentionally separate from the export formatter below: the live
 * terminal keeps line breaks from the byte stream, while exported captures are
 * grouped into fixed-width rows. Keeping the two paths explicit prevents a
 * view switch from having to wait for another serial packet just to repaint.
 */
export const formatSerialBytesForDisplay = (bytes: Uint8Array): string => {
    if (bytes.length === 0) return '';
    const parts: string[] = [];
    for (const byte of bytes) {
        parts.push(byte.toString(16).padStart(2, '0').toUpperCase(), ' ');
        if (byte === 0x0A) parts.push('\r\n');
    }
    return parts.join('');
};

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
    const { t } = useTranslation('serial');
    const terminalRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const isInitializedRef = useRef(false);
    const [isAtBottom, setIsAtBottom] = useState(true);
    const [hasOutput, setHasOutput] = useState(false);
    const hasOutputRef = useRef(false);
    const [terminalGeneration, setTerminalGeneration] = useState(0);
    const previousViewModeRef = useRef(viewMode);

    // State refs
    const viewModeRef = useRef(viewMode);
    const pausedRef = useRef(paused);
    const showTimestampRef = useRef(showTimestamp);
    const hideDebugProtocolRef = useRef(hideDebugProtocol);
    const debugProtocolParserRef = useRef(new CkDebugStreamParser());

    // Logic refs
    const atLineStartRef = useRef(true);
    const decoderRef = useRef(new TextDecoder('utf-8')); // Stream decoder
    const captureDecoderRef = useRef(new TextDecoder('utf-8'));
    const captureTextRef = useRef('');
    const captureByteChunksRef = useRef<Uint8Array[]>([]);
    const captureByteLengthRef = useRef(0);
    const syncScrollStateRef = useRef<() => void>(() => undefined);
    // The xterm buffer is rendered in the selected mode. A mode change must
    // repaint the already-captured bytes immediately instead of waiting for
    // the next `serial-data` event (which can be seconds away on a quiet port).
    const redrawForModeRef = useRef<() => void>(() => undefined);

    // Sync refs immediately during render (before any async operations)
    viewModeRef.current = viewMode;
    pausedRef.current = paused;
    showTimestampRef.current = showTimestamp;
    hideDebugProtocolRef.current = hideDebugProtocol;

    useEffect(() => {
        debugProtocolParserRef.current.reset();
    }, [hideDebugProtocol]);

    const clearCapture = () => {
        captureTextRef.current = '';
        captureByteChunksRef.current = [];
        captureByteLengthRef.current = 0;
        captureDecoderRef.current = new TextDecoder('utf-8');
    };

    const markHasOutput = () => {
        if (hasOutputRef.current) return;
        hasOutputRef.current = true;
        setHasOutput(true);
    };

    const appendCapture = (bytes: Uint8Array, text: string) => {
        if (bytes.length > 0) {
            captureByteChunksRef.current.push(bytes.slice());
            captureByteLengthRef.current += bytes.length;
            while (captureByteLengthRef.current > bufferCap && captureByteChunksRef.current.length > 0) {
                const overflow = captureByteLengthRef.current - bufferCap;
                const first = captureByteChunksRef.current[0];
                if (first.length <= overflow) {
                    captureByteChunksRef.current.shift();
                    captureByteLengthRef.current -= first.length;
                } else {
                    captureByteChunksRef.current[0] = first.slice(overflow);
                    captureByteLengthRef.current -= overflow;
                }
            }
        }
        if (text) {
            captureTextRef.current += text;
            if (captureTextRef.current.length > bufferCap) {
                captureTextRef.current = captureTextRef.current.slice(-bufferCap);
            }
        }
    };

    const captureAsHex = (): string => {
        if (captureByteLengthRef.current === 0) return '';
        const lines: string[] = [];
        let line: string[] = [];
        for (const chunk of captureByteChunksRef.current) {
            for (const byte of chunk) {
                line.push(byte.toString(16).padStart(2, '0').toUpperCase());
                if (line.length === 16) {
                    lines.push(line.join(' '));
                    line = [];
                }
            }
        }
        if (line.length > 0) lines.push(line.join(' '));
        return lines.join('\r\n');
    };

    const captureAsDisplayHex = (): string => {
        if (captureByteLengthRef.current === 0) return '';
        const targetLength = Math.min(SERIAL_MODE_SWITCH_REPAINT_BYTES, captureByteLengthRef.current);
        const bytes = new Uint8Array(targetLength);
        let writeOffset = targetLength;
        let remaining = targetLength;
        for (let index = captureByteChunksRef.current.length - 1; index >= 0 && remaining > 0; index -= 1) {
            const chunk = captureByteChunksRef.current[index];
            const take = Math.min(remaining, chunk.length);
            bytes.set(chunk.subarray(chunk.length - take), writeOffset - take);
            writeOffset -= take;
            remaining -= take;
        }
        return formatSerialBytesForDisplay(bytes);
    };

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
            clearCapture();
            setIsAtBottom(true);
            hasOutputRef.current = false;
            setHasOutput(false);
        },
        scrollToBottom: () => {
            xtermRef.current?.scrollToBottom();
            setIsAtBottom(true);
        },
        write: (data: string) => {
            if (!pausedRef.current && xtermRef.current) {
                xtermRef.current.write(data);
                appendCapture(new TextEncoder().encode(data), data);
                if (data.length > 0) markHasOutput();
                if (data.length > 0) atLineStartRef.current = data.endsWith('\n');
                window.requestAnimationFrame(() => syncScrollStateRef.current());
            }
        },
        getCapture: (mode: SerialCaptureMode) => (
            mode === 'hex' ? captureAsHex() : captureTextRef.current
        ),
    }));

    useEffect(() => {
        if (!terminalRef.current || isInitializedRef.current) return;

        console.log("[SerialTerminal] Initializing xterm (Debug Mode)...");

        const prefersDark = typeof window !== 'undefined'
            && typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-color-scheme: dark)').matches;
        const isDark = theme === 'dark' || (theme === 'system' && prefersDark);

        const terminal = new Terminal({
            theme: getSerialTerminalTheme(isDark),
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            fontSize: fontSize,
            fontWeight: 500,
            lineHeight: 1.2,
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

        const syncScrollState = () => {
            const buffer = terminal.buffer.active;
            setIsAtBottom(buffer.viewportY >= buffer.baseY);
        };
        syncScrollStateRef.current = syncScrollState;
        const scrollDisposable = terminal.onScroll(syncScrollState);

        const handleResize = () => {
            fitAddonRef.current?.fit();
            syncScrollState();
        };
        window.addEventListener('resize', handleResize);
        const resizeObserver = new ResizeObserver(() => handleResize());
        resizeObserver.observe(terminalRef.current);

        return () => {
            window.removeEventListener('resize', handleResize);
            resizeObserver.disconnect();
            scrollDisposable.dispose();
            terminal.dispose();
            xtermRef.current = null;
            fitAddonRef.current = null;
            isInitializedRef.current = false;
            syncScrollStateRef.current = () => undefined;
        };
    }, [terminalGeneration]);

    // Theme Update Effect
    useEffect(() => {
        if (!xtermRef.current) return;
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        const applyTheme = () => {
            if (!xtermRef.current) return;
            const isDark = theme === 'dark' || (theme === 'system' && media.matches);
            xtermRef.current.options.theme = getSerialTerminalTheme(isDark);
        };
        applyTheme();
        if (theme === 'system') media.addEventListener('change', applyTheme);
        return () => media.removeEventListener('change', applyTheme);
    }, [theme, terminalGeneration]);

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

        const cancelPendingFlush = () => {
            incomingBuffer = '';
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
            flushScheduled = false;
        };

        const redrawCurrentMode = () => {
            if (destroyed || !xtermRef.current) return;

            // The pending buffer may have been formatted using the previous
            // mode. The same bytes are already in the capture, so discard that
            // stale display chunk before rebuilding from the source capture.
            cancelPendingFlush();

            const terminal = xtermRef.current;
            const content = viewModeRef.current === 'hex'
                ? captureAsDisplayHex()
                : captureTextRef.current.length > SERIAL_MODE_SWITCH_REPAINT_TEXT
                    ? captureTextRef.current.slice(-SERIAL_MODE_SWITCH_REPAINT_TEXT)
                    : captureTextRef.current;

            terminal.clear();
            if (content.length > 0) terminal.write(content);
            atLineStartRef.current = content.length === 0 || content.endsWith('\n');
            terminal.scrollToBottom();
            syncScrollStateRef.current();
        };

        redrawForModeRef.current = redrawCurrentMode;

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
                window.requestAnimationFrame(() => syncScrollStateRef.current());
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
                    let captureBytes = new Uint8Array();
                    let captureText = '';

                    // 1. Normalize Input (Universal Handler)
                    if (typeof payload === 'string') {
                        captureBytes = new TextEncoder().encode(payload);
                        captureText = payload;
                        textToAdd = payload;
                        if (viewModeRef.current === 'hex') {
                            textToAdd = formatSerialBytesForDisplay(captureBytes);
                        }
                    } else if (Array.isArray(payload)) {
                        const rawBytes = new Uint8Array(payload);
                        captureBytes = rawBytes;
                        captureText = captureDecoderRef.current.decode(rawBytes, { stream: true });
                        if (viewModeRef.current === 'hex') {
                            textToAdd = formatSerialBytesForDisplay(rawBytes);
                        } else {
                            textToAdd = decoderRef.current.decode(rawBytes, { stream: true });
                        }
                    } else if (payload && typeof payload === 'object') {
                        try {
                            const values = Object.values(payload) as number[];
                            if (values.length > 0 && typeof values[0] === 'number') {
                                const rawBytes = new Uint8Array(values);
                                captureBytes = rawBytes;
                                captureText = captureDecoderRef.current.decode(rawBytes, { stream: true });
                                if (viewModeRef.current === 'hex') {
                                    textToAdd = `${formatSerialBytesForDisplay(rawBytes)}\r\n`;
                                } else {
                                    textToAdd = decoderRef.current.decode(rawBytes, { stream: true });
                                }
                            } else {
                                textToAdd = "\r\n[JSON] " + JSON.stringify(payload) + "\r\n";
                                captureText = textToAdd;
                                captureBytes = new TextEncoder().encode(captureText);
                            }
                        } catch (e) {
                            textToAdd = "\r\n[ObjError] " + JSON.stringify(payload) + "\r\n";
                            captureText = textToAdd;
                            captureBytes = new TextEncoder().encode(captureText);
                        }
                    } else {
                        textToAdd = String(payload);
                        captureText = textToAdd;
                        captureBytes = new TextEncoder().encode(captureText);
                    }

                    // 2. Buffer and schedule one flush frame.
                    if (textToAdd) {
                        appendCapture(captureBytes, captureText || textToAdd);
                        markHasOutput();
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
            redrawForModeRef.current = () => undefined;
            unlisten?.();
            unlisten = undefined;
            if (rafId !== null) cancelAnimationFrame(rafId);
            incomingBuffer = '';
            debugProtocolParserRef.current.reset();
        };
    }, [bufferCap]);

    // A fresh xterm instance drops any old asynchronous WriteBuffer queue.
    // This matters under high-rate serial traffic: clear()+write() alone can
    // leave the previous mode queued for another second or two.
    useEffect(() => {
        if (previousViewModeRef.current === viewMode) return;
        previousViewModeRef.current = viewMode;
        setTerminalGeneration((generation) => generation + 1);
    }, [viewMode]);

    // The generation effect has recreated xterm; now repaint the captured
    // bytes in the newly selected mode without waiting for serial input.
    useEffect(() => {
        if (terminalGeneration === 0) return;
        redrawForModeRef.current();
    }, [terminalGeneration, viewMode]);

    return (
        <div
            className={`ck-serial-terminal ${paused ? 'is-paused' : ''} ${hasOutput ? 'has-output' : 'is-empty'} ${className || ''}`}
            data-ck-role="serial-terminal"
            style={{
                width: '100%',
                height: '100%',
                overflow: 'hidden',
                ...style,
            }}
        >
            <div key={terminalGeneration} ref={terminalRef} className="ck-serial-terminal-host" aria-label={t('monitor.outputAria')} />
            {!hasOutput && (
                <div className="ck-serial-terminal-empty" aria-hidden="true">
                    <span className="ck-serial-terminal-empty-icon">&gt;_</span>
                    <span className="ck-serial-terminal-empty-title">{t('monitor.waitingOutput')}</span>
                    <span className="ck-serial-terminal-empty-detail">{t('monitor.outputHint')}</span>
                </div>
            )}
            {paused && (
                <div className="ck-serial-terminal-paused" role="status">
                    {t('monitor.displayPaused')}
                </div>
            )}
            {!isAtBottom && (
                <button
                    type="button"
                    className="ck-serial-scroll-to-bottom"
                    onClick={() => {
                        xtermRef.current?.scrollToBottom();
                        setIsAtBottom(true);
                    }}
                    title={t('monitor.latestContent')}
                    aria-label={t('monitor.bottom')}
                >
                    <ArrowDown size={14} />
                    <span>{t('monitor.bottom')}</span>
                </button>
            )}
        </div>
    );
});
