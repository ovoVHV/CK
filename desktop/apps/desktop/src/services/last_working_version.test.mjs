import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./last_working_version.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
    },
    fileName: 'last_working_version.ts',
    reportDiagnostics: true,
});
const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, []);
const executable = transpiled.outputText.replace(
    "import { invoke } from '@tauri-apps/api/core';",
    'const invoke = (...args) => globalThis.__CK_LAST_WORKING_INVOKE__(...args);',
);
const service = await import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`);

const workspace = (blocks) => JSON.stringify({
    blocks: { languageVersion: 0, blocks },
});

const makeVersion = async () => {
    const workspaceJson = workspace([{ id: 'setup', type: 'controls_if', fields: { MODE: 'IF' } }]);
    const code = 'void setup() {}\n';
    const digest = async value => {
        const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
        return Buffer.from(result).toString('hex');
    };
    return {
        schemaVersion: 1,
        id: 'baseline',
        createdAt: '2026-07-13T00:00:00.000Z',
        verifiedAt: '2026-07-13T00:00:00.000Z',
        project: {
            originalPath: 'C:/Projects/demo.maker',
            name: 'demo',
            workspaceJson,
            workspaceSha256: await digest(workspaceJson),
            generatedCode: code,
            generatedCodeSha256: await digest(code),
            board: 'esp32:esp32:esp32c6',
            boardOptionsJson: '{}',
            blockCount: 1,
        },
        lock: {
            path: 'ck.lock',
            content: '{}',
            sha256: 'a'.repeat(64),
            dependencies: [{
                name: 'FastLED',
                version: '3.8.0',
                sourcePath: 'C:/CK/FastLED',
                snapshotPath: 'dependencies/FastLED',
                contentSha256: 'd'.repeat(64),
                fileCount: 2,
                totalBytes: 100,
            }],
        },
        environment: {
            fqbn: 'esp32:esp32:esp32c6:FlashSize=8M,PartitionScheme=default_8MB',
            coreId: 'esp32:esp32',
            coreVersion: '3.3.6',
            arduinoCliVersion: '1.3.1',
            toolchainKey: 'toolchain',
            buildSignature: 'signature',
            compileProfile: 'quick-fast',
            optimization: '-O1',
        },
        firmware: {
            buildDirectory: 'firmware/build',
            manifestPath: 'firmware/build/.ck-upload-artifacts.json',
            manifestSha256: 'b'.repeat(64),
            partition: { path: 'partitions.csv', sha256: 'c'.repeat(64) },
            artifacts: [],
        },
        device: { chip: 'ESP32-C6', revision: 'v0.1', flashBytes: 8 * 1024 * 1024, psramBytes: null },
        resources: { flashUsedBytes: 100, flashMaxBytes: 1000, ramUsedBytes: 20, ramMaxBytes: 200, warningCount: 0 },
        logs: { compilePath: 'compile.log', uploadPath: 'upload.log' },
    };
};

test('native command wrappers use the safe baseline and gated firmware commands', async () => {
    globalThis.window = { __TAURI_INTERNALS__: {} };
    const calls = [];
    globalThis.__CK_LAST_WORKING_INVOKE__ = async (...args) => {
        calls.push(args);
        if (args[0] === 'get_last_working_version') return await makeVersion();
        if (args[0] === 'rebuild_last_working_version_locked') {
            return JSON.stringify({
                status: 'passed',
                fqbn: 'esp32:esp32:esp32c6',
                lockSha256: 'a'.repeat(64),
                dependencyCount: 1,
                buildPath: 'C:/Temp/CK_Builds/isolated/test/build',
                compileProfile: 'quick-fast',
                optimization: '-O1',
                log: 'ok',
                elapsedMs: 100,
                artifactGate: 'sealed upload-ready artifacts',
                globalLibrariesUsed: false,
            });
        }
        return 'ok';
    };
    await service.getLastWorkingVersion('C:/Projects/demo.maker');
    await service.deleteLastWorkingVersion('C:/Projects/demo.maker');
    await service.restoreLastWorkingDependencies('C:/Projects/demo.maker', '3.3.6');
    await service.restoreLastWorkingFirmware('C:/Projects/demo.maker', 'COM12');
    const cleanBuild = await service.rebuildLastWorkingVersionLocked('C:/Projects/demo.maker');
    assert.equal(cleanBuild.globalLibrariesUsed, false);
    assert.deepEqual(calls.map(call => call[0]), [
        'get_last_working_version',
        'delete_last_working_version',
        'restore_last_working_dependencies',
        'restore_last_working_firmware',
        'rebuild_last_working_version_locked',
    ]);
    assert.deepEqual(calls[1][1], { projectPath: 'C:/Projects/demo.maker' });
    assert.deepEqual(calls[2][1], {
        projectPath: 'C:/Projects/demo.maker',
        currentCoreVersion: '3.3.6',
    });
    assert.deepEqual(calls[3][1], { projectPath: 'C:/Projects/demo.maker', port: 'COM12' });
    assert.deepEqual(calls[4][1], { projectPath: 'C:/Projects/demo.maker' });
});

test('comparison treats board package identity as separate from shared compiler FQBN', async () => {
    const version = await makeVersion();
    version.project.boardPackageId = 'acme-c6-a';
    const report = await service.compareWithLastWorkingVersion(version, {
        workspaceJson: version.project.workspaceJson,
        generatedCode: version.project.generatedCode,
        blockCount: version.project.blockCount,
        fqbn: version.environment.fqbn,
        boardPackageId: 'acme-c6-b',
        coreId: version.environment.coreId,
        coreVersion: version.environment.coreVersion,
        boardOptions: {},
        dependencyInventory: [],
        resources: null,
        deviceHealth: null,
    });
    assert.ok(report.items.some(item => (
        item.title === '板卡包发生变化'
        && item.before === 'acme-c6-a'
        && item.after === 'acme-c6-b'
        && item.severity === 'important'
    )));
});

test('diff grouping uses locale-independent ASCII identities', async () => {
    const version = await makeVersion();
    const report = await service.compareWithLastWorkingVersion(version, {
        workspaceJson: workspace([
            { id: 'setup', type: 'controls_if', fields: { MODE: 'ELSE' } },
        ]),
        generatedCode: version.project.generatedCode,
        blockCount: 1,
        fqbn: version.environment.fqbn,
        coreId: version.environment.coreId,
        coreVersion: version.environment.coreVersion,
        boardOptions: {},
        dependencyInventory: [{ name: 'FastLED', version: '3.8.0' }],
        deviceHealth: null,
        resources: null,
    });

    assert.ok(report.items.length > 0);
    assert.deepEqual(service.LAST_WORKING_DIFF_GROUPS, [
        'workspace',
        'environment',
        'dependencies',
        'device',
        'resources',
    ]);
    assert.equal(report.items.some(item => /[\u3400-\u9fff]/u.test(item.group)), false);
    assert.ok(report.items.some(item => item.group === 'workspace'));
});

test('diff control flow uses stable codes instead of localized titles', () => {
    assert.match(source, /informationalEvidence\.has\(item\.code\)/);
    assert.doesNotMatch(source, /informationalEvidence\.has\(item\.title\)/);
    assert.match(source, /summaryCode:/);
});

test('Chinese comparison explains block, Core, FQBN option, dependency and hardware changes', async () => {
    const version = await makeVersion();
    const currentWorkspace = workspace([
        { id: 'setup', type: 'controls_if', fields: { MODE: 'ELSE' } },
        { id: 'wifi', type: 'wifi_begin' },
    ]);
    const report = await service.compareWithLastWorkingVersion(version, {
        workspaceJson: currentWorkspace,
        generatedCode: 'void setup() { wifi(); }\n',
        blockCount: 2,
        fqbn: 'esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=fatflash',
        coreId: 'esp32:esp32',
        coreVersion: '3.4.0',
        boardOptions: { FlashSize: '16M', PartitionScheme: 'fatflash' },
        optimization: '-Os',
        arduinoCliVersion: '1.4.0',
        toolchainKey: 'toolchain-v2',
        buildSignature: 'signature-v2',
        dependencies: [{ name: 'FastLED', version: '3.9.2' }],
        deviceHealth: {
            device: { chip: 'ESP32-C5' },
            memory: { flashBytes: 4 * 1024 * 1024, psramBytes: null },
        },
        resources: null,
    });
    const titles = report.items.map(item => item.title).join('\n');
    assert.match(titles, /修改了 1 个积木/);
    assert.match(titles, /新增了 1 个积木/);
    assert.match(titles, /Core 发生变化/);
    assert.match(titles, /FlashSize 配置发生变化/);
    assert.match(titles, /FastLED 版本发生变化/);
    assert.match(titles, /Arduino CLI 发生变化/);
    assert.match(titles, /编译工具链身份发生变化/);
    assert.match(titles, /构建签名发生变化/);
    assert.match(titles, /实体 Flash 证据发生变化/);
});

test('board-scoped library inventory compares locked dependency versions without claiming every installed library is used', async () => {
    const version = await makeVersion();
    const report = await service.compareWithLastWorkingVersion(version, {
        workspaceJson: version.project.workspaceJson,
        generatedCode: version.project.generatedCode,
        blockCount: version.project.blockCount,
        fqbn: version.environment.fqbn,
        coreId: version.environment.coreId,
        coreVersion: version.environment.coreVersion,
        boardOptions: {},
        arduinoCliVersion: version.environment.arduinoCliVersion,
        toolchainKey: version.environment.toolchainKey,
        buildSignature: version.environment.buildSignature,
        dependencyInventory: [
            { name: 'FastLED', version: '3.9.2' },
            { name: 'UnrelatedInstalledLibrary', version: '1.0.0' },
        ],
        deviceHealth: null,
        resources: null,
    });
    const titles = report.items.map(item => item.title).join('\n');
    assert.match(titles, /FastLED 版本发生变化/);
    assert.doesNotMatch(titles, /UnrelatedInstalledLibrary/);
});

test('older build evidence and a not-yet-inspected port are informational immediately after a working version is created', async () => {
    const version = await makeVersion();
    const report = await service.compareWithLastWorkingVersion(version, {
        workspaceJson: version.project.workspaceJson,
        generatedCode: version.project.generatedCode,
        blockCount: version.project.blockCount,
        fqbn: version.environment.fqbn,
        coreId: version.environment.coreId,
        coreVersion: version.environment.coreVersion,
        boardOptions: {},
        optimization: '-Os',
        arduinoCliVersion: 'older-cli',
        toolchainKey: 'older-toolchain',
        buildSignature: 'older-signature',
        buildEvidenceRecordedAt: '2026-07-12T23:59:00.000Z',
        dependencyInventory: [{ name: 'FastLED', version: '3.8.0' }],
        deviceHealth: null,
        resources: null,
    });
    assert.equal(report.identical, true);
    assert.match(report.summary, /没有发现可解释差异/);
    const titles = report.items.map(item => item.title).join('\n');
    assert.match(titles, /当前尚无可比较的工具链证据/);
    assert.match(titles, /当前端口尚未完成真机体检/);
    assert.doesNotMatch(titles, /构建签名发生变化/);
    assert.doesNotMatch(titles, /实体 Flash 证据发生变化/);
});

test('modal exposes comparison, four recovery operations, locked rebuild, and safe local deletion', async () => {
    const modal = await readFile(new URL('../components/LastWorkingVersionModal.tsx', import.meta.url), 'utf8');
    const workspaceSource = await readFile(new URL('../components/Workspace.tsx', import.meta.url), 'utf8');
    assert.match(modal, /t\('lastWorking\.actions\.restoreProject'\)/);
    assert.match(modal, /t\('lastWorking\.actions\.restoreFirmware'\)/);
    assert.match(modal, /t\('lastWorking\.actions\.completeRestore'\)/);
    assert.match(modal, /t\('lastWorking\.actions\.rebuild'\)/);
    assert.match(modal, /t\('lastWorking\.actions\.rebuildDescription'\)/);
    assert.match(modal, /t\('lastWorking\.compareCurrent'\)/);
    assert.match(modal, /t\('lastWorking\.safetyNote'\)/);
    assert.match(modal, /deleteLastWorkingVersion\(projectPath\)/);
    assert.match(modal, /t\('lastWorking\.deleteTooltip'\)/);
    assert.match(modal, /t\('lastWorking\.confirm\.deleteMessage'\)/);
    assert.match(modal, /tone: 'danger'/);
    assert.match(modal, /setVersion\(null\)[\s\S]*?setDiff\(null\)[\s\S]*?await refresh\(\)/);
    assert.match(modal, /disabled=\{loading \|\| comparing \|\| isBusy \|\| Boolean\(action\)\}/);
    assert.match(workspaceSource, /restoreLastWorkingFirmware\(currentPathRef\.current, uploadPort\)/);
    assert.match(workspaceSource, /rebuildLastWorkingVersionLocked\(currentPathRef\.current\)/);
    assert.doesNotMatch(workspaceSource, /esptool[^\n]*restoreLastWorking/i);
});
