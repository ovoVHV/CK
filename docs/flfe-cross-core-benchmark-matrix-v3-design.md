# FLFE 跨 Core 公平基准矩阵 v3 设计

> **历史设计快照（部分 superseded，2026-07-19）：**下方“runner 只允许 AVR／非 AVR 不发证”等执行状态记录的是设计时点，现已由最终 EXE `fe1450c5…` 的正式结果部分取代：精确 `arduino:avr:uno` / Core 1.8.6 与 `arduino:samd:mkrzero` / Core 1.8.14 均完成 5 轮 `portable-edit` A/B、获得 NativeRelink v4 本机热编辑资格，并在无 qualification token 的普通运行中验证证书授权。两者冷 `simple` 均慢于原生，未获冷编译资格。其余矩阵目标仍未取得 NativeRelink 资格，继续原生 Release。以下矩阵设计、历史缺口和样本列表原样保留；权威当前状态见 [性能资格门禁](ck-forge-performance-no-regression-gate.md)。

状态：**设计与执行清单，不代表这些目标已经获得 FLFE 加速资格。** 现有
`Run-CKForgeNativeAB.cjs` 只允许 Arduino AVR 的明确 adapter 进入正式资格；其他
Core 仍可采集优化前基线，但必须显示为 `not-qualified`。

## 1. 不能混在一起的四种口径

| lane | 要回答的问题 | 缓存合同 | 是否可授予 NativeRelink 资格 |
| --- | --- | --- | --- |
| `toolchain-cache-cold` | 没有 ccache 对象时，CK 的完整兼容路径比原生多多少开销 | 两边 `CCACHE_DISABLE=1`，独立空 build path；保留 OS 文件缓存 | 否；只做 cold no-regression，不能拿预热冒充 cold |
| `warm-fresh-build-path` | 共享编译器缓存已热，但工程 build path 全新时多快 | 两边从同一冻结 ccache 快照起跑 | 否；报告必须标记 `prewarmed` |
| `no-change` | 用户不改代码再按一次编译，各自多快 | native 在原 build path 做 no-change incremental；CK 另记 authenticated Exact | Exact 单独认证，不能算作重新编译或 NativeRelink |
| `portable-edit` | 代码真实变化后，CK 是否比原生 CLI 增量构建更快 | 同一 lane 内固定 build path，`simple → complex → medium → simple-return`；CK 禁止 Exact | 是；每个 adapter/FQBN/Core/工具链独立发证 |

`simple-return` 虽然字节回到第一段 `simple`，仍必须重新调用编译器；它用于确认
NativeRelink 没有把历史 Exact 产物冒充本次结果。

## 2. 每个目标的报告集合

每个目标生成一个只增不改的目录：

```text
artifacts/benchmarks/flfe-matrix-<UTC>-<runner-sha8>/
  00-environment.json
  <target>/01-toolchain-cache-cold-ab.json
  <target>/02-warm-fresh-build-path-ab.json
  <target>/03-native-no-change.json
  <target>/04-ck-authenticated-exact.json
  <target>/05-portable-edit-ab.json
  <target>/06-adapter-qualification.json       # 没有 adapter 时明确 absent
  90-disk-cleanup.json
  matrix-summary.json
  matrix-summary.md
```

聚合报告只引用子报告 SHA-256，不复制或改写原始样本。每份报告至少绑定：production
EXE、Runner、bundled CLI/config、完整 FQBN、Core 版本和内容身份、工具链、有效菜单
选项、jobs、主机、workload、cache mode、adapter/engine/artifact policy，以及每轮
CK/native 起跑顺序。

## 3. 当前已安装的第一轮样本

| 类别 | Core | 第一代表 FQBN | 追加覆盖 |
| --- | --- | --- | --- |
| AVR8 | `arduino:avr@1.8.6` | `arduino:avr:uno` | Mega、Leonardo 各自独立资格 |
| SAMD21 | `arduino:samd@1.8.14` | `arduino:samd:mkrzero` | SAMD51 需另装对应 Core 后再测 |
| Renesas RA4M1 | `arduino:renesas_uno@1.6.0` | `arduino:renesas_uno:minima` | UNO R4 WiFi 不能沿用 Minima 证书 |
| ESP8266 | `esp8266:esp8266@3.1.2` | `esp8266:esp8266:nodemcuv2` | Generic 及菜单配置单独资格 |
| Raspberry Pi Pico MCU | `arduino:mbed_rp2040@4.6.0` | `arduino:mbed_rp2040:pico` | Arduino-Pico/RP2350 是另一 Core，不能沿用 |
| STM32 F4 | `STMicroelectronics:stm32@2.12.0` | `STMicroelectronics:stm32:Nucleo_64:pnum=NUCLEO_F401RE` | G474RE、H743ZI 先做完整 E1 捕获，再单独资格 |
| ESP32 RISC-V | `esp32:esp32@3.3.6` | `esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB` | H2、P4、C5 各自独立 |
| ESP32 Xtensa | `esp32:esp32@3.3.6` | `esp32:esp32:adafruit_feather_esp32s3` | classic ESP32/S2/S3 菜单分别覆盖 |

