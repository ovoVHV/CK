import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const result = await build({ entryPoints: [fileURLToPath(new URL('./health_capability.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
const { describeHealthCapability: describe } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
test('coverage never promotes code availability or publisher pins to hardware evidence', () => {
    const c6 = { fqbn: 'esp32:esp32:esp32c6:FlashSize=16M', coreVersion: '3.3.6' };
    assert.equal(describe(c6).evidence, 'hardware-verified');
    for (const model of ['esp32c3', 'esp32c5', 'esp32s2', 'esp32s3', 'esp32']) {
        const result = describe({ ...c6, fqbn: `esp32:esp32:${model}:FlashSize=16M` });
        assert.equal(result.device, 'available');
        assert.equal(result.evidence, 'code-path-verified');
    }
    assert.notEqual(describe({ ...c6, coreVersion: '3.3.7' }).evidence, 'hardware-verified');
    assert.notEqual(describe({ ...c6, configuredFlashBytes: 8388608 }).evidence, 'hardware-verified');
    assert.deepEqual(describe({ fqbn: 'arduino:avr:nano' }), { engineering: 'available', pin: 'available', device: 'unsupported', evidence: 'none' });
    for (const trustedPins of [false, true]) {
        const result = describe({ ...c6, customBoard: true, trustedPins });
        assert.equal(result.engineering, 'available');
        assert.equal(result.pin, trustedPins ? 'available' : 'unsupported');
        assert.notEqual(result.evidence, 'hardware-verified');
    }
});
