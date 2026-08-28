# ESP32-C6 16 MiB 真板回归计划

状态：本文件定义当前候选的可重复真板验收规范，不保存固定的“当前通过”结论。2026-07-13/14 的本机会话仅作为历史诊断，不能代表后来重新冻结的源码、production EXE 或发布候选。当前候选是否通过，只由绑定同一源码树、gate、EXE 哈希、进程、CDP 页面、完整 FQBN、Core、CLI、工具链与构建签名的最新证据清单裁决。

证据文件：

- `artifacts/release/v1-c6-device-health.json`
- `artifacts/release/v1-c6-hardware-regression.json`
- `artifacts/release/v1-c6-upload-progress.json`
- `artifacts/release/first-compile-performance-summary.json`
- `artifacts/release/v1-c6-manifest-gate.json`
- `artifacts/release/v1-c6-safe-cancel.json`
- `artifacts/release/v1-release-evidence-manifest.json`

旧目录中的报告即使写着 `passed`，也只有在最终证据清单逐项复核其源码、gate、EXE、进程和哈希后才能成为当前候选证据。

## 固定测试身份

- 软件：CK Tauri 桌面端，CDP 端口 `9223`。
- 测试项目：专用回归工程 `c6_regression.maker`，基准脚本退出前恢复原延时值与代码指纹。
- 串口：`COM12`。
- 板卡：`ESP32C6 Dev Module`，真机报告芯片 `ESP32-C6 rev0.0`。
- 实体 Flash：真机报告 `16 MiB`；没有可靠报告时不得从模块名猜测。
- Arduino Core：本轮证据绑定实际使用的 `esp32:esp32@3.3.6`，不代表锁死后续版本。
- 完整编译 FQBN：

  ```text
  esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB
  ```

`arduino-cli board details` 已确认 Core 3.3.6 对该配置解析为：16 MB Flash、`app3M_fat9M_16MB` 分区、应用上限 3,145,728 bytes。C6 菜单没有 PSRAM 选项，因此不得沿用 C5 的 `PSRAM=enabled`。

其余核心默认值仅用于复核，不写入项目的显式 FQBN：上传速率 921600、CPU 160 MHz、Flash 80 MHz/QIO、USB CDC 关闭、Core Debug 关闭、上传前不擦除全部 Flash、JTAG 关闭、Zigbee 关闭。

## 软件内创建专用工程

1. 回到主页，在编辑器外部选择 `ESP32-C6 (WiFi 6)`，再创建 `c6_regression`。不要在编辑器内部增加快速换板入口。
2. 打开编辑器内的“板卡设置”，只把 `Flash Size` 改为 `16M`、`Partition Scheme` 改为 `app3M_fat9M_16MB`，其余保持核心默认值。
3. 确认板卡设置按钮的最后一行完整等于上面的 FQBN，且配置状态为 `resolved`、无被丢弃选项。
4. 选择 `COM12`。
5. 放入一个 `wifi_connect` 积木和一个带稳定数字常量的延时积木。延时积木应是测试脚本支持的 `control_delay`、`controls_delay`、`io_delay_us` 或 `delay_ms` 之一。
6. 确认生成代码包含 `WiFi.h`，保存工程，并等待界面没有前台编译任务。

基准脚本会把延时数值临时加一，完成热编辑测试后恢复原值并确认保存；项目名、完整 FQBN 或串口任一不匹配时会在清缓存、改积木或上传前拒绝执行。

## 执行顺序

在仓库根目录的 PowerShell 中先设置一次精确身份：

```powershell
$Fqbn = 'esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB'
```

### A. 真机体检（不写 Flash）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-DeviceHealthNative.ps1 `
  -DebugPort 9223 `
  -Port COM12 `
  -ProjectName c6_regression `
  -ExpectedFqbn $Fqbn `
  -TimeoutSeconds 120 `
  -VerifySerialRestore `
  -OutputPath .\artifacts\release\v1-c6-device-health.json
