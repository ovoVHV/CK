import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./compile_source_map.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'compile_source_map.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter(
        diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
    ),
    [],
    'compile_source_map.ts should transpile without syntax errors',
);

const sourceMapService = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

const {
    CK_COMPILE_SOURCE_MAP_SCHEMA,
    CK_COMPILE_SOURCE_MAP_VERSION,
    compileSourceMapToLegacyLineMap,
    createCompileSourceBoundaryMarkers,
    freezeCompileSourceMap,
    lookupCompileSourceMap,
    normalizeTrustedCompileSketchAlias,
    resolveTrustedCompileDiagnosticFile,
    sha256Hex,
    stripCompileSourceBoundaryMarkers,
    wrapCompileSourceBoundary,
} = sourceMapService;

const trustedAliasFor = (sourceMap, path, runId = 'run-current') => {
    const normalized = path.replace(/\\/g, '/').toLowerCase();
    return normalizeTrustedCompileSketchAlias({
        schemaVersion: 1,
        status: 'trusted',
        runId,
        sourceSha256: sourceMap.codeSha256,
        basename: normalized.slice(normalized.lastIndexOf('/') + 1),
        pathSha256: sha256Hex(normalized),
    });
};

const boundary = (overrides = {}) => ({
    boundaryId: 'boundary-1',
    blockId: 'block-1',
    blockType: 'controls_if',
    section: 'loop',
    confidence: 'exact',
    ...overrides,
});

test('uses a stable UTF-8 SHA-256 for ASCII, Unicode and emoji source', () => {
    for (const code of ['', 'abc', '串口.println("积木🙂");\n']) {
        const expected = createHash('sha256').update(code, 'utf8').digest('hex');
        assert.equal(sha256Hex(code), expected);
        assert.match(sha256Hex(code), /^[0-9a-f]{64}$/);
    }
});

test('freezes an explicit multiline span with Unicode block metadata', () => {
    const fragment = '\n  first();\r\n  second("中文🙂");\r\n';
    const metadata = boundary({
        boundaryId: '边界🙂',
        blockId: '积木*/🙂',
        blockType: '自定义/statement',
        section: 'setup',
        confidence: 'high',
    });
    const wrapped = wrapCompileSourceBoundary(fragment, metadata);
    const frozen = freezeCompileSourceMap(wrapped, { file: 'src/CurrentSketch.ino' });

    assert.equal(stripCompileSourceBoundaryMarkers(wrapped), fragment);
    assert.equal(wrapped.split(/\r\n|\n|\r/).length, fragment.split(/\r\n|\n|\r/).length);
    assert.equal(frozen.schema, CK_COMPILE_SOURCE_MAP_SCHEMA);
    assert.equal(frozen.version, CK_COMPILE_SOURCE_MAP_VERSION);
    assert.equal(frozen.file, 'src/CurrentSketch.ino');
    assert.equal(frozen.codeSha256, sha256Hex(wrapped));
    assert.equal(frozen.mappings.length, 1);
    assert.deepEqual(frozen.mappings[0], {
        file: 'src/CurrentSketch.ino',
        lineStart: 2,
        lineEnd: 3,
        blockId: '积木*/🙂',
        blockType: '自定义/statement',
        section: 'setup',
        confidence: 'high',
    });
    assert.ok(Object.isFrozen(frozen));
    assert.ok(Object.isFrozen(frozen.mappings));
    assert.ok(Object.isFrozen(frozen.mappings[0]));
});

test('a diagnostic caller can require exact/high without promoting a deeper medium mapping', () => {
    const outer = createCompileSourceBoundaryMarkers(boundary({
        boundaryId: 'outer-trusted',
        blockId: 'statement-block',
        section: 'loop',
        confidence: 'exact',
    }));
    const inner = createCompileSourceBoundaryMarkers(boundary({
        boundaryId: 'inner-expression',
        blockId: 'expression-block',
        section: 'expression',
        confidence: 'medium',
    }));
    const code = `value = missing; ${outer.begin} ${inner.begin} ${inner.end} ${outer.end}`;
    const frozen = freezeCompileSourceMap(code);

    assert.equal(lookupCompileSourceMap(frozen, {
        file: 'sketch.ino',
        line: 1,
        code,
    })?.blockId, 'expression-block');
    assert.equal(lookupCompileSourceMap(frozen, {
        file: 'sketch.ino',
        line: 1,
        code,
        acceptedConfidences: ['exact', 'high'],
    })?.blockId, 'statement-block');
    assert.equal(lookupCompileSourceMap(frozen, {
        file: 'sketch.ino',
        line: 1,
        code,
        acceptedConfidences: ['low'],
    }), null);
});

