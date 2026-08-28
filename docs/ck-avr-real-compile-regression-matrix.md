# CK AVR 真实编译回归矩阵 v2

> **历史证据快照：**本页的 38-FQBN 资格与生产路由结论绑定旧 EXE `821a2c10…`，不授权
> 后续 EXE。旧 EXE `7b45eccf…` 的精确 Yun 与 Uno 证书同样只是另一份历史快照；
> 不代表当前只兼容两个目标。当前状态以 [FLFE 性能资格与原生底线](ck-forge-flfe-portable-lane.md) 和
> [`Report-CKForgeFastQualifications.cjs`](../scripts/Report-CKForgeFastQualifications.cjs) 输出为准。

## 目的

这套矩阵回答一个具体问题：用户在真实积木工程里连续增加积木后，CK 每次重新编译是否仍然正确、可解释，并且确实比相同 Arduino CLI 更快。

入口：[Run-CKAvrRegressionMatrix.cjs](../scripts/Run-CKAvrRegressionMatrix.cjs)

矩阵通过正在运行的 production 桌面后端调用 CK 普通编译路径，同时用仓库内同一份 Arduino CLI、配置、完整 FQBN、源码字节和并行度运行原生对照。它只做 compile-only，不选择串口、不上传、不写入 Flash，也不证明外设或真板运行行为。

## 固定覆盖范围

本矩阵完整展开本机 `Arduino AVR Boards 1.8.6` 的 `boards.txt`：

- 27 个 board ID；
- 展开所有 `Processor` 菜单后共 38 个完整 FQBN；
- 每个完整 FQBN 独立记录结果，不把 Uno 结论外推给 Nano，也不把 Nano 新旧引导配置合并。

| 板卡组 | 完整 FQBN |
| --- | --- |
| Yún | `arduino:avr:yun` |
| Uno | `arduino:avr:uno` |
| Uno Mini | `arduino:avr:unomini` |
| Duemilanove / Diecimila | `arduino:avr:diecimila:cpu=atmega328`、`arduino:avr:diecimila:cpu=atmega168` |
| Nano | `arduino:avr:nano:cpu=atmega328`、`arduino:avr:nano:cpu=atmega328old`、`arduino:avr:nano:cpu=atmega168` |
| Mega | `arduino:avr:mega:cpu=atmega2560`、`arduino:avr:mega:cpu=atmega1280` |
| Mega ADK | `arduino:avr:megaADK` |
| Leonardo / Leonardo ETH | `arduino:avr:leonardo`、`arduino:avr:leonardoeth` |
| Micro / Esplora | `arduino:avr:micro`、`arduino:avr:esplora` |
| Mini | `arduino:avr:mini:cpu=atmega328`、`arduino:avr:mini:cpu=atmega168` |
| Ethernet / Fio | `arduino:avr:ethernet`、`arduino:avr:fio` |
| BT | `arduino:avr:bt:cpu=atmega328`、`arduino:avr:bt:cpu=atmega168` |
| LilyPad USB | `arduino:avr:LilyPadUSB` |
| LilyPad | `arduino:avr:lilypad:cpu=atmega328`、`arduino:avr:lilypad:cpu=atmega168` |
| Pro / Pro Mini | `arduino:avr:pro:cpu=16MHzatmega328`、`arduino:avr:pro:cpu=8MHzatmega328`、`arduino:avr:pro:cpu=16MHzatmega168`、`arduino:avr:pro:cpu=8MHzatmega168` |
| NG / older | `arduino:avr:atmegang:cpu=atmega168`、`arduino:avr:atmegang:cpu=atmega8` |
| Robot | `arduino:avr:robotControl`、`arduino:avr:robotMotor` |
| Gemma | `arduino:avr:gemma` |
| Circuit Playground | `arduino:avr:circuitplay32u4cat` |
| Yún Mini / Industrial 101 / Linino One | `arduino:avr:yunmini`、`arduino:avr:chiwawa`、`arduino:avr:one` |
| Uno WiFi | `arduino:avr:unowifi` |

`arduino:avr:nano:cpu=atmega328old` 是用户当前场景的精确目标，不以普通 Nano 代替。它使用 ATmega328P、16 MHz、`eightanaloginputs` variant 和旧引导配置；矩阵中的 `mstimer2` 负载对该目标为强制适用，不会跳过。

