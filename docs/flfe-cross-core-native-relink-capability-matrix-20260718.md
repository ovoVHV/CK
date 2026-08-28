# FLFE AVR 后跨 Core NativeRelink 能力矩阵（2026-07-18）

状态：只读设计审查。本文没有修改产品源码、已安装 Core 或任何构建缓存；证据来自审查时现存的 `%TEMP%\CK_Builds`、工作区 bundled Core，以及已经提交的 compile-only A/B 报告。

## 结论先行

AVR Phase 1 后，建议按以下顺序扩展：

1. **P1：Arduino SAMD / MKR Zero**。它最接近 AVR：没有 prebuild、linking-prelink 或 postobjcopy hook；只多一个固定 CMSIS math archive。先补一份完整 Release CCDB 基线，再复用 AVR 事务骨架。
2. **P2：Renesas UNO R4 Minima**。仍可只替换 sketch 对象，但 link 必须同时冻结 `libfsp.a`、`fsp.ld` 和 FSP response files。应先增加 `CoreArchivePlusStaticArchives` 能力，不能把 `libfsp.a` 当成普通 `core.a` 忽略。
3. **P3：ESP32 3.3.6 家族（C6/H2/P4/S3）**。C6/H2/P4 的现存 Release CCDB 都证明对象层是 `1 sketch + 56 core`；现有 ESP32 FastRelink 代码可复用很多执行与产物门禁。但 Release link 仍绑定三份 SDK response files、数百个 `-l` token，upload-ready 又有完整 packager，必须作为 ESP32 adapter，不应伪装成纯 AVR adapter。S3 实物样本还多一个 `variant.cpp.o`。
4. **P4：ESP8266**。对象层也是单 sketch + core archive，但有四个强制 prelink 和 Python `elf2bin/sign/sizes` 链；需要 `GeneratedLinkerScripts` 能力后再做。
5. **P5：Arduino Mbed RP2040**。需固定 `libmbed.a`，每次 link 前预处理 linker script；upload-ready 另需 `elf2uf2`。适合 `PrelinkedStaticRuntime` 能力，不能直接套 AVR。
6. **P6：STM32 F401**。绝不能直接套 `SingleSketchObject + CoreArchive`。现存 Release CCDB 的真实链接输入是 **188 个非 archive 对象 + `core.a`**；只能新建 `OrderedImmutableObjects + CoreArchive` 能力类。

如果排期目标优先考虑“一次覆盖四个芯片且复用现有实现”，P3 ESP32 可以和 P2 Renesas 对调；从新增语义最少、最容易做出第一份无回退 A/B 资格看，SAMD 仍应排第一。

## 1. 审查范围与证据等级

Bundled Core 版本：

| package:arch | 版本 | 安装根 |
|---|---:|---|
| `arduino:samd` | 1.8.14 | `packages/arduino/hardware/samd/1.8.14` |
| `arduino:renesas_uno` | 1.6.0 | `packages/arduino/hardware/renesas_uno/1.6.0` |
| `esp8266:esp8266` | 3.1.2 | `packages/esp8266/hardware/esp8266/3.1.2` |
| `arduino:mbed_rp2040` | 4.6.0 | `packages/arduino/hardware/mbed_rp2040/4.6.0` |
| `STMicroelectronics:stm32` | 2.12.0 | `packages/STMicroelectronics/hardware/stm32/2.12.0` |
| `esp32:esp32` | 3.3.6 | `packages/esp32/hardware/esp32/3.3.6` |

本文区分三种证据，避免把配方推导冒充现存 CCDB：

- **E1（实物）**：`%TEMP%\CK_Builds` 中存在完整 Release `compile_commands.json`、对象、`core.a` 和 ELF。
- **E2（配方）**：`CK_Builds` 当前只有 Release 工程壳；compile/link 图来自已安装 Core 的 `platform.txt`、`boards.txt`、variant response/static files。首次实现前必须重新捕获 E1 基线。
- **E3（产物/时延）**：现有 `artifacts/benchmarks/*portable-edit-native-ab*.json` 证明原生 Release 产物集合和 Arduino CLI 热编辑时延，但不证明直接引擎已经合格。

