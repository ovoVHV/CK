# FLFE 跨板卡编译测速（2026-08-23）

> **历史证据快照。**本报告绑定的是旧 production EXE `f47acdd2…`，不能授权当前安装包或覆盖安装后的新 EXE。当前资格必须运行 `node scripts/Report-CKForgeFastQualifications.cjs --format text` 重新查询。

本报告绑定生产程序 `target/release/appsdesktop.exe`，SHA-256：
`f47acdd2a3f4133f2efc04335218a14216fe30bb3096dfaa0ba3d8d98a48816b`。

## 测试口径

- 同一台 Windows 主机、同一 Arduino CLI/Core、同一完整 FQBN、同一源码序列。
- 每个正式目标 5 轮交错 CK/原生 A/B：`simple -> complex -> medium -> simple-return`。
- 仅统计编辑阶段；冷 `simple` 只记录，不用于性能资格。
- 门槛为编辑阶段中位数至少比原生快 25%，并要求 p95 不劣、产物门禁通过。
- 全程 compile-only，没有上传、串口访问或物理写入。

## 正式通过

| 目标 | Core | complex | medium | simple-return | 结果 |
| --- | --- | ---: | ---: | ---: | --- |
| ESP32-C6 | 3.3.6 | 36.83% | 39.11% | 37.78% | qualified |
| ESP32-C3 | 3.3.6 | 38.28% | 37.09% | 37.50% | qualified |
| ESP32-S3 | 3.3.6 | 34.97% | 35.59% | 37.03% | qualified |
| ESP32-C5 | 3.3.6 | 36.69% | 37.71% | 37.10% | qualified |
| ESP32-S2 | 3.3.6 | 37.12% | 34.99% | 37.38% | qualified |
| ESP32 (classic) | 3.3.6 | 29.92% | 30.54% | 31.19% | qualified |
| ESP32-H2 | 3.3.6 | 37.81% | 37.60% | 37.36% | qualified |
| Arduino Uno / ATmega328P | 1.8.6 | 58.09% | 58.42% | 58.51% | qualified |
| Arduino Mega / ATmega2560 | 1.8.6 | 56.54% | 57.13% | 56.35% | qualified |

详细原始证据：

- [C6 A/B](../artifacts/benchmarks/flfe-esp32c6-native-relink-formal-20260823.json)
- [C3 A/B](../artifacts/benchmarks/flfe-esp32c3-native-relink-formal-20260823.json)
- [S3 A/B](../artifacts/benchmarks/flfe-esp32s3-native-relink-formal-20260823.json)
- [C5 A/B](../artifacts/benchmarks/flfe-esp32c5-native-relink-formal-20260823.json)
- [S2 A/B](../artifacts/benchmarks/flfe-esp32s2-native-relink-formal-20260824.json)
- [经典 ESP32 A/B](../artifacts/benchmarks/flfe-esp32-classic-native-relink-formal-20260824.json)
- [H2 A/B](../artifacts/benchmarks/flfe-esp32h2-native-relink-formal-20260824.json)
- [AVR Uno A/B](../artifacts/benchmarks/flfe-avr-uno-native-relink-formal-20260823.json)
- [AVR Mega A/B](../artifacts/benchmarks/flfe-avr-mega-native-relink-formal-20260823.json)

表中九份 `qualified` 报告已安装到当前 EXE 的 `state/qualifications/`。当前资格清单可用：

```powershell
node scripts/Report-CKForgeFastQualifications.cjs --format text
```

## 保持原生的目标

STM32 Nucleo F401RE（Core 2.12.0）完成 3 轮观测，但没有进入资格证书：编辑阶段 CK 中位数约 21.5s/21.4s/21.5s，原生约 16.0s/15.2s/15.4s，慢约 34.5%～40.4%，且通用产物角色门禁失败。报告为 [STM32 观测](../artifacts/benchmarks/flfe-stm32-f401re-native-ab-observation-20260823.json)。因此该目标继续走原生 Arduino CLI Release，符合 fail-closed 规则。

ESP32-P4 本轮在用户要求收尾时中止；ESP8266、AVR Nano、Leonardo 也没有完成本轮新证据，均保持原生路径。不能用同架构其他板卡的证书继承它们。

## 结论

FLFE 当前已在两种 ESP32 变体（RISC-V C3/C5/C6 与 Xtensa S3）和两种 AVR MCU（ATmega328P/ATmega2560）上通过正式 A/B。STM32 的失败观测证明门禁会阻止不合适的快速路径，而不是牺牲正确性换速度。后续扩展板卡必须使用同样的完整 FQBN、Core 版本、产物等价和性能证据重新资格化。
