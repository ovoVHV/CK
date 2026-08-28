import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { validateImportablePackage } from './Validate-ImportablePackage.mjs';

const root = process.cwd();
const catalogRoot = path.join(root, 'artifacts', 'tmp', 'ck_hardware_catalog');
const outputRoot = path.join(root, 'packages', 'block-libraries');
const indexPath = path.join(outputRoot, 'CK-HARDWARE-LIBRARIES.md');
const version = '0.1.0';

// Remove retired combined-package outputs so they cannot be mistaken for the
// independent distribution. All paths are fixed children of this workspace.
fs.rmSync(path.join(outputRoot, 'ck_common_hardware_pack'), { recursive: true, force: true });
for (const retired of [
  'ck_common_hardware_pack-0.1.4-ckpkg.zip',
  'ck_common_hardware_pack-0.1.4.zip',
  'ck_common_hardware_pack-0.1.5.zip',
  'ck_common_hardware_pack-0.1.6.zip',
]) fs.rmSync(path.join(root, 'artifacts', 'packages', retired), { force: true });

const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
const ensure = directory => fs.mkdirSync(directory, { recursive: true });

fs.rmSync(catalogRoot, { recursive: true, force: true });
const catalogResult = spawnSync(process.execPath, [path.join(root, 'scripts', 'Build-CommonHardwarePack.mjs')], {
  cwd: root,
  env: { ...process.env, CK_HARDWARE_CATALOG_OUTPUT: catalogRoot },
  encoding: 'utf8',
});
if (catalogResult.status !== 0) {
  process.stderr.write(catalogResult.stdout || '');
  process.stderr.write(catalogResult.stderr || '');
  process.exit(catalogResult.status || 1);
}

const manifest = json(path.join(catalogRoot, 'ck-blocks.json'));
const definitions = json(path.join(catalogRoot, 'blocks', 'blocks.json'));
const generator = json(path.join(catalogRoot, 'blocks', 'ck-generator.json'));
const license = fs.readFileSync(path.join(catalogRoot, 'LICENSE'), 'utf8');
const definitionByType = new Map(definitions.map(item => [item.type, item]));

const wirePrelude = (header, prefix) => `#include "${header}"
#include <math.h>

static bool ${prefix}WireReady = false;
static void ${prefix}WireBeginOnce() { if (!${prefix}WireReady) { Wire.begin(); ${prefix}WireReady = true; } }
static void ${prefix}Write8(uint8_t address, uint8_t reg, uint8_t value) { ${prefix}WireBeginOnce(); Wire.beginTransmission(address); Wire.write(reg); Wire.write(value); Wire.endTransmission(); }
static int16_t ${prefix}Read16(uint8_t address, uint8_t reg, bool littleEndian = false) { ${prefix}WireBeginOnce(); Wire.beginTransmission(address); Wire.write(reg); if (Wire.endTransmission(false) != 0) return 0; if (Wire.requestFrom(address, (uint8_t)2) != 2) return 0; uint8_t a = Wire.read(), b = Wire.read(); return littleEndian ? (int16_t)((b << 8) | a) : (int16_t)((a << 8) | b); }
`;