审查快照中，SAMD、Renesas、RP2040 的 `_rel` 目录各只有根 `.ino`；ESP8266 NodeMCU 的 `_rel` 也只有根 `.ino`，但同 Core 的 Generic Release 完整树仍在。不存在的 CCDB 在下表明确标作 E2。

## 2. Release CCDB 实物盘点

| 目标/FQBN | 证据 | CCDB 条目构成 | `core.a` 成员 | 非 archive link 对象结论 |
|---|---|---:|---:|---|
| AVR Uno（对照）`arduino:avr:uno` | E1 | 26 = sketch 1 + core 25 | 25 | 仅 sketch 1 |
| SAMD MKR Zero `arduino:samd:mkrzero` | E2/E3 | 当前未保留 | 当前未保留 | 配方预计 sketch 1；须重新捕获确认 |
| Renesas Minima `arduino:renesas_uno:minima` | E2/E3 | 当前未保留 | 当前未保留 | 配方预计 sketch 1，另有预编译 `libfsp.a`；须重新捕获确认 |
| ESP8266 Generic `esp8266:esp8266:generic` | E1 | 84 = sketch 1 + core 83 | 83 | 仅 sketch 1 |
| ESP8266 NodeMCU `esp8266:esp8266:nodemcuv2` | E2/E3 | 当前未保留 | 当前未保留 | 与 Generic 同平台配方，不能借 Generic 的对象哈希跨 FQBN 复用 |
| Mbed RP2040 Pico `arduino:mbed_rp2040:pico` | E2/E3 | 当前未保留 | 当前未保留 | 配方预计 sketch 1，另有预编译 `libmbed.a`；须重新捕获确认 |
| STM32 F401RE `STMicroelectronics:stm32:Nucleo_64:pnum=NUCLEO_F401RE` | E1 | 212 = sketch 2 + core archive 24 + library 180 + variant/system 6 | 24 | **188** = sketch `.ino.o` + generated `requiredLibraries.o` + library 180 + variant 6 |
| ESP32-C6 `esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB` | E1 | 57 = sketch 1 + core 56 | 56 | 仅 sketch 1 |
| ESP32-H2 `esp32:esp32:esp32h2` | E1 | 57 = sketch 1 + core 56 | 56 | 仅 sketch 1 |
| ESP32-P4 `esp32:esp32:esp32p4` | E1 | 57 = sketch 1 + core 56 | 56 | 仅 sketch 1 |
| ESP32-S3 样本 `esp32:esp32:adafruit_feather_esp32s3` | E1 | 58 = sketch 1 + core 56 + variant 1 | 56 | sketch 1 + 固定 `variant.cpp.o` 1 |

重要限制：CCDB 只证明“源文件如何编译”，不证明 `{object_files}` 的最终顺序。除字面只剩一个 sketch 对象的目标外，NativeRelink manifest 必须从原生 verbose link 或可信 builder 输出捕获**有序** link input graph，不能按 CCDB 排序自行重建。

### 2.1 实物身份摘要

以下 hash 只用于标识本次审查快照，不授予跨构建复用资格：

| Release 样本 | CCDB bytes / SHA-256 | `core.a` bytes / SHA-256 |
|---|---|---|
| AVR Uno | 28,123 / `a9fa69a4e21a4576d5b0606465e48efe3f5143a230eb5aa3befe7b910346e498` | 345,252 / `30c747f5f1042ac29e0b83325f15135af1d579e547d6bc435612212a427014ec` |
| ESP8266 Generic | 191,569 / `158880820742972de4b7b8fb03b33840e3955c367280f7849c86d155cbacd545` | 5,673,804 / `dde465f44cddbf7b0d6deedeb5fc2faa8c7ea232e541a775bb17b9e2e6f8df31` |
| STM32 F401RE | 946,952 / `0658b7a73a6aefd2eabecac8a0a9f8e7cf7ed296f2cd9b5dec8a87e7d64590b6` | 105,460 / `3ff915407ca0125743d7ec27c4469263ff4991d2d189f59e04856c2103db7524` |
| ESP32-C6 | 121,669 / `d6f44c5eaecfd8be8e39755e8e98ce90411bbed541705b1f5c56351128e6e01b` | 4,078,926 / `997190ee62fea74f24fe4f53da5e13b080538d173a40f6fecf5611581a5b1c44` |
| ESP32-H2 | 117,451 / `2f0f092dabe0b57095346c3cf8dd7b7681b354937073a65f25c71a3c0bf7ff23` | 4,057,886 / `0c6d955db9b0aee27d76b145334299017fbaf3daf8c1351ad742a22430fd1d94` |
| ESP32-P4 | 122,239 / `7d5b9edc586c23e382eb4ffba289880f0f086a497124e9734f5bc08b6e0d3f0f` | 5,045,900 / `2e9a86da28e516348c7b0ded6d993e355de58603f82ff414fe7c108b7519d5df` |
| ESP32-S3 Feather | 135,864 / `2596bc07aa487ebabd122be2d2d56b4b98b9a89e0750ecb870238adfc8213f71` | 3,319,696 / `a2ff32a8e872f6a4353699939ec12bb78f9dcbd3884ae311ae247558113ad99b` |

