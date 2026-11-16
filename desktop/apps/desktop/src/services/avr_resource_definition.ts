import type { BoardResourceGraph, HardwareResource } from './hardware_resource_graph';
import { createResourceGraphBuilder } from './resource_graph_builder';

export interface AvrResolvedIdentity {
  fqbn: string;
  options: Record<string, string>;
  mcu: string;
  variant: string;
  coreVersion: string;
  fCpu: string;
}

export interface AvrEvidence {
  id: string;
  source: string;
  locator: string;
  confidence: 'verified';
}

export interface AvrResourceDefinition {
  evidence: AvrEvidence[];
  gpioPins: number[];
  analogPins: Array<{ token: number; gpio?: number }>;
  timers: Array<{ pin: number; timer: string }>;
  toneTimer: string;
  toneEvidence: string;
  led: number;
  spi: { ss: number; sck: number; mosi: number; miso: number };
  i2c: { sda: number; scl: number };
  uarts: Array<{ id: string; port: string; rx: number; tx: number; evidence: string[] }>;
  baseResourceEvidence: string[];
  timerEvidence: string[];
  adcControllerEvidence: string[];
  adcChannelEvidence: string[];
  spiEvidence: string[];
  i2cEvidence: string[];
  ledEvidence: string[];
  pinAliases?: Record<string, string[]>;
  icspAliases?: Array<{ signal: string; pin: number }>;
}

export function matchesAvrIdentity(expected: AvrResolvedIdentity, actual: AvrResolvedIdentity) {
  return expected.fqbn === actual.fqbn && expected.mcu === actual.mcu &&
    expected.variant === actual.variant && expected.fCpu === actual.fCpu &&
    expected.coreVersion === actual.coreVersion &&
    Object.keys(expected.options).length === Object.keys(actual.options).length &&
    Object.entries(expected.options).every(([key, value]) => actual.options[key] === value);
}

/**
 * Generic AVR capability graph construction. Board files only supply exact
 * source-backed data and evidence; claims and analysis stay elsewhere.
 */
export function buildAvrResourceModel(identity: AvrResolvedIdentity, definition: AvrResourceDefinition) {
  const graphBuilder = createResourceGraphBuilder(definition.baseResourceEvidence);
  const { resources, add, fixedRoute: route } = graphBuilder;
  const gpioByPin = new Map<number, HardwareResource>();
  for (const pin of definition.gpioPins) {
    const channel = definition.analogPins.findIndex(entry => entry.gpio === pin);
    const gpio: HardwareResource = {
      id: `gpio.${pin}`,
      type: 'gpio',
      sharing: 'exclusive',
      evidence: [...definition.baseResourceEvidence],
      aliases: [String(pin), ...(channel >= 0 ? [`A${channel}`] : []), ...(pin === definition.led ? ['LED_BUILTIN'] : [])],
      capabilities: ['digital-input', 'digital-output'],
    };
    resources.push(gpio);
    gpioByPin.set(pin, gpio);
  }

  const pwm: Record<string, string> = {};
  const outputs = definition.timers.filter(entry => entry.timer !== 'NOT_ON_TIMER');
  for (const timer of new Set(outputs.map(entry => entry.timer.slice(0, -1)))) {
    add(timer, 'timer', 'shared', { evidence: [...definition.timerEvidence], capabilities: timer === 'TIMER0' ? ['core-timebase'] : [] });
  }
  for (const { pin, timer } of outputs) {
    const parent = timer.slice(0, -1);
    add(timer, 'pwm-channel', 'exclusive', { parent });
    route(timer, 'output', pin);
    pwm[String(pin)] = timer;
    gpioByPin.get(pin)?.capabilities?.push(timer);
  }

  const adc: Record<string, string> = {};
  add('adc', 'adc-controller', 'shared', { evidence: [...definition.adcControllerEvidence] });
  definition.analogPins.forEach(({ token, gpio }, channel) => {
    const id = `adc.${channel}`;
    add(id, 'adc-channel', 'shared', { parent: 'adc', evidence: [...definition.adcChannelEvidence] });
    if (gpio !== undefined && gpio >= 0) route(id, 'input', gpio);
    for (const alias of [String(channel), String(token), `A${channel}`]) adc[alias] = id;
  });

  for (const uart of definition.uarts) {
    add(uart.id, 'uart-controller', 'configuration', {
      aliases: [uart.port], configurationKeys: ['baud'], evidence: [...uart.evidence],
    });
    route(uart.id, 'rx', uart.rx);
    route(uart.id, 'tx', uart.tx);
  }
  add('spi', 'spi-controller', 'selector', { evidence: [...definition.spiEvidence] });
  for (const signal of ['sck', 'mosi', 'miso'] as const) route('spi', signal, definition.spi[signal]);
  add('i2c', 'i2c-controller', 'address', { evidence: [...definition.i2cEvidence] });
  for (const signal of ['sda', 'scl'] as const) route('i2c', signal, definition.i2c[signal]);
  add('board.led', 'onboard-device', 'shared', { evidence: [...definition.ledEvidence] });
  route('board.led', 'led', definition.led);
  for (const [pinText, aliases] of Object.entries(definition.pinAliases ?? {})) {
    const gpio = gpioByPin.get(Number(pinText));
    if (!gpio) continue;
    gpio.aliases?.push(...aliases);
    gpio.capabilities?.push(...aliases);
  }
  for (const alias of definition.icspAliases ?? []) gpioByPin.get(alias.pin)?.aliases?.push(`ICSP.${alias.signal.toUpperCase()}`);

  const graph: BoardResourceGraph = graphBuilder.build(definition.evidence, 'partial');
  return {
    status: 'ready' as const,
    identity: { ...identity, options: { ...identity.options } },
    resource_graph: graph,
    pwm,
    adc,
    coreDependencies: { tone: { resource: definition.toneTimer, exclusive: true, evidence: definition.toneEvidence } },
  };
}
