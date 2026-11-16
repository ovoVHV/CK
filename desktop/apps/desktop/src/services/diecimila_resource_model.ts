import definitions188 from '../config/avr-resource-evidence/diecimila-1.8.8.json';
import definitions186 from '../config/avr-resource-evidence/diecimila-1.8.6.json';
import type { AvrResolvedIdentity } from './avr_resource_definition';
import { buildAvrResourceModel, matchesAvrIdentity } from './avr_resource_definition';

/** Source-backed Duemilanove/Diecimila data; graph construction is shared. */
export function resolveDiecimilaResourceModel(identity: AvrResolvedIdentity) {
  const data = [...definitions188, ...definitions186].find(entry => matchesAvrIdentity(entry.identity as AvrResolvedIdentity, identity));
  if (!data) return undefined;
  const evidence = data.evidence.map((entry, index) => ({
    id: `diecimila.source.${index}`, source: entry.path, locator: `sha256:${entry.sha256}`, confidence: 'verified' as const,
  }));
  const source = (suffix: string) => {
    const entry = evidence.find(item => item.source.endsWith(suffix));
    if (!entry) throw new Error(`Missing admitted source: ${suffix}`);
    return entry.id;
  };
  const variant = source(`/variants/${identity.variant}/pins_arduino.h`);
  return buildAvrResourceModel(identity, {
    evidence: [...evidence,
      { id: 'diecimila.schematic', source: 'https://www.arduino.cc/en/uploads/Main/Arduino-Diecimila-schematic.pdf', locator: 'Header RX/PD0, TX/PD1; LED/SCK/PB5; FT232RL bridge', confidence: 'verified' },
      { id: 'duemilanove.schematic', source: 'https://www.arduino.cc/en/uploads/Main/arduino-duemilanove-schematic.pdf', locator: 'Header RX/PD0, TX/PD1; LED/SCK/PB5; FT232RL bridge', confidence: 'verified' },
    ],
    gpioPins: data.ports.flatMap((port, pin) => port ? [pin] : []),
    analogPins: data.analogPins.map((token, channel) => ({ token, gpio: data.analogGpio[channel] })),
    timers: data.timers,
    toneTimer: data.toneTimer,
    toneEvidence: source('/Tone.cpp'),
    led: data.led,
    spi: data.spi,
    i2c: data.i2c,
    uarts: [{ id: 'uart0', port: 'Serial', rx: 0, tx: 1, evidence: [source('/HardwareSerial0.cpp'), 'diecimila.schematic', 'duemilanove.schematic'] }],
    baseResourceEvidence: [variant],
    timerEvidence: [variant, source('/wiring.c')],
    adcControllerEvidence: [source('/wiring_analog.c')],
    adcChannelEvidence: [variant, source('/wiring_analog.c')],
    spiEvidence: [variant, source('/SPI.cpp')],
    i2cEvidence: [variant, source('/twi.c')],
    ledEvidence: [variant, 'diecimila.schematic', 'duemilanove.schematic'],
    pinAliases: { '0': ['RX'], '1': ['TX'], '10': ['SS'], '11': ['MOSI'], '12': ['MISO'], '13': ['SCK'], '18': ['SDA'], '19': ['SCL'] },
  });
}
