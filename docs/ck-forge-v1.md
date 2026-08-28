# CK Forge v1：跨板构建底座与回归入口

版本：1。状态：Stable local。更新时间：2026-08-25。

当前 production EXE、证书数量和 Fast 授权目标不由本文固定保存；请运行
`node scripts/Report-CKForgeFastQualifications.cjs --format text` 查询。本文中的
EXE SHA-256、测速和资格列表若未明确标注为当前，均按历史快照处理。

CK Forge（CK 锻造引擎）是 CK 的跨板构建编排与安全路由底座，机器身份为 `ck-forge/v1`。FLFE（**Fast Link For Ever**）是它的跨 Core 性能优化方向。CK Forge 负责在“已认证快速路径”和“未修改的原生 Arduino CLI 路径”之间安全路由、管理缓存证据并编排跨板回归，但**不是新的编译器、云端 CI 服务或真板认证中心**。

`QuickFast`、`Exact Match`、`Fast Relink`、`SharedFast` 和完整构建仍是 CK 编译核心的内部合同。CK Forge v1 只观察并记录实际路径，不重命名、不替换，也不强迫某种命中结果。

## 0. 产品目标与兼容路由

> 资格清单格式已升级为 schema v2（历史文件名保留 `.v1.json` 仅为路径兼容）。
> v2 将普通性能证据按 `operation + candidateProfile` 唯一绑定，并绑定实际
> production EXE SHA-256 与 Core/tool 内容 SHA-256；NativeRelink 使用更严格的 v4 本机
> 证书，再额外绑定 adapter/engine、原始 A/B 报告与产物证据。schema v1 或
> NativeRelink v3 证据都会 fail-closed，不能自动迁移。

> **历史资格快照：**production EXE
> `7b45eccf6dabbb4a23ebac269c7f8c1f1a04d1cf9a59e7acb5a4fe7fc7453476`
>（44,863,488 bytes）按本机证书重新复算后，只有精确 `arduino:avr:yun` 与
> `arduino:avr:uno` / AVR Core 1.8.6 获得 `native-relink-compile-only` 热编辑资格。
> 该历史 EXE 的 ESP32 Fast 资格为 0；MKR Zero 资格只绑定旧 EXE `fe1450c5…`。
> 当前更严格的 lane-boundary/四阶段评估器会拒绝上述两份旧证书，因此按现行规则复算为 0；
> 它们只用于说明历史过程，不能再显示成当前 Fast。
> 两个历史目标的冷基线分别慢于原生 3.18% 和 26.40%，所以不授予首次编译资格；其他
> 板卡/Core/菜单/operation 继续走原生 Release。候选身份清单和 Exact 产物回放均不授予 Fast。
> 正在运行或新构建 EXE 的资格必须由 `Report-CKForgeFastQualifications.cjs` 动态复算，
> 不得沿用本段历史数量。

ESP32 C3/C5/C6/S2/S3/H2/P4 与 Adafruit Feather ESP32-S3 等目标不是“只支持两个板”的
例外逻辑。它们都可以进入同一
受控 A/B 探针，但必须分别按主机、最终 EXE、CLI、Core/tool 内容、完整 FQBN、profile 和
operation 产生证据。探针或候选文件生成成功不等于获得 Fast 资格；只有独立门禁通过并
安装精确证书后，普通产品路由才会改变。未完成时应显示“Fast 待验证”，不是“不兼容”。

CK Forge 的优先级固定为：构建正确性、可解释降级、跨板兼容，最后才是速度。

- `产物直达`：源码、完整 FQBN、Core/工具链、依赖与产物证据完全相同，使用 Exact Match。
- `持证热构建`：v4 本机证书精确匹配后，由证书指定的 adapter 只编译变化部分并重新链接；缺证或任一身份变化就走原生安全构建。
- `原生安全构建`：未知板卡、未知/更新 Core、Core 内容变化、未验证菜单组合或性能资格证据不足时，使用 Release；保持 Arduino Core 的原生 hooks/recipes 和工具调用，不注入 CK 加速变换，也不标记为 Fast。

