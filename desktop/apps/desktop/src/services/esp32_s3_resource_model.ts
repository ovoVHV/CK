import snapshot from '../config/esp32-resource-evidence/esp32-s3-3.3.6.json';
import type { BoardResourceGraph } from './hardware_resource_graph';
import { createResourceGraphBuilder } from './resource_graph_builder';
import type { Esp32ResolvedIdentity } from './esp32_resource_model';

export type { Esp32ResolvedIdentity } from './esp32_resource_model';

/**
 * ESP32-S3 is selected only from the compiler-resolved identity.  The model
 * intentionally keeps SoC capability, board exposure and menu-conditional
 * ownership separate; none of those facts are inferred from a display name.
 */
const baseFqbns = new Set(['esp32s3', 'esp32s3-octal']);
const fCpuValues = new Set(['240000000L', '160000000L', '80000000L', '40000000L', '20000000L', '10000000L']);
const cpuFreqToFcpu: Record<string, string> = {
  '240': '240000000L', '160': '160000000L', '80': '80000000L',
  '40': '40000000L', '20': '20000000L', '10': '10000000L',
};
const optionValues: Record<string, Set<string>> = {
  JTAGAdapter: new Set(['default', 'builtin', 'external', 'bridge']),
  PSRAM: new Set(['disabled', 'enabled', 'opi']),
  FlashMode: new Set(['qio', 'qio120', 'dio', 'opi']),
  FlashSize: new Set(['4M', '8M', '16M', '32M']),
  USBMode: new Set(['hwcdc', 'default']),
  CDCOnBoot: new Set(['default', 'cdc']),
  MSCOnBoot: new Set(['default', 'msc']),
  DFUOnBoot: new Set(['default', 'dfu']),
  UploadMode: new Set(['default', 'cdc']),
  CPUFreq: new Set(['240', '160', '80', '40', '20', '10']),
  LoopCore: new Set(['0', '1']),
  EventsCore: new Set(['0', '1']),
  PartitionScheme: new Set([
    'default', 'defaultffat', 'default_8MB', 'minimal', 'no_fs', 'no_ota',
    'noota_3g', 'noota_ffat', 'noota_3gffat', 'huge_app', 'min_spiffs',
    'fatflash', 'app3M_fat9M_16MB', 'rainmaker', 'rainmaker_4MB',
    'rainmaker_8MB', 'app5M_fat24M_32MB', 'app5M_little24M_32MB',
    'app13M_data7M_32MB', 'esp_sr_16', 'zigbee_zczr', 'zigbee_zczr_8MB', 'custom',
  ]),
  UploadSpeed: new Set(['921600', '115200', '256000', '230400', '460800', '512000']),
  DebugLevel: new Set(['none', 'error', 'warn', 'info', 'debug', 'verbose']),
  EraseFlash: new Set(['none', 'all']),
  ZigbeeMode: new Set(['default', 'zczr']),
};

export function matchesEsp32S3Identity(identity: Esp32ResolvedIdentity): boolean {
  const parts = identity.fqbn.split(':');
  const packagePrefix = parts.slice(0, 2).join(':');
  const boardId = parts[2];
  if (packagePrefix !== 'esp32:esp32'
    || !baseFqbns.has(boardId)
    || identity.mcu !== 'esp32s3'
    || identity.variant !== 'esp32s3'
    || identity.coreVersion !== '3.3.6'
    || !fCpuValues.has(identity.fCpu)) return false;
  if (identity.options.CPUFreq && cpuFreqToFcpu[identity.options.CPUFreq] !== identity.fCpu) return false;
  const boardOptions: Record<string, Set<string>> = Object.fromEntries(Object.entries(optionValues).map(([key, values]) => [key, new Set(values)]));
  if (boardId === 'esp32s3-octal') {
    boardOptions.PartitionScheme = new Set(['app3M_fat9M_16MB', 'default', 'defaultffat', 'default_8MB', 'minimal', 'no_ota', 'noota_3g', 'noota_ffat', 'noota_3gffat', 'huge_app', 'min_spiffs', 'fatflash', 'rainmaker', 'rainmaker_4MB', 'rainmaker_8MB']);
    delete boardOptions.ZigbeeMode;
  }
  if (!Object.entries(identity.options).every(([key, value]) => !!boardOptions[key]?.has(value))) return false;
  const suffix = parts.slice(3).join(':');
  if (suffix) {
    for (const token of suffix.split(',')) {
      const separator = token.indexOf('=');
      if (separator <= 0) return false;
      const key = token.slice(0, separator);
      const value = token.slice(separator + 1);
      if (!boardOptions[key]?.has(value)) return false;
      if (identity.options[key] !== undefined && identity.options[key] !== value) return false;
    }
  }
  return true;
}

