import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
// This file is the catalog generator used by Build-IndependentHardwareLibraries.
// Its output is an intermediate document only; the user-facing distribution is
// one independent package per hardware module.
const out = path.resolve(process.env.CK_HARDWARE_CATALOG_OUTPUT
  || path.join(root, 'artifacts', 'tmp', 'ck_hardware_catalog'));
const blocksDir = path.join(out, 'blocks');
const srcDir = path.join(out, 'src');
fs.mkdirSync(blocksDir, { recursive: true });
fs.mkdirSync(srcDir, { recursive: true });

const packageId = 'ck_common_hardware_pack';
const categoryColours = {
  '模拟传感': 42,
  '开关传感': 78,
  '基础执行器': 8,
  'I2C 设备': 178,
  '环境传感': 156,
  '显示与灯光': 265,
  '运动与定位': 205,
  '通信与识别': 225,
};
const blockDefs = [];
const rules = [];
const metadata = [];
const categories = new Map();
const modules = new Map();

const addCategoryBlock = (category, type) => {
  if (!categories.has(category)) categories.set(category, []);
  categories.get(category).push(type);
};

const numberField = (name, label, value = 0, min = 0, max = 255) => ({
  meta: { name, kind: 'number', description: label, required: true, default: value },
  block: { type: 'field_number', name, value, min, max, precision: 1 },
});
const dropdownField = (name, label, options, defaultValue = options[0][1]) => ({
  meta: {
    name,
    kind: 'dropdown',
    description: label,
    required: true,
    default: defaultValue,
    options: options.map(([optionLabel, value]) => ({ label: optionLabel, value })),
  },
  block: { type: 'field_dropdown', name, options },
});
const textField = (name, label, value = '') => ({
  meta: { name, kind: 'text', description: label, required: true, default: value },
  block: { type: 'field_input', name, text: value },
});

const depHeader = (id, reason, license = 'MIT') => ({
  kind: 'header', id, headers: [id], optional: false, reason, license,
});
const depLibrary = (id, headers, reason, license) => ({
  kind: 'arduino-library', id, headers, optional: false, reason, license,
});
const pinResource = (field, access, description, capabilities = ['digital']) => ({
  kind: capabilities.includes('analog-input') ? 'adc' : capabilities.includes('pwm-output') ? 'pwm' : 'gpio',
  id: field.toLowerCase(),
  source: { kind: 'field', name: field },
  access,
  sharing: access === 'read' ? 'shared' : 'board-defined',
  quantity: 1,
  capabilities,
  description,
});
const busResource = (kind, description, sharing = 'shared') => ({
  kind,
  id: `default-${kind}`,
  source: { kind: 'board-default' },
  access: 'read-write',
  sharing,
  quantity: 1,
  capabilities: ['controller'],
  description,
});