缺少专用资格不是失败或阻止。第三方板卡即使没有 CK Fast Relink 资格也必须能够按原生 Core 规则编译；但 CK 不再把“能够编译”包装成“通用加速”。普通上传、普通编译和后台任务遇到 `force-platform` 时直接使用 Release，不会尝试 PortableFast、QuickFast 或 SharedFast。

`force-platform` 的真实编译严格对应 Release：禁用 Fast Relink CCDB、旧对象直链、ccache compiler shim 和 PortableFast 私有 build path，让 Arduino CLI 按当前 Core 的原生依赖发现、hooks、链接和产物规则执行。编译器启动前仍可对源码、完整身份、依赖闭包、资源和产物集合完全相同的结果执行安全 Exact 回放；这项回放不改变 `force-platform` 决策、不授予 Fast，性能 A/B 会显式禁用它。升级时只会删除与旧 CK 模板逐字一致的历史覆盖文件；未知或用户自定义 `platform.local.txt` 保留，并使目标继续走原生链路。PortableFast 只作为历史实验 profile 保留；由于 STM32 F401RE、H2、P4 和 Feather S3 的直接对照均慢于原生 CLI，它不再是未资格目标的默认产品路由。

成功编译或上传后的普通缓存维护不再占用响应路径：全进程单飞、10 分钟节流、延迟 2 秒，
前台缓存消费者出现时取消；低于 2 GiB 可用空间时同步回收到最多 512 MiB。维护与编译、
暖机、上传和恢复通过独占／共享门禁互斥，`CK_Builds/build` 只按直接工程目录淘汰而不删除
共享容器。退出协调、ENOSPC 幂等重试和源码／build 成对 LRU 仍按
[`flfe-cache-maintenance-followups.md`](flfe-cache-maintenance-followups.md) 留作 P1。

快速资格绑定的是**完整 canonical FQBN**，不是基础板型。canonical FQBN 由 `package:architecture:board` 和全部菜单键值组成；菜单键按键名不区分大小写排序，重复键或不完整键值视为无效。仅仅命中同一个基础板型，不能继承另一个 Flash、PSRAM、分区、USB、CPU 或频率组合的资格。

v1 仍保留机器可读的 [`ck_forge_qualified_targets.v1.json`](../apps/desktop/src-tauri/src/ck_forge_qualified_targets.v1.json) 与 [`ck-forge-qualification-manifest.schema.json`](schemas/ck-forge-qualification-manifest.schema.json)，用于描述历史专用路径的**静态兼容候选边界**。下表不是当前性能资格、不是兼容上限，也不能仅凭命中就启用 Fast；当前运行时还必须取得与最终 EXE 和完整环境一致的本机性能证书。清单以外的完整 FQBN 不会被基础板型泛化授予 direct-link 候选，清单以内但无有效证书的目标同样进入原生 Release：

| Core | 完整 canonical FQBN |
| --- | --- |
| ESP32 3.3.6 | `esp32:esp32:esp32` |
| ESP32 3.3.6 | `esp32:esp32:esp32s2` |
| ESP32 3.3.6 | `esp32:esp32:esp32s3` |
| ESP32 3.3.6 | `esp32:esp32:esp32c3` |
| ESP32 3.3.6 | `esp32:esp32:esp32c5` |
| ESP32 3.3.6 | `esp32:esp32:esp32c6` |
| ESP32 3.3.6 | `esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB` |
| Arduino AVR 1.8.6 | `arduino:avr:uno` |
| Arduino AVR 1.8.6 | `arduino:avr:nano` |
| Arduino AVR 1.8.6 | `arduino:avr:nano:cpu=atmega328` |
| Arduino AVR 1.8.6 | `arduino:avr:mega` |
| Arduino AVR 1.8.6 | `arduino:avr:mega:cpu=atmega2560` |
| Arduino AVR 1.8.6 | `arduino:avr:diecimila` |
| Arduino AVR 1.8.6 | `arduino:avr:diecimila:cpu=atmega328` |
| ESP8266 3.1.2 | `esp8266:esp8266:nodemcuv2` |