## 3. 真实/可解析的 compile contract

所有现存 E1 CCDB 的 `output` 字段都为空；必须从参数中唯一提取 `-o <object>`，这和 AVR Phase 1 的处理一致。

| 家族 | sketch 编译器与关键 Release contract | response/generated inputs |
|---|---|---|
| SAMD | `arm-none-eabi-g++`, Cortex-M0+, `-mthumb -g -Os -std=gnu++11 -MMD`, 无 LTO | CMSIS include；无 build response file |
| Renesas | `arm-none-eabi-g++`, Cortex-M4 hard-float, `-Os -g3 -std=gnu++17 -MMD` | `defines.txt`、`includes.txt`；`PROJECT_NAME` 含 build path |
| ESP8266 | 实物为 `xtensa-lx106-elf-g++`, `-Os -g -MMD` | `core/build.opt`（325 B）与 warning response；还强制 include sketch-specific globals header |
| RP2040 | `arm-none-eabi-g++`, Cortex-M0+, `-g3`; variant `cxxflags.txt` 再给出 `-Os -std=gnu++14 -mthumb` | `defines.txt`、`cxxflags.txt`、`includes.txt` |
| STM32 F401 | 实物为 GCC 14.2.1 `arm-none-eabi-g++`, Cortex-M4, `-mthumb -Os -MMD` | `sketch/build.opt`（本样本 107 B），由 `prebuild.sh` 生成 |
| ESP32 C6/H2/P4 | 实物为 `riscv32-esp-elf-g++`, `-MMD -Os` | SDK `cpp_flags/defines/includes` + build-local empty `build_opt.h/file_opts` |
| ESP32 S3 | 实物为 `xtensa-esp32s3-elf-g++`, `-MMD -Os` | 与 ESP32 RISC-V 同类，SDK 文件换成 `esp32s3-libs` |

NativeRelink 必须绑定 response file 的普通文件身份、大小和内容 SHA-256；不能只 hash CCDB 命令中的 `@path` 字符串。ESP8266 的 `.globals.h`、STM32/ESP32 的 `build_opt` sidecar 也必须进入依赖指纹。

## 4. 每类 link / objcopy / size 图

下面的 key 均来自相应 installed Core 的真实 recipe；箭头表示必须保持的语义顺序。

### 4.1 SAMD 1.8.14

```text
sketch.cpp --recipe.cpp.o--> sketch.o
sketch.o + core.a + libarm_cortexM0l_math.a
  --recipe.c.combine--> ELF + MAP
  --recipe.objcopy.bin--> BIN
  --recipe.objcopy.hex--> HEX
  --recipe.size (-A)--> size summary
```

- 无 platform/board hook。
- 固定 CMSIS archive 为 2,775,436 B；MKR Zero linker script 为 `flash_with_bootloader.ld`。
- `with_bootloader.bin/.hex` 是 Arduino CLI 的标准编译导出语义，不在上述 objcopy
  recipe 内。MKR Zero 产品适配器允许原生 lane 保留它们，但 CK compile-only 编辑
  lane 必须清理并证明不存在；application BIN/HEX 逐字节等价，UF2、flash_args、
  upload manifest 与未知辅助固件全阶段拒绝，upload-ready 仍继续走原生 CLI。

