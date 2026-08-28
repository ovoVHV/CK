import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./diagnostic_bundle.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'diagnostic_bundle.ts',
    reportDiagnostics: true,
});
const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'diagnostic_bundle.ts should transpile without syntax errors');

const executableSource = transpiled.outputText.replace(
    "import { invoke } from '@tauri-apps/api/core';",
    'const invoke = (...args) => globalThis.__CK_DIAGNOSTIC_TEST_INVOKE__(...args);',
);
const diagnostic = await import(
    `data:text/javascript;base64,${Buffer.from(executableSource).toString('base64')}`
);

const summary = (overrides = {}) => ({
    title: 'CK 本地诊断包',
    contentLevel: '不含源码',
    board: 'ESP32-C6',
    core: 'esp32:esp32@3.3.6',
    fqbn: 'esp32:esp32:esp32c6:FlashSize=8M',
    flash: '930740 / 3145728 字节',
    missingCore: false,
    failureStage: '上传/烧录',
    sourceIncluded: false,
    ...overrides,
});

test('defaults to all four privacy protections and creates a safe ZIP path', () => {
    assert.deepEqual(diagnostic.DEFAULT_DIAGNOSTIC_PRIVACY, {
        redactWifi: true,
        redactUsername: true,
        redactPaths: true,
        redactSerialContent: true,
    });
    assert.equal(diagnostic.ensureDiagnosticBundleZipPath('C:\\tmp\\support'), 'C:\\tmp\\support.zip');
    assert.equal(diagnostic.ensureDiagnosticBundleZipPath('C:\\tmp\\SUPPORT.ZIP'), 'C:\\tmp\\SUPPORT.ZIP');
    assert.match(
        diagnostic.createDiagnosticBundleFileName(new Date('2026-07-13T04:05:06.789Z')),
        /^CK-诊断包_2026-07-13_04-05-06-789\.zip$/,
    );
});

test('standard evidence builder keeps every requested archive name and role explicit', () => {
    const items = diagnostic.createStandardDiagnosticBundleItems({
        support: { content: '{"app":"CK"}' },
        boardReport: { path: 'C:\\tmp\\board-report.json' },
        generatedSource: { content: 'void setup() {}' },
        sourceMap: { content: '{"schema":"ck-sourcemap","version":1}' },
    });
    const byId = Object.fromEntries(items.map(item => [item.id, item]));
    assert.equal(byId.support.archivePath, 'support.json');
    assert.equal(byId.support.role, 'environment');
    assert.equal(byId.support.required, true);
    assert.equal(byId['board-report'].archivePath, 'board-report.json');
    assert.equal(byId['build-manifest'].archivePath, 'build-manifest.json');
    assert.equal(byId['upload-manifest'].archivePath, 'upload-manifest.json');
    assert.equal(byId['ck-lock'].archivePath, 'ck.lock');
    assert.equal(byId['compile-log'].archivePath, 'compile.log');
    assert.equal(byId['upload-log'].archivePath, 'upload.log');
    assert.equal(byId['package-quality-reports'].archivePath, 'package-quality-reports/index.json');
    assert.equal(byId['project-change-summary'].archivePath, 'project-change-summary.json');
    assert.equal(byId['serial-device'].archivePath, 'serial-device.json');
    assert.equal(byId['generated-source'].role, 'generated_source');
    assert.equal(byId['compile-source-map'].archivePath, 'ck-sourcemap.json');
    assert.equal(byId['compile-source-map'].role, 'source_map');
    assert.equal(
        byId['compile-source-map'].content,
        '{"schema":"ck-sourcemap","version":1}',
    );
    assert.equal('path' in byId['build-manifest'], false, 'missing evidence stays an explicit missing record');
});

