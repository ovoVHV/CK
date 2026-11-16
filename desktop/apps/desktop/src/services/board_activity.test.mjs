import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const bundle = await build({ entryPoints: [fileURLToPath(new URL('./board_activity.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' });
const { resolveBoardActivity, boardCardPassportStages } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const nano = { id: 'arduino:avr:nano', fqbn: 'arduino:avr:nano' };
const record = (overrides = {}) => ({ boardPackageId: nano.id, fqbn: nano.fqbn + ':cpu=atmega328', coreVersion: '1.8.8', operation: 'compile', completedAt: '2026-11-04T00:00:00Z', ...overrides });

test('compile and upload badges reflect distinct host successes for the current Core', () => {
    let states = resolveBoardActivity(nano, '1.8.8', [record()]);
    assert.deepEqual(states.map(s => s.count), [1, 0]);
    states = resolveBoardActivity(nano, '1.8.8', [record(), record({ operation: 'upload' })]);
    assert.deepEqual(states.map(s => s.count), [1, 1]);
});
test('full CPU configurations remain explicit and cannot certify every configuration', () => {
    const rows = [record(), record({ fqbn: nano.fqbn + ':cpu=atmega168' })];
    const [state] = resolveBoardActivity(nano, '1.8.8', rows);
    assert.equal(state.count, 2);
    assert.equal(state.current[0].fqbn, rows[0].fqbn);
    assert.equal(state.current[1].fqbn, rows[1].fqbn);
});
test('different packages, boards, Core versions, unknown Core and malformed rows never turn green', () => {
    const rows = [record({ boardPackageId: 'custom-nano' }), record({ fqbn: 'arduino:avr:uno' }), record({ coreVersion: '1.8.7' }), record({ completedAt: 'bad' }), record({ operation: 'failed' }), null];
    const [state] = resolveBoardActivity(nano, '1.8.8', rows);
    assert.equal(state.count, 0); assert.equal(state.history.length, 1);
    assert.equal(resolveBoardActivity(nano, undefined, [record()])[0].count, 0);
    assert.equal(resolveBoardActivity(nano, '1.8.8', { invalid: true })[0].count, 0);
});
test('Core 3.3.6 and 3.3.6-cn history is not conflated', () => {
    const board = { id: 'esp32:esp32:esp32s3', fqbn: 'esp32:esp32:esp32s3' };
    const rows = [record({ boardPackageId: board.id, fqbn: board.fqbn, coreVersion: '3.3.6-cn' })];
    assert.equal(resolveBoardActivity(board, '3.3.6', rows)[0].count, 0);
    assert.equal(resolveBoardActivity(board, '3.3.6-cn', rows)[0].count, 1);
});
test('builtins show ordinary activity; AVR never displays unsupported device qualification', () => {
    const view = { stages: ['structure','environment','compile','device'].map(id => ({ id })) };
    for (const board of ['uno','nano','mega','diecimila']) {
        const target = { id: 'arduino:avr:' + board, fqbn: 'arduino:avr:' + board };
        assert.deepEqual(boardCardPassportStages(target, view).map(s => s.id), ['structure','environment']);
        assert.deepEqual(boardCardPassportStages({ ...target, is_custom: true }, view).map(s => s.id), ['structure','environment','compile']);
    }
    const esp = { id: 'vendor-esp32', fqbn: 'esp32:esp32:esp32s3', is_custom: true };
    assert.equal(boardCardPassportStages(esp, view).length, 4);
});
test('host exposes only a reader and records upload after transport success, never preparation', () => {
    const source = fs.readFileSync(new URL('../../src-tauri/src/lib.rs', import.meta.url), 'utf8');
    const upload = source.slice(source.indexOf('async fn upload_sketch_impl('), source.indexOf('async fn restore_last_working_firmware('));
    const write = upload.indexOf('board_activity::Operation::Upload');
    assert(write > upload.indexOf('let upload_outcome = run_upload_transport_with_identity_gate('));
    assert(write > upload.indexOf('if observe_preparation_only'));
    assert.match(upload.slice(0,write), /if probe_memory\.unwrap_or\(true\) \{/);
    const handlers = source.slice(source.indexOf('.invoke_handler(tauri::generate_handler!['));
    assert.match(handlers, /get_board_success_history,/);
    assert.doesNotMatch(handlers, /record_board_success,/);
});
