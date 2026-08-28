# FLFE 回归证据记录：2026-07-17～18

状态：**本机 compile-only 证据快照，不是公开发布门禁，也不是真板认证**。当前证据绑定
production EXE `53dd76b7…`、三平台交替 A/B 与 C6/STM32 正常 Exact 报告；`7f10e3f8…`、`3fcaf092…`、
`0cce8cd1…`、`1b736151…`、`164729…`、`8442…` 和 `9275…` 的报告全部保留为
历史/previous-candidate 证据。“当前”只表示报告绑定现有 EXE，不表示所有板卡、Core 或配置
都已快速或真板通过。

本记录把同一个 production EXE 会话下的 ESP32 广覆盖矩阵和 STM32 依赖文件回归放在一起，方便后续继续实现 FLFE（**Fast Link For Ever**）。机器可读索引见 [`artifacts/benchmarks/index.json`](../artifacts/benchmarks/index.json)。

## 2026-07-18 当前候选补充（EXE `53dd76b7…`）

当前 production EXE SHA-256 为
`53dd76b738fc510c2e52bee7b91206e2daa57e40615d31efbdf81eb01a5796fa`，大小
`40,997,376` bytes。C6、AVR Uno 与 STM32 F401RE 已各完成 3 组同机、同 CLI、同 Core/FQBN、
同源码的交替配对 A/B，qualification 模式禁用 Exact：

| 目标 | CK fresh / 原生 fresh | CK repeat / 原生 repeat | Fast 裁决 |
| --- | ---: | ---: | --- |
| ESP32-C6 | 42.130 / 42.288 s | 21.599 / 21.015 s | 不合格 |
| Arduino Uno | 6.817 / 6.892 s | 4.894 / 4.542 s | 不合格 |
| STM32 F401RE | 35.444 / 36.565 s | 16.018 / 15.599 s | 不合格 |

三份报告的 `passed` 表示证据采集和等价门禁通过，不表示性能胜出；当前 Fast 资格数为 0，
30%～40% 冷编译目标未达到。正常产品路径另行验证了 C6 `47.378→2.438s` 与 STM32
`42.265→1.648s` 的安全 Exact。Exact 是完整身份和产物一致后的回放，不进入 A/B，也不授予 Fast。
权威当前口径见 [FLFE 性能资格与原生底线](ck-forge-flfe-portable-lane.md) 与
[机器证据索引](../artifacts/benchmarks/index.json)。

该候选还包含有界缓存维护：普通成功响应后的回收离开响应路径，采用单飞、10 分钟节流、
2 秒延迟和前台消费者取消；低于 2 GiB 时同步收紧至最多 512 MiB。维护与编译／上传消费者
经独占／共享门禁互斥，out-of-tree build 容器按直接工程目录淘汰。退出、ENOSPC 幂等重试和
源码／build 成对 LRU 仍按 [后续项](flfe-cache-maintenance-followups.md) 保持 P1。

> **2026-07-18 路由纠偏：**本页以下旧章节的 `force-platform + portable-fast` 均是历史 EXE
> 当时真实发生的路由，只能证明 compile-only 兼容性。后续同机直接 Arduino CLI 诊断发现
> STM32 F401RE、H2、P4 和 Feather S3 的 fresh/repeat 均比原生慢，其中 STM32 为
> `62.644/68.416s` 对原生 `37.608/16.149s`。当前产品已将未通过正式 A/B 资格的
> `force-platform` 改为原生 `release`。历史报告不重写，但不得再据此宣称 PortableFast
> 或 FLFE 已对这些目标提速。绑定 `0cce8cd1…` 的回归已经确认这些目标不再进入 PortableFast；
> 这只证明负优化路由已移除，不授予 Fast 资格。随后 `3fcaf092…` 的 C6 回归同样走
> 原生 Release。最新 runner 还修正了 Core 内置 `WiFi.h` 的依赖门禁：它通过编译命令闭包
> 和资源变化验证加入/移除，而不会伪造用户库命中。早先 `localhost:1420` 无 custom-protocol
> 参数的启动尝试属于失败冒烟，不计入通过证据。