```

继续前必须人工复核证据显示 C6、16 MiB、COM12、配置 Flash 16 MiB 与实体 Flash 一致。本机真机体检卡片应显示完整 MAC，方便现场核对；输出日志、落盘证据、诊断包和持久化基线仍必须脱敏。PSRAM 未报告只表示“未知”，不能写成“不存在”。

### B. 冷编译、Exact、首次热编辑与普通上传

本阶段使用 `-FirstProjectCold` 模拟“同一台电脑已有编译器全局缓存，但当前完整 FQBN 尚无工程缓存”的首次工程场景：清除当前完整 FQBN 的 CK 工程构建、元数据、预构建 Core 和依赖对象缓存，保留全局 ccache store，且不强制 `CCACHE_RECACHE`。该口径现在对应用户界面的默认“重建缓存/重新编译/重新烧录”；高级“彻底刷新”仍按当前完整 FQBN 强制 recache，用于确认缓存损坏或 Core 升级异常。随后写入一次正常测试固件：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Benchmark-CompileUploadNative.ps1 `
  -DebugPort 9223 `
  -Port COM12 `
  -ProjectName c6_regression `
  -ExpectedFqbn $Fqbn `
  -FirstProjectCold `
  -TimeoutSeconds 1200 `
  -OutputPath .\artifacts\release\v1-c6-hardware-regression.json `
  -ProgressOutputPath .\artifacts\release\v1-c6-upload-progress.json `
  -RequireUploadProgress
```

接受条件：

- cold 是首次工程缓存口径下的真实 `Full Build`，不是 Exact Match；报告必须显示 `coldMode=firstProjectCold`、ccache store 保留、prebuilt Core 清除且没有强制 recache。
- exact 明确命中 Exact Match。
- hotEdit 明确 `codeChanged=true`、不是 Exact Match，并优先走 Fast Relink。
- cold、exact、hotEdit 报告的 include 均为 `wifi.h`；只改延时后 include delta 为空。
- 使用同一候选严格交替采集恰好 3 份 `firstProjectCold` 与 3 份 `readyInstallCold`；每份都实际上传，验证窗口不得重叠，整批最多 2 小时且证据不超过 72 小时。严格摘要中 ready-install 相对 first-project 的 median 和 nearest-rank p95 都必须缩短至少 30%，40% 作为进阶目标。单次、额外挑选或历史耗时不能冒充该比例，热编辑也必须单独记录。
- upload 的目标 FQBN 精确一致，上传产物清单通过，传输结束后报告普通固件上传成功。
- 脚本退出前延时值和生成代码指纹恢复到初始状态，工程保存成功。

### C. 上传进度回归

应在阶段 B 的上传过程中同步采样，不应为了采样再烧录一次。至少记录：

- `data-ck-progress-stage`、进度消息、可见百分比文本、数值百分比和采样时间。
- 上传从 0 到 100，数值在 0..100 内，聚合进度不倒退；100% 只出现在复位或完成阶段。
- 至少观察到一个两位数百分比和最终 `100%`，百分比列不裁切任何数字。
- 首次完整编译或重建使用不确定进度、持续计时和静默说明，不再伪装成卡在 95%。

`Benchmark-CompileUploadNative.ps1` 已支持两个可选参数：

```text
-ProgressOutputPath <path>
-RequireUploadProgress
```

实现会在现有 `runOperation('upload')` 的 200 ms 轮询中去重保存样本，并断言边界、聚合单调性、两位数显示、最终 100% 以及百分比文字没有被布局裁切。阶段 B 的命令已同时启用两个参数，输出：

```text
artifacts/release/v1-c6-upload-progress.json
```

### D. 错配置产物门禁

阶段 B 必须先成功，并且当前 FQBN 下不能已经存在 SharedFast 缓存。基准脚本开头的精确缓存清理可以建立这个前提。以下阶段会再次写入正常测试固件：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-UploadManifestGateNative.ps1 `
  -DebugPort 9223 `
  -Port COM12 `
  -ProjectName c6_regression `
  -ExpectedFqbn $Fqbn `
  -WrongPartitionScheme fatflash `
  -TimeoutSeconds 1200 `
  -OutputPath .\artifacts\release\v1-c6-manifest-gate.json
