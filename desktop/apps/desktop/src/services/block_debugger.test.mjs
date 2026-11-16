import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const transpile = (source, fileName) => ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName,
    reportDiagnostics: true,
});

const markerSourcePath = new URL('./block_markers.ts', import.meta.url);
const markerSource = await readFile(markerSourcePath, 'utf8');
const markerTranspiled = transpile(markerSource, 'block_markers.ts');
const markerSyntaxErrors = (markerTranspiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(markerSyntaxErrors, [], 'block_markers.ts should transpile without syntax errors');
const markerModuleUrl = `data:text/javascript;base64,${Buffer.from(markerTranspiled.outputText).toString('base64')}`;

const sourcePath = new URL('./block_debugger.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const transpiled = transpile(source, 'block_debugger.ts');

const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'block_debugger.ts should transpile without syntax errors');

const debuggerOutput = transpiled.outputText.replace(
    /from ['"]\.\/block_markers['"];/,
    `from '${markerModuleUrl}';`,
);
assert.notEqual(debuggerOutput, transpiled.outputText, 'block marker import should be rewritten for the test loader');
const debuggerService = await import(
    `data:text/javascript;base64,${Buffer.from(debuggerOutput).toString('base64')}`
);

const markerService = await import(markerModuleUrl);
const {
    createBlockMarkerComment,
    decodeBlockMarkerPayload,
    encodeBlockMarkerPayload,
    findBlockMarker,
    stripBlockMarkerComments,
} = markerService;

const {
    CkDebugStreamParser,
    createDebugCommandLine,
    createDebugSketch,
    createTraceSketch,
    encodeDebugBlockToken,
    extractDebuggableBlockIds,
    extractInstrumentableBlockIds,
    parseDebugFrame,
} = debuggerService;

const marker = id => createBlockMarkerComment(id);

const sourceSketch = `#include <Arduino.h>
int globalValue = 1; ${marker('global')}

void setup() {
  Serial.begin(9600); ${marker('serial')}
}

void loop() {
  if (globalValue > 0) { ${marker('if-block')}
    globalValue--; ${marker('decrement')}
  }
  // WiFi.begin is emitted in setup ${marker('comment-only')}
}`;

test('round-trips safe source markers for comment terminators and Unicode IDs', () => {
    const blockIds = ['plain', 'a*/b', '中文积木', 'pipe|id', 'space id', '*/|混合'];
    for (const blockId of blockIds) {
        const payload = encodeBlockMarkerPayload(blockId);
        const comment = createBlockMarkerComment(blockId);
        assert.equal(decodeBlockMarkerPayload(payload), blockId);
        assert.equal((comment.match(/\*\//g) || []).length, 1, `marker must not contain an early terminator: ${blockId}`);
        assert.deepEqual(findBlockMarker(`statement(); ${comment}`)?.blockId, blockId);
        assert.equal(stripBlockMarkerComments(`statement(); ${comment}`), 'statement();');
    }

    assert.equal(findBlockMarker('x(); /* @ck:legacy-id */')?.blockId, 'legacy-id');
    assert.equal(findBlockMarker('x(); /* @ck:v1:not-hex */')?.blockId, 'v1:not-hex');
});

test('extracts marker IDs and encodes arbitrary Blockly IDs safely', () => {
    const ids = extractDebuggableBlockIds(sourceSketch);
    assert.equal(ids.has('if-block'), true);
    assert.equal(ids.has('decrement'), true);
    assert.equal(encodeDebugBlockToken('a*/中'), '612a2fe4b8ad');
    const instrumentable = extractInstrumentableBlockIds(sourceSketch);
    assert.equal(instrumentable.has('if-block'), true);
    assert.equal(instrumentable.has('comment-only'), false);
    assert.equal(instrumentable.has('global'), false);
});

test('builds a debug sketch without changing global or comment-only code into checkpoints', () => {
    const breakpoints = new Set(['if-block', 'comment-only', 'missing']);
    const result = createDebugSketch(sourceSketch, breakpoints, 'session_123');

    assert.equal(result.baudRate, 9600);
    assert.match(result.code, /Serial\.begin\(9600\);/);
    assert.match(result.code, /__ck_debug_begin\(\);/);
    assert.match(result.code, /__ck_debug_checkpoint\(__CK_DEBUG_TEXT\("69662d626c6f636b"\)\);\n  if/);
    assert.match(result.code, /__ck_debug_checkpoint\(__CK_DEBUG_TEXT\("64656372656d656e74"\)\);\n    globalValue--/);
    assert.doesNotMatch(result.code, /__ck_debug_checkpoint\(__CK_DEBUG_TEXT\("676c6f62616c"\)/);
    assert.doesNotMatch(result.code, /__ck_debug_checkpoint\(__CK_DEBUG_TEXT\("636f6d6d656e742d6f6e6c79"\)/);
    assert.deepEqual(result.missingBreakpointIds, ['comment-only', 'missing']);
    assert.equal(result.tokenToBlockId.get('69662d626c6f636b'), 'if-block');
});

test('declares the debug runtime before user procedures for CLI and fast relink builds', () => {
    const sketch = `#include <Arduino.h>
void helper() {
  delay(1); ${marker('helper-delay')}
}

void setup() {
  helper(); ${marker('helper-call')}
}

void loop() {}
`;
    const result = createDebugSketch(sketch, new Set(['helper-delay']), 'procedure_session');
    const runtimeDeclaration = result.code.indexOf('static void __ck_debug_checkpoint');
    const helperDefinition = result.code.indexOf('void helper()');

    assert.ok(runtimeDeclaration >= 0, 'debug runtime declaration should exist');
    assert.ok(helperDefinition >= 0, 'user helper should exist');
    assert.ok(runtimeDeclaration < helperDefinition, 'runtime must precede a user procedure checkpoint');
    assert.match(result.code, /__ck_debug_checkpoint\(__CK_DEBUG_TEXT\("68656c7065722d64656c6179"\)\);\n  __ck_debug_delay/);
    assert.doesNotMatch(result.code, /enum __CkDebugCommand/);
    assert.doesNotMatch(result.code, /detail\s*=\s*nullptr/);
    assert.match(result.code, /__ck_debug_emit\(__CK_DEBUG_TEXT\("READY"\), nullptr\);/);
});

test('requires a bounded ATTACH handshake before enabling firmware breakpoints', () => {
    const result = createDebugSketch(sourceSketch, new Set(['if-block']), 'attach_session');

    assert.match(result.code, /static bool __ck_debug_enabled = false;/);
    assert.match(result.code, /__CK_DEBUG_ATTACH_TIMEOUT_MS = 12000UL;/);
    assert.match(result.code, /__CK_DEBUG_READY_INTERVAL_MS = 250UL;/);
    assert.match(result.code, /while \(millis\(\) - attachStartedAt < __CK_DEBUG_ATTACH_TIMEOUT_MS\)/);
    assert.match(result.code, /CMD\|ATTACH/);
    assert.match(
        result.code,
        /if \(command == __CK_DEBUG_ATTACH\) \{\n\s+__ck_debug_enabled = true;\n\s+__ck_debug_attached\(nullptr\);\n\s+return;/,
    );
    assert.match(
        result.code,
        /No desktop debugger attached[\s\S]*__ck_debug_enabled = false;\n\s+__ck_debug_step = false;/,
    );
});

test('builds a separately bounded non-pausing trace firmware', () => {
    const result = createTraceSketch(sourceSketch, 'trace_session', {
        maxTrackedBlocks: 2,
        sampleEvery: 3,
        minIntervalMs: 1,
    });

    assert.equal(result.traceLimits.maxTrackedBlocks, 2);
    assert.equal(result.traceLimits.trackedBlockCount, 2);
    assert.equal(result.traceLimits.sampleEvery, 3);
    assert.equal(result.traceLimits.minIntervalMs, 10, 'hard frame-rate floor should clamp to 10ms');
    assert.equal(result.traceLimits.maxFramesPerSecond, 100);
    assert.equal(result.traceIndexToBlockId.size, 2);
    assert.ok(result.omittedTraceBlockIds.length > 0);
    assert.match(result.code, /static const uint16_t __CK_DEBUG_TRACE_NONE = 0xFFFFU;/);
    assert.match(result.code, /static uint8_t __ck_debug_trace_seen\[1\] = \{0\};/);
    assert.match(result.code, /__ck_debug_trace_sample_counter < 3U/);
    assert.match(result.code, /< 10000UL/);
    assert.match(result.code, /TRACE\|/);
    assert.match(result.code, /__ck_debug_checkpoint\(__CK_DEBUG_TEXT\("[0-9a-f]+"\), (?:\d+U|__CK_DEBUG_TRACE_NONE)\);/);
    assert.match(result.code, /static bool __ck_debug_is_breakpoint[\s\S]*return false;/);

    const firstHitBranch = result.code.indexOf('if (firstHit) {');
    const steadySampleGate = result.code.indexOf('__ck_debug_trace_sample_counter < 3U');
    const steadyIntervalGate = result.code.indexOf('< 10000UL');
    assert.ok(firstHitBranch >= 0, 'first-hit branch should exist');
    assert.ok(firstHitBranch < steadySampleGate, 'first-hit evidence must bypass the steady-state sample gate');
    assert.ok(firstHitBranch < steadyIntervalGate, 'first-hit evidence must bypass the steady-state interval gate');
    assert.match(
        result.code,
        /if \(firstHit\) \{[\s\S]*__ck_debug_trace_mark_seen\(blockIndex\);[\s\S]*__ck_debug_emit_trace\(blockIndex, now, true\);[\s\S]*return;/,
    );

    const normal = createDebugSketch(sourceSketch, new Set(['if-block']), 'normal_session');
    assert.doesNotMatch(normal.code, /TRACE\|/);
    assert.doesNotMatch(normal.code, /__CK_DEBUG_TRACE_NONE/);
});

test('places switch case checkpoints after labels', () => {
    const sketch = `void setup() {}\nvoid loop() {\n  switch (1) {\n    case 1: ${marker('case-one')}\n      break;\n  }\n}`;
    const result = createDebugSketch(sketch, new Set(['case-one']), 'case_session');
    assert.match(result.code, /case 1: __ck_debug_checkpoint\(__CK_DEBUG_TEXT\("636173652d6f6e65"\)\);/);
});

test('keeps AVR debugger commands within the 64-byte RX ring and avoids heap-backed strings', () => {
    const result = createDebugSketch(
        `void setup() {}
void loop() {
  delay(1); ${marker('tick')}
}`,
        new Set(['tick']),
        's'.repeat(80),
    );
    const longestCommand = createDebugCommandLine(result.sessionId, 'CONTINUE', 4294967295);

    assert.equal(result.sessionId.length, 24);
    assert.ok(Buffer.byteLength(longestCommand, 'utf8') < 64);
    assert.match(result.code, /static char __ck_debug_input\[64\];/);
    assert.doesNotMatch(result.code, /static String __ck_debug_input/);
    assert.match(result.code, /typedef const __FlashStringHelper\* __ck_debug_text_t;/);
    assert.match(result.code, /#define __CK_DEBUG_TEXT\(value\) F\(value\)/);
    assert.match(result.code, /__ck_debug_checkpoint\(__CK_DEBUG_TEXT\("7469636b"\)\)/);
    assert.match(result.code, /__asm__ __volatile__\("wdr"\);/);
    assert.match(result.code, /yield\(\);\n  delay\(1\);/);
    assert.ok(result.code.startsWith('#include <Arduino.h>\n'));
});

test('does not split unbraced control bodies or inspect braces in comments/literals', () => {
    const source = `void setup() {}\nvoid loop() {\n/* unmatched } */\nif(false)\n  tick(); ${marker('unsafe')}\nconst char* s = "{if(Serial.read())}"; ${marker('safe')}\n}`;
    const result = createDebugSketch(source, new Set(['unsafe', 'safe']), 'subset');
    assert.deepEqual(result.missingBreakpointIds, ['unsafe']);
    assert.deepEqual(result.unsupportedBlockIds, ['unsafe']);
    assert.ok(result.instrumentedBlockIds.has('safe'));
    assert.match(result.code, /if\(false\)\n  tick\(\);/);
});

test('rejects all shared Serial RX and alias uses and resolves literal integer constants', () => {
    for (const use of ['Serial.readStringUntil(10)', 'Serial.readBytes(buf, 5)', 'Serial.readBytesUntil(10, buf, 5)', 'Serial.peek()', 'Serial.parseInt()', 'auto& alias = Serial']) {
        assert.throws(() => createTraceSketch(`void setup() {}\nvoid loop(){\n${use}; ${marker('rx')}\n}`, 'serial'), /Serial/);
    }
    const source = 'const unsigned long BAUD = 9600;\nvoid setup(){Serial.begin(BAUD);}\nvoid loop(){}';
    assert.equal(createTraceSketch(source, 'baud').baudRate, 9600);
    assert.throws(() => createTraceSketch('void setup(){Serial.begin(getBaud());}\nvoid loop(){}', 'baud'), /波特率/);
    assert.throws(() => createTraceSketch('void setup(){Serial.begin(9600);}\nvoid loop(){Serial.begin(115200);}', 'baud'), /切换/);
});

test('hooks the actual top-level setup and leaves comment/string decoys intact', () => {
    const source = `// void setup() {\nconst char* decoy = "void setup() {";\nstruct Example { void setup() {} };\nvoid /* gap */ setup(void) {\n tick(); ${marker('real')}\n}\nvoid loop() {}`;
    for (const result of [createDebugSketch(source, new Set(['real']), 'hook'), createTraceSketch(source, 'hook')]) {
        assert.match(result.code, /void \/\* gap \*\/ setup\(void\) \{\n  __ck_debug_begin\(\);/);
        assert.match(result.code, /struct Example \{ void setup\(\) \{\} \};/);
        assert.match(result.code, /const char\* decoy = "void setup\(\) \{";/);
    }
    assert.throws(() => createTraceSketch('// void setup() {}\nvoid loop() {}', 'missing'), /setup/);
});

test('refuses unsafe do bodies and never splits a labeled unbraced child', () => {
    const unbraced = `void setup() {}\nvoid loop() {\n do\n tick(); ${marker('body')}\n while(false); ${marker('condition')}\n}`;
    assert.throws(() => createTraceSketch(unbraced, 'do'), /do…while/);
    assert.equal(extractInstrumentableBlockIds(unbraced).size, 0);
    const labeled = `void setup() {}\nvoid loop() {\n if(false)\n label: tick(); ${marker('child-label')}\n tick(); ${marker('tail')}\n}`;
    const result = createDebugSketch(labeled, new Set(['child-label']), 'label');
    assert.deepEqual(result.missingBreakpointIds, ['child-label']);
    assert.match(result.code, /label: tick\(\);/);
});

test('status acknowledgements retain command sequence and actual attachment state', () => {
    assert.equal(createDebugCommandLine('s', 'STEP', 7), '@@CKDBG|s|CMD|STEP|7\n');
    assert.deepEqual(parseDebugFrame('@@CKDBG|s|PAUSED|abc|7'), {kind:'paused',sessionId:'s',blockToken:'abc',sequence:7});
    assert.deepEqual(parseDebugFrame('@@CKDBG|s|ATTACHED|RUNNING|8'), {kind:'attached',sessionId:'s',state:'running',sequence:8});
    assert.deepEqual(parseDebugFrame('@@CKDBG|s|ATTACHED|PAUSED|abc|8'), {kind:'attached',sessionId:'s',state:'paused',blockToken:'abc',sequence:8});
});

test('parses split and joined protocol frames while preserving user serial text', () => {
    const parser = new CkDebugStreamParser();
    let output = parser.push('temperature=21\n@@CKDBG|abc|PA');
    assert.equal(output.visibleText, 'temperature=21\n');
    assert.deepEqual(output.frames, []);

    output = parser.push('USED|6964\n@@CKDBG|abc|RESUMED|step\nplain');
    assert.equal(output.visibleText, '');
    assert.equal(output.frames.length, 2);
    assert.deepEqual(output.frames[0], {
        kind: 'paused',
        sessionId: 'abc',
        blockToken: '6964',
    });
    assert.deepEqual(output.frames[1], {
        kind: 'resumed',
        sessionId: 'abc',
        mode: 'step',
    });

    output = parser.push(' text\n');
    assert.equal(output.visibleText, 'plain text\n');
});

test('recognizes record-separated frames after user output without a newline', () => {
    const parser = new CkDebugStreamParser();
    let output = parser.push('temperature=21\x1e@@CKD');
    assert.equal(output.visibleText, '');
    assert.deepEqual(output.frames, []);

    output = parser.push('BG|abc|PAUSED|68656c70\nnext line\n');
    assert.equal(output.visibleText, 'temperature=21next line\n');
    assert.deepEqual(output.frames, [{
        kind: 'paused',
        sessionId: 'abc',
        blockToken: '68656c70',
    }]);
    assert.deepEqual(parseDebugFrame('\x1e@@CKDBG|abc|STOPPED\r\n'), {
        kind: 'stopped',
        sessionId: 'abc',
    });
});

test('parses bounded TRACE frames and rejects malformed trace payloads', () => {
    assert.deepEqual(parseDebugFrame('\x1e@@CKDBG|trace-1|TRACE|7|4294967295|F\r\n'), {
        kind: 'trace',
        sessionId: 'trace-1',
        traceIndex: 7,
        deviceMicros: 4294967295,
        firstHit: true,
    });
    assert.deepEqual(parseDebugFrame('@@CKDBG|trace-1|TRACE|8|42|S'), {
        kind: 'trace',
        sessionId: 'trace-1',
        traceIndex: 8,
        deviceMicros: 42,
        firstHit: false,
    });
    assert.equal(parseDebugFrame('@@CKDBG|trace-1|TRACE|-1|42|F'), null);
    assert.equal(parseDebugFrame('@@CKDBG|trace-1|TRACE|1|4294967296|F'), null);
    assert.equal(parseDebugFrame('@@CKDBG|trace-1|TRACE|1|42|X'), null);
});

test('preserves A, B, C TRACE frame order across split and coalesced serial chunks', () => {
    const parser = new CkDebugStreamParser();
    let output = parser.push('\x1e@@CKDBG|trace-1|TRACE|0|100|F\n\x1e@@CKDBG|trace-1|TR');
    assert.deepEqual(output.frames.map(frame => frame.kind === 'trace' ? frame.traceIndex : null), [0]);

    output = parser.push('ACE|1|200|F\n\x1e@@CKDBG|trace-1|TRACE|2|300|F\n');
    assert.deepEqual(
        output.frames.map(frame => frame.kind === 'trace' ? frame.traceIndex : null),
        [1, 2],
    );
    assert.deepEqual(
        output.frames.filter(frame => frame.kind === 'trace').map(frame => frame.deviceMicros),
        [200, 300],
    );
});

test('creates scoped commands and rejects unrelated lines', () => {
    assert.equal(createDebugCommandLine('abc-1', 'ATTACH'), '@@CKDBG|abc-1|CMD|ATTACH\n');
    assert.equal(createDebugCommandLine('abc-1', 'CONTINUE'), '@@CKDBG|abc-1|CMD|CONTINUE\n');
    assert.deepEqual(parseDebugFrame('@@CKDBG|abc-1|READY'), {
        kind: 'ready',
        sessionId: 'abc-1',
    });
    assert.deepEqual(parseDebugFrame('@@CKDBG|abc-1|ATTACHED'), {
        kind: 'attached',
        sessionId: 'abc-1',
    });
    assert.equal(parseDebugFrame('hello world'), null);
});
