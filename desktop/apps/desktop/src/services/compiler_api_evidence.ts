/**
 * Reviewed implementation summaries, not block/package adapters.
 * Only the selected compiler objects + exact source bytes activate a summary.
 * A similarly named third-party library, new version or different Core fails closed.
 */
import type {
    CompilerResourceSnapshot, CompilerSourceDigest, VerifiedI2cApiEvidence, VerifiedPrimitiveApiEvidence,
} from './compiler_resource_observation';

export interface CapturedCompilerSnapshot extends Omit<CompilerResourceSnapshot, 'graphSha256'> {
    symbols: { file: string; definedSymbols: string[]; referencedSymbols: string[] }[];
    gaps: string[];
}
const normalize = (path: string) => path.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').toLowerCase();
const reviewed = {
    arduino: ['cores/arduino/Arduino.h', '335f45c59532cd7df39ce1435fbf1abf8d503d42ac6085a92e0f2ff75f5fffac'],
    digital: ['cores/arduino/wiring_digital.c', 'f56a12bb80e3179db3c4803a90b7c3c4ac6b14d4f23ababb121173ef0e27d26c'],
    analog: ['cores/arduino/wiring_analog.c', 'af985237cce8dcf22d1a1359bab6af274c780592feae73707c792c334ee63172'],
    serialHeader: ['cores/arduino/HardwareSerial.h', 'f64d1a45fb14b94ca2425e73978f61bd054a886e5f838089098008d199a9bd73'],
    serial: ['cores/arduino/HardwareSerial.cpp', '641c8d9b1f266c7b97ca59bcb0915e09a897ef1fa78dd9cdb2c93ce1c2d19c1b'],
    tone: ['cores/arduino/Tone.cpp', '7c902769f0950fc26a1032258f526775d25ae61aca97de2036653459172f3d00'],
    wireHeader: ['libraries/Wire/src/Wire.h', 'e08adefc3c3b31d9444ba8bd28d67beef1efff310cdef4d8f8aa4ad88542da92'],
    wire: ['libraries/Wire/src/Wire.cpp', 'e56c6ff92128cc1334b8e112fc463396646166e2dc8f99178b45d5201bb607c3'],
    twi: ['libraries/Wire/src/utility/twi.c', '846c0a685d1796990c8c5d06df4364fcf8d4657c2221161a613f8cafb232301d'],
    twiHeader: ['libraries/Wire/src/utility/twi.h', 'a8551bcf840a1d17dfa435fb6f299726bf45abfe75018ddc860a7788053a0f30'],
    spiHeader: ['libraries/SPI/src/SPI.h', '5b444eebc18adac5a69e99cfdc229cb7c8622125b67e1e0d2e2127fa2cde52b1'],
    spi: ['libraries/SPI/src/SPI.cpp', 'adae94aae5f04be3225a568a1ed932a917160c0859e51ee3850fa0da4cf4e345'],
    softHeader: ['libraries/SoftwareSerial/src/SoftwareSerial.h', '5897e15a3fc14307066fbad6e201f88e39417a8d40368c21b41ea14a0abf2f25'],
    soft: ['libraries/SoftwareSerial/src/SoftwareSerial.cpp', 'f49b152375ede361c7475ac9a83d9fa23bef7f3c9c58c46ca036b1aa85cd65b0'],
    servoHeader: ['src/Servo.h', 'baf96f1d65390abddb1c88121198480e4d993b7c9ef87657640082aa73944d7d'],
    servo: ['src/avr/Servo.cpp', '6b4477836ed3a00c3d77a5ad1e6a8636a4ee6cc905a9d93dfc60fca654860abb'],
    servoTimers: ['src/avr/ServoTimers.h', 'c18bf7dfd3804d0862572b4e0ea3b4e73431916771ceb531c28e88ed36ec4461'],
} as const;

