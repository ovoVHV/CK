import snapshot from '../config/esp32-resource-evidence/esp32-c6-3.3.6.json';
import type { BoardResourceGraph } from './hardware_resource_graph';
import { createResourceGraphBuilder } from './resource_graph_builder';

import type { Esp32ResolvedIdentity } from './esp32_resource_model';
export type { Esp32ResolvedIdentity } from './esp32_resource_model';

const baseFqbn = 'esp32:esp32:esp32c6';
const fCpuValues = new Set(['160000000L', '120000000L', '80000000L', '40000000L', '20000000L', '10000000L']);
const cpuFreqToFcpu: Record<string, string> = {
  '160': '160000000L', '120': '120000000L', '80': '80000000L',
  '40': '40000000L', '20': '20000000L', '10': '10000000L',
};
const optionValues: Record<string, Set<string>> = {
  JTAGAdapter: new Set(['default', 'builtin', 'external', 'bridge']),
  CDCOnBoot: new Set(['default', 'cdc']),
  PartitionScheme: new Set([
    'default', 'defaultffat', 'default_8MB', 'minimal', 'no_fs', 'no_ota',
    'noota_3g', 'noota_ffat', 'noota_3gffat', 'huge_app', 'min_spiffs',
    'fatflash', 'app3M_fat9M_16MB', 'rainmaker', 'rainmaker_4MB',
    'rainmaker_8MB', 'zigbee_2MB', 'zigbee', 'zigbee_8MB', 'zigbee_zczr_2MB',
    'zigbee_zczr', 'zigbee_zczr_8MB', 'custom',
  ]),
  CPUFreq: new Set(['160', '120', '80', '40', '20', '10']),
  FlashMode: new Set(['qio', 'dio']),
  FlashFreq: new Set(['80', '40']),
  FlashSize: new Set(['4M', '8M', '2M', '16M']),
  UploadSpeed: new Set(['921600', '115200', '256000', '230400', '460800', '512000']),
  DebugLevel: new Set(['none', 'error', 'warn', 'info', 'debug', 'verbose']),
  EraseFlash: new Set(['none', 'all']),
  ZigbeeMode: new Set(['default', 'ed', 'zczr', 'ed_debug', 'zczr_debug']),
};

export function matchesEsp32C6Identity(identity: Esp32ResolvedIdentity): boolean {
  if (identity.fqbn.split(':').slice(0, 3).join(':') !== baseFqbn
    || identity.mcu !== 'esp32c6'
    || identity.variant !== 'esp32c6'
    || identity.coreVersion !== '3.3.6'
    || !fCpuValues.has(identity.fCpu)) return false;
  if (identity.options.CPUFreq && cpuFreqToFcpu[identity.options.CPUFreq] !== identity.fCpu) return false;
  return Object.entries(identity.options).every(([key, value]) => !!optionValues[key]?.has(value));
}

const validGpio = [...snapshot.validGpio];
const inputGpio = validGpio;
// JSON imports infer an empty inputOnlyGpio array as `never[]`; keep the
// evidence-driven value while widening only for the capability calculation.
const inputOnlyGpio = snapshot.inputOnlyGpio as readonly number[];
const outputGpio = validGpio.filter(pin => !inputOnlyGpio.includes(pin));
const flashReserved = new Set(snapshot.boardExposure.flashReservedPins);
const strapPins = new Set(snapshot.boardExposure.boardWarningPins.strapping);
const evidence = snapshot.evidence.map(entry => ({
  id: entry.id,
  source: entry.path,
  locator: `${entry.sha256 ? `sha256:${entry.sha256}` : 'official-source'}; ${entry.locator}`,
  confidence: entry.confidence as 'verified' | 'declared' | 'unknown',
}));
const option = (identity: Esp32ResolvedIdentity, key: string, fallback: string) => identity.options[key] || fallback;

/**
 * Exact ESP32-C6 model provider.  It is selected only from production-resolved
 * identity; claims, binding and conflict analysis remain family-generic.
 */