命中上述完整 FQBN 仍不是充分条件。历史静态候选还要求绑定：

- 当前构建合同 `ck-fast-build-contract-v9:command-scoped-ccache-native-file-paths-O1-final-g0-no-lto-expanded-ccdb-core-deps-portable-response-guard`；
- Arduino CLI `1.4.1`；
- 表中精确 Core 版本及其实际平台内容；
- 当前关键编译工具及 Core 平台生成器的可迁移强内容身份；其 schema 为 `ck_toolchain_cache_key_v13_portable_inputs`。用户名、盘符、安装记录和其他 Core 产生的全局 ccache shim 不属于编译输入；CLI、ccache 本体、Core 配置/源码及实际选中的编译器、SDK 仍逐内容绑定。

这里的版本号属于不同合同，不能混用：Fast/build 当前标记为 `v9`，工具链强内容身份 schema 为 `ck_toolchain_cache_key_v13_portable_inputs`。历史报告中的 `v6`/`v7`/`v8` 快速构建标记只能作为旧候选证据，不能匹配当前资格清单；内部 Core 快照即使仍有独立的 schema 版本，也不等于 CK Forge 当前构建合同版本。

任一专用身份缺失、变化或不匹配都得到 `force-platform` 并使用原生 Release。同一 Core 下未列出的板型、新 Core 版本、原地修改过的 Core/工具链，以及未列出的菜单组合也遵循这一规则。它们仍可正常构建，但没有资格执行或展示未经 A/B 证明的 Fast Relink、direct link、ccache shim 或私有增量缓存。

当前本机证书来自 Windows 环境。macOS/Linux 即使 Core 名称和版本相同，也不能继承 Windows 的 NativeRelink 资格；在建立各自操作系统、最终 EXE 和完整身份的独立正确性与性能资格证据前使用平台 Release。

本机资格接口已经接入产品只读 loader，并精确绑定完整 canonical FQBN、Core 版本、Arduino CLI、工具链内容、production EXE、adapter/engine 和构建合同。历史 EXE `7b45eccf…` 的 `arduino:avr:yun` 与 `arduino:avr:uno` / Core 1.8.6 证书目录键分别为 `7d0f3abb…` 与 `7ff683e3…`；它们不授权其他 EXE。运行时复算全部引用和哈希后才授权。v1 仍不会把“板卡护照编译通过”或静态候选身份直接升级为快速资格：它们不能替代同身份原生 A/B。第三方目标必须建立自己的 adapter、产物等价策略和独立证书，不能继承芯片家族或基础板型的资格。

当前 5 轮正式 A/B 的三个热编辑阶段结果为：Yun 快 58.91% / 59.10% / 58.71%，
Uno 快 48.71% / 46.48% / 47.72%。两份报告均为 `qualified-native-relink`，但冷
`simple` 分别慢 3.18% / 26.40%；因此这些数字只支持热编辑资格，不能宣传首编加速。
可用 [`Report-CKForgeFastQualifications.cjs`](../scripts/Report-CKForgeFastQualifications.cjs)
从本机证书目录按 EXE 哈希重复复算。旧 Uno/MKR Zero 正式报告继续作为历史证据保留，
不授权当前 EXE。

持久化身份缓存只用于缩短 Core、平台配置、分区和关键工具的身份扫描。缓存命中不授予、扩大或继承快速资格；相关文件新增、删除、重命名、等长替换或缓存损坏时必须回到强内容扫描并重算身份。用户库和工程依赖仍由各自的递归失效规则处理，不能借身份扫描缓存绕过依赖校验。

