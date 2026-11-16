import snapshot from '../config/esp32-resource-evidence/esp32-c3-3.3.6.json';
import type { BoardResourceGraph, HardwareResource } from './hardware_resource_graph';
import { createResourceGraphBuilder } from './resource_graph_builder';

export interface Esp32C3ResolvedIdentity {
  fqbn: string;
  options: Record<string, string>;
  mcu: string;
  variant: string;
  coreVersion: string;
  fCpu: string;
}

const baseFqbn = 'esp32:esp32:esp32c3';
const fCpuValues = new Set(['160000000L', '80000000L', '40000000L', '20000000L', '10000000L']);
const cpuFreqToFcpu: Record<string, string> = {
  '160': '160000000L', '80': '80000000L', '40': '40000000L', '20': '20000000L', '10': '10000000L',
};
const optionValues: Record<string, Set<string>> = {
  JTAGAdapter: new Set(['default', 'builtin', 'external', 'bridge']),
  CDCOnBoot: new Set(['default', 'cdc']),
  CPUFreq: new Set(['160', '80', '40', '20', '10']),
  FlashMode: new Set(['qio', 'dio']),
  FlashFreq: new Set(['80', '40']),
  FlashSize: new Set(['2M', '4M', '8M', '16M']),
  UploadSpeed: new Set(['921600', '115200', '256000', '230400', '460800', '512000']),
  PartitionScheme: new Set(['default', 'defaultffat', 'default_8MB', 'minimal', 'no_fs', 'no_ota', 'noota_3g', 'noota_ffat', 'noota_3gffat', 'huge_app', 'min_spiffs', 'fatflash', 'app3M_fat9M_16MB', 'rainmaker', 'rainmaker_4MB', 'rainmaker_8MB', 'zigbee_zczr', 'zigbee_zczr_8MB', 'custom']),
  DebugLevel: new Set(['none', 'error', 'warn', 'info', 'debug', 'verbose']),
  EraseFlash: new Set(['none', 'all']),
  ZigbeeMode: new Set(['default', 'zczr']),
};

export function matchesEsp32C3Identity(identity: Esp32C3ResolvedIdentity): boolean {
  if (identity.fqbn.split(':').slice(0, 3).join(':') !== baseFqbn
    || identity.mcu !== 'esp32c3'
    || identity.variant !== 'esp32c3'
    || identity.coreVersion !== '3.3.6'
    || !fCpuValues.has(identity.fCpu)) return false;
  if (identity.options.CPUFreq && cpuFreqToFcpu[identity.options.CPUFreq] !== identity.fCpu) return false;
  return Object.entries(identity.options).every(([key, value]) => !!optionValues[key]?.has(value));
}

const validGpio = [...snapshot.validGpio];
const inputGpio = validGpio;
const outputGpio = validGpio;
const flashReserved = new Set(snapshot.boardExposure.flashReservedPins);
const evidence = snapshot.evidence.map(entry => ({
  id: entry.id,
  source: entry.path,
  locator: `${entry.sha256 ? `sha256:${entry.sha256}` : entry.confidence === 'verified' ? 'official-source' : 'declared-source'}; ${entry.locator}`,
  confidence: entry.confidence as 'verified' | 'declared' | 'unknown',
}));

const option = (identity: Esp32C3ResolvedIdentity, key: string, fallback: string) => identity.options[key] || fallback;

/**
 * Exact C3 model selected from the production-resolved identity.  This module
 * is a model provider only; the first-party analyzer remains family-generic.
 */