test('paired end markers prevent the final block from leaking through EOF', () => {
    const mappedFragment = wrapCompileSourceBoundary(
        '  first();\n  second();',
        boundary({ blockId: 'last-real-block' }),
    );
    const code = `${mappedFragment}\n}\n\n// compiler trailer\nunrelated();`;
    const frozen = freezeCompileSourceMap(code);
    const legacy = compileSourceMapToLegacyLineMap(frozen);

    assert.equal(frozen.mappings[0].lineStart, 1);
    assert.equal(frozen.mappings[0].lineEnd, 2);
    assert.equal(legacy.get(1), 'last-real-block');
    assert.equal(legacy.get(2), 'last-real-block');
    assert.equal(legacy.has(3), false);
    assert.equal(legacy.has(frozen.lineCount), false);

    const markers = createCompileSourceBoundaryMarkers(
        boundary({ boundaryId: 'never-closed', blockId: 'must-not-guess' }),
    );
    const unclosed = freezeCompileSourceMap(`value(); ${markers.begin}\ntrailer();`);
    assert.equal(unclosed.mappings.length, 0, 'an unclosed begin marker must not map through EOF');
});

test('nested spans select the narrowest mapping deterministically', () => {
    const inner = wrapCompileSourceBoundary(
        '    dangerous();',
        boundary({
            boundaryId: 'inner',
            blockId: 'parent-statement',
            blockType: 'variables_set',
            section: 'expression',
            confidence: 'medium',
        }),
    );
    const code = wrapCompileSourceBoundary(
        `  consume(\n${inner}\n  );`,
        boundary({
            boundaryId: 'outer',
            blockId: 'parent-statement',
            blockType: 'variables_set',
            section: 'loop',
            confidence: 'exact',
        }),
    );
    const frozen = freezeCompileSourceMap(code);
    const expressionLine = code.split('\n').findIndex(line => line.includes('dangerous();')) + 1;
    const hit = lookupCompileSourceMap(frozen, {
        file: 'sketch.ino',
        line: expressionLine,
        code,
    });

    assert.equal(hit?.blockId, 'parent-statement');
    assert.equal(hit?.blockType, 'variables_set');
    assert.equal(hit?.section, 'expression');
    assert.equal(hit?.confidence, 'medium');
});

test('lookup requires the current file and exact compile-session hash', () => {
    const code = wrapCompileSourceBoundary(
        'compile_me();',
        boundary({ blockId: 'current-block' }),
    );
    const frozen = freezeCompileSourceMap(code, { file: 'build/current/CurrentSketch.ino' });
    const request = {
        file: 'build/current/CurrentSketch.ino',
        line: 1,
        code,
    };

    assert.equal(lookupCompileSourceMap(frozen, request)?.blockId, 'current-block');
    assert.equal(lookupCompileSourceMap(frozen, {
        ...request,
        file: 'build/other/CurrentSketch.ino',
    }), null, 'a same-basename file from another build is not the current sketch');
    assert.equal(lookupCompileSourceMap(frozen, {
        ...request,
        file: 'library.cpp',
    }), null, 'library diagnostics must not be guessed');
    assert.equal(lookupCompileSourceMap(frozen, {
        ...request,
        code: `${code}\n// edited after generation`,
    }), null, 'edited code must fail the frozen SHA-256 check');
    assert.equal(lookupCompileSourceMap(frozen, {
        ...request,
        code: undefined,
        codeSha256: frozen.codeSha256,
    })?.blockId, 'current-block');
    assert.equal(lookupCompileSourceMap(frozen, {
        ...request,
        codeSha256: '0'.repeat(64),
    }), null, 'disagreeing supplied and computed hashes must be rejected');
    assert.equal(lookupCompileSourceMap(frozen, {
        file: request.file,
        line: 1,
    }), null, 'hash-free lookup is intentionally unsupported');
    assert.equal(lookupCompileSourceMap({ ...frozen, schema: 'unknown-map' }, request), null);
    assert.equal(lookupCompileSourceMap({ ...frozen, version: 2 }, request), null);
});

