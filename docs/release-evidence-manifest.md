# CK 1.0 机器证据清单

[`New-ReleaseEvidenceManifest.ps1`](../scripts/New-ReleaseEvidenceManifest.ps1) 是 CK 1.0 候选的最终机器裁决器。它不执行构建或真板测试，而是在这些步骤完成后，把同一份冻结源码、同一次自动门禁、同一个 production EXE、交付包和原生／C6 报告重新验算并绑定成一个不可扩大的结论。

## 固定结论边界

即使所有证据通过，清单也只能写出：

- `status: passed`；
- `releaseClass: local-machine-and-closed-test-candidate-only`；
- `publicFormalRelease: false`。

未签名的 EXE、MSI、NSIS 或 SDK 不影响本机／封闭测试候选本身，但绝不能借此提升为公开正式发布。清单会记录每个交付物的 Authenticode 状态和时间戳状态；公开分发仍需可信签名、时间戳以及安装／升级验证。

## 必需证据

默认命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\New-ReleaseEvidenceManifest.ps1
```

默认读取并复核：

- `source-tree-manifest.json` 与 `source-tree-freeze.json`，包括每个源码文件的字节数、SHA-256 和树哈希；生成器还会重新调用权威 `New-SourceTreeManifest.ps1 -Mode Verify`，所以冻结后新增但未列入旧清单的源码同样会使候选失效；
- `v1-release-gates.json`，其 schema 必须正确，并且必须恰好包含 14 个固定、唯一、全部通过的 gate：源码前检、版本、资源契约、rustfmt、前端／脚本／三组 Rust 测试、示例、SDK、production build、安装包和源码后检；
- 当前 `target/release/appsdesktop.exe`；
- 本轮 gate 记录且当前哈希仍一致的 MSI、NSIS、Extension SDK；
- gate 记录且磁盘上恰好存在、本轮 gate 启动后生成的 5 个确定性示例 ZIP；名称固定为 `ck_example_c6_board.zip`、`ck_example_i2c_sensor_v2.zip`、`ck_example_nano_board.zip`、`ck_example_native_deep.zip` 和 `ck_example_serial_blocks.zip`；
- gate 的 `compatibility_reports` 中恰好两项内置兼容证据：`builtin-block-generator-audit.json` 与 `core-compatibility-results.json`；最终清单重新读取其固定相对路径，复核字节数、SHA-256、mtime、`generated_at` 和 gate 启动时间；
- production 原生冒烟、桌面内存回归、C6 编译／上传 Benchmark、DeviceHealth、UploadProgress、UploadManifestGate 和 SafeCancel。
- `first-compile-performance-summary.json`。它是 CK 1.0 的必需引用：`firstProjectCold` 与 `readyInstallCold` 各恰好 3 份并严格交替、验证窗口不重叠、编译锁等待不超过 5 秒、median 与 nearest-rank p95 改善都至少 30%，且每份样本都必须有成功上传形成的完整基线。最终清单会重新计算样本统计和改善比例，并将工程、同一端口与结构化硬件属性、完整 FQBN、Core／CLI／工具链／构建签名／优化等级、源码冻结、gate、production EXE 与同一 native PID 逐项绑定；同时按模式复核 `cacheClear` 的完整 FQBN、reset scope 与原生布尔缓存状态，验证 cold／upload profile、Exact／hot-edit／可选 priming 原生操作，并要求 `verified_before <= capturedAt <= baseline createdAt <= baseline verifiedAt <= verified_after`。

首次编译汇总不引用最终 evidence manifest，因为后者只有在所有汇总完成后才能生成；最终 manifest 单向引用汇总报告并记录其字节数和 SHA-256，从而避免循环依赖。这条链证明同一工作区本地文件的一致性，不冒充第三方签名或远端时间戳证明。

每个原生报告必须提供相同的绑定对象：

```json
{
  "source_tree": {
    "manifest_path": "artifacts/release/source-tree-manifest.json",
    "manifest_sha256": "...",
    "freeze_record_path": "artifacts/release/source-tree-freeze.json",
    "freeze_record_sha256": "...",
    "tree_sha256": "...",
    "frozen_at": "..."
  },
  "executable": {
    "path": "target/release/appsdesktop.exe",
    "bytes": 123,
    "sha256": "...",
    "process_id": 1234
  },
  "cdp_binding": {
    "bound": true,
    "debug_port": 9223,
    "process_id": 1234,
    "browser_process_id": 5678,
    "browser_host_process_id": 5678,
    "listener_owning_process_id": 5678,
    "target_id": "...",
    "target_type": "page",
    "target_url": "http://tauri.localhost/",
    "web_socket_debugger_url": "ws://127.0.0.1:9223/...",
    "executable_sha256": "..."
  },
  "gate_run": {
    "run_id": "...",
    "finished_at": "...",
    "report_path": "artifacts/release/v1-release-gates.json",
    "report_sha256": "..."
  },
  "binding_verification": {
    "verified_before_at": "...",
    "verified_after_at": "...",
    "unchanged": true
  }
}
```

这些字段证明报告针对哪份源码、哪个 EXE、哪次 CDP 原生会话和哪次门禁。Windows 原生证据的 `target_url` 必须按原样精确等于 `http://tauri.localhost/`；`http://localhost:1420/` 开发服务器、`chrome-error://chromewebdata/` 导航错误页，以及大小写、查询参数或片段不同的近似地址都会 fail-closed 为 stale。即使七份报告共同记录了同一个错误地址，也不能靠“跨报告一致”继承候选资格。只有文件名相同、旧报告仍写着 `passed` 或截图看起来正常，同样不能继承当前候选资格。

