import snapshot from '../config/esp32-resource-evidence/esp32-dev-module-3.3.6.json';
import type { BoardResourceGraph, HardwareResource } from './hardware_resource_graph';
import { createResourceGraphBuilder } from './resource_graph_builder';

export interface Esp32ResolvedIdentity {
  fqbn: string;
  options: Record<string, string>;
  mcu: string;
  variant: string;
  coreVersion: string;
  fCpu: string;
}

const baseFqbn = 'esp32:esp32:esp32';
const fCpuValues = new Set(['240000000L', '160000000L', '80000000L', '40000000L', '26000000L', '20000000L', '13000000L', '10000000L']);
const optionValues: Record<string, Set<string>> = {
  JTAGAdapter: new Set(['default', 'external', 'bridge']), PSRAM: new Set(['disabled', 'enabled']),
  CPUFreq: new Set(['240', '160', '80', '40', '26', '20', '13', '10']), FlashMode: new Set(['qio', 'dio']),
  FlashFreq: new Set(['80', '40']), FlashSize: new Set(['2M', '4M', '8M', '16M']), UploadSpeed: new Set(['921600', '512000', '460800', '256000', '230400', '115200']),
  PartitionScheme: new Set(['default', 'defaultffat', 'default_8MB', 'minimal', 'no_fs', 'no_ota', 'noota_3g', 'noota_ffat', 'noota_3gffat', 'huge_app', 'min_spiffs', 'fatflash', 'app3M_fat9M_16MB', 'rainmaker', 'rainmaker_4MB', 'rainmaker_8MB', 'storage_4MB', 'zigbee_zczr', 'zigbee_zczr_8MB', 'custom']),
  LoopCore: new Set(['0', '1']), EventsCore: new Set(['0', '1']), DebugLevel: new Set(['none', 'error', 'warn', 'info', 'debug', 'verbose']),
  EraseFlash: new Set(['none', 'all']), ZigbeeMode: new Set(['default', 'zczr']),
};

export function matchesEsp32Identity(identity: Esp32ResolvedIdentity) {
  if (identity.fqbn.split(':').slice(0, 3).join(':') !== baseFqbn || identity.mcu !== 'esp32' || identity.variant !== 'esp32' || identity.coreVersion !== '3.3.6' || !fCpuValues.has(identity.fCpu)) return false;
  return Object.entries(identity.options).every(([key, value]) => !!optionValues[key]?.has(value));
}

const validGpio = snapshot.validGpio;
const outputGpio = validGpio.filter(pin => !snapshot.inputOnlyGpio.includes(pin));
const inputGpio = validGpio;
const analogAliases: Record<string, string> = {};
for (const [channel, pin] of Object.entries(snapshot.adc1)) analogAliases[`adc1.${channel}`] = `gpio.${pin}`;
for (const [channel, pin] of Object.entries(snapshot.adc2)) analogAliases[`adc2.${channel}`] = `gpio.${pin}`;

/** Source-backed ESP32 classic capability graph. GPIO-matrix resources are
 * deliberately represented as selectable routes or dynamic controllers; no
 * board display name participates in this resolver. */