## 三类真实积木风格负载

1. `core-only-block-style`：定位 marker、数组、引脚和普通控制代码；适用于全部 38 个 FQBN。它不要求硬件串口，因此也能给无 UART 的 ATtiny85 留下基础编译证据。
2. `mstimer2`：真实 `MsTimer2.h` 与 `MsTimer2.cpp` 第三方 Arduino 库；对 37 个 FQBN 适用。MsTimer2 1.1 源码会对 ATtiny85 报 `Unsupported CPU type`，所以 Gemma 明确记为 `expected-skip`。
3. `wire-spi-eeprom`：`Wire.h`、`SPI.h`、`EEPROM.h` 的组合依赖和实际 API 调用；对 37 个 FQBN 适用。Arduino AVR Core 1.8.6 的 Wire/SPI 实现依赖 ATtiny85 不具备的硬件 TWI/SPCR 寄存器，所以 Gemma 明确记为 `expected-skip`。

`expected-skip` 是机器可读的“已知不适用”，不是通过，也不是失败：计划和报告保留该单元、原因及源码哈希，但不启动 CK/CLI 编译，也不清该目标缓存。任何没有声明为 `expected-skip` 的失败仍然使矩阵失败。

默认计划共有：

- 114 个板卡/负载单元（38 × 3）；
- 112 个实际适用单元；
- 2 个预期跳过单元；
- 每轮 896 次真实 compile-only 调用（112 × 4 阶段 × CK/CLI 两条 lane）。

## 编辑序列与等价门禁

每个适用负载都在同一条 lane、同一稳定 build path 内按以下顺序运行：

`simple → complex → medium → simple-return`

`simple-return` 与起点 `simple` 的源码字节及 CK 定位标记完全相同，用于验证工程恢复后的确定性产物。CK 与原生 CLI 在每个阶段收到完全相同的源码字节。

每阶段必须记录并检查：

- 墙钟时间、CK `buildMode`、fallback 和后端分段计时；
- CLI、Core、工具链、完整 FQBN 和 jobs 身份；
- Flash、RAM 和警告数；
- AVR application HEX 与 EEPROM 的角色、大小和 SHA-256；
- CK 与原生 CLI 的源码、资源和产物等价；
- CK Exact 产物回放不得冒充编译。

编辑阶段的矩阵目标是 CK 中位数至少快 25%、至少节省 500 ms，且 p95 不回退。冷启动 `simple` 记录但不参与该性能判定；该矩阵本身不签发 Fast 资格，正式资格仍必须满足策略 v3 的至少 5 个配对 trial。

## 安全与公平控制

- `compile-only=true`，不访问串口、不上传、不写 Flash；
- CK 使用普通 production 路由，`qualification=false`，矩阵自身不能打开未授权 Fast；
- CK 以显式前台 `CompileOnly` 意图调用（`silent=false`）；后台静默预热不继承本证书；
- CK 与原生对照使用相同 bundled CLI、`arduino-cli.yaml`、Core、完整 FQBN、源码和 jobs；
- 两条 lane 严格顺序运行；每条 lane 启动前检测到已有 `arduino-cli` 即失败，避免把外部编译混入样本；
- 每条 lane 结束后执行 `arduino-cli-lane-idle-window-v1`：必须连续 500 ms 观测到零个 `arduino-cli` 进程，最多等待 15 秒、每 100 ms 轮询一次。该等待位于本次编译墙钟计时之外，并把 lane、策略 ID、等待时长和轮询次数写入原始证据；缺失、顺序错误或策略不匹配都会使资格证据失效；
- 每个 trial 只清当前完整 FQBN 的 CK 构建缓存，并保留共享 ccache；
- 默认要求至少 8 GiB 可用空间；脚本只删除自己创建的 `%TEMP%/CKAB/<token>`；
- `qualificationClaimed` 永远为 `false`，矩阵通过不等于签发 NativeRelink 资格证书。

## 使用

只读计划不会编译、不会清缓存：

```powershell
node scripts\Run-CKAvrRegressionMatrix.cjs --plan
```

完整一轮：

```powershell
node scripts\Run-CKAvrRegressionMatrix.cjs `
  --execute `
  --allow-cache-reset `
  --trials 1 `
  --output artifacts\benchmarks\ck-avr-real-matrix-YYYYMMDD.json
```

