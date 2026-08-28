import {
    findBlockMarker,
    stripBlockMarkerComments,
} from './block_markers';

export const CK_DEBUG_PROTOCOL_PREFIX = '@@CKDBG';
export const CK_DEBUG_RECORD_SEPARATOR = '\x1e';
export const CK_DEBUG_DEFAULT_BAUD = 115200;
export const CK_TRACE_DEFAULT_MAX_BLOCKS = 64;
export const CK_TRACE_HARD_MAX_BLOCKS = 128;
export const CK_TRACE_DEFAULT_SAMPLE_EVERY = 4;
export const CK_TRACE_DEFAULT_MIN_INTERVAL_MS = 40;

export type CkDebugCommand = 'ATTACH' | 'CONTINUE' | 'STEP' | 'STOP';
export type CkDebugFrame =
    | { kind: 'ready'; sessionId: string }
    | { kind: 'attached'; sessionId: string }
    | { kind: 'paused'; sessionId: string; blockToken: string }
    | { kind: 'trace'; sessionId: string; traceIndex: number; deviceMicros: number; firstHit: boolean }
    | { kind: 'resumed'; sessionId: string; mode: 'continue' | 'step' }
    | { kind: 'stopped'; sessionId: string };

export interface DebugSketchResult {
    code: string;
    baudRate: number;
    sessionId: string;
    tokenToBlockId: Map<string, string>;
    instrumentedBlockIds: Set<string>;
    missingBreakpointIds: string[];
}

export interface BlockTraceBuildOptions {
    maxTrackedBlocks?: number;
    sampleEvery?: number;
    minIntervalMs?: number;
}

export interface BlockTraceLimits {
    maxTrackedBlocks: number;
    trackedBlockCount: number;
    sampleEvery: number;
    minIntervalMs: number;
    maxFramesPerSecond: number;
}

export interface TraceSketchResult extends DebugSketchResult {
    traceIndexToBlockId: Map<number, string>;
    tracedBlockIds: Set<string>;
    omittedTraceBlockIds: string[];
    traceLimits: BlockTraceLimits;
}

interface NormalizedBlockTraceOptions {
    maxTrackedBlocks: number;
    sampleEvery: number;
    minIntervalMs: number;
}

interface InstrumentedDebugStatements {
    code: string;
    instrumentedBlockIds: Set<string>;
    traceIndexToBlockId: Map<number, string>;
    omittedTraceBlockIds: Set<string>;
}

const normalizeSessionId = (value: string): string => {
    const safe = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    if (!safe) throw new Error('调试会话标识无效');
    return safe;
};

export const encodeDebugBlockToken = (blockId: string): string => {
    const bytes = new TextEncoder().encode(String(blockId || ''));
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
};

export const extractDebuggableBlockIds = (code: string): Set<string> => {
    const ids = new Set<string>();
    for (const line of String(code || '').split(/\r?\n/)) {
        const marker = findBlockMarker(line);
        if (marker?.blockId) ids.add(marker.blockId);
    }
    return ids;
};

const braceDelta = (rawLine: string): number => {
    const line = rawLine
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/'(?:\\.|[^'\\])*'/g, "''")
        .replace(/\/\/.*$/, '')
        .replace(/\/\*.*?\*\//g, '');
    let delta = 0;
    for (const char of line) {
        if (char === '{') delta += 1;
        else if (char === '}') delta -= 1;
    }
    return delta;
};