test('inspection normalization exposes the requested Chinese evidence and rejects network claims', () => {
    const result = diagnostic.normalizeDiagnosticBundleInspection({
        valid: true,
        schemaVersion: 1,
        includedFiles: 8,
        missingItems: 1,
        warnings: ['当前电脑缺少 Core'],
        summary: summary({ missingCore: true, sourceIncluded: true }),
        networkUsed: false,
        uploadPerformed: false,
    });
    assert.equal(result.summary.board, 'ESP32-C6');
    assert.equal(result.summary.core, 'esp32:esp32@3.3.6');
    assert.equal(result.summary.missingCore, true);
    assert.equal(result.summary.sourceIncluded, true);
    assert.equal(result.summary.failureStage, '上传/烧录');

    assert.throws(
        () => diagnostic.normalizeDiagnosticBundleInspection({
            valid: true,
            schemaVersion: 1,
            includedFiles: 0,
            missingItems: 0,
            warnings: [],
            summary: summary(),
            networkUsed: true,
            uploadPerformed: false,
        }),
        /使用了网络或自动上传/,
    );
});

test('imported Core status distinguishes current-machine evidence from recorded evidence', () => {
    const imported = summary();
    assert.deepEqual(
        diagnostic.deriveDiagnosticCoreAvailability(imported),
        {
            state: 'unknown',
            packageName: 'esp32:esp32',
            requiredVersion: '3.3.6',
            installedVersion: null,
            label: '尚未检查当前电脑的 Core',
        },
    );
    assert.equal(
        diagnostic.deriveDiagnosticCoreAvailability(imported, {}).label,
        '当前电脑缺少 esp32:esp32',
    );
    const different = diagnostic.deriveDiagnosticCoreAvailability(imported, {
        'esp32:esp32': '3.4.0',
    });
    assert.equal(different.state, 'version_difference');
    assert.match(different.label, /当前电脑为 3\.4\.0，诊断包使用 3\.3\.6/);
    assert.equal(
        diagnostic.deriveDiagnosticCoreAvailability(imported, {
            'esp32:esp32': '3.3.6',
        }).state,
        'ready',
    );
});

test('service calls only the two local Rust commands with their exact argument shapes', async () => {
    const calls = [];
    globalThis.__CK_DIAGNOSTIC_TEST_INVOKE__ = async (command, args) => {
        calls.push({ command, args });
        if (command === 'export_diagnostic_bundle') {
            return {
                outputPath: args.request.outputPath,
                includedFiles: 2,
                missingItems: 0,
                omittedItems: 3,
                warnings: [],
                summary: summary(),
            };
        }
        return {
            valid: true,
            schemaVersion: 1,
            includedFiles: 2,
            missingItems: 0,
            warnings: [],
            summary: summary(),
            networkUsed: false,
            uploadPerformed: false,
        };
    };

    try {
        const exported = await diagnostic.exportDiagnosticBundle({
            outputPath: 'C:\\tmp\\ck-support',
            contentLevel: 'generated_source_only',
            privacy: { ...diagnostic.DEFAULT_DIAGNOSTIC_PRIVACY },
            context: { boardName: 'ESP32-C6' },
            items: [{
                id: 'source',
                role: 'generated_source',
                archivePath: 'source/main.ino',
                content: 'void setup() {}',
            }],
        });
        assert.equal(exported.outputPath, 'C:\\tmp\\ck-support.zip');
        assert.equal(calls[0].command, 'export_diagnostic_bundle');
        assert.deepEqual(Object.keys(calls[0].args), ['request']);
        assert.equal(calls[0].args.request.contentLevel, 'generated_source_only');
        assert.equal(calls[0].args.request.privacy.redactSerialContent, true);

        const inspected = await diagnostic.inspectDiagnosticBundle('C:\\tmp\\ck-support.zip');
        assert.equal(inspected.valid, true);
        assert.deepEqual(calls[1], {
            command: 'inspect_diagnostic_bundle',
            args: { path: 'C:\\tmp\\ck-support.zip' },
        });
        assert.equal(calls.some(call => /https?|upload/i.test(call.command)), false);
    } finally {
        delete globalThis.__CK_DIAGNOSTIC_TEST_INVOKE__;
    }
});
