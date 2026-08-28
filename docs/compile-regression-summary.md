# 一键编译回归摘要

更新时间：2026-08-25。该文档描述摘要器的输入输出合同；摘要中的“当前”只指本次扫描到的证据，历史 JSON 不会自动升级为当前实测。

## 目标

`Summarize-CompileRegression` 将 C3、C5、C6、S3 和 Arduino AVR 的以下证据整理成同一份 JSON、Markdown 和控制台表格：

- 冷编译；
- Exact 精确命中；
- 改代码后的热编辑；
- 上传；
- 上传产物门禁。

它是证据汇总器，不是隐藏的真机测试器。运行摘要命令不会清缓存、编译、上传、打开串口或重置开发板，也不会把以前保存的结果描述成本轮实测。

## 使用

在仓库根目录执行：

```powershell
& .\scripts\Summarize-CompileRegression.ps1
```

默认读取 `artifacts/benchmarks/*.json`，生成：

- `artifacts/benchmarks/compile-regression-summary.json`
- `artifacts/benchmarks/compile-regression-summary.md`

只在控制台预览、不写文件：

```powershell
& .\scripts\Summarize-CompileRegression.ps1 -NoWrite
```

CI 要求五类目标的五项证据全部齐全时使用：

```powershell
& .\scripts\Summarize-CompileRegression.ps1 -Strict
```

`-Strict` 在存在失败、跳过、缺失、陈旧证据或无可信绑定的证据时返回非零退出码。日常本地汇总默认仍然生成报告，方便浏览历史结果；陈旧结果会明确标为 `stale`，但不会被描述成本轮实测。

## 状态含义

| 状态 | 含义 |
| --- | --- |
| `passed` | 来源证据记录了成功，并满足该阶段的确定性断言；只是历史证据通过，不代表摘要命令刚刚实测 |
| `failed` | 阶段明确失败，或证据字段不满足身份断言，例如冷编译不是 Full Build、Exact 没有命中、热编辑没有真实代码变化 |
| `skipped` | 证据生产脚本明确记录了主动跳过及原因 |
| `missing` | 没有可证明该阶段的证据；不会把“没找到”写成“跳过”或“失败” |

旧的 benchmark 文件没有稳定 `schemaId`、逐阶段 `success` 或完整 native binding 时，只能作为 `ignoredLegacyEvidence` 浏览，不能贡献 `passed`。新的 `Benchmark-CompileUploadNative.ps1` 会写入单次会话 `runId`、`evidenceScope`、明确的 `skippedStages`，并为每个 compile/upload operation 写入 `success=true`。

## 证据一致性

- 冷编译、Exact 和热编辑必须来自同一个 `cycles` 文档，避免从不同日期拼出一轮虚假的完整测试。
- 上传进度和产物门禁可以来自专门报告，但只有完整 FQBN 与主编译会话完全一致时才会合并。
- FQBN 菜单选项顺序不同可以规范化比较；Flash、PSRAM、分区或其他选项值不同仍视为不同配置。
- FQBN 必须包含非空 package、architecture 和 board；菜单必须是唯一的 `key=value`。重复 key、空值、额外冒号或空 board 会被拒绝，不能形成一个看似完整的目标行。
- 主 benchmark、独立上传进度和产物门禁只有在源码树三项哈希、release gate、production EXE、进程 PID 与 CDP 绑定完全一致时才能合并；同 FQBN 但不同候选或不同进程不会拼成一行。
- 每个阶段保留来源路径、捕获时间、证据年龄和 `sameInvocationAsSummary=false`。
- `fresh` 只表示证据未超过年龄阈值，仍然不是本轮摘要命令的新测试。
- `capturedAt` 必须是带时区的 ISO-8601 时间且不能来自未来。普通浏览允许显示陈旧证据；`-Strict` 不允许陈旧证据通过。
- 无法解析的 JSON 会进入 `sourceErrors`，不会静默忽略。