## 历史 `3fcaf092…` C6 WiFi-cycle 证据身份

| 项目 | 值 |
| --- | --- |
| 捕获时 production EXE | `target/release/appsdesktop.exe` |
| 捕获时 EXE 大小 | `40,761,856` bytes |
| 捕获时 EXE SHA-256 | `3fcaf092e83fc55855714c5ae8ea1a11b553d952a7742cb0af2cbb2959094c6b` |
| 回归 runner | `artifacts/benchmarks/Run-CrossBoard-CompileOnly.cjs` |
| runner 大小 | `65,532` bytes |
| runner SHA-256 | `8efba5106ef07e72f69908a463245203d2c15e2010ab6aa3c57273b9d34f8340` |
| CLI | Arduino CLI 1.4.1 |
| 运行边界 | compile-only；未上传、未访问串口、未探测设备、未写 Flash；所有目标 `hardwareTested=false` |

历史 C6 WiFi 依赖循环报告窗口为 `2026-07-17T20:28:28.492Z` 至 `20:31:24.717Z`。
同一 EXE 的 `20:12:34.817Z` simple-only 报告因 runner 早于依赖门禁修复而降为 runner-stale 历史证据。
前一候选 `0cce8cd1…` 的 STM32/五目标兼容窗口为 `19:11:50.627Z` 至 `19:18:17.919Z`；
旧 minimum-v8-final、release-v8-qualified、STM32、C2/C61 和 ESP32 广覆盖窗口继续由各自报告保存。

所有报告均在运行前后重新核对了各自 EXE 和 runner；报告本身的 SHA-256 以及相对路径登记在机器索引中。

## 历史 C6 WiFi 依赖循环：1/1 目标、4/4 阶段

报告：[`ck-forge-20260718-flfe-3fcaf092-c6-wifi-cycle-v2.json`](../artifacts/benchmarks/ck-forge-20260718-flfe-3fcaf092-c6-wifi-cycle-v2.json)，SHA-256
`03f322eaf0a94f598d09c0589e7a2aaf58677d18211d31283b3c467e11f581ee`，`30,132` bytes。

捕获时 production EXE `3fcaf092…` 下，ESP32-C6 `esp32:esp32:esp32c6` 完成 **1/1** 目标、
**4/4** 阶段，全部实际走 `force-platform + release`：没有 CK Exact、ccache、Core cache
或 Fast Relink。首轮前精确移除 1 项缓存（`26,788,199` bytes）。四阶段如下：

| 阶段 | 耗时 | include / 编译闭包 | Flash / RAM |
| --- | ---: | --- | ---: |
| 简单代码 full-build | 49.296s | `Arduino.h`；57 条命令 | 248,986 / 13,260 bytes |
| 加入 Core 内置 WiFi | 73.822s | `Arduino.h` + `WiFi.h`；71 条命令 | 941,082 / 39,964 bytes |
| 移除 WiFi 回到简单代码 | 26.477s | `Arduino.h`；57 条命令 | 248,986 / 13,260 bytes |
| 相同简单代码再编译 | 26.321s | `Arduino.h`；57 条命令 | 248,986 / 13,260 bytes |

每一阶段都有 6 个已校验产物；报告状态 `passed`、`warnings=[]`、`hardwareTested=false`。
`WiFi.h` 属于 ESP32 Core，因此用户库计数保持 0 是正确结果。门禁依据 include、编译命令
闭包和资源变化确认依赖已加入，并在移除后要求命令数与资源总量精确回到初始值；这证明没有
残留依赖，同时不会把 Core 内置组件冒充 Arduino 用户库。

