import assert from 'node:assert/strict';
import test from 'node:test';
import { loadResourceModule } from './resource_test_loader.mjs';

const { summarizeCompilerLibraryResourceUsage } =
    await loadResourceModule('./compiler_resource_usage.ts');

const evidence = path => ({ path, sha256: `${path}-sha256` });

test('groups verified I2C and SPI observations by the selected implementation', () => {
    const result = summarizeCompilerLibraryResourceUsage({
        traces: [
            {
                blockId: 'aht20-block',
                claimId: 'i2c-claim',
                origin: 'compiler-observation',
                implementation: {
                    file: 'C:/libraries/AHT20/AHT20.cpp',
                    libraryRoot: 'C:/libraries/AHT20',
                    version: '1.0.0',
                },
                steps: [{ function: 'TwoWire::beginTransmission', file: 'Wire.cpp', line: 10 }],
                apiEvidence: [evidence('Wire.cpp')],
            },
            {
                blockId: 'display-block',
                claimId: 'spi-claim',
                origin: 'compiler-observation',
                implementation: {
                    file: 'C:/libraries/Display/Display.cpp',
                    libraryRoot: 'C:/libraries/Display',
                    version: '2.0.0',
                },
                steps: [{ function: 'SPIClass::begin', file: 'SPI.cpp', line: 20 }],
                apiEvidence: [evidence('SPI.cpp')],
                operation: 'spi',
            },
        ],
        claims: [
            {
                id: 'i2c-claim',
                owner: 'aht20',
                reference: 'aht20-block',
                resource: 'i2c0',
                role: 'i2c-device',
                discriminator: '56',
            },
            {
                id: 'spi-claim',
                owner: 'display',
                reference: 'display-block',
                resource: 'spi0',
                role: 'spi-controller-use',
            },
        ],
        gaps: ['recognition.spi-device-selector.unresolved'],
    });

    assert.equal(result.length, 2);
    const aht20 = result.find(item => item.implementation.endsWith('/AHT20'));
    const display = result.find(item => item.implementation.endsWith('/Display'));
    assert.deepEqual(aht20.kinds, ['i2c']);
    assert.deepEqual(aht20.resources, ['i2c0']);
    assert.equal(aht20.status, 'observed');
    assert.deepEqual(display.kinds, ['spi']);
    assert.deepEqual(display.resources, ['spi0']);
    assert.equal(display.status, 'partial');
    assert.ok(display.unresolved.includes('recognition.spi-device-selector.unresolved'));
});

test('falls back to the exact implementation file for direct Core calls', () => {
    const result = summarizeCompilerLibraryResourceUsage({
        traces: [{
            blockId: 'pwm-block',
            claimId: 'pwm-claim',
            origin: 'compiler-observation',
            implementation: {
                file: 'C:/arduino/cores/arduino/wiring_analog.c',
                libraryRoot: '',
            },
            steps: [{ function: 'analogWrite', file: 'wiring_analog.c', line: 30 }],
            apiEvidence: [evidence('wiring_analog.c')],
            operation: 'pwm',
        }],
        claims: [{
            id: 'pwm-claim',
            owner: 'pwm.9',
            reference: 'pwm-block',
            resource: 'timer1',
            role: 'hardware-pwm',
        }],
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].implementation, 'C:/arduino/cores/arduino/wiring_analog.c');
    assert.deepEqual(result[0].kinds, ['pwm']);
});

test('does not invent a usage row without a compiler trace', () => {
    assert.deepEqual(summarizeCompilerLibraryResourceUsage({
        traces: [],
        claims: [{
            id: 'declared-i2c',
            owner: 'declared',
            reference: 'block',
            resource: 'i2c0',
            role: 'i2c-device',
        }],
        gaps: ['recognition.coverage.partial'],
    }), []);
});