function addBlock(spec) {
  const {
    moduleId, moduleName, type, displayName, description, category, kind,
    message, fields = [], outputType, unit, dependencies = [], resources = [],
    notes = [], template, order = 0, includes = {}, declarations = {}, setup = {},
    calls = [], constraints = [], errors = [], keywords = [], sideEffects = [],
    toolboxVisible = true,
  } = spec;
  // CK's Rust import gate intentionally requires the manifest, block
  // definitions, generator rules and toolbox to expose exactly the same type
  // set. Compatibility-only blocks therefore must be omitted from all four
  // surfaces, not merely hidden from the toolbox.
  if (!toolboxVisible) return;
  modules.set(moduleId, moduleName);
  const args0 = fields.map((field) => field.block);
  const block = {
    type,
    message0: message,
    args0,
    colour: categoryColours[category],
    tooltip: description,
    helpUrl: '',
  };
  if (kind === 'value') block.output = outputType || 'Number';
  else {
    block.previousStatement = null;
    block.nextStatement = null;
  }
  blockDefs.push(block);
  rules.push({
    type,
    kind: kind === 'value' ? 'expression' : 'statement',
    template,
    ...(kind === 'value' ? { order } : {}),
    ...(Object.keys(includes).length ? { includes } : {}),
    ...(Object.keys(declarations).length ? { declarations } : {}),
    ...(Object.keys(setup).length ? { setup } : {}),
  });
  const shape = kind === 'value' ? 'expression' : 'statement';
  metadata.push({
    type,
    display_name: displayName,
    description,
    category,
    kind,
    keywords: [...new Set([moduleName, moduleId, ...keywords])],
    semantics: {
      purpose: description,
      behavior: `${displayName}；生成确定性的 Arduino C++，只引入本积木需要的依赖。`,
      side_effects: sideEffects,
      concepts: [...new Set([moduleId, kind === 'value' ? 'sensor-read' : 'hardware-control'])],
    },
    fields: fields.map((field) => field.meta),
    inputs: [],
    output: kind === 'value'
      ? { connection: 'value', types: [outputType || 'Number'], description: `${displayName}的结果。`, ...(unit ? { unit } : {}), nullable: false }
      : { connection: 'none', types: [], description: '该积木执行操作，不返回值。' },
    dependencies,
    hardware: { resources, notes },
    generation: {
      language: 'arduino-cpp',
      shape,
      deterministic: true,
      includes: Object.values(includes).map((line) => line.replace(/^#include\s*[<\"]|[>\"]$/g, '')),
      calls,
      emissions: [
        { section: shape, description: `生成 ${displayName} 的 ${shape === 'expression' ? '表达式' : '语句'}。`, template },
      ],
      notes: ['未使用此积木时不会注入对应第三方头文件。'],
    },
    constraints,
    examples: [{
      id: `${moduleId}-${type}-example`.replace(/^ck_/, '').replace(/_/g, '-'),
      title: `${displayName}示例`,
      description: `在 CK 工作区中使用“${displayName}”积木。`,
      field_values: Object.fromEntries(fields.map((field) => [field.meta.name, field.meta.default])),
      input_values: {},
      expected_behavior: `连接 ${moduleName} 并按积木参数配置后，可完成“${displayName}”。`,
    }],
    errors: errors.length ? errors : [{
      code: 'HARDWARE_NOT_READY',
      severity: 'error',
      message: `${moduleName}未返回有效结果。`,
      cause: '模块未供电、接线错误、引脚或地址配置错误。',
      recovery: '检查供电、共地、接线、引脚和模块地址后重试。',
    }],
  });
  addCategoryBlock(category, type);
}

const analogModules = [
  ['mq2', 'MQ-2 烟雾/可燃气体'], ['mq3', 'MQ-3 酒精'], ['mq7', 'MQ-7 一氧化碳'],
  ['mq9', 'MQ-9 可燃气体'], ['mq135', 'MQ-135 空气质量'], ['soil_moisture', '土壤湿度'],
  ['rain', '雨滴'], ['flame_analog', '火焰模拟量'], ['ldr', '光敏电阻'], ['sound_analog', '声音模拟量'],
  ['joystick_x', '摇杆 X 轴'], ['joystick_y', '摇杆 Y 轴'], ['water_level', '水位'],
  ['flex', '弯曲传感器'], ['potentiometer', '电位器'], ['acs712', 'ACS712 电流'], ['ntc', 'NTC 热敏电阻'],
];
for (const [id, name] of analogModules) {
  addBlock({
    moduleId: id, moduleName: name, type: `ck_common_${id}_read`, displayName: `读取 ${name}`,
    description: `读取 ${name}模块的原始 ADC 数值。`, category: '模拟传感', kind: 'value',
    message: `读取 ${name} 管脚 %1`, fields: [numberField('PIN', '模拟输入管脚', 0, 0, 255)],
    outputType: 'Number', resources: [pinResource('PIN', 'read', `${name}模拟输出。`, ['analog-input'])],
    template: 'analogRead({{field:PIN}})', calls: ['analogRead'], keywords: ['ADC', '模拟量'],
  });
}

const digitalModules = [
  ['pir', 'HC-SR501 人体红外'], ['touch', 'TTP223 触摸'], ['vibration', 'SW-420 振动'],
  ['hall', '霍尔开关'], ['line_tracking', '循迹传感器'], ['ir_obstacle', '红外避障'],
  ['reed', '干簧管'], ['tilt', '倾斜开关'], ['button', '按键模块'], ['flame_digital', '火焰数字量'],
  ['sound_digital', '声音数字量'], ['float_switch', '浮球开关'],
];
for (const [id, name] of digitalModules) {
  addBlock({
    moduleId: id, moduleName: name, type: `ck_common_${id}_active`, displayName: `${name}已触发`,
    description: `读取 ${name}模块并判断是否触发。`, category: '开关传感', kind: 'value',
    message: `${name} 管脚 %1 有效电平 %2`, fields: [
      numberField('PIN', '数字输入管脚', 2, 0, 255),
      dropdownField('ACTIVE', '模块触发时的电平', [['低', 'LOW'], ['高', 'HIGH']], 'LOW'),
    ],
    outputType: 'Boolean', resources: [pinResource('PIN', 'read', `${name}数字输出。`, ['digital-input'])],
    template: '(digitalRead({{field:PIN}}) == {{field:ACTIVE}})', calls: ['digitalRead'], keywords: ['数字量', '触发'],
  });
}

const outputModules = [
  ['relay', '继电器'], ['active_buzzer', '有源蜂鸣器'], ['laser', '激光模块'],
  ['led', 'LED 模块'], ['solenoid', '电磁阀'], ['water_pump', '小水泵'],
];
for (const [id, name] of outputModules) {
  addBlock({
    moduleId: id, moduleName: name, type: `ck_common_${id}_write`, displayName: `控制 ${name}`,
    description: `通过数字输出控制 ${name}。`, category: '基础执行器', kind: 'statement',
    message: `${name} 管脚 %1 状态 %2`, fields: [
      numberField('PIN', '数字输出管脚', 3, 0, 255),
      dropdownField('LEVEL', '输出电平', [['开启/高', 'HIGH'], ['关闭/低', 'LOW']], 'HIGH'),
    ],
    resources: [pinResource('PIN', 'write', `${name}控制管脚。`, ['digital-output'])],
    template: 'pinMode({{field:PIN}}, OUTPUT);\ndigitalWrite({{field:PIN}}, {{field:LEVEL}});',
    calls: ['pinMode', 'digitalWrite'], sideEffects: ['改变 GPIO 输出电平'],
  });
}

addBlock({
  moduleId: 'passive_buzzer', moduleName: '无源蜂鸣器', type: 'ck_common_passive_buzzer_tone', displayName: '无源蜂鸣器发声',
  description: '使用 tone 让无源蜂鸣器按频率发声。', category: '基础执行器', kind: 'statement',
  message: '无源蜂鸣器 管脚 %1 频率 %2 Hz 时长 %3 ms', fields: [
    numberField('PIN', '蜂鸣器管脚', 3, 0, 255), numberField('FREQ', '频率', 1000, 20, 20000), numberField('DURATION', '时长', 200, 0, 60000),
  ], resources: [pinResource('PIN', 'write', '蜂鸣器控制管脚。', ['digital-output', 'timer'])],
  template: 'tone({{field:PIN}}, {{field:FREQ}}, {{field:DURATION}});', calls: ['tone'], sideEffects: ['占用定时器并输出方波'],
});

addBlock({
  moduleId: 'vibration_motor', moduleName: '振动马达', type: 'ck_common_vibration_motor_pwm', displayName: '设置振动马达强度',
  description: '通过 PWM 和驱动管设置振动马达强度。', category: '基础执行器', kind: 'statement',
  message: '振动马达 PWM 管脚 %1 强度 %2', fields: [numberField('PIN', 'PWM 管脚', 3, 0, 255), numberField('VALUE', 'PWM 强度', 128, 0, 255)],
  resources: [pinResource('PIN', 'write', '振动马达 PWM 控制管脚。', ['pwm-output'])],
  template: 'analogWrite({{field:PIN}}, {{field:VALUE}});', calls: ['analogWrite'], sideEffects: ['输出 PWM'],
});

const simpleI2cReads = [
  ['adxl345', 'ADXL345 加速度计', 'ckCommonAdxl345Read({{field:AXIS}})', dropdownField('AXIS', '读取轴', [['X', '0'], ['Y', '1'], ['Z', '2']], '0'), 'm/s²'],
  ['qmc5883l', 'QMC5883L 电子罗盘', 'ckCommonQmc5883Read({{field:AXIS}})', dropdownField('AXIS', '读取轴', [['X', '0'], ['Y', '1'], ['Z', '2']], '0'), 'raw'],
  ['bh1750', 'BH1750 光照', 'ckCommonBh1750Lux()', null, 'lx'],
  ['aht20', 'AHT20 温湿度', 'ckCommonAht20Read({{field:VALUE}})', dropdownField('VALUE', '读取项目', [['温度 °C', '0'], ['湿度 %', '1']], '0'), ''],
  ['sht20', 'SHT20 温湿度', 'ckCommonSht20Read({{field:VALUE}})', dropdownField('VALUE', '读取项目', [['温度 °C', '0'], ['湿度 %', '1']], '0'), ''],
  ['ads1115', 'ADS1115 16 位 ADC', 'ckCommonAds1115Read({{field:CHANNEL}})', dropdownField('CHANNEL', '通道', [['A0', '0'], ['A1', '1'], ['A2', '2'], ['A3', '3']], '0'), 'raw'],
  ['ina219', 'INA219 电流/电压', 'ckCommonIna219Read({{field:VALUE}})', dropdownField('VALUE', '读取项目', [['总线电压 V', '0'], ['电流 mA', '1']], '0'), ''],
  ['ds3231', 'DS3231 实时时钟', 'ckCommonDs3231Read({{field:VALUE}})', dropdownField('VALUE', '读取项目', [['年', '0'], ['月', '1'], ['日', '2'], ['时', '3'], ['分', '4'], ['秒', '5']], '3'), ''],
];
for (const [id, name, template, field, unit] of simpleI2cReads) {
  addBlock({
    moduleId: id, moduleName: name, type: `ck_common_${id}_read`, displayName: `读取 ${name}`,
    description: `通过 Wire 轻量驱动读取 ${name}，不依赖 Adafruit。`, category: 'I2C 设备', kind: 'value',
    message: `读取 ${name}${field ? ' %1' : ''}`, fields: field ? [field] : [], outputType: 'Number', ...(unit ? { unit } : {}),
    dependencies: [depHeader('Wire.h', '使用目标板核心的 I2C 总线。'), depHeader('CKCommonHardware.h', '使用本包轻量驱动。')],
    resources: [busResource('i2c', `${name}使用默认 I2C 总线。`)], template,
    includes: { wire: '#include <Wire.h>', common: '#include <CKCommonHardware.h>' }, calls: [template.split('(')[0]],
  });
}

addBlock({
  moduleId: 'pcf8574', moduleName: 'PCF8574 IO 扩展', type: 'ck_common_pcf8574_write', displayName: 'PCF8574 写管脚',
  description: '通过 Wire 直接控制 PCF8574 的一个扩展 IO。', category: 'I2C 设备', kind: 'statement',
  message: 'PCF8574 地址 %1 管脚 %2 电平 %3', fields: [
    dropdownField('ADDRESS', 'I2C 地址', [['0x20', '0x20'], ['0x21', '0x21'], ['0x27', '0x27']], '0x20'),
    numberField('PIN', '扩展管脚', 0, 0, 7), dropdownField('LEVEL', '输出电平', [['高', 'HIGH'], ['低', 'LOW']], 'HIGH'),
  ], dependencies: [depHeader('Wire.h', 'I2C 总线。'), depHeader('CKCommonHardware.h', '本包轻量驱动。')],
  resources: [busResource('i2c', 'PCF8574 使用默认 I2C 总线。')],
  template: 'ckCommonPcf8574Write({{field:ADDRESS}}, {{field:PIN}}, {{field:LEVEL}});',
  includes: { wire: '#include <Wire.h>', common: '#include <CKCommonHardware.h>' }, calls: ['ckCommonPcf8574Write'], sideEffects: ['改变 IO 扩展器输出'],
});

addBlock({
  moduleId: 'mpu6050', moduleName: 'MPU6050 六轴传感器', type: 'ck_common_mpu6050_begin', displayName: '初始化 MPU6050',
  description: '使用 MPU6050_light 初始化六轴传感器；不使用 Adafruit。', category: '运动与定位', kind: 'statement',
  message: '初始化 MPU6050 并校准', fields: [], toolboxVisible: false,
  dependencies: [depLibrary('MPU6050_light', ['MPU6050_light.h'], '轻量 MPU6050 驱动，不使用 Adafruit。', 'MIT'), depHeader('Wire.h', 'I2C 总线。')],
  resources: [busResource('i2c', 'MPU6050 使用默认 I2C 总线。')], template: '/* MPU6050 已由 CK 在 setup 前置段初始化 */',
  calls: [], sideEffects: [],
});
addBlock({
  moduleId: 'mpu6050', moduleName: 'MPU6050 六轴传感器', type: 'ck_common_mpu6050_read', displayName: '读取 MPU6050',
  description: '使用包内置 Wire 驱动读取 MPU6050 加速度、角速度、融合角度或温度；不依赖第三方 MPU 库。', category: '运动与定位', kind: 'value',
  message: '读取 MPU6050 %1 地址 %2', fields: [dropdownField('VALUE', '读取项目', [
    ['加速度 X', '0'], ['加速度 Y', '1'], ['加速度 Z', '2'], ['角速度 X', '3'], ['角速度 Y', '4'], ['角速度 Z', '5'],
    ['角度 X', '6'], ['角度 Y', '7'], ['角度 Z', '8'], ['温度', '9'],
  ], '0'), dropdownField('ADDRESS', 'I2C 地址', [['0x68', '0x68'], ['0x69', '0x69']], '0x68')], outputType: 'Number',
  dependencies: [depHeader('Wire.h', '使用目标板核心的 I2C 总线。'), depHeader('CKCommonHardware.h', '使用本包内置 MPU6050 轻量驱动。')],
  resources: [busResource('i2c', 'MPU6050 使用默认 I2C 总线。')], template: 'ckCommonMpu6050Read({{field:VALUE}}, {{field:ADDRESS}})',
  includes: { common: '#include <CKCommonHardware.h>' },
  setup: { mpu_init: 'ckCommonMpu6050Begin({{field:ADDRESS}});' }, calls: ['ckCommonMpu6050Begin', 'ckCommonMpu6050Read'],
});

const ultrasonic = [['hc_sr04', 'HC-SR04 超声波'], ['jsn_sr04t', 'JSN-SR04T 防水超声波']];
for (const [id, name] of ultrasonic) addBlock({
  moduleId: id, moduleName: name, type: `ck_common_${id}_distance`, displayName: `读取 ${name}距离`,
  description: `读取 ${name}的距离（厘米）。`, category: '运动与定位', kind: 'value',
  message: `${name} Trig %1 Echo %2`, fields: [numberField('TRIG', 'Trig 管脚', 5, 0, 255), numberField('ECHO', 'Echo 管脚', 6, 0, 255)],
  outputType: 'Number', unit: 'cm', dependencies: [depHeader('CKCommonHardware.h', '使用本包超声波帮助函数。')],
  resources: [pinResource('TRIG', 'write', '超声波触发管脚。', ['digital-output']), pinResource('ECHO', 'read', '超声波回响管脚。', ['digital-input'])],
  template: 'ckCommonUltrasonicCm({{field:TRIG}}, {{field:ECHO}})', includes: { common: '#include <CKCommonHardware.h>' }, calls: ['ckCommonUltrasonicCm'],
});

addBlock({
  moduleId: 'rotary_encoder', moduleName: 'EC11 旋转编码器', type: 'ck_common_rotary_encoder_delta', displayName: '读取旋转编码器方向',
  description: '读取 EC11 A/B 相并返回 -1、0 或 1。', category: '运动与定位', kind: 'value',
  message: '旋转编码器 A %1 B %2', fields: [numberField('A', 'A 相管脚', 2, 0, 255), numberField('B', 'B 相管脚', 3, 0, 255)],
  outputType: 'Number', dependencies: [depHeader('CKCommonHardware.h', '使用本包编码器帮助函数。')],
  resources: [pinResource('A', 'read', '编码器 A 相。', ['digital-input']), pinResource('B', 'read', '编码器 B 相。', ['digital-input'])],
  template: 'ckCommonEncoderDelta({{field:A}}, {{field:B}})', includes: { common: '#include <CKCommonHardware.h>' }, calls: ['ckCommonEncoderDelta'],
});

addBlock({
  moduleId: 'dht11', moduleName: 'DHT11 温湿度', type: 'ck_common_dht11_read', displayName: '读取 DHT11',
  description: '使用 Rob Tillaart DHTlib 读取 DHT11。', category: '环境传感', kind: 'value',
  message: '读取 DHT11 管脚 %1 项目 %2', fields: [numberField('PIN', '数据管脚', 2, 0, 255), dropdownField('VALUE', '读取项目', [['温度 °C', '0'], ['湿度 %', '1']], '0')],
  outputType: 'Number', dependencies: [depLibrary('DHTlib', ['dht.h'], 'Rob Tillaart 轻量 DHT 驱动。', 'MIT')],
  resources: [pinResource('PIN', 'read', 'DHT11 单总线数据管脚。', ['digital-input', 'timing-sensitive'])], template: 'ckReadDht11({{field:PIN}}, {{field:VALUE}})',
  includes: { dht: '#include <dht.h>' }, declarations: { dht: 'dht ckDht;', dht11_read: 'float ckReadDht11(uint8_t pin, uint8_t item) { ckDht.read11(pin); return item == 0 ? ckDht.temperature : ckDht.humidity; }' }, calls: ['dht.read11'],
});
addBlock({
  moduleId: 'dht22', moduleName: 'DHT22/AM2302 温湿度', type: 'ck_common_dht22_read', displayName: '读取 DHT22',
  description: '使用 Rob Tillaart DHTlib 读取 DHT22/AM2302。', category: '环境传感', kind: 'value',
  message: '读取 DHT22 管脚 %1 项目 %2', fields: [numberField('PIN', '数据管脚', 2, 0, 255), dropdownField('VALUE', '读取项目', [['温度 °C', '0'], ['湿度 %', '1']], '0')],
  outputType: 'Number', dependencies: [depLibrary('DHTlib', ['dht.h'], 'Rob Tillaart 轻量 DHT 驱动。', 'MIT')],
  resources: [pinResource('PIN', 'read', 'DHT22 单总线数据管脚。', ['digital-input', 'timing-sensitive'])], template: 'ckReadDht22({{field:PIN}}, {{field:VALUE}})',
  includes: { dht: '#include <dht.h>' }, declarations: { dht: 'dht ckDht;', dht22_read: 'float ckReadDht22(uint8_t pin, uint8_t item) { ckDht.read22(pin); return item == 0 ? ckDht.temperature : ckDht.humidity; }' }, calls: ['dht.read22'],
});

addBlock({
  moduleId: 'ds18b20', moduleName: 'DS18B20 温度', type: 'ck_common_ds18b20_begin', displayName: '初始化 DS18B20',
  description: '初始化 OneWire 总线和 DallasTemperature。', category: '环境传感', kind: 'statement',
  message: '初始化 DS18B20 管脚 %1', fields: [numberField('PIN', 'OneWire 管脚', 2, 0, 255)], toolboxVisible: false,
  dependencies: [depLibrary('OneWire', ['OneWire.h'], 'OneWire 总线。', 'MIT'), depLibrary('DallasTemperature', ['DallasTemperature.h'], 'DS18B20 驱动。', 'LGPL-2.1-or-later')],
  resources: [pinResource('PIN', 'read-write', 'OneWire 数据管脚。', ['digital-input', 'digital-output', 'timing-sensitive'])], template: '/* DS18B20 已由 CK 在 setup 前置段初始化 */',
  calls: [],
});
addBlock({
  moduleId: 'ds18b20', moduleName: 'DS18B20 温度', type: 'ck_common_ds18b20_read', displayName: '读取 DS18B20 温度',
  description: '请求并读取第一个 DS18B20 的摄氏温度。', category: '环境传感', kind: 'value', message: '读取 DS18B20 温度 管脚 %1', fields: [numberField('PIN', 'OneWire 管脚', 2, 0, 255)], outputType: 'Number', unit: '°C',
  dependencies: [depLibrary('OneWire', ['OneWire.h'], 'OneWire 总线。', 'MIT'), depLibrary('DallasTemperature', ['DallasTemperature.h'], 'DS18B20 驱动。', 'LGPL-2.1-or-later')],
  resources: [pinResource('PIN', 'read-write', 'OneWire 数据管脚。', ['digital-input', 'digital-output', 'timing-sensitive'])],
  template: '(ckDs18.requestTemperatures(), ckDs18.getTempCByIndex(0))', includes: { onewire: '#include <OneWire.h>', ds: '#include <DallasTemperature.h>' },
  declarations: { ow: 'OneWire ckOneWire({{field:PIN}});', ds: 'DallasTemperature ckDs18(&ckOneWire);' }, setup: { ds18_init: 'ckDs18.begin();' },
  calls: ['DallasTemperature.requestTemperatures', 'DallasTemperature.getTempCByIndex'],
});

addBlock({
  moduleId: 'hx711', moduleName: 'HX711 称重', type: 'ck_common_hx711_begin', displayName: '初始化 HX711',
  description: '初始化 HX711 并设置校准系数。', category: '环境传感', kind: 'statement',
  message: '初始化 HX711 DT %1 SCK %2 系数 %3', fields: [numberField('DT', '数据管脚', 4, 0, 255), numberField('SCK', '时钟管脚', 5, 0, 255), numberField('SCALE', '校准系数', 1, -100000, 100000)], toolboxVisible: false,
  dependencies: [depLibrary('HX711', ['HX711.h'], 'Rob Tillaart HX711 驱动。', 'MIT')],
  resources: [pinResource('DT', 'read', 'HX711 数据管脚。', ['digital-input']), pinResource('SCK', 'write', 'HX711 时钟管脚。', ['digital-output'])],
  template: '/* HX711 已由 CK 在 setup 前置段初始化 */', calls: [],
});
addBlock({
  moduleId: 'hx711', moduleName: 'HX711 称重', type: 'ck_common_hx711_read', displayName: '读取 HX711 重量',
  description: '读取 HX711 的平均重量。', category: '环境传感', kind: 'value', message: '读取 HX711 重量 DT %1 SCK %2 系数 %3 平均 %4 次', fields: [
    numberField('DT', '数据管脚', 4, 0, 255), numberField('SCK', '时钟管脚', 5, 0, 255),
    numberField('SCALE', '校准系数', 1, -100000, 100000), numberField('TIMES', '平均次数', 5, 1, 32),
  ], outputType: 'Number',
  dependencies: [depLibrary('HX711', ['HX711.h'], 'Rob Tillaart HX711 驱动。', 'MIT')],
  resources: [pinResource('DT', 'read', 'HX711 数据管脚。', ['digital-input']), pinResource('SCK', 'write', 'HX711 时钟管脚。', ['digital-output'])],
  template: 'ckScale.get_units({{field:TIMES}})', includes: { hx: '#include <HX711.h>' }, declarations: { hx: 'HX711 ckScale;' },
  setup: { hx_init: 'ckScale.begin({{field:DT}}, {{field:SCK}});\nckScale.set_scale({{field:SCALE}});' }, calls: ['HX711.get_units'],
});

const oledDependencies = [depLibrary('U8g2', ['U8g2lib.h'], 'U8g2 支持 SSD1306、SH1106 等廉价 OLED。', 'BSD-2-Clause')];
for (const [id, name, declaration] of [
  ['u8g2_ssd1306', 'U8g2 SSD1306 OLED', 'U8G2_SSD1306_128X64_NONAME_F_HW_I2C ckOled(U8G2_R0, U8X8_PIN_NONE);'],
  ['u8g2_sh1106', 'U8g2 SH1106 OLED', 'U8G2_SH1106_128X64_NONAME_F_HW_I2C ckOled(U8G2_R0, U8X8_PIN_NONE);'],
]) addBlock({
  moduleId: id, moduleName: name, type: `ck_common_${id}_begin`, displayName: `初始化 ${name}`,
  description: `使用 U8g2 全缓冲硬件 I2C 驱动初始化 ${name}。`, category: '显示与灯光', kind: 'statement', message: `初始化 ${name}`, fields: [], toolboxVisible: false,
  dependencies: oledDependencies, resources: [busResource('i2c', `${name}使用默认 I2C 总线。`)], template: '/* OLED 已由 CK 在 setup 前置段初始化 */',
  calls: [], sideEffects: [],
});
addBlock({
  moduleId: 'u8g2_oled', moduleName: 'U8g2 OLED 绘图', type: 'ck_common_u8g2_draw_text', displayName: 'OLED 绘制文字',
  description: '用 U8g2 在 OLED 缓冲区绘制 UTF-8 文字。', category: '显示与灯光', kind: 'statement',
  message: 'OLED 文字 %1 X %2 Y %3', fields: [textField('TEXT', '显示文字', '你好 CK'), numberField('X', 'X 坐标', 0, 0, 255), numberField('Y', 'Y 坐标', 16, 0, 255)],
  dependencies: oledDependencies, resources: [busResource('i2c', 'OLED 使用默认 I2C 总线。')],
  template: 'ckOled.clearBuffer();\nckOled.drawUTF8({{field:X}}, {{field:Y}}, {{field_json:TEXT}});\nckOled.sendBuffer();',
  includes: { u8g2: '#include <U8g2lib.h>' }, declarations: { oled: 'U8G2_SSD1306_128X64_NONAME_F_HW_I2C ckOled(U8G2_R0, U8X8_PIN_NONE);' },
  setup: { oled_init: 'ckOled.begin();\nckOled.setFont(u8g2_font_unifont_t_chinese2);' }, calls: ['U8G2.drawUTF8'], sideEffects: ['修改显示缓冲区'],
});
for (const [id, display, template] of [
  ['clear', '清空 OLED 缓冲区', 'ckOled.clearBuffer();'], ['send', '刷新 OLED 显示', 'ckOled.sendBuffer();'],
]) addBlock({
  moduleId: 'u8g2_oled', moduleName: 'U8g2 OLED 绘图', type: `ck_common_u8g2_${id}`, displayName: display,
  description: `${display}，使用 U8g2。`, category: '显示与灯光', kind: 'statement', message: display, fields: [], dependencies: oledDependencies, toolboxVisible: false,
  resources: [busResource('i2c', 'OLED 使用默认 I2C 总线。')],
  template: '/* OLED 清空与刷新已合并到“OLED 绘制文字”积木 */', calls: [],
});

addBlock({
  moduleId: 'lcd1602_i2c', moduleName: 'LCD1602 I2C', type: 'ck_common_lcd1602_begin', displayName: '初始化 LCD1602',
  description: '初始化常见 PCF8574 转接板的 LCD1602。', category: '显示与灯光', kind: 'statement',
  message: '初始化 LCD1602 地址 %1', fields: [dropdownField('ADDRESS', 'I2C 地址', [['0x27', '0x27'], ['0x3F', '0x3F']], '0x27')], toolboxVisible: false,
  dependencies: [depLibrary('LiquidCrystal I2C', ['LiquidCrystal_I2C.h'], '常见 LCD1602 I2C 驱动。', 'MIT')], resources: [busResource('i2c', 'LCD1602 使用默认 I2C 总线。')],
  template: '/* LCD1602 已由 CK 在 setup 前置段初始化 */', calls: [],
});
addBlock({
  moduleId: 'lcd1602_i2c', moduleName: 'LCD1602 I2C', type: 'ck_common_lcd1602_print', displayName: 'LCD1602 显示文字',
  description: '在 LCD1602 指定行列显示文字。', category: '显示与灯光', kind: 'statement',
  message: 'LCD1602 地址 %1 文字 %2 列 %3 行 %4', fields: [dropdownField('ADDRESS', 'I2C 地址', [['0x27', '0x27'], ['0x3F', '0x3F']], '0x27'), textField('TEXT', '显示文字', 'Hello CK'), numberField('COL', '列', 0, 0, 15), numberField('ROW', '行', 0, 0, 1)],
  dependencies: [depLibrary('LiquidCrystal I2C', ['LiquidCrystal_I2C.h'], '常见 LCD1602 I2C 驱动。', 'MIT')], resources: [busResource('i2c', 'LCD1602 使用默认 I2C 总线。')],
  template: 'ckLcd.setCursor({{field:COL}}, {{field:ROW}});\nckLcd.print({{field_json:TEXT}});', includes: { lcd: '#include <LiquidCrystal_I2C.h>' },
  declarations: { lcd: 'LiquidCrystal_I2C ckLcd({{field:ADDRESS}}, 16, 2);' }, setup: { lcd_init: 'ckLcd.init();\nckLcd.backlight();' },
  calls: ['LiquidCrystal_I2C.setCursor', 'LiquidCrystal_I2C.print'],
});

addBlock({
  moduleId: 'tm1637', moduleName: 'TM1637 四位数码管', type: 'ck_common_tm1637_show', displayName: 'TM1637 显示数字',
  description: '在 TM1637 四位数码管显示整数。', category: '显示与灯光', kind: 'statement',
  message: 'TM1637 CLK %1 DIO %2 显示 %3', fields: [numberField('CLK', '时钟管脚', 2, 0, 255), numberField('DIO', '数据管脚', 3, 0, 255), numberField('VALUE', '显示数字', 1234, -999, 9999)],
  dependencies: [depLibrary('TM1637', ['TM1637Display.h'], 'Avishay Orpaz TM1637 驱动。', 'LGPL-3.0-or-later')],
  resources: [pinResource('CLK', 'write', 'TM1637 CLK。', ['digital-output']), pinResource('DIO', 'read-write', 'TM1637 DIO。', ['digital-input', 'digital-output'])],
  template: 'ckTm.setBrightness(7);\nckTm.showNumberDec({{field:VALUE}});', includes: { tm: '#include <TM1637Display.h>' }, declarations: { tm: 'TM1637Display ckTm({{field:CLK}}, {{field:DIO}});' }, calls: ['TM1637Display.showNumberDec'],
});

addBlock({
  moduleId: 'servo', moduleName: '舵机', type: 'ck_common_servo_write', displayName: '设置舵机角度',
  description: '使用 Arduino Servo 库设置舵机角度。', category: '基础执行器', kind: 'statement',
  message: '舵机 管脚 %1 角度 %2', fields: [numberField('PIN', '舵机信号管脚', 9, 0, 255), numberField('ANGLE', '目标角度', 90, 0, 180)],
  dependencies: [depLibrary('Servo', ['Servo.h'], 'Arduino 官方 Servo 库。', 'LGPL-2.1-or-later')],
  resources: [pinResource('PIN', 'write', '舵机 PWM/定时输出。', ['pwm-output', 'timer'])], template: 'if (!ckServo.attached()) ckServo.attach({{field:PIN}});\nckServo.write({{field:ANGLE}});',
  includes: { servo: '#include <Servo.h>' }, declarations: { servo: 'Servo ckServo;' }, calls: ['Servo.attach', 'Servo.write'], sideEffects: ['占用舵机定时器'],
});

addBlock({
  moduleId: 'ws2812', moduleName: 'WS2812/NeoPixel 灯带', type: 'ck_common_fastled_begin', displayName: '初始化 WS2812 灯带',
  description: '使用 FastLED 初始化廉价 WS2812 灯带。', category: '显示与灯光', kind: 'statement',
  message: '初始化 WS2812 管脚 %1 灯数 %2', fields: [numberField('PIN', '数据管脚', 6, 0, 255), numberField('COUNT', '灯珠数量', 8, 1, 60)], toolboxVisible: false,
  dependencies: [depLibrary('FastLED', ['FastLED.h'], '成熟的可寻址 LED 驱动。', 'MIT')], resources: [pinResource('PIN', 'write', 'WS2812 单线数据管脚。', ['digital-output', 'timing-sensitive'])],
  template: '/* WS2812 已由 CK 在 setup 前置段初始化 */', calls: [],
});
addBlock({
  moduleId: 'ws2812', moduleName: 'WS2812/NeoPixel 灯带', type: 'ck_common_fastled_pixel', displayName: '设置 WS2812 灯珠',
  description: '设置一个 WS2812 灯珠并立即刷新。', category: '显示与灯光', kind: 'statement',
  message: 'WS2812 管脚 %1 灯数 %2 序号 %3 R %4 G %5 B %6', fields: [numberField('PIN', '数据管脚', 6, 0, 255), numberField('COUNT', '灯珠数量', 8, 1, 60), numberField('INDEX', '灯珠序号', 0, 0, 59), numberField('R', '红色', 255, 0, 255), numberField('G', '绿色', 0, 0, 255), numberField('B', '蓝色', 0, 0, 255)],
  dependencies: [depLibrary('FastLED', ['FastLED.h'], '成熟的可寻址 LED 驱动。', 'MIT')], resources: [pinResource('PIN', 'write', 'WS2812 单线数据管脚。', ['digital-output', 'timing-sensitive'])],
  template: 'ckLeds[{{field:INDEX}}] = CRGB({{field:R}}, {{field:G}}, {{field:B}});\nFastLED.show();', includes: { fastled: '#include <FastLED.h>' }, declarations: { leds: 'CRGB ckLeds[60];' },
  setup: { fastled_init: 'FastLED.addLeds<NEOPIXEL, {{field:PIN}}>(ckLeds, {{field:COUNT}});\nFastLED.clear(true);' }, calls: ['FastLED.show'],
});

addBlock({
  moduleId: 'mfrc522', moduleName: 'MFRC522 RFID', type: 'ck_common_mfrc522_begin', displayName: '初始化 MFRC522',
  description: '使用 Miguel Balboa MFRC522 库初始化 RFID 读卡器。', category: '通信与识别', kind: 'statement',
  message: '初始化 MFRC522 SS %1 RST %2', fields: [numberField('SS', '片选管脚', 10, 0, 255), numberField('RST', '复位管脚', 9, 0, 255)], toolboxVisible: false,
  dependencies: [depLibrary('MFRC522', ['MFRC522.h'], 'Miguel Balboa RFID 驱动。', 'Unlicense'), depHeader('SPI.h', 'SPI 总线。')],
  resources: [busResource('spi', 'MFRC522 使用默认 SPI 总线。'), pinResource('SS', 'write', 'MFRC522 片选。', ['digital-output']), pinResource('RST', 'write', 'MFRC522 复位。', ['digital-output'])],
  template: '/* MFRC522 已由 CK 在 setup 前置段初始化 */', calls: [],
});
addBlock({
  moduleId: 'mfrc522', moduleName: 'MFRC522 RFID', type: 'ck_common_mfrc522_available', displayName: 'RFID 有新卡',
  description: '判断 MFRC522 是否检测到并读取了新卡。', category: '通信与识别', kind: 'value', message: 'RFID 有新卡 SS %1 RST %2',
  fields: [numberField('SS', '片选管脚', 10, 0, 255), numberField('RST', '复位管脚', 9, 0, 255)], outputType: 'Boolean',
  dependencies: [depLibrary('MFRC522', ['MFRC522.h'], 'Miguel Balboa RFID 驱动。', 'Unlicense'), depHeader('SPI.h', 'SPI 总线。')],
  resources: [busResource('spi', 'MFRC522 使用默认 SPI 总线。'), pinResource('SS', 'write', 'MFRC522 片选。', ['digital-output']), pinResource('RST', 'write', 'MFRC522 复位。', ['digital-output'])],
  template: '(ckRfid.PICC_IsNewCardPresent() && ckRfid.PICC_ReadCardSerial())', includes: { spi: '#include <SPI.h>', rfid: '#include <MFRC522.h>' },
  declarations: { rfid: 'MFRC522 ckRfid({{field:SS}}, {{field:RST}});' }, setup: { rfid_init: 'SPI.begin();\nckRfid.PCD_Init();' }, calls: ['MFRC522.PICC_IsNewCardPresent'],
});

addBlock({
  moduleId: 'irremote', moduleName: '红外遥控接收', type: 'ck_common_irremote_begin', displayName: '初始化红外接收',
  description: '使用 Arduino-IRremote 初始化红外接收器。', category: '通信与识别', kind: 'statement',
  message: '初始化红外接收 管脚 %1', fields: [numberField('PIN', '红外接收管脚', 2, 0, 255)], toolboxVisible: false,
  dependencies: [depLibrary('IRremote', ['IRremote.hpp'], 'Arduino-IRremote。', 'MIT')], resources: [pinResource('PIN', 'read', '红外接收数据管脚。', ['digital-input', 'interrupt', 'timer'])],
  template: '/* 红外接收器已由 CK 在 setup 前置段初始化 */', calls: [], sideEffects: [],
});
addBlock({
  moduleId: 'irremote', moduleName: '红外遥控接收', type: 'ck_common_irremote_command', displayName: '读取红外命令',
  description: '解码一次红外命令；无新数据时返回 -1。', category: '通信与识别', kind: 'value', message: '读取红外命令 管脚 %1',
  fields: [numberField('PIN', '红外接收管脚', 2, 0, 255)], outputType: 'Number',
  dependencies: [depLibrary('IRremote', ['IRremote.hpp'], 'Arduino-IRremote。', 'MIT')],
  resources: [pinResource('PIN', 'read', '红外接收数据管脚。', ['digital-input', 'interrupt', 'timer'])], template: 'ckReadIrCommand()', includes: { ir: '#include <IRremote.hpp>' },
  declarations: { ir_read: 'long ckReadIrCommand() { if (!IrReceiver.decode()) return -1; long value = IrReceiver.decodedIRData.command; IrReceiver.resume(); return value; }' },
  setup: { ir_init: 'IrReceiver.begin({{field:PIN}}, DISABLE_LED_FEEDBACK);' }, calls: ['IrReceiver.decode', 'IrReceiver.resume'],
});

addBlock({
  moduleId: 'tinygpsplus', moduleName: 'GPS（TinyGPSPlus）', type: 'ck_common_gps_update', displayName: '更新 GPS 数据',
  description: '从 Serial1 读取并解析当前 GPS 数据。', category: '通信与识别', kind: 'statement', message: '更新 GPS 数据（Serial1）波特率 %1',
  fields: [dropdownField('BAUD', 'GPS 串口波特率', [['9600', '9600'], ['38400', '38400'], ['115200', '115200']], '9600')], toolboxVisible: false,
  dependencies: [depLibrary('TinyGPSPlus', ['TinyGPS++.h'], 'Mikal Hart TinyGPSPlus。', 'LGPL-2.1-or-later'), depHeader('HardwareSerial.h', '板卡硬件串口。')],
  resources: [{ kind: 'uart', id: 'serial1', source: { kind: 'fixed', value: 'Serial1' }, access: 'read', sharing: 'exclusive', quantity: 1, capabilities: ['rx'], description: '使用 Serial1 接收 GPS NMEA 数据。' }],
  template: '/* GPS 数据会在读取积木中自动更新 */', calls: [],
  constraints: [{ id: 'serial1-required', severity: 'error', description: '需要 Serial1。', check: { target: 'board', operator: 'board-capability', value: 'uart-secondary' }, message: '当前板卡未声明 Serial1。', recovery: '选择带额外硬件串口的板卡，或稍后使用软件串口适配积木。' }],
});
for (const [id, label, expression, unit] of [
  ['latitude', 'GPS 纬度', 'ckGps.location.lat()', '°'], ['longitude', 'GPS 经度', 'ckGps.location.lng()', '°'], ['satellites', 'GPS 卫星数', 'ckGps.satellites.value()', ''],
]) addBlock({
  moduleId: 'tinygpsplus', moduleName: 'GPS（TinyGPSPlus）', type: `ck_common_gps_${id}`, displayName: label,
  description: `读取 ${label}。`, category: '通信与识别', kind: 'value', message: `${label} 波特率 %1`,
  fields: [dropdownField('BAUD', 'GPS 串口波特率', [['9600', '9600'], ['38400', '38400'], ['115200', '115200']], '9600')], outputType: 'Number', ...(unit ? { unit } : {}), toolboxVisible: false,
  dependencies: [depLibrary('TinyGPSPlus', ['TinyGPS++.h'], 'Mikal Hart TinyGPSPlus。', 'LGPL-2.1-or-later')], resources: [],
  template: `(ckUpdateGps_${id}(), ${expression.replaceAll('ckGps', `ckGps_${id}`)})`,
  includes: { gps: '#include <TinyGPS++.h>' }, declarations: {
    [`gps_${id}`]: `TinyGPSPlus ckGps_${id};`,
    [`gps_update_${id}`]: `void ckUpdateGps_${id}() { while (Serial1.available()) ckGps_${id}.encode(Serial1.read()); }`,
  },
  setup: { gps_serial: 'Serial1.begin({{field:BAUD}});' }, calls: ['TinyGPSPlus.encode', expression.split('(')[0]],
});

addBlock({
  moduleId: 'tinygpsplus', moduleName: 'GPS（TinyGPSPlus）', type: 'ck_common_gps_read', displayName: '读取 GPS',
  description: '自动从 Serial1 更新数据并读取纬度、经度或卫星数。', category: '通信与识别', kind: 'value',
  message: '读取 GPS %1 波特率 %2', fields: [
    dropdownField('VALUE', '读取项目', [['纬度', '0'], ['经度', '1'], ['卫星数', '2']], '0'),
    dropdownField('BAUD', 'GPS 串口波特率', [['9600', '9600'], ['38400', '38400'], ['115200', '115200']], '9600'),
  ], outputType: 'Number',
  dependencies: [depLibrary('TinyGPSPlus', ['TinyGPS++.h'], 'Mikal Hart TinyGPSPlus。', 'LGPL-2.1-or-later')],
  resources: [{ kind: 'uart', id: 'serial1', source: { kind: 'fixed', value: 'Serial1' }, access: 'read', sharing: 'exclusive', quantity: 1, capabilities: ['rx'], description: '使用 Serial1 接收 GPS NMEA 数据。' }],
  template: 'ckReadGps({{field:VALUE}})', includes: { gps: '#include <TinyGPS++.h>' },
  declarations: {
    gps: 'TinyGPSPlus ckGps;',
    gps_update: 'void ckUpdateGps() { while (Serial1.available()) ckGps.encode(Serial1.read()); }',
    gps_read: 'double ckReadGps(uint8_t item) { ckUpdateGps(); if (item == 0) return ckGps.location.lat(); if (item == 1) return ckGps.location.lng(); return ckGps.satellites.value(); }',
  },
  setup: { gps_serial: 'Serial1.begin({{field:BAUD}});' }, calls: ['TinyGPSPlus.encode'],
  constraints: [{ id: 'serial1-required', severity: 'error', description: '需要 Serial1。', check: { target: 'board', operator: 'board-capability', value: 'uart-secondary' }, message: '当前板卡未声明 Serial1。', recovery: '选择带额外硬件串口的板卡。' }],
});

const manifest = {
  schema_version: 2,
  id: packageId,
  display_name: 'CK 常用硬件积木包',
  description: `覆盖 ${modules.size} 类常用廉价硬件模块的声明式积木包；OLED 使用 U8g2，MPU6050 使用包内置 Wire 驱动，不依赖 Adafruit。`,
  keywords: ['common-hardware', 'sensor', 'actuator', 'u8g2', 'mpu6050', 'no-adafruit'],
  license: { spdx_id: 'MIT', file: 'LICENSE' },
  compatibility: { boards: ['*'], architectures: ['*'] },
  dependencies: [],
  entrypoints: { blocks: 'blocks/blocks.json', generator: 'blocks/ck-generator.json', toolbox: 'blocks/toolbox.json' },
  blocks: metadata,
};

const toolbox = [...categories.entries()].map(([name, types]) =>
  `<category name="${name}" colour="${categoryColours[name]}">\n${types.map((type) => `  <block type="${type}" />`).join('\n')}\n</category>`
).join('\n');

// JSON toolbox is required here. CK deliberately converts number/dropdown
// fields in third-party blocks into value inputs so users may plug expressions
// into them. The JSON toolbox path lets the runtime attach a visible default
// shadow to every converted input; a bare XML <block/> cannot carry those
// generated shadow types and would render every socket empty in the flyout.
const toolboxJson = [...categories.entries()].map(([name, types]) => ({
  kind: 'category',
  name,
  colour: categoryColours[name],
  contents: types.map((type) => ({ kind: 'block', type })),
}));

const libraryJson = {
  id: packageId,
  name: 'CK 常用硬件积木包',
  version: '0.1.6',
  description: `${modules.size} 类常用硬件模块，面向廉价通用模块，不依赖 Adafruit。`,
  author: 'CK Project',
  license: 'MIT',
  architectures: ['*'],
  includes: ['CKCommonHardware.h'],
};

const helperHeader = `#pragma once
#include <Arduino.h>
#include <Wire.h>

float ckCommonUltrasonicCm(uint8_t trig, uint8_t echo);
int8_t ckCommonEncoderDelta(uint8_t pinA, uint8_t pinB);
float ckCommonAdxl345Read(uint8_t axis);
float ckCommonQmc5883Read(uint8_t axis);
float ckCommonBh1750Lux();
float ckCommonAht20Read(uint8_t item);
float ckCommonSht20Read(uint8_t item);
int16_t ckCommonAds1115Read(uint8_t channel);
float ckCommonIna219Read(uint8_t item);
int16_t ckCommonDs3231Read(uint8_t item);
void ckCommonPcf8574Write(uint8_t address, uint8_t pin, uint8_t level);
bool ckCommonMpu6050Begin(uint8_t address = 0x68);
float ckCommonMpu6050Read(uint8_t item, uint8_t address = 0x68);
`;

const helperSource = `#include "CKCommonHardware.h"
#include <math.h>

static bool ckWireReady = false;
static void ckWireBeginOnce() { if (!ckWireReady) { Wire.begin(); ckWireReady = true; } }
static void ckWrite8(uint8_t address, uint8_t reg, uint8_t value) { ckWireBeginOnce(); Wire.beginTransmission(address); Wire.write(reg); Wire.write(value); Wire.endTransmission(); }
static int16_t ckRead16(uint8_t address, uint8_t reg, bool littleEndian = false) { ckWireBeginOnce(); Wire.beginTransmission(address); Wire.write(reg); if (Wire.endTransmission(false) != 0) return 0; if (Wire.requestFrom(address, (uint8_t)2) != 2) return 0; uint8_t a = Wire.read(), b = Wire.read(); return littleEndian ? (int16_t)((b << 8) | a) : (int16_t)((a << 8) | b); }

static bool ckMpuReady = false;
static uint8_t ckMpuAddress = 0x68;
static unsigned long ckMpuLastMicros = 0;
static float ckMpuValues[10] = {0};

bool ckCommonMpu6050Begin(uint8_t address) {
  ckWireBeginOnce();
  ckMpuAddress = address;
  Wire.beginTransmission(address);
  Wire.write(0x6B);
  Wire.write(0x00);
  if (Wire.endTransmission() != 0) { ckMpuReady = false; return false; }
  ckWrite8(address, 0x1A, 0x03);
  ckWrite8(address, 0x1B, 0x00);
  ckWrite8(address, 0x1C, 0x00);
  ckMpuLastMicros = micros();
  ckMpuReady = true;
  return true;
}

static bool ckCommonMpu6050Update(uint8_t address) {
  if (!ckMpuReady || ckMpuAddress != address) {
    if (!ckCommonMpu6050Begin(address)) return false;
  }
  Wire.beginTransmission(address);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(address, (uint8_t)14) != 14) return false;
  int16_t raw[7];
  for (uint8_t i = 0; i < 7; ++i) raw[i] = (int16_t)((Wire.read() << 8) | Wire.read());
  float ax = raw[0] / 16384.0f, ay = raw[1] / 16384.0f, az = raw[2] / 16384.0f;
  float gx = raw[4] / 131.0f, gy = raw[5] / 131.0f, gz = raw[6] / 131.0f;
  unsigned long now = micros();
  float dt = (now - ckMpuLastMicros) * 0.000001f;
  ckMpuLastMicros = now;
  if (dt <= 0.0f || dt > 0.25f) dt = 0.01f;
  float rollAcc = atan2f(ay, az) * 57.2957795f;
  float pitchAcc = atan2f(-ax, sqrtf(ay * ay + az * az)) * 57.2957795f;
  ckMpuValues[0] = ax; ckMpuValues[1] = ay; ckMpuValues[2] = az;
  ckMpuValues[3] = gx; ckMpuValues[4] = gy; ckMpuValues[5] = gz;
  ckMpuValues[6] = 0.98f * (ckMpuValues[6] + gx * dt) + 0.02f * rollAcc;
  ckMpuValues[7] = 0.98f * (ckMpuValues[7] + gy * dt) + 0.02f * pitchAcc;
  ckMpuValues[8] += gz * dt;
  ckMpuValues[9] = raw[3] / 340.0f + 36.53f;
  return true;
}

float ckCommonMpu6050Read(uint8_t item, uint8_t address) {
  if (!ckCommonMpu6050Update(address)) return NAN;
  return ckMpuValues[item < 10 ? item : 9];
}

float ckCommonUltrasonicCm(uint8_t trig, uint8_t echo) { pinMode(trig, OUTPUT); pinMode(echo, INPUT); digitalWrite(trig, LOW); delayMicroseconds(2); digitalWrite(trig, HIGH); delayMicroseconds(10); digitalWrite(trig, LOW); unsigned long us = pulseIn(echo, HIGH, 30000UL); return us ? us * 0.0343f * 0.5f : -1.0f; }
int8_t ckCommonEncoderDelta(uint8_t pinA, uint8_t pinB) { static uint8_t previous = 0; pinMode(pinA, INPUT_PULLUP); pinMode(pinB, INPUT_PULLUP); uint8_t current = (digitalRead(pinA) << 1) | digitalRead(pinB); uint8_t transition = (previous << 2) | current; previous = current; if (transition == 0x1 || transition == 0x7 || transition == 0xE || transition == 0x8) return 1; if (transition == 0x2 || transition == 0xB || transition == 0xD || transition == 0x4) return -1; return 0; }
float ckCommonAdxl345Read(uint8_t axis) { static bool ready = false; if (!ready) { ckWrite8(0x53, 0x2D, 0x08); ready = true; } return ckRead16(0x53, 0x32 + (axis % 3) * 2, true) * 0.0392266f; }
float ckCommonQmc5883Read(uint8_t axis) { static bool ready = false; if (!ready) { ckWrite8(0x0D, 0x0B, 0x01); ckWrite8(0x0D, 0x09, 0x1D); ready = true; } return (float)ckRead16(0x0D, (axis % 3) * 2, true); }
float ckCommonBh1750Lux() { ckWireBeginOnce(); Wire.beginTransmission(0x23); Wire.write(0x10); Wire.endTransmission(); delay(180); if (Wire.requestFrom((uint8_t)0x23, (uint8_t)2) != 2) return NAN; return ((Wire.read() << 8) | Wire.read()) / 1.2f; }
float ckCommonAht20Read(uint8_t item) { ckWireBeginOnce(); Wire.beginTransmission(0x38); Wire.write(0xAC); Wire.write(0x33); Wire.write(0x00); Wire.endTransmission(); delay(85); if (Wire.requestFrom((uint8_t)0x38, (uint8_t)6) != 6) return NAN; uint8_t d[6]; for (uint8_t i=0;i<6;i++) d[i]=Wire.read(); uint32_t rh=((uint32_t)(d[1]&0x0F)<<16)|((uint32_t)d[2]<<8)|d[3]; uint32_t rt=((uint32_t)(d[3]&0x0F)<<16)|((uint32_t)d[4]<<8)|d[5]; return item ? rh*100.0f/1048576.0f : rt*200.0f/1048576.0f-50.0f; }
float ckCommonSht20Read(uint8_t item) { ckWireBeginOnce(); Wire.beginTransmission(0x40); Wire.write(item ? 0xF5 : 0xF3); Wire.endTransmission(); delay(item ? 30 : 90); if (Wire.requestFrom((uint8_t)0x40, (uint8_t)2) != 2) return NAN; uint16_t raw=(Wire.read()<<8)|Wire.read(); raw &= 0xFFFC; return item ? -6.0f+125.0f*raw/65536.0f : -46.85f+175.72f*raw/65536.0f; }
int16_t ckCommonAds1115Read(uint8_t channel) { ckWireBeginOnce(); uint16_t config=0xC183|((channel&3)<<12); Wire.beginTransmission(0x48); Wire.write(0x01); Wire.write(config>>8); Wire.write(config); Wire.endTransmission(); delay(9); return ckRead16(0x48,0x00); }
float ckCommonIna219Read(uint8_t item) { if (item == 0) return ((uint16_t)ckRead16(0x40,0x02)>>3)*0.004f; return ckRead16(0x40,0x04)*0.1f; }
int16_t ckCommonDs3231Read(uint8_t item) { static const uint8_t regs[]={0x06,0x05,0x04,0x02,0x01,0x00}; uint8_t v=(uint8_t)(ckRead16(0x68,regs[item%6])>>8); return (v>>4)*10+(v&0x0F); }
void ckCommonPcf8574Write(uint8_t address, uint8_t pin, uint8_t level) { static uint8_t state=0xFF; if (level) state|=(1U<<(pin&7)); else state&=~(1U<<(pin&7)); ckWireBeginOnce(); Wire.beginTransmission(address); Wire.write(state); Wire.endTransmission(); }
`;

const moduleList = [...modules.entries()].map(([id, name], index) => `${index + 1}. \`${id}\` — ${name}`).join('\n');
const readme = `# CK 常用硬件积木包 0.1.6

一个可导入的 CK Block Package v2，当前包含 **${modules.size} 类硬件模块、${metadata.length} 个实际积木**。

## 设计原则

- 不依赖 Adafruit 生态。
- MPU6050 使用本包自带的 **Wire 轻量驱动**，无需再安装 MPU6050_light。
- SSD1306 OLED 使用 **U8g2**。
- 简单 ADC、GPIO、超声波和可直接审计的 I2C 协议使用本包轻量实现。
- DHT、DS18B20、HX711、Servo、FastLED、MFRC522、IRremote、TinyGPSPlus 等使用成熟的非 Adafruit 库。
- 依赖按积木声明；没有使用的模块不会注入对应头文件。
- 第一版的有状态设备按“每类设备一个实例”生成，多个同类设备将在后续版本增加实例命名。

## 导入

将整个文件夹压缩为 ZIP 后，在 CK 的“导入库”中选择 ZIP。也可以直接使用生成的发布 ZIP。

## 模块目录

${moduleList}

## 外部依赖

按实际使用的积木安装对应 Arduino 库：U8g2、DHTlib、OneWire、DallasTemperature、HX711、LiquidCrystal I2C、TM1637、Servo、FastLED、MFRC522、IRremote、TinyGPSPlus。MPU6050 无需外部库。
`;

const license = `MIT License

Copyright (c) 2026 CK Project

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
`;

const writeJson = (target, value) => fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
writeJson(path.join(out, 'library.json'), libraryJson);
writeJson(path.join(out, 'ck-blocks.json'), manifest);
writeJson(path.join(blocksDir, 'blocks.json'), blockDefs);
writeJson(path.join(blocksDir, 'ck-generator.json'), { schema: 'ck-generator', version: 1, rules });
fs.writeFileSync(path.join(blocksDir, 'toolbox.xml'), `${toolbox}\n`, 'utf8');
writeJson(path.join(blocksDir, 'toolbox.json'), toolboxJson);
fs.writeFileSync(path.join(srcDir, 'CKCommonHardware.h'), helperHeader, 'utf8');
fs.writeFileSync(path.join(srcDir, 'CKCommonHardware.cpp'), helperSource, 'utf8');
fs.writeFileSync(path.join(out, 'library.properties'), `name=CK Common Hardware Pack\nversion=0.1.6\nauthor=CK Project\nmaintainer=CK Project\nsentence=Common low-cost hardware helpers for CK blocks.\nparagraph=U8g2 OLED and built-in Wire-based MPU6050 support without Adafruit dependencies.\ncategory=Device Control\narchitectures=*\nincludes=CKCommonHardware.h\nlicense=MIT\n`, 'utf8');
fs.writeFileSync(path.join(out, 'README.md'), readme, 'utf8');
fs.writeFileSync(path.join(out, 'LICENSE'), license, 'utf8');

console.log(`Generated ${packageId}: ${modules.size} modules, ${metadata.length} blocks at ${out}`);