test('trusted backend alias binds one dynamic CK sketch path to logical sketch.ino', () => {
    const code = wrapCompileSourceBoundary(
        'compile_me();',
        boundary({ blockId: 'dynamic-sketch-block' }),
    );
    const frozen = freezeCompileSourceMap(code, { file: 'sketch.ino' });
    const dynamicPath = 'C:\\Users\\AI\\AppData\\Local\\Temp\\CK_Builds\\sketch_board_qfast2\\sketch_board_qfast2.ino';
    const alias = trustedAliasFor(frozen, dynamicPath);

    assert.equal(resolveTrustedCompileDiagnosticFile({
        alias,
        runId: 'run-current',
        sourceMap: frozen,
        diagnosticFile: dynamicPath,
    }), 'sketch.ino');
    assert.equal(resolveTrustedCompileDiagnosticFile({
        alias,
        runId: 'run-current',
        sourceMap: frozen,
        diagnosticFile: `${dynamicPath}.cpp`,
    }), 'sketch.ino', 'the generated .ino.cpp spelling resolves through the same alias');
});

test('trusted alias is fail-closed for library, wrong path, stale run, stale source and revocation', () => {
    const code = wrapCompileSourceBoundary('dangerous();', boundary());
    const frozen = freezeCompileSourceMap(code);
    const dynamicPath = 'C:\\Temp\\CK_Builds\\sketch_board_qfast2\\sketch_board_qfast2.ino';
    const alias = trustedAliasFor(frozen, dynamicPath);
    const resolve = (overrides = {}) => resolveTrustedCompileDiagnosticFile({
        alias,
        runId: 'run-current',
        sourceMap: frozen,
        diagnosticFile: dynamicPath,
        ...overrides,
    });

    assert.equal(resolve({ diagnosticFile: 'C:\\third-party\\evil.ino.cpp' }), null);
    assert.equal(resolve({
        diagnosticFile: 'C:\\Temp\\CK_Builds\\other\\sketch_board_qfast2.ino',
    }), null, 'same basename at a different path is not trusted');
    assert.equal(resolve({ runId: 'run-old' }), null);
    assert.equal(resolve({
        alias: { ...alias, sourceSha256: '0'.repeat(64) },
    }), null);
    assert.equal(resolve({
        alias: normalizeTrustedCompileSketchAlias({
            schemaVersion: 1,
            status: 'revoked',
            runId: 'run-current',
            sourceSha256: frozen.codeSha256,
        }),
    }), null);
    assert.equal(resolve({ diagnosticFile: 'sketch_board_qfast2.ino' }), null,
        'a basename without an authenticated absolute path is insufficient');
});

test('malformed alias payloads never enter the trusted type', () => {
    assert.equal(normalizeTrustedCompileSketchAlias(null), null);
    assert.equal(normalizeTrustedCompileSketchAlias({
        schemaVersion: 1,
        status: 'trusted',
        runId: 'run',
        sourceSha256: '0'.repeat(64),
        basename: '../sketch.ino',
        pathSha256: '1'.repeat(64),
    }), null);
    assert.equal(normalizeTrustedCompileSketchAlias({
        schemaVersion: 1,
        status: 'trusted',
        runId: 'run',
        sourceSha256: 'not-a-sha',
        basename: 'sketch.ino',
        pathSha256: '1'.repeat(64),
    }), null);
});

test('inline boundaries preserve line offsets used by debug markers', () => {
    const original = [
        'void loop() {',
        '  first(); /* @ck:v1:6669727374 */',
        '  second(); /* @ck:v1:7365636f6e64 */',
        '}',
    ].join('\n');
    const lines = original.split('\n');
    lines[1] = wrapCompileSourceBoundary(lines[1], boundary({ boundaryId: 'debug-1' }));
    lines[2] = wrapCompileSourceBoundary(lines[2], boundary({ boundaryId: 'debug-2' }));
    const wrapped = lines.join('\n');

    assert.equal(wrapped.split('\n').length, original.split('\n').length);
    assert.equal(stripCompileSourceBoundaryMarkers(wrapped), original);
    assert.equal(wrapped.split('\n').findIndex(line => line.includes('@ck:v1:6669727374')), 1);
    assert.equal(wrapped.split('\n').findIndex(line => line.includes('@ck:v1:7365636f6e64')), 2);
});
