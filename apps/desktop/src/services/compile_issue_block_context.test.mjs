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

const sourceMapSource = await readFile(new URL('./compile_source_map.ts', import.meta.url), 'utf8');
const sourceMapTranspiled = transpile(sourceMapSource, 'compile_source_map.ts');
assert.deepEqual(
    (sourceMapTranspiled.diagnostics || []).filter(
        diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
    ),
    [],
    'compile_source_map.ts should transpile without syntax errors',
);
const sourceMapUrl = `data:text/javascript;base64,${Buffer.from(sourceMapTranspiled.outputText).toString('base64')}`;

const sourcePath = new URL('./compile_issue_block_context.ts', import.meta.url);
const source = (await readFile(sourcePath, 'utf8'))
    .replaceAll("from './compile_source_map';", `from '${sourceMapUrl}';`);
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'compile_issue_block_context.ts',
    reportDiagnostics: true,
});

const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'compile_issue_block_context.ts should transpile without syntax errors');

const {
    captureCompileIssueBlockPresentations,
    reconcileCompileIssueBlockContexts,
    resolveCompileIssueBlockContext,
} = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`);

const sourceMapService = await import(sourceMapUrl);

const mapping = (overrides = {}) => ({
    file: 'sketch.ino',
    lineStart: 40,
    lineEnd: 44,
    blockId: 'oled-1',
    blockType: 'oled_print',
    section: 'loop',
    confidence: 'exact',
    ...overrides,
});

const sourceMap = mappings => ({
    schema: 'ck-sourcemap',
    version: 1,
    codeSha256: 'a'.repeat(64),
    file: 'sketch.ino',
    lineCount: 80,
    mappings,
});

test('freezes the block label and evidence-backed structural position at compile start', () => {
    const first = {
        id: 'delay-1',
        type: 'delay',
        previousConnection: {},
        nextConnection: {},
        getPreviousBlock: () => null,
        getSurroundParent: () => null,
        toString: () => '延时 1000 毫秒',
    };
    let mutableLabel = 'OLED 显示文字 hello';
    const target = {
        id: 'oled-1',
        type: 'oled_print',
        previousConnection: {},
        nextConnection: {},
        getPreviousBlock: () => first,
        getSurroundParent: () => null,
        toString: () => mutableLabel,
    };
    const workspace = {
        getBlockById: id => id === target.id ? target : null,
    };

    const presentations = captureCompileIssueBlockPresentations(
        workspace,
        sourceMap([mapping()]),
    );
    mutableLabel = '编译后被用户修改的文字';

    const frozen = [...presentations.values()][0];
    assert.equal(frozen.label, 'OLED 显示文字 hello');
    assert.equal(frozen.flowPosition, '主循环 · 当前积木链第 2 项');

    const context = resolveCompileIssueBlockContext({
        id: 'compiler-diagnostic',
        severity: 'error',
        certainty: 'certain',
        title: '源码编译错误',
        summary: 'not declared',
        evidence: 'sketch.ino:42:3: error: not declared',
        sourceLine: 42,
        details: [],
    }, mapping(), presentations);

    assert.deepEqual(context, {
        blockId: 'oled-1',
        blockType: 'oled_print',
        label: 'OLED 显示文字 hello',
        section: 'loop',
        sourceLine: 42,
        flowLocation: '主循环 · 当前积木链第 2 项 · 源码第 42 行',
        confidence: 'exact',
    });
});

test('uses the enclosing flow label when Blockly proves a nested statement position', () => {
    const parent = { toString: () => '如果 温度 > 60' };
    const target = {
        id: 'oled-1',
        type: 'oled_print',
        previousConnection: {},
        nextConnection: {},
        getPreviousBlock: () => null,
        getSurroundParent: () => parent,
        toString: () => 'OLED 显示警告',
    };
    const presentations = captureCompileIssueBlockPresentations(
        { getBlockById: () => target },
        sourceMap([mapping()]),
    );
    assert.equal(
        [...presentations.values()][0].flowPosition,
        '主循环 · “如果 温度 > 60”内第 1 项',
    );
});

test('never binds medium/low mappings, mismatched metadata, or a line outside the range', () => {
    const block = {
        id: 'oled-1',
        type: 'oled_print',
        nextConnection: {},
        toString: () => 'OLED 显示文字',
    };
    const mediumPresentations = captureCompileIssueBlockPresentations(
        { getBlockById: () => block },
        sourceMap([mapping({ confidence: 'medium', section: 'expression' })]),
    );
    assert.equal(mediumPresentations.size, 0);

    const presentations = captureCompileIssueBlockPresentations(
        { getBlockById: () => block },
        sourceMap([mapping()]),
    );
    const issue = {
        id: 'compiler-diagnostic',
        severity: 'error',
        certainty: 'certain',
        title: '源码编译错误',
        summary: 'not declared',
        evidence: 'sketch.ino:70:3: error: not declared',
        sourceLine: 70,
        details: [],
    };
    assert.equal(resolveCompileIssueBlockContext(issue, mapping(), presentations), undefined);
    assert.equal(resolveCompileIssueBlockContext(
        { ...issue, sourceLine: 42 },
        mapping({ blockType: 'different_type' }),
        presentations,
    ), undefined);
});

test('third-party label failures degrade to the block type without breaking diagnostics', () => {
    const presentations = captureCompileIssueBlockPresentations(
        {
            getBlockById: () => ({
                id: 'oled-1',
                type: 'vendor_oled_print',
                toString: () => { throw new Error('renderer failed'); },
            }),
        },
        sourceMap([mapping({ blockType: 'vendor_oled_print', confidence: 'high' })]),
    );
    assert.equal([...presentations.values()][0].label, 'vendor_oled_print');
});

test('omits an ordinal when a third-party connection traversal throws or cycles', () => {
    const throwing = {
        id: 'oled-1',
        type: 'vendor_oled_print',
        nextConnection: {},
        getPreviousBlock: () => { throw new Error('broken connection'); },
        toString: () => '第三方 OLED',
    };
    const throwingPresentations = captureCompileIssueBlockPresentations(
        { getBlockById: () => throwing },
        sourceMap([mapping({ blockType: 'vendor_oled_print' })]),
    );
    assert.equal([...throwingPresentations.values()][0].flowPosition, '主循环');

    const cyclic = {
        id: 'oled-1',
        type: 'vendor_oled_print',
        nextConnection: {},
        toString: () => '第三方 OLED',
    };
    cyclic.getPreviousBlock = () => cyclic;
    const cyclicPresentations = captureCompileIssueBlockPresentations(
        { getBlockById: () => cyclic },
        sourceMap([mapping({ blockType: 'vendor_oled_print' })]),
    );
    assert.equal([...cyclicPresentations.values()][0].flowPosition, '主循环');
});

test('late trusted alias deterministically enriches an already-created compiler card', () => {
    const compileCode = Array.from({ length: 80 }, (_, index) => `line_${index + 1};`).join('\n');
    const dynamicPath = 'C:\\Users\\AI\\AppData\\Local\\Temp\\CK_Builds\\sketch_c6_qfast2\\sketch_c6_qfast2.ino';
    const normalizedPath = dynamicPath.replace(/\\/g, '/').toLowerCase();
    const exactMap = {
        ...sourceMap([mapping()]),
        codeSha256: sourceMapService.sha256Hex(compileCode),
    };
    const block = {
        id: 'oled-1',
        type: 'oled_print',
        nextConnection: {},
        toString: () => 'OLED display text',
    };
    const presentations = captureCompileIssueBlockPresentations(
        { getBlockById: () => block },
        exactMap,
    );
    const card = {
        id: 'compiler-diagnostic',
        severity: 'error',
        certainty: 'certain',
        title: 'compile error',
        summary: 'missing_symbol was not declared',
        evidence: `${dynamicPath}:42:3: error: missing_symbol was not declared`,
        sourceFile: dynamicPath,
        sourceLine: 42,
        sourceColumn: 3,
        details: [],
    };
    const base = {
        issues: [card],
        sourceMap: exactMap,
        compileCode,
        currentCode: compileCode,
        runId: 'run-current',
        presentations,
    };

    const beforeAlias = reconcileCompileIssueBlockContexts({ ...base, alias: null });
    assert.equal(beforeAlias[0].blockContext, undefined);

    const alias = sourceMapService.normalizeTrustedCompileSketchAlias({
        schemaVersion: 1,
        status: 'trusted',
        runId: 'run-current',
        sourceSha256: exactMap.codeSha256,
        basename: 'sketch_c6_qfast2.ino',
        pathSha256: sourceMapService.sha256Hex(normalizedPath),
    });
    const afterAlias = reconcileCompileIssueBlockContexts({ ...base, alias });
    assert.equal(afterAlias[0].blockContext?.blockId, 'oled-1');
    assert.equal(afterAlias[0].blockContext?.sourceLine, 42);

    const revoked = reconcileCompileIssueBlockContexts({
        ...base,
        issues: afterAlias,
        alias: {
            schemaVersion: 1,
            status: 'revoked',
            runId: 'run-current',
            sourceSha256: exactMap.codeSha256,
        },
    });
    assert.equal(revoked[0].blockContext, undefined, 'revocation removes prior context');
});

test('reconciliation fails closed for stale editor code, run, path, and library diagnostics', () => {
    const compileCode = Array.from({ length: 80 }, (_, index) => `line_${index + 1};`).join('\n');
    const dynamicPath = 'C:\\Temp\\CK_Builds\\sketch_c6_qfast2\\sketch_c6_qfast2.ino';
    const normalizedPath = dynamicPath.replace(/\\/g, '/').toLowerCase();
    const exactMap = {
        ...sourceMap([mapping()]),
        codeSha256: sourceMapService.sha256Hex(compileCode),
    };
    const presentations = new Map([[
        'oled-1\u0000oled_print\u0000loop',
        {
            blockId: 'oled-1',
            blockType: 'oled_print',
            label: 'OLED',
            section: 'loop',
            flowPosition: 'loop',
        },
    ]]);
    const alias = sourceMapService.normalizeTrustedCompileSketchAlias({
        schemaVersion: 1,
        status: 'trusted',
        runId: 'run-current',
        sourceSha256: exactMap.codeSha256,
        basename: 'sketch_c6_qfast2.ino',
        pathSha256: sourceMapService.sha256Hex(normalizedPath),
    });
    const issue = file => ({
        id: 'compiler-diagnostic',
        severity: 'error',
        certainty: 'certain',
        title: 'error',
        summary: 'error',
        evidence: `${file}:42:3: error: controlled failure`,
        sourceFile: file,
        sourceLine: 42,
        details: [],
        blockContext: { blockId: 'stale' },
    });
    const base = {
        sourceMap: exactMap,
        compileCode,
        currentCode: compileCode,
        runId: 'run-current',
        alias,
        presentations,
    };

    assert.equal(reconcileCompileIssueBlockContexts({
        ...base,
        issues: [issue(dynamicPath)],
        currentCode: `${compileCode}\n// edited`,
    })[0].blockContext, undefined);
    assert.equal(reconcileCompileIssueBlockContexts({
        ...base,
        issues: [issue(dynamicPath)],
        runId: 'run-stale',
    })[0].blockContext, undefined);
    assert.equal(reconcileCompileIssueBlockContexts({
        ...base,
        issues: [issue('C:\\third-party\\sketch_c6_qfast2.ino')],
    })[0].blockContext, undefined);
    assert.equal(reconcileCompileIssueBlockContexts({
        ...base,
        issues: [issue('C:\\third-party\\library.cpp')],
    })[0].blockContext, undefined);
});