const instrumentDebugStatements = (
    source: string,
    tokenToBlockId: Map<string, string>,
    traceMaxBlocks = 0,
): InstrumentedDebugStatements => {
    const instrumentedBlockIds = new Set<string>();
    const traceIndexToBlockId = new Map<number, string>();
    const traceIndexByBlockId = new Map<string, number>();
    const omittedTraceBlockIds = new Set<string>();
    const outputLines: string[] = [];
    let braceDepth = 0;

    const checkpointFor = (blockId: string, indentation: string): string => {
        const token = encodeDebugBlockToken(blockId);
        tokenToBlockId.set(token, blockId);
        instrumentedBlockIds.add(blockId);

        if (traceMaxBlocks <= 0) {
            return `${indentation}__ck_debug_checkpoint(__CK_DEBUG_TEXT("${token}"));`;
        }

        let traceIndex = traceIndexByBlockId.get(blockId);
        if (traceIndex == null && traceIndexByBlockId.size < traceMaxBlocks) {
            traceIndex = traceIndexByBlockId.size;
            traceIndexByBlockId.set(blockId, traceIndex);
            traceIndexToBlockId.set(traceIndex, blockId);
        }
        if (traceIndex == null) omittedTraceBlockIds.add(blockId);
        const traceArgument = traceIndex == null ? '__CK_DEBUG_TRACE_NONE' : `${traceIndex}U`;
        return `${indentation}__ck_debug_checkpoint(__CK_DEBUG_TEXT("${token}"), ${traceArgument});`;
    };

    for (const line of source.split('\n')) {
        const marker = findBlockMarker(line);
        const blockId = marker?.blockId || '';
        const trimmed = line.trimStart();
        const indentation = line.slice(0, line.length - trimmed.length);
        const executableText = stripBlockMarkerComments(trimmed).trim();
        const isCaseLabel = /^(?:case\b.*|default)\s*:/.test(executableText);
        const isCommentOnly = !executableText
            || executableText.startsWith('//')
            || (executableText.startsWith('/*') && executableText.endsWith('*/'));
        const isUnsafeBoundary = trimmed.startsWith('}') || trimmed.startsWith('#');

        if (blockId && braceDepth > 0 && !isUnsafeBoundary && !isCaseLabel && !isCommentOnly) {
            outputLines.push(checkpointFor(blockId, indentation));
        }

        outputLines.push(line);

        if (blockId && braceDepth > 0 && isCaseLabel && !isCommentOnly) {
            outputLines.push(checkpointFor(blockId, `${indentation}  `));
        }

        braceDepth = Math.max(0, braceDepth + braceDelta(line));
    }

    return {
        code: outputLines.join('\n'),
        instrumentedBlockIds,
        traceIndexToBlockId,
        omittedTraceBlockIds,
    };
};

export const extractInstrumentableBlockIds = (code: string): Set<string> => (
    instrumentDebugStatements(String(code || '').replace(/\r\n/g, '\n'), new Map()).instrumentedBlockIds
);

const detectDebugBaudRate = (code: string): number => {
    const match = String(code || '').match(/\bSerial\s*\.\s*begin\s*\(\s*(\d+)\s*\)/);
    const baud = Number(match?.[1] || CK_DEBUG_DEFAULT_BAUD);
    return Number.isFinite(baud) && baud >= 300 && baud <= 2_000_000
        ? Math.round(baud)
        : CK_DEBUG_DEFAULT_BAUD;
};

const clampedInteger = (
    rawValue: unknown,
    fallback: number,
    minimum: number,
    maximum: number,
): number => {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.round(value)));
};

const normalizeTraceOptions = (
    options: BlockTraceBuildOptions = {},
): NormalizedBlockTraceOptions => ({
    maxTrackedBlocks: clampedInteger(
        options.maxTrackedBlocks,
        CK_TRACE_DEFAULT_MAX_BLOCKS,
        1,
        CK_TRACE_HARD_MAX_BLOCKS,
    ),
    sampleEvery: clampedInteger(
        options.sampleEvery,
        CK_TRACE_DEFAULT_SAMPLE_EVERY,
        1,
        1024,
    ),
    // A hard 10 ms lower bound keeps even an explicitly customized trace at
    // or below 100 protocol frames per second.
    minIntervalMs: clampedInteger(
        options.minIntervalMs,
        CK_TRACE_DEFAULT_MIN_INTERVAL_MS,
        10,
        1000,
    ),
});

const buildBreakpointExpression = (
    breakpointIds: ReadonlySet<string>,
    tokenToBlockId: Map<string, string>,
): string => {
    const expressions: string[] = [];
    for (const blockId of Array.from(breakpointIds).sort()) {
        const token = encodeDebugBlockToken(blockId);
        tokenToBlockId.set(token, blockId);
        expressions.push(`__ck_debug_token_equals(blockToken, __CK_DEBUG_TEXT("${token}"))`);
    }
    return expressions.length > 0 ? expressions.join(' ||\n        ') : 'false';
};

