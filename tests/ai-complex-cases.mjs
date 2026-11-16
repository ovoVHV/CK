// Requirements fixed before model execution. No solution code is supplied.
export const complexCases = [
  {
    id: 'hysteresis-safety', title: '双周期采样与滞回安全控制',
    prompt: `为 Arduino Uno 生成完整可编辑积木：A0 接 0–1023 模拟量传感器，D9 接高电平有效的输出指示器（只验证逻辑，不连接实际负载），D8 接按钮且按下接地，启用内部上拉。每100毫秒采样一次A0：数值>=700时打开D9，<=600时关闭，601–699保持原状态；但数值<=5或>=1018是传感器异常，必须关闭输出。D8按下时每轮loop都必须立即关闭D9，不得等采样；按钮放开后，下一个正常采样可以按以上滞回规则恢复。启动时输出关闭。串口115200，每1000毫秒单独输出最近采样值，不能因为串口定时而少采样。所有计时非阻塞，不用delay、阻塞等待或自定义代码积木。保留现有setup/loop容器，使用必要的全局状态。请直接提交完整积木方案。`,
    requirements: ['100ms sampling', '>=700 on and <=600 off with hysteresis', '<=5 or >=1018 sensor fault off', 'D8 active-low immediate interlock', 'startup off', 'independent 1000ms telemetry', 'nonblocking', 'editable blocks'],
  },
  {
    id: 'traffic-emergency', title: '带急停恢复的交通灯状态机',
    prompt: `为 Arduino Uno 生成完整可编辑积木：D8红灯、D9黄灯、D10绿灯都高电平亮，D2急停按钮按下接地，内部上拉。上电红灯亮，红3秒→绿4秒→黄1秒→红3秒循环，任意时刻恰好亮一盏。D2按下必须每轮loop立即强制红灯，绿黄熄灭；持续按住保持红。松开急停后必须重新完整计时红灯3秒，再进入绿灯，不能继续急停前的旧计时。D13另做每250毫秒翻转一次的心跳，急停时心跳也正常运行。全程使用非阻塞millis计时或非阻塞定时积木，不用delay/阻塞while/自定义代码块；考虑millis回绕，用无符号时间差。保留现有setup/loop容器，提交完整积木方案。`,
    requirements: ['red3000-green4000-yellow1000 state machine', 'one active traffic light', 'active-low immediate emergency red', 'release restarts complete red interval', 'independent 250ms heartbeat', 'nonblocking', '32-bit timer rollover', 'editable blocks'],
  },
  {
    id: 'ring-buffer-filter', title: '环形缓冲采样与阈值报警',
    prompt: `为 Arduino Uno 生成完整可编辑积木：每20毫秒采样A0，使用长度8的全局数组和循环下标实现最近8次的移动平均。启动不足8个样本时，只除以已收到的真实样本数，不能被初始零值拉低；满8次后正确覆盖最旧样本，不能越界，平均值可以整数取整。平均值>=600时点亮D13，<=400时熄灭，中间保持之前状态。串口115200，每200毫秒独立输出一次当前平均值。启动时D13灭。用非阻塞定时，不能delay/阻塞等待/自定义代码积木。采样、数组、求和/均值、判断和串口操作都必须是可编辑积木，可使用函数减少重复。保留现有setup/loop容器，请提交完整方案。`,
    requirements: ['20ms sampling', '8-slot ring buffer', 'partial-fill divisor equals valid samples', 'wrap replaces oldest without out-of-range indexing', 'mean hysteresis >=600 on <=400 off', 'independent 200ms telemetry', 'nonblocking', 'editable blocks'],
  },
];

// Same final controller requirements, explicitly evaluated as a multi-turn workflow.
// These instructions give the model requirements, not a block tree or source solution.
export const stagedControllerCases = [
  { id: 'controller-stage1', projectId: 'staged-controller', title: '分步控制器：采样与遥测',
    prompt: `Arduino Uno 控制器第一步：A0接模拟量，D9高电平有效输出，D8按钮按下接地。请用可编辑积木完成初始化D9输出且关闭，D8输入上拉，串口115200；声明全局int sensorReading=0和bool outputOn=false。loop里每100毫秒非阻塞采样A0保存到sensorReading，每1000毫秒独立打印sensorReading。不要delay，不用自定义代码。现在只做采样与遥测，暂不做阈值控制。保留原setup/loop。当前接口每轮最多6个工具调用、单次最多24个，请按需要分批查询并直接提出方案。`, requirements: ['sensor sample100ms','telemetry1000ms','startup off','nonblocking'] },
  { id: 'controller-stage2', projectId: 'staged-controller', title: '分步控制器：滞回控制',
    prompt: `在已有控制器上继续第二步，保留采样和串口及两个定时周期。每次100毫秒采样获得sensorReading之后：值>=700把outputOn置true，值<=600置false，601–699保持原值；根据outputOn输出D9。只改控制逻辑，其他积木不要删。继续只用可编辑积木，不用delay或代码块。每轮最多6个工具调用，单次最多24个，请分页读取已有工程、只查必要类型。`, requirements: ['>=700 on','<=600 off','601..699 preserve state','existing acquisition and telemetry retained'] },
  { id: 'controller-stage3', projectId: 'staged-controller', title: '分步控制器：故障与急停',
    prompt: `在已有控制器上做最后一步安全逻辑，保留正常滞回、100毫秒采样和1000毫秒遥测：sensorReading<=5或>=1018时必须清除outputOn并关闭D9，优先级高于阈值打开。D8按钮按下接地，每轮loop立即清除outputOn并关闭D9，不能等采样周期；按住时不能被采样逻辑重新打开。按钮松开后下个正常采样允许按原滞回规则恢复。不要delay或代码块，不清空工程。每轮最多6个工具调用、单次最多24个，按需要分页读工作区并局部修改。`, requirements: complexCases[0].requirements },
];