const native = {
  adxl345: {
    header: 'CKAdxl345.h', replace: { ckCommonAdxl345Read: 'ckAdxl345Read' },
    declaration: 'float ckAdxl345Read(uint8_t axis);',
    source: header => `${wirePrelude(header, 'ckAdxl345')}\nfloat ckAdxl345Read(uint8_t axis) { static bool ready = false; if (!ready) { ckAdxl345Write8(0x53, 0x2D, 0x08); ready = true; } return ckAdxl345Read16(0x53, 0x32 + (axis % 3) * 2, true) * 0.0392266f; }\n`,
  },
  qmc5883l: {
    header: 'CKQmc5883l.h', replace: { ckCommonQmc5883Read: 'ckQmc5883lRead' },
    declaration: 'float ckQmc5883lRead(uint8_t axis);',
    source: header => `${wirePrelude(header, 'ckQmc5883l')}\nfloat ckQmc5883lRead(uint8_t axis) { static bool ready = false; if (!ready) { ckQmc5883lWrite8(0x0D, 0x0B, 0x01); ckQmc5883lWrite8(0x0D, 0x09, 0x1D); ready = true; } return (float)ckQmc5883lRead16(0x0D, (axis % 3) * 2, true); }\n`,
  },
  bh1750: {
    header: 'CKBh1750.h', replace: { ckCommonBh1750Lux: 'ckBh1750Lux' },
    declaration: 'float ckBh1750Lux();',
    source: header => `${wirePrelude(header, 'ckBh1750')}\nfloat ckBh1750Lux() { ckBh1750WireBeginOnce(); Wire.beginTransmission(0x23); Wire.write(0x10); Wire.endTransmission(); delay(180); if (Wire.requestFrom((uint8_t)0x23, (uint8_t)2) != 2) return NAN; return ((Wire.read() << 8) | Wire.read()) / 1.2f; }\n`,
  },
  aht20: {
    header: 'CKAht20.h', replace: { ckCommonAht20Read: 'ckAht20Read' },
    declaration: 'float ckAht20Read(uint8_t item);',
    source: header => `${wirePrelude(header, 'ckAht20')}\nfloat ckAht20Read(uint8_t item) { ckAht20WireBeginOnce(); Wire.beginTransmission(0x38); Wire.write(0xAC); Wire.write(0x33); Wire.write(0x00); Wire.endTransmission(); delay(85); if (Wire.requestFrom((uint8_t)0x38, (uint8_t)6) != 6) return NAN; uint8_t d[6]; for (uint8_t i = 0; i < 6; ++i) d[i] = Wire.read(); uint32_t rh = ((uint32_t)(d[1] & 0x0F) << 16) | ((uint32_t)d[2] << 8) | d[3]; uint32_t rt = ((uint32_t)(d[3] & 0x0F) << 16) | ((uint32_t)d[4] << 8) | d[5]; return item ? rh * 100.0f / 1048576.0f : rt * 200.0f / 1048576.0f - 50.0f; }\n`,
  },
  sht20: {
    header: 'CKSht20.h', replace: { ckCommonSht20Read: 'ckSht20Read' },
    declaration: 'float ckSht20Read(uint8_t item);',
    source: header => `${wirePrelude(header, 'ckSht20')}\nfloat ckSht20Read(uint8_t item) { ckSht20WireBeginOnce(); Wire.beginTransmission(0x40); Wire.write(item ? 0xF5 : 0xF3); Wire.endTransmission(); delay(item ? 30 : 90); if (Wire.requestFrom((uint8_t)0x40, (uint8_t)2) != 2) return NAN; uint16_t raw = (Wire.read() << 8) | Wire.read(); raw &= 0xFFFC; return item ? -6.0f + 125.0f * raw / 65536.0f : -46.85f + 175.72f * raw / 65536.0f; }\n`,
  },
  ads1115: {
    header: 'CKAds1115.h', replace: { ckCommonAds1115Read: 'ckAds1115Read' },
    declaration: 'int16_t ckAds1115Read(uint8_t channel);',
    source: header => `${wirePrelude(header, 'ckAds1115')}\nint16_t ckAds1115Read(uint8_t channel) { ckAds1115WireBeginOnce(); uint16_t config = 0xC183 | ((channel & 3) << 12); Wire.beginTransmission(0x48); Wire.write(0x01); Wire.write(config >> 8); Wire.write(config); Wire.endTransmission(); delay(9); return ckAds1115Read16(0x48, 0x00); }\n`,
  },
  ina219: {
    header: 'CKIna219.h', replace: { ckCommonIna219Read: 'ckIna219Read' },
    declaration: 'float ckIna219Read(uint8_t item);',
    source: header => `${wirePrelude(header, 'ckIna219')}\nfloat ckIna219Read(uint8_t item) { if (item == 0) return ((uint16_t)ckIna219Read16(0x40, 0x02) >> 3) * 0.004f; return ckIna219Read16(0x40, 0x04) * 0.1f; }\n`,
  },
  ds3231: {
    header: 'CKDs3231.h', replace: { ckCommonDs3231Read: 'ckDs3231Read' },
    declaration: 'int16_t ckDs3231Read(uint8_t item);',
    source: header => `${wirePrelude(header, 'ckDs3231')}\nint16_t ckDs3231Read(uint8_t item) { static const uint8_t regs[] = {0x06, 0x05, 0x04, 0x02, 0x01, 0x00}; uint8_t v = (uint8_t)(ckDs3231Read16(0x68, regs[item % 6]) >> 8); return (v >> 4) * 10 + (v & 0x0F); }\n`,
  },
  pcf8574: {
    header: 'CKPcf8574.h', replace: { ckCommonPcf8574Write: 'ckPcf8574Write' },
    declaration: 'void ckPcf8574Write(uint8_t address, uint8_t pin, uint8_t level);',
    source: header => `${wirePrelude(header, 'ckPcf8574')}\nvoid ckPcf8574Write(uint8_t address, uint8_t pin, uint8_t level) { static uint8_t state = 0xFF; if (level) state |= (1U << (pin & 7)); else state &= ~(1U << (pin & 7)); ckPcf8574WireBeginOnce(); Wire.beginTransmission(address); Wire.write(state); Wire.endTransmission(); }\n`,
  },
  mpu6050: {
    header: 'CKMpu6050.h', replace: { ckCommonMpu6050Begin: 'ckMpu6050Begin', ckCommonMpu6050Read: 'ckMpu6050Read' },
    declaration: 'bool ckMpu6050Begin(uint8_t address = 0x68);\nfloat ckMpu6050Read(uint8_t item, uint8_t address = 0x68);',
    source: header => `#include "${header}"
#include <math.h>

static bool ckMpu6050WireReady = false;
static bool ckMpu6050Ready = false;
static uint8_t ckMpu6050Address = 0x68;
static unsigned long ckMpu6050LastMicros = 0;
static float ckMpu6050Values[10] = {0};
static void ckMpu6050WireBeginOnce() { if (!ckMpu6050WireReady) { Wire.begin(); ckMpu6050WireReady = true; } }
static bool ckMpu6050Write8(uint8_t address, uint8_t reg, uint8_t value) { ckMpu6050WireBeginOnce(); Wire.beginTransmission(address); Wire.write(reg); Wire.write(value); return Wire.endTransmission() == 0; }

bool ckMpu6050Begin(uint8_t address) {
  ckMpu6050WireBeginOnce();
  ckMpu6050Address = address;
  if (!ckMpu6050Write8(address, 0x6B, 0x00)) { ckMpu6050Ready = false; return false; }
  ckMpu6050Write8(address, 0x1A, 0x03);
  ckMpu6050Write8(address, 0x1B, 0x00);
  ckMpu6050Write8(address, 0x1C, 0x00);
  ckMpu6050LastMicros = micros();
  ckMpu6050Ready = true;
  return true;
}

static bool ckMpu6050Update(uint8_t address) {
  if (!ckMpu6050Ready || ckMpu6050Address != address) if (!ckMpu6050Begin(address)) return false;
  Wire.beginTransmission(address); Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0 || Wire.requestFrom(address, (uint8_t)14) != 14) return false;
  int16_t raw[7];
  for (uint8_t i = 0; i < 7; ++i) raw[i] = (int16_t)((Wire.read() << 8) | Wire.read());
  float ax = raw[0] / 16384.0f, ay = raw[1] / 16384.0f, az = raw[2] / 16384.0f;
  float gx = raw[4] / 131.0f, gy = raw[5] / 131.0f, gz = raw[6] / 131.0f;
  unsigned long now = micros(); float dt = (now - ckMpu6050LastMicros) * 0.000001f; ckMpu6050LastMicros = now;
  if (dt <= 0.0f || dt > 0.25f) dt = 0.01f;
  float rollAcc = atan2f(ay, az) * 57.2957795f;
  float pitchAcc = atan2f(-ax, sqrtf(ay * ay + az * az)) * 57.2957795f;
  ckMpu6050Values[0] = ax; ckMpu6050Values[1] = ay; ckMpu6050Values[2] = az;
  ckMpu6050Values[3] = gx; ckMpu6050Values[4] = gy; ckMpu6050Values[5] = gz;
  ckMpu6050Values[6] = 0.98f * (ckMpu6050Values[6] + gx * dt) + 0.02f * rollAcc;
  ckMpu6050Values[7] = 0.98f * (ckMpu6050Values[7] + gy * dt) + 0.02f * pitchAcc;
  ckMpu6050Values[8] += gz * dt;
  ckMpu6050Values[9] = raw[3] / 340.0f + 36.53f;
  return true;
}

float ckMpu6050Read(uint8_t item, uint8_t address) { if (!ckMpu6050Update(address)) return NAN; return ckMpu6050Values[item < 10 ? item : 9]; }
`,
  },
  hc_sr04: {
    header: 'CKHcSr04.h', replace: { ckCommonUltrasonicCm: 'ckHcSr04DistanceCm' },
    declaration: 'float ckHcSr04DistanceCm(uint8_t trig, uint8_t echo);',
    source: header => `#include "${header}"\n\nfloat ckHcSr04DistanceCm(uint8_t trig, uint8_t echo) { pinMode(trig, OUTPUT); pinMode(echo, INPUT); digitalWrite(trig, LOW); delayMicroseconds(2); digitalWrite(trig, HIGH); delayMicroseconds(10); digitalWrite(trig, LOW); unsigned long us = pulseIn(echo, HIGH, 30000UL); return us ? us * 0.0343f * 0.5f : -1.0f; }\n`,
  },
  jsn_sr04t: {
    header: 'CKJsnSr04t.h', replace: { ckCommonUltrasonicCm: 'ckJsnSr04tDistanceCm' },
    declaration: 'float ckJsnSr04tDistanceCm(uint8_t trig, uint8_t echo);',
    source: header => `#include "${header}"\n\nfloat ckJsnSr04tDistanceCm(uint8_t trig, uint8_t echo) { pinMode(trig, OUTPUT); pinMode(echo, INPUT); digitalWrite(trig, LOW); delayMicroseconds(2); digitalWrite(trig, HIGH); delayMicroseconds(10); digitalWrite(trig, LOW); unsigned long us = pulseIn(echo, HIGH, 40000UL); return us ? us * 0.0343f * 0.5f : -1.0f; }\n`,
  },
  rotary_encoder: {
    header: 'CKRotaryEncoder.h', replace: { ckCommonEncoderDelta: 'ckRotaryEncoderDelta' },
    declaration: 'int8_t ckRotaryEncoderDelta(uint8_t pinA, uint8_t pinB);',
    source: header => `#include "${header}"\n\nint8_t ckRotaryEncoderDelta(uint8_t pinA, uint8_t pinB) { static uint8_t previous = 0; pinMode(pinA, INPUT_PULLUP); pinMode(pinB, INPUT_PULLUP); uint8_t current = (digitalRead(pinA) << 1) | digitalRead(pinB); uint8_t transition = (previous << 2) | current; previous = current; if (transition == 0x1 || transition == 0x7 || transition == 0xE || transition == 0x8) return 1; if (transition == 0x2 || transition == 0xB || transition == 0xD || transition == 0x4) return -1; return 0; }\n`,
  },
};

