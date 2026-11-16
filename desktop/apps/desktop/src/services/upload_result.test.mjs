import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const built = await build({ entryPoints: [fileURLToPath(new URL('./upload_result.ts', import.meta.url))], bundle: true, format: 'esm', write: false });
const { parseSuccessfulUploadResult: parse } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const identity = { runId: 'upload-run', fqbn: 'arduino:avr:nano:cpu=atmega328old' };
const result = { kind: 'ck-upload-result', schemaVersion: 1, success: true, ...identity,
    compileLog: 'Sketch uses 1234 bytes (4%). Maximum is 30720 bytes.',
    log: 'Upload done', baselineFailure: 'Missing resource evidence' };
test('upload completion carries resource and baseline outcomes without any streamed logs', () => {
    const parsed = parse(JSON.stringify(result), identity);
    assert.equal(parsed.compileLog, result.compileLog);
    assert.equal(parsed.baselineFailure, result.baselineFailure);
    assert.equal(parsed.log, 'Upload done');
});
test('another run, board/menu, malformed payload or failed upload cannot publish successful evidence', () => {
    for (const changes of [{ runId: 'old' }, { fqbn: 'arduino:avr:nano:cpu=atmega328' },
        { success: false }, { schemaVersion: 2 }, { compileLog: null }, { baselineFailure: {} }]) {
        assert.throws(() => parse(JSON.stringify({ ...result, ...changes }), identity));
    }
});
test('legacy log-returning uploads remain compatible without invented measurements', () => {
    assert.deepEqual(parse('Upload successful', identity), {
        log: 'Upload successful', compileLog: '', fqbn: identity.fqbn, baselineFailure: null,
    });
});