```

`fatflash` 是同一 Core 中有效的另一套 16 MiB 分区，仅用于把 QuickFast 清单的 `canonicalFqbn` 临时改错；脚本不修改固件文件。接受条件：

- QuickFast 缓存先达到 Exact Match，并验证已有上传清单。
- 错误清单在传输前被拒绝，不能先写板再报错。
- 自动转入 fresh SharedFast，重新生成并验证当前正确 FQBN 的产物后才允许传输。
- 原 QuickFast 的 bootloader、分区表、boot_app0、应用固件、flash_args、build options 与分区定义字节均保持不变。
- 临时清单被可靠恢复或由正确重建清单替代，外部备份和临时残留被清理。
- 最终板上保留的是当前正确 FQBN、当前已恢复源码对应的正常固件。

## 脚本审查结论与建议参数

现有三个脚本都具备项目名、完整 FQBN、串口和 CDP 页面的精确前置校验，C6 不需要为板型新增硬编码分支。还建议后续补齐以下可选断言，避免证据只证明“脚本运行成功”：

- `Test-DeviceHealthNative.ps1`：`-ExpectedChip ESP32-C6`、`-ExpectedFlashBytes 16777216`。
- `Benchmark-CompileUploadNative.ps1`：进度输出和严格门禁已实现；仍建议补 `-ExpectedCoreVersion 3.3.6`。
- `Test-UploadManifestGateNative.ps1`：默认输出名目前写死为 C5；C6 运行必须显式传 `-OutputPath`，或以后按 `ProjectName` 派生默认名。

Core 版本断言只绑定本次认证证据。产品兼容策略仍应是：低于最低要求或命中已知不兼容范围才阻止；兼容但非推荐、超过已验证上限或新版本未复验时允许继续并显示警告。

## 第三方 C6 板卡包自动认证补充回归

以下是历史候选证据，不是当前 CK Forge v1 快速资格。`ck_example_c6_board.zip` 曾使用 `ck-fast-build-contract-v6:O1-final-g0-no-lto-expanded-ccdb-core-deps` 通过桌面软件真实导入和三档 `compile-only` 自动认证，最终 `ck.lock` 状态为 `compile_certified`；当前候选必须重新满足构建合同 v8 与工具链身份 schema v9，不能继承该 v6 结果：

- N4 Wi‑Fi：Flash 930,740 B，RAM 39,964 B，0 条警告；随后 Exact 回放 0.9 秒且字节数一致；
- N8 Wi‑Fi + Zigbee：两个 smoke 均通过，分别记录 930,740/39,964 B 与 251,624/13,396 B，0 条警告；Zigbee Full 与 Fast Relink 都是 251,624 B，Wi‑Fi Fast Relink 与随后 Exact 都是 930,740 B；
- N16 Wi‑Fi：Flash 930,756 B，RAM 39,964 B，0 条警告；随后 Exact 回放 0.9 秒且字节数一致。

三个档案都绑定 `esp32:esp32@3.3.6`、完整 FQBN、工具链键、构建签名和各自 `partitions.csv` SHA-256。认证没有上传固件或访问 COM12；`matrix_executed:false` 与 `timeout_enforced:false` 保持如实记录。

旧 v2/v3/v4 认证曾允许 `-Os` CCDB、无法证明来源的 Core 归档或旧合成规则产生的依赖对象进入 Fast Relink，使 Wi‑Fi 资源低估约 3.2 KiB、Zigbee 低估 48 B。v5 会在 CCDB 克隆/播种/执行前核对最后有效的 `-O1 -g0 -fno-lto`，Core 身份只能由成功 Full/暖机构建或已验证快照写入，并把依赖对象缓存绑定到认证引擎契约；旧护照和对象链会自动失效，不能通过手工补字段恢复绿色。
