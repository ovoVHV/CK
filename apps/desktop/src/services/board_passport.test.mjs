import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./board_passport.ts', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'board_passport.ts',
    reportDiagnostics: true,
});
const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'board_passport.ts should transpile without syntax errors');

const passport = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);
const { compareCoreVersions, coreEnvironmentBlocksUse, resolveBoardPassport } = passport;

const customBoard = (overrides = {}) => ({
    id: 'vendor_c6_board',
    name: 'Vendor C6',
    version: '1.2.0',
    vendor: 'Vendor',
    fqbn: 'esp32:esp32:esp32c6',
    fqbn_base: 'esp32:esp32:esp32c6',
    pins: [{ label: 'D2', value: '2' }],
    is_custom: true,
    quality_report: {
        status: 'passed',
        warning_count: 0,
        error_count: 0,
        checks: [],
    },
    arduino_core: {
        package: 'esp32:esp32',
        version: '3.3.6',
        min_version: '3.0.0',
        compatible_versions: ['3.2.1'],
        known_incompatible_versions: ['3.3.5'],
    },
    ...overrides,
});

test('compares numeric core versions without treating suffixes as a different API level', () => {
    assert.equal(compareCoreVersions('3.3.6', '3.3.6'), 0);
    assert.equal(compareCoreVersions('3.4.0-rc1', '3.3.6'), 1);
    assert.equal(compareCoreVersions('2.0.17', '3.0.0'), -1);
    assert.equal(compareCoreVersions('custom', '3.0.0'), undefined);
});

test('only the recommended core is green when a recommendation is declared', () => {
    const recommended = resolveBoardPassport(customBoard(), { 'esp32:esp32': '3.3.6' });
    assert.equal(recommended.stages[1].status, 'passed');
    assert.match(recommended.stages[1].summary, /推荐核心/);
    assert.equal(recommended.canCreateProject, true);

    const compatible = resolveBoardPassport(customBoard(), { 'esp32:esp32': '3.2.1' });
    assert.equal(compatible.stages[1].status, 'warning');
    assert.match(compatible.stages[1].summary, /仍需自动复验/);
    assert.equal(compatible.canCreateProject, true);
});

test('without a recommendation only an explicitly tested compatible core is green', () => {
    const noRecommendation = customBoard({
        arduino_core: {
            package: 'esp32:esp32',
            tested_versions: ['3.3.7'],
        },
    });
    const tested = resolveBoardPassport(noRecommendation, { 'esp32:esp32': '3.3.7' });
    assert.equal(tested.stages[1].status, 'passed');
    assert.match(tested.stages[1].summary, /已测试兼容核心/);

    const undeclared = resolveBoardPassport(noRecommendation, { 'esp32:esp32': '3.4.0' });
    assert.equal(undeclared.stages[1].status, 'warning');
    assert.equal(undeclared.canCreateProject, true);
});

test('newer and otherwise untested versions remain usable but require revalidation', () => {
    const newer = resolveBoardPassport(customBoard(), { 'esp32:esp32': '3.4.0' });
    assert.equal(newer.stages[1].status, 'warning');
    assert.match(newer.stages[1].summary, /需自动复验/);
    assert.equal(newer.canCreateProject, true);
    assert.equal(newer.needsLocalCertification, true);

    const olderUnknown = resolveBoardPassport(customBoard({
        arduino_core: { package: 'esp32:esp32', version: '3.3.6' },
    }), { 'esp32:esp32': '2.0.17' });
    assert.equal(olderUnknown.stages[1].status, 'warning');
    assert.equal(olderUnknown.canCreateProject, true, 'a version is not blocked without a declared minimum/incompatibility');
});