这是历史候选的单轮 compile-only 路由与产物证据，证明当时 C6 没有进入已知负优化的
PortableFast 路径；它不等于相对原生 CLI 的正式性能证书，也不授予 Fast。该报告自身
没有 3 组交替配对 A/B；当前候选虽已另行补齐采集，仍因速度门槛未过而不授予 Fast。

### 同一 EXE 的旧 runner simple-only 报告

[`ck-forge-20260718-flfe-3fcaf092-c6-native.json`](../artifacts/benchmarks/ck-forge-20260718-flfe-3fcaf092-c6-native.json)
仍原样保留，SHA-256 为 `778f024eac2be55ed008fceae44bb2ff518942d76b18a969cb07977f2f404c62`。
它记录 `51.827s` full-build 与 `26.101s` incremental，但绑定旧 runner `fa610a31…`，
未覆盖修复后的 Core 内置依赖循环门禁，因此索引将它标为 runner-stale/historical，
不得再作为当前主证据。

## 前一候选原生 Release 回退：6/6 目标

STM32 报告（previous candidate `0cce8cd1…`）：[`ck-forge-20260718-flfe-0cce8cd1-stm32-native-pure.json`](../artifacts/benchmarks/ck-forge-20260718-flfe-0cce8cd1-stm32-native-pure.json)，SHA-256
`762f5e30c6c7f76b662e4fdec9bedf3eb095013ddc90d8b5317eaade30a90d2d`，`17,411` bytes。

兼容目标报告（previous candidate `0cce8cd1…`）：[`ck-forge-20260718-flfe-0cce8cd1-compatibility-native.json`](../artifacts/benchmarks/ck-forge-20260718-flfe-0cce8cd1-compatibility-native.json)，SHA-256
`044f112ea7108bdd2d956544b550f34a1ce89518cbe00590f630285c5de8239c`，`76,023` bytes。

两份报告共覆盖 **6/6** 个目标、**12/12** 次 compile + 相同源码阶段，全部实际走
`force-platform + release`：没有 CK Exact、ccache、Core cache 或 Fast Relink。首轮是
`full-build`，第二轮是 Arduino CLI 自身 incremental。计时如下，单位为秒：

| 目标 | full-build | 原生 incremental | 产物/依赖 |
| --- | ---: | ---: | --- |
| STM32 Nucleo F401RE | 37.353 | 18.939 | 3 个产物；212/212 条依赖命令 |
| ESP32-H2 | 47.053 | 22.794 | 6 个产物；57/57 条依赖命令 |
| ESP32-P4 | 47.230 | 21.486 | 6 个产物；57/57 条依赖命令 |
| Adafruit Feather ESP32-S3 | 54.424 | 24.314 | 6 个产物；58/58 条依赖命令 |
| Arduino Leonardo | 8.994 | 5.627 | 5 个产物；26/26 条依赖命令 |
| Generic ESP8266 | 27.999 | 11.322 | 2 个产物；84/84 条依赖命令 |

STM32 首轮前执行了精确目标缓存清理，删除 4 项、`4,739,093` bytes，且报告明确记录
`full-build`；五目标兼容报告未请求显式清缓存，所以不能把它们写成正式冷启动样本。
所有目标都完整返回源码指纹、资源统计、依赖闭包和已校验产物，warning 只说明它们不是
CK 内置板卡卡片；全部 `hardwareTested=false`。

与旧 PortableFast 单轮结果相比，已知的大幅负优化不再发生；但这批报告绑定的是前一候选，
不是当前 `53dd76b7…` EXE。它们仍然只是单轮
compile-only 路由回归，**不等于相对原生 CLI 的正式性能证书**，也不建立 P50/P95。
当前候选虽已完成三平台各 3 组交替配对 A/B，但只有中位数收益、p95 和变异门槛也通过后，
对应完整身份才可进入 `allow-fast`；本轮三个目标均未通过。

## 历史 minimum v8 final：7/7

报告：[`ck-forge-20260717-flfe-1b736151-minimum-v8-final.json`](../artifacts/benchmarks/ck-forge-20260717-flfe-1b736151-minimum-v8-final.json)

