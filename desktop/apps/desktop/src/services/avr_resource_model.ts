import uno188 from '../config/avr-resource-evidence/uno-1.8.8.json';
import uno186 from '../config/avr-resource-evidence/uno-1.8.6.json';
import { resolveNanoResourceModel } from './nano_resource_model';
import { resolveDiecimilaResourceModel } from './diecimila_resource_model';
import { resolveMegaResourceModel } from './mega_resource_model';
import type { AvrResolvedIdentity } from './avr_resource_definition';
import { buildAvrResourceModel, matchesAvrIdentity } from './avr_resource_definition';

export type { AvrResolvedIdentity as ResolvedAvrResourceIdentity } from './avr_resource_definition';

/** Caller must supply resolved build properties, never values inferred from a display name. */
export function resolveAvrResourceModel(identity: AvrResolvedIdentity) {
  const mega = resolveMegaResourceModel(identity);
  if (mega) return mega;
  const diecimila = resolveDiecimilaResourceModel(identity);
  if (diecimila) return diecimila;
  const nano = resolveNanoResourceModel(identity);
  if (nano) return nano;

  const uno = [uno188, uno186].find(entry => matchesAvrIdentity(entry, identity));
  if (!uno) return { status: 'not-applicable' as const, reason: 'unverified-resolved-identity' };
  const sourceId = (index: number) => `core.${index}`;
  const evidence = uno.evidence.map((entry, index) => ({
    id: sourceId(index), source: entry.path, locator: `sha256:${entry.sha256}`, confidence: 'verified' as const,
  }));
  return buildAvrResourceModel(identity, {
    evidence: [...evidence, {
      id: 'uno-pinout',
      source: 'https://content.arduino.cc/assets/A000066-full-pinout.pdf',
      locator: 'D0/RX=PD0/RXD; D1/TX=PD1/TXD',
      confidence: 'verified',
    }],
    gpioPins: Array.from({ length: uno.digital }, (_, pin) => pin),
    analogPins: uno.analogPins.map(token => ({ token, gpio: token })),
    timers: uno.timers,
    toneTimer: uno.toneTimer,
    toneEvidence: sourceId(7),
    led: uno.led,
    spi: uno.spi,
    i2c: uno.i2c,
    uarts: [{ id: 'uart0', port: 'Serial', rx: 0, tx: 1, evidence: [sourceId(6), 'uno-pinout'] }],
    baseResourceEvidence: [sourceId(2)],
    timerEvidence: [sourceId(2), sourceId(4)],
    adcControllerEvidence: [sourceId(5)],
    adcChannelEvidence: [sourceId(2), sourceId(5)],
    spiEvidence: [sourceId(2), sourceId(9)],
    i2cEvidence: [sourceId(2), sourceId(8)],
    ledEvidence: [sourceId(2)],
    pinAliases: { '10': ['SS'], '11': ['MOSI'], '12': ['MISO'], '13': ['SCK'], '18': ['SDA'], '19': ['SCL'] },
  });
}
