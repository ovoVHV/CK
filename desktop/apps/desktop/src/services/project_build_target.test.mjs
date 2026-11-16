import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const compile = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText).toString('base64')}`;
const fqbn = compile(await readFile(new URL('./board_fqbn.ts', import.meta.url), 'utf8'));
const source = (await readFile(new URL('./project_build_target.ts', import.meta.url), 'utf8')).replace("'./board_fqbn'", JSON.stringify(fqbn));
const { captureProjectBuildTarget: capture, readProjectBuildTarget: read, projectBuildTargetDifference: difference, sourceWithBuildTarget } = await import(compile(source));
const env = () => ({ board: 'esp32:esp32:esp32s3', boardPackageId: 'ck:s3', coreVersion: '3.3.6-cn',
    options: {}, effectiveOptions: { PSRAM: 'disabled', USBMode: 'hwcdc', PartitionScheme: 'default', FlashSize: '8M' }, resolved: true });

test('save freezes every default, concrete package, Core and full FQBN', () => {
    const input = env(); const saved = capture(input, null);
    assert.deepEqual(saved.options, input.effectiveOptions);
    assert.equal(saved.optionsComplete, true);
    assert.equal(saved.coreVersion, '3.3.6-cn');
    assert.equal(saved.boardPackageId, 'ck:s3');
    assert.deepEqual(read(JSON.stringify(saved)), saved);
    assert.match(saved.fqbn, /PSRAM=disabled/);
});
test('old project without metadata remains readable; unsupported or corrupt target is rejected', () => {
    assert.equal(read(undefined), null);
    assert.throws(() => read('{'), SyntaxError);
    const saved = capture(env(), null);
    for (const changed of [{ schemaVersion: 2 }, { options: { PSRAM: '../bad' } }, { fqbn: 'arduino:avr:uno' }, { coreId: 'arduino:avr' }]) {
        assert.throws(() => read({ ...saved, ...changed }));
    }
});
test('new Core defaults cannot override saved values; changing Core requires explicit adoption', () => {
    const saved = capture(env(), null);
    const next = { ...env(), coreVersion: '3.3.13', options: saved.options, effectiveOptions: { ...env().effectiveOptions, PSRAM: 'opi' } };
    assert.match(difference(saved, next), /3\.3\.6-cn.*3\.3\.13/);
    const preserved = capture(next, saved);
    assert.equal(preserved.coreVersion, saved.coreVersion);
    assert.equal(preserved.options.PSRAM, 'disabled');
    const adopted = capture(next, null);
    assert.equal(adopted.coreVersion, '3.3.13');
    assert.equal(difference(adopted, next), null);
});
test('saving offline preserves an existing Core and all pinned options', () => {
    const saved = capture(env(), null);
    const offline = { ...env(), options: saved.options, effectiveOptions: {}, resolved: false, coreVersion: '' };
    assert.match(difference(saved, offline), /未安装/);
    assert.deepEqual(capture(offline, saved), saved);
    const old = capture({ ...offline, options: { PSRAM: 'opi' } }, null);
    assert.equal(old.optionsComplete, false);
    assert.equal(old.coreVersion, null);
});

test('a live Core change preserves saved defaults even before an older caller pins them in memory', () => {
    const saved = capture(env(), null);
    const next = { ...env(), coreVersion: '3.3.13', options: { FlashSize: '16M' } };
    const preserved = capture(next, saved);
    assert.equal(preserved.options.PSRAM, 'disabled');
    assert.equal(preserved.options.FlashSize, '16M');
    assert.equal(preserved.coreVersion, '3.3.6-cn');
    assert.equal(preserved.optionsComplete, true);
});
test('an explicit board/package switch does not inherit the previous Core or options', () => {
    const saved = capture(env(), null);
    const next = { board: 'arduino:avr:nano', boardPackageId: 'arduino:avr:nano', coreVersion: '1.8.6',
        options: { cpu: 'atmega328old' }, effectiveOptions: { cpu: 'atmega328old' }, resolved: true };
    assert.equal(difference(saved, next), null);
    const nano = read(capture(next, saved));
    assert.equal(nano.coreId, 'arduino:avr');
    assert.equal(nano.fqbn, 'arduino:avr:nano:cpu=atmega328old');
    assert.deepEqual(nano.options, { cpu: 'atmega328old' });
});
test('new menu names require confirmation even when the Core version string has not changed', () => {
    const saved = capture(env(), null);
    const next = { ...env(), options: saved.options, effectiveOptions: { ...env().effectiveOptions, DebugLevel: 'none' } };
    assert.match(difference(saved, next), /DebugLevel/);
    assert.equal('DebugLevel' in capture(next, saved).options, false);
});
test('new or unresolved projects never claim their defaults are completely recorded', () => {
    const next = { ...env(), resolved: false, options: { FlashSize: '16M' } };
    const saved = capture(next, null);
    assert.equal(saved.optionsComplete, false);
    assert.deepEqual(saved.options, { FlashSize: '16M' });
});

test('copied code carries configuration as comments without rewriting source or allowing metadata newlines to become code', () => {
    const target = capture(env(), null);
    const code = '#include <WiFi.h>\nvoid setup() {}\nvoid loop() {}\n';
    const text = sourceWithBuildTarget(code, { ...target, coreVersion: '3.3.6-cn\n#error injected' });
    const lines = text.split('\n');
    assert.equal(lines[0].startsWith('// '), true);
    assert.equal(lines[1].startsWith('// '), true);
    assert.equal(lines.slice(3).join('\n'), code);
    assert.equal(JSON.parse(lines[1].slice(3)).options.PSRAM, 'disabled');
});