test('supports the version_range, tested_versions and object incompatibility schema', () => {
    const schemaBoard = customBoard({
        arduino_core: {
            package: 'esp32:esp32',
            version: '3.3.6',
            version_range: { minimum: '3.0.0', maximum_exclusive: '4.0.0' },
            tested_versions: ['3.3.6', '3.3.7'],
            known_incompatible: [
                { version: '3.2.0', reason: 'upstream USB regression' },
                {
                    version_range: { minimum: '3.1.0', maximum_exclusive: '3.1.2' },
                    reason: 'partition generator regression',
                },
            ],
        },
    });

    const tested = resolveBoardPassport(schemaBoard, { 'esp32:esp32': '3.3.7' });
    assert.equal(tested.stages[1].status, 'warning');
    assert.match(tested.stages[1].summary, /不是推荐版本/);
    assert.equal(tested.canCreateProject, true);
    assert.equal(tested.needsLocalCertification, true);

    const inRange = resolveBoardPassport(schemaBoard, { 'esp32:esp32': '3.4.0' });
    assert.equal(inRange.stages[1].status, 'warning');
    assert.match(inRange.stages[1].summary, /尚未实测/);
    assert.equal(inRange.canCreateProject, true);
    assert.equal(inRange.needsLocalCertification, true);

    const aboveRange = resolveBoardPassport(schemaBoard, { 'esp32:esp32': '4.0.0' });
    assert.equal(aboveRange.stages[1].status, 'warning');
    assert.equal(aboveRange.canCreateProject, true, 'the tested upper boundary requests revalidation instead of a downgrade');

    const exactBad = resolveBoardPassport(schemaBoard, { 'esp32:esp32': '3.2.0' });
    assert.equal(exactBad.canCreateProject, false);
    assert.match(exactBad.blockedReason, /USB regression/);

    const rangeBad = resolveBoardPassport(schemaBoard, { 'esp32:esp32': '3.1.1' });
    assert.equal(rangeBad.canCreateProject, false);
    assert.match(rangeBad.blockedReason, /partition generator regression/);
});

test('uses backend core compatibility status when available', () => {
    const view = resolveBoardPassport(customBoard({
        core_status: { compatibility: 'above_tested_range', message: '5.0.0 needs revalidation' },
    }), { 'esp32:esp32': '5.0.0' });
    assert.equal(view.stages[1].status, 'warning');
    assert.equal(view.canCreateProject, true);
    assert.match(view.stages[1].summary, /needs revalidation/);

    const genericMismatch = resolveBoardPassport(customBoard({
        core_status: { status: 'failed', message: 'different from recommended version' },
    }), { 'esp32:esp32': '3.4.0' });
    assert.equal(genericMismatch.stages[1].status, 'warning');
    assert.equal(genericMismatch.canCreateProject, true, 'a generic version mismatch must not become a blocking error');

    const explicitWarningWins = resolveBoardPassport(customBoard({
        core_status: {
            status: 'tested_non_recommended',
            compatible: true,
            usable: true,
            installed_version: '3.3.7',
            message: 'publisher-tested but non-recommended',
        },
    }), { 'esp32:esp32': '3.3.7' });
    assert.equal(explicitWarningWins.stages[1].status, 'warning', 'compatible=true must not override an explicit warning status');
    assert.equal(explicitWarningWins.canCreateProject, true);

    const legacyIncompatible = resolveBoardPassport(customBoard({
        core_status: { status: 'incompatible', usable: false, installed_version: '3.4.0' },
        usable: false,
    }), { 'esp32:esp32': '3.4.0' });
    assert.equal(legacyIncompatible.stages[1].status, 'warning');
    assert.equal(legacyIncompatible.canCreateProject, true, 'generic incompatible is a warning, even with a stale usable=false flag');

    const backendKnownBad = resolveBoardPassport(customBoard({
        core_status: { compatibility: 'known_incompatible', message: 'confirmed upstream regression' },
    }), { 'esp32:esp32': '3.4.0' });
    assert.equal(backendKnownBad.stages[1].status, 'failed');
    assert.equal(backendKnownBad.canCreateProject, false);

    const conflictingKnownBad = resolveBoardPassport(customBoard({
        usable: false,
        core_status: {
            compatibility: 'compatible',
            code: 'warning',
            status: 'known_incompatible',
            installed_version: '3.4.0',
            usable: false,
            message: 'the concrete status must win over a generic compatibility field',
        },
    }), { 'esp32:esp32': '3.4.0' });
    assert.equal(conflictingKnownBad.stages[1].status, 'failed');
    assert.equal(conflictingKnownBad.canCreateProject, false, 'any concrete hard-block token must take precedence');

    const conflictingBelowMinimum = resolveBoardPassport(customBoard({
        usable: false,
        core_status: {
            compatibility: 'warning',
            code: 'below_minimum',
            status: 'compatible',
            installed_version: '3.4.0',
            usable: false,
        },
    }), { 'esp32:esp32': '3.4.0' });
    assert.equal(conflictingBelowMinimum.stages[1].status, 'failed');
    assert.equal(conflictingBelowMinimum.canCreateProject, false);
});