报告 SHA-256：`db6e319feb227863afa58babd16e2f18b948eacc11fd136636a5adf4878a6e5f`。

历史 `1b736151…` production EXE 下，C3、C5、C6、S3、Nano、Mega、ESP8266 共 **7/7** 目标、
compile/Exact 共 **14/14** 次均成功，且都报告 v8 构建合同与
`builtin-platform-core-qualified`。ESP8266 只有“不是内置 CK 板卡卡片”的预期 warning，
没有构建失败。

本轮缓存已就绪，因此七个目标的 compile 和 Exact 两个阶段都实际报告 `exact-match`；它能证明
该历史 EXE、修正后的资格哈希、缓存身份和产物复用一致，但**不是冷编译性能报告**，不能用这些秒数
代替当前 EXE 的 full-build P50/P95。

### 历史 configuration v8：3/3

报告：[`ck-forge-20260717-flfe-1b736151-configuration-v8-final.json`](../artifacts/benchmarks/ck-forge-20260717-flfe-1b736151-configuration-v8-final.json)，SHA-256
`011e3c63fa5fa3fdf055132563ca0c0020c463afda3e5fc8783a7f4947dfcde2`，`46,227` bytes。

三套高风险菜单配置均完成 compile + 相同源码阶段，**3/3 目标、6/6 次成功**，报告状态为
`passed` 且 `warnings=[]`：

- C5 N16R8 与 S3 16MB OPI 尚无专用完整 FQBN 资格，按预期走
  `force-platform` + `portable-fast`，模式为 `full-build` → `arduino-cli-incremental`。
- C6 16MB `app3M_fat9M_16MB` 已有单独的完整 FQBN 资格，按预期走
  `allow-fast` + `quick-fast`；compile 为 Arduino CLI incremental，第二阶段命中 Exact Match。

因此“configuration 按预期”不能简写成三项都走 PortableFast；实际路由必须以每个完整 FQBN
的资格证据为准。

### 历史 compatibility v8：5/5

报告：[`ck-forge-20260717-flfe-1b736151-compatibility-v8-final.json`](../artifacts/benchmarks/ck-forge-20260717-flfe-1b736151-compatibility-v8-final.json)，SHA-256
`5abf31a07cd8b5fd6d413df7161673d6a786c281a63542da65a2f5216da3d4e2`，`76,467` bytes。

H2、P4、Adafruit Feather ESP32-S3、Arduino Leonardo 与 Generic ESP8266 共 **5/5** 目标、
**10/10** 次 compile + 相同源码阶段成功。五项都按预期走 `force-platform` +
`portable-fast`，模式为 `full-build` → `arduino-cli-incremental`，没有偷用 CK Exact 或
Fast Relink。报告为 `passed-with-warnings`；五条 warning 都只说明目标不是 CK 内置板卡卡片，
不是构建错误。

configuration 与 compatibility 都绑定历史 `1b736151…` EXE；索引保留原报告与哈希，
但不再把它们列为当前证据。

### 历史 STM32 F401RE supplemental

身份复用报告：[`ck-forge-20260717-flfe-1b736151-stm32-f401re-final.json`](../artifacts/benchmarks/ck-forge-20260717-flfe-1b736151-stm32-f401re-final.json)，SHA-256
`73a6b32c9c1f578b7383e4416484a467fe763efd63bb9fbe841f87dc45a4e532`，`17,121` bytes。

STM32 Core `2.12.0`、`STMicroelectronics:stm32:Nucleo_64:pnum=NUCLEO_F401RE` 在
`force-platform` + `portable-fast` 下两次成功，耗时 `71.679s` → `66.877s`，两次实际
模式均为 `arduino-cli-incremental`，因此不是 CK Exact。每次都记录 212 条依赖命令和
3 个已校验产物（HEX、BIN、ELF）。报告为 `passed-with-warnings`；唯一 warning 只说明
该目标不是 CK 内置板卡卡片。该结果同样是 compile-only、`hardwareTested=false`。

