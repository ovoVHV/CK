import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./CoreManagerModal.tsx', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'CoreManagerModal.tsx',
    reportDiagnostics: true,
});

const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'CoreManagerModal.tsx should transpile without syntax errors');

test('STM32 recommendation tracks 2.12.0 instead of the obsolete 2.8 catalog', () => {
    const stm32Start = source.indexOf('name: "STM32 (STMicroelectronics)"');
    const stm32End = source.indexOf('name: "RP2040 (Raspberry Pi)"', stm32Start);
    assert.ok(stm32Start >= 0 && stm32End > stm32Start);
    const stm32 = source.slice(stm32Start, stm32End);

    assert.match(stm32, /versions:\s*\["2\.12\.0", "2\.11\.0", "2\.10\.1"\]/);
    assert.match(stm32, /recommendedVersion:\s*"2\.12\.0"/);
    assert.doesNotMatch(stm32, /"2\.8\.1"|"2\.7\.1"/);
});

test('Core Manager offers index-latest without replacing the verified recommendation', () => {
    assert.match(source, /selectedVersions\[core\.id\] \|\| core\.recommendedVersion/);
    assert.match(source, /versionToUse === 'latest'/);
    assert.match(source, /versionToUse = ''/);
    assert.match(source, /<option value="latest">最新可用版本（来自包索引）<\/option>/);
    assert.match(source, /v === core\.recommendedVersion \? '（推荐）'/);
});

test('ESP32 CN core selection resolves the JihuLab index while official 3.3.6 remains the default', () => {
    assert.match(source, /const ESP32_OFFICIAL_INDEX_URL = "https:\/\/espressif\.github\.io\/arduino-esp32\/package_esp32_index\.json"/);
    assert.match(source, /const ESP32_CN_INDEX_URL = "https:\/\/jihulab\.com\/esp-mirror\/espressif\/arduino-esp32\/-\/raw\/gh-pages\/package_esp32_index_cn\.json"/);
    assert.match(source, /"3\.3\.6-cn": ESP32_CN_INDEX_URL/);
    assert.match(source, /"3\.3\.5-cn": ESP32_CN_INDEX_URL/);
    assert.match(source, /recommendedVersion: "3\.3\.6"[\s\S]*index_url: ESP32_OFFICIAL_INDEX_URL/);
    assert.match(source, /defaultIndexUrlForVersion\(core, versionToUse\)/);
    assert.match(source, /defaultIndexUrlForVersion\(core, indexVersion\)/);
    assert.match(source, /customUrls\[core\.id\] !== undefined/);
});