const buildDebugRuntime = (
    sessionId: string,
    baudRate: number,
    breakpointExpression: string,
    traceOptions: NormalizedBlockTraceOptions | null = null,
    traceBlockCount = 0,
): string => {
    const traceSeenBytes = Math.max(1, Math.ceil(traceBlockCount / 8));
    const traceMinIntervalUs = traceOptions ? traceOptions.minIntervalMs * 1000 : 0;
    const traceRuntime = traceOptions ? `
static const uint16_t __CK_DEBUG_TRACE_NONE = 0xFFFFU;
static uint8_t __ck_debug_trace_seen[${traceSeenBytes}] = {0};
static uint16_t __ck_debug_trace_sample_counter = 0;
static unsigned long __ck_debug_trace_last_emit_us = 0;

static bool __ck_debug_trace_was_seen(uint16_t blockIndex) {
  const uint8_t mask = (uint8_t)(1U << (blockIndex & 7U));
  return (__ck_debug_trace_seen[blockIndex >> 3U] & mask) != 0;
}

static void __ck_debug_trace_mark_seen(uint16_t blockIndex) {
  const uint8_t mask = (uint8_t)(1U << (blockIndex & 7U));
  __ck_debug_trace_seen[blockIndex >> 3U] |= mask;
}

static void __ck_debug_emit_trace(uint16_t blockIndex, unsigned long deviceMicros, bool firstHit) {
  Serial.write((uint8_t)0x1E);
  Serial.print(__CK_DEBUG_TEXT("${CK_DEBUG_PROTOCOL_PREFIX}|${sessionId}|TRACE|"));
  Serial.print(blockIndex);
  Serial.print('|');
  Serial.print(deviceMicros);
  Serial.print('|');
  if (firstHit) Serial.println('F');
  else Serial.println('S');
}

static void __ck_debug_trace(uint16_t blockIndex) {
  if (blockIndex == __CK_DEBUG_TRACE_NONE || blockIndex >= ${traceBlockCount}U) return;

  const bool firstHit = !__ck_debug_trace_was_seen(blockIndex);
  __ck_debug_trace_sample_counter++;
  if (!firstHit && __ck_debug_trace_sample_counter < ${traceOptions.sampleEvery}U) return;

  const unsigned long now = micros();
  if (
    __ck_debug_trace_last_emit_us != 0
    && (unsigned long)(now - __ck_debug_trace_last_emit_us) < ${traceMinIntervalUs}UL
  ) return;

  if (firstHit) __ck_debug_trace_mark_seen(blockIndex);
  __ck_debug_trace_sample_counter = 0;
  __ck_debug_trace_last_emit_us = now;
  __ck_debug_emit_trace(blockIndex, now, firstHit);
}
` : '';
    const checkpointSignature = traceOptions
        ? '__ck_debug_text_t blockToken, uint16_t blockIndex'
        : '__ck_debug_text_t blockToken';
    const traceCheckpoint = traceOptions ? '\n  __ck_debug_trace(blockIndex);\n' : '';

    // Arduino's sketch preprocessor (and CK's direct .ino.cpp updater) always
    // place Arduino.h before sketch declarations. Keeping platform-only AVR
    // headers out of the raw sketch prevents the dependency scanner from
    // treating an inactive #if branch as an ESP32 include-set change.
    return `#if defined(ARDUINO_ARCH_AVR)
typedef const __FlashStringHelper* __ck_debug_text_t;
#define __CK_DEBUG_TEXT(value) F(value)

static char __ck_debug_text_char_at(__ck_debug_text_t value, size_t index) {
  return (char)pgm_read_byte(reinterpret_cast<PGM_P>(value) + index);
}
#else
typedef const char* __ck_debug_text_t;
#define __CK_DEBUG_TEXT(value) value

static char __ck_debug_text_char_at(__ck_debug_text_t value, size_t index) {
  return value[index];
}
#endif

static const uint8_t __CK_DEBUG_NONE = 0;
static const uint8_t __CK_DEBUG_ATTACH = 1;
static const uint8_t __CK_DEBUG_CONTINUE = 2;
static const uint8_t __CK_DEBUG_STEP = 3;
static const uint8_t __CK_DEBUG_STOP = 4;
static const unsigned long __CK_DEBUG_ATTACH_TIMEOUT_MS = 12000UL;
static const unsigned long __CK_DEBUG_READY_INTERVAL_MS = 250UL;

// A debug build remains safe to run as normal firmware. Breakpoints are only
// enabled after the desktop app attaches during the bounded startup window.
static bool __ck_debug_enabled = false;
static bool __ck_debug_step = false;
// A complete command is at most 62 bytes with the normalized 40-character
// session ID, including its newline. It therefore fits the Nano/Uno 64-byte
// HardwareSerial RX ring without relying on heap-backed Arduino String.
static char __ck_debug_input[64];
static uint8_t __ck_debug_input_length = 0;
static bool __ck_debug_input_overflow = false;

static void __ck_debug_emit(__ck_debug_text_t eventName, __ck_debug_text_t detail) {
  Serial.write((uint8_t)0x1E);
  Serial.print(__CK_DEBUG_TEXT("${CK_DEBUG_PROTOCOL_PREFIX}|${sessionId}|"));
  Serial.print(eventName);
  if (detail != nullptr) {
    Serial.print('|');
    Serial.print(detail);
  }
  Serial.println();
}

static bool __ck_debug_input_equals(__ck_debug_text_t expected) {
  size_t index = 0;
  while (true) {
    const char expectedChar = __ck_debug_text_char_at(expected, index);
    if (__ck_debug_input[index] != expectedChar) return false;
    if (expectedChar == '\\0') return true;
    index++;
  }
}

static bool __ck_debug_token_equals(__ck_debug_text_t left, __ck_debug_text_t right) {
  size_t index = 0;
  while (true) {
    const char leftChar = __ck_debug_text_char_at(left, index);
    const char rightChar = __ck_debug_text_char_at(right, index);
    if (leftChar != rightChar) return false;
    if (leftChar == '\\0') return true;
    index++;
  }
}

static void __ck_debug_idle() {
#if defined(ARDUINO_ARCH_AVR)
  // Service an explicitly enabled AVR watchdog without introducing a
  // platform-only header into the raw cross-board sketch.
  __asm__ __volatile__("wdr");
#endif
  yield();
  delay(1);
}

static uint8_t __ck_debug_poll_command() {
  while (Serial.available() > 0) {
    const char incoming = (char)Serial.read();
    if (incoming == '\\n') {
      uint8_t command = __CK_DEBUG_NONE;
      if (!__ck_debug_input_overflow) {
        __ck_debug_input[__ck_debug_input_length] = '\\0';
        if (__ck_debug_input_equals(__CK_DEBUG_TEXT("${CK_DEBUG_PROTOCOL_PREFIX}|${sessionId}|CMD|ATTACH"))) {
          command = __CK_DEBUG_ATTACH;
        } else if (__ck_debug_input_equals(__CK_DEBUG_TEXT("${CK_DEBUG_PROTOCOL_PREFIX}|${sessionId}|CMD|CONTINUE"))) {
          command = __CK_DEBUG_CONTINUE;
        } else if (__ck_debug_input_equals(__CK_DEBUG_TEXT("${CK_DEBUG_PROTOCOL_PREFIX}|${sessionId}|CMD|STEP"))) {
          command = __CK_DEBUG_STEP;
        } else if (__ck_debug_input_equals(__CK_DEBUG_TEXT("${CK_DEBUG_PROTOCOL_PREFIX}|${sessionId}|CMD|STOP"))) {
          command = __CK_DEBUG_STOP;
        }
      }
      __ck_debug_input_length = 0;
      __ck_debug_input_overflow = false;
      if (command != __CK_DEBUG_NONE) return command;
    } else if (incoming != '\\r') {
      if (!__ck_debug_input_overflow && __ck_debug_input_length < sizeof(__ck_debug_input) - 1) {
        __ck_debug_input[__ck_debug_input_length++] = incoming;
      } else {
        __ck_debug_input_overflow = true;
      }
    }
  }
  return __CK_DEBUG_NONE;
}

static bool __ck_debug_is_breakpoint(__ck_debug_text_t blockToken) {
  return ${breakpointExpression};
}
${traceRuntime}

static void __ck_debug_checkpoint(${checkpointSignature}) {
  if (!__ck_debug_enabled) return;

  const uint8_t pending = __ck_debug_poll_command();
  if (pending == __CK_DEBUG_STOP) {
    __ck_debug_enabled = false;
    __ck_debug_emit(__CK_DEBUG_TEXT("STOPPED"), nullptr);
    return;
  }
  if (pending == __CK_DEBUG_ATTACH) {
    // ATTACH is idempotent after the startup handshake, which lets a serial
    // reconnect verify the same live session without changing execution mode.
    __ck_debug_emit(__CK_DEBUG_TEXT("ATTACHED"), nullptr);
  }
  if (pending == __CK_DEBUG_CONTINUE) __ck_debug_step = false;
  if (pending == __CK_DEBUG_STEP) __ck_debug_step = true;
${traceCheckpoint}

  if (!__ck_debug_step && !__ck_debug_is_breakpoint(blockToken)) return;

  unsigned long lastAnnouncement = 0;
  while (__ck_debug_enabled) {
    const unsigned long now = millis();
    if (lastAnnouncement == 0 || now - lastAnnouncement >= 750) {
      __ck_debug_emit(__CK_DEBUG_TEXT("PAUSED"), blockToken);
      lastAnnouncement = now;
    }

    const uint8_t command = __ck_debug_poll_command();
    if (command == __CK_DEBUG_ATTACH) {
      // Confirm transport reconnection without resuming a paused program.
      __ck_debug_emit(__CK_DEBUG_TEXT("ATTACHED"), nullptr);
    }
    if (command == __CK_DEBUG_CONTINUE) {
      __ck_debug_step = false;
      __ck_debug_emit(__CK_DEBUG_TEXT("RESUMED"), __CK_DEBUG_TEXT("continue"));
      return;
    }
    if (command == __CK_DEBUG_STEP) {
      __ck_debug_step = true;
      __ck_debug_emit(__CK_DEBUG_TEXT("RESUMED"), __CK_DEBUG_TEXT("step"));
      return;
    }
    if (command == __CK_DEBUG_STOP) {
      __ck_debug_enabled = false;
      __ck_debug_step = false;
      __ck_debug_emit(__CK_DEBUG_TEXT("STOPPED"), nullptr);
      return;
    }
    __ck_debug_idle();
  }
}

static void __ck_debug_begin() {
  Serial.begin(${baudRate});
  delay(40);

  __ck_debug_enabled = false;
  __ck_debug_step = false;
  const unsigned long attachStartedAt = millis();
  unsigned long lastReadyAt = 0;
  bool readyAnnounced = false;

  while (millis() - attachStartedAt < __CK_DEBUG_ATTACH_TIMEOUT_MS) {
    const unsigned long now = millis();
    if (!readyAnnounced || now - lastReadyAt >= __CK_DEBUG_READY_INTERVAL_MS) {
      __ck_debug_emit(__CK_DEBUG_TEXT("READY"), nullptr);
      lastReadyAt = now;
      readyAnnounced = true;
    }

    const uint8_t command = __ck_debug_poll_command();
    if (command == __CK_DEBUG_ATTACH) {
      __ck_debug_enabled = true;
      __ck_debug_emit(__CK_DEBUG_TEXT("ATTACHED"), nullptr);
      return;
    }
    if (command == __CK_DEBUG_STOP) {
      __ck_debug_emit(__CK_DEBUG_TEXT("STOPPED"), nullptr);
      return;
    }
    __ck_debug_idle();
  }

  // No desktop debugger attached. Continue through the user's setup/loop as a
  // normal sketch; checkpoints stay inert for the lifetime of this boot.
  __ck_debug_enabled = false;
  __ck_debug_step = false;
}`;
};