七份原生报告必须具有同一个 EXE PID、WebView2 browser／listener owner、CDP target、调试端口、EXE SHA-256 和 gate run。时间顺序固定为 `gate finished <= binding before <= report captured/finalized <= binding after <= now`；字段缺失或任一报告换了进程／target 都会退回 stale。

C6 的 Benchmark、DeviceHealth、UploadProgress、UploadManifestGate 和 SafeCancel 还必须记录同一个规范化工程名、串口和完整 ESP32-C6 FQBN。Benchmark 不能跳过阶段，必须同时含有冷编译、Exact、真实热编辑、源码恢复和普通上传证据。DeviceHealth 必须有结构化芯片／实体 Flash／完整 FQBN、隐私和串口恢复检查；UploadProgress 必须显式 `status=passed` 并验证单调、两位数样本与最终 100%。UploadManifestGate schema v2 必须分别证明“应用产物 SHA-256 被改写”和“完整 FQBN 被改写”都在 transport 前拒绝，两个阶段各自以精确完整 FQBN 清缓存并设置强制重建／ccache recache、禁止沿用 prebuilt core，随后都生成新鲜、已复核的 SharedFast 清单再上传；两种变异都只能改 manifest，固件／分区等受保护文件必须不变，备份、残留和有效原清单必须完整恢复。SafeCancel 固定由普通上传按钮启动，清理当前完整 FQBN 缓存后等到真实 Arduino CLI／GCC 进程出现才取消；报告必须证明 `upload_sketch` 与 `cancel_foreground_build` 使用同一 UUID、后端终止并 wait 至少一棵该 run 拥有的进程树、没有 `avrdude` 或 esptool `write_flash`／串口 transport、CK 工具树与全局 CK 关联孤儿连续三次归零，并立即以新 UUID 仅编译成功且 compile-lock wait 不超过 5 秒。esptool `elf2image` 只属于构建打包，不得误报为 Flash transport。

Benchmark 的普通上传还必须明确报告上传专用的 `Upload compile lock wait`，等待不超过 5 秒，且不得出现“等待匹配预热”或“复用兼容后台预热”。普通编译的 `Compile lock wait` 不能冒充上传遥测；缺少字段不能按 0 秒通过。最终清单会从 upload cycle 保留的原始 Timing 行重新求和，并要求原始 evidence、cycle 结构化字段和顶层 `uploadCompileLock` 三方一致；两层 warmup 标志必须显式为布尔 `false`，`failures` 必须是显式空数组，任何原始 warmup marker 都会令证据失效。