export function resolveEsp32ResourceModel(identity: Esp32ResolvedIdentity) {
  if (!matchesEsp32Identity(identity)) return { status: 'not-applicable' as const, reason: 'unverified-resolved-identity' };
  const psram = identity.options.PSRAM === 'enabled';
  const evidence = snapshot.evidence.map(entry => ({ id: entry.id, source: entry.path, locator: `sha256:${entry.sha256}; ${entry.locator}`, confidence: 'verified' as const }));
  const baseEvidence = ['soc-caps', 'gpio'];
  const graphBuilder = createResourceGraphBuilder(baseEvidence);
  const { resources, add, fixedRoute, selectableRoute } = graphBuilder;

  const analogTokenByPin = new Map<number, string[]>();
  const addAnalogToken = (channel: string, pin: number) => {
    const list = analogTokenByPin.get(pin) ?? []; list.push(channel); analogTokenByPin.set(pin, list);
  };
  for (const [channel, pin] of Object.entries(snapshot.adc1)) addAnalogToken(`A${Number(channel)}`, pin);
  for (const [channel, pin] of Object.entries(snapshot.adc2)) addAnalogToken(`ADC2_CH${channel}`, pin);
  for (const pin of validGpio) {
    const aliases = [String(pin), `GPIO${pin}`];
    const tokens = analogTokenByPin.get(pin) ?? [];
    aliases.push(...tokens.filter(token => token.startsWith('A')));
    if (pin === 1) aliases.push('TX');
    if (pin === 3) aliases.push('RX');
    if (pin === 21) aliases.push('SDA');
    if (pin === 22) aliases.push('SCL');
    if (pin === 5) aliases.push('SS');
    if (pin === 23) aliases.push('MOSI');
    if (pin === 19) aliases.push('MISO');
    if (pin === 18) aliases.push('SCK');
    const reserved = [6, 7, 8, 9, 10, 11].includes(pin) || (psram && [16, 17].includes(pin));
    const capabilities = pin >= 34 ? ['digital-input', 'input-only'] : ['digital-input', 'digital-output'];
    if ([0, 2, 5, 12, 15].includes(pin)) capabilities.push('strapping');
    if ([6, 7, 8, 9, 10, 11].includes(pin)) capabilities.push('flash-reserved');
    if (psram && [16, 17].includes(pin)) capabilities.push('psram-reserved');
    const gpio: HardwareResource = { id: `gpio.${pin}`, type: 'gpio', sharing: 'exclusive', aliases, capabilities, reserved, evidence: [...baseEvidence, 'variant'] };
    resources.push(gpio);
  }

  const adc: Record<string, string> = {};
  add('adc', 'adc-controller', 'shared', { capabilities: ['adc1', 'adc2', 'adc2-wifi-shared'], evidence: ['soc-caps', 'adc', 'adc-runtime'] });
  for (const [unit, channels] of Object.entries({ adc1: snapshot.adc1, adc2: snapshot.adc2 })) {
    for (const [channel, pin] of Object.entries(channels)) {
      const id = `${unit}.channel${channel}`;
      add(id, 'adc-channel', 'shared', { parent: 'adc', capabilities: [unit, ...(unit === 'adc2' ? ['wifi-arbitrated'] : [])], evidence: ['soc-caps', 'adc', ...(unit === 'adc2' ? ['adc-runtime'] : [])] });
      fixedRoute(id, 'input', pin);
      adc[String(pin)] = id; adc[`${unit}.${channel}`] = id;
      if (unit === 'adc1') adc[`A${channel}`] = id;
    }
  }

  const dac: Record<string, string> = {};
  add('dac', 'dac-controller', 'shared', { capabilities: ['8-bit', '2-channels'], evidence: ['soc-caps', 'dac'] });
  for (const [channel, pin] of Object.entries(snapshot.dac)) {
    const id = `dac.channel${channel}`; add(id, 'dac-channel', 'exclusive', { parent: 'dac', aliases: [`DAC${Number(channel) + 1}`], evidence: ['soc-caps', 'dac'] });
    fixedRoute(id, 'output', pin); dac[String(pin)] = id;
  }

  const serial: Record<string, string> = {};
  const addUart = (id: string, port: string, rx: number, tx: number, cts: number, rts: number, aliases: string[]) => {
    add(id, 'uart-controller', 'configuration', { aliases: [port, ...aliases], configurationKeys: ['baud'], capabilities: ['gpio-matrix', `default-route.rx.gpio.${rx}`, `default-route.tx.gpio.${tx}`, `default-route.cts.gpio.${cts}`, `default-route.rts.gpio.${rts}`], evidence: ['soc-caps', 'uart', 'uart-core'] });
    serial[port] = id;
    // HardwareSerial::begin and uartSetPins route every UART signal through
    // the GPIO matrix. Defaults are metadata, never physical fixed routes.
    selectableRoute(id, 'rx', inputGpio); selectableRoute(id, 'tx', outputGpio);
    // CTS/RTS are optional flow-control signals. Keep them as child signal
    // resources so a normal UART claim does not reserve unused flow-control
    // pins, while a future flow-control claim can bind the selectable route.
    add(`${id}.cts`, 'uart-flow-control', 'exclusive', { parent: id, aliases: [`${port}.CTS`], capabilities: ['gpio-matrix', `default-route.cts.gpio.${cts}`], evidence: ['soc-caps', 'uart', 'uart-hal'] });
    add(`${id}.rts`, 'uart-flow-control', 'exclusive', { parent: id, aliases: [`${port}.RTS`], capabilities: ['gpio-matrix', `default-route.rts.gpio.${rts}`], evidence: ['soc-caps', 'uart', 'uart-hal'] });
    selectableRoute(`${id}.cts`, 'cts', inputGpio); selectableRoute(`${id}.rts`, 'rts', outputGpio);
  };
  addUart('uart0', 'Serial', 3, 1, 19, 22, ['UART0']); addUart('uart1', 'Serial1', 9, 10, 6, 11, ['UART1']); addUart('uart2', 'Serial2', 16, 17, 8, 7, ['UART2']);

  add('spi2', 'spi-controller', 'selector', { aliases: ['HSPI', 'SPI2'], capabilities: ['gpio-matrix', 'default-route.sck.gpio.14', 'default-route.miso.gpio.12', 'default-route.mosi.gpio.13', 'default-route.cs.gpio.15'], evidence: ['soc-caps', 'spi', 'spi-core'] });
  selectableRoute('spi2', 'sck', outputGpio); selectableRoute('spi2', 'miso', inputGpio); selectableRoute('spi2', 'mosi', outputGpio); selectableRoute('spi2', 'cs', outputGpio);
  add('spi3', 'spi-controller', 'selector', { aliases: ['VSPI', 'SPI3', 'SPI', 'spi'], capabilities: ['gpio-matrix', 'default-route.sck.gpio.18', 'default-route.miso.gpio.19', 'default-route.mosi.gpio.23', 'default-route.cs.gpio.5'], evidence: ['soc-caps', 'spi', 'spi-core'] });
  selectableRoute('spi3', 'sck', outputGpio); selectableRoute('spi3', 'miso', inputGpio); selectableRoute('spi3', 'mosi', outputGpio); selectableRoute('spi3', 'cs', outputGpio);

  add('i2c0', 'i2c-controller', 'address', { aliases: ['Wire', 'I2C0', 'i2c'], capabilities: ['gpio-matrix', 'default-route.sda.gpio.21', 'default-route.scl.gpio.22'], evidence: ['soc-caps', 'wire'] });
  selectableRoute('i2c0', 'sda', outputGpio); selectableRoute('i2c0', 'scl', outputGpio);
  add('i2c1', 'i2c-controller', 'address', { aliases: ['Wire1', 'I2C1'], capabilities: ['gpio-matrix', 'explicit-pins-required'], evidence: ['soc-caps', 'wire'] });
  selectableRoute('i2c1', 'sda', outputGpio); selectableRoute('i2c1', 'scl', outputGpio);

  add('ledc', 'ledc-controller', 'shared', { capabilities: ['dynamic-channel-allocation', '2-speed-groups', '16-channels-total', '8-channels-per-group', '20-bit'], evidence: ['soc-caps', 'ledc'] });
  for (let group = 0; group < 2; group++) {
    add(`ledc.group${group}`, 'ledc-speed-group', 'shared', { parent: 'ledc', capabilities: [`group-index:${group}`, '8-channels', '4-timers'], evidence: ['soc-caps', 'ledc'] });
    for (let timer = 0; timer < 4; timer++) add(`ledc.timer${group * 4 + timer}`, 'ledc-timer', 'exclusive', { parent: `ledc.group${group}`, capabilities: [`group-index:${group}`, `timer-index:${timer}`], evidence: ['soc-caps', 'ledc'] });
    for (let channel = 0; channel < 8; channel++) {
      const globalChannel = group * 8 + channel;
      add(`ledc.channel${globalChannel}`, 'ledc-channel', 'exclusive', { parent: `ledc.group${group}`, aliases: [`LEDC_CH${globalChannel}`], capabilities: [`group-index:${group}`, `channel-index:${channel}`, 'shares-frequency-and-resolution-with-timer'], evidence: ['soc-caps', 'ledc'] });
    }
  }
  add('timer', 'timer-controller', 'shared', { capabilities: ['4-hardware-timers'], evidence: ['soc-caps', 'timer'] });
  for (let group = 0; group < 2; group++) for (let timer = 0; timer < 2; timer++) add(`timer.group${group}.timer${timer}`, 'hardware-timer', 'exclusive', { parent: 'timer', evidence: ['soc-caps', 'timer'] });
  add('rmt', 'rmt-controller', 'shared', { capabilities: ['8-channels', 'tx-rx'], evidence: ['soc-caps', 'rmt'] });
  for (let channel = 0; channel < 8; channel++) add(`rmt.channel${channel}`, 'rmt-channel', 'exclusive', { parent: 'rmt', evidence: ['soc-caps', 'rmt'] });
  add('mcpwm', 'mcpwm-controller', 'shared', { capabilities: ['2-groups', '3-timers-per-group'], evidence: ['soc-caps'] });
  for (let group = 0; group < 2; group++) for (let timer = 0; timer < 3; timer++) add(`mcpwm.group${group}.timer${timer}`, 'mcpwm-timer', 'exclusive', { parent: 'mcpwm', evidence: ['soc-caps'] });
  add('twai0', 'twai-controller', 'shared', { capabilities: ['gpio-matrix'], evidence: ['soc-caps'] });
  selectableRoute('twai0', 'tx', outputGpio); selectableRoute('twai0', 'rx', inputGpio);

  const graph: BoardResourceGraph = graphBuilder.build(evidence, 'full');
  const pwm: Record<string, string> = Object.fromEntries(outputGpio.map(pin => [String(pin), 'ledc']));
  return {
    status: 'ready' as const, identity: { ...identity, options: { ...identity.options } }, resource_graph: graph,
    pwm, adc, dac, serial, ledc: { groups: 2, channelsPerGroup: 8, totalChannels: 16, timersPerGroup: 4, maxResolution: 20, allocation: 'dynamic' as const },
    coreDependencies: { flash: { resources: ['gpio.6', 'gpio.7', 'gpio.8', 'gpio.9', 'gpio.10', 'gpio.11'] }, psram: psram ? { resources: ['gpio.16', 'gpio.17'] } : undefined },
    boardExposure: { validGpio: [...validGpio], inputOnlyGpio: [...snapshot.inputOnlyGpio], defaultI2c: { sda: 21, scl: 22 }, defaultSpi: { sck: 18, miso: 19, mosi: 23, cs: 5 }, defaultUart: { rx: 3, tx: 1 } },
    // Arduino HardwareSerial defaults are model facts, not analyzer logic.
    // Keep them alongside the selected graph so a different ESP32 variant can
    // expose a different Serial/USB mapping without copying this adapter.
    serialDefaults: {
      Serial: { resource: 'uart0', rx: 'gpio.3', tx: 'gpio.1', transport: 'uart' as const },
      Serial1: { resource: 'uart1', rx: 'gpio.9', tx: 'gpio.10', transport: 'uart' as const },
      Serial2: { resource: 'uart2', rx: 'gpio.16', tx: 'gpio.17', transport: 'uart' as const },
    },
    metadata: {
      defaultSerial: 'uart0',
      serialDefaults: {
        Serial: { resource: 'uart0', rx: 'gpio.3', tx: 'gpio.1', transport: 'uart' as const },
        Serial1: { resource: 'uart1', rx: 'gpio.9', tx: 'gpio.10', transport: 'uart' as const },
        Serial2: { resource: 'uart2', rx: 'gpio.16', tx: 'gpio.17', transport: 'uart' as const },
      },
    },
  };
}

export { analogAliases };