export const createDebugSketch = (
    sourceCode: string,
    breakpointIds: ReadonlySet<string>,
    rawSessionId: string,
): DebugSketchResult => {
    const sessionId = normalizeSessionId(rawSessionId);
    const source = String(sourceCode || '').replace(/\r\n/g, '\n');
    if (!/\bvoid\s+setup\s*\(\s*\)\s*\{/.test(source)) {
        throw new Error('生成代码中没有找到 setup()，无法启动积木调试');
    }

    const tokenToBlockId = new Map<string, string>();
    const breakpointExpression = buildBreakpointExpression(breakpointIds, tokenToBlockId);
    const baudRate = detectDebugBaudRate(source);
    const instrumented = instrumentDebugStatements(source, tokenToBlockId);

    const runtime = buildDebugRuntime(sessionId, baudRate, breakpointExpression);
    const codeWithSetupHook = instrumented.code.replace(
        /\bvoid\s+setup\s*\(\s*\)\s*\{/,
        'void setup() {\n  __ck_debug_begin();',
    );
    // Keep every debugger declaration ahead of user procedures. Arduino's sketch
    // preprocessor may synthesize prototypes before function bodies, while the fast
    // relink path can compile the rewritten translation unit directly. Placing the
    // runtime first makes both paths agree and lets a procedure before setup() call
    // an injected checkpoint safely.
    const codeWithRuntime = `${runtime}\n\n${codeWithSetupHook}`;
    const missingBreakpointIds = Array.from(breakpointIds)
        .filter((blockId) => !instrumented.instrumentedBlockIds.has(blockId))
        .sort();

    return {
        code: codeWithRuntime,
        baudRate,
        sessionId,
        tokenToBlockId,
        instrumentedBlockIds: instrumented.instrumentedBlockIds,
        missingBreakpointIds,
    };
};

/**
 * Builds a non-pausing trace firmware using the existing ATTACH/STOP transport.
 * The regular breakpoint build remains byte-for-byte on its original path:
 * TRACE support is only emitted when this separate entry point is used.
 *
 * Counts observed by the desktop are sampled hits, not exact execution counts.
 * Firmware applies both a checkpoint sampler and a hard global frame interval.
 */
export const createTraceSketch = (
    sourceCode: string,
    rawSessionId: string,
    options: BlockTraceBuildOptions = {},
): TraceSketchResult => {
    const sessionId = normalizeSessionId(rawSessionId);
    const source = String(sourceCode || '').replace(/\r\n/g, '\n');
    if (!/\bvoid\s+setup\s*\(\s*\)\s*\{/.test(source)) {
        throw new Error('生成代码中没有找到 setup()，无法启动积木轨迹');
    }

    const traceOptions = normalizeTraceOptions(options);
    const tokenToBlockId = new Map<string, string>();
    const baudRate = detectDebugBaudRate(source);
    const instrumented = instrumentDebugStatements(
        source,
        tokenToBlockId,
        traceOptions.maxTrackedBlocks,
    );
    const runtime = buildDebugRuntime(
        sessionId,
        baudRate,
        'false',
        traceOptions,
        instrumented.traceIndexToBlockId.size,
    );
    const codeWithSetupHook = instrumented.code.replace(
        /\bvoid\s+setup\s*\(\s*\)\s*\{/,
        'void setup() {\n  __ck_debug_begin();',
    );
    const codeWithRuntime = `${runtime}\n\n${codeWithSetupHook}`;
    const tracedBlockIds = new Set(instrumented.traceIndexToBlockId.values());

    return {
        code: codeWithRuntime,
        baudRate,
        sessionId,
        tokenToBlockId,
        instrumentedBlockIds: instrumented.instrumentedBlockIds,
        missingBreakpointIds: [],
        traceIndexToBlockId: instrumented.traceIndexToBlockId,
        tracedBlockIds,
        omittedTraceBlockIds: Array.from(instrumented.omittedTraceBlockIds).sort(),
        traceLimits: {
            maxTrackedBlocks: traceOptions.maxTrackedBlocks,
            trackedBlockCount: tracedBlockIds.size,
            sampleEvery: traceOptions.sampleEvery,
            minIntervalMs: traceOptions.minIntervalMs,
            maxFramesPerSecond: Math.floor(1000 / traceOptions.minIntervalMs),
        },
    };
};

export const createDebugCommandLine = (sessionId: string, command: CkDebugCommand): string => (
    `${CK_DEBUG_PROTOCOL_PREFIX}|${normalizeSessionId(sessionId)}|CMD|${command}\n`
);

export const parseDebugFrame = (rawLine: string): CkDebugFrame | null => {
    const normalized = String(rawLine || '').replace(/^\x1e/, '').trim();
    const parts = normalized.split('|');
    if (parts[0] !== CK_DEBUG_PROTOCOL_PREFIX || !parts[1] || !parts[2]) return null;
    const sessionId = parts[1];
    if (parts[2] === 'READY') return { kind: 'ready', sessionId };
    if (parts[2] === 'ATTACHED') return { kind: 'attached', sessionId };
    if (parts[2] === 'PAUSED' && parts[3]) {
        return { kind: 'paused', sessionId, blockToken: parts[3] };
    }
    if (parts[2] === 'TRACE' && parts[3] && parts[4] && (parts[5] === 'F' || parts[5] === 'S')) {
        const traceIndex = Number(parts[3]);
        const deviceMicros = Number(parts[4]);
        if (
            Number.isSafeInteger(traceIndex)
            && traceIndex >= 0
            && traceIndex < 0xFFFF
            && Number.isSafeInteger(deviceMicros)
            && deviceMicros >= 0
            && deviceMicros <= 0xFFFFFFFF
        ) {
            return {
                kind: 'trace',
                sessionId,
                traceIndex,
                deviceMicros,
                firstHit: parts[5] === 'F',
            };
        }
    }
    if (parts[2] === 'RESUMED' && (parts[3] === 'continue' || parts[3] === 'step')) {
        return { kind: 'resumed', sessionId, mode: parts[3] };
    }
    if (parts[2] === 'STOPPED') return { kind: 'stopped', sessionId };
    return null;
};

const serialPayloadToText = (payload: unknown, decoder: TextDecoder): string => {
    if (typeof payload === 'string') return payload;
    if (Array.isArray(payload)) return decoder.decode(new Uint8Array(payload), { stream: true });
    if (payload && typeof payload === 'object') {
        const values = Object.values(payload);
        if (values.every((value) => typeof value === 'number')) {
            return decoder.decode(new Uint8Array(values as number[]), { stream: true });
        }
    }
    return '';
};

export class CkDebugStreamParser {
    private readonly decoder = new TextDecoder('utf-8');
    private buffer = '';

    push(payload: unknown): { frames: CkDebugFrame[]; visibleText: string } {
        this.buffer += serialPayloadToText(payload, this.decoder);
        const frames: CkDebugFrame[] = [];
        let visibleText = '';
        const framedPrefix = `${CK_DEBUG_RECORD_SEPARATOR}${CK_DEBUG_PROTOCOL_PREFIX}|`;

        while (true) {
            // Firmware frames start with an ASCII record separator. This lets a
            // breakpoint be recognized even when user code previously called
            // Serial.print() without a trailing newline.
            const framedStart = this.buffer.indexOf(framedPrefix);
            if (framedStart >= 0) {
                if (framedStart > 0) {
                    visibleText += this.buffer.slice(0, framedStart);
                    this.buffer = this.buffer.slice(framedStart);
                }
                const framedNewline = this.buffer.indexOf('\n');
                if (framedNewline < 0) break;

                const rawFrame = this.buffer.slice(0, framedNewline + 1);
                this.buffer = this.buffer.slice(framedNewline + 1);
                const frame = parseDebugFrame(rawFrame);
                if (frame) frames.push(frame);
                else visibleText += rawFrame.replace(/^\x1e/, '');
                continue;
            }

            // Accept newline-delimited frames from older debug firmware too.
            const newline = this.buffer.indexOf('\n');
            if (newline < 0) break;
            const rawLine = this.buffer.slice(0, newline + 1);
            this.buffer = this.buffer.slice(newline + 1);
            const frame = parseDebugFrame(rawLine);
            if (frame) frames.push(frame);
            else visibleText += rawLine;
        }

        if (this.buffer.length > 8192) {
            visibleText += this.buffer;
            this.buffer = '';
        }
        return { frames, visibleText };
    }

    reset(): void {
        this.buffer = '';
        this.decoder.decode();
    }
}
