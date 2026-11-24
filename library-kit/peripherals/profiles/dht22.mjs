import { block, chain, gpio, math, n, print, serial, slots, wait } from '../build-kit.mjs';

const id = 'ck_dht22';
const b = (name, key, args = {}) => block(`${id}_${name}`, `${id}-${key}`, { CHANNEL: 1, ...args });
const ch = slots('CKDht22', 'CK_DHT22');
const pin = n('PIN', 2, '数据所在数字引脚。允许变量或算术表达式。');
const data = gpio('PIN', 'gpio', '带外部上拉的单线 DATA。驱动先拉低，再切换输入。');
data.resource.capabilities = ['digital-input', 'digital-output'];
const temp = '读取最近一次采样的摄氏温度；无有效样本时返回 NaN。';
const humidity = '读取最近一次采样的相对湿度；无有效样本时返回 NaN。';

export default {
  id, version: '1.1.0', depends: 'DHT sensor library', name: 'DHT22 温湿度', keywords: ['AM2302', '温度', '湿度'],
  description: '读取 DHT22 或 AM2302 的摄氏温度和相对湿度，最多配置两个数据引脚。',
  header: 'CKDht22.h', color: '#366B51', adapter: { name: 'CKDht22', header: 'CKDht22.h' },
  drivers: [
    { name: 'DHT_sensor_library', version: '1.4.6', header: 'DHT.h', folder: 'DHT_sensor_library-1.4.6', archive: 'DHT.zip',
      sha256: '20a9048e72d636305470c347bd8f83c01d4178c87ff865cae47a7276315e36c2', license: 'MIT', licenseFile: 'license.txt', source: 'https://github.com/adafruit/DHT-sensor-library',
      url: 'https://downloads.arduino.cc/libraries/github.com/adafruit/DHT_sensor_library-1.4.6.zip' },
    { name: 'Adafruit_Unified_Sensor', version: '1.1.15', header: 'Adafruit_Sensor.h', folder: 'Adafruit_Unified_Sensor-1.1.15', archive: 'AdafruitSensor.zip',
      sha256: 'd64cdec0b817535f568fc3b8b8d44e7e097749f5ab8040aea573f412a3cbaec6', license: 'Apache-2.0', licenseFile: 'LICENSE.txt', source: 'https://github.com/adafruit/Adafruit_Sensor',
      url: 'https://downloads.arduino.cc/libraries/github.com/adafruit/Adafruit_Unified_Sensor-1.1.15.zip' },
  ],
  resourceNote: '使用初始化声明的 DATA；实采时驱动短时屏蔽中断，不独占硬件定时器。',
  constraints: 'setup 中先初始化；上电后约等 2 秒再采样。两个通道用不同数据脚。重复请求同一通道时，2 秒内复用驱动缓存。真正采样会短时阻塞并影响中断时序。采样失败会清除上一次读数。',
  wiring: 'Uno 示例 DATA 接 D2；ESP32-S3 接 GPIO2，模块和 DATA 上拉均使用 3.3 V，VCC 接模块允许的电源，GND 共地。裸 DHT22 要按器件标记把 DATA 用约 10 kΩ 电阻上拉到 VCC；模块若已带上拉则不必重复加。四脚裸器件的 NC 留空。不要用 DHT11 代替。',
  observation: '串口 9600。每隔约 2.1 秒依次输出温度和相对湿度；无有效读数时两项均打印 nan。实际逻辑可先用「采样有效？」作条件。',
  repairText: '把初始化的通道号从 3 改回 1。',
  negative: { blockId: `${id}-config`, input: 'CHANNEL', invalid: 3, repair: 1, errorCode: ch.code },
  blocks: [
    { id: 'begin', label: '初始化 DHT22 通道 %1 数据脚 %2', args: [ch.arg, pin], description: '配置指定编号的 DHT22 单线数据脚，清除旧样本。',
      code: `${ch.check}${ch.call('begin', '{{value:PIN}}')};`, hardware: [data], error: ch.err, effects: ['配置 DATA 引脚并重置缓存。'] },
    { id: 'sample', label: 'DHT22 通道 %1 采样', args: [ch.arg], description: '采样一次；两秒内复用原驱动结果，失败时清除该通道读数。',
      code: `${ch.call('sample')};`, effects: ['读取 DATA 并更新缓存，实际采样会阻塞。'] },
    { id: 'valid', label: 'DHT22 通道 %1 采样有效？', args: [ch.arg], output: 'Boolean',
      description: '最近一次采样得到有效温度和湿度时为真。', code: ch.call('valid') },
    { id: 'temperature', label: 'DHT22 通道 %1 温度（℃）', args: [ch.arg], output: 'Number', unit: '°C', description: temp, code: ch.call('temperature') },
    { id: 'humidity', label: 'DHT22 通道 %1 相对湿度（%）', args: [ch.arg], output: 'Number', unit: '%RH', description: humidity, code: ch.call('humidity') },
  ],
  demo: {
    setup: chain(serial(`${id}-serial`), b('begin', 'config', { PIN: math(`${id}-pin-expression`, 1, 1) })),
    loop: chain(wait(`${id}-delay`, 2100), b('sample', 'sample'), print(`${id}-print-t`, b('temperature', 'temp')),
      print(`${id}-print-h`, b('humidity', 'rh')), print(`${id}-print-ok`, b('valid', 'status'))),
  },
};
