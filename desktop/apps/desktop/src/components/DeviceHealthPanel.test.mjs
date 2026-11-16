import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./DeviceHealthPanel.tsx', import.meta.url), 'utf8');
const diagnosticFrontendSource = await readFile(new URL('../services/diagnostic_bundle.ts', import.meta.url), 'utf8');
const diagnosticBackendSource = await readFile(new URL('../../src-tauri/src/diagnostic_bundle.rs', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'DeviceHealthPanel.tsx',
    reportDiagnostics: true,
});
const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);

test('device health panel remains valid TSX', () => {
    assert.deepEqual(syntaxErrors, []);
});

test('makes the reset-only and no-write boundary explicit', () => {
    assert.match(source, /t\('device\.resetDisclaimer'\)/);
    assert.match(source, /t\('device\.resetDisclaimerShort'\)/);
});

test('shows complete local MAC, memory, target, and certainty', () => {
    assert.match(source, /data-ck-role="device-health-panel"/);
    assert.match(source, /aria-label=\{t\('device\.title'\)\}/);
    assert.match(source, /t\('device\.fact\.flash'\)/);
    assert.match(source, /t\('device\.fact\.psram'\)/);
    assert.match(source, /t\('device\.fact\.mac'\)/);
    assert.match(source, /report\.device\.mac/);
    assert.match(source, /detail: report\.target\.resolvedFqbn/);
    assert.match(source, /className: 'col-span-full'/);
    assert.match(source, /dataRole: 'device-health-full-mac'/);
    assert.match(source, /copyValue: report\.device\.mac \|\| undefined/);
    assert.match(source, /copyLabel: t\('device\.copyFullMac'\)/);
    assert.match(source, /dataRole: 'device-health-full-fqbn'/);
    assert.match(source, /data-ck-device-chip-model=\{report\.device\.chip \|\| ''\}/);
    assert.match(source, /data-ck-device-flash-bytes=\{report\.memory\.flashBytes \?\? ''\}/);
    assert.match(source, /data-ck-device-configured-flash-bytes=\{report\.target\.configuredFlashBytes \?\? ''\}/);
    assert.match(source, /data-ck-device-psram-bytes=\{report\.memory\.psramBytes \?\? ''\}/);
    assert.match(source, /const psramCheckState = report\.checks\.find\(check => check\.id === 'psram'\)\?\.state \?\? 'unknown'/);
    assert.match(source, /data-ck-device-psram-check-state=\{psramCheckState\}/);
    assert.match(source, /data-ck-device-fqbn=\{report\.target\.resolvedFqbn\}/);
    assert.match(source, /copyValue: report\.target\.resolvedFqbn/);
    assert.match(source, /copyLabel: t\('device\.copyFullFqbn'\)/);
    assert.match(source, /navigator\.clipboard\?\.writeText/);
    assert.match(source, /select-text whitespace-normal break-words/);
    assert.match(source, /\[overflow-wrap:anywhere\]/);
    assert.match(source, /t\('device\.fullMacPrivacy'\)/);
    assert.match(source, /t\(`device\.certainty\.\$\{check\.certainty\}`\)/);
});

test('keeps diagnostic export privacy enabled and always redacts complete MAC addresses', () => {
    assert.match(diagnosticFrontendSource, /redactWifi: true/);
    assert.match(diagnosticFrontendSource, /redactUsername: true/);
    assert.match(diagnosticFrontendSource, /redactPaths: true/);
    assert.match(diagnosticFrontendSource, /redactSerialContent: true/);
    assert.match(diagnosticBackendSource, /fn redact_mac\(input: &str\)/);
    assert.match(diagnosticBackendSource, /full_mac_is_always_redacted_even_when_optional_privacy_is_disabled/);
});

test('retains a compact representation without hiding the highest-severity check', () => {
    assert.match(source, /actionableChecks = presentation\.orderedChecks\.filter\(check => check\.state === 'error' \|\| check\.state === 'warning'\)/);
    assert.match(source, /const visibleChecks = compact \|\| simple/);
    assert.match(source, /actionableChecks\.length > 0 \? actionableChecks : presentation\.orderedChecks\.slice\(0, 1\)/);
    assert.match(source, /t\('device\.hiddenChecks'/);
    assert.match(source, /repeat\(auto-fit,minmax\(118px,1fr\)\)/);
    assert.doesNotMatch(source, /block truncate text-\[10px\] font-bold/);
    assert.doesNotMatch(source, /className="truncate text-slate-700/);
    assert.doesNotMatch(source, /mt-0\.5 truncate font-mono/);
});