test('a generic blocked_core passport remains a warning unless its core reason is concrete', () => {
    const staleGenericBlock = resolveBoardPassport(customBoard({
        usable: false,
        passport: {
            certification_status: 'blocked_core',
            core: {
                status: 'tested_non_recommended',
                usable: true,
                requires_revalidation: true,
                installed_version: '3.3.7',
                message: 'local revalidation required',
            },
            profiles: [{ id: 'default', status: 'blocked_core' }],
        },
    }), { 'esp32:esp32': '3.3.7' });
    assert.equal(staleGenericBlock.stages[1].status, 'warning');
    assert.equal(staleGenericBlock.stages[2].status, 'warning');
    assert.equal(staleGenericBlock.canCreateProject, true);

    assert.equal(coreEnvironmentBlocksUse({ status: 'below_minimum' }), true);
    assert.equal(coreEnvironmentBlocksUse({ compatibility: 'known_incompatible', status: 'warning' }), true);
    assert.equal(coreEnvironmentBlocksUse({ status: 'missing' }), true);
    assert.equal(coreEnvironmentBlocksUse({ status: 'incompatible' }), false);
    assert.equal(coreEnvironmentBlocksUse({ status: 'tested_non_recommended' }), false);
    assert.equal(coreEnvironmentBlocksUse({ compatibility: 'compatible', status: 'known_incompatible' }), true);
    assert.equal(coreEnvironmentBlocksUse({ compatibility: 'warning', code: 'below_minimum' }), true);
});

test('legacy known-incompatible strings use normalized SemVer equality', () => {
    const legacyStrings = customBoard({
        arduino_core: {
            package: 'esp32:esp32',
            known_incompatible: ['v3.3.5'],
        },
    });
    const legacyBad = resolveBoardPassport(legacyStrings, { 'esp32:esp32': '3.3.5' });
    assert.equal(legacyBad.stages[1].status, 'failed');
    assert.equal(legacyBad.canCreateProject, false);

    const legacyVersionList = customBoard({
        arduino_core: {
            package: 'esp32:esp32',
            known_incompatible_versions: ['3.3.5'],
        },
    });
    const prefixedInstalled = resolveBoardPassport(legacyVersionList, { 'esp32:esp32': 'v3.3.5' });
    assert.equal(prefixedInstalled.stages[1].status, 'failed');
    assert.equal(prefixedInstalled.canCreateProject, false);
});

test('usable=false is ignored only for an explicit legacy core-version warning', () => {
    const unrelatedUnavailable = resolveBoardPassport(customBoard({
        usable: false,
        core_status: {
            status: 'tested_non_recommended',
            installed_version: '3.3.7',
            usable: true,
        },
    }), { 'esp32:esp32': '3.3.7' });
    assert.equal(unrelatedUnavailable.stages[1].status, 'warning');
    assert.equal(unrelatedUnavailable.canCreateProject, false, 'a current usable core must not hide another backend gate');

    const legacyCoreOnly = resolveBoardPassport(customBoard({
        usable: false,
        core_status: {
            status: 'incompatible',
            installed_version: '3.4.0',
            usable: false,
        },
    }), { 'esp32:esp32': '3.4.0' });
    assert.equal(legacyCoreOnly.stages[1].status, 'warning');
    assert.equal(legacyCoreOnly.canCreateProject, true);
});

test('new revalidation status names are explicit non-blocking warnings', () => {
    for (const status of ['unverified_compatibility', 'revalidation_required']) {
        const view = resolveBoardPassport(customBoard({
            core_status: {
                status,
                installed_version: '3.4.0',
                usable: true,
            },
        }), { 'esp32:esp32': '3.4.0' });
        assert.equal(view.stages[1].status, 'warning', status);
        assert.equal(view.canCreateProject, true, status);
    }
});