export function resolveEsp32C6ResourceModel(identity: Esp32ResolvedIdentity) {
  if (!matchesEsp32C6Identity(identity)) return { status: 'not-applicable' as const, reason: 'unverified-resolved-identity' };

  const cdcOnBoot = option(identity, 'CDCOnBoot', 'default') === 'cdc';
  const jtagBuiltin = option(identity, 'JTAGAdapter', 'default') === 'builtin';
  const zigbeeMode = option(identity, 'ZigbeeMode', 'default');
  const ieee802154Active = zigbeeMode !== 'default';
  const usbActive = cdcOnBoot || jtagBuiltin;
  const graphBuilder = createResourceGraphBuilder(['c6-soc-caps']);
  const { resources, add, fixedRoute, selectableRoute } = graphBuilder;

  const analogByPin = new Map<number, string[]>();
  for (const [channel, pin] of Object.entries(snapshot.adc1)) {
    analogByPin.set(Number(pin), [...(analogByPin.get(Number(pin)) || []), `A${channel}`]);
  }

  for (const pin of validGpio) {
    const aliases = [String(pin), `GPIO${pin}`];
    aliases.push(...(analogByPin.get(pin) || []));
    if (pin === 8) aliases.push('LED_BUILTIN', 'RGB_BUILTIN');
    if (pin === 16) aliases.push('TX');
    if (pin === 17) aliases.push('RX');
    if (pin === 23) aliases.push('SDA');
    if (pin === 22) aliases.push('SCL');
    if (pin === 6) aliases.push('SDA1');
    if (pin === 7) aliases.push('SCL1');
    if (pin === 18) aliases.push('SS');
    if (pin === 19) aliases.push('MOSI');
    if (pin === 20) aliases.push('MISO');
    if (pin === 21) aliases.push('SCK');

    const capabilities = ['digital-input', 'digital-output', 'gpio-matrix'];
    if (pin <= 7) capabilities.push('rtc-lp-io', 'deep-sleep-wake-capable');
    if (pin >= 8) capabilities.push('digital-pad');
    if (strapPins.has(pin)) capabilities.push('strapping');
    if (pin === 8) capabilities.push('onboard-led', 'rgb-led');
    if (flashReserved.has(pin)) capabilities.push('flash-reserved', 'system-owned-by-mspi');
    if ([12, 13].includes(pin)) {
      capabilities.push('usb-serial-jtag-pad');
      if (cdcOnBoot) capabilities.push('system-owned-when-usb-active');
      if (jtagBuiltin) capabilities.push('potential-system-owned-when-jtag-active');
    }
    if ([2, 3, 4, 5].includes(pin)) capabilities.push('lp-uart-fixed-pad');
    resources.push({
      id: `gpio.${pin}`,
      type: 'gpio',
      sharing: 'exclusive',
      aliases,
      capabilities,
      reserved: flashReserved.has(pin),
      evidence: ['c6-soc-caps', 'c6-gpio', 'c6-variant', ...(strapPins.has(pin) ? ['c6-official-gpio'] : []), ...(flashReserved.has(pin) ? ['c6-spi-pins'] : []), ...([12, 13].includes(pin) ? ['c6-usb-pads', 'c6-usb-core'] : [])],
    });
  }

  const adc: Record<string, string> = {};
  add('adc', 'adc-controller', 'shared', { capabilities: ['adc1', '12-bit', 'single-adc-unit'], evidence: ['c6-soc-caps', 'c6-adc'] });
  for (const [channel, pin] of Object.entries(snapshot.adc1)) {
    const id = `adc1.channel${channel}`;
    add(id, 'adc-channel', 'shared', { parent: 'adc', capabilities: ['adc1'], evidence: ['c6-soc-caps', 'c6-adc'] });
    fixedRoute(id, 'input', pin);
    adc[String(pin)] = id;
    adc[`adc1.${channel}`] = id;
    adc[`A${channel}`] = id;
  }

  const serial: Record<string, string> = {};
  const addHpUart = (id: string, port: string, rx: number, tx: number) => {
    add(id, 'uart-controller', 'configuration', {
      aliases: [port, `UART${id.slice(-1)}`],
      configurationKeys: ['baud'],
      capabilities: ['high-performance', 'gpio-matrix', 'cts-rts-selectable', `default-route.rx.gpio.${rx}`, `default-route.tx.gpio.${tx}`],
      evidence: ['c6-soc-caps', 'c6-uart-pins', 'c6-uart-core', 'c6-uart-hal'],
    });
    serial[port] = id;
    selectableRoute(id, 'rx', inputGpio);
    selectableRoute(id, 'tx', outputGpio);
    add(`${id}.cts`, 'uart-flow-control', 'exclusive', { parent: id, aliases: [`${port}.CTS`], capabilities: ['gpio-matrix'], evidence: ['c6-soc-caps', 'c6-uart-pins', 'c6-uart-hal'] });
    add(`${id}.rts`, 'uart-flow-control', 'exclusive', { parent: id, aliases: [`${port}.RTS`], capabilities: ['gpio-matrix'], evidence: ['c6-soc-caps', 'c6-uart-pins', 'c6-uart-hal'] });
    selectableRoute(`${id}.cts`, 'cts', inputGpio);
    selectableRoute(`${id}.rts`, 'rts', outputGpio);
  };
  const addLpUart = () => {
    add('uart2', 'uart-controller', 'configuration', {
      aliases: ['Serial2', 'UART2', 'LP_UART0'],
      configurationKeys: ['baud'],
      capabilities: ['low-power', 'fixed-route', 'fixed-rx-tx', 'fixed-cts-rts', 'default-route.rx.gpio.4', 'default-route.tx.gpio.5'],
      evidence: ['c6-soc-caps', 'c6-uart-pins', 'c6-uart-core', 'c6-uart-hal'],
    });
    serial.Serial2 = 'uart2';
    fixedRoute('uart2', 'rx', 4);
    fixedRoute('uart2', 'tx', 5);
    fixedRoute('uart2', 'cts', 3);
    fixedRoute('uart2', 'rts', 2);
  };
  addHpUart('uart0', 'Serial0', 17, 16);
  addHpUart('uart1', 'Serial1', 4, 5);
  addLpUart();

  add('usb-serial-jtag', 'usb-serial-jtag-controller', 'exclusive', {
    aliases: ['USBSerial', 'USB-JTAG'],
    capabilities: ['hardware-cdc', 'jtag', 'fixed-pads', 'upload-debug', ...(cdcOnBoot ? ['system-owned-when-active', 'cdc-on-boot'] : []), ...(jtagBuiltin ? ['jtag-debug-path-selected'] : [])],
    reserved: false,
    evidence: ['c6-soc-caps', 'c6-usb-pads', 'c6-usb-core', 'c6-usb-register'],
  });
  fixedRoute('usb-serial-jtag', 'dm', 12);
  fixedRoute('usb-serial-jtag', 'dp', 13);
  serial.Serial = cdcOnBoot ? 'usb-serial-jtag' : 'uart0';

  add('mspi.flash', 'spi-system-controller', 'exclusive', {
    aliases: ['MSPI', 'SPI0', 'SPI1'],
    capabilities: ['system-flash', 'reserved-by-core', 'flash-bus', 'vdd-spi-pad'],
    reserved: true,
    evidence: ['c6-soc-caps', 'c6-spi-pins'],
  });
  fixedRoute('mspi.flash', 'cs0', 24);
  fixedRoute('mspi.flash', 'miso', 25);
  fixedRoute('mspi.flash', 'wp', 26);
  fixedRoute('mspi.flash', 'vdd-spi', 27);
  fixedRoute('mspi.flash', 'hd', 28);
  fixedRoute('mspi.flash', 'clk', 29);
  fixedRoute('mspi.flash', 'mosi', 30);

  add('spi2', 'spi-controller', 'selector', {
    aliases: ['FSPI', 'SPI2', 'SPI', 'spi'],
    capabilities: ['gpio-matrix', 'default-route.sck.gpio.21', 'default-route.miso.gpio.20', 'default-route.mosi.gpio.19', 'default-route.cs.gpio.18'],
    evidence: ['c6-soc-caps', 'c6-spi-pins', 'c6-spi-core', 'c6-variant'],
  });
  selectableRoute('spi2', 'sck', outputGpio);
  selectableRoute('spi2', 'miso', inputGpio);
  selectableRoute('spi2', 'mosi', outputGpio);
  selectableRoute('spi2', 'cs', outputGpio);

  add('i2c0', 'i2c-controller', 'address', { aliases: ['Wire', 'I2C0', 'i2c'], capabilities: ['high-performance', 'gpio-matrix', 'default-route.sda.gpio.23', 'default-route.scl.gpio.22'], evidence: ['c6-soc-caps', 'c6-wire', 'c6-variant'] });
  selectableRoute('i2c0', 'sda', outputGpio);
  selectableRoute('i2c0', 'scl', outputGpio);
  add('i2c1', 'i2c-controller', 'address', { aliases: ['Wire1', 'I2C1', 'LP_I2C'], capabilities: ['low-power', 'fixed-route', 'default-route.sda.gpio.6', 'default-route.scl.gpio.7'], evidence: ['c6-soc-caps', 'c6-wire', 'c6-variant'] });
  fixedRoute('i2c1', 'sda', 6);
  fixedRoute('i2c1', 'scl', 7);

  add('ledc', 'ledc-controller', 'shared', { capabilities: ['dynamic-channel-allocation', '1-speed-group', '6-channels-total', '4-timers', '20-bit', 'timer-sharing-by-frequency-resolution'], evidence: ['c6-soc-caps', 'c6-ledc'] });
  add('ledc.group0', 'ledc-speed-group', 'shared', { parent: 'ledc', capabilities: ['group-index:0', '6-channels', '4-timers'], evidence: ['c6-soc-caps', 'c6-ledc'] });
  for (let timer = 0; timer < 4; timer++) add(`ledc.timer${timer}`, 'ledc-timer', 'exclusive', { parent: 'ledc.group0', capabilities: [`timer-index:${timer}`], evidence: ['c6-soc-caps', 'c6-ledc'] });
  for (let channel = 0; channel < 6; channel++) add(`ledc.channel${channel}`, 'ledc-channel', 'exclusive', { parent: 'ledc.group0', aliases: [`LEDC_CH${channel}`], capabilities: [`channel-index:${channel}`, 'shares-frequency-and-resolution-with-timer'], evidence: ['c6-soc-caps', 'c6-ledc'] });

  add('rmt', 'rmt-controller', 'shared', { capabilities: ['1-group', '4-channels', '2-tx-candidates', '2-rx-candidates', 'dynamic-allocation'], evidence: ['c6-soc-caps', 'c6-rmt'] });
  for (let channel = 0; channel < 4; channel++) add(`rmt.channel${channel}`, 'rmt-channel', 'exclusive', { parent: 'rmt', capabilities: ['dynamic-channel', 'direction-selected-at-allocation'], evidence: ['c6-soc-caps', 'c6-rmt'] });

  add('mcpwm', 'mcpwm-controller', 'shared', { capabilities: ['1-group', '3-timers-per-group', '3-operators-per-group'], evidence: ['c6-soc-caps'] });
  add('mcpwm.group0', 'mcpwm-group', 'shared', { parent: 'mcpwm', capabilities: ['group-index:0', '3-timers', '3-operators'], evidence: ['c6-soc-caps'] });
  for (let timer = 0; timer < 3; timer++) add(`mcpwm.group0.timer${timer}`, 'mcpwm-timer', 'exclusive', { parent: 'mcpwm.group0', capabilities: [`timer-index:${timer}`], evidence: ['c6-soc-caps'] });
  for (let operator = 0; operator < 3; operator++) {
    const operatorId = `mcpwm.group0.operator${operator}`;
    add(operatorId, 'mcpwm-operator', 'exclusive', { parent: 'mcpwm.group0', capabilities: [`operator-index:${operator}`, '2-comparators', '2-generators', '2-triggers'], evidence: ['c6-soc-caps'] });
    for (let comparator = 0; comparator < 2; comparator++) add(`${operatorId}.comparator${comparator}`, 'mcpwm-comparator', 'exclusive', { parent: operatorId, capabilities: [`comparator-index:${comparator}`], evidence: ['c6-soc-caps'] });
    for (let generator = 0; generator < 2; generator++) add(`${operatorId}.generator${generator}`, 'mcpwm-generator', 'exclusive', { parent: operatorId, capabilities: [`generator-index:${generator}`, 'gpio-matrix'], evidence: ['c6-soc-caps'] });
    for (let trigger = 0; trigger < 2; trigger++) add(`${operatorId}.trigger${trigger}`, 'mcpwm-trigger', 'exclusive', { parent: operatorId, capabilities: [`trigger-index:${trigger}`], evidence: ['c6-soc-caps'] });
  }
  add('mcpwm.group0.capture-timer0', 'mcpwm-capture-timer', 'exclusive', { parent: 'mcpwm.group0', capabilities: ['capture-timer-index:0', 'shares-group-clock'], evidence: ['c6-soc-caps'] });
  for (let channel = 0; channel < 3; channel++) add(`mcpwm.group0.capture-timer0.channel${channel}`, 'mcpwm-capture-channel', 'exclusive', { parent: 'mcpwm.group0.capture-timer0', capabilities: [`capture-channel-index:${channel}`, 'gpio-matrix'], evidence: ['c6-soc-caps'] });
  for (let fault = 0; fault < 3; fault++) add(`mcpwm.group0.fault${fault}`, 'mcpwm-fault-detector', 'exclusive', { parent: 'mcpwm.group0', capabilities: [`fault-index:${fault}`, 'gpio-matrix'], evidence: ['c6-soc-caps'] });
  for (let sync = 0; sync < 3; sync++) add(`mcpwm.group0.gpio-sync${sync}`, 'mcpwm-gpio-sync', 'exclusive', { parent: 'mcpwm.group0', capabilities: [`sync-index:${sync}`, 'gpio-matrix'], evidence: ['c6-soc-caps'] });

  for (let controller = 0; controller < 2; controller++) {
    const id = `twai${controller}`;
    add(id, 'twai-controller', 'shared', { capabilities: ['gpio-matrix'], evidence: ['c6-soc-caps'] });
    selectableRoute(id, 'tx', outputGpio);
    selectableRoute(id, 'rx', inputGpio);
  }

  add('gptimer', 'hardware-timer-controller', 'shared', { capabilities: ['2-timers', '2-groups', '54-bit-counter'], evidence: ['c6-soc-caps', 'c6-timer'] });
  for (let group = 0; group < 2; group++) add(`gptimer.group${group}.timer0`, 'hardware-timer', 'exclusive', { parent: 'gptimer', aliases: [`TIMER${group}`], capabilities: [`group-index:${group}`, 'timer-index:0'], evidence: ['c6-soc-caps', 'c6-timer'] });
  add('systimer', 'system-timer-controller', 'shared', { capabilities: ['2-counters', '3-alarms', '32-and-20-bit'], evidence: ['c6-soc-caps'] });
  for (let counter = 0; counter < 2; counter++) add(`systimer.counter${counter}`, 'system-timer-counter', 'exclusive', { parent: 'systimer', capabilities: [`counter-index:${counter}`], evidence: ['c6-soc-caps'] });
  for (let alarm = 0; alarm < 3; alarm++) add(`systimer.alarm${alarm}`, 'system-timer-alarm', 'exclusive', { parent: 'systimer', capabilities: [`alarm-index:${alarm}`], evidence: ['c6-soc-caps'] });

  add('ieee802154.radio', 'ieee802154-radio', 'exclusive', {
    aliases: ['802.15.4', 'Zigbee', 'Thread'],
    capabilities: ['ieee802154', 'zigbee', 'thread-radio', ...(ieee802154Active ? [`system-owned-when-${zigbeeMode}`] : []), ...(ieee802154Active ? [`zigbee-mode:${zigbeeMode}`] : [])],
    reserved: ieee802154Active,
    evidence: ['c6-soc-caps', 'c6-boards'],
  });

  const graph: BoardResourceGraph = graphBuilder.build(evidence, 'full');
  const pwm: Record<string, string> = Object.fromEntries(outputGpio.map(pin => [String(pin), 'ledc']));
  const serialDefaults = {
    Serial: cdcOnBoot ? { resource: 'usb-serial-jtag', transport: 'usb-serial-jtag' as const } : { resource: 'uart0', transport: 'uart' as const, rx: 'gpio.17', tx: 'gpio.16' },
    Serial0: { resource: 'uart0', transport: 'uart' as const, rx: 'gpio.17', tx: 'gpio.16' },
    Serial1: { resource: 'uart1', transport: 'uart' as const, rx: 'gpio.4', tx: 'gpio.5' },
    Serial2: { resource: 'uart2', transport: 'uart' as const, rx: 'gpio.4', tx: 'gpio.5' },
  };
  return {
    status: 'ready' as const,
    identity: { ...identity, options: { ...identity.options } },
    resource_graph: graph,
    pwm,
    adc,
    serial,
    serialDefaults,
    metadata: { defaultSerial: cdcOnBoot ? 'usb-serial-jtag' : 'uart0', serialDefaults },
    defaultSerial: cdcOnBoot ? 'usb-serial-jtag' : 'uart0',
    ledc: { groups: 1, channelsPerGroup: 6, totalChannels: 6, timersPerGroup: 4, maxResolution: 20, allocation: 'dynamic' as const },
    coreDependencies: { flash: { resources: [...snapshot.boardExposure.flashReservedPins.map(pin => `gpio.${pin}`)] } },
    boardExposure: {
      validGpio: [...validGpio],
      inputOnlyGpio: [],
      packageExposure: {
        status: 'blocked' as const,
        reason: 'FQBN does not encode QFN32/QFN40 package exposure; require an explicit board fixture',
      },
      defaultI2c: { sda: 23, scl: 22 },
      defaultSpi: { sck: 21, miso: 20, mosi: 19, cs: 18 },
      defaultUart: { rx: 17, tx: 16 },
      usbSerialJtag: { dm: 12, dp: 13, active: usbActive },
      resourceAffectingOptions: { CDCOnBoot: option(identity, 'CDCOnBoot', 'default'), JTAGAdapter: option(identity, 'JTAGAdapter', 'default'), ZigbeeMode: zigbeeMode },
      psram: { supported: false },
    },
  };
}

export { validGpio };