Windows production 实测中，ESP32 各芯片目标的首次强内容身份校验约 8.8～10.2 秒，随后跨进程元数据复核约 1.3～1.6 秒；其中 C6 16MB 的一次真冷测量为 `10.042s / StrongContent`，紧接复核为 `1.470s / PersistentMetadata`。AVR 热复核约 0.25～0.38 秒，ESP8266 约 0.54 秒。该结果只描述身份预检，不等同于完整编译用时，也不是其他机器的 P50/P95。

性能目标不是对所有陌生平台承诺固定秒数：

- 已就绪目标的 Exact 参考目标：ESP 系列约 5 秒以内，AVR/ESP8266 约 3 秒以内；
- 热编辑必须比平台路径稳定缩短至少 30%，否则不应启用；
- 通过资格验证的首次编译继续以稳定缩短 30%～40% 为目标；
- 未通过专用资格验证的目标以“原生 Release 正确完成、未注入加速变换且不跨身份误复用”为验收标准；只有通过独立 A/B 不回退门禁后才可记录为 Fast。

性能资格的配对采集、完整认证键和固定阈值以
[`ck-forge-performance-no-regression-gate.md`](ck-forge-performance-no-regression-gate.md)
为准。当前策略 v3 的硬门槛为至少 5 个交替配对 trial、每个受认证阶段相对原生 Arduino CLI
至少快 25%、至少节省 500 ms 且 p95 不回退。兼容性回归只证明“能正确构建”，不能代替与原生 Arduino CLI 的速度对照。

## 1. 稳定入口与默认安全行为

在仓库根目录执行：

```powershell
node .\scripts\Run-CKForgeRegression.cjs
```

无参数时只显示帮助并明确输出“没有启动回归”。它不会连接 CK、编译、清缓存、打开串口、探测设备、上传或写 Flash。

查看机器可读目标目录，同样不会编译：

```powershell
node .\scripts\Run-CKForgeRegression.cjs --list
```

只生成执行计划：

```powershell
node .\scripts\Run-CKForgeRegression.cjs `
  --plan `
  --matrix minimum `
  --output .\artifacts\forge\minimum-candidate.json
```

真正运行必须显式给出 `--execute`、目标矩阵和一个尚不存在的 JSON 输出路径：

```powershell
node .\scripts\Run-CKForgeRegression.cjs `
  --execute `
  --matrix minimum `
  --output .\artifacts\forge\minimum-20260717.json
```

输出文件永不覆盖。稳定入口先拒绝已有文件，底层 harness 发布时仍以 no-clobber 原子方式落盘。编译会正常填充 CK build cache，但默认不删除任何缓存。

只有同时写出两个参数才允许清理所选完整 FQBN 的 first-project 缓存：

```powershell
node .\scripts\Run-CKForgeRegression.cjs `
  --execute `
  --matrix minimum `
  --cold `
  --allow-cache-reset `
  --output .\artifacts\forge\minimum-cold-20260717.json
