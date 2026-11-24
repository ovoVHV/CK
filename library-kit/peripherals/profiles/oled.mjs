import { n, block, chain, serial, print, wait, fixed, error } from '../build-kit.mjs';
const id = 'ck_oled_ssd1306';
const b = (key, instance, args) => block(`${id}_${key}`, `${id}-${instance}`, args);
const addr = n('ADDR', 60, '7 位 I²C 地址整型常量：60 (0x3C) 或 61 (0x3D)，不填 8 位写地址。');
const addressError = error('CK_OLED_ADDRESS', 'SSD1306 地址应为 60 或 61。', '该模式仅支持 0x3C/0x3D。', '根据模块跳线填 60 或 61，重新编译。');
export default {
  id, version:'1.0.0', name:'SSD1306 OLED 进度显示', color:'#25647D', header:'CKOled128x64.h',
  adapter:{ name:'CKOled128x64', header:'CKOled128x64.h' }, drivers:[],
  coreDeps:[{kind:'core', id:'Wire', headers:['Wire.h'], reason:'使用目标板 Core 自带的默认 I²C 总线。'}],
  coreNote:'SSD1306 驱动为 CK 自有源码，使用板卡 Core 的 Wire，无其他依赖。',
  description:'在一块 128×64 I²C SSD1306 上显示横向进度，支持反色和通信状态。',
  resourceNote:'默认 Wire 可共享，设备地址不能与同一总线其他设备冲突。',
  constraints:'仅支持带复位电路的 4 针模块与内置电荷泵；非 SPI、SH1106 或 128×32 驱动。一组积木只管理一块屏。通信失败后重新初始化。',
  wiring:'GND 共地。确认模块供电和逻辑电平；Uno 默认 SDA=A4、SCL=A5；通用 ESP32-S3 Dev Module 默认 SDA=GPIO8、SCL=GPIO9，I²C 上拉至 3.3 V。',
  observation:'上电清屏；屏幕中部在 25% 和 75% 的横条之间切换。串口 9600 打印最近一次通信是否成功；ACK 不证明屏幕可见。',
  repairText:'将填错的 62 改为 60（0x3C）。', negative:{blockId:`${id}-config`, input:'ADDR', invalid:62, repair:60, errorCode:addressError.code},
  blocks:[
    {id:'begin',label:'初始化 SSD1306 OLED 地址 %1',args:[addr],description:'启动默认 Wire，清空 128×64 显存，打开显示。',
     code:'static_assert(({{value:ADDR}})==60 || ({{value:ADDR}})==61, "CK_OLED_ADDRESS: use 60 or 61");\nCKOled128x64::begin({{value:ADDR}});', error:addressError,
     hardware:[{resource:{kind:'i2c',id:'wire',source:{kind:'board-default'},access:'write',sharing:'shared',description:'默认 SDA/SCL 与 7 位设备地址'},claim:{id:'address',resource:fixed('i2c'),role:'i2c-device',exclusive:false,discriminator:{kind:'input',name:'ADDR',valueType:'integer'}}}]},
    {id:'bar',label:'OLED 显示进度 %1 %',args:[n('VALUE',50,'进度百分比，允许表达式，限幅到 0～100。')],description:'重画中部 8 像素高的进度条。', code:'CKOled128x64::bar({{value:VALUE}});'},
    {id:'invert',label:'OLED 反色 开(1)/关(0) %1',args:[n('ENABLE',0,'零为关闭，非零为开启。')],description:'切换正常显示与反色显示。',code:'CKOled128x64::invert(({{value:ENABLE}}) != 0);'},
    {id:'ready',label:'OLED 通信正常？',output:'Boolean',description:'返回最近一次写入是否收到应答，不主动探测。',code:'CKOled128x64::ready()'}
  ],
  demo:{setup:chain(serial(`${id}-serial`),b('begin','config',{ADDR:60}),b('invert','normal',{ENABLE:0})),loop:chain(b('bar','low',{VALUE:25}),wait(`${id}-a`,800),b('bar','high',{VALUE:75}),print(`${id}-status`,b('ready','read')),wait(`${id}-b`,800))}
};