function replaceDeep(value, replacements) {
  if (typeof value === 'string') {
    let result = value;
    for (const [from, to] of Object.entries(replacements)) result = result.replaceAll(from, to);
    return result;
  }
  if (Array.isArray(value)) return value.map(item => replaceDeep(item, replacements));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceDeep(item, replacements)]));
  return value;
}

function externalDependencies(block) {
  return [...new Set((block.dependencies || [])
    .filter(dep => dep.kind === 'arduino-library')
    .map(dep => dep.id))];
}

const grouped = new Map();
for (const block of manifest.blocks) {
  const moduleId = block.keywords?.[1];
  if (!moduleId) throw new Error(`block ${block.type} has no module id in keywords[1]`);
  if (!grouped.has(moduleId)) grouped.set(moduleId, []);
  grouped.get(moduleId).push(block);
}

const rows = [];
const failures = [];
for (const [moduleId, rawBlocks] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  const packageId = `ck_hw_${moduleId}`;
  const packageRoot = path.join(outputRoot, packageId);
  const blocksRoot = path.join(packageRoot, 'blocks');
  const nativeSpec = native[moduleId];
  const moduleName = rawBlocks[0].keywords[0];
  const replacements = nativeSpec
    ? { 'CKCommonHardware.h': nativeSpec.header, ...nativeSpec.replace }
    : {};
  const blocks = rawBlocks.map(block => {
    const transformed = replaceDeep(block, replacements);
    if (nativeSpec) {
      transformed.dependencies = transformed.dependencies.map(dep => dep.id === nativeSpec.header
        ? { ...dep, reason: `${moduleName} 独立库内置驱动；不依赖公共硬件总库或 Adafruit。` }
        : dep);
    }
    return transformed;
  });
  const types = new Set(blocks.map(block => block.type));
  const packageDefinitions = definitions.filter(item => types.has(item.type));
  const packageRules = generator.rules.filter(item => types.has(item.type)).map(item => replaceDeep(item, replacements));
  const deps = [...new Set(blocks.flatMap(externalDependencies))];
  const category = blocks[0].category;
  const colour = definitionByType.get(blocks[0].type)?.colour ?? 160;

  fs.rmSync(packageRoot, { recursive: true, force: true });
  ensure(blocksRoot);
  if (nativeSpec) ensure(path.join(packageRoot, 'src'));

  const libraryJson = {
    id: packageId,
    name: `CK ${moduleName}积木库`,
    version,
    description: `${moduleName}独立 CK 积木库；可独立导入、删除和升级。`,
    author: 'CK Project',
    license: 'MIT',
    architectures: ['*'],
    ...(nativeSpec ? { includes: [nativeSpec.header] } : {}),
    ...(deps.length ? { dependencies: deps } : {}),
  };
  const packageManifest = {
    ...manifest,
    id: packageId,
    display_name: `CK ${moduleName}积木库`,
    description: `${moduleName}独立声明式积木库；不依赖任何公共硬件总库。`,
    keywords: [...new Set([moduleId, moduleName, 'independent-hardware-library', 'no-adafruit'])],
    dependencies: [],
    blocks,
  };

  writeJson(path.join(packageRoot, 'library.json'), libraryJson);
  writeJson(path.join(packageRoot, 'ck-blocks.json'), packageManifest);
  writeJson(path.join(blocksRoot, 'blocks.json'), packageDefinitions);
  writeJson(path.join(blocksRoot, 'ck-generator.json'), { schema: generator.schema, version: generator.version, rules: packageRules });
  writeJson(path.join(blocksRoot, 'toolbox.json'), [{
    kind: 'category', name: category, colour,
    contents: blocks.map(block => ({ kind: 'block', type: block.type })),
  }]);
  fs.writeFileSync(path.join(packageRoot, 'LICENSE'), license, 'utf8');

  if (nativeSpec) {
    const header = `#pragma once\n#include <Arduino.h>\n${['adxl345', 'qmc5883l', 'bh1750', 'aht20', 'sht20', 'ads1115', 'ina219', 'ds3231', 'pcf8574', 'mpu6050'].includes(moduleId) ? '#include <Wire.h>\n' : ''}\n${nativeSpec.declaration}\n`;
    fs.writeFileSync(path.join(packageRoot, 'src', nativeSpec.header), header, 'utf8');
    fs.writeFileSync(path.join(packageRoot, 'src', nativeSpec.header.replace(/\.h$/i, '.cpp')), nativeSpec.source(nativeSpec.header), 'utf8');
    fs.writeFileSync(path.join(packageRoot, 'library.properties'), `name=CK ${moduleName}\nversion=${version}\nauthor=CK Project\nmaintainer=CK Project\nsentence=Independent ${moduleName} support for CK blocks.\nparagraph=Contains only the driver used by this hardware module; no shared hardware runtime dependency.\ncategory=Device Control\nurl=https://example.invalid/ck/${packageId}\narchitectures=*\nincludes=${nativeSpec.header}\nlicense=MIT\n`, 'utf8');
  }

  const dependencyText = deps.length ? deps.join('、') : nativeSpec ? '无外部库（驱动已包含）' : '仅使用目标板 Core API';
  fs.writeFileSync(path.join(packageRoot, 'README.md'), `# CK ${moduleName}积木库\n\n这是一个**独立可导入**的 CK Block Package v2。它只包含 ${moduleName} 的积木、元数据、生成规则和必要驱动。\n\n- 包 ID：\`${packageId}\`\n- 积木数量：${blocks.length}\n- 外部 Arduino 依赖：${dependencyText}\n- 与其他硬件包关系：无公共总库依赖，可单独安装、删除和升级\n- Adafruit 依赖：无\n\n将本文件夹单独打成 ZIP，或使用发布目录中同名 ZIP 导入 CK。\n`, 'utf8');

  const validation = validateImportablePackage(packageRoot, { kind: 'block' });
  if (!validation.ok) failures.push({ packageId, errors: validation.errors });
  rows.push({ packageId, moduleName, blocks: blocks.length, dependencyText, native: Boolean(nativeSpec) });
}