优先复现 Nano old + MsTimer2：

```powershell
node scripts\Run-CKAvrRegressionMatrix.cjs `
  --execute `
  --allow-cache-reset `
  --target nano-atmega328old `
  --workload mstimer2 `
  --trials 1 `
  --output artifacts\benchmarks\ck-avr-nano-old-mstimer2-YYYYMMDD.json
```

查询 Gemma 的机器可读不适用原因（计划中编译次数为 0）：

```powershell
node scripts\Run-CKAvrRegressionMatrix.cjs --plan --target gemma --workload mstimer2
```

## 38 个精确 FQBN 资格批次

[Run-CKAvrFullQualificationBatch.cjs](../scripts/Run-CKAvrFullQualificationBatch.cjs) 是本矩阵之外的、可中断恢复的资格编排器。它固定读取同一份 38 个完整 FQBN 清单，并对每个 FQBN 独立执行：

1. 5 轮交替配对 `portable-edit` A/B，共 40 次 compile-only 调用；
2. 资格证书落盘并重新复算后，以普通 production 路由运行 1 个 `core-only-block-style` 覆盖单元，共 8 次 compile-only 调用；
3. 把事件追加写入批次状态目录，原始证据和尝试文件均禁止覆盖，因中断恢复时仍会重新核验 production EXE、CLI、Core、工具链和完整 FQBN。

因此完整资格批次的计划量是每个目标 48 次、总计 1824 次 compile-only 调用。它严格串行运行，默认要求 12 GiB 可用空间，不访问串口、不上传也不写 Flash。

资格批次和完整负载矩阵不能互相替代：资格批次回答“这个精确 FQBN 是否可获 NativeRelink 热编辑授权，并且生产路由是否真的使用该证书”；本文件的 112 个适用单元、896 次调用则回答三类真实负载在 38 个 FQBN 上是否编译、等价并达到性能目标。只有两者分别完成，才能同时声称“精确目标已认证”和“AVR 负载矩阵已覆盖”。

## 状态与退出码

| 状态 | 含义 |
| --- | --- |
| `measurementStatus=passed` | 所有适用单元真实编译、等价门禁和清理通过；所有跳过单元均有明确机器可读原因 |
| `measurementStatus=failed` | 缺 Core/库、编译失败、Exact、证据不完整、不等价、并发或清理失败 |
| `performanceTargetStatus=target-met` | 所有适用单元达到编辑性能目标 |
| `performanceTargetStatus=target-not-met` | 证据有效，但至少一个适用单元不够快 |
| `performanceTargetStatus=not-applicable` | 筛选结果只有预期跳过单元，没有执行性能测量 |
| `qualificationClaimed=false` | 永远为 false；矩阵不是证书签发器 |

退出码：

- `0`：证据完整且达到目标，或筛选结果只有有据可查的预期跳过单元；
- `2`：测量完整但至少一个适用单元没有达到性能目标；
- `1`：参数、环境、编译、等价或清理证据失败。

## 2026-07-19 完整实测结果

本轮已完成，不再是待填计划。主报告为
[`ck-avr-full-matrix-exe821a2c10-20260719.json`](../artifacts/benchmarks/ck-avr-full-matrix-exe821a2c10-20260719.json)，
报告 SHA-256 为
`3771c4bea4235912754a595df9f4c553b826fe898c285b443ab10ead70828a66`。
它绑定 production EXE SHA-256
`821a2c10991a68073983b0dc21cc0ceee944b28eba4b59280d769f84494bb2a9`
（43,474,432 bytes）、bundled Arduino CLI 1.4.1、Arduino AVR Boards 1.8.6、当前工具链和每个完整 FQBN；运行前后 EXE 身份一致。