export function resolveEsp32C3ResourceModel(identity: Esp32C3ResolvedIdentity) {
  if (!matchesEsp32C3Identity(identity)) return { status: 'not-applicable' as const, reason: 'unverified-resolved-identity' };
  const cdcOnBoot = option(identity, 'CDCOnBoot', 'default') === 'cdc';
  const jtagBuiltin = option(identity, 'JTAGAdapter', 'default') === 'builtin';
  const usbActive = cdcOnBoot || jtagBuiltin;
  const graphBuilder = createResourceGraphBuilder(['soc-caps']);
  const { resources, add, fixedRoute, selectableRoute } = graphBuilder;

  const analogByPin = new Map<number, string[]>();
  for (const [channel, pin] of Object.entries(snapshot.adc1)) analogByPin.set(Number(pin), [...(analogByPin.get(Number(pin)) || []), `A${channel}`]);
  for (const [channel, pin] of Object.entries(snapshot.adc2)) analogByPin.set(Number(pin), [...(analogByPin.get(Number(pin)) || []), `ADC2_CH${channel}`]);

  for (const pin of validGpio) {
    const aliases = [String(pin), `GPIO${pin}`];
    if (pin === 8) aliases.push('SDA');
    if (pin === 9) aliases.push('SCL');
    if (pin === 7) aliases.push('SS');
    if (pin === 6) aliases.push('MOSI');
    if (pin === 5) aliases.push('MISO');
    if (pin === 4) aliases.push('SCK');
    if (pin === 20) aliases.push('RX');
    if (pin === 21) aliases.push('TX');
    for (const token of analogByPin.get(pin) || []) aliases.push(token);
    if (pin === 8) aliases.push('LED_BUILTIN', 'RGB_BUILTIN');
    const capabilities = ['digital-input', 'digital-output'];
    if (snapshot.boardExposure.boardWarningPins.strapping.includes(pin)) capabilities.push('strapping');
    if (pin === 8) capabilities.push('onboard-led', 'rgb-led');
    if (flashReserved.has(pin)) capabilities.push('flash-reserved');
    if ([18, 19].includes(pin)) {
      capabilities.push('usb-serial-jtag-pad');
      if (cdcOnBoot) capabilities.push('system-owned-when-usb-active');
      if (jtagBuiltin) capabilities.push('potential-system-owned-when-jtag-active');
    }
    // USB Serial/JTAG claims its fixed pads through the graph route. Keep the
    // pads themselves non-reserved so the controller's own route does not
    // self-report a reserved-resource conflict; a competing UART claim still
    // conflicts on the exclusive GPIO resource when both are present.
    const reserved = flashReserved.has(pin);
    resources.push({ id: `gpio.${pin}`, type: 'gpio', sharing: 'exclusive', aliases, capabilities, reserved, evidence: ['soc-caps', 'gpio', 'variant', ...(snapshot.boardExposure.boardWarningPins.strapping.includes(pin) ? ['official-gpio-doc'] : []), ...(flashReserved.has(pin) ? ['spi'] : []), ...([18, 19].includes(pin) ? ['usb-pads', 'usb-core'] : [])] });
  }

  const adc: Record<string, string> = {};
  add('adc', 'adc-controller', 'shared', { capabilities: ['adc1', 'adc2', '12-bit', 'soc-adc-arbiter-present', 'no-classic-wifi-priority'], evidence: ['soc-caps', 'adc'] });
  for (const [unit, channels] of Object.entries({ adc1: snapshot.adc1, adc2: snapshot.adc2 })) {
    for (const [channel, pin] of Object.entries(channels)) {
      const id = `${unit}.channel${channel}`;
      add(id, 'adc-channel', 'shared', { parent: 'adc', capabilities: [unit], evidence: ['soc-caps', 'adc'] });
      fixedRoute(id, 'input', pin);
      adc[String(pin)] = id;
      adc[`${unit}.${channel}`] = id;
      const variantAnalogAlias = Object.entries(snapshot.boardExposure.aliases)
        .find(([alias, aliasPin]) => /^A\d+$/.test(alias) && Number(aliasPin) === Number(pin))?.[0];
      if (variantAnalogAlias) adc[variantAnalogAlias] = id;
    }
  }

  const serial: Record<string, string> = {};
  const addUart = (id: string, port: string, rx: number, tx: number, aliases: string[]) => {
    add(id, 'uart-controller', 'configuration', { aliases: [port, ...aliases], configurationKeys: ['baud'], capabilities: ['gpio-matrix', `default-route.rx.gpio.${rx}`, `default-route.tx.gpio.${tx}`, 'cts-rts-selectable'], evidence: ['soc-caps', 'uart', 'uart-core', 'uart-hal'] });
    serial[port] = id;
    selectableRoute(id, 'rx', inputGpio);
    selectableRoute(id, 'tx', outputGpio);
    add(`${id}.cts`, 'uart-flow-control', 'exclusive', { parent: id, aliases: [`${port}.CTS`], capabilities: ['gpio-matrix'], evidence: ['soc-caps', 'uart', 'uart-hal'] });
    add(`${id}.rts`, 'uart-flow-control', 'exclusive', { parent: id, aliases: [`${port}.RTS`], capabilities: ['gpio-matrix'], evidence: ['soc-caps', 'uart', 'uart-hal'] });
    selectableRoute(`${id}.cts`, 'cts', inputGpio);
    selectableRoute(`${id}.rts`, 'rts', outputGpio);
  };
  addUart('uart0', 'Serial0', 20, 21, ['UART0']);
  addUart('uart1', 'Serial1', 18, 19, ['UART1']);

  add('usb-serial-jtag', 'usb-serial-jtag-controller', 'exclusive', { aliases: ['Serial', 'USBSerial', 'USB-JTAG'], capabilities: ['hardware-cdc', 'jtag', 'fixed-pads', 'upload-debug', ...(cdcOnBoot ? ['system-owned-when-active'] : []), ...(jtagBuiltin ? ['jtag-debug-path-selected'] : []), ...(cdcOnBoot ? ['cdc-on-boot'] : []), ...(jtagBuiltin ? ['integrated-jtag'] : [])], reserved: false, evidence: ['soc-caps', 'platform', 'usb-pads', 'usb-core', 'usb-register'] });
  fixedRoute('usb-serial-jtag', 'dm', 18);
  fixedRoute('usb-serial-jtag', 'dp', 19);

  add('mspi.flash', 'spi-system-controller', 'exclusive', { aliases: ['MSPI', 'SPI0', 'SPI1'], capabilities: ['system-flash', 'reserved-by-core'], reserved: true, evidence: ['soc-caps', 'spi'] });
  add('spi2', 'spi-controller', 'selector', { aliases: ['FSPI', 'SPI2', 'SPI', 'spi'], capabilities: ['gpio-matrix', 'default-route.sck.gpio.4', 'default-route.miso.gpio.5', 'default-route.mosi.gpio.6', 'default-route.cs.gpio.7'], evidence: ['soc-caps', 'spi', 'spi-core', 'variant'] });
  selectableRoute('spi2', 'sck', outputGpio); selectableRoute('spi2', 'miso', inputGpio); selectableRoute('spi2', 'mosi', outputGpio); selectableRoute('spi2', 'cs', outputGpio);

  add('i2c0', 'i2c-controller', 'address', { aliases: ['Wire', 'I2C0', 'i2c'], capabilities: ['gpio-matrix', 'default-route.sda.gpio.8', 'default-route.scl.gpio.9'], evidence: ['soc-caps', 'wire', 'variant'] });
  selectableRoute('i2c0', 'sda', outputGpio); selectableRoute('i2c0', 'scl', outputGpio);

  add('ledc', 'ledc-controller', 'shared', { capabilities: ['dynamic-channel-allocation', '1-speed-group', '6-channels-total', '4-timers', '14-bit', 'timer-sharing-by-frequency-resolution'], evidence: ['soc-caps', 'ledc'] });
  add('ledc.group0', 'ledc-speed-group', 'shared', { parent: 'ledc', capabilities: ['group-index:0', '6-channels', '4-timers'], evidence: ['soc-caps', 'ledc'] });
  for (let timer = 0; timer < 4; timer++) add(`ledc.timer${timer}`, 'ledc-timer', 'exclusive', { parent: 'ledc.group0', capabilities: [`timer-index:${timer}`], evidence: ['soc-caps', 'ledc'] });
  for (let channel = 0; channel < 6; channel++) add(`ledc.channel${channel}`, 'ledc-channel', 'exclusive', { parent: 'ledc.group0', aliases: [`LEDC_CH${channel}`], capabilities: [`channel-index:${channel}`, 'shares-frequency-and-resolution-with-timer'], evidence: ['soc-caps', 'ledc'] });

  add('rmt', 'rmt-controller', 'shared', { capabilities: ['1-group', '4-channels', '2-tx-candidates', '2-rx-candidates', 'dynamic-allocation'], evidence: ['soc-caps', 'rmt'] });
  for (let channel = 0; channel < 4; channel++) add(`rmt.channel${channel}`, 'rmt-channel', 'exclusive', { parent: 'rmt', capabilities: ['dynamic-channel'], evidence: ['soc-caps', 'rmt'] });
  add('twai0', 'twai-controller', 'shared', { capabilities: ['gpio-matrix'], evidence: ['soc-caps'] });
  selectableRoute('twai0', 'tx', outputGpio); selectableRoute('twai0', 'rx', inputGpio);
  add('gptimer', 'hardware-timer-controller', 'shared', { capabilities: ['2-timers', '2-groups', '54-bit-counter'], evidence: ['soc-caps', 'timer'] });
  for (let group = 0; group < 2; group++) add(`gptimer.group${group}.timer0`, 'hardware-timer', 'exclusive', { parent: 'gptimer', aliases: [`TIMER${group}`], capabilities: [`group-index:${group}`, 'timer-index:0'], evidence: ['soc-caps', 'timer'] });

  const graph: BoardResourceGraph = graphBuilder.build(evidence, 'full');
  const pwm: Record<string, string> = Object.fromEntries(outputGpio.map(pin => [String(pin), 'ledc']));
  return {
    status: 'ready' as const,
    identity: { ...identity, options: { ...identity.options } },
    resource_graph: graph,
    pwm,
    adc,
    serial,
    serialDefaults: {
      Serial: cdcOnBoot ? { resource: 'usb-serial-jtag', transport: 'usb-serial-jtag' as const } : { resource: 'uart0', transport: 'uart' as const, rx: 'gpio.20', tx: 'gpio.21' },
      Serial0: { resource: 'uart0', transport: 'uart' as const, rx: 'gpio.20', tx: 'gpio.21' },
      Serial1: { resource: 'uart1', transport: 'uart' as const, rx: 'gpio.18', tx: 'gpio.19' },
    },
    defaultSerial: cdcOnBoot ? 'usb-serial-jtag' : 'uart0',
    ledc: { groups: 1, channelsPerGroup: 6, totalChannels: 6, timersPerGroup: 4, maxResolution: 14, allocation: 'dynamic' as const },
    coreDependencies: { flash: { resources: [...snapshot.boardExposure.flashReservedPins.map(pin => `gpio.${pin}`)] } },
    boardExposure: {
      validGpio: [...validGpio], inputOnlyGpio: [],
      defaultI2c: { sda: 8, scl: 9 }, defaultSpi: { sck: 4, miso: 5, mosi: 6, cs: 7 }, defaultUart: { rx: 20, tx: 21 },
      usbSerialJtag: { dm: 18, dp: 19, active: usbActive },
      resourceAffectingOptions: { CDCOnBoot: option(identity, 'CDCOnBoot', 'default'), JTAGAdapter: option(identity, 'JTAGAdapter', 'default') },
    },
  };
}

export { validGpio };