摘要器只承认三种稳定生产者身份：`ck.native-compile-upload-benchmark`、`ck.native-upload-progress` 和 `ck.native-upload-manifest-gate`。编译周期的秒数必须是 JSON number，不能用字符串、布尔值、数组或 `null` 冒充；冷编译、Exact、热编辑和上传的成功与负条件都必须由显式布尔字段证明。产物门禁同时要求 FQBN 错配与产物 SHA-256 篡改均在 transport 前被拒绝、重新封存后复验上传成功，并完成两次清理恢复；单独的 `artifactGate.passed=true` 不构成证据。

这些检查用于防止历史目录里的普通 JSON、旧格式或不同候选证据误拼成通过结果。它仍然不是密码学签名者，也不会在摘要阶段重新哈希整个源码树或 EXE；需要形成发布结论时，`New-ReleaseEvidenceManifest` 负责重新绑定并复核当前候选文件。

### 冷编译的缓存口径

摘要不会把所有“冷编译”视为同一种测试。每个目标的 `cold.details.cacheReset` 和 Markdown 证据段都会明确输出：

- `scope`：是否只清理精确完整 FQBN；
- `ccacheStore`：ccache store 是 `preserved`、`cleared` 还是 `unknown`；
- `prebuiltCore`：预构建 Core 是 `preserved`、`cleared` 还是 `unknown`；
- `forceCcacheRecache`：是否有明确证据启用了强制 recache；
- `forceRebuildPending`、清理条目数和字节数。

旧 benchmark 只记录了 `force_rebuild_pending`，没有记录 ccache store 和 prebuilt Core 的保留策略。因此当前旧证据会如实显示 `unknown`，不会根据今天的实现倒推当时的运行口径。新 benchmark 会额外捕获 `Forced rebuild`、ccache recache 和 prebuilt Core 注入日志；只有明确日志或未来扩展后的结构化字段才能把对应项从 `unknown` 改为确定值。

后续性能报告必须区分三类冷路径，不能把数字合并后宣称“首次编译”：

- `hardRefreshCold`：用户主动刷新当前完整 FQBN 的缓存；清理预构建快照并强制 ccache recache。这是安全恢复基线，不能为提速取消重编。
- `firstProjectCold`：清理当前完整 FQBN 的 CK build/meta、预构建 Core 和依赖对象缓存，但保留全局 ccache 命中且不设置强制 recache 标记；这是“当前配置没有准备好 Core”的保守首次工程口径。
- `readyInstallCold`：清理工程 build/meta 和依赖对象暂存，但保留通过 v5 身份校验的精确完整 FQBN 预构建 Core；用于衡量启动热集已经准备好当前配置后，新建工程的真实首编译体验。Core 不存在、身份不符或没有实际注入时该模式直接失败，不能退化后仍冒充 ready。
- `readyInstallCold` 的无 CLI-CCDB 快速入口还要求 `QuickFast`、工程 meta/backup/CCDB 均为空且 `extra_libs` 为空；当前 include 作为初始 added 集合进入既有核心库解析与严格 CCDB 合成门禁。Benchmark 只有在同一 cold cycle 明确报告 `fast_relink_ccdb_prepare method=synthetic ... status=success`，且没有出现 `method=arduino-cli-only-compilation-database` 时才允许通过；Sibling、失败或 `not_created` 不能冒充合成成功。报告中的 `fast_relink_ccdb_prepare`、`fast_relink_dependency_cache_staging`、`fast_relink_dependency_objects` 用于拆分 CCDB、对象暂存、依赖编译和 ccache 指标耗时。
- `newConfigCold`：此前从未出现过的完整 FQBN，没有该配置的预构建 Core，但保留全局内容缓存；用于衡量 Flash、PSRAM、USB 或分区新组合的首次成本。

