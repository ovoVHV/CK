import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const transpile = (source, fileName) => ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    fileName,
    reportDiagnostics: true,
}).outputText;
const mapSource = await readFile(new URL('./compile_source_map.ts', import.meta.url), 'utf8');
const mapUrl = `data:text/javascript;base64,${Buffer.from(transpile(mapSource, 'compile_source_map.ts')).toString('base64')}`;
const projectIdentitySource = await readFile(new URL('./project_identity.ts', import.meta.url), 'utf8');
const projectIdentityUrl = `data:text/javascript;base64,${Buffer.from(transpile(projectIdentitySource, 'project_identity.ts')).toString('base64')}`;
const bundledQualifications = await readFile(new URL('../../src-tauri/src/ck_forge_bundled_qualifications.v1.json', import.meta.url), 'utf8');
const forgeCoreSupportSource = (await readFile(new URL('./ck_forge_core_support.ts', import.meta.url), 'utf8'))
    .replace(
        "import bundledQualifications from '../../src-tauri/src/ck_forge_bundled_qualifications.v1.json';",
        `const bundledQualifications = ${bundledQualifications};`,
    );
const forgeCoreSupportUrl = `data:text/javascript;base64,${Buffer.from(transpile(forgeCoreSupportSource, 'ck_forge_core_support.ts')).toString('base64')}`;
const doctorSource = (await readFile(new URL('./compile_doctor.ts', import.meta.url), 'utf8'))
    .replace("from './compile_source_map';", `from '${mapUrl}';`)
    .replace("from './project_identity';", `from '${projectIdentityUrl}';`)
    .replace("from './ck_forge_core_support';", `from '${forgeCoreSupportUrl}';`);
const doctor = await import(
    `data:text/javascript;base64,${Buffer.from(transpile(doctorSource, 'compile_doctor.ts')).toString('base64')}`
);

const values = new Map();
globalThis.window = {
    localStorage: {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
    },
};

const environment = fqbn => ({
    fqbn,
    coreId: fqbn.split(':').slice(0, 2).join(':'),
    coreVersion: '1.0.0',
    codeFingerprint: 'a'.repeat(64),
    includeHeaders: [],
});

const CURRENT_CK_FORGE_CONTRACT_ID = 'ck-fast-build-contract-v9:command-scoped-ccache-native-file-paths-O1-final-g0-no-lto-expanded-ccdb-core-deps-portable-response-guard';
const HISTORICAL_CK_FORGE_CONTRACT_V8 = 'ck-fast-build-contract-v8:command-scoped-ccache-O1-final-g0-no-lto-expanded-ccdb-core-deps-portable-response-guard';

const currentForgeDiagnostics = (fqbn, overrides = {}) => ({
    schemaVersion: 1,
    fqbn,
    buildMode: 'fast-relink',
    profile: 'quick-fast',
    engine: {
        id: 'ck-forge',
        schemaVersion: 1,
        productVersion: '1',
        contractId: CURRENT_CK_FORGE_CONTRACT_ID,
        decision: 'allow-fast',
        source: 'local-qualification',
        coreVersion: '1.0.0',
        reasonCodes: ['local-qualification-matched'],
    },
    timing: { cliCompileMs: 800, totalMs: 900 },
    environment: {
        cliVersion: 'arduino-cli Version: 1.4.1',
        toolchainKey: 'esp32|esp32|1.0.0|'.concat('a'.repeat(64)),
        toolchainIdentitySource: 'strong-content',
        buildSignature: 'b'.repeat(64),
    },
    ...overrides,
});

