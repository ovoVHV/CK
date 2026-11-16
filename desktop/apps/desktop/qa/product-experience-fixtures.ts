// QA-only fixtures. Nothing here is imported by the application entry point.
import { analyzeHardwareResources, type BoardResourceGraph, type ResourceClaim } from '../src/services/hardware_resource_graph';
import { buildHardwareResourceInspector } from '../src/services/hardware_resource_inspector';
import { buildResourcePreflight } from '../src/services/resource_preflight';
import { resolveAvrResourceModel } from '../src/services/avr_resource_model';
import { analyzeAvrWorkspaceResources } from '../src/services/avr_builtin_resource_claims';
import { resolveEsp32ResourceModel } from '../src/services/esp32_resource_model';
import { resolveEsp32C3ResourceModel } from '../src/services/esp32_c3_resource_model';
import { analyzeEsp32WorkspaceResources } from '../src/services/esp32_builtin_resource_claims';

const literal = (type: string, field: string, value: string) => ({
    id: `literal-${field}`, type, getFieldValue: (name: string) => name === field ? value : undefined,
    getInputTargetBlock: () => null,
});
const block = (id: string, type: string, inputs: Record<string, ReturnType<typeof literal>>) => ({
    id, type, getFieldValue: () => undefined, getInputTargetBlock: (name: string) => inputs[name] ?? null,
});
const fullCoverage = { declarationCoverage: 'full', analysisCoverage: 'full', projectCoverage: 'full', hardwareValidation: 'not-tested' } as const;
const classic = { fqbn: 'esp32:esp32:esp32', options: {}, mcu: 'esp32', variant: 'esp32', coreVersion: '3.3.6', fCpu: '240000000L' };