三类报告都必须输出完整 FQBN、Core/工具链身份、缓存清理范围和产物门禁结果。缺少口径字段时状态保持 `unknown`，不得靠耗时猜测命中了哪一层缓存。

## 生成新证据

真机证据仍由现有脚本显式生成，例如：

```powershell
& .\scripts\Benchmark-CompileUploadNative.ps1 `
  -Port COM12 `
  -ProjectName c6_regression `
  -ExpectedFqbn 'esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB' `
  -OutputPath .\artifacts\release\v1-c6-hardware-regression.json `
  -ProgressOutputPath .\artifacts\release\v1-c6-upload-progress.json `
  -RequireUploadProgress
```

该命令会清理精确 FQBN 缓存并执行真实编译和上传，必须在用户明确选择好工程、端口和开发板后运行。摘要器不会自动调用它。

若要测量“全局 ccache 已存在，但当前完整配置没有准备 Core”的保守首次工程编译，请显式增加 `-FirstProjectCold`：

```powershell
& .\scripts\Benchmark-CompileUploadNative.ps1 `
  -FirstProjectCold `
  -Port COM12 `
  -ProjectName c6_regression `
  -ExpectedFqbn 'esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB' `
  -OutputPath .\artifacts\benchmarks\esp32c6-first-project.json
```

结果顶层的 `coldMode` 会明确记录 `firstProjectCold` 或默认的 `hardRefreshCold`，`cacheClear` 同时记录清理范围、ccache/预构建 Core 保留策略及是否强制 recache。`-FirstProjectCold` 与 `-SkipCold` 不能同时使用。UI 的缓存硬刷新仍走原有 `hardRefreshCold`，不会因为性能基准而削弱。

若要测量“启动预热已经为实际完整 FQBN 准备好可信 Core”的新工程体验，改用 `-ReadyInstallCold`。它与 `-FirstProjectCold`、`-SkipCold` 互斥，并要求报告明确出现精确 Core 注入证据。

若只采集编译而不碰真机上传，应显式使用 `-SkipUpload`。报告会把上传记为 `skipped`，不会伪装成通过：

```powershell
& .\scripts\Benchmark-CompileUploadNative.ps1 `
  -SkipUpload `
  -OutputPath .\artifacts\benchmarks\esp32s3-compile-only.json
