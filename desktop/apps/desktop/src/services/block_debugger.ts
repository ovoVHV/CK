import {
    findBlockMarker,
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
    | { kind: 'attached'; sessionId: string; state?: 'running' | 'paused'; blockToken?: string; sequence?: number }
    | { kind: 'paused'; sessionId: string; blockToken: string; sequence?: number }
    | { kind: 'trace'; sessionId: string; traceIndex: number; deviceMicros: number; firstHit: boolean }
    | { kind: 'resumed'; sessionId: string; mode: 'continue' | 'step'; sequence?: number }
    | { kind: 'stopped'; sessionId: string; sequence?: number };

export interface DebugSketchResult {
    code: string;
    baudRate: number;
    sessionId: string;
    tokenToBlockId: Map<string, string>;
    instrumentedBlockIds: Set<string>;
    missingBreakpointIds: string[];
    unsupportedBlockIds: string[];
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
    unsupportedBlockIds: Set<string>;
}

const normalizeSessionId = (value: string): string => {
    const safe = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
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

// Keep offsets and newlines, but never interpret braces/Serial text in comments
// or literals as C++. This scanner admits a conservative statement subset; it
// does not pretend to parse arbitrary C++ or macro-expanded control flow.
const maskCpp = (source: string): string => source.replace(
    /(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\([\s\S]*?\)\1"|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    value => value.replace(/[^\n]/g, ' ').replace(/^ /, value.startsWith('/') ? ' ' : '0'),
);

const maskCppDirectives = (source: string): string => maskCpp(source).replace(
    /^[ \t]*#(?:[^\n]*\\\n)*[^\n]*/gm, value => value.replace(/[^\n]/g, ' '),
);

const setupBodyOffset = (source: string): number => {
    const clean = maskCppDirectives(source);
    let depth = 0;
    let cursor = 0;
    for (const match of clean.matchAll(/\bvoid\s+setup\s*\(\s*(?:void\s*)?\)\s*\{/g)) {
        for (; cursor < match.index!; cursor++) {
            if (clean[cursor] === '{') depth++;
            else if (clean[cursor] === '}') depth--;
        }
        if (depth === 0) return match.index! + match[0].length;
    }
    return -1;
};

const addSetupHook = (source: string): string => {
    const offset = setupBodyOffset(source);
    if (offset < 0) throw new Error('生成代码中没有找到顶层 setup()，无法启动积木调试或轨迹');
    return source.slice(0, offset) + '\n  __ck_debug_begin();' + source.slice(offset);
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
    const unsupportedBlockIds = new Set<string>();
    const outputLines: string[] = [];
    const masked = maskCppDirectives(source);
    // A trailing while is not a new statement. Until the scanner can prove the
    // extent of an arbitrary unbraced do body, refuse instrumentation rather than
    // insert a checkpoint between its body and condition.
    if (/\bdo\b(?!\s*\{)/.test(masked)) {
        throw new Error('调试/轨迹暂不支持无花括号的 do…while，请给循环体添加花括号或使用普通上传。');
    }
    const sourceLines = source.split('\n');
    const maskedLines = masked.split('\n');
    const scopes: boolean[] = [];
    const scopeHeads: string[] = [];
    const parens: string[] = [];
    let brackets = 0;
    let previousToken = '';
    let closedParenHead = '';
    let boundary = false;
    let afterDoBody = false;

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

    for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex++) {
        const line = sourceLines[lineIndex];
        const clean = maskedLines[lineIndex];
        const marker = findBlockMarker(line);
        const blockId = marker?.blockId || '';
        const trimmed = line.trimStart();
        const indentation = line.slice(0, line.length - trimmed.length);
        const executableText = clean.trim();
        const label = /^(?:case\s+[^?:]+|default|[a-zA-Z_]\w*)\s*:(?!:)/.exec(executableText);
        const inFunction = scopes[scopes.length - 1] === true && parens.length === 0 && brackets === 0;
        const unsafeStart = /^(?:[{}#;]|else\b|catch\b)/.test(executableText) || (afterDoBody && /^while\b/.test(executableText));
        const safe = inFunction && boundary && !unsafeStart && !label;
        if (blockId && executableText && safe) {
            outputLines.push(checkpointFor(blockId, indentation));
        }
        const edits: { at: number; length: number; text: string }[] = [];
        if (blockId && inFunction && boundary && label) {
            edits.push({ at: clean.indexOf(label[0]) + label[0].length, length: 0, text: ' ' + checkpointFor(blockId, '') });
        } else if (blockId && executableText && scopes.some(Boolean) && !safe) {
            unsupportedBlockIds.add(blockId);
        }
        for (const match of clean.matchAll(/[a-zA-Z_]\w*|::|[^\s]/g)) {
            const token = match[0];
            if (token === '(') { parens.push(previousToken); boundary = false; }
            else if (token === ')') { closedParenHead = parens.pop() || ''; boundary = false; }
            else if (token === '[') { brackets++; boundary = false; }
            else if (token === ']') { brackets = Math.max(0, brackets - 1); boundary = false; }
            else if (token === '{') {
                const parent = scopes[scopes.length - 1] === true;
                const control = /^(?:if|for|while|switch|catch)$/.test(closedParenHead);
                const functionHead = previousToken === ')' && /^[a-zA-Z_]\w*$/.test(closedParenHead)
                    && !/^(?:if|for|while|switch|catch|sizeof|alignas|decltype|noexcept)$/.test(closedParenHead);
                const executable = parens.length === 0 && brackets === 0 && (
                    functionHead || (parent && ((previousToken === ')' && control) || /^(?:else|do|try|\{|\}|;)$/.test(previousToken)))
                );
                scopes.push(executable); boundary = executable;
                scopeHeads.push(previousToken === ')' ? closedParenHead : previousToken);
                if (executable && parent && ((previousToken === ')' && /^(?:for|while)$/.test(closedParenHead)) || previousToken === 'do')) {
                    edits.push({ at: match.index! + 1, length: 0, text: ' __ck_debug_service(); ' });
                }
            } else if (token === '}') {
                boundary = scopes.pop() === true && scopes[scopes.length - 1] === true;
                afterDoBody = scopeHeads.pop() === 'do';
            } else if (token === ';') { boundary = parens.length === 0 && brackets === 0; }
            else if (token === ':' && label) { boundary = true; }
            else { boundary = false; }
            // Cooperative delays belong only to instrumented user code, never
            // runtime code or a member function with the same name.
            if (token === 'delay' && scopes[scopes.length - 1] === true && !['.', '::', '>'].includes(previousToken)
                && /^\s*\(/.test(clean.slice(match.index! + token.length))) {
                edits.push({ at: match.index!, length: token.length, text: '__ck_debug_delay' });
            }
            previousToken = token;
            if (token === 'while' || token === ';') afterDoBody = false;
        }
        let rewritten = line;
        for (const edit of edits.sort((a, b) => b.at - a.at)) rewritten = rewritten.slice(0, edit.at) + edit.text + rewritten.slice(edit.at + edit.length);
        outputLines.push(rewritten);
    }

    for (const blockId of instrumentedBlockIds) unsupportedBlockIds.delete(blockId);
    return {
        code: outputLines.join('\n'),
        instrumentedBlockIds,
        traceIndexToBlockId,
        omittedTraceBlockIds,
        unsupportedBlockIds,
    };
};

export const extractInstrumentableBlockIds = (code: string): Set<string> => {
    const source = String(code || '').replace(/\r\n/g, '\n');
    // Eligibility runs while editing, before a user requests instrumentation.
    // Keep the ordinary editor usable for syntax we reject at upload time.
    if (/\bdo\b(?!\s*\{)/.test(maskCppDirectives(source))) return new Set();
    return instrumentDebugStatements(source, new Map()).instrumentedBlockIds;
};

const detectDebugBaudRate = (code: string): number => {
    const clean = maskCpp(code);
    // Serial RX is exclusively owned by the debug protocol. Reject every direct
    // use except the output/configuration operations we can account for.
    for (const use of clean.matchAll(/\bSerial\b/g)) {
        const tail = clean.slice(use.index! + 6);
        if (!/^\s*\.\s*(?:begin|print|println|write|flush)\s*\(/.test(tail)) {
            throw new Error('当前程序会读取或复用 Serial，无法与调试/轨迹命令共用；请改用其他串口或普通上传。');
        }
    }
    const rates: number[] = [];
    for (const match of clean.matchAll(/\bSerial\s*\.\s*begin\s*\(([^)]*)\)/g)) {
        let expression = match[1].trim();
        if (/^[A-Za-z_]\w*$/.test(expression)) {
            const declaration = new RegExp(`\\b(?:const|constexpr)\\s+(?:(?:unsigned|long|int|uint32_t|uint16_t|auto)\\s+)+${expression}\\s*=\\s*((?:0x[0-9a-f]+|[0-9]+)[uUlL]*)\\s*;`, 'i').exec(clean);
            if (declaration) expression = declaration[1];
        }
        if (!/^(?:0x[\da-f]+|\d+)[uUlL]*$/i.test(expression)) throw new Error('调试串口波特率必须是确定的数字或整数常量；当前表达式无法确认，请使用固定波特率或普通上传。');
        const baud = Number(expression.replace(/[uUlL]+$/, ''));
        if (!Number.isSafeInteger(baud) || baud < 300 || baud > 2_000_000) throw new Error('调试串口波特率不在支持范围内。');
        rates.push(baud);
    }
    if (new Set(rates).size > 1) throw new Error('程序会切换 Serial 波特率，无法保持调试连接；请使用其他串口或普通上传。');
    return rates[0] ?? CK_DEBUG_DEFAULT_BAUD;
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
  const unsigned long now = micros();

  // A block's first observed checkpoint is bounded to one frame per tracked
  // block. Emit it immediately and in execution order instead of letting the
  // steady-state sampler/minimum interval hide B/C behind an earlier A frame.
  // Serial writes are synchronous, so these bounded first-hit frames retain
  // the same order in which checkpoints reached this function.
  if (firstHit) {
    __ck_debug_trace_mark_seen(blockIndex);
    __ck_debug_trace_sample_counter = 0;
    __ck_debug_trace_last_emit_us = now;
    __ck_debug_emit_trace(blockIndex, now, true);
    return;
  }

  __ck_debug_trace_sample_counter++;
  if (__ck_debug_trace_sample_counter < ${traceOptions.sampleEvery}U) return;

  if (
    __ck_debug_trace_last_emit_us != 0
    && (unsigned long)(now - __ck_debug_trace_last_emit_us) < ${traceMinIntervalUs}UL
  ) return;

  __ck_debug_trace_sample_counter = 0;
  __ck_debug_trace_last_emit_us = now;
  __ck_debug_emit_trace(blockIndex, now, false);
}
` : '';
    const checkpointSignature = traceOptions
        ? '__ck_debug_text_t blockToken, uint16_t blockIndex'
        : '__ck_debug_text_t blockToken';
    const traceCheckpoint = traceOptions ? '\n  __ck_debug_trace(blockIndex);\n' : '';

    return `#include <Arduino.h>
#if defined(ARDUINO_ARCH_AVR)
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
// 24-character session + CONTINUE + uint32 sequence + newline fits in the
// Nano/Uno 64-byte RX ring without heap-backed strings.
static char __ck_debug_input[64];
static uint8_t __ck_debug_input_length = 0;
static bool __ck_debug_input_overflow = false;
static unsigned long __ck_debug_sequence = 0;

static void __ck_debug_emit(__ck_debug_text_t eventName, __ck_debug_text_t detail) {
  Serial.write((uint8_t)0x1E);
  Serial.print(__CK_DEBUG_TEXT("${CK_DEBUG_PROTOCOL_PREFIX}|${sessionId}|"));
  Serial.print(eventName);
  if (detail != nullptr) {
    Serial.print('|');
    Serial.print(detail);
  }
  Serial.print('|');
  Serial.println(__ck_debug_sequence);
}

static void __ck_debug_attached(__ck_debug_text_t pausedToken) {
  if (pausedToken == nullptr) {
    __ck_debug_emit(__CK_DEBUG_TEXT("ATTACHED"), __CK_DEBUG_TEXT("RUNNING"));
  } else {
    Serial.write((uint8_t)0x1E);
    Serial.print(__CK_DEBUG_TEXT("${CK_DEBUG_PROTOCOL_PREFIX}|${sessionId}|ATTACHED|PAUSED|"));
    Serial.print(pausedToken);
    Serial.print('|');
    Serial.println(__ck_debug_sequence);
  }
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
        unsigned long sequence = 0;
        int separator = (int)__ck_debug_input_length - 1;
        while (separator >= 0 && __ck_debug_input[separator] != '|') separator--;
        bool numbered = separator >= 0 && separator + 1 < __ck_debug_input_length;
        for (int i = separator + 1; numbered && i < __ck_debug_input_length; ++i) {
          const char digit = __ck_debug_input[i];
          if (digit < '0' || digit > '9' || sequence > 429496729UL || (sequence == 429496729UL && digit > '5')) numbered = false;
          else sequence = sequence * 10UL + (unsigned long)(digit - '0');
        }
        if (numbered) __ck_debug_input[separator] = '\\0';
        if (__ck_debug_input_equals(__CK_DEBUG_TEXT("${CK_DEBUG_PROTOCOL_PREFIX}|${sessionId}|CMD|ATTACH"))) {
          command = __CK_DEBUG_ATTACH;
        } else if (__ck_debug_input_equals(__CK_DEBUG_TEXT("${CK_DEBUG_PROTOCOL_PREFIX}|${sessionId}|CMD|CONTINUE"))) {
          command = __CK_DEBUG_CONTINUE;
        } else if (__ck_debug_input_equals(__CK_DEBUG_TEXT("${CK_DEBUG_PROTOCOL_PREFIX}|${sessionId}|CMD|STEP"))) {
          command = __CK_DEBUG_STEP;
        } else if (__ck_debug_input_equals(__CK_DEBUG_TEXT("${CK_DEBUG_PROTOCOL_PREFIX}|${sessionId}|CMD|STOP"))) {
          command = __CK_DEBUG_STOP;
        }
        if (command != __CK_DEBUG_NONE) {
          if (numbered && sequence > __ck_debug_sequence) __ck_debug_sequence = sequence;
          else if (numbered || __ck_debug_sequence != 0) command = __CK_DEBUG_NONE;
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

static void __ck_debug_service() {
  if (!__ck_debug_enabled) return;
  const uint8_t command = __ck_debug_poll_command();
  if (command == __CK_DEBUG_STOP) {
    __ck_debug_enabled = false;
    __ck_debug_step = false;
    __ck_debug_emit(__CK_DEBUG_TEXT("STOPPED"), nullptr);
  } else if (command == __CK_DEBUG_ATTACH) {
    __ck_debug_attached(nullptr);
  }
}

static void __ck_debug_delay(unsigned long duration) {
  if (!__ck_debug_enabled) { delay(duration); return; }
  const unsigned long started = millis();
  while ((unsigned long)(millis() - started) < duration) {
    __ck_debug_service();
    const unsigned long elapsed = millis() - started;
    if (elapsed >= duration) break;
    const unsigned long remaining = duration - elapsed;
    delay(remaining > 10UL ? 10UL : remaining);
  }
}

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
    __ck_debug_attached(nullptr);
  }
${traceOptions ? `${traceCheckpoint}
  // Trace mode never enables step or enters a pause loop, regardless of input.
  return;
}` : `
  if (pending == __CK_DEBUG_CONTINUE) __ck_debug_step = false;
  if (pending == __CK_DEBUG_STEP) __ck_debug_step = true;

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
      __ck_debug_attached(blockToken);
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
}`}

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
      __ck_debug_attached(nullptr);
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
    if (setupBodyOffset(source) < 0) {
        throw new Error('生成代码中没有找到 setup()，无法启动积木调试');
    }

    const tokenToBlockId = new Map<string, string>();
    const breakpointExpression = buildBreakpointExpression(breakpointIds, tokenToBlockId);
    const baudRate = detectDebugBaudRate(source);
    const instrumented = instrumentDebugStatements(source, tokenToBlockId);

    const runtime = buildDebugRuntime(sessionId, baudRate, breakpointExpression);
    const codeWithSetupHook = addSetupHook(instrumented.code);
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
        unsupportedBlockIds: Array.from(instrumented.unsupportedBlockIds),
    };
};

/**
 * Builds a non-pausing trace firmware using the existing ATTACH/STOP transport.
 * Trace sampling and pause control have separate generated checkpoint bodies.
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
    if (setupBodyOffset(source) < 0) {
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
    const codeWithSetupHook = addSetupHook(instrumented.code);
    const codeWithRuntime = `${runtime}\n\n${codeWithSetupHook}`;
    const tracedBlockIds = new Set(instrumented.traceIndexToBlockId.values());

    return {
        code: codeWithRuntime,
        baudRate,
        sessionId,
        tokenToBlockId,
        instrumentedBlockIds: instrumented.instrumentedBlockIds,
        missingBreakpointIds: [],
        unsupportedBlockIds: Array.from(instrumented.unsupportedBlockIds),
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

export const createDebugCommandLine = (sessionId: string, command: CkDebugCommand, sequence?: number): string => (
    `${CK_DEBUG_PROTOCOL_PREFIX}|${normalizeSessionId(sessionId)}|CMD|${command}${sequence == null ? '' : '|' + sequence}\n`
);

export const parseDebugFrame = (rawLine: string): CkDebugFrame | null => {
    const normalized = String(rawLine || '').replace(/^\x1e/, '').trim();
    const parts = normalized.split('|');
    if (parts[0] !== CK_DEBUG_PROTOCOL_PREFIX || !parts[1] || !parts[2]) return null;
    const sessionId = parts[1];
    const sequenceAt = (index: number): { sequence?: number } => {
        const raw = parts[index];
        if (!raw || !/^\d+$/.test(raw)) return {};
        const sequence = Number(raw);
        return Number.isSafeInteger(sequence) && sequence >= 0 && sequence <= 0xFFFFFFFF ? { sequence } : {};
    };
    if (parts[2] === 'READY') return { kind: 'ready', sessionId };
    if (parts[2] === 'ATTACHED') {
        if (parts[3] === 'RUNNING') return { kind: 'attached', sessionId, state: 'running', ...sequenceAt(4) };
        if (parts[3] === 'PAUSED' && parts[4]) return { kind: 'attached', sessionId, state: 'paused', blockToken: parts[4], ...sequenceAt(5) };
        return { kind: 'attached', sessionId };
    }
    if (parts[2] === 'PAUSED' && parts[3]) {
        return { kind: 'paused', sessionId, blockToken: parts[3], ...sequenceAt(4) };
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
        return { kind: 'resumed', sessionId, mode: parts[3], ...sequenceAt(4) };
    }
    if (parts[2] === 'STOPPED') return { kind: 'stopped', sessionId, ...sequenceAt(3) };
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