test('only unavailable core environments block project creation', () => {
    const tooOld = resolveBoardPassport(customBoard(), { 'esp32:esp32': '2.0.17' });
    assert.equal(tooOld.stages[1].status, 'failed');
    assert.match(tooOld.blockedReason, /低于最低/);
    assert.equal(tooOld.canCreateProject, false);

    const incompatible = resolveBoardPassport(customBoard(), { 'esp32:esp32': '3.3.5' });
    assert.equal(incompatible.stages[1].status, 'failed');
    assert.match(incompatible.blockedReason, /已知不兼容/);

    const missing = resolveBoardPassport(customBoard(), {});
    assert.equal(missing.stages[1].status, 'failed');
    assert.match(missing.blockedReason, /缺少核心/);

    const loading = resolveBoardPassport(customBoard(), { 'esp32:esp32': '3.3.6' }, { coreListLoading: true });
    assert.equal(loading.canCreateProject, false);
    assert.match(loading.blockedReason, /正在检查核心环境/);
});

test('separates structure, local compile and real-device evidence', () => {
    const view = resolveBoardPassport(customBoard({
        passport: {
            local_compile: { status: 'passed', message: '2 profiles passed' },
            device: { status: 'not_verified' },
            ck_lock: { status: 'stale', verified_core_version: '3.3.5' },
        },
    }), { 'esp32:esp32': '3.3.6' });

    assert.deepEqual(view.stages.map(stage => stage.label), [
        '结构检查',
        '环境就绪',
        '本机可编译',
        '真机待验证',
    ]);
    assert.equal(view.stages[2].status, 'passed');
    assert.equal(view.stages[3].status, 'pending');
    assert.match(view.lockSummary, /ck\.lock 已过期/);
    assert.equal(view.canCreateProject, true);
});

test('reads the real ck.lock passport profile and certification fields', () => {
    const certified = resolveBoardPassport(customBoard({
        passport: {
            certification_status: 'compile_certified',
            invalidated_reasons: [],
            core: { status: 'recommended', installed_version: '3.3.6', usable: true },
            profiles: [
                { id: 'n8', fqbn: 'esp32:esp32:esp32c6', status: 'compile_passed' },
                { id: 'n16', fqbn: 'esp32:esp32:esp32c6:FlashSize=16M', status: 'compile_passed' },
            ],
        },
    }), { 'esp32:esp32': '3.3.6' });
    assert.equal(certified.stages[2].status, 'passed');
    assert.match(certified.stages[2].summary, /2 个声明配置/);
    assert.equal(certified.stages[3].status, 'pending');
    assert.match(certified.lockSummary, /ck\.lock 有效/);

    const hardwareVerified = resolveBoardPassport(customBoard({
        passport: {
            certification_status: 'device_verified',
            invalidated_reasons: [],
            core: { status: 'recommended', installed_version: '3.3.6', usable: true },
            profiles: [{ id: 'n8', fqbn: 'esp32:esp32:esp32c6', status: 'device_verified' }],
        },
    }), { 'esp32:esp32': '3.3.6' });
    assert.equal(hardwareVerified.stages[3].status, 'passed');
    assert.equal(hardwareVerified.stages[3].label, '真机已验');

    const expired = resolveBoardPassport(customBoard({
        passport: {
            certification_status: 'expired',
            invalidated_reasons: ['core_version_changed'],
            core: { status: 'newer_untested', installed_version: '3.4.0', usable: true, requires_revalidation: true },
            profiles: [{ id: 'n8', fqbn: 'esp32:esp32:esp32c6', status: 'revalidation_required' }],
        },
    }), { 'esp32:esp32': '3.4.0' });
    assert.equal(expired.stages[1].status, 'warning');
    assert.equal(expired.stages[2].status, 'warning');
    assert.match(expired.lockSummary, /ck\.lock 已过期/);
    assert.equal(expired.canCreateProject, true);
});

test('an unchecked custom package or failed local compile cannot create a project', () => {
    const unchecked = resolveBoardPassport(customBoard({ quality_report: undefined }), { 'esp32:esp32': '3.3.6' });
    assert.equal(unchecked.stages[0].status, 'pending');
    assert.equal(unchecked.canCreateProject, false);

    const failedCompile = resolveBoardPassport(customBoard({
        passport: { compile: { status: 'failed', reason: 'smoke sketch failed' } },
    }), { 'esp32:esp32': '3.3.6' });
    assert.equal(failedCompile.canCreateProject, false);
    assert.equal(failedCompile.blockedReason, 'smoke sketch failed');
});