production 原生冒烟使用 schema v3，并固定校验 28 个、恰好一致的 check。它必须在同一个真实 Tauri／CDP／production EXE 会话中且不启用 viewport emulation，实际完成主页与 `c6_regression` 工作区往返、浅色／深色切换及原设置恢复、主页高级诊断完整系统路径、可换行的精确完整 FQBN、一次真实成功编译后的工程体检与资源预算无重叠／无横向溢出／收起重开、带来源的全局积木搜索、工程检查点／唯一滚动恢复稿／上一个可用版本入口。它还必须通过真实串口菜单精确选中本轮指定端口，再证明未知积木工程的普通上传是在保护逻辑内阻止，而不是因为“未选择串口”提前返回；报告只保存“已精确选择”的布尔证据，不复制端口值。它还必须从确定性示例复制唯一临时声明式积木包，证明完整质量报告与 `declarative-safe` 运行时并在搜索中显示正确来源；构造的 Legacy `blocks.js`／`generator.js` 包必须在导入门禁 fail-closed、sentinel 未执行且未进入库列表；唯一未知积木工程的保存、编译和普通上传不得触达对应后端，原文件字节必须保持一致。报告完成前必须只删除本轮创建的包、恢复稿、工程和临时源，恢复原主题，并重新打开 `c6_regression`。报告只记录数量、布尔值、固定工程名与 FQBN，不记录任何本地绝对路径、端口值或完整 MAC。

内存报告必须是 10 轮、`result_kind=conclusive`、污染状态 `clean`，并明确绑定 `project.requested_name=c6_regression`、非空 `code_fingerprint` 和完整 `esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB`，同时包含 dashboard／workspace 内存、DOM、事件监听、Blockly 生命周期和进程污染的固定核心 check。只写一个笼统 `status=passed` 不构成证据。

### C6 跨报告一致性门禁

最终裁决不再逐份相信报告里的布尔结论，而是重新计算并交叉绑定：

- Benchmark、DeviceHealth、UploadProgress、UploadManifestGate 和 SafeCancel 必须逐份写明 `project=c6_regression`、`port=COM12` 以及精确完整 FQBN `esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB`，不能只写 C6 前缀。
- Benchmark 与 DeviceHealth 的芯片型号归一后必须同为 `ESP32-C6`；两份实体 Flash 都必须是 16 MiB，DeviceHealth 的配置 Flash 也必须是 16 MiB 且不大于实体容量，编译资源上限不能大于配置容量。
- 每个带地址的固件段都重新解析 `flashAddress + size`；段必须完全位于 16 MiB 实体 Flash 内，且任意两段不得重叠。
- Benchmark 与 DeviceHealth 都必须显式提供 `psramBytes`。两边同为 `null` 只表示 unknown，DeviceHealth 的 `psramEvidenceState`／`psramCheckState` 也必须为 unknown；两边为正数时容量必须相同。单边有值、属性缺失，或 FQBN 明确启用 PSRAM 却没有真机容量，都会拒绝该证据集。
- Benchmark 顶层 `runId`、内嵌 UploadProgress 和独立 UploadProgress 的 `benchmarkRunId` 必须一致。裁决器逐个样本重算 0～100 整数范围、单调性、10～99 中间样本、最后 100、精确百分比文字、文字宽度、非负单调耗时、样本数及上传 wall time，并要求内嵌与独立样本完整一致。
- 内存回归、Benchmark 初始／恢复、SafeCancel 前／后和 UploadManifestGate 前／后的源码指纹必须相同；各报告提供的 include signature 也必须一致。普通 FQBN 恢复和 SHA-256 恢复两份 SharedFast manifest 都必须是精确 FQBN、新鲜封存且带 64 位十六进制哈希。

### 输入大小与隐私 fail-closed

每个被引用的 JSON 证据上限为 16 MiB，超过上限会在解析前失败。所有引用 JSON 都会扫描冒号／短横线／点分 MAC、带 MAC 标签的裸 12 位值、含 A～F 的无标签裸 12 位值、任意盘符绝对路径、UNC 路径和 `file:///` URI；命中任意一种都会令整个证据集 `failed`，而不再是“记录观察后仍允许通过”。纯数字的无标签小数测量不会冒充设备地址，但 `mac: 123456789012` 仍会被阻止。最终清单只保留固定 issue ID、证据角色、相对路径、字节数和 SHA-256，不复制敏感原值，并在原子写入前后再次扫描自身。