### 4.2 Renesas UNO R4 Minima 1.6.0

```text
sketch.cpp + @defines + @includes --recipe.cpp.o--> sketch.o
sketch.o + core.a + --whole-archive libfsp.a + fsp.ld
  --recipe.c.combine--> ELF + MAP
  --recipe.objcopy.bin--> BIN
  --recipe.objcopy.hex--> HEX
  --recipe.size (-A)--> size summary
```

- 无 prelink/postobjcopy hook。
- `libfsp.a` 为 9,102,434 B，并位于 `--whole-archive` group；不能改组、抽成员或移动到 group 外。
- `compiler.fsp.extra_ldflags` 含 nano specs 和标准库；完整 token 序列必须跟 property contract 一起冻结。

### 4.3 ESP8266 3.1.2

```text
baseline-only sketch.prebuild signing header
baseline-bound prebuild mkbuildoptglobals -> core/build.opt + <project>.globals.h
sketch.cpp --recipe.cpp.o--> sketch.o
prelink.1 mkdir ld_h
 -> prelink.2 copy selected eagle.flash.*.ld.h
 -> prelink.3 gcc -E -> local.eagle.flash.ld
 -> prelink.4 gcc -E -> local.eagle.app.v6.common.ld
sketch.o + core.a + SDK libraries --recipe.c.combine--> ELF + MAP
 -> objcopy.hex.1 Python elf2bin -> BIN
 -> objcopy.hex.2 Python signing -> optional signed/legacy files
 -> objcopy.hex.3 Python sizes
 -> recipe.size (-A)
```

- 四个 prelink 都是 link-critical；不能复用 AVR 的 `Prelink=None`。
- prelink 输出依赖完整 FQBN 的 flash size/MMU/vtable 选择。可每次在事务目录重建，或在 manifest 中内容绑定后复用；不得跨 Generic/NodeMCU 或菜单项共享。
- upload-ready 必须保留 Python packager/signing 行为；compile-only 若只承诺 ELF+size，可跳过它，但必须删除旧 BIN/signature/upload manifest。若 compile-only 仍承诺当前 BIN，则至少运行 `hex.1`。

### 4.4 Arduino Mbed RP2040 4.6.0

```text
sketch.cpp + @defines + @cxxflags + @includes --recipe.cpp.o--> sketch.o
linking.prelink.1: g++ -E -P linker_script.ld -> build/linker_script.ld
sketch.o + core.a + --whole-archive libmbed.a + @ldflags
  --recipe.c.combine--> ELF + MAP
  --recipe.objcopy.bin--> BIN
  --recipe.objcopy.hex--> HEX
  --board postobjcopy.1 elf2uf2--> UF2
  --recipe.size (-A)--> size summary
```

- `libmbed.a` 为 3,918,132 B；`ldflags.txt` 和 linker script 都是 link identity 的一部分。
- prelink 必须在事务目录重定向输出；不可覆盖仍认证上一版本的 committed linker script。
- compile-only 可以将 UF2 排除在最小产物合同之外并删除 stale UF2；upload-ready 必须执行 `elf2uf2`。

### 4.5 STM32 F401 / Core 2.12.0

```text
baseline prebuild.sh
  -> sketch/build.opt
  -> generated sketch/requiredLibraries.cpp (#include <SrcWrapper.h>)
edited sketch.cpp --recipe.cpp.o--> new sketch.o
new sketch.o
 + preserved requiredLibraries.o
 + preserved SrcWrapper/HAL objects x180
 + preserved variant objects x6
 + core.a (24 members)
  --recipe.c.combine in captured order--> ELF + MAP
  --recipe.objcopy.bin--> BIN
  --recipe.objcopy.hex--> HEX
  --recipe.size (-A)--> size summary
```

