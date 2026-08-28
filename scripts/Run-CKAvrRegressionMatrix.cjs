#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ARDUINO_CLI_LANE_IDLE_POLICY_ID,
  ARDUINO_CLI_LANE_IDLE_POLL_INTERVAL_MS,
  ARDUINO_CLI_LANE_IDLE_TIMEOUT_MS,
  ARDUINO_CLI_LANE_IDLE_WINDOW_MS,
  assertFreeSpace,
  assertNoConcurrentArduinoCli,
  canonicalCompleteFqbn,
  cdpPreflightTimeoutMs,
  compareAvrArtifactRoles,
  createCdp,
  createNativeTrial,
  digestObject,
  effectiveJobs,
  getCdpTarget,
  inspectCkArtifacts,
  inspectCliAndCore,
  inspectOwnedWorkdir,
  inspectProductionExecutable,
  median,
  nativeBaselineContract,
  nativeRelinkAdapterFor,
  percentileNearestRank,
  resourcesEquivalent,
  runNativeCompile,
  safeRemoveWorkdir,
  sha256Bytes,
  updateNativeTrialSource,
  validateCacheClear,
  validateCkCompilerEvidence,
  waitForArduinoCliIdleWindow,
} = require('./Run-CKForgeNativeAB.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_TRIALS = 1;
const DEFAULT_TIMEOUT_MINUTES = 10;
const DEFAULT_MIN_FREE_GIB = 8;
const STAGE_IDS = Object.freeze(['simple', 'complex', 'medium', 'simple-return']);
const EDIT_STAGE_IDS = Object.freeze(STAGE_IDS.slice(1));
const PERFORMANCE_POLICY = Object.freeze({
  id: 'ck-avr-matrix-edit-target-v2',
  minimumMedianSpeedupPct: 25,
  minimumAbsoluteMedianGainMs: 500,
  p95NoRegression: true,
  certification: false,
});
const SIMPLE_RETURN_RESTORATION_POLICY = Object.freeze({
  id: 'ck-avr-simple-return-restoration-v1',
  simpleStageId: 'simple',
  restoredStageId: 'simple-return',
  exactSourceBytesRequired: true,
  artifactEquivalencePolicyId: 'arduino-avr-hex-required-eeprom-optional-exact-v2',
  flashAndRamEqualityRequired: true,
  warningCountGateRequired: false,
  warningCountNote: 'Warning emission depends on incremental diagnostic replay; it is observed but is not firmware/resource equivalence.',
});
const LANE_BOUNDARY_IDLE_POLICY = Object.freeze({
  policyId: ARDUINO_CLI_LANE_IDLE_POLICY_ID,
  idleWindowMs: ARDUINO_CLI_LANE_IDLE_WINDOW_MS,
  timeoutMs: ARDUINO_CLI_LANE_IDLE_TIMEOUT_MS,
  pollIntervalMs: ARDUINO_CLI_LANE_IDLE_POLL_INTERVAL_MS,
  outsideMeasuredCompileWallTime: true,
});

const GEMMA_EXPECTED_SKIPS = Object.freeze({
  mstimer2: 'MsTimer2 1.1 emits #error Unsupported CPU type for ATtiny85.',
  'wire-spi-eeprom': 'Arduino AVR Core 1.8.6 Wire/SPI require hardware TWI/SPCR registers unavailable on ATtiny85.',
});

function avrTarget(id, label, fqbn, mcu, clockHz, variant, expectedSkips = {}) {
  return Object.freeze({
    id,
    label,
    fqbn,
    hardware: Object.freeze({ mcu, clockHz, variant }),
    expectedSkips: Object.freeze({ ...expectedSkips }),
  });
}

// Exhaustive expansion of Arduino AVR Boards 1.8.6 boards.txt: 27 board IDs,
// 38 complete FQBNs after every Processor menu value is materialized. Keep
// exact FQBNs separate even where compile properties currently coincide: the
// matrix is also a guard against later Core/menu changes.
const AVR_TARGETS = Object.freeze([
  avrTarget('yun', 'Arduino Yún', 'arduino:avr:yun', 'atmega32u4', 16_000_000, 'yun'),
  avrTarget('uno', 'Arduino Uno', 'arduino:avr:uno', 'atmega328p', 16_000_000, 'standard'),
  avrTarget('unomini', 'Arduino Uno Mini', 'arduino:avr:unomini', 'atmega328p', 16_000_000, 'standard'),
  avrTarget('diecimila-atmega328', 'Duemilanove / Diecimila / ATmega328P', 'arduino:avr:diecimila:cpu=atmega328', 'atmega328p', 16_000_000, 'standard'),
  avrTarget('diecimila-atmega168', 'Duemilanove / Diecimila / ATmega168', 'arduino:avr:diecimila:cpu=atmega168', 'atmega168', 16_000_000, 'standard'),
  avrTarget('nano-atmega328', 'Arduino Nano / ATmega328P', 'arduino:avr:nano:cpu=atmega328', 'atmega328p', 16_000_000, 'eightanaloginputs'),
  avrTarget('nano-atmega328old', 'Arduino Nano / ATmega328P old bootloader', 'arduino:avr:nano:cpu=atmega328old', 'atmega328p', 16_000_000, 'eightanaloginputs'),
  avrTarget('nano-atmega168', 'Arduino Nano / ATmega168', 'arduino:avr:nano:cpu=atmega168', 'atmega168', 16_000_000, 'eightanaloginputs'),
  avrTarget('mega-atmega2560', 'Arduino Mega / ATmega2560', 'arduino:avr:mega:cpu=atmega2560', 'atmega2560', 16_000_000, 'mega'),
  avrTarget('mega-atmega1280', 'Arduino Mega / ATmega1280', 'arduino:avr:mega:cpu=atmega1280', 'atmega1280', 16_000_000, 'mega'),
  avrTarget('mega-adk', 'Arduino Mega ADK', 'arduino:avr:megaADK', 'atmega2560', 16_000_000, 'mega'),
  avrTarget('leonardo', 'Arduino Leonardo', 'arduino:avr:leonardo', 'atmega32u4', 16_000_000, 'leonardo'),
  avrTarget('leonardo-eth', 'Arduino Leonardo ETH', 'arduino:avr:leonardoeth', 'atmega32u4', 16_000_000, 'leonardo'),
  avrTarget('micro', 'Arduino Micro', 'arduino:avr:micro', 'atmega32u4', 16_000_000, 'micro'),
  avrTarget('esplora', 'Arduino Esplora', 'arduino:avr:esplora', 'atmega32u4', 16_000_000, 'leonardo'),
  avrTarget('mini-atmega328', 'Arduino Mini / ATmega328P', 'arduino:avr:mini:cpu=atmega328', 'atmega328p', 16_000_000, 'eightanaloginputs'),
  avrTarget('mini-atmega168', 'Arduino Mini / ATmega168', 'arduino:avr:mini:cpu=atmega168', 'atmega168', 16_000_000, 'eightanaloginputs'),
  avrTarget('ethernet', 'Arduino Ethernet', 'arduino:avr:ethernet', 'atmega328p', 16_000_000, 'ethernet'),
  avrTarget('fio', 'Arduino Fio', 'arduino:avr:fio', 'atmega328p', 8_000_000, 'eightanaloginputs'),
  avrTarget('bt-atmega328', 'Arduino BT / ATmega328P', 'arduino:avr:bt:cpu=atmega328', 'atmega328p', 16_000_000, 'eightanaloginputs'),
  avrTarget('bt-atmega168', 'Arduino BT / ATmega168', 'arduino:avr:bt:cpu=atmega168', 'atmega168', 16_000_000, 'eightanaloginputs'),
  avrTarget('lilypad-usb', 'LilyPad Arduino USB', 'arduino:avr:LilyPadUSB', 'atmega32u4', 8_000_000, 'leonardo'),
  avrTarget('lilypad-atmega328', 'LilyPad Arduino / ATmega328P', 'arduino:avr:lilypad:cpu=atmega328', 'atmega328p', 8_000_000, 'standard'),
  avrTarget('lilypad-atmega168', 'LilyPad Arduino / ATmega168', 'arduino:avr:lilypad:cpu=atmega168', 'atmega168', 8_000_000, 'standard'),
  avrTarget('pro-16mhz-atmega328', 'Arduino Pro / Pro Mini / ATmega328P 16 MHz', 'arduino:avr:pro:cpu=16MHzatmega328', 'atmega328p', 16_000_000, 'eightanaloginputs'),
  avrTarget('pro-8mhz-atmega328', 'Arduino Pro / Pro Mini / ATmega328P 8 MHz', 'arduino:avr:pro:cpu=8MHzatmega328', 'atmega328p', 8_000_000, 'eightanaloginputs'),
  avrTarget('pro-16mhz-atmega168', 'Arduino Pro / Pro Mini / ATmega168 16 MHz', 'arduino:avr:pro:cpu=16MHzatmega168', 'atmega168', 16_000_000, 'eightanaloginputs'),
  avrTarget('pro-8mhz-atmega168', 'Arduino Pro / Pro Mini / ATmega168 8 MHz', 'arduino:avr:pro:cpu=8MHzatmega168', 'atmega168', 8_000_000, 'eightanaloginputs'),
  avrTarget('atmegang-atmega168', 'Arduino NG / ATmega168', 'arduino:avr:atmegang:cpu=atmega168', 'atmega168', 16_000_000, 'standard'),
  avrTarget('atmegang-atmega8', 'Arduino NG / ATmega8', 'arduino:avr:atmegang:cpu=atmega8', 'atmega8', 16_000_000, 'standard'),
  avrTarget('robot-control', 'Arduino Robot Control', 'arduino:avr:robotControl', 'atmega32u4', 16_000_000, 'robot_control'),
  avrTarget('robot-motor', 'Arduino Robot Motor', 'arduino:avr:robotMotor', 'atmega32u4', 16_000_000, 'robot_motor'),
  avrTarget('gemma', 'Arduino Gemma', 'arduino:avr:gemma', 'attiny85', 8_000_000, 'gemma', GEMMA_EXPECTED_SKIPS),
  avrTarget('circuit-playground-32u4', 'Adafruit Circuit Playground', 'arduino:avr:circuitplay32u4cat', 'atmega32u4', 8_000_000, 'circuitplay32u4'),
  avrTarget('yun-mini', 'Arduino Yún Mini', 'arduino:avr:yunmini', 'atmega32u4', 16_000_000, 'yun'),
  avrTarget('industrial-101', 'Arduino Industrial 101', 'arduino:avr:chiwawa', 'atmega32u4', 16_000_000, 'yun'),
  avrTarget('linino-one', 'Linino One', 'arduino:avr:one', 'atmega32u4', 16_000_000, 'yun'),
  avrTarget('uno-wifi', 'Arduino Uno WiFi', 'arduino:avr:unowifi', 'atmega328p', 16_000_000, 'standard'),
]);

function ckMarker(kind, stage, blockType, section, ordinal) {
  const payload = kind === 'begin'
    ? JSON.stringify({
      boundaryId: `${stage}-${ordinal}`,
      blockId: `avr-${stage}-${ordinal}`,
      blockType,
      section,
      confidence: 'exact',
    })
    : `${stage}-${ordinal}`;
  return `/* @ck-source-${kind}:v1:${Buffer.from(payload, 'utf8').toString('hex')} */`;
}

function markedLine(code, stage, blockType, section, ordinal) {
  return `${code} ${ckMarker('begin', stage, blockType, section, ordinal)} ${ckMarker('end', stage, blockType, section, ordinal)}`;
}

function coreOnlySource(stage, size, iterations) {
  const begin = ckMarker('begin', stage, 'variables_set', 'definition', 1);
  const end = ckMarker('end', stage, 'variables_set', 'definition', 1);
  // Real CK-generated core-only sketches rely on Arduino's .ino preprocessor
  // to inject Arduino.h; keeping the include absent catches an engine that was
  // only benchmarked with hand-written, already-translated C++.
  // Use a numeric Arduino pin instead of LED_BUILTIN.  Robot Control/Motor
  // and several legacy AVR variants do not define that convenience macro;
  // keeping the source free of preprocessor branches also preserves the
  // NativeRelink translation contract.  The matrix measures compilation and
  // artifact equivalence, not physical LED wiring.
  return `constexpr uint8_t CK_STATUS_PIN = 13;

volatile uint16_t ckValue = 0; ${begin} ${end}
uint16_t ckSamples[${size}] = {0};

uint16_t ckFold(uint16_t seed) {
  for (uint8_t index = 0; index < ${iterations}; ++index) {
    seed = (uint16_t)((seed << 1U) ^ (uint16_t)(index * 31U + 7U));
  }
  return seed;
}

void setup() {
  ${markedLine('pinMode(CK_STATUS_PIN, OUTPUT);', stage, 'set_pin_mode', 'setup', 2)}
}

void loop() {
  const uint8_t slot = (uint8_t)(millis() % ${size}U);
  ckSamples[slot] = ckFold((uint16_t)(ckSamples[slot] + slot + 1U));
  ckValue = ckSamples[slot];
  ${markedLine('digitalWrite(CK_STATUS_PIN, (ckValue & 1U) ? HIGH : LOW);', stage, 'digital_write', 'loop', 3)}
  delay(2);
}
`;
}

function msTimer2Source(stage, size, intervalMs) {
  const guard = ckMarker('begin', stage, 'control_mstimer2_every', 'definition', 1);
  const guardEnd = ckMarker('end', stage, 'control_mstimer2_every', 'definition', 1);
  return `#if defined(ARDUINO_ARCH_AVR) ${guard}
#include <MsTimer2.h>
#define CK_MSTIMER2_RUN() ((void)0)
#else
class CKMsTimer2Compat {
public:
  typedef void (*Callback)();
  void set(unsigned long intervalMs, Callback cb) {
    intervalMs_ = intervalMs;
    callback_ = cb;
    lastTick_ = millis();
  }
  void start() {
    running_ = true;
    lastTick_ = millis();
  }
  void stop() { running_ = false; }
  void run() {
    if (!running_ || callback_ == nullptr || intervalMs_ == 0) return;
    unsigned long now = millis();
    if ((now - lastTick_) >= intervalMs_) {
      lastTick_ += intervalMs_;
      callback_();
    }
  }
private:
  unsigned long intervalMs_ = 0;
  unsigned long lastTick_ = 0;
  bool running_ = false;
  Callback callback_ = nullptr;
};
static CKMsTimer2Compat ck_ms_timer2;
namespace MsTimer2 {
  inline void set(unsigned long ms, CKMsTimer2Compat::Callback cb) { ck_ms_timer2.set(ms, cb); }
  inline void start() { ck_ms_timer2.start(); }
  inline void stop() { ck_ms_timer2.stop(); }
}
#define CK_MSTIMER2_RUN() ck_ms_timer2.run()
#endif ${guardEnd}

volatile uint16_t ckTicks = 0;
uint16_t ckTimerSamples[${size}] = {0};

void ckTimerCallback() {
  const uint8_t slot = (uint8_t)(ckTicks % ${size}U);
  ckTimerSamples[slot] = (uint16_t)(ckTimerSamples[slot] + slot + 1U);
  ckTicks++;
}

void setup() {
  ${markedLine('Serial.begin(115200);', stage, 'serial_print', 'setup', 2)}
  ${markedLine(`MsTimer2::set(${intervalMs}, ckTimerCallback);`, stage, 'control_mstimer2_every', 'setup', 3)}
  ${markedLine('MsTimer2::start();', stage, 'control_mstimer2_start', 'setup', 4)}
}

void loop() {
  CK_MSTIMER2_RUN();
  ${markedLine('Serial.println(ckTicks);', stage, 'serial_print', 'loop', 5)}
  delay(2);
}
`;
}

function busStackSource(stage, size, spiHz) {
  const include = (header, ordinal) => `#include <${header}> ${ckMarker('begin', stage, `include_${header.toLowerCase()}`, 'definition', ordinal)} ${ckMarker('end', stage, `include_${header.toLowerCase()}`, 'definition', ordinal)}`;
  return `${include('Wire.h', 1)}
${include('SPI.h', 2)}
${include('EEPROM.h', 3)}

SPISettings ckSpiSettings(${spiHz}, MSBFIRST, SPI_MODE0);
uint8_t ckBusSamples[${size}] = {0};
uint8_t ckBusCursor = 0;

void setup() {
  ${markedLine('Serial.begin(115200);', stage, 'serial_print', 'setup', 4)}
  ${markedLine('Wire.begin();', stage, 'wire_begin', 'setup', 5)}
  ${markedLine('SPI.begin();', stage, 'spi_begin', 'setup', 6)}
}

void loop() {
  SPI.beginTransaction(ckSpiSettings);
  const uint8_t sample = SPI.transfer((uint8_t)(ckBusCursor + 0x31U));
  SPI.endTransaction();
  ckBusSamples[ckBusCursor] = sample;
  Wire.beginTransmission(0x3C);
  Wire.write(sample);
  (void)Wire.endTransmission();
  EEPROM.update(ckBusCursor, sample);
  ${markedLine('Serial.println(sample);', stage, 'serial_print', 'loop', 7)}
  ckBusCursor = (uint8_t)((ckBusCursor + 1U) % ${size}U);
  delay(2);
}
`;
}

function stagesFrom(builder, variants) {
  return Object.freeze(STAGE_IDS.map((id, index) => Object.freeze({
    id,
    // The final stage must return to the exact original source bytes. This
    // proves deterministic restoration rather than merely returning to a
    // semantically similar sketch whose CK marker IDs differ.
    code: builder(id === 'simple-return' ? 'simple' : id, ...variants[index]),
  })));
}

const AVR_WORKLOADS = Object.freeze([
  Object.freeze({
    id: 'core-only-block-style',
    label: 'Core-only 积木风格（定位 marker / 数组 / 引脚）',
    requiredHeaders: Object.freeze([]),
    stages: stagesFrom(coreOnlySource, [[3, 2], [24, 14], [8, 6], [3, 2]]),
  }),
  Object.freeze({
    id: 'mstimer2',
    label: 'MsTimer2 第三方 Arduino 库',
    requiredHeaders: Object.freeze(['MsTimer2.h']),
    stages: stagesFrom(msTimer2Source, [[3, 500], [24, 25], [8, 100], [3, 500]]),
  }),
  Object.freeze({
    id: 'wire-spi-eeprom',
    label: 'Wire + SPI + EEPROM 内置依赖组合',
    requiredHeaders: Object.freeze(['Wire.h', 'SPI.h', 'EEPROM.h']),
    stages: stagesFrom(busStackSource, [[3, 500000], [24, 4000000], [8, 1000000], [3, 500000]]),
  }),
]);

function workloadApplicability(target, workload) {
  const reason = target?.expectedSkips?.[workload?.id];
  if (typeof reason === 'string' && reason.trim()) {
    return Object.freeze({
      status: 'expected-skip',
      applicable: false,
      reason: reason.trim(),
    });
  }
  return Object.freeze({ status: 'applicable', applicable: true, reason: null });
}

function validateWorkload(workload) {
  if (!workload || !Array.isArray(workload.stages)
      || workload.stages.map((stage) => stage.id).join('\0') !== STAGE_IDS.join('\0')) return false;
  const hashes = workload.stages.map((stage) => sha256Bytes(stage.code));
  if (hashes[0] !== hashes[3]
      || hashes[0] === hashes[1]
      || hashes[0] === hashes[2]
      || hashes[1] === hashes[2]) return false;
  return workload.stages.every((stage) => (
    typeof stage.code === 'string'
    && stage.code.includes('@ck-source-begin:v1:')
    && stage.code.includes('@ck-source-end:v1:')
    && workload.requiredHeaders.every((header) => (
      new RegExp(`#include\\s*<${header.replace('.', '\\.')}>`, 'u').test(stage.code)
    ))
  ));
}

function parseInteger(value, label, minimum, maximum) {
  if (!/^\d+$/u.test(String(value || ''))) throw new Error(`${label} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be in ${minimum}..${maximum}`);
  }
  return parsed;
}