历史冷构建报告：[`ck-forge-20260717-flfe-1b736151-stm32-f401re-cold-build-final.json`](../artifacts/benchmarks/ck-forge-20260717-flfe-1b736151-stm32-f401re-cold-build-final.json)，SHA-256
`5ec2fac5752318f1d9106bccb422dbed62b7e599e2683a20b0415fcb6d65a6af`，`17,225` bytes。
运行前只移除了该目标的 pfast2 build 目录；报告随后明确记录 `full-build` 以及
`build_path_missing`/Core/产物身份 miss。首轮为 `62.644s` full build，第二轮为
`68.416s` Arduino CLI incremental；两轮仍均为 PortableFast/force-platform、212 deps、
3 个已校验产物。第二轮反而慢 `5.772s`（约 9.21%），所以该单次样本证明“真 full build
后可继续增量”，但**不能**证明本轮增量有性能收益，也不能代替 P50/P95。索引将它登记为
historical cold performance evidence，并保留上面的 71.679→66.877 身份复用报告。

另存的 [`ck-forge-20260717-flfe-1b736151-stm32-f401re-cold-final.json`](../artifacts/benchmarks/ck-forge-20260717-flfe-1b736151-stm32-f401re-cold-final.json)
（SHA-256 `86fd5a0ddab5543ca405b5cda05afe76cffc192408cda93a37d7fe1513c0b22c`）只作为
`--cold` 诊断：缓存清理虽然被请求并验证，但实际删除 **0 项 / 0 bytes**，且两次仍是
Arduino CLI incremental（`69.294s` / `67.921s`）。因此它明确排除在冷编译主证据之外，
不能因为命令带 `--cold` 就写成真冷样本。

## 历史 release v8：11/11 资格哈希修复

报告：[`ck-forge-20260717-flfe-9275ab99-release-v8-qualified.json`](../artifacts/benchmarks/ck-forge-20260717-flfe-9275ab99-release-v8-qualified.json)

报告 SHA-256：`ac7e6347105d5b78069f79cdb7e259fe830e036b6db6ad4e9e3a5c4ac8b00eb8`。

该报告绑定历史 EXE `9275ab9973bd106e4d1d08209d4e81d6c67ecbdf7632a85fd660422d97b12196`。
C3/C5/C6/S3/S2/ESP32、Uno/Nano/Mega/Diecimila、ESP8266 共 **11/11** 目标均完成
full-build compile 与 Exact，合计 **22/22** 次成功；所有目标都命中
`builtin-platform-core-qualified`，证明旧资格清单的工具链哈希修复在 v8 路由上有效。
ESP8266 仍只有预期 warning。由于随后 Cargo test 后重新 production build，9275 报告已降为
historical，不能冒充当前 `53dd76b7…` EXE 的 11/11 绑定。

## 历史 STM32 pfast2：response-file 护栏（EXE 8442）

报告：[`ck-forge-20260717-flfe-8442d108-stm32-pfast2-response-guard.json`](../artifacts/benchmarks/ck-forge-20260717-flfe-8442d108-stm32-pfast2-response-guard.json)

报告 SHA-256：`b2d3c1ebd1066d4bf518ac7baa5e1a942a396e906ebed449975d4869cf94622c`。

目标为 `STMicroelectronics:stm32:Nucleo_64:pnum=NUCLEO_F401RE`、Core `2.12.0`。pfast2
合同为 `ck-fast-build-contract-v8:command-scoped-ccache-O1-final-g0-no-lto-expanded-ccdb-core-deps-portable-response-guard`；冷编译 `88.626s`，第二次相同源码为 `73.435s`，两次依赖文件闭包均为 **212/212**，模式为 `full-build` → `arduino-cli-incremental`。