- `prebuild.sh` 是 shell recipe；对 same-include/body edit，其输出只依赖 sidecar、platform path、USB/VirtIO FQBN 属性，可以在 baseline 中冻结，但未知输出或 include delta 必须回 CLI。
- 不能把 187 个 preserved non-sketch objects 重新归档以“变成 AVR 图”；这会改变 archive extraction、constructor 和 link-order 语义。
- 适配器必须捕获原生有序 `{object_files}`，并逐个验证普通文件身份/内容。任何一个对象缺失或改变都回 CLI。

### 4.6 ESP32 3.3.6（C6/H2/P4/S3）

```text
baseline prebuild.1..8
  -> partitions.csv + bootloader.bin + build_opt.h + file_opts + sdkconfig
edited sketch.cpp + SDK response files --recipe.cpp.o--> sketch.o
sketch.o [+ S3 sample variant.cpp.o] + core.a
 + @ld_flags + @ld_scripts + @ld_libs [+ menu zigbee libs]
  --recipe.c.combine--> ELF + MAP
  --recipe.objcopy.partitions.bin--> partitions.bin
  --recipe.objcopy.bin (esptool elf2image)--> application BIN
  --postobjcopy.1 Insights conditional
  --postobjcopy.2 ESP_SR conditional
  --postobjcopy.3 esptool merge-bin--> merged.bin
  --postobjcopy.4 shell echo chain--> flash_args
  --recipe.size (-A)--> size summary
```

SDK link response 文件的规模说明它不是“只有一个 core archive”的简单 linker：

| target SDK | `ld_libs` 中 `-l` token | `ld_libs` bytes |
|---|---:|---:|
| C6 | 582 | 8,207 |
| H2 | 539 | 7,789 |
| P4 ES | 550 | 7,981 |
| S3 | 622 | 8,789 |

- C6/H2/P4 的 E1 对象层确实只有一个 sketch 对象加 `core.a`，所以可以复用同一事务骨架；SDK response identity 和完整 link group 必须作为额外 immutable inputs。
- S3 E1 样本是 Adafruit Feather，不是 generic `esp32s3`；它的 `variant.cpp.o` 位于 archive 外，需 `FixedObjectSet(1)`。不能把该样本资格推广给所有 S3 FQBN。
- compile-only 可以只提交 ELF/MAP/size（或再生成 app BIN），但必须清理旧
  `partitions.bin/merged.bin/flash_args/bootloader.bin` 及 upload manifest，防止旧包与新 ELF 混用。
- upload-ready 必须完整执行 partitions、bootloader、application、merge 和 flash_args 合同；Insights/ESP_SR 目录存在时还要保留条件 hook。

## 5. 精确能力矩阵

| 目标 | 字面 `sketch.o + core.a` | 必要额外 link 输入 | prelink | compile-only 后处理 | upload-ready 额外生成物 | 可复用 AVR 单事务吗 | 所需能力类 |
|---|---|---|---|---|---|---|---|
| SAMD | 接近（另有 CMSIS archive） | linker script、CMSIS math archive | 无 | application bin/hex、size；原生可另有 with-bootloader | UF2、flash_args、upload manifest；CK edit 还禁 with-bootloader | **是，轻量扩展** | `CoreArchivePlusStaticArchives` |
| Renesas Minima | 接近 | `libfsp.a`、`fsp.ld`、response files、whole-archive group | 无 | bin、hex、size | 同 compile-only 主产物 | **是，但不能忽略 FSP** | `CoreArchivePlusStaticArchives` |
| ESP8266 | 是（对象层） | SDK libs、两个 generated linker scripts、build.opt/globals | **4 步** | ELF+size；可选 elf2bin | sign/legacy/sizes 与 BIN | **否，需 generator adapter** | `GeneratedLinkerScripts + PythonPackager` |
| RP2040 | 接近 | `libmbed.a`、`@ldflags`、generated linker script | **1 步** | bin、hex、size | UF2 | **否，需 prelink/static runtime** | `PrelinkedStaticRuntime + UF2` |
| STM32 F401 | **否** | 187 preserved non-sketch objects + new sketch object + `core.a` | link prelink 无；baseline shell prebuild 1 | bin、hex、size | 同 compile-only 主产物 | **绝不能直接套** | `OrderedImmutableObjects + CoreArchive` |
| ESP32 C6/H2/P4 | 是（对象层） | 三份 SDK link response、539–582 个 SDK lib token、菜单 libs | link prelink 无；baseline prebuild 8 | ELF/MAP/size；可选 app BIN | partitions、bootloader、merged、flash_args、条件包 | **可复用骨架，不可复用纯 recipe** | `SdkResponseLinker + Esp32Packager` |
| ESP32 S3 Feather | 否（多 1 variant object） | 同 ESP32 + fixed variant object | 同 ESP32 | 同 ESP32 | 同 ESP32 | **需 FixedObjectSet 扩展** | `SdkResponseLinker + FixedObjectSet + Esp32Packager` |