```

`--allow-cache-reset` 是 CK Forge 的二次确认，不传给编译核心；缓存清理的真实范围仍由原生报告记录。高级彻底刷新、全局 ccache 清空和上传均不属于该入口。

## 2. v1 目标矩阵

| 矩阵 | 目标 | 用途 |
| --- | --- | --- |
| `minimum` | C3、C5、C6、S3、Nano、Mega、ESP8266 | 日常候选的最小跨架构 compile-only/Exact 烟测 |
| `dependency` | C6、Nano、ESP8266 | 分别使用 WiFi、SPI、ESP8266WiFi 做依赖加入与移除闭环；必须另加 `--dependency-cycle` 才真正执行依赖阶段 |
| `release` | C3、C5、C6、S3、S2、经典 ESP32、Uno、Nano、Mega、Diecimila、ESP8266 | 本机已安装 Core 能覆盖的完整发布候选 compile-only 矩阵 |
| `configuration` | C5 N16R8 菜单配置、C6 16MB、S3 16MB + OPI PSRAM | 取自本机 ESP32 Core 3.3.6 的高风险 compile-only 样本；只有列入完整 FQBN 资格清单且证据有效的 C6 16MB 组合可进入专用路径，其余组合使用原生 Release |
| `compatibility` | H2、P4、Adafruit Feather ESP32-S3、Arduino Leonardo、Generic ESP8266 | 已安装但不在 v1 专用资格清单中的跨架构原生兼容哨兵；必须得到 `force-platform` 并使用 `release` |

也可以用 `--targets c3,c6,nano` 明确选择子集；不能与 `--matrix` 同时使用。每个目标绑定固定基准 FQBN，菜单选项顺序和实际 Core 身份仍由报告记录。

`configuration` 和 `compatibility` 都不改变 `minimum` 或 `release` 的既有目标集合，必须显式选择才会进入计划。当前三个配置 FQBN 直接取自本机 ESP32 Core 3.3.6 的 `boards.txt`：

| target ID | 完整 FQBN | 预期路由 |
| --- | --- | --- |
| `c5-n16r8-config` | `esp32:esp32:esp32c5:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=enabled` | `force-platform` + `release` |
| `c6-16m-config` | `esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB` | 当前无 NativeRelink 性能证书，`force-platform` + `release`；未来只有精确身份重新 A/B 并发证后才可改变 |
| `s3-16m-opi-config` | `esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi` | `force-platform` + `release` |

只生成该矩阵的执行计划：

```powershell
node .\scripts\Run-CKForgeRegression.cjs `
  --plan `
  --matrix configuration `
  --output .\artifacts\forge\configuration-candidate.json
```

这里的 `c5-n16r8-config` 是对 N16 +“启用 PSRAM”菜单组合的稳定简称，不是对 R8 容量的物理认证。`PSRAM=enabled` 只证明该 Core 接受启用声明；compile-only 无法检测实际 PSRAM 容量。三个目标均固定为 `hardwareTested=false`，也不代表同一板型的其他 Flash、PSRAM、分区、USB、FlashMode 或频率组合已经验证。运行 `configuration` 只生成回归证据，不会自动修改内置专用资格清单、授予上传资格或接通本机资格接口。

`compatibility` 使用三套已安装 Core 确实声明、但 CK Forge v1 内置快速矩阵没有列出的板型：

| target ID | 完整 FQBN | 预期路由 |
| --- | --- | --- |
| `compat-esp32s3-feather` | `esp32:esp32:adafruit_feather_esp32s3` | `force-platform` + `release` |
| `compat-avr-leonardo` | `arduino:avr:leonardo` | `force-platform` + `release` |
| `compat-esp8266-generic` | `esp8266:esp8266:generic` | `force-platform` + `release` |

只生成兼容降级计划：

```powershell
node .\scripts\Run-CKForgeRegression.cjs `
  --plan `
  --matrix compatibility `
  --output .\artifacts\forge\compatibility-candidate.json