- 覆盖：38 个完整 FQBN、114 个板卡 × 负载单元，其中 112 个适用、2 个 Gemma 单元为有明确原因的 `expected-skip`；实际完成 896 次 compile-only 调用，失败 0。
- 资格与生产路由：独立资格批次为 `38 / 38` 个完整 FQBN 资格通过、0 个资格性能未达、0 个资格证据失败；最终完整矩阵中的 `core-only-block-style` 为 `38 / 38` 通过。r4 原始 [`summary-000001.json`](../artifacts/benchmarks/avr-full-qualification-exe821a2c10-20260719-r4/summaries/summary-000001.json) 仍如实保留早期 Robot Control/Motor 两项 coverage 失败，不能单独当作 `38 / 38` 覆盖结论；两份修复报告、当时 runner/测试/Core/EXE 哈希和最终矩阵的组合关系记录在 [`repair-index`](../artifacts/benchmarks/ck-avr-full-qualification-repair-index-exe821a2c10-20260719.json)。最终完整矩阵已用相同旧 production EXE 对两个精确 FQBN 重新实测并通过全部门禁，因此该旧 EXE 的生产路由覆盖以组合证据的 `38 / 38` 为准，不改写早期原始证据，也不迁移到当前 EXE。
- 完整性：112 / 112 个适用单元的测量、NativeRelink 路由、逐阶段产物与资源等价、`simple-return` 恢复、lane 边界空闲和无 Exact 绕过全部通过；112 个单元均为 `target-met`，`target-not-met` 为 0。
- 路由计数：112 次冷 `simple` 为 `full-build`，336 次热编辑阶段为 `native-relink-compile-only`；CK fallback 为 0，Exact 为 0。上传、串口访问和物理 Flash 写入均为 0。
- 热编辑：336 个 `complex`、`medium`、`simple-return` 配对样本中，CK 时间中位数为 2857.21085 ms，原生 CLI 为 5102.99545 ms；逐配对加速百分比的中位数为 44.271%。最差样本仍快 17.584%、节省 841.856 ms，因此所有适用单元都超过“至少快 10% 且至少节省 500 ms”的门槛。
- 冷编译：112 个 `simple` 样本中，CK 中位数为 9383.6598 ms，原生 CLI 为 7815.367 ms；110 / 112 个样本 CK 更慢。冷编译不参与热编辑资格判定，但该结果明确说明首次编译尚未加速，更没有达到 30%～40% 的首次编译目标。

以上全部是当时本机、该 production EXE、Arduino AVR Boards 1.8.6 和所列完整 FQBN 的 compile-only 证据。它不代表其他 AVR Core 版本，不代表 38 块实体板、引导程序、串口上传或外设运行均已真板验证；也不能从这份热编辑结果宣传“首次编译已达 Fast”。

## 2026-07-20 候选修复后的证据状态

本轮源码候选包含构建稳定性和冷阶段可观测性修改，因此会生成不同字节身份的 production EXE：

- 构建缓存改为外层 build-use 生命周期门禁和内层 cache-budget 操作门禁，固定按 `build-use → budget → board lock` 取锁；前台消费者先发布等待意图，使递归回收可以中止，避免排队 writer 与已有 reader 形成死锁。
- 普通回收和重复低盘回收均受全进程单飞及 10 分钟节流约束；低于 2 GiB 时首轮仍可同步压力回收，显式强制维护可绕过节流，但每次热编译不会重新递归扫描 C 盘。
- 板卡与完整 FQBN 稳定 300 ms 后可机会性启动编译目标预证明；300 ms 是前端防抖。后端只读取本机已安装 Core、`boards.txt`、别名和工具链身份，按完整 FQBN 单飞，不运行 CLI、不编译、不上传、不下载、不写 Flash；结果不授予 Fast，正式编译仍重复权威校验。
- 冷构建诊断新增运行工具预检、Arduino CLI 子进程墙钟、依赖／产物封存、NativeRelink 基线捕获提交、BuildMeta/Core 快照和构建后缓存快照六个结构化毫秒字段。它们用于归因冷阶段，不是新的加速成绩。

因此，2026-07-19 的 `821a2c10…` 报告和 38 个 v4 证书只对该旧 EXE 保持历史有效，不能授权本轮源码候选产生的新 EXE。最终新 production EXE 生成后必须重新运行 38 个精确 FQBN 的资格批次、112 个适用单元的完整矩阵，以及无 qualification token 的普通 production 路由验证；证书必须绑定新 EXE SHA-256。重跑完成前，未持有新 EXE 精确证书的目标必须 fail-closed 使用原生 Release，不能把旧矩阵写成新候选已经通过。

本轮尚无新的公平冷编译 A/B 报告。最近完整冷证据仍是 2026-07-19 矩阵中的 CK 9383.6598 ms 对原生 CLI 7815.367 ms，110 / 112 个 CK 更慢；所以首次／冷编译仍未宣称更快，更未宣称达到 30%～40%。