所有“可复用”结论都仅适用于当前 Phase 1 类：同完整 FQBN、同 include/preprocessor 指纹、无新增 Arduino library compile unit、同 Core/CLI/toolchain/property contract。出现 library source/object、`ldflags`、precompiled library 声明或 header delta 时应回原生 CLI，不能把表格当作板卡白名单。

## 6. 预计直链下界与工程目标

定义：下表的“结构性下界区间”是热文件缓存下，后端必须执行的 sketch compile + 必要 prelink + direct link + size（以及保持最小 compile-only 主产物所需的廉价 objcopy）的工程估计；**不含**桌面端身份预检、库解析、上传 transport，也不是已取得的性能资格。没有执行任何会写产物的新测量，因此这些数值必须由后续事务级 stage timing A/B 替换。

| 目标 | 当前原生 CLI 热编辑中位区间（E3） | 结构性直链下界估计 | 第一轮端到端目标 | 主要下界来源 |
|---|---:|---:|---:|---|
| SAMD MKR Zero | 5.36–5.71 s | **1.5–2.5 s** | `< 3.0 s` | 3–4 个短工具进程、CMSIS archive link |
| Renesas Minima | 13.54–14.23 s | **2.5–4.5 s** | `< 6.0 s` | 9.1 MB `libfsp.a` whole-archive link |
| ESP8266 | 10.91–11.40 s | **4.0–6.5 s** | `< 8.0 s` | 4 个 prelink + Xtensa/SDK link；生成 BIN 再加约 0.7–1.5 s |
| Mbed RP2040 Pico | 13.45–14.10 s | **3.5–6.0 s** | `< 8.0 s` | linker-script preprocess + 3.9 MB `libmbed.a` whole-archive |
| STM32 F401RE | 16.52–16.67 s | **3.0–6.0 s** | `< 8.0 s` | 188 个有序对象的命令/文件门禁和 link；非 LTO |
| ESP32-C6/H2 | C6 21.31–21.59 s；H2 未测 | **7–10 s** | `<= 12 s` | 大量 SDK archive group/response-file link |
| ESP32-P4/S3 | 当前矩阵未测 | **8–12 s** | `<= 14 s` | 更大的 SDK/core；S3 另有 variant object |

参考但不作为 Release 资格：仓库已有 ESP32 QuickFast compile-only direct-link 记录约 9.1–13.3 s，支持把 ESP32 的结构性下界放在 7 s 以上，而不是按 AVR/SAMD 估成 2–3 s。QuickFast 使用自己的 compiler/property contract，不能替代 Release NativeRelink A/B。

## 7. 建议的通用 manifest/事务分层

不要把 AVR manifest 扩成一串 `if fqbn.starts_with(...)`。应将 link 能力正交化：

```text
SourceDelta
  SingleSketchObject

LinkInputModel
  CoreArchiveOnly
  CoreArchivePlusStaticArchives
  OrderedImmutableObjectsPlusCoreArchive
  SdkResponseArchives

PrelinkPlan
  None
  TransactionalDirectCommands
  BaselineGeneratedInputs

ArtifactPlan
  DirectObjcopy
  PythonPackager
  Uf2Packager
  Esp32Packager

ArtifactGoal
  CompileOnly
  UploadReady
```

每个 baseline manifest 至少应新增：