function selectedRows(values, available, label) {
  if (values.length === 0 || values.includes('all')) return [...available];
  const requested = new Set(values);
  const rows = available.filter((item) => requested.has(item.id));
  const missing = [...requested].filter((id) => !available.some((item) => item.id === id));
  if (missing.length > 0) throw new Error(`unknown ${label}: ${missing.join(', ')}`);
  return rows;
}

function parseArgs(argv) {
  const options = {
    action: null,
    trials: DEFAULT_TRIALS,
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    minFreeGiB: DEFAULT_MIN_FREE_GIB,
    outputPath: null,
    allowCacheReset: false,
    keepWorkdir: false,
    targetIds: [],
    workloadIds: [],
    help: false,
  };
  const setAction = (action) => {
    if (options.action && options.action !== action) throw new Error('choose exactly one of --plan or --execute');
    options.action = action;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--plan') setAction('plan');
    else if (argument === '--execute') setAction('execute');
    else if (argument === '--allow-cache-reset') options.allowCacheReset = true;
    else if (argument === '--keep-workdir') options.keepWorkdir = true;
    else if (argument === '--trials') options.trials = parseInteger(argv[++index], '--trials', 1, 5);
    else if (argument === '--timeout-minutes') options.timeoutMinutes = parseInteger(argv[++index], '--timeout-minutes', 1, 60);
    else if (argument === '--min-free-gib') options.minFreeGiB = parseInteger(argv[++index], '--min-free-gib', 1, 100);
    else if (argument === '--target') options.targetIds.push(String(argv[++index] || '').trim());
    else if (argument === '--workload') options.workloadIds.push(String(argv[++index] || '').trim());
    else if (argument === '--output') options.outputPath = path.resolve(process.cwd(), argv[++index] || '');
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown argument '${argument}'`);
  }
  if (options.help || argv.length === 0) return { ...options, help: true };
  if (!options.action) throw new Error('choose --plan or --execute');
  options.targets = selectedRows(options.targetIds, AVR_TARGETS, 'target');
  options.workloads = selectedRows(options.workloadIds, AVR_WORKLOADS, 'workload');
  if (options.action === 'plan' && (options.outputPath || options.allowCacheReset || options.keepWorkdir)) {
    throw new Error('--plan is read-only and cannot accept output/cache-reset/workdir flags');
  }
  if (options.action === 'execute') {
    if (!options.allowCacheReset) throw new Error('--execute requires --allow-cache-reset');
    if (!options.outputPath || path.extname(options.outputPath).toLowerCase() !== '.json') {
      throw new Error('--execute requires --output <new.json>');
    }
    if (fs.existsSync(options.outputPath)) throw new Error(`refusing to overwrite ${options.outputPath}`);
  }
  return options;
}

function usage() {
  return `CK real AVR compile regression matrix

Usage:
  node scripts/Run-CKAvrRegressionMatrix.cjs --plan [filters]
  node scripts/Run-CKAvrRegressionMatrix.cjs --execute --allow-cache-reset --output <new.json> [options]

Options:
  --target <id|all>          Repeatable; default all 38 exact FQBNs
  --workload <id|all>        Repeatable; default all 3 workloads
  --trials <1..5>            Cold + edit sequences per cell; default ${DEFAULT_TRIALS}
  --timeout-minutes <1..60>  Per compile; default ${DEFAULT_TIMEOUT_MINUTES}
  --min-free-gib <1..100>    Abort before the active volume is tight; default ${DEFAULT_MIN_FREE_GIB}
  --keep-workdir             Keep only the runner-owned native work directory

Contract:
  * compile-only; no serial port, upload, discovery probe or physical write;
  * CK normal production route (qualification=false) versus the same bundled
    Arduino CLI/config/jobs/complete FQBN/source bytes;
  * simple -> complex -> medium -> simple-return on one stable build path per lane;
  * exact output is rejected; fallback/buildMode is recorded, never hidden;
  * AVR HEX and Flash/RAM must match by stage; EEPROM may be absent in both
    lanes, but if emitted it must match by bytes and SHA-256;
  * simple-return restores the exact simple source bytes, required AVR
    artifacts and Flash/RAM independently inside both CK and native lanes;
  * exit 0 means evidence and the matrix performance target passed, not that a
    NativeRelink certificate was issued; exit 2 means valid but not fast enough;
  * --execute clears only each exact target's CK compile cache and removes the
    runner-owned temporary native directories unless --keep-workdir is given.
`;
}

function planFor(options) {
  const cells = options.targets.flatMap((target) => options.workloads.map((workload) => ({
    targetId: target.id,
    fqbn: target.fqbn,
    workloadId: workload.id,
    applicability: workloadApplicability(target, workload),
    stages: workload.stages.map((stage) => ({ id: stage.id, sourceSha256: sha256Bytes(stage.code) })),
    pairedCompiles: workloadApplicability(target, workload).applicable
      ? options.trials * STAGE_IDS.length * 2
      : 0,
  })));
  const applicableCellCount = cells.filter((cell) => cell.applicability.applicable).length;
  const expectedSkipCellCount = cells.length - applicableCellCount;
  return {
    schemaId: 'ck.avr.compile-regression-plan',
    schemaVersion: 1,
    compileOnly: true,
    uploadPerformed: false,
    serialPortAccessed: false,
    qualificationClaimed: false,
    targets: options.targets,
    workloads: options.workloads.map(({ stages, ...workload }) => ({
      ...workload,
      stages: stages.map((stage) => ({ id: stage.id, sourceSha256: sha256Bytes(stage.code) })),
    })),
    trials: options.trials,
    cellCount: cells.length,
    applicableCellCount,
    expectedSkipCellCount,
    totalCompileCount: cells.reduce((sum, cell) => sum + cell.pairedCompiles, 0),
    cells,
    performancePolicy: PERFORMANCE_POLICY,
    simpleReturnRestorationPolicy: SIMPLE_RETURN_RESTORATION_POLICY,
  };
}

function writeJsonNoClobber(outputPath, value) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (fs.existsSync(outputPath)) throw new Error(`refusing to overwrite ${outputPath}`);
  const temporary = `${outputPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.linkSync(temporary, outputPath);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function artifactSetSha256(artifacts) {
  return digestObject(artifacts.map(({ name, bytes, sha256, primaryApplication, role }) => ({
    name, bytes, sha256, primaryApplication, role,
  })));
}

function fallbackEvidence(buildMode, log) {
  const normalizedMode = String(buildMode || '').toLowerCase();
  const normalizedLog = String(log || '').toLowerCase();
  return {
    used: normalizedMode.includes('fallback') || normalizedLog.includes('falling back'),
    buildMode: buildMode || null,
    reasonLines: String(log || '').split(/\r?\n/u)
      .filter((line) => /\b(?:fallback|not eligible|no passing a\/b performance certificate)\b/iu.test(line))
      .slice(0, 12),
  };
}

async function waitForLaneIdleBoundary(
  lane,
  waitForIdle = waitForArduinoCliIdleWindow,
) {
  if (!['ck', 'native'].includes(lane)) throw new Error(`unsupported compile lane: ${lane}`);
  const idle = await waitForIdle({
    idleWindowMs: LANE_BOUNDARY_IDLE_POLICY.idleWindowMs,
    timeoutMs: LANE_BOUNDARY_IDLE_POLICY.timeoutMs,
    pollIntervalMs: LANE_BOUNDARY_IDLE_POLICY.pollIntervalMs,
    policyId: LANE_BOUNDARY_IDLE_POLICY.policyId,
    phaseLabel: `${lane} lane boundary`,
  });
  return { lane, ...idle };
}

function laneBoundaryIdleEvidencePassed(trial) {
  const expectedLanes = typeof trial?.order === 'string' ? trial.order.split('-') : [];
  if (expectedLanes.length !== 2
      || !expectedLanes.every((lane) => ['ck', 'native'].includes(lane))
      || new Set(expectedLanes).size !== 2
      || !Array.isArray(trial?.laneBoundaryIdle)
      || trial.laneBoundaryIdle.length !== expectedLanes.length) return false;
  return trial.laneBoundaryIdle.every((record, index) => (
    record?.lane === expectedLanes[index]
    && record.policyId === LANE_BOUNDARY_IDLE_POLICY.policyId
    && record.idleWindowMs === LANE_BOUNDARY_IDLE_POLICY.idleWindowMs
    && record.timeoutMs === LANE_BOUNDARY_IDLE_POLICY.timeoutMs
    && record.pollIntervalMs === LANE_BOUNDARY_IDLE_POLICY.pollIntervalMs
    && Number.isSafeInteger(record.waitedMs)
    && record.waitedMs >= LANE_BOUNDARY_IDLE_POLICY.idleWindowMs
    && record.waitedMs <= LANE_BOUNDARY_IDLE_POLICY.timeoutMs
    && Number.isSafeInteger(record.polls)
    && record.polls >= 1
  ));
}

async function clearCkCache(evaluate, fqbn, timeoutMs) {
  const result = await evaluate(`(async () => {
    try {
      const value = await window.__TAURI_INTERNALS__.invoke(
        'clear_board_first_project_compile_cache', { fqbn: ${JSON.stringify(fqbn)} }
      );
      return { ok: true, value };
    } catch (error) { return { ok: false, error: String(error) }; }
  })()`, timeoutMs);
  if (!result?.ok) throw new Error(`CK exact-target cache reset failed: ${result?.error || 'unknown error'}`);
  const validation = validateCacheClear(result.value, fqbn);
  if (!validation.passed) throw new Error(`CK cache-reset evidence failed: ${validation.failures.join('; ')}`);
  return result.value;
}

async function runCkCompile(evaluate, fqbn, code, phase, trialId, timeoutMs, expectedJobs) {
  const codeSha256 = sha256Bytes(code);
  const runId = crypto.randomUUID();
  const outerStart = process.hrtime.bigint();
  const result = await evaluate(`(async () => {
    const started = performance.now();
    try {
      const raw = await window.__TAURI_INTERNALS__.invoke('compile_sketch', {
        code: ${JSON.stringify(code)},
        fqbn: ${JSON.stringify(fqbn)},
        boardPackageId: null,
        runId: ${JSON.stringify(runId)},
        workspaceFingerprint: ${JSON.stringify(codeSha256)},
        sourceMapJson: null,
        // Explicit foreground compile: silent=true means Background to the
        // desktop backend and cannot consume a compile-only certificate.
        silent: false,
        qualification: false
      });
      return { ok: true, raw, pageWallMs: performance.now() - started };
    } catch (error) { return { ok: false, error: String(error), pageWallMs: performance.now() - started }; }
  })()`, timeoutMs);
  const outerNs = process.hrtime.bigint() - outerStart;
  if (!result?.ok) throw new Error(`CK ${phase} compile failed: ${result?.error || 'unknown error'}`);
  const parsed = JSON.parse(result.raw);
  const diagnostics = parsed.diagnostics || {};
  const compiler = validateCkCompilerEvidence(diagnostics, parsed.log, phase, expectedJobs);
  const artifacts = inspectCkArtifacts(parsed, nativeRelinkAdapterFor(fqbn));
  const resources = diagnostics.resources || {};
  if (resources.evidenceComplete !== true) throw new Error(`CK ${phase} resource evidence is incomplete`);
  const run = {
    trialId,
    phase,
    success: true,
    compileOnly: true,
    uploadPerformed: false,
    exactUsed: compiler.exactUsed,
    wallMs: Number(outerNs) / 1e6,
    rawTiming: {
      runnerWallNs: outerNs.toString(),
      pageWallMs: Number(result.pageWallMs),
      backend: diagnostics.timing || null,
    },
    buildMode: diagnostics.buildMode || null,
    fallback: fallbackEvidence(diagnostics.buildMode, parsed.log),
    profile: diagnostics.profile || null,
    route: diagnostics.engine || null,
    cache: {
      exactMatch: diagnostics.cache?.exactMatch === true,
      forcedRebuild: diagnostics.cache?.forcedRebuild === true,
      missReasons: Array.isArray(diagnostics.cache?.missReasons)
        ? diagnostics.cache.missReasons.slice(0, 16)
        : [],
      nativeRelinkDiagnostics: Array.isArray(diagnostics.cache?.nativeRelinkDiagnostics)
        ? diagnostics.cache.nativeRelinkDiagnostics.slice(0, 16)
        : [],
    },
    jobs: compiler.observedJobs,
    fqbn: diagnostics.fqbn || null,
    toolchainKey: diagnostics.environment?.toolchainKey || null,
    cliVersion: diagnostics.environment?.cliVersion || null,
    codeSha256,
    responseSha256: sha256Bytes(result.raw),
    resources: {
      evidenceComplete: true,
      flashUsedBytes: Number(resources.flashUsedBytes),
      ramUsedBytes: Number(resources.ramUsedBytes),
      warningCount: Number(resources.warningCount),
    },
    artifacts,
    artifactSetSha256: artifactSetSha256(artifacts),
  };
  run.evidenceSha256 = digestObject({ ...run, wallMs: undefined });
  return run;
}

function stageSummary(trials, stageId) {
  const ck = trials.map((trial) => trial.ck[stageId].wallMs);
  const native = trials.map((trial) => trial.native[stageId].wallMs);
  const ckMedianMs = median(ck);
  const nativeMedianMs = median(native);
  const medianGainMs = nativeMedianMs - ckMedianMs;
  const speedupPct = nativeMedianMs > 0 ? (medianGainMs / nativeMedianMs) * 100 : null;
  const ckP95Ms = percentileNearestRank(ck, 95);
  const nativeP95Ms = percentileNearestRank(native, 95);
  const performancePassed = EDIT_STAGE_IDS.includes(stageId)
    ? speedupPct >= PERFORMANCE_POLICY.minimumMedianSpeedupPct
      && medianGainMs >= PERFORMANCE_POLICY.minimumAbsoluteMedianGainMs
      && ckP95Ms <= nativeP95Ms
    : null;
  return {
    ckRawMs: ck,
    nativeRawMs: native,
    ckMedianMs,
    nativeMedianMs,
    medianGainMs,
    ckSpeedupPctVsNative: speedupPct,
    ckP95Ms,
    nativeP95Ms,
    performancePassed,
    ckBuildModes: [...new Set(trials.map((trial) => trial.ck[stageId].buildMode))],
    ckFallbackCount: trials.filter((trial) => trial.ck[stageId].fallback.used).length,
  };
}

function warningCountObservation(resources) {
  const value = Number(resources?.warningCount);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function compareSimpleReturnLane(simple, restored) {
  const simpleWarningCount = warningCountObservation(simple?.resources);
  const restoredWarningCount = warningCountObservation(restored?.resources);
  const source = {
    simpleSha256: typeof simple?.codeSha256 === 'string' ? simple.codeSha256 : null,
    restoredSha256: typeof restored?.codeSha256 === 'string' ? restored.codeSha256 : null,
    passed: typeof simple?.codeSha256 === 'string'
      && simple.codeSha256.length > 0
      && simple.codeSha256 === restored?.codeSha256,
  };
  const resources = {
    simple: simple?.resources || null,
    restored: restored?.resources || null,
    passed: resourcesEquivalent(simple?.resources, restored?.resources),
  };
  const artifacts = compareAvrArtifactRoles(simple?.artifacts, restored?.artifacts);
  const warningCount = {
    simple: simpleWarningCount,
    restored: restoredWarningCount,
    comparable: simpleWarningCount != null && restoredWarningCount != null,
    match: simpleWarningCount != null && restoredWarningCount != null
      ? simpleWarningCount === restoredWarningCount
      : null,
    gateRequired: false,
  };
  return {
    source,
    resources,
    artifacts,
    warningCount,
    passed: source.passed && resources.passed && artifacts.passed,
  };
}

function evaluateSimpleReturnRestoration(trial) {
  const ck = compareSimpleReturnLane(trial?.ck?.simple, trial?.ck?.['simple-return']);
  const native = compareSimpleReturnLane(trial?.native?.simple, trial?.native?.['simple-return']);
  return {
    policy: SIMPLE_RETURN_RESTORATION_POLICY,
    ck,
    native,
    passed: ck.passed && native.passed,
  };
}

function evaluateCell(cell) {
  const allEquivalent = cell.trials.every((trial) => STAGE_IDS.every((stageId) => (
    trial.equivalence[stageId].source
    && trial.equivalence[stageId].resources
    && trial.equivalence[stageId].artifacts.passed
  )));
  const noExact = cell.trials.every((trial) => STAGE_IDS.every(
    (stageId) => trial.ck[stageId].exactUsed === false,
  ));
  const laneBoundaryIdlePassed = cell.trials.every(laneBoundaryIdleEvidencePassed);
  const simpleReturnRestorationPassed = cell.trials.every(
    (trial) => trial.simpleReturnRestoration?.passed === true,
  );
  const nativeRelinkRoutePassed = cell.trials.every((trial) => {
    const simpleDiagnostics = trial.ck.simple.cache.nativeRelinkDiagnostics;
    const baselineCommitted = simpleDiagnostics.some((line) => (
      line.includes('NativeRelink AVR Release baseline committed (authorization=certified)')
    ));
    const allStagesCertified = STAGE_IDS.every((stageId) => (
      trial.ck[stageId].cache.nativeRelinkDiagnostics.some((line) => (
        line.includes('NativeRelinkCompileOnly certificate matched')
      ))
    ));
    const editsUsedNativeRelink = EDIT_STAGE_IDS.every((stageId) => (
      trial.ck[stageId].buildMode === 'native-relink-compile-only'
      && trial.ck[stageId].fallback.used === false
      && trial.ck[stageId].cache.nativeRelinkDiagnostics.some((line) => (
        line.includes('NativeRelinkCompileOnly path:')
      ))
    ));
    return baselineCommitted && allStagesCertified && editsUsedNativeRelink;
  });
  const summaries = Object.fromEntries(STAGE_IDS.map((stageId) => [
    stageId,
    stageSummary(cell.trials, stageId),
  ]));
  const performancePassed = EDIT_STAGE_IDS.every(
    (stageId) => summaries[stageId].performancePassed === true,
  );
  return {
    measurementPassed: allEquivalent && noExact && laneBoundaryIdlePassed
      && simpleReturnRestorationPassed && nativeRelinkRoutePassed && cell.failures.length === 0,
    artifactAndResourceEquivalent: allEquivalent && simpleReturnRestorationPassed,
    stageByStageArtifactAndResourceEquivalent: allEquivalent,
    simpleReturnRestorationEquivalent: simpleReturnRestorationPassed,
    noExactCompilerBypass: noExact,
    laneBoundaryIdlePassed,
    nativeRelinkRoutePassed,
    stages: summaries,
    performanceTarget: {
      policy: PERFORMANCE_POLICY,
      status: performancePassed ? 'target-met' : 'target-not-met',
      passed: performancePassed,
      qualificationClaimed: false,
      note: 'This heterogeneous regression matrix is not a NativeRelink certificate.',
    },
  };
}

function safeCellPath(root, ...segments) {
  const candidate = path.join(root, ...segments.map((segment) => String(segment).replace(/[^a-z0-9_-]+/giu, '_')));
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('cell path escaped work root');
  fs.mkdirSync(candidate, { recursive: true });
  return candidate;
}

async function execute(options) {
  if (!AVR_WORKLOADS.every(validateWorkload)) throw new Error('AVR workload source contract failed');
  const plan = planFor(options);
  const timeoutMs = options.timeoutMinutes * 60_000;
  const jobs = effectiveJobs();
  const runToken = crypto.randomBytes(8).toString('hex');
  const workParent = path.join(os.tmpdir(), 'CKAB');
  fs.mkdirSync(workParent, { recursive: true });
  const workRoot = path.join(workParent, runToken);
  fs.mkdirSync(workRoot, { recursive: false });
  const productionBefore = inspectProductionExecutable();
  const report = {
    schemaId: 'ck.avr.compile-regression-report',
    schemaVersion: 1,
    status: 'running',
    measurementStatus: 'running',
    performanceTargetStatus: 'not-evaluated',
    qualificationClaimed: false,
    startedAt: new Date().toISOString(),
    controls: {
      compileOnly: true,
      uploadPerformed: false,
      physicalFlashWritten: false,
      serialPortAccessed: false,
      ckQualificationMode: false,
      exactAllowed: false,
      sameBundledCli: true,
      sameCliConfig: true,
      sameCompleteFqbn: true,
      sameSourceBytesPerStage: true,
      simpleReturnRestorationPolicy: SIMPLE_RETURN_RESTORATION_POLICY,
      sameJobs: true,
      sequentialNoConcurrentCompiles: true,
      laneBoundaryIdlePolicy: LANE_BOUNDARY_IDLE_POLICY,
      performancePolicy: PERFORMANCE_POLICY,
    },
    planSha256: digestObject(plan),
    trialsPerCell: options.trials,
    plannedCellCount: plan.cellCount,
    applicableCellCount: plan.applicableCellCount,
    expectedSkipCellCount: plan.expectedSkipCellCount,
    plannedCompileCount: plan.totalCompileCount,
    targets: [],
    cells: [],
    failures: [],
    startupStability: null,
    productionExecutable: { before: productionBefore, after: null, unchanged: null },
    disk: {
      minimumFreeGiB: options.minFreeGiB,
      freeBytesBefore: assertFreeSpace(workRoot, options.minFreeGiB),
      freeBytesAfterCapture: null,
      freeBytesAfterCleanup: null,
      cleanup: null,
    },
  };
  let cdp;
  const attemptedFqbns = new Set();
  try {
    report.startupStability = await waitForArduinoCliIdleWindow();
    const target = await getCdpTarget();
    cdp = createCdp(target.webSocketDebuggerUrl);
    const preflight = await cdp.evaluate(`(async () => ({
      invokeAvailable: typeof window.__TAURI_INTERNALS__?.invoke === 'function',
      url: location.href,
      compileSettings: await window.__TAURI_INTERNALS__.invoke('get_compile_accel_settings')
    }))()`, cdpPreflightTimeoutMs(timeoutMs));
    if (!preflight?.invokeAvailable) throw new Error('production page has no Tauri invoke bridge');
    const backendMaxJobs = Number(preflight.compileSettings?.max_jobs) || 0;
    if (backendMaxJobs > 0 && backendMaxJobs !== jobs
        && !(backendMaxJobs === 8 && jobs > 8 && !/^(?:1|true|yes|on)$/iu.test(String(process.env.CK_RESPECT_MAX_JOBS || '')))) {
      throw new Error(`production jobs=${backendMaxJobs} do not bind runner jobs=${jobs}`);
    }
    report.compileSettingsSha256 = digestObject(preflight.compileSettings);

    let applicableCellOrdinal = 0;
    for (const targetSpec of options.targets) {
      assertFreeSpace(workRoot, options.minFreeGiB);
      let identity;
      try {
        identity = inspectCliAndCore(targetSpec.fqbn);
        if (String(identity.coreArchitecture).toLowerCase() !== 'avr') {
          throw new Error(`resolved architecture is ${identity.coreArchitecture}, expected avr`);
        }
        report.targets.push({ ...targetSpec, identity, status: 'ready' });
      } catch (error) {
        report.targets.push({ ...targetSpec, status: 'failed', failure: String(error?.stack || error) });
        report.failures.push(`${targetSpec.id}: target preflight failed`);
        continue;
      }
      for (const workload of options.workloads) {
        const applicability = workloadApplicability(targetSpec, workload);
        const cell = {
          id: `${targetSpec.id}__${workload.id}`,
          targetId: targetSpec.id,
          fqbn: targetSpec.fqbn,
          workloadId: workload.id,
          workloadLabel: workload.label,
          applicability,
          sourceSequence: workload.stages.map((stage) => ({
            id: stage.id,
            sha256: sha256Bytes(stage.code),
            bytes: Buffer.byteLength(stage.code, 'utf8'),
          })),
          trials: [],
          failures: [],
          result: null,
        };
        if (!applicability.applicable) {
          cell.result = {
            measurementPassed: true,
            measurementStatus: 'expected-skip',
            artifactAndResourceEquivalent: null,
            stageByStageArtifactAndResourceEquivalent: null,
            simpleReturnRestorationEquivalent: null,
            noExactCompilerBypass: null,
            stages: {},
            performanceTarget: {
              policy: PERFORMANCE_POLICY,
              status: 'not-applicable',
              passed: null,
              qualificationClaimed: false,
            },
          };
          report.cells.push(cell);
          process.stdout.write(`${cell.id}: expected-skip (${applicability.reason})\n`);
          continue;
        }
        attemptedFqbns.add(targetSpec.fqbn);
        for (let trialIndex = 0; trialIndex < options.trials; trialIndex += 1) {
          assertFreeSpace(workRoot, options.minFreeGiB);
          const trialId = `trial-${String(trialIndex + 1).padStart(3, '0')}`;
          const order = (applicableCellOrdinal + trialIndex) % 2 === 0 ? ['ck', 'native'] : ['native', 'ck'];
          const trial = {
            id: trialId,
            order: order.join('-'),
            cacheReset: null,
            ck: {},
            native: {},
            equivalence: {},
            laneBoundaryIdle: [],
          };
          const nativeRoot = safeCellPath(workRoot, 'cells', targetSpec.id, workload.id, trialId);
          // Coverage compares the certified production route against the
          // Core's unmodified Release recipes: an empty compiler baseline.
          const nativeContext = createNativeTrial(
            nativeRoot,
            trialId,
            targetSpec.fqbn,
            jobs,
            workload.stages[0].code,
            nativeBaselineContract(null),
          );
          try {
            for (const lane of order) {
              assertNoConcurrentArduinoCli();
              if (lane === 'ck') {
                trial.cacheReset = await clearCkCache(cdp.evaluate, targetSpec.fqbn, timeoutMs);
                for (const stage of workload.stages) {
                  trial.ck[stage.id] = await runCkCompile(
                    cdp.evaluate,
                    targetSpec.fqbn,
                    stage.code,
                    stage.id,
                    trialId,
                    timeoutMs,
                    jobs,
                  );
                }
              } else {
                for (const stage of workload.stages) {
                  updateNativeTrialSource(nativeContext, stage.code);
                  trial.native[stage.id] = await runNativeCompile(
                    nativeContext,
                    stage.id,
                    trialId,
                    timeoutMs,
                  );
                }
              }
              trial.laneBoundaryIdle.push(await waitForLaneIdleBoundary(lane));
            }
            for (const stage of workload.stages) {
              const ck = trial.ck[stage.id];
              const native = trial.native[stage.id];
              trial.equivalence[stage.id] = {
                source: ck.codeSha256 === native.codeSha256 && ck.codeSha256 === sha256Bytes(stage.code),
                resources: resourcesEquivalent(ck.resources, native.resources),
                artifacts: compareAvrArtifactRoles(ck.artifacts, native.artifacts),
              };
            }
            trial.simpleReturnRestoration = evaluateSimpleReturnRestoration(trial);
            cell.trials.push(trial);
            process.stdout.write(`${cell.id} ${trialId} ${trial.order}: ${STAGE_IDS.map((stageId) => (
              `${stageId} CK ${trial.ck[stageId].wallMs.toFixed(0)}ms/${trial.ck[stageId].buildMode} vs CLI ${trial.native[stageId].wallMs.toFixed(0)}ms`
            )).join('; ')}\n`);
          } catch (error) {
            cell.failures.push(`${trialId}: ${String(error?.stack || error)}`);
            break;
          } finally {
            try {
              await clearCkCache(cdp.evaluate, targetSpec.fqbn, timeoutMs);
            } catch (error) {
              cell.failures.push(`${trialId} cleanup: ${String(error?.message || error)}`);
            }
          }
        }
        cell.result = cell.trials.length === options.trials
          ? evaluateCell(cell)
          : {
            measurementPassed: false,
            performanceTarget: {
              policy: PERFORMANCE_POLICY,
              status: 'not-evaluated',
              passed: false,
              qualificationClaimed: false,
            },
          };
        if (!cell.result.measurementPassed) report.failures.push(`${cell.id}: measurement failed`);
        report.cells.push(cell);
        applicableCellOrdinal += 1;
      }
    }
  } catch (error) {
    report.failures.push(String(error?.stack || error));
  } finally {
    if (cdp) {
      for (const fqbn of attemptedFqbns) {
        try { await clearCkCache(cdp.evaluate, fqbn, timeoutMs); } catch (error) {
          report.failures.push(`final CK cache cleanup ${fqbn}: ${String(error?.message || error)}`);
        }
      }
    }
    cdp?.socket.close();
    report.finishedAt = new Date().toISOString();
    try {
      const productionAfter = inspectProductionExecutable();
      report.productionExecutable.after = productionAfter;
      report.productionExecutable.unchanged = digestObject(productionBefore) === digestObject(productionAfter);
      if (!report.productionExecutable.unchanged) report.failures.push('production executable/process changed during matrix');
    } catch (error) {
      report.failures.push(`production identity finalization failed: ${String(error?.message || error)}`);
    }
    try {
      report.disk.freeBytesAfterCapture = assertFreeSpace(workRoot, options.minFreeGiB);
      report.disk.cleanup = inspectOwnedWorkdir(workRoot);
      if (!options.keepWorkdir) {
        safeRemoveWorkdir(workRoot);
        if (fs.existsSync(workRoot)) throw new Error('owned matrix work directory remains after cleanup');
        report.disk.cleanup.removed = true;
        report.disk.cleanup.removedPaths = ['<TEMP>/CKAB/<run-token>'];
      } else {
        report.disk.cleanup.removed = false;
        report.disk.cleanup.removedPaths = [];
      }
      report.disk.freeBytesAfterCleanup = assertFreeSpace(workParent, options.minFreeGiB);
    } catch (error) {
      report.failures.push(`workdir cleanup failed: ${String(error?.message || error)}`);
    }
    report.measurementStatus = report.failures.length === 0
      && report.cells.length === plan.cellCount
      && report.cells.every((cell) => cell.result?.measurementPassed === true)
      ? 'passed'
      : 'failed';
    const applicableCells = report.cells.filter((cell) => cell.applicability?.applicable === true);
    report.performanceTargetStatus = report.measurementStatus !== 'passed'
      ? 'not-evaluated'
      : applicableCells.length === 0
        ? 'not-applicable'
        : applicableCells.every((cell) => cell.result?.performanceTarget?.passed === true)
          ? 'target-met'
          : 'target-not-met';
    report.status = report.measurementStatus;
    report.qualificationClaimed = false;
    writeJsonNoClobber(options.outputPath, report);
    process.stdout.write(`REPORT ${options.outputPath}\n`);
  }
  if (report.measurementStatus !== 'passed') process.exitCode = 1;
  else if (report.performanceTargetStatus === 'target-not-met') process.exitCode = 2;
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (options.action === 'plan') {
    process.stdout.write(`${JSON.stringify(planFor(options), null, 2)}\nNo compile was started.\n`);
    return;
  }
  await execute(options);
}

module.exports = {
  AVR_TARGETS,
  AVR_WORKLOADS,
  EDIT_STAGE_IDS,
  LANE_BOUNDARY_IDLE_POLICY,
  PERFORMANCE_POLICY,
  SIMPLE_RETURN_RESTORATION_POLICY,
  STAGE_IDS,
  evaluateCell,
  evaluateSimpleReturnRestoration,
  parseArgs,
  planFor,
  sha256Bytes,
  stageSummary,
  laneBoundaryIdleEvidencePassed,
  validateWorkload,
  workloadApplicability,
  waitForLaneIdleBoundary,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