已安装 Core 只证明“可开始测”，不证明加速。ESP32 3.3.7/3.3.10 等更新版本必须在
隔离 sysroot 中重跑；合法新版本先走原生 Release 兼容路径，不锁死、不阻止，也不继承
3.3.6 的 Fast 证书。

## 4. RP2040 与 Raspberry Pi Linux SBC 必须分开

- Raspberry Pi Pico/RP2040 是微控制器，有 Arduino FQBN，可进入上述 Arduino CLI 矩阵。
- Raspberry Pi 4/5/Zero 等是 Linux SBC，没有可比较的 Arduino FQBN。不得把 Pico 报告写成
  “树莓派 Linux 已验证”。
- Linux SBC 后续使用独立 `linux-sbc` adapter，在同一 Linux 主机/同一 sysroot 上比较 CK
  与项目原生 CMake+Ninja（或项目声明的原生构建系统）：`clean build`、`no-change`、
  `source edit`、`header edit`。它有独立 contract、产物规则和资格库，绝不复用 Arduino
  NativeRelink 证书。

## 5. adapter 与产物等价门禁

当前正式规则只有：

```text
adapter: arduino-avr-native-relink-v1
engine:  ck-native-relink-avr-release-compile-only-v2
policy:  arduino-avr-hex-required-eeprom-optional-exact-v2
roles:   avr-application-hex 必须逐角色 bytes/SHA-256 完全相同；avr-eeprom
         可同时缺失，任一侧生成时则双方必须各有一个且 bytes/SHA-256 完全相同
```

非 AVR 在下列规则明确并有测试前一律不能发证：

- SAMD/Renesas/STM32：至少明确 application BIN/HEX，以及 ELF 是否只做 section 等价；
- RP2040：BIN/HEX 与 compile-only 是否要求 UF2；
- ESP32：application BIN、partition/bootloader 等 compile-only 与 upload-ready 边界；
- ESP8266：BIN、签名 sidecar 和 Python packager 边界；
- 所有 adapter：stale upload-only 产物必须删除并重新检查。

仅仅“两边各自有 SHA-256”不等于“两边产物相同”。没有按角色等价策略时，速度数字只能
作为诊断基线。

## 6. 公平性与通过条件

- 正式 `portable-edit` 每目标至少 5 轮配对，顺序交替；P50 至少快 10%，且绝对中位收益
  至少 500 ms，nearest-rank P95 不慢于原生。
- 每个 edit 必须命中声明的 adapter，不能 CLI fallback，不能 Exact，资源统计和必需主产物
  必须等价。
- cold、warm、Exact、portable edit 分开给结论；任一 lane 失败不能被另一个 lane 的好数字
  抵消。
- `measurementStatus=passed` 只说明证据有效；只有 `qualificationStatus=qualified` 才能显示
  FLFE 加速。
- 任一 Core、完整 FQBN、菜单、CLI、工具链、adapter contract 或 artifact policy 变化，资格
  自动失效并回到原生兼容路径。

## 7. 现阶段可执行与尚缺命令

现有 portable-edit 基线（非 AVR 不会获得资格）：

```powershell
node scripts/Run-CKForgeNativeAB.cjs --execute --allow-cache-reset `
  --sequence portable-edit --trials 5 --min-free-gib 15 `
  --fqbn <完整FQBN> --output <新的05-portable-edit-ab.json>
```

AVR adapter 正式资格在同一命令增加：

```powershell
--require-ck-mode native-relink-compile-only
```

现有 `Run-CKForgeRegression.cjs` 可验证目录内目标的 cold-build-path、产物与 CK Exact，但它
不是 CK/native A/B，而且目录尚未纳入 SAMD、Renesas、Mbed RP2040 和 STM32。v3 runner
必须先补这四类目标，再增加独立 `--cache-mode toolchain-cold|shared-warm` 与
`--sequence no-change|portable-edit`；在此之前不得声称一条现有命令已经统一覆盖四种口径。

## 8. C 盘纪律

- 整轮和每个目标前检查可用空间；本机建议硬门槛 15 GiB，而不是等降到 8 GiB 才停止。
- Runner 只删除自己创建的 `%TEMP%/CKAB/<run-token>`，记录 capture 后与 cleanup 后的可用
  空间、普通文件字节数、文件/目录数、是否删除及脱敏路径。
- timeout/cancel 只按 Runner 持有的根 PID 终止完整进程树，避免残留 gcc/ld 继续写盘；不得
  按进程名杀其他用户任务。
- 保留 production EXE、installed Cores、当前资格引用的 baseline 与 ccache；只清理已封存
  A/B 临时目录、孤立测试 harness、过期 staging，以及不再被证据引用的 LRU build cache。
- `matrix-summary` 完成后再次采样 C 盘并写 `90-disk-cleanup.json`。磁盘释放应报告客观字节，
  不能只写“已清理”。
