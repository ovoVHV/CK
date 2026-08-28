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
    assert.match(source, /体检会短暂复位开发板，但不会擦除或写入 Flash/);
    assert.match(source, /未报告的 PSRAM、外设与无线功能不会被猜测为不存在/);
});

test('shows complete local MAC, memory, target, and certainty', () => {
    assert.match(source, /data-ck-role="device-health-panel"/);
    assert.match(source, /aria-label="真机实测信息"/);
    assert.match(source, /实体 Flash/);
    assert.match(source, /实体 PSRAM/);
    assert.match(source, /设备 MAC/);
    assert.match(source, /report\.device\.mac/);
    assert.match(source, /detail: report\.target\.resolvedFqbn/);
    assert.match(source, /className: 'col-span-full'/);
    assert.match(source, /dataRole: 'device-health-full-mac'/);
    assert.match(source, /copyValue: report\.device\.mac \|\| undefined/);
    assert.match(source, /复制完整设备 MAC/);
    assert.match(source, /dataRole: 'device-health-full-fqbn'/);
    assert.match(source, /data-ck-device-chip-model=\{report\.device\.chip \|\| ''\}/);
    assert.match(source, /data-ck-device-flash-bytes=\{report\.memory\.flashBytes \?\? ''\}/);
    assert.match(source, /data-ck-device-configured-flash-bytes=\{report\.target\.configuredFlashBytes \?\? ''\}/);
    assert.match(source, /data-ck-device-psram-bytes=\{report\.memory\.psramBytes \?\? ''\}/);
    assert.match(source, /const psramCheckState = report\.checks\.find\(check => check\.id === 'psram'\)\?\.state \?\? 'unknown'/);
    assert.match(source, /data-ck-device-psram-check-state=\{psramCheckState\}/);
    assert.match(source, /data-ck-device-fqbn=\{report\.target\.resolvedFqbn\}/);
    assert.match(source, /copyValue: report\.target\.resolvedFqbn/);
    assert.match(source, /复制完整编译目标 FQBN/);
    assert.match(source, /navigator\.clipboard\?\.writeText/);
    assert.match(source, /select-text whitespace-normal break-words/);
    assert.match(source, /\[overflow-wrap:anywhere\]/);
    assert.match(source, /诊断包与持久化基线仍会脱敏/);
    assert.match(source, /check\.certainty === 'certain' \? '已确认' : '仅提示'/);
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
    assert.match(source, /问题与风险不会被折叠/);
    assert.match(source, /repeat\(auto-fit,minmax\(118px,1fr\)\)/);
    assert.doesNotMatch(source, /block truncate text-\[10px\] font-bold/);
    assert.doesNotMatch(source, /className="truncate text-slate-700/);
    assert.doesNotMatch(source, /mt-0\.5 truncate font-mono/);
});