export function createExperienceFixture(name: string) {
    if (name === 'blink' || name === 'usb' || name === 'ledc') {
        const identity = name === 'blink'
            ? { fqbn: 'arduino:avr:uno', options: {}, mcu: 'atmega328p', variant: 'standard', coreVersion: '1.8.8', fCpu: '16000000L' }
            : name === 'usb'
                ? { fqbn: 'esp32:esp32:esp32c3', options: { CDCOnBoot: 'cdc' }, mcu: 'esp32c3', variant: 'esp32c3', coreVersion: '3.3.6', fCpu: '160000000L' }
                : classic;
        const model = name === 'blink' ? resolveAvrResourceModel(identity) : name === 'usb' ? resolveEsp32C3ResourceModel(identity) : resolveEsp32ResourceModel(identity);
        const workspace = { getAllBlocks: () => [
            name === 'blink' ? block('d13', 'io_digital_write', { PIN: literal('board_pin_selector', 'PIN', '13') })
                : name === 'usb' ? block('usb', 'serial_setup', { BAUD: literal('math_number', 'NUM', '115200') })
                    : block('pwm', 'io_analog_write', { PIN: literal('board_pin_selector', 'PIN', '13'), VALUE: literal('math_number', 'NUM', '128') }),
        ] };
        const result = name === 'blink' ? analyzeAvrWorkspaceResources(identity, workspace) : analyzeEsp32WorkspaceResources(identity, workspace);
        if (model.status !== 'ready' || result.status !== 'ready') throw new Error(`QA fixture unavailable: ${name}`);
        const view = buildHardwareResourceInspector({ graph: model.resource_graph, analysis: result.report, claims: result.claims, coverage: result.coverage, gaps: result.gaps });
        return { view, report: buildResourcePreflight({ phase: 'edit', inspector: view, analysis: result.report }), graph: model.resource_graph, analysis: result.report, claims: result.claims, identity };
    }

    let graph: BoardResourceGraph;
    let claims: ResourceClaim[];
    if (name === 'shared' || name === 'spi-route-gap') {
        const model = resolveEsp32ResourceModel(classic);
        if (model.status !== 'ready') throw new Error('QA classic model unavailable');
        graph = model.resource_graph;
        claims = [
            ...[['OLED', '60'], ['AHT20', '56'], ['MPU6050', '104']].map(([reference, discriminator], index) => ({
                id: `i2c-${index}`, owner: 'qa-i2c', reference, resource: 'i2c0', role: 'i2c-device', discriminator, segment: 'i2c0', signals: { sda: 'gpio.21', scl: 'gpio.22' },
            })),
        ];
        if (name === 'spi-route-gap') claims.push(...[['SD Card', 'gpio.5'], ['TFT', 'gpio.25']].map(([reference, discriminator], index) => ({
            id: `spi-${index}`, owner: 'qa-spi', reference, resource: 'spi3', role: 'spi-device', discriminator, signals: { sck: 'gpio.18', mosi: 'gpio.23', miso: 'gpio.19' },
        })));
    } else if (name === 'spi') {
        // Same generic sharing fixture as resource_preflight.test.mjs.
        graph = {
            version: 1, coverage: 'full',
            resources: [{ id: 'acme.board.sensor-bus', type: 'spi-controller', aliases: ['ACME-SPI'], sharing: 'selector', evidence: ['acme-spec'] }],
            routes: [],
            evidence: [{ id: 'acme-spec', source: 'acme-board-resource-package', confidence: 'declared' }],
        };
        claims = [
            { id: 'acme-device-a', owner: 'acme-display', reference: 'block:acme-display', resource: 'acme.board.sensor-bus', role: 'spi-device', discriminator: 'acme.board.cs-a' },
            { id: 'acme-device-b', owner: 'acme-storage', reference: 'block:acme-storage', resource: 'acme.board.sensor-bus', role: 'spi-device', discriminator: 'acme.board.cs-b' },
        ];
    } else if (name === 'third-party') {
        graph = {
            version: 1, coverage: 'full',
            resources: [
                { id: 'vendor.gpio.a', type: 'gpio', aliases: ['VGPIO_A'], capabilities: ['digital-input', 'digital-output'], sharing: 'exclusive', evidence: ['vendor-spec'] },
                { id: 'vendor.gpio.b', type: 'gpio', aliases: ['VGPIO_B'], capabilities: ['digital-input', 'digital-output'], sharing: 'exclusive', evidence: ['vendor-spec'] },
                { id: 'vendor.i2c0', type: 'i2c-controller', aliases: ['VendorWire'], sharing: 'address', evidence: ['vendor-spec'] },
            ],
            routes: [
                { id: 'vendor.sda', resource: 'vendor.i2c0', signal: 'sda', mode: 'selectable', pins: ['vendor.gpio.a'] },
                { id: 'vendor.scl', resource: 'vendor.i2c0', signal: 'scl', mode: 'selectable', pins: ['vendor.gpio.b'] },
            ],
            evidence: [{ id: 'vendor-spec', source: 'vendor.example/board-resource.json', confidence: 'declared' }],
        };
        claims = [{ id: 'sensor', owner: 'vendor.example', reference: 'vendor-device', resource: 'vendor.i2c0', role: 'i2c-device', discriminator: '66', segment: 'vendor.i2c0', signals: { sda: 'vendor.gpio.a', scl: 'vendor.gpio.b' } }];
    } else {
        // Existing timer conflict acceptance scenario, not a claim about a physical board/provider.
        graph = {
            version: 1, coverage: 'full',
            resources: [{ id: 'TIMER1', type: 'timer', sharing: 'exclusive', evidence: ['fixture'] }],
            routes: [],
            evidence: [{ id: 'fixture', source: 'timer-conflict-acceptance-fixture', confidence: 'declared' }],
        };
        claims = [
            { id: 'servo', owner: 'qa', reference: 'block:servo-1', resource: 'TIMER1', role: 'servo', exclusive: true },
            { id: 'pwm', owner: 'qa', reference: 'block:pwm-1', resource: 'TIMER1', role: 'pwm', exclusive: true },
        ];
    }
    const analysis = analyzeHardwareResources(graph, claims);
    const view = buildHardwareResourceInspector({ graph, analysis, claims, coverage: fullCoverage });
    return { view, report: buildResourcePreflight({ phase: 'compile', inspector: view, analysis }), graph, analysis, claims, identity: null };
}
