import definitions188 from '../config/avr-resource-evidence/mega-1.8.8.json';
import definitions186 from '../config/avr-resource-evidence/mega-1.8.6.json';
import type { AvrResolvedIdentity } from './avr_resource_definition';
import { buildAvrResourceModel, matchesAvrIdentity } from './avr_resource_definition';

/** Exact, independently extracted Mega data; graph construction is shared. */
export function resolveMegaResourceModel(identity: AvrResolvedIdentity) {
  const data = [...definitions188, ...definitions186].find(entry => matchesAvrIdentity(entry.identity as AvrResolvedIdentity, identity));
  if (!data) return undefined;
  const evidence = data.evidence.map((entry, index) => ({
    id: `mega.source.${index}`, source: entry.path, locator: `sha256:${entry.sha256}`, confidence: 'verified' as const,
  }));
  const source = (suffix: string) => {
    const entry = evidence.find(item => item.source.endsWith(suffix));
    if (!entry) throw new Error(`Missing admitted source: ${suffix}`);
    return entry.id;
  };
  const variant = source(`/variants/${identity.variant}/pins_arduino.h`);
  return buildAvrResourceModel(identity, {
    evidence: [...evidence,
      { id: 'mega.pinout', source: 'https://docs.arduino.cc/resources/pinouts/A000067-full-pinout.pdf', locator: 'Hardware UART header routes; PB1/PB2/PB3 SPI repeated on ICSP; LED/D13, not SCK', confidence: 'verified' },
      { id: 'mega1280.schematic', source: 'https://www.arduino.cc/en/uploads/Main/arduino-mega-schematic.pdf', locator: 'Hardware UART header routes; PB1/PB2/PB3 SPI repeated on ICSP; LED/D13, not SCK', confidence: 'verified' },
    ],
    gpioPins: data.ports.filter(Boolean).map((_, pin) => pin),
    analogPins: data.analogPins.map((token, channel) => ({ token, gpio: data.analogGpio[channel] })),
    timers: data.timers,
    toneTimer: data.toneTimer,
    toneEvidence: source('/Tone.cpp'),
    led: data.led,
    spi: data.spi,
    i2c: data.i2c,
    uarts: data.uart.map(uart => ({ id: uart.id, port: uart.port, rx: uart.rx, tx: uart.tx, evidence: [source('/' + uart.implementation), 'mega.pinout', 'mega1280.schematic'] })),
    baseResourceEvidence: [variant],
    timerEvidence: [variant, source('/wiring.c')],
    adcControllerEvidence: [source('/wiring_analog.c')],
    adcChannelEvidence: [variant, source('/wiring_analog.c')],
    spiEvidence: [variant, source('/SPI.cpp')],
    i2cEvidence: [variant, source('/twi.c')],
    ledEvidence: [variant, 'mega.pinout', 'mega1280.schematic'],
    pinAliases: { '50': ['MISO'], '51': ['MOSI'], '52': ['SCK'], '53': ['SS'], '20': ['SDA'], '21': ['SCL'] },
    icspAliases: [{ signal: 'SCK', pin: data.spi.sck }, { signal: 'MOSI', pin: data.spi.mosi }, { signal: 'MISO', pin: data.spi.miso }],
  });
}