```

## JSON 顶层字段

- `schemaId`: 固定为 `ck.compile-regression-summary`；
- `generationMode`: 固定为 `evidence-only`；
- `currentRunExecuted`: 固定为 `false`；
- `overallStatus`: `complete`、`incomplete` 或 `failed`；
- `counts`: 五类目标共 25 个阶段的状态计数；
- `targets`: 每种目标的完整 FQBN、阶段结果和来源；
- `sourceErrors`: 无法读取或解析的证据文件。
- `strictFreshness`: 本次是否按 CI 严格新鲜度策略汇总。

离线单元测试：

```powershell
node --test .\scripts\Summarize-CompileRegression.test.mjs
node --test .\scripts\Benchmark-CompileUploadNative.test.mjs
```

## 首次编译稳定性汇总

`Summarize-FirstCompilePerformance` 只聚合已有的 `Benchmark-CompileUploadNative` JSON，不会触发编译、上传或缓存清理。策略固定为每种模式恰好 3 份独立样本，以及 median、nearest-rank p95 均改善至少 30%；库调用方不能降低这些阈值，也不能靠加入额外有利样本改变统计结果。

输入只允许位于 `-Root` 内的文件。loader 会拒绝绝对引用、`..`、符号链接/realpath 越界，并重新读取与校验源码 manifest、freeze record、release gate 和 production EXE：包括文件 SHA-256、EXE 字节数、manifest 内逐文件哈希与 tree hash、freeze/manifest 绑定、gate 的 `passed` 状态和同一源码身份。聚合函数只接受该 loader 在本次进程中验证且验证后未被修改的对象；手写 JSON 中的“已验证”字段不能充当认证。

这是一项同源本地文件的直接验证，不是密码学签名者、远端时间戳服务或第三方不可抵赖证明。发布证据 manifest 因生成顺序存在循环依赖，不作为该聚合器的输入；最终发布门禁仍负责把汇总报告纳入整套证据清单。

所有样本必须绑定同一工程、串口、完整 FQBN、初始源码指纹与 include 签名、源码树、发布门禁、production EXE 哈希与同一个运行进程 PID，并核对同一芯片、revision、实体 Flash 与明确 PSRAM 证据。每次样本还必须带有成功上传后新生成的完整 `verified_baseline`；FQBN、Core ID/版本、Arduino CLI、工具链、构建签名与优化等级在六次样本间必须完全一致。`compileProfile` 是本次真实上传操作的模式内证据：`firstProjectCold` 的 cold/upload/baseline 必须为 `quick-fast`，`readyInstallCold` 的 cold 必须为 `quick-fast`、upload/baseline 必须为 `shared-fast`。因此不能把 profile 强行改成统一值，使用 `-SkipUpload` 产生的报告也不能用于首次编译稳定性结论。

- `firstProjectCold` 必须是 Full Build，且不能是 Exact 命中。
- `readyInstallCold` 必须是 Fast Relink、非 Full Build、非 Exact；必须明确记录 `syntheticCcdbPrepared=true` 与 `arduinoCliCcdbRefreshObserved=false`，并有预构建 Core 已注入、已保留且已验证的证据。任一字段缺失也会失败。
- `cacheClear` 必须使用目标的完整 FQBN 和模式专属 scope：First 为 `first-project-full-fqbn`，保留 ccache 但不保留/验证预构建 Core；Ready 为 `ready-install-project-full-fqbn`，保留 ccache 且必须保留并验证预构建 Core。两者的 `force_rebuild_pending` 与 `force_ccache_recache` 都必须是字面量 `false`；字段缺失、字符串布尔或驼峰别名均不接受。
- Exact、热编辑及可选 priming 会作为独立原生 compile operation 复核，而不只相信顶层五项自报检查；上传基线时间还必须满足 `verified before ≤ capturedAt ≤ createdAt ≤ verifiedAt ≤ verified after`。
- cold 与 upload 都必须是 `ck.native-compile-upload-operation` schema v1 且字面量成功；upload 还必须报告正数有限耗时，baseline profile 必须与实际 upload profile 一致。六份报告都必须包含固定五项已通过检查，并保持 `skippedStages=[]`、`failures=[]`。
- 两种 cold 模式都必须明确报告 `compileLockWaitReported=true`，`compileLockSeconds` 必须是 0 到 5 的 JSON number；还必须明确报告没有等待或复用后台 warmup。缺失字段、字符串数字和大于 5 秒的等待都会失败。
- 六份样本按各自原生绑定时间排序后必须严格为 `First → Ready → First → Ready → First → Ready`，相邻验证窗口不得重叠；每份都必须满足 `gate 完成 ≤ EXE 启动 ≤ verified before ≤ capturedAt ≤ verified after`。整批最多 2 小时，证据最多 72 小时，未来时钟容差 5 分钟。
- 汇总输出 median、max 和 nearest-rank p95；ready 相对 first 的 median 与 p95 改善都必须达到 30%，否则报告为失败。
- 对外样本只输出顺序号与不可逆短哈希组成的 sample ID 和耗时；时序只输出策略、批次跨度及由最早样本推导的固定过期截止，不复制原始 benchmark `runId`、`capturedAt`、源码指纹、逐样本时间戳或 include header 列表。

示例：

```powershell
& .\scripts\Summarize-FirstCompilePerformance.ps1 `
  -InputDirectory .\artifacts\benchmarks\first-compile `
  -Strict
```

也可以重复传入 `-InputPath`。默认输出为 `artifacts/release/first-compile-performance-summary.json`。