response guard 已观察到相同内容的 `build.opt` 在原生 prebuild 后恢复 mtime；它消除了时间戳变化造成的额外 churn，但 Arduino CLI/工具链自身的耗时下限仍约 **73s**，本轮改善约 **17.14%**，没有达到 30%～40% 首次编译目标。该结果是 compile-only、`hardwareTested=false`，不等于 STM32 真板资格。

## 历史 C2/C61 runtime preflight（EXE 8442）

报告：[`ck-forge-20260717-flfe-8442d108-c2-c61-preflight.json`](../artifacts/benchmarks/ck-forge-20260717-flfe-8442d108-c2-c61-preflight.json)

报告 SHA-256：`562761fbea3541e5a2f510647ef8bec054a1fe4def647c6e535d724207f0e1e6`。

历史 8442 EXE 会在 Arduino CLI 前执行 runtime 预检：C2 用时 `6.507s`，C61 用时 `6.803s`，两者均因 `runtime.tools.esp32c2-libs.path` / `runtime.tools.esp32c61-libs.path` 未解析而确定性阻止，**没有启动 Arduino CLI**。`boards.txt` 的 `hide=true` 只作为解释信息，不是 blocker。该门禁改善了失败反馈速度和可解释性，但缺少 runtime 包仍不是“板卡不兼容”或成功编译证据。

## 历史 ESP32 Core 3.3.6：七目标广覆盖（旧 EXE）

报告：[`ck-forge-20260717-flfe-16472947-esp32-broad-seven-cold-repeat.json`](../artifacts/benchmarks/ck-forge-20260717-flfe-16472947-esp32-broad-seven-cold-repeat.json)

报告 SHA-256：`9c6d751834b910fcb3c2ecd7907eb540fcb7871f37ee88258fa5f02e8f9eb13e`。

五个目标完成了 PortableFast 的冷编译和相同源码的 Exact（这里的 Exact 是 Arduino CLI 增量重编译，不是 CK Fast Relink）；两个目标在平台产物工具缺失处被阻止。成功计时如下，单位为秒：

| 目标 | 完整 FQBN | 路由 | 冷编译 | Exact/增量 | 结果 |
| --- | --- | --- | ---: | ---: | --- |
| C3 2MB minimal | `esp32:esp32:esp32c3:FlashSize=2M,PartitionScheme=minimal` | `force-platform` → `portable-fast` | 107.186 | 60.187 | 通过 |
| S3 32MB OPI | `esp32:esp32:esp32s3:FlashSize=32M,PartitionScheme=app5M_little24M_32MB,PSRAM=opi` | `force-platform` → `portable-fast` | 117.605 | 77.696 | 通过 |
| Adafruit Feather C6 | `esp32:esp32:adafruit_feather_esp32c6` | `force-platform` → `portable-fast` | 121.591 | 54.312 | 通过（警告） |
| SparkFun S3 Thing Plus | `esp32:esp32:sparkfun_esp32s3_thing_plus` | `force-platform` → `portable-fast` | 92.272 | 56.602 | 通过（警告） |
| ESP32 WROVER | `esp32:esp32:esp32wrover` | `force-platform` → `portable-fast` | 90.384 | 55.937 | 通过（警告） |

### C2/C61 的明确边界

- `esp32c2:FlashSize=2M,PartitionScheme=minimal` 在 `esptool elf2image` 阶段找不到 `esp32c2-libs\\bin\\bootloader_qio_60m.elf`。
- `esp32c61:FlashSize=8M,PartitionScheme=default_8MB,PSRAM=enabled` 在同一阶段找不到 `esp32c61-libs\\bin\\bootloader_qio_80m.elf`。
- 本机 ESP32 Core 3.3.6 的 `boards.txt` 虽然声明这两个目标，但同时标记了 `esp32c2.hide=true` / `esp32c61.hide=true`；当前安装的 runtime tool package 也没有对应目录/引导文件。因此这不是 FLFE 主动拒绝、也不是实体板不兼容结论，而是“隐藏目标 + 安装内容不足”导致的 compile-only 阻止。修复/补齐对应 runtime libs 后必须重新跑完整报告，不能沿用这次失败结果。
- 该报告总体状态为 `failed`，原因是七目标门禁要求全部成功；不能把“五个成功”改写为“七目标全绿”。