test('keeps separate frozen presentations when one block emits definition and loop code', () => {
    const block = {
        id: 'oled-1',
        type: 'oled_print',
        nextConnection: {},
        toString: () => 'OLED 显示文字',
    };
    const presentations = captureCompileIssueBlockPresentations(
        { getBlockById: () => block },
        sourceMap([
            mapping({ section: 'definition', confidence: 'high', lineStart: 4, lineEnd: 4 }),
            mapping({ section: 'loop', confidence: 'exact', lineStart: 40, lineEnd: 44 }),
        ]),
    );
    assert.equal(presentations.size, 2);

    const issue = {
        id: 'compiler-diagnostic',
        severity: 'error',
        certainty: 'certain',
        title: '源码编译错误',
        summary: 'not declared',
        evidence: 'sketch.ino:42:3: error: not declared',
        sourceLine: 42,
        details: [],
    };
    const context = resolveCompileIssueBlockContext(issue, mapping(), presentations);
    assert.equal(context.section, 'loop');
    assert.match(context.flowLocation, /^主循环/);
});

test('maps the reported nested variable marker line after a late authenticated dynamic-path alias', () => {
    const boundary = sourceMapService.createCompileSourceBoundaryMarkers({
        boundaryId: 'b2',
        blockId: 'var-set-1',
        blockType: 'var_set_custom',
        section: 'loop',
        confidence: 'exact',
    });
    const expression = sourceMapService.createCompileSourceBoundaryMarkers({
        boundaryId: 'e1',
        blockId: 'var-set-1',
        blockType: 'var_set_custom',
        section: 'expression',
        confidence: 'medium',
    });
    const compileCode = [
        'void setup() {}',
        '',
        'void loop() {',
        '  int padding_1 = 0;',
        '  int padding_2 = 0;',
        '  int padding_3 = 0;',
        '  int padding_4 = 0;',
        '  int padding_5 = 0;',
        `  variable = 0; ${boundary.begin} ${expression.begin} ${expression.end} ${boundary.end}`,
        '}',
    ].join('\n');
    const exactMap = sourceMapService.freezeCompileSourceMap(compileCode);
    const dynamicPath = 'C:\\Users\\x2582\\AppData\\Local\\Temp\\CK_Builds\\sketch_arduino_avr_mega_rel\\sketch_arduino_avr_mega_rel.ino';
    const presentations = captureCompileIssueBlockPresentations({
        getBlockById: id => id === 'var-set-1' ? {
            id,
            type: 'var_set_custom',
            nextConnection: {},
            toString: () => '设置变量 variable 为 0',
        } : null,
    }, exactMap);
    const alias = sourceMapService.normalizeTrustedCompileSketchAlias({
        schemaVersion: 1,
        status: 'trusted',
        runId: 'run-variable',
        sourceSha256: exactMap.codeSha256,
        basename: 'sketch_arduino_avr_mega_rel.ino',
        pathSha256: sourceMapService.sha256Hex(dynamicPath.replace(/\\/g, '/').toLowerCase()),
    });
    const [result] = reconcileCompileIssueBlockContexts({
        issues: [{
            id: 'compiler-diagnostic',
            severity: 'error',
            certainty: 'certain',
            title: '源码编译错误',
            summary: "'variable' was not declared in this scope",
            evidence: `${dynamicPath}:9:3: error: 'variable' was not declared in this scope`,
            sourceFile: dynamicPath,
            sourceLine: 9,
            sourceColumn: 3,
            details: [],
        }],
        sourceMap: exactMap,
        compileCode,
        currentCode: compileCode,
        runId: 'run-variable',
        alias,
        presentations,
    });

    assert.equal(result.blockContext?.blockId, 'var-set-1');
    assert.equal(result.blockContext?.sourceLine, 9);
    assert.equal(result.blockContext?.confidence, 'exact');
});