test('compile environment snapshot binds a full SHA-256 project identity', () => {
    values.clear();
    const path = 'C:/Projects/blink.maker';
    const saved = doctor.saveCompileEnvironmentSnapshot(path, environment('arduino:avr:nano'));
    assert.equal(saved.schemaVersion, 2);
    assert.match(saved.projectIdentitySha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(doctor.loadCompileEnvironmentSnapshot(path), saved);
    assert.equal(doctor.loadCompileEnvironmentSnapshot('C:/Projects/other.maker'), null);
});

test('old v1 environment payload is never migrated into current evidence', () => {
    values.clear();
    const path = 'C:/Projects/legacy.maker';
    doctor.saveCompileEnvironmentSnapshot(path, environment('arduino:avr:nano'));
    const [key] = values.keys();
    values.set(key, JSON.stringify({ schemaVersion: 1, ...environment('arduino:avr:nano') }));
    assert.equal(doctor.loadCompileEnvironmentSnapshot(path), null);
});

test('SHA keys separate project paths that collided under the former 32-bit FNV key', () => {
    values.clear();
    const left = 'C:/Projects/pb290yft2.maker';
    const right = 'C:/Projects/11xhlob1csh.maker';
    const oldFnv = value => {
        let hash = 0x811c9dc5;
        for (const char of value.toLowerCase()) {
            hash ^= char.charCodeAt(0);
            hash = Math.imul(hash, 0x01000193);
        }
        return hash >>> 0;
    };
    assert.equal(oldFnv(left), oldFnv(right));
    doctor.saveCompileEnvironmentSnapshot(left, environment('arduino:avr:nano'));
    doctor.saveCompileEnvironmentSnapshot(right, environment('esp32:esp32:esp32c6'));
    assert.equal(values.size, 2);
    assert.equal(doctor.loadCompileEnvironmentSnapshot(left).fqbn, 'arduino:avr:nano');
    assert.equal(doctor.loadCompileEnvironmentSnapshot(right).fqbn, 'esp32:esp32:esp32c6');
});

test('Arduino CLI incremental fallback is explicit instead of unknown', () => {
    const report = doctor.diagnoseCompile({
        success: true,
        log: [
            '[Timing WARN] Fast Relink bypassed, falling back to arduino-cli compile:',
            '[INFO] Build cache directory detected; arduino-cli may still rebuild based on inputs.',
        ].join('\n'),
        durationMs: 12_000,
        currentEnvironment: environment('esp32:esp32:esp32s3'),
    });
    assert.equal(report.buildMode, 'arduino-cli-incremental-fallback');
    assert.equal(report.status, 'attention');
    assert.equal(doctor.compileBuildModeLabel(report.buildMode), 'Arduino CLI 增量回退');
});

test('structured full fallback mode remains explainable', () => {
    const report = doctor.diagnoseCompile({
        success: true,
        log: '',
        durationMs: 20_000,
        diagnostics: {
            buildMode: 'arduino-cli-full-fallback',
            timing: { cliCompileMs: 19_000, totalMs: 20_000 },
            cache: { fastRelinkFallback: true },
        },
        currentEnvironment: environment('arduino:avr:uno'),
    });
    assert.equal(report.buildMode, 'arduino-cli-full-fallback');
    assert.equal(report.status, 'attention');
    assert.equal(doctor.compileBuildModeLabel(report.buildMode), 'Arduino CLI 完整回退');
});

test('CK Forge compatibility and fast routes are visible in the user report', () => {
    const compatibility = doctor.diagnoseCompile({
        success: true,
        log: '',
        durationMs: 3_000,
        diagnostics: {
            buildMode: 'full-build',
            profile: 'release',
            engine: {
                id: 'ck-forge',
                decision: 'force-platform',
                reasonCodes: ['unknown-platform'],
            },
            timing: {
                libraryResolutionMs: 30,
                identityResolutionMs: 40,
                precompileMs: 80,
                cliCompileMs: 2_900,
                totalMs: 3_000,
            },
            environment: {
                toolchainIdentitySource: 'persistent-metadata',
            },
        },
        currentEnvironment: environment('vendor:arch:custom'),
    });
    assert.equal(compatibility.forgeDecision, 'force-platform');
    assert.equal(compatibility.status, 'attention');
    assert.match(compatibility.summary, /CK Forge · 原生安全构建/);
    assert.match(compatibility.explanation, /A\/B 不回退门禁/);
    assert.doesNotMatch(compatibility.summary, /快速|Fast/i);
    assert.equal(compatibility.profile, 'release');
    assert.equal(compatibility.identityResolutionMs, 40);
    assert.equal(compatibility.toolchainIdentitySource, 'persistent-metadata');

    const hot = doctor.diagnoseCompile({
        success: true,
        log: '',
        durationMs: 900,
        diagnostics: currentForgeDiagnostics('esp32:esp32:esp32c6'),
        currentEnvironment: environment('esp32:esp32:esp32c6'),
    });
    assert.equal(hot.forgeDecision, 'allow-fast');
    assert.equal(hot.forgeEvidenceCurrent, true);
    assert.equal(hot.forgeFastAuthorized, true);
    assert.equal(hot.toolchainIdentitySource, 'strong-content');
    assert.match(hot.summary, /CK Forge · 热构建/);
    assert.doesNotMatch(hot.summary, /待验证|证据不完整/);
});

test('certified ESP32 Core-library baseline is explained as a one-time dependency seal', () => {
    const fqbn = 'esp32:esp32:esp32s2';
    const base = currentForgeDiagnostics(fqbn);
    const report = doctor.diagnoseCompile({
        success: true,
        log: [
            '[INFO] CK Forge NativeRelinkCompileOnly certificate matched this host/Core/toolchain/FQBN;',
            '[INFO] ESP32 library NativeRelink baseline committed; native object order and library graph are sealed (authorization=certified).',
        ].join('\n'),
        durationMs: 42_000,
        diagnostics: {
            ...base,
            buildMode: 'full-build',
            profile: 'release',
            engine: {
                ...base.engine,
                decision: 'force-platform',
                source: 'conservative-fallback',
                reasonCodes: ['builtin-performance-qualification-missing'],
            },
            cache: { nativeRelinkCertificateMatched: true },
            timing: { cliCompileMs: 40_000, totalMs: 42_000 },
        },
        currentEnvironment: environment(fqbn),
    });

    assert.equal(report.forgeFastAuthorized, true);
    assert.match(report.summary, /已认证依赖基线/);
    assert.match(report.explanation, /封存.*Core 内置库.*依赖图/);
    assert.match(report.recommendation, /下一次.*修改代码/);
});

test('all Core-version qualification failures name the current and certified versions', () => {
    for (const reasonCode of ['unverified-core-version', 'qualification-core-version-mismatch']) {
        const currentEnvironment = {
            ...environment('arduino:avr:diecimila:cpu=atmega328'),
            coreVersion: '1.8.9',
        };
        const report = doctor.diagnoseCompile({
            success: true,
            log: '',
            durationMs: 4_200,
            diagnostics: {
                schemaVersion: 1,
                fqbn: currentEnvironment.fqbn,
                buildMode: 'full-build',
                profile: 'release',
                engine: {
                    id: 'ck-forge',
                    decision: 'force-platform',
                    source: 'conservative-fallback',
                    coreVersion: '1.8.9',
                    reasonCodes: [reasonCode],
                },
                timing: { cliCompileMs: 4_000, totalMs: 4_200 },
            },
            currentEnvironment,
        });

        assert.equal(report.forgeCoreStatus, 'local-certification-required');
        assert.match(report.forgeCoreStatusLabel, /Core 1\.8\.9.*待本机认证/);
        assert.deepEqual(report.forgeCertifiedCoreVersions, ['1.8.6', '1.8.8']);
        assert.match(report.forgeCoreStatusDetail, /1\.8\.9 仍可正常编译，不要求降级/);
        assert.match(report.forgeCoreStatusDetail, /1\.8\.6/);
        assert.match(report.forgeReasonDetails[0], /当前 Core 1\.8\.9/);
        assert.match(report.recommendation, /不要求降级/);
    }
});

test('an unknown board or platform is labelled as a safe fallback rather than a required Core', () => {
    const currentEnvironment = {
        ...environment('vendor:architecture:custom'),
        coreVersion: '9.2.1',
    };
    const report = doctor.diagnoseCompile({
        success: true,
        log: '',
        durationMs: 2_000,
        diagnostics: {
            schemaVersion: 1,
            fqbn: currentEnvironment.fqbn,
            buildMode: 'full-build',
            profile: 'release',
            engine: {
                id: 'ck-forge',
                decision: 'force-platform',
                source: 'conservative-fallback',
                coreVersion: '9.2.1',
                reasonCodes: ['unknown-platform'],
            },
        },
        currentEnvironment,
    });

    assert.equal(report.forgeCoreStatus, 'safe-fallback');
    assert.match(report.forgeCoreStatusLabel, /Core 9\.2\.1.*安全回退/);
    assert.match(report.forgeCoreStatusDetail, /仍可通过平台原生路径正常编译/);
    assert.doesNotMatch(`${report.explanation} ${report.recommendation}`, /必须|只能使用/);
});

test('a log-only Fast Relink marker never claims that fast compilation is active', () => {
    const report = doctor.diagnoseCompile({
        success: true,
        log: '[INFO] Fast Relink path: sketch-only compile + direct link',
        durationMs: 1_200,
        currentEnvironment: environment('esp32:esp32:esp32c6'),
    });
    assert.equal(report.buildMode, 'fast-relink');
    assert.equal(report.forgeDecision, null);
    assert.equal(report.forgeEvidenceCurrent, false);
    assert.equal(report.forgeFastAuthorized, false);
    assert.equal(report.status, 'attention');
    assert.match(report.summary, /快速资格待验证/);
    assert.doesNotMatch(`${report.summary} ${report.explanation}`, /快速编译已生效|CK Forge · 热构建/);
    assert.equal(doctor.compileBuildModeLabel(report.buildMode), '重链接构建');
});

test('a sparse allow-fast claim is rejected without current engine identity evidence', () => {
    const report = doctor.diagnoseCompile({
        success: true,
        log: '',
        durationMs: 1_200,
        diagnostics: {
            buildMode: 'fast-relink',
            profile: 'quick-fast',
            engine: {
                id: 'ck-forge',
                decision: 'allow-fast',
                reasonCodes: ['local-qualification-matched'],
            },
        },
        currentEnvironment: environment('esp32:esp32:esp32c6'),
    });
    assert.equal(report.forgeDecision, null);
    assert.equal(report.forgeEvidenceCurrent, false);
    assert.equal(report.forgeFastAuthorized, false);
    assert.match(report.summary, /快速资格证据不完整/);
    assert.doesNotMatch(`${report.summary} ${report.explanation}`, /快速编译已生效|CK Forge · 热构建/);
});

test('historical v8 diagnostics cannot present a Fast route as currently authorized', () => {
    const diagnostics = currentForgeDiagnostics('esp32:esp32:esp32c6');
    diagnostics.engine.contractId = HISTORICAL_CK_FORGE_CONTRACT_V8;
    const report = doctor.diagnoseCompile({
        success: true,
        log: '',
        durationMs: 900,
        diagnostics,
        currentEnvironment: environment('esp32:esp32:esp32c6'),
    });

    assert.equal(report.forgeEvidenceCurrent, false);
    assert.equal(report.forgeFastAuthorized, false);
    assert.equal(report.forgeDecision, null);
    assert.doesNotMatch(`${report.summary} ${report.explanation}`, /快速编译已生效|CK Forge · 热构建/);
});

test('a certified NativeRelink build is visible as fast even though its route stays native', () => {
    const report = doctor.diagnoseCompile({
        success: true,
        log: '',
        durationMs: 850,
        diagnostics: currentForgeDiagnostics('arduino:avr:uno', {
            buildMode: 'native-relink-compile-only',
            profile: 'release',
            engine: {
                id: 'ck-forge',
                schemaVersion: 1,
                productVersion: '1',
                contractId: CURRENT_CK_FORGE_CONTRACT_ID,
                decision: 'force-platform',
                source: 'conservative-fallback',
                coreVersion: '1.0.0',
                reasonCodes: ['qualification-performance-missing'],
            },
            cache: { nativeRelinkCertificateMatched: true },
        }),
        currentEnvironment: environment('arduino:avr:uno'),
    });
    assert.equal(report.forgeFastAuthorized, true);
    assert.match(report.summary, /CK Forge · 热构建/);
});

test('a certified target full build is shown as baseline creation instead of unqualified', () => {
    const report = doctor.diagnoseCompile({
        success: true,
        log: '',
        durationMs: 4_800,
        diagnostics: currentForgeDiagnostics('arduino:avr:nano', {
            buildMode: 'full-build',
            profile: 'release',
            engine: {
                id: 'ck-forge',
                schemaVersion: 1,
                productVersion: '1',
                contractId: CURRENT_CK_FORGE_CONTRACT_ID,
                decision: 'force-platform',
                source: 'conservative-fallback',
                coreVersion: '1.0.0',
                reasonCodes: ['qualification-native-relink-certificate-matched'],
            },
            timing: { cliCompileMs: 4_320, totalMs: 4_800 },
            cache: {
                nativeRelinkCertificateMatched: true,
                missReasons: ['metadata_missing'],
            },
        }),
        currentEnvironment: environment('arduino:avr:nano'),
    });
    assert.equal(report.forgeDecision, 'force-platform');
    assert.equal(report.forgeEvidenceCurrent, true);
    assert.equal(report.forgeFastAuthorized, true);
    assert.equal(report.status, 'healthy');
    assert.match(report.summary, /已认证.*首次建立基线/);
    assert.match(report.explanation, /后续符合门禁的编辑将进入快速路径/);
    assert.doesNotMatch(
        `${report.summary} ${report.explanation} ${report.recommendation}`,
        /尚未通过|快速资格待验证|原生安全构建/,
    );
});

test('an unauthenticated certificate flag cannot turn a sparse full build into certified UI', () => {
    const report = doctor.diagnoseCompile({
        success: true,
        log: '',
        durationMs: 4_800,
        diagnostics: {
            buildMode: 'full-build',
            profile: 'release',
            engine: {
                id: 'ck-forge',
                decision: 'force-platform',
                reasonCodes: ['qualification-native-relink-certificate-matched'],
            },
            cache: { nativeRelinkCertificateMatched: true },
        },
        currentEnvironment: environment('arduino:avr:nano'),
    });
    assert.equal(report.forgeEvidenceCurrent, false);
    assert.equal(report.forgeFastAuthorized, false);
    assert.match(report.summary, /原生安全构建/);
    assert.match(report.explanation, /尚未通过/);
    assert.doesNotMatch(report.summary, /已认证/);
});