```

该矩阵的发布后置门禁会逐次检查 `engine.decision=force-platform` 和 `profile=release`。任一未资格目标误用 PortableFast、QuickFast/SharedFast 或回报 `allow-fast`，都必须使报告发布失败。正常功能回归可以验证严格同身份的 Exact；需要测原生 repeat 或性能时必须显式进入 qualification/no-exact 模式。这里的“兼容”仍然只是 compile-only 证据，目标固定为 `hardwareTested=false`，不表示 CK 已经连接、探测或运行这些实体板卡，也不表示 CK 比原生 CLI 快。

矩阵只包含本机已定义的基准目标。第三方板卡包应先由自身 `validation_profiles` 和 `ckpkg compile` 验证；不能因为芯片同为 ESP32 就继承某块官方开发板的结果。

## 3. 测试阶段

默认阶段：

1. `compile`：同一套只使用跨架构 Arduino API 的 portable sketch。
2. `exact`：源码完全不变的再次请求；普通功能回归允许 `force-platform` 在完整证据一致时报告 Exact Match。若目标是验证原生 repeat，则 runner 必须显式禁用 Exact 并再次成功走 Release；两种证据不可混写。专用快速资格始终由独立的交替 A/B 门禁裁决。

增加 `--dependency-cycle` 后：

1. `compile`：portable sketch。
2. `dependency`：加入该架构的内置库与真实 API 调用。
3. `simple-return`：移除库，资源与非 Core 依赖闭包必须回到初始状态。
4. `exact`：对恢复后的 simple sketch 做完全相同源码重放。

CK Forge 不把“编译成功”简化为进程退出码。报告还绑定完整 FQBN、源码 SHA-256、Core/工具链/构建签名、资源统计、非 Core 依赖集合、主应用产物和 SHA-256。

## 4. 报告合同

机器报告继续使用编译 harness 已有的内部身份：

```text
schemaId: ck.cross-board-compile-only-matrix
schemaVersion: 2
```

CK Forge 没有为了产品名称重写旧证据。其稳定消费边界由 [`ck-forge-regression-report.schema.json`](schemas/ck-forge-regression-report.schema.json) 定义，至少强制：

- compile-only，且未上传、未写 Flash、未访问串口、未探测设备；
- `hardwareTested=false`；
- 当前入口生成的每次 run 都有 `engine.id=ck-forge`、schema version 1、实际路由决策和 profile；
- 所选目标、实际目标行和完整 FQBN 可解析；
- 每次 run 有源码身份、耗时、资源证据和已校验主应用产物；
- runner 与 production EXE 在运行前后身份不变；
- `passed`、`passed-with-warnings`、`failed` 与 warnings/failures 一致。

稳定入口在 harness 成功退出后还会再次核对引擎路由证据、安全字段、缓存清理请求和目标顺序。报告 Schema 为兼容历史 v2 证据仍允许旧报告缺少 `engine`，但这种旧报告不能通过当前 CK Forge 候选门禁。Schema 验证不等于发布者签名，也不能证明硬件实际运行。

## 5. 证据边界

CK Forge v1 能证明：

- 当前本机存在所需 Core 和板卡定义；
- CK production compile command 能解析目标并完成预处理、编译和链接；
- 产物、资源和依赖闭包证据满足报告门禁；
- 正常功能回归可证明完整身份与产物证据相同时 Exact 安全命中；qualification/no-exact 回归可证明 `force-platform` 的实际编译仍由原生 Release/Arduino CLI 完成，并且 PortableFast 与 Fast Relink 被禁用。Exact 功能证据不等于性能资格。

它不能证明：

- 上传握手、BOOT/RESET、USB 重枚举或串口行为；
- 实体芯片、Flash、PSRAM、引脚、电气连接、无线或外设运行；
- 任意 Flash/PSRAM/分区/USB 菜单组合；
- 一次样本代表 P50/P95；
- 第三方包作者身份、许可证法律结论或 CK 官方认证。

真板证据继续由独立设备体检、上传清单和原生 benchmark 生成，不得与 CK Forge 的 compile-only 行合并为虚假的全绿认证。

## 6. 当前 Core 与后续扩展

v1 矩阵以运行时实际安装 Core 为准。推荐版本、最低兼容版本和最新版本是三条不同兼容 lane：低于最低要求或命中已知不兼容范围才阻止；兼容但未复验的新版本保持警告、进入原生 Release，并且不能继承旧版本的专用 Fast Relink 或性能资格证据。表中的 ESP32 3.3.6 仅是当前证据样本，不是版本上限；ESP32 3.3.7/更高版本及 STM32、RP2040 等其他合法 Core 都遵循同一安全路由。

增加新架构时必须同时完成：

1. 唯一 target ID、基准 FQBN 和是否为内置板卡的声明；
2. portable sketch 的真实 compile-only；
3. 若加入依赖矩阵，定义一个确定的内置库与依赖移除等价检查；
4. Schema/目标目录/no-clobber 自动化测试；
5. 明确保持 `hardwareTested=false`。

公开服务、远程队列、签名认证、Core 自动安装和真板农场不属于 v1。它们必须另行定义权限、配额、供应链与撤销协议。