const validGpio = [...snapshot.validGpio];
const inputGpio = validGpio;
const outputGpio = validGpio;
const flashReserved = new Set(snapshot.boardExposure.flashReservedPins);
const boardNotExposed = new Set(snapshot.boardExposure.boardWarningPins.boardNotExposed);
const strapPins = new Set(snapshot.boardExposure.boardWarningPins.strapping);
const usbPins = new Set(snapshot.boardExposure.boardWarningPins.usbSerialJtag);
const evidence = snapshot.evidence.map(entry => ({
  id: entry.id,
  source: entry.path,
  locator: `${entry.sha256 ? `sha256:${entry.sha256}` : 'official-source'}; ${entry.locator}`,
  confidence: entry.confidence as 'verified' | 'declared' | 'unknown',
}));

const option = (identity: Esp32ResolvedIdentity, key: string, fallback: string) => identity.options[key] || fallback;

function isOctalIdentity(identity: Esp32ResolvedIdentity): boolean {
  return identity.fqbn.split(':')[2] === 'esp32s3-octal';
}

function isOpiMemory(identity: Esp32ResolvedIdentity): boolean {
  const octal = isOctalIdentity(identity);
  return option(identity, 'PSRAM', octal ? 'opi' : 'disabled') === 'opi'
    || option(identity, 'FlashMode', octal ? 'opi' : 'qio') === 'opi';
}

function analogAliases(): Map<number, string[]> {
  const aliases = new Map<number, string[]>();
  for (const [channel, pin] of Object.entries(snapshot.adc1)) {
    const list = aliases.get(Number(pin)) ?? [];
    list.push(`A${channel}`);
    aliases.set(Number(pin), list);
  }
  for (const [channel, pin] of Object.entries(snapshot.adc2)) {
    const list = aliases.get(Number(pin)) ?? [];
    list.push(`ADC2_CH${channel}`);
    aliases.set(Number(pin), list);
  }
  return aliases;
}

