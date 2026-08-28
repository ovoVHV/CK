# FLFE portable-edit 公平基线（2026-07-18）

状态：**优化前基线；证据完整，但 7 个目标均未取得 FLFE 性能资格。**

## 测量合同

- 同一台 Windows 主机、同一 bundled Arduino CLI、同一配置、Core、完整 FQBN、源码字节和并行度。
- 每个目标 3 轮配对，CK/native 起跑顺序交替。
- 每轮在各自不变的 build path 上依次编译 `simple -> complex -> medium -> simple-return`。
- `simple-return` 与首段 `simple` 字节完全相同，但 CK Exact 被强制禁用；测量的是编译路径，不是产物重放。
- 仅 compile-only，不打开串口、不上传、不接触真机 Flash。
- 报告 `status=passed` 只表示证据完整，不表示 CK 更快。性能列为负数时，表示 CK 比原生慢。

最终 production EXE：

- SHA-256：`91052e6e6b2a44b7690121f4747d2c7c450472ea96dbb8c4863760998e941a90`
- 大小：`40,982,016` bytes
- custom protocol：`http://tauri.localhost/`

## 三轮中位数

| 目标 | simple CK / native | complex CK / native | medium 相对原生 | simple-return 相对原生 | 结论 |
| --- | ---: | ---: | ---: | ---: | --- |
| AVR Uno 1.8.6 | 8.440s / 7.307s | 6.409s / 5.114s | -17.5% | -16.8% | 未达标 |
| SAMD MKR Zero 1.8.14 | 10.263s / 9.074s | 6.174s / 5.363s | -8.8% | -10.4% | 未达标 |
| Renesas UNO R4 Minima 1.6.0 | 23.370s / 23.341s | 14.420s / 14.216s | -7.7% | -1.6% | 未达标 |
| ESP8266 NodeMCU 3.1.2 | 29.949s / 28.655s | 13.165s / 10.908s | -21.2% | -12.9% | 未达标 |
| Arduino Mbed RP2040 Pico 4.6.0 | 46.469s / 42.925s | 17.149s / 14.070s | -27.8% | -19.0% | 未达标 |
| STM32 F401RE 2.12.0 | 41.876s / 38.696s | 23.728s / 16.672s | -25.9% | -21.5% | 未达标 |
| ESP32-C6 3.3.6（16MB/app3M） | 50.303s / 43.408s | 27.105s / 21.586s | -25.4% | -27.5% | 未达标 |

## 固定开销分解

`complex` 阶段的 CK 后端中位数显示，身份校验只是回退的一部分；builder/CLI 阶段也存在重复工作。

| 目标 | CK 身份阶段 | CK builder/CLI | 原生整段 |
| --- | ---: | ---: | ---: |
| AVR | 0.637s | 5.719s | 5.114s |
| SAMD | 0.343s | 5.807s | 5.363s |
| Renesas | 0.339s | 14.042s | 14.216s |
| ESP8266 | 1.148s | 11.980s | 10.908s |
| RP2040 | 1.443s | 15.724s | 14.070s |
| STM32 | 2.238s | 18.567s | 16.672s |
| ESP32-C6 | 2.701s | 24.374s | 21.586s |

因此不能只把门禁放到按钮点击之前，也不能把 Exact 叫作编译加速。下一轮需要两条真实优化线：

1. **请求级身份租约**：一个编译请求开始验证一次、内部复用、提交 BuildMeta 前未租约复验一次，消除 builder 内重复完整 guard。
2. **NativeRelinkCompileOnly**：保持原生 Release flags 和 Core hooks，只对认证基线后的同 include/body edit 重编 sketch、执行原生 prelink/link/size；任何不确定立即退回 Arduino CLI。

## 证据文件

- [AVR](../artifacts/benchmarks/ck-forge-20260718-flfe-91052e6e-avr-portable-edit-native-ab-v1.json)
- [SAMD](../artifacts/benchmarks/ck-forge-20260718-flfe-91052e6e-samd-mkrzero-portable-edit-native-ab-v1.json)
- [Renesas](../artifacts/benchmarks/ck-forge-20260718-flfe-91052e6e-renesas-minima-portable-edit-native-ab-v1.json)
- [ESP8266](../artifacts/benchmarks/ck-forge-20260718-flfe-91052e6e-esp8266-portable-edit-native-ab-v2.json)
- [RP2040](../artifacts/benchmarks/ck-forge-20260718-flfe-91052e6e-rp2040-portable-edit-native-ab-v1.json)
- [STM32](../artifacts/benchmarks/ck-forge-20260718-flfe-91052e6e-stm32f401re-portable-edit-native-ab-v1.json)
- [ESP32-C6](../artifacts/benchmarks/ck-forge-20260718-flfe-91052e6e-esp32c6-portable-edit-native-ab-v1.json)

说明：ESP8266 首次运行因 native 资源格式未被 Runner 识别而 fail-closed；修复为完整 `IROM + IRAM + DATA + RODATA` 证据后使用 v2 报告。该 Runner 修复发生在 AVR/SAMD/Renesas 报告之后，所以每份报告仍以自身记录的 Runner 哈希为准；优化后的最终统一矩阵必须使用同一冻结 Runner 重新生成全部目标。

## 磁盘纪律

- 矩阵开始前 C 盘可用约 22.86 GiB，完成后约 22.75 GiB。
- 每个目标结束后 `%TEMP%\CKAB` 自动清空；未使用 `--keep-workdir`。
- 保留 `CK_Builds`、ccache、prebuilt Core 与 installed Cores，它们是后续 Exact/热编辑/复测证据，不属于无用垃圾。