- ordered object/archive/group token graph 的 hash，而不只是 CCDB hash；
- 每个 `@response` 的内容身份；
- linker script、prelink 输入和预期输出身份；
- baseline-only hook 的输入/输出闭包及“允许跳过”的明确原因；
- compile-only 要保留的产物集合，以及必须删除的 stale upload-only 集合；
- packager 条件（例如 ESP32 Insights/ESP_SR、ESP8266 key sidecar、RP2040 UF2）；
- 完整 FQBN、Core、CLI、工具链、Release property contract 和 dependency content signature。

统一事务顺序应为：

1. 校验 manifest、CCDB、response、ordered link inputs、generator inputs 和旧成功产物；
2. 在 build root 内建立 transaction dir 与 dirty marker；
3. 用受限 `.ino -> .ino.cpp` 合同生成当前源；
4. 只重编 sketch 到 transaction object/depfile；
5. 必要时在 transaction dir 执行 prelink；
6. 按捕获的原生顺序 direct link；
7. 按 `ArtifactGoal` 执行最小 objcopy/size 或完整 packager；
8. 做 section/resource/primary artifact 等价门禁；
9. 原子提交对象、ELF、最小产物和新 manifest，并删除所有 stale upload-only 产物；
10. 任一步不确定或失败，清理整个目标 build path，再由 Arduino CLI Release 重建基线。

## 8. 分批交付建议

### Patch 1：能力抽象，不开产品路由

- 从 AVR manifest 提取 `LinkInputModel/PrelinkPlan/ArtifactPlan`；
- 单元测试 response 内容变化、ordered object 顺序变化、prelink 输出变化和 stale upload artifact；
- 所有非 AVR runtime 仍 fail-closed。

### Patch 2：SAMD E1 基线与 A/B

- 重新捕获 MKR Zero 完整 Release CCDB/core.a；
- 证明非 Core 只有一个 sketch object，确认 variant 是否已归入 core archive；
- 先做 ELF/bin/hex/size compile-only；application BIN/HEX 等价、CK edit 无
  with-bootloader，上传仍走原生 CLI；
- 5 轮 simple -> complex -> medium -> simple-return，无 fallback 后才授予当前身份资格。

### Patch 3：Renesas static-runtime 扩展

- hash `libfsp.a/fsp.ld/defines/includes`；
- 保留 whole-archive/group token；
- 单独测 link 阶段，验证 9.1 MB archive 是否仍有足够收益。

### Patch 4：ESP32 Release compile-only 家族

- 复用现有 ESP32 FastRelink 的 response、partition 与 artifact 验证代码，但重新绑定 Release CCDB/flags；
- C6、H2、P4、S3 各自独立资格；S3 先以现有 Feather FQBN 验证 fixed variant object，不推广到 generic S3；
- compile-only 和 upload-ready 证书严格分离。

### Patch 5：ESP8266 与 RP2040 prelink adapters

- 所有 prelink 输出写 transaction dir；
- ESP8266 globals/build.opt 和 key sidecars进入指纹；
- RP2040 linker script/libmbed/UF2 分别校验。

### Patch 6：STM32 ordered-object engine

- 从原生 link 捕获 188 个 object input 的顺序；
- `requiredLibraries.cpp`、SrcWrapper/HAL 和 variant objects 全部 immutable；
- 不重新归档、不猜顺序；include delta 一律回 CLI。

## 9. 不可跨越的门禁

- 不能从 CCDB 顺序推断 linker 顺序。
- 不能只验证 `core.a` 而漏掉 static runtime、SDK response、linker script 或 fixed objects。
- 不能跳过 link-critical prelink；只有输入/输出闭包已认证的 baseline-only prebuild 才允许不重跑。
- 不能把 compile-only ELF 与上一轮 upload-ready BIN/UF2/merged image/flash_args 并存并对外报告。
- 不能跨完整 FQBN 菜单项、Core 版本、CLI、工具链或 property contract 使用能力。
- 不能把某个 S3/ESP8266/STM32 板型样本资格推广到同架构其他板型。
- 不能因 direct compile/link 成功就授予资格；必须做与原生 Release 的 source、section/resource、主产物和 fallback 等价 A/B。

本轮只完成能力审查。建议立即执行的下一项工作是：**为 `arduino:samd:mkrzero` 捕获一份新的完整 Release E1 基线，并只实现 compile-only `CoreArchivePlusStaticArchives` 原型**。
