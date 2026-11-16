import snapshots188 from '../config/avr-resource-evidence/nano-1.8.8.json';
import snapshots186 from '../config/avr-resource-evidence/nano-1.8.6.json';
import type { AvrResolvedIdentity } from './avr_resource_definition';
import { buildAvrResourceModel, matchesAvrIdentity } from './avr_resource_definition';

/** Source-backed Nano data; graph construction is shared by all AVR boards. */
export function resolveNanoResourceModel(identity: AvrResolvedIdentity) {
  const snapshot = [...snapshots188, ...snapshots186].find(entry => matchesAvrIdentity(entry.identity as AvrResolvedIdentity, identity));
  if (!snapshot) return undefined;
  const source = (index: number) => `nano.core.${index}`;
  const evidence = snapshot.evidence.map((entry, index) => ({
    id: source(index), source: entry.path, locator: `sha256:${entry.sha256}`, confidence: 'verified' as const,
  }));
  const definition = {
    evidence: [...evidence, {
      id: 'nano-pinout',
      source: identity.mcu === 'atmega168' ? 'https://www.arduino.cc/en/uploads/Main/ArduinoNanoManual23.pdf' : 'https://docs.arduino.cc/resources/pinouts/A000005-full-pinout.pdf',
      locator: 'Nano pin layout: D0/RX; D1/TX; D13/LED; A6/A7 analog-only. USB bridge is not a sketch GPIO claim.',
      confidence: 'verified' as const,
    }],
    gpioPins: snapshot.ports.flatMap((port, pin) => port === 0 ? [] : [pin]),
    analogPins: snapshot.analogPins.map((token, channel) => ({ token, gpio: snapshot.analogGpio[channel] })),
    timers: snapshot.timers,
    toneTimer: snapshot.toneTimer,
    toneEvidence: source(8),
    led: snapshot.led,
    spi: snapshot.spi,
    i2c: snapshot.i2c,
    uarts: [{ id: 'uart0', port: 'Serial', rx: 0, tx: 1, evidence: [source(7), 'nano-pinout'] }],
    baseResourceEvidence: [source(2), source(3)],
    timerEvidence: [source(3), source(5)],
    adcControllerEvidence: [source(6)],
    adcChannelEvidence: [source(2), source(3), source(6)],
    spiEvidence: [source(3), source(10)],
    i2cEvidence: [source(3), source(9)],
    ledEvidence: [source(3), 'nano-pinout'],
    pinAliases: { '0': ['RX'], '1': ['TX'], '10': ['SS'], '11': ['MOSI'], '12': ['MISO'], '13': ['SCK'], '18': ['SDA'], '19': ['SCL'] },
  };
  return buildAvrResourceModel(identity, definition);
}