### 内置积木兼容证据边界

`builtin-block-generator-audit.json` 必须是 `ck-builtin-block-generator-audit` version 1、`hardwareTested=false`，并精确报告 147 个积木、294 个目标生成、294 通过、0 失败。`core-compatibility-results.json` 必须是 `ck-core-compatibility-results` version 1、`generatorOnly=true`、`evidence=compile-only`、`hardwareTested=false`，积木／目标单元／静态生成通过数固定为 147／294／294；`results` 必须恰好 7 项，每项均为 `Passed=true`、`Evidence=compile-only`、`Source=built-in-generator`、`HardwareTested=false`。这些结果证明真实工具链 compile-only，不得描述为上传、启动、外设或真板功能验证。报告内容、gate 摘要与磁盘哈希任一不一致都会使候选失效。

## 裁决规则

- 明确的测试失败、报告 `failed`、非空 `failures` 或任一 `checks[].passed=false` 产生 `status: failed`。
- 文件缺失、JSON 损坏、哈希／字节数失配、源码树变化、gate run 不同、EXE 不同、CDP 未绑定、CDP target URL 不是精确生产地址 `http://tauri.localhost/`、报告早于 gate 或超出证据时效，产生 `status: candidate_evidence_stale`。
- 脚本启动后先用一个 `candidate_evidence_stale` 失效标记原子替换旧输出；中途异常会再次失效或删除输出，绝不保留历史 `passed`。成功结果使用同目录临时文件和 `File.Replace` 原子替换，临时／替换备份在 `finally` 中清理。
- 输出中的每个引用只保存工作区相对路径、字节数和 SHA-256。写入前、原子替换后都会再次验算引用，避免并发改写继承早先结果。
- 共享原生绑定在 PowerShell 5.1 下递归脱敏并重新编码报告时，必须保持空数组和单项数组的 JSON 类型；`failures: []`、`observations: []` 等机器字段不得变成 `{}`、`null` 或标量，否则按 schema 失效处理。
- 输入报告一旦包含完整 MAC 或本地绝对路径，整个证据集立即失败；最终清单只记录观察数量而不复制敏感值。扫描范围包含冒号／短横线／点分 MAC、带标签的纯数字裸 MAC、含 A～F 的无标签裸 MAC，以及盘符、UNC 和 `file:///` 绝对路径；普通小数位不会被误判为 MAC。

普通候选证据的默认且允许的最大年龄是 72 小时；`-MaximumEvidenceAgeHours` 只接受 1～72，可设得更短，不能放宽到 72 小时以上，也不能绕过源码、gate、EXE 或报告绑定。首次编译 3+3 批次另有固定 72 小时截止：摘要从最早样本推导 `batch.expiresAt`，最终 evidence manifest 必须在该时刻前生成，`-MaximumEvidenceAgeHours` 不得延长这一截止时间。

## 推荐顺序

1. 停止源码写入并创建 source-tree manifest／freeze。
2. 运行完整 release gate，生成 production EXE、恰好 5 个示例、SDK、MSI 和 NSIS。
3. 使用同一个 production EXE 完成 schema v3 产品化原生冒烟和内存回归；原生冒烟会为资源布局证据执行一次真实编译，但不会上传固件。
4. 使用同一 EXE 与同一 gate 绑定完成 C6 真板五份证据，其中 `Test-SafeCancelNative.ps1` 写入 `artifacts/release/v1-c6-safe-cancel.json`。
5. 用同一 production PID、完整 C6 FQBN、源码冻结与 gate 按 First／Ready 顺序交替运行恰好 3+3，每次都实际上传形成可用基线，且相邻验证窗口不得重叠；随后生成 `artifacts/release/first-compile-performance-summary.json`。
6. 最后运行本脚本生成 `artifacts/release/v1-release-evidence-manifest.json`。
7. 清单生成后若源码、EXE、安装包或任何报告变化，候选立即失效，必须从相应步骤重跑。
