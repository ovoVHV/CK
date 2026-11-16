import assert from 'node:assert/strict';
import test from 'node:test';
import { loadResourceModule } from './resource_test_loader.mjs';
const { analyzeHardwareResources: analyze, validateBoardResourceGraph: validate } = await loadResourceModule('./hardware_resource_graph.ts');
const node = (id, sharing = 'shared', extra = {}) => ({ id, type: 'fixture-resource', sharing, evidence: ['fixture'], ...extra });
const graph = (...resources) => ({ version: 1, resources, routes: [], evidence: [{ id: 'fixture', source: 'synthetic-test-only', confidence: 'declared' }], coverage: 'full' });
const claim = (id, resource, extra = {}) => ({ id, owner: id, reference: id, resource, role: 'consumer', ...extra });

test('one GPIO role keeps multiple source references without capability becoming usage', () => {
  const result = analyze(graph(node('pin13', 'exclusive'), node('spi0')), [claim('a', 'pin13', { owner: 'gpio-output', role: 'output' }), claim('b', 'pin13', { owner: 'gpio-output', role: 'output' })]);
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(result.usages[0].references, ['a', 'b']);
  assert.equal(result.usages.length, 1);
});
test('I2C distinct addresses share, same reachable segment collides', () => {
  const g = graph(node('bus', 'address'));
  const claims = ['60', '56', '104'].map((address, i) => claim(`c${i}`, 'bus', { discriminator: address, segment: 'root' }));
  assert.equal(analyze(g, claims).conflicts.length, 0);
  claims[1].discriminator = '60';
  assert.equal(analyze(g, claims).conflicts.length, 1);
  claims[1].segment = 'isolated-channel-1';
  assert.equal(analyze(g, claims).conflicts.length, 0);
});
test('SPI selectors and unknown advanced configuration remain separate', () => {
  const g = graph(node('spi', 'selector', { configurationKeys: ['mode'] }));
  const a = claim('a', 'spi', { discriminator: 'pin10', configuration: { mode: 0 } });
  const b = claim('b', 'spi', { discriminator: 'pin8', configuration: { mode: 0 } });
  assert.equal(analyze(g, [a, b]).conflicts.length, 0);
  assert.equal(analyze(g, [a, { ...b, discriminator: 'pin10' }]).conflicts.length, 1);
  assert.equal(analyze(g, [{ ...a, configuration: undefined }]).coverage, 'partial');
});
test('software bus signal cannot merge with generic GPIO output', () => {
  const r = analyze(graph(node('pin4', 'exclusive')), [claim('soft', 'pin4', { role: 'softspi1.sck' }), claim('gpio', 'pin4', { role: 'output' })]);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.usages[0].roles.length, 2);
});
test('UART configuration uses controller identity', () => {
  const g = graph(node('uart0', 'configuration', { configurationKeys: ['baud'] }), node('uart1', 'configuration', { configurationKeys: ['baud'] }));
  const a = claim('a', 'uart0', { configuration: { baud: 9600 } });
  const b = claim('b', 'uart0', { configuration: { baud: 115200 } });
  assert.equal(analyze(g, [a, b]).conflicts.length, 1);
  assert.equal(analyze(g, [a, { ...b, resource: 'uart1' }]).conflicts.length, 0);
});
test('timer exclusivity reaches child channels regardless of pin', () => {
  const g = graph(node('timer1'), node('channelA', 'exclusive', { parent: 'timer1' }), node('channelB', 'exclusive', { parent: 'timer1' }));
  const r = analyze(g, [claim('servo', 'timer1', { exclusive: true }), claim('pwm', 'channelB')]);
  assert.equal(r.conflicts[0].resource, 'timer1');
  assert.deepEqual(r.bindings[1].ancestors, ['timer1']);
});
test('missing declarations and missing binding never yield full coverage', () => {
  assert.equal(analyze(graph(node('pin')), [], 1).coverage, 'partial');
  assert.equal(analyze(graph(node('pin')), [claim('a', 'missing')]).coverage, 'partial');
  assert.equal(analyze(graph(), []).coverage, 'unknown');
});
test('unknown single-device address and policy are incomplete', () => {
  assert.equal(analyze(graph(node('bus', 'address')), [claim('a', 'bus')]).coverage, 'partial');
  assert.equal(analyze(graph(node('bus', 'configuration')), [claim('a', 'bus')]).coverage, 'partial');
});
test('invalid graphs fail closed without executing accessors', () => {
  assert.throws(() => validate(graph(node('a', 'shared', { parent: 'a' }))));
  assert.throws(() => validate(graph(node('a'), node('a'))));
  assert.throws(() => validate(JSON.parse('{"__proto__": {}}')));
  let called = false;
  const dangerous = { get version() { called = true; return 1; } };
  assert.throws(() => validate(dangerous));
  assert.equal(called, false);
  assert.throws(() => validate({ ...graph(), resources: Array(1025).fill(node('a')) }));
});
test('analysis leaves capability and claim inputs unchanged', () => {
  const g = graph(node('pin'));
  const claims = [claim('a', 'pin')];
  const before = JSON.stringify({ g, claims });
  analyze(g, claims);
  assert.equal(JSON.stringify({ g, claims }), before);
});
test('fixed bus routes share signals but conflict with unrelated digital output', () => {
  const g = graph(node('bus', 'selector'), node('pin13', 'exclusive'));
  g.routes.push({ id: 'clock', resource: 'bus', signal: 'sck', mode: 'fixed', pins: ['pin13'] });
  const claims = [claim('a', 'bus', { discriminator: 'cs1' }), claim('b', 'bus', { discriminator: 'cs2' })];
  assert.equal(analyze(g, claims).conflicts.length, 0);
  const result = analyze(g, [...claims, claim('gpio', 'pin13', { role: 'output' })]);
  assert.ok(result.conflicts.some(c => c.resource === 'pin13'));
  assert.deepEqual(result.usages.find(u => u.resource === 'pin13').roles, ['bus.sck', 'output']);
});
test('flexible routing fails incomplete when no permitted pin is selected', () => {
  const g = graph(node('uart'), node('pin4'));
  g.routes.push({ id: 'tx', resource: 'uart', signal: 'tx', mode: 'selectable', pins: ['pin4'] });
  assert.equal(analyze(g, [claim('a', 'uart')]).coverage, 'partial');
  assert.equal(analyze(g, [claim('a', 'uart', { signals: { tx: 'pin4' } })]).coverage, 'full');
  assert.equal(analyze(g, [claim('a', 'uart', { signals: { tx: 'pin9' } })]).coverage, 'partial');
});