export function verifiedCompilerApis(snapshot: CapturedCompilerSnapshot) {
    const primitives: VerifiedPrimitiveApiEvidence[] = [];
    const i2c: VerifiedI2cApiEvidence[] = [];
    const source = (key: keyof typeof reviewed) => {
        const [suffix, hash] = reviewed[key];
        const found = snapshot.sources.filter(item => normalize(item.path).endsWith(`/${suffix.toLowerCase()}`) && item.sha256 === hash);
        return found.length === 1 ? found[0] : undefined;
    };
    const proof = (definition: keyof typeof reviewed, header: keyof typeof reviewed, other: (keyof typeof reviewed)[] = []) => {
        const files = [definition, header, ...other].map(source);
        if (files.some(file => !file)) return undefined;
        const definitionFile = files[0]!.path;
        const symbols = snapshot.symbols.find(item => normalize(item.file) === normalize(definitionFile));
        if (!symbols) return undefined;
        return { definitionFile, headerFile: files[1]!.path, sourceEvidence: files as CompilerSourceDigest[],
            context: snapshot.context, definedSymbols: symbols.definedSymbols };
    };
    const add = (definition: keyof typeof reviewed, header: keyof typeof reviewed,
        entries: Pick<VerifiedPrimitiveApiEvidence, 'callee' | 'kind' | 'valueArgument' | 'receiverArgument'>[]) => {
        const evidence = proof(definition, header);
        if (evidence) for (const entry of entries) primitives.push({ ...evidence, ...entry });
    };
    add('digital', 'arduino', [
        { callee: 'digitalWrite', kind: 'gpio-output' }, { callee: 'digitalRead', kind: 'gpio-input' },
        { callee: 'pinMode', kind: 'pin-mode' },
    ]);
    add('analog', 'arduino', [
        { callee: 'analogRead', kind: 'adc' }, { callee: 'analogWrite', kind: 'pwm' },
    ]);
    add('serial', 'serialHeader', [{ callee: 'HardwareSerial::begin', kind: 'uart', receiverArgument: 0, valueArgument: 1 }]);
    add('spi', 'spiHeader', [{ callee: 'SPIClass::begin', kind: 'spi' }]);
    add('tone', 'arduino', [{ callee: 'tone', kind: 'tone' }]);
    // AVR SoftwareSerial RX is interrupt serviced; TX explicitly masks global
    // interrupts for start/data bits. This is a latency hazard, NOT a Timer claim.
    add('soft', 'softHeader', [
        { callee: 'SoftwareSerial::begin', kind: 'interrupt-blocking', receiverArgument: 0 },
        { callee: 'SoftwareSerial::write', kind: 'interrupt-blocking', receiverArgument: 0 },
    ]);
    const wire = proof('wire', 'wireHeader', ['twi', 'twiHeader']);
    if (wire) i2c.push({ ...wire, callee: 'TwoWire::beginTransmission', commitCallee: 'TwoWire::endTransmission',
        intermediateCallees: ['TwoWire::write'], receiver: '&Wire', receiverArgument: 0,
        addressArgument: 1, resourceAlias: 'i2c' });
    const servo = proof('servo', 'servoHeader', ['servoTimers']);
    if (servo) {
        // Inspect the compiler-expanded enum. Never select Timer1 by board name,
        // library name or the order of an unexpanded #if. Multi-timer allocation
        // depends on runtime Servo object indices and deliberately stays unknown.
        const unit = snapshot.units.find(item => normalize(item.file) === normalize(servo.definitionFile));
        const match = unit?.preprocessed?.match(/typedef\s+enum\s*\{([^{}]+)\}\s*timer16_Sequence_t\s*;/);
        const tokens = match?.[1].split(',').map(item => item.trim());
        const timers = tokens?.filter(token => /^_timer\d+$/.test(token));
        const timer = tokens && timers?.length === 1 && tokens.length === 2 && tokens[1] === '_Nbr_16timers'
            ? timers[0].replace('_timer', 'TIMER') : undefined;
        primitives.push({ ...servo, callee: 'Servo::attach', kind: 'servo-attach',
            receiverArgument: 0, valueArgument: 1, ...(timer ? { timer } : {}) });
    }
    return { primitives, i2c };
}
