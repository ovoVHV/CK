import assert from 'node:assert/strict';
import test from 'node:test';
import { loadResourceModule } from './resource_test_loader.mjs';

const { installCloudLibraryQueue } = await loadResourceModule('./cloud_library_install.ts');
const items = ['one', 'two', 'three'].map(name => ({ name, url: `gitee-raw://owner/repo/master#${name}` }));
const visible = id => ({ id, user_installed: true, runtime_activation: { state: 'declarative-safe' } });
const callbacks = { onStart() {}, onRefresh() {}, onResults() {} };

test('single install waits for inventory confirmation and publishes persistent results', async () => {
    const events = [];
    const results = await installCloudLibraryQueue([items[0]], {
        ...callbacks,
        install: async () => { events.push('install'); return 'one'; },
        refresh: async () => { events.push('refresh'); return [visible('one')]; },
        onResults: results => events.push(results[0].status),
    });
    assert.deepEqual(events, ['install', 'checking', 'refresh', 'installed']);
    assert.equal(results[0].packageId, 'one');
});

test('failed single install retains backend rejection and never reports success', async () => {
    const error = 'Quality gate rejected\nInvalid generator entry';
    const results = await installCloudLibraryQueue([items[0]], {
        ...callbacks,
        install: async () => { throw error; },
        refresh: async () => { assert.fail('nothing was installed'); },
    });
    assert.equal(results[0].status, 'failed');
    assert.equal(results[0].error, error);
});

test('batch continues after one failure and refreshes successful installs exactly once', async () => {
    const calls = [];
    const results = await installCloudLibraryQueue(items, {
        ...callbacks,
        install: async item => { calls.push(item.name); if (item.name === 'two') throw 'HTTP 503'; return item.name; },
        refresh: async () => { calls.push('refresh'); return [visible('one'), visible('three')]; },
    });
    assert.deepEqual(calls, ['one', 'two', 'three', 'refresh']);
    assert.deepEqual(results.map(result => result.status), ['installed', 'failed', 'installed']);
});

test('refresh rejection or swallowed error cannot turn into installation success', async () => {
    for (const refresh of [async () => undefined, async () => { throw new Error('inventory failed'); }]) {
        const [result] = await installCloudLibraryQueue([items[0]], { ...callbacks, install: async () => 'one', refresh });
        assert.equal(result.status, 'unconfirmed');
        assert.equal(result.reason, 'refreshFailed');
        assert.equal(result.packageId, 'one');
    }
});

test('missing or shadowed package is not reported as available', async () => {
    for (const inventory of [[], [{ id: 'one', user_installed: false }]]) {
        const [result] = await installCloudLibraryQueue([items[0]], {
            ...callbacks, install: async () => 'one', refresh: async () => inventory,
        });
        assert.equal(result.status, 'unconfirmed');
        assert.equal(result.reason, 'notVisible');
    }
});

test('disabled legacy code stays installed but is not claimed to be usable', async () => {
    const [result] = await installCloudLibraryQueue([items[0]], {
        ...callbacks, install: async () => 'one',
        refresh: async () => [{ ...visible('one'), runtime_activation: { state: 'legacy-disabled', reason: 'Legacy JavaScript disabled' } }],
    });
    assert.equal(result.status, 'unconfirmed');
    assert.equal(result.reason, 'runtimeDisabled');
    assert.equal(result.error, 'Legacy JavaScript disabled');
});

test('missing backend package ID is a failure', async () => {
    const [result] = await installCloudLibraryQueue([items[0]], {
        ...callbacks, install: async () => '', refresh: async () => [],
    });
    assert.equal(result.status, 'failed');
});
