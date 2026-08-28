import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const transpile = (source, fileName) => ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    fileName,
    reportDiagnostics: true,
}).outputText;

const catalog = await readFile(
    new URL('../../src-tauri/src/ck_forge_bundled_qualifications.v1.json', import.meta.url),
    'utf8',
);
const source = (await readFile(new URL('./ck_forge_core_support.ts', import.meta.url), 'utf8'))
    .replace(
        "import bundledQualifications from '../../src-tauri/src/ck_forge_bundled_qualifications.v1.json';",
        `const bundledQualifications = ${catalog};`,
    );
const support = await import(
    `data:text/javascript;base64,${Buffer.from(transpile(source, 'ck_forge_core_support.ts')).toString('base64')}`
);

test('bundled FLFE Core evidence is resolved per board and exact Core version', () => {
    const certified = support.resolveForgeCoreSupport(
        'arduino:avr:diecimila:cpu=atmega328',
        '1.8.6',
    );
    assert.equal(certified.status, 'certified-evidence-available');
    assert.deepEqual(certified.certifiedCoreVersions, ['1.8.6', '1.8.8']);

    const newer = support.resolveForgeCoreSupport(
        'arduino:avr:diecimila:cpu=atmega328',
        '1.8.8',
    );
    assert.equal(newer.status, 'certified-evidence-available');
    assert.match(newer.label, /1\.8\.8.*已有资格证据/);
});

test('the same policy applies to every platform instead of special-casing AVR', () => {
    const newerEsp32 = support.resolveForgeCoreSupport('esp32:esp32:esp32c6', '3.3.7');
    assert.equal(newerEsp32.status, 'local-certification-required');
    assert.deepEqual(newerEsp32.certifiedCoreVersions, ['3.3.6']);
    assert.match(newerEsp32.detail, /3\.3\.7 仍可正常编译/);

    const unknown = support.resolveForgeCoreSupport('stm32:stm32:GenF4', '2.11.0');
    assert.equal(unknown.status, 'safe-fallback');
    assert.match(unknown.detail, /仍可通过平台原生路径正常编译/);
});

test('reason labels include the current Core version for all version mismatch reasons', () => {
    assert.equal(
        support.forgeReasonLabel('unverified-core-version', '3.3.7'),
        '当前 Core 版本尚无 FLFE 资格证据（当前 Core 3.3.7）',
    );
    assert.equal(
        support.forgeReasonLabel('qualification-core-version-mismatch', '1.8.8'),
        '本机资格证据属于另一 Core 版本（当前 Core 1.8.8）',
    );
});