const expectedNative = new Set(Object.keys(native));
const unknownNative = [...expectedNative].filter(moduleId => !grouped.has(moduleId));
if (unknownNative.length) failures.push({ packageId: '(catalog)', errors: [`native source definitions without blocks: ${unknownNative.join(', ')}`] });

fs.writeFileSync(indexPath, `# CK 独立常用硬件积木库\n\n当前共 **${rows.length} 个独立库、${rows.reduce((sum, row) => sum + row.blocks, 0)} 个积木**。每个目录都能独立导入、删除和升级，不存在公共硬件总库运行时依赖。\n\n| 包 ID | 模块 | 积木 | 依赖方式 |\n|---|---|---:|---|\n${rows.map(row => `| \`${row.packageId}\` | ${row.moduleName} | ${row.blocks} | ${row.dependencyText} |`).join('\n')}\n`, 'utf8');

// The combined catalog is build-time input only. Never leave it beside the
// importable packages where a user could mistake it for the distribution.
fs.rmSync(catalogRoot, { recursive: true, force: true });

if (failures.length) {
  for (const failure of failures) console.error(`${failure.packageId}: ${failure.errors.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log(`Generated and validated ${rows.length} independent hardware libraries (${rows.filter(row => row.native).length} with isolated native drivers).`);
  console.log(indexPath);
}