## 历史 STM32 depfile 回归（旧 EXE）

报告：[`ck-forge-20260717-flfe-16472947-stm32-depfile-fix-repeat.json`](../artifacts/benchmarks/ck-forge-20260717-flfe-16472947-stm32-depfile-fix-repeat.json)

报告 SHA-256：`5b395e6c78565afe99924aa2922920eb0af7555e65a653a41181eeac17a78112`。

目标为 `STMicroelectronics:stm32:Nucleo_64:pnum=NUCLEO_F401RE`、Core `2.12.0`。冷编译与相同源码重编译都成功，依赖闭包每次均为 **212/212** 条编译命令；耗时由 `91.955s` 降到 `74.727s`，改善 **18.74%**（约 18.7%）。因此本次证明了 depfile 解析/闭包完整性和可重复成功，但尚未达到 FLFE 期望的 30%～40% 首次编译改善目标。

### 历史报告中的 response-file 护栏状态

旧 EXE 的报告只观察到 `prebuild.sh` 重写 `build.opt`，因此当时不能把护栏写成已完成。最终 pfast2
报告已补上“同内容恢复 mtime”的证据，但仍只覆盖 STM32 这一条 PortableFast 路径；内容变化不复用、helper 失败不阻断以及其他 Core 的等价回归仍需继续保持独立门禁。

## FLFE 口径与后续资格

1. **PortableFast 兼容不等于 Fast。** 本页证明的是旧实验通道能按 Core 规则完成若干 compile-only；直接对照已发现性能回退，因此它不再是当前未资格目标的默认路由。当前承诺是合法目标可解析并走原生 Release，只有 A/B 不回退通过后才启用 Fast。
2. **QuickFast/SharedFast 是专用资格，不是板型白名单的推断。** 只有完整 canonical FQBN、Core/CLI/工具链内容身份和构建合同全部匹配，并有独立对照证据时才可升级。历史 9275 release-v8 曾证明修正资格哈希后的 11 个基准目标可走 `allow-fast`；历史 1b736 minimum 只重新绑定其中 7 个目标。当前 `53dd76b7…` 的 C6/AVR/STM32 A/B 均未过 Fast 门槛，不能把旧 7/7、11/11、报告 `passed` 或单个 Exact 命中外推到当前 EXE 的完整矩阵。
3. **跨 Core 3.3.7 仍待验证。** 当前证据只绑定 ESP32 Core 3.3.6、STM32 Core 2.12.0 和本机 Windows 工具链；不能从 3.3.6 外推 3.3.7 或其他 Core 版本。新版本先走原生 Release，完成独立正确性与性能资格后再考虑专用路径。
4. **compile-only 不是真板证据。** 本记录不能证明上传握手、实体 Flash/PSRAM、引脚、电气、串口或运行时行为。

## 下一次回归要求

- 补齐/修复 C2、C61 对应 Core runtime libs 后，再重跑七目标，保留 preflight 失败报告而不覆盖历史文件。
- 继续验证 response-file helper 的内容变化不恢复、helper 失败不阻断原生编译，并扩展到其他非 ESP32 Core。
- 当前 `53dd76b7…` 已有 C6/AVR/STM32 三组交替配对 A/B，但三个目标的裁决都是 `not-qualified-fast`。继续优化后必须在同一完整身份上重新采集，不能只改汇总或沿用本轮有效但未达速的报告。
- 使用同一 production EXE 重新验证 Core 3.3.7（至少一个 ESP32 目标）并单独记录兼容性；只有配对原生 CLI A/B 门禁通过后才记录快速资格。