/** Build the source-backed S3 graph. Claims and analysis remain generic. */
export function resolveEsp32S3ResourceModel(identity: Esp32ResolvedIdentity) {
  if (!matchesEsp32S3Identity(identity)) return { status: 'not-applicable' as const, reason: 'unverified-resolved-identity' };

  const octal = isOctalIdentity(identity);
  const opi = isOpiMemory(identity);
  const cdcOnBoot = option(identity, 'CDCOnBoot', 'default') === 'cdc';
  const mscOnBoot = option(identity, 'MSCOnBoot', 'default') === 'msc';
  const dfuOnBoot = option(identity, 'DFUOnBoot', 'default') === 'dfu';
  const jtagBuiltin = option(identity, 'JTAGAdapter', 'default') === 'builtin';
  const usbHardwareCdc = option(identity, 'USBMode', 'hwcdc') === 'hwcdc';
  const uploadMode = option(identity, 'UploadMode', 'default');
  const usbSerialActive = usbHardwareCdc && (cdcOnBoot || jtagBuiltin);
  const usbOtgActive = !usbHardwareCdc && (cdcOnBoot || mscOnBoot || dfuOnBoot || uploadMode === 'cdc');
  const opiPins = new Set(snapshot.boardExposure.octalMemoryPins);
  const graphBuilder = createResourceGraphBuilder(['s3-soc-caps']);
  const { resources, add, fixedRoute, selectableRoute } = graphBuilder;
  const analogByPin = analogAliases();

  for (const pin of validGpio) {
    const aliases = [String(pin), `GPIO${pin}`, ...(analogByPin.get(pin) ?? [])];
    for (const [alias, aliasPin] of Object.entries(snapshot.boardExposure.aliases)) {
      if (Number(aliasPin) === pin && !aliases.includes(alias)) aliases.push(alias);
    }
    const capabilities = ['digital-input', 'digital-output', 'gpio-matrix'];
    if (strapPins.has(pin)) capabilities.push('strapping');
    if (pin === 48) capabilities.push('onboard-led', 'rgb-led');
    if (usbPins.has(pin)) capabilities.push('usb-serial-jtag-pad');
    if (usbPins.has(pin) && (usbSerialActive || usbOtgActive)) capabilities.push('system-owned-when-usb-active');
    if (boardNotExposed.has(pin)) capabilities.push('board-not-exposed');
    if (flashReserved.has(pin)) capabilities.push('flash-reserved', 'system-owned-by-mspi');
    if (opiPins.has(pin)) capabilities.push('octal-memory-capable');
    if (opi && opiPins.has(pin)) capabilities.push('system-owned-by-opi');
    // Board-not-exposed and capability-level reservations remain visible in the
    // graph; only resources actually owned by the active memory configuration
    // are reserved and therefore able to produce a conflict.
    const reserved = flashReserved.has(pin) || (opi && opiPins.has(pin));
    resources.push({
      id: `gpio.${pin}`,
      type: 'gpio',
      sharing: 'exclusive',
      aliases,
      capabilities,
      reserved,
      evidence: [
        's3-soc-caps', 's3-gpio', 's3-variant',
        ...(strapPins.has(pin) ? ['s3-official-gpio'] : []),
        ...(flashReserved.has(pin) ? ['s3-spi-pins'] : []),
        ...(usbPins.has(pin) ? ['s3-usb-pins', 's3-usb-core'] : []),
      ],
    });
  }

  const adc: Record<string, string> = {};
  add('adc', 'adc-controller', 'shared', {
    capabilities: ['adc1', 'adc2', '2-units', '20-channels', '12-bit'],
    evidence: ['s3-soc-caps', 's3-adc'],
  });
  for (const [unit, channels] of Object.entries({ adc1: snapshot.adc1, adc2: snapshot.adc2 })) {
    for (const [channel, pin] of Object.entries(channels)) {
      const id = `${unit}.channel${channel}`;
      add(id, 'adc-channel', 'shared', { parent: 'adc', capabilities: [unit, ...(unit === 'adc2' ? ['runtime-arbitrated', 'wifi-rtc-digital-priority'] : [])], evidence: ['s3-soc-caps', 's3-adc'] });
      fixedRoute(id, 'input', pin);
      adc[String(pin)] = id;
      adc[`${unit}.${channel}`] = id;
      if (unit === 'adc1') adc[`A${channel}`] = id;
    }
  }

  const serial: Record<string, string> = {};
  const addUart = (id: string, port: string, rx: number, tx: number, cts?: number, rts?: number) => {
    add(id, 'uart-controller', 'configuration', {
      aliases: [port, `UART${id.slice(-1)}`],
      configurationKeys: ['baud'],
      capabilities: ['high-performance', 'gpio-matrix', `default-route.rx.gpio.${rx}`, `default-route.tx.gpio.${tx}`],
      evidence: ['s3-soc-caps', 's3-uart-pins', 's3-uart-core'],
    });
    serial[port] = id;
    selectableRoute(id, 'rx', inputGpio);
    selectableRoute(id, 'tx', outputGpio);
    if (cts !== undefined && rts !== undefined) {
      add(`${id}.cts`, 'uart-flow-control', 'exclusive', { parent: id, aliases: [`${port}.CTS`], capabilities: ['gpio-matrix', `default-route.cts.gpio.${cts}`], evidence: ['s3-soc-caps', 's3-uart-pins'] });
      add(`${id}.rts`, 'uart-flow-control', 'exclusive', { parent: id, aliases: [`${port}.RTS`], capabilities: ['gpio-matrix', `default-route.rts.gpio.${rts}`], evidence: ['s3-soc-caps', 's3-uart-pins'] });
      selectableRoute(`${id}.cts`, 'cts', inputGpio);
      selectableRoute(`${id}.rts`, 'rts', outputGpio);
    }
  };
  addUart('uart0', 'Serial0', 44, 43, 16, 15);
  addUart('uart1', 'Serial1', 15, 16, 20, 19);
  addUart('uart2', 'Serial2', 19, 20);

  add('usb-serial-jtag', 'usb-serial-jtag-controller', 'exclusive', {
    aliases: ['USBSerial', 'USB-Serial-JTAG'],
    capabilities: ['hardware-cdc', 'jtag', 'fixed-pads', 'upload-debug', ...(usbHardwareCdc ? ['hardware-usb-cdc'] : []), ...(usbSerialActive ? ['system-owned-when-active'] : []), ...(cdcOnBoot && usbHardwareCdc ? ['cdc-on-boot'] : []), ...(jtagBuiltin ? ['jtag-debug-path-selected'] : [])],
    evidence: ['s3-soc-caps', 's3-usb-pins', 's3-usb-core'],
  });
  fixedRoute('usb-serial-jtag', 'dm', 19);
  fixedRoute('usb-serial-jtag', 'dp', 20);
  add('usb-otg', 'usb-otg-controller', 'exclusive', {
    aliases: ['USB-OTG', 'TinyUSB'],
    capabilities: ['usb-otg', 'fixed-internal-phy', 'shared-internal-phy', ...(usbOtgActive ? ['system-owned-when-active'] : []), ...(mscOnBoot ? ['msc-on-boot'] : []), ...(dfuOnBoot ? ['dfu-on-boot'] : [])],
    evidence: ['s3-soc-caps', 's3-usb-pins', 's3-usb-core'],
  });
  fixedRoute('usb-otg', 'dm', 19);
  fixedRoute('usb-otg', 'dp', 20);

  add('mspi.flash', 'spi-system-controller', 'exclusive', {
    aliases: ['MSPI', 'SPI0', 'SPI1'],
    capabilities: ['system-flash', 'reserved-by-core', 'flash-bus'],
    reserved: true,
    evidence: ['s3-soc-caps', 's3-spi-pins'],
  });
  for (const pin of snapshot.boardExposure.flashReservedPins) fixedRoute('mspi.flash', `pin${pin}`, pin);
  if (opi) for (const pin of snapshot.boardExposure.octalMemoryPins) fixedRoute('mspi.flash', `opi${pin}`, pin);

  add('spi2', 'spi-controller', 'selector', {
    aliases: ['SPI2', 'FSPI', 'SPI', 'spi'],
    capabilities: ['gpio-matrix', 'default-route.sck.gpio.12', 'default-route.miso.gpio.13', 'default-route.mosi.gpio.11', 'default-route.cs.gpio.10'],
    evidence: ['s3-soc-caps', 's3-spi-pins', 's3-spi-core', 's3-variant'],
  });
  selectableRoute('spi2', 'sck', outputGpio); selectableRoute('spi2', 'miso', inputGpio); selectableRoute('spi2', 'mosi', outputGpio); selectableRoute('spi2', 'cs', outputGpio);
  add('spi3', 'spi-controller', 'selector', { aliases: ['SPI3', 'VSPI'], capabilities: ['gpio-matrix', 'no-arduino-default-route'], evidence: ['s3-soc-caps', 's3-spi-core'] });
  selectableRoute('spi3', 'sck', outputGpio); selectableRoute('spi3', 'miso', inputGpio); selectableRoute('spi3', 'mosi', outputGpio); selectableRoute('spi3', 'cs', outputGpio);

  add('i2c0', 'i2c-controller', 'address', { aliases: ['Wire', 'I2C0', 'i2c'], capabilities: ['gpio-matrix', 'default-route.sda.gpio.8', 'default-route.scl.gpio.9'], evidence: ['s3-soc-caps', 's3-wire', 's3-variant'] });
  selectableRoute('i2c0', 'sda', outputGpio); selectableRoute('i2c0', 'scl', outputGpio);
  add('i2c1', 'i2c-controller', 'address', { aliases: ['Wire1', 'I2C1'], capabilities: ['gpio-matrix', 'explicit-pins-required', 'no-arduino-default-route'], evidence: ['s3-soc-caps', 's3-wire'] });
  selectableRoute('i2c1', 'sda', outputGpio); selectableRoute('i2c1', 'scl', outputGpio);

  add('ledc', 'ledc-controller', 'shared', { capabilities: ['dynamic-channel-allocation', '1-speed-group', '8-channels-total', '4-timers', '14-bit', 'timer-sharing-by-frequency-resolution'], evidence: ['s3-soc-caps', 's3-ledc'] });
  add('ledc.group0', 'ledc-speed-group', 'shared', { parent: 'ledc', capabilities: ['group-index:0', '8-channels', '4-timers'], evidence: ['s3-soc-caps', 's3-ledc'] });
  for (let timer = 0; timer < 4; timer++) add(`ledc.timer${timer}`, 'ledc-timer', 'exclusive', { parent: 'ledc.group0', capabilities: [`timer-index:${timer}`], evidence: ['s3-soc-caps', 's3-ledc'] });
  for (let channel = 0; channel < 8; channel++) add(`ledc.channel${channel}`, 'ledc-channel', 'exclusive', { parent: 'ledc.group0', aliases: [`LEDC_CH${channel}`], capabilities: [`channel-index:${channel}`, 'shares-frequency-and-resolution-with-timer'], evidence: ['s3-soc-caps', 's3-ledc'] });

  add('rmt', 'rmt-controller', 'shared', { capabilities: ['1-group', '8-channels', '4-tx-candidates', '4-rx-candidates', 'dynamic-allocation'], evidence: ['s3-soc-caps', 's3-rmt'] });
  for (let channel = 0; channel < 8; channel++) add(`rmt.channel${channel}`, 'rmt-channel', 'exclusive', { parent: 'rmt', capabilities: ['dynamic-channel', 'direction-selected-at-allocation'], evidence: ['s3-soc-caps', 's3-rmt'] });

  add('mcpwm', 'mcpwm-controller', 'shared', { capabilities: ['2-groups', '3-timers-per-group', '3-operators-per-group'], evidence: ['s3-soc-caps'] });
  for (let group = 0; group < 2; group++) {
    add(`mcpwm.group${group}`, 'mcpwm-group', 'shared', { parent: 'mcpwm', capabilities: [`group-index:${group}`, '3-timers', '3-operators'], evidence: ['s3-soc-caps'] });
    for (let timer = 0; timer < 3; timer++) add(`mcpwm.group${group}.timer${timer}`, 'mcpwm-timer', 'exclusive', { parent: `mcpwm.group${group}`, capabilities: [`timer-index:${timer}`], evidence: ['s3-soc-caps'] });
    for (let operator = 0; operator < 3; operator++) {
      const operatorId = `mcpwm.group${group}.operator${operator}`;
      add(operatorId, 'mcpwm-operator', 'exclusive', { parent: `mcpwm.group${group}`, capabilities: [`operator-index:${operator}`, '2-comparators', '2-generators', '2-triggers'], evidence: ['s3-soc-caps'] });
      for (let comparator = 0; comparator < 2; comparator++) add(`${operatorId}.comparator${comparator}`, 'mcpwm-comparator', 'exclusive', { parent: operatorId, capabilities: [`comparator-index:${comparator}`], evidence: ['s3-soc-caps'] });
      for (let generator = 0; generator < 2; generator++) add(`${operatorId}.generator${generator}`, 'mcpwm-generator', 'exclusive', { parent: operatorId, capabilities: [`generator-index:${generator}`, 'gpio-matrix'], evidence: ['s3-soc-caps'] });
      for (let trigger = 0; trigger < 2; trigger++) add(`${operatorId}.trigger${trigger}`, 'mcpwm-trigger', 'exclusive', { parent: operatorId, capabilities: [`trigger-index:${trigger}`], evidence: ['s3-soc-caps'] });
    }
  }

  add('twai0', 'twai-controller', 'shared', { capabilities: ['gpio-matrix'], evidence: ['s3-soc-caps'] });
  selectableRoute('twai0', 'tx', outputGpio); selectableRoute('twai0', 'rx', inputGpio);
  add('gptimer', 'hardware-timer-controller', 'shared', { capabilities: ['2-groups', '2-timers-per-group', '4-timers', '54-bit-counter'], evidence: ['s3-soc-caps', 's3-timer'] });
  for (let group = 0; group < 2; group++) for (let timer = 0; timer < 2; timer++) add(`gptimer.group${group}.timer${timer}`, 'hardware-timer', 'exclusive', { parent: 'gptimer', aliases: [`GPTIMER${group}_${timer}`], capabilities: [`group-index:${group}`, `timer-index:${timer}`], evidence: ['s3-soc-caps', 's3-timer'] });
  add('systimer', 'system-timer-controller', 'shared', { capabilities: ['2-counters', '3-alarms', '32-and-20-bit'], evidence: ['s3-soc-caps'] });
  for (let counter = 0; counter < 2; counter++) add(`systimer.counter${counter}`, 'system-timer-counter', 'exclusive', { parent: 'systimer', capabilities: [`counter-index:${counter}`], evidence: ['s3-soc-caps'] });
  for (let alarm = 0; alarm < 3; alarm++) add(`systimer.alarm${alarm}`, 'system-timer-alarm', 'exclusive', { parent: 'systimer', capabilities: [`alarm-index:${alarm}`], evidence: ['s3-soc-caps'] });

  const graph: BoardResourceGraph = graphBuilder.build(evidence, 'full');
  const pwm: Record<string, string> = Object.fromEntries(outputGpio.map(pin => [String(pin), 'ledc']));
  const serialDefaults = {
    Serial: cdcOnBoot ? (usbHardwareCdc ? { resource: 'usb-serial-jtag', transport: 'usb-serial-jtag' as const } : { resource: 'usb-otg', transport: 'usb-otg' as const }) : { resource: 'uart0', transport: 'uart' as const, rx: 'gpio.44', tx: 'gpio.43' },
    Serial0: { resource: 'uart0', transport: 'uart' as const, rx: 'gpio.44', tx: 'gpio.43' },
    Serial1: { resource: 'uart1', transport: 'uart' as const, rx: 'gpio.15', tx: 'gpio.16' },
    Serial2: { resource: 'uart2', transport: 'uart' as const, rx: 'gpio.19', tx: 'gpio.20' },
  };
  return {
    status: 'ready' as const,
    identity: { ...identity, options: { ...identity.options } },
    resource_graph: graph,
    pwm,
    adc,
    serial,
    serialDefaults,
    metadata: { defaultSerial: serialDefaults.Serial.resource, serialDefaults },
    defaultSerial: serialDefaults.Serial.resource,
    ledc: { groups: 1, channelsPerGroup: 8, totalChannels: 8, timersPerGroup: 4, maxResolution: 14, allocation: 'dynamic' as const },
    coreDependencies: { flash: { resources: [...new Set([...snapshot.boardExposure.flashReservedPins, ...(opi ? snapshot.boardExposure.octalMemoryPins : [])].map(pin => `gpio.${pin}`))] }, psram: opi ? { resources: [...snapshot.boardExposure.octalMemoryPins.map(pin => `gpio.${pin}`)] } : undefined },
    boardExposure: {
      validGpio: [...validGpio],
      exposedGpio: [...snapshot.boardExposure.exposedGpio],
      inputOnlyGpio: [],
      packageExposure: { ...snapshot.boardExposure.packageExposure },
      defaultI2c: { ...snapshot.boardExposure.defaultRoutes.i2c0 },
      defaultSpi: { ...snapshot.boardExposure.defaultRoutes.spi2 },
      defaultUart: { ...snapshot.boardExposure.defaultRoutes.uart0 },
      usbSerialJtag: { dm: 19, dp: 20, active: usbSerialActive },
      resourceAffectingOptions: {
        JTAGAdapter: option(identity, 'JTAGAdapter', 'default'),
        PSRAM: option(identity, 'PSRAM', octal ? 'opi' : 'disabled'),
        FlashMode: option(identity, 'FlashMode', octal ? 'opi' : 'qio'),
        USBMode: option(identity, 'USBMode', 'hwcdc'),
        CDCOnBoot: option(identity, 'CDCOnBoot', 'default'),
        MSCOnBoot: option(identity, 'MSCOnBoot', 'default'),
        DFUOnBoot: option(identity, 'DFUOnBoot', 'default'),
        UploadMode: option(identity, 'UploadMode', 'default'),
      },
      psram: { supported: true, mode: opi ? 'opi' : option(identity, 'PSRAM', 'disabled') === 'enabled' ? 'qspi' : 'disabled' },
      activeSystemRoutes: { usbSerialJtag: usbSerialActive, usbOtg: usbOtgActive, octalMemory: opi },
    },
    menus: { octal, psram: option(identity, 'PSRAM', octal ? 'opi' : 'disabled'), fCpu: identity.fCpu },
  };
}

export { validGpio };
