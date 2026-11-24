import { block, chain, gpio, math, n, print, serial, slots, wait } from '../build-kit.mjs';

const id = 'ck_position_servo';
const b = (name, key, args = {}) => block(`${id}_${name}`, `${id}-${key}`, { CHANNEL: 1, ...args });
const ch = slots('CKPositionServo', 'CK_POSITION_SERVO');
const pin = n('PIN', 9, '舵机信号使用的数字输出脚；无需板载 PWM 功能。支持动态表达式。');
const angle = n('ANGLE', 90, '目标角度（°），支持变量和表达式；数值限制在 0～180，取整后发送。');
const timer = {
  resource: { kind: 'timer', id: 'servo-timer', source: { kind: 'board-default' }, access: 'reserve', sharing: 'board-defined',
    description: 'AVR 使用 Servo 驱动分配的定时器；ESP32 使用 Core 3.x 分配的 LEDC 通道。' },
};
export default {
  id, version: '1.1.0', name: '位置舵机', keywords: ['Servo', 'SG90', '角度', '执行器'],
  description: '控制常见三线位置舵机，可独立设置两个通道的角度，支持停止输出。',
  header: 'CKPositionServo.h', color: '#886224', adapter: { name: 'CKPositionServo', header: 'CKPositionServo.h' },
  drivers: [{ name: 'Servo', version: '1.2.2', header: 'Servo.h', folder: 'Servo-1.2.2', archive: 'Servo.zip',
    sha256: '60850b4c644aa4239706fa50ca09a49c99fb98b0e0f2fb84b30022b82428908b', license: 'LGPL-2.1-or-later', licenseFile: 'LICENSE.txt', source: 'https://github.com/arduino-libraries/Servo',
    url: 'https://downloads.arduino.cc/libraries/github.com/arduino-libraries/Servo-1.2.2.zip' }],
  coreDeps: [{kind:'core', id:'LEDC', reason:'ESP32 构建使用 Arduino-ESP32 3.x 的 LEDC，不使用 AVR Servo。'}],
  resourceNote: '舵机信号脚由初始化声明。Uno 上的 Servo 会使用 Timer1；不要并用 D9/D10 的 analogWrite。Mega2560 首组为 Timer5。ESP32 用动态分配的 50 Hz LEDC，不固定通道或计时器编号。',
  constraints: '先初始化再设角度；两个通道的信号脚不能相同。初始化请求 90°，标定脉宽约 1000～2000 µs。角度是命令，不是实际位置反馈，也不保证机械行程正好是 180°。首次使用先空载，从中点小幅移动。',
  wiring: 'Uno D9 或 ESP32-S3 GPIO9 接信号线。按舵机规格使用能承担启动电流的独立电源，舵机电源负极和 Uno GND 共地；不要从 GPIO 给舵机供电。只适用于位置舵机，不适用于 360° 连续旋转型。',
  observation: '舵机应从中位开始，在 75° 和 105° 的目标之间交替，串口 9600 输出当前命令角度。停止信号积木可用于需要解除保持的程序，不是断电开关。',
  repairText: '把初始化的通道号从 3 改回 1。',
  negative: { blockId: `${id}-config`, input: 'CHANNEL', invalid: 3, repair: 1, errorCode: ch.code },
  blocks: [
    { id: 'begin', label: '初始化位置舵机 通道 %1 信号脚 %2', args: [ch.arg, pin], description: '把通道绑定到数字输出脚并请求 90°。',
      code: `${ch.check}${ch.call('begin', '{{value:PIN}}')};`, hardware: [gpio('PIN', 'servo-signal', '舵机信号线'), timer], error: ch.err,
      effects: ['启用舵机定时输出并改变目标角度。'] },
    { id: 'angle', label: '舵机 通道 %1 转到 %2 度', args: [ch.arg, angle],
      description: '请求 0～180° 的目标角度；超范围数值被限制，无效或未连接时不输出。',
      code: `${ch.call('write', '{{value:ANGLE}}')};`, effects: ['改变舵机脉宽。'] },
    { id: 'commanded', label: '舵机 通道 %1 最后命令角度（°）', args: [ch.arg], output: 'Number', unit: '°',
      description: '读取该通道最后写入的整数目标角度；通道未启用时为 -1。',
      code: ch.call('commanded') },
    { id: 'stop', label: '停止舵机 通道 %1 输出', args: [ch.arg], description: '停止信号并将原输出脚置低。重新动作前须再次初始化。',
      code: `${ch.call('stop')};`, effects: ['停止舵机信号；不会切断外部电源。'] },
  ],
  demo: {
    setup: chain(serial(`${id}-serial`), b('begin', 'config', { PIN: 9 })),
    loop: chain(b('angle', 'left', { ANGLE: math(`${id}-angle-expression`, 70, 5) }),
      print(`${id}-print-left`, b('commanded', 'read-left')), wait(`${id}-delay-left`, 1100), b('angle', 'right', { ANGLE: 105 }),
      print(`${id}-print-right`, b('commanded', 'read-right')), wait(`${id}-delay-right`, 1100)),
  },
};
