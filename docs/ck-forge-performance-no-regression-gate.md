# CK Forge / FLFE 性能认证与 A/B 不回退门禁

更新时间：2026-08-25。当前资格以审计脚本、证书和运行中的 production EXE 绑定为准；本文内的旧 EXE 哈希和历史报告只用于复核，不授予当前 Fast。

## 结论先行

“能够编译”“复用了缓存”和“比原生 Arduino CLI 快”是三件不同的事。

现有 `Run-CKForgeRegression.cjs` 继续负责兼容性、产物、资源、依赖闭包和路由证据；它不再被当作速度认证。任何 Core、工具链或完整 FQBN 只有通过本文件定义的 A/B 门禁，才允许标记为 **Fast**。未通过时推荐路由必须是 `native-arduino-cli`，而不是把兼容通道包装成快速通道。

门禁实现：

- 公平采集：`scripts/Run-CKForgeNativeAB.cjs`
- `scripts/Evaluate-CKForgePerformanceGate.cjs`
- 输入 Schema：`docs/schemas/ck-forge-performance-ab-candidate.schema.json`
- 输出 Schema：`docs/schemas/ck-forge-performance-qualification-report.schema.json`
- 自动化测试：`scripts/Evaluate-CKForgePerformanceGate.test.mjs`

## 认证键

认证不按“ESP32”“STM32”这种大类发放，而按下列完整身份生成 SHA-256 `qualificationKey`：

- 当前主机身份；
- Arduino CLI 可执行文件 SHA-256 和自报版本；
- Core package、architecture、version；
- 工具链强身份及 Core/tool 内容 SHA-256；
- 完整 FQBN，包括所有菜单选项；
- 固定 `simple → complex → medium → simple-return` 源码序列及 SHA-256；
- 采集时实际运行的 production EXE SHA-256；
- CK 编译合同；
- 性能策略 ID；
- `operation + candidateProfile` 能力边界；
- CK 与原生 CLI 的编译属性差异声明。

Core 升级、工具内容变化、production EXE 重建、完整 FQBN 变化或 CK 编译合同变化后，
旧认证自然失效，不能跨身份沿用。

普通 QuickFast/SharedFast schema v4 候选必须同时携带
`toolchainContentSha256` 与 `productionExecutableSha256`。前者必须与强
`toolchainKey` 的内容哈希后缀完全一致；后者是采集 A/B 时实际运行的
`appsdesktop.exe` 完整字节 SHA-256。评估器要求 CK/native 两条 lane、原始采集身份及
资格报告使用同一身份；Rust loader 会从 `current_exe()` 重新计算当前 EXE SHA-256，并
复核当前工具链内容身份。任一处不一致都不得启用 QuickFast/SharedFast。

NativeRelink 的授权边界在上述身份外更严格：还绑定 adapter/engine、原始 A/B 报告和
逐角色产物证据。普通 Fast 候选与 NativeRelink 均不能因为芯片族或基础板名相同而继承
资格。

## A/B 采集协议

普通 QuickFast/SharedFast 候选至少采集 5 个配对 trial。每个 trial 都从空的独立
build path 开始，并在同一路径内严格执行：

1. `simple`：简单源码的冷编译；
2. `complex`：切换到复杂源码；
3. `medium`：切换到中等源码；
4. `simple-return`：回到与第一阶段字节完全相同的简单源码。

每个 trial 都要分别运行 CK 与原生 Arduino CLI。采集顺序必须交替，例如：

```text
trial-1: CK -> native
trial-2: native -> CK
trial-3: CK -> native
trial-4: native -> CK
trial-5: CK -> native
```

这样可以减少系统温度、后台负载和文件系统热缓存只偏向其中一方的问题。采集期间不允许并发编译。
采集 runner 必须以 qualification 模式显式禁用 Exact。正常产品中的相同产物 Exact 回放
属于独立功能证据，不能进入四阶段计时，也不能被当作 CK 编译器速度。

NativeRelink compile-only 使用更严格的 `portable-edit` 协议：至少 5 个交替配对 trial，
每轮固定为 `simple → complex → medium → simple-return`。`simple` 建立原生 Release 基线；
后三个真实编辑阶段必须逐次命中证书声明的 adapter/engine，禁止 Exact、禁止 CLI fallback，
并逐角色证明 CK/native 产物与资源等价。冷 `simple` 结果必须如实记录，但不由热编辑资格
掩盖；热编辑通过不等于冷编译加速。

普通 QuickFast/SharedFast 与 NativeRelink 现在共用同一份可移植源码序列，但资格口径不同：
普通 Fast 要求四个阶段全部通过；NativeRelink 仍只授权三个热编辑阶段，并要求其专用
adapter/engine/artifact policy。两类结果不能相互继承。

### lane 边界空闲策略

Windows 上子进程刚返回时，`arduino-cli` 的进程枚举可能仍短暂可见。为了既不把这个清理尾巴误判为下一条 lane 的并发编译，也不把等待时间藏进 CK 或原生 CLI 的编译成绩，NativeRelink 资格采集固定使用机器可读策略 `arduino-cli-lane-idle-window-v1`：

- lane 启动前仍是即时 fail-closed：如果已有 `arduino-cli`，该 trial 不开始；
- lane 结束后必须连续 500 ms 观测到零个 `arduino-cli` 进程；
- 最多等待 15 秒，每 100 ms 轮询一次；超时即证据失败；
- 该等待明确位于 measured compile wall time 之外；
- 每个 trial 必须按 lane 实际顺序保存 `policyId`、`idleWindowMs`、`timeoutMs`、`pollIntervalMs`、`waitedMs` 与 `polls`；
- 评估器逐项复核策略常量、lane 数量、lane 顺序和数值边界，缺字段或旧策略证据不能签发证书。

这只修正采集边界的进程回收竞态，不会把 CK 的实际编译时间减去、暂停或重标，也不会放宽“采集期间不能并发编译”的要求。

以下条件必须可机器验证：

- 同一台机器；
- 同一个 Arduino CLI 二进制；
- 同一个 Core 版本和工具链；
- 同一个完整 FQBN；
- 同一份 sketch；
- 全局缓存对两条通道采用相同策略；
- 每个 trial 的初始 build path 确实为空，四次编辑保持在该 lane 的同一路径内；
- 两边都编译成功并产生已校验产物；
- 每次编译绑定原始证据文件 SHA-256 和产物集合 SHA-256；
- 依赖闭包、资源上限和产物安全门禁通过；
- 全程 compile-only，不上传、不打开串口、不写 Flash；
- CK 强加的 `-O1`、LTO、调试符号等属性差异必须明确记录，不能隐藏。

## 固定判据

普通四阶段判据被写死在版本化策略 `ck-forge-portable-edit-no-regression-v3` 中，
命令行不能临时放宽：

- 每条通道至少 5 个 trial；
- simple、complex、medium、simple-return 分别计算中位数；
- CK 四个阶段都必须比原生 CLI 至少快 25%；
- 每个阶段的中位数绝对收益至少 500 ms；
- CK 的 p95 不能比原生 CLI 慢；
- 两条通道每个阶段的变异系数不得超过 20%。

只有四个阶段全部通过才输出：

```json
{
  "status": "qualified-fast",
  "recommendedRoute": "ck-fast"
}
```

任何阶段失败都会输出：

```json
{
  "status": "not-qualified",
  "recommendedRoute": "native-arduino-cli"
}
```

合法但未通过的门禁退出码为 `2`，便于 CI 阻止错误进入 Fast 白名单；输入无效或证据不完整退出码为 `1`。

NativeRelink `portable-edit` 使用相同的每阶段相对收益、绝对收益和 p95 底线，但作用于
complex、medium、simple-return 三个编辑阶段；并额外要求 5 trials、零 fallback、精确
adapter/engine/artifact policy 与 production EXE 绑定。任一编辑阶段失败则不得签发 v4
证书。首次 `simple` 单独报告 cold no-regression，不计入热编辑资格，也不得显示成首编 Fast。

## 运行命令

先用同一套 runner 对一个精确 ESP32 身份进行受控 QuickFast compile-only 探针：

```powershell
node scripts/Run-CKForgeNativeAB.cjs `
  --plan `
  --fqbn esp32:esp32:esp32c6 `
  --qualification-operation compile `
  --qualification-profile quick-fast

$env:CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN = '<与 production 进程一致的 64 位小写十六进制令牌>'
node scripts/Run-CKForgeNativeAB.cjs `
  --execute `
  --allow-cache-reset `
  --fqbn esp32:esp32:esp32c6 `
  --qualification-operation compile `
  --qualification-profile quick-fast `
  --output artifacts/benchmarks/esp32-c6-quick-fast-raw.json `
  --candidate-output artifacts/benchmarks/candidates/esp32-c6-quick-fast.json `
  --candidate-artifact-bundle artifacts/benchmarks/candidates/esp32-c6-quick-fast-artifacts
```

提供 Fast operation/profile 后，runner 会强制选择 `portable-edit`；不能退回旧的
fresh/repeat 候选结构。生成的候选为 schema v4，并绑定固定阶段顺序、逐阶段源码哈希、
同 lane 构建路径、Fast route、recipe capability、实际 `arduino-cli-fast.yaml` 哈希、
原生 lane 编译属性摘要、资源和产物证据。原生 lane 的每次运行都必须重复携带同一属性摘要，
因此不能只靠 `compilePropertyDelta` 文案声称与 CK 公平可比。

`portable-fast` 只允许 `compile`，用于保留原生 Core recipes 的命令级 ccache
候选采集；它不具备上传产物资格。上传就绪能力必须另测，可选 `upload-ready + quick-fast` 或
`upload-ready + shared-fast`；该探针只编译并检查完整上传产物，不访问串口、不执行物理
烧录。runner 生成的候选文件只供后续独立门禁评估，**不会写入
`state/qualifications`、不会签发证书，也不会改变普通产品路由**。

只检查计划，不读取或写入认证结果：

```powershell
node scripts/Evaluate-CKForgePerformanceGate.cjs `
  --plan `
  --input artifacts/benchmarks/candidates/stm32-f401re-ab.json
```

正式评估，输出路径必须是新文件：

```powershell
node scripts/Evaluate-CKForgePerformanceGate.cjs `
  --evaluate `
  --input artifacts/benchmarks/candidates/stm32-f401re-ab.json `
  --output artifacts/benchmarks/stm32-f401re-performance-qualification.json
```

评估通过后仍不会自动启用 Fast。正式安装必须同时提交原始 A/B 报告、由该报告投影出的
candidate、可复算的 qualification report 和 runner 在清理短构建目录前保存的实际产物包：

```powershell
node scripts/Install-CKForgePerformanceQualification.cjs `
  --plan `
  --capture-report artifacts/benchmarks/esp32-c6-quick-fast-raw.json `
  --candidate artifacts/benchmarks/candidates/esp32-c6-quick-fast.json `
  --report artifacts/benchmarks/esp32-c6-quick-fast-qualification.json `
  --artifact-bundle artifacts/benchmarks/candidates/esp32-c6-quick-fast-artifacts `
  --qualification-root state/qualifications

node scripts/Install-CKForgePerformanceQualification.cjs `
  --install `
  --capture-report artifacts/benchmarks/esp32-c6-quick-fast-raw.json `
  --candidate artifacts/benchmarks/candidates/esp32-c6-quick-fast.json `
  --report artifacts/benchmarks/esp32-c6-quick-fast-qualification.json `
  --artifact-bundle artifacts/benchmarks/candidates/esp32-c6-quick-fast-artifacts `
  --qualification-root state/qualifications
```

安装器会重新从原始报告投影 candidate、重新运行固定策略评估、逐项验证实际产物，并以
no-clobber 临时目录原子生成 `candidate.json`、`report.json`、`artifact-manifest.json`、
`artifacts/` 和 `certificate.json`。`certificate.json` 只绑定这些字节的 SHA-256；安装器
不会写 `allow-fast`、不会修改路由清单，任一输入不一致时不会留下证书目录。

### v4 精确源码边界

当前普通 performance v4 identity 仍把固定 `portable-edit` 的 simple 源码 SHA-256 写入
`sketchSha256`，Rust loader 也要求运行时源码 SHA-256 完全相同。因此这类 v2 本地证书只
形成 `source-bound-sample-qualification`，**不能计为整块板卡、整个 Core 或任意用户工程的
Fast 资格**。`Report-CKForgeFastQualifications.cjs` 将其单列为
`sourceBoundQualifications`，不会增加 `qualifiedTargetCount`；普通工程继续走原生 Release。

要扩展到真实用户工程，需要另立新版本 workload-class 合同：机器可读描述源码/依赖类别，
用多工程覆盖矩阵验证该类别，并让 candidate、qualification key 与 loader 同时绑定该类别。
不得通过删除 `sketchSha256` 检查或把当前基准证书改名来扩大授权范围。

运行门禁自身回归：

```powershell
node --test scripts/Evaluate-CKForgePerformanceGate.test.mjs
node --test scripts/Install-CKForgePerformanceQualification.test.mjs
node --test scripts/Report-CKForgeFastQualifications.test.mjs
```

## 与现有回归的关系

兼容性回归仍先运行：

```powershell
node artifacts/benchmarks/Run-CrossBoard-CompileOnly.cjs `
  --targets stm32-f401re `
  --cold `
  --output artifacts/benchmarks/stm32-f401re-compatibility.json
```

它可以证明 CK 没有上传、使用了请求的 FQBN、产物存在且依赖闭包完整，但不能单独证明 CK 比原生 CLI 快。性能认证必须另有同身份的原生 CLI 配对样本。

## 当前数据应如何解释

以下两份结果绑定的是前一版 production EXE SHA-256
`fe1450c5a719adcf6851fd41e7f8315c9961a49d98d6c353bcfafea27549aa0f`
（43,314,176 bytes），现作为历史对照保留：

| 精确身份 | 5 轮 complex / medium / simple-return 相对原生 | cold `simple` | 状态 |
| --- | --- | --- | --- |
| `arduino:avr:uno`，AVR Core 1.8.6 | 快 37.15% / 50.12% / 43.47% | CK 慢 19.39% | `measurementStatus=passed`、`qualificationStatus=qualified` |
| `arduino:samd:mkrzero`，SAMD Core 1.8.14 | 快 41.25% / 44.63% / 35.59% | CK 慢 23.56% | `measurementStatus=passed`、`qualificationStatus=qualified` |

- [AVR Uno 正式报告](../artifacts/benchmarks/flfe-avr-native-relink-formal-20260719-exefe1450c5.json)
- [SAMD MKR Zero 正式报告](../artifacts/benchmarks/flfe-samd-mkrzero-native-relink-formal-20260719-exefe1450c5.json)

两份报告均为 5 trials，编辑阶段零 fallback，产物角色与资源等价。历史 v4 证书目录键
分别为 `4bfe55cb…` 和 `e28010e6…`；无 qualification token 的普通运行已验证
`authorization=certified` 并进入 `native-relink-compile-only`。这些结果只授予两个精确
身份在该旧 EXE 上的受限热编辑，不授予上传或冷编译资格，也不能授权 `821a2c10…` 或之后任一 EXE。30%～40% 冷编译目标仍未达到。

2026-07-19 历史 production build 的 SHA-256 为
`821a2c10991a68073983b0dc21cc0ceee944b28eba4b59280d769f84494bb2a9`
（43,474,432 bytes）。针对 Arduino AVR Core 1.8.6 的 38 个完整 FQBN，5-trial 精确资格批次已取得 `38 / 38` 个资格通过、0 个资格性能未达和 0 个资格证据失败。最终普通 production 路由矩阵覆盖 114 个单元，其中 112 个适用、2 个 Gemma 单元按声明跳过；112 / 112 个适用单元完成测量、NativeRelink 路由、产物与资源等价、恢复、lane 空闲和无 Exact 绕过门禁，896 次 compile-only 调用失败 0、fallback 0、Exact 0。

完整矩阵的 336 个热编辑配对样本中，CK 时间中位数为 2857.21085 ms，原生 CLI 为 5102.99545 ms；逐配对加速百分比中位数为 44.271%，最差样本仍快 17.584%、节省 841.856 ms。相反，冷 `simple` 的 CK 中位数为 9383.6598 ms，原生 CLI 为 7815.367 ms，110 / 112 个样本 CK 更慢。因此该历史 AVR 证据只证明这些精确身份在 `821a2c10…` 上的持证热编辑达标，**不证明首次编译加速，也不满足 30%～40% 的首次编译目标**。

- [历史 AVR 完整矩阵报告](../artifacts/benchmarks/ck-avr-full-matrix-exe821a2c10-20260719.json)
- [历史 AVR 精确资格批次摘要](../artifacts/benchmarks/avr-full-qualification-exe821a2c10-20260719-r4/summaries/summary-000001.json)
- [AVR 资格、Robot 修复与最终矩阵组合索引](../artifacts/benchmarks/ck-avr-full-qualification-repair-index-exe821a2c10-20260719.json)

旧 EXE `53dd76b7…` 的 C6/AVR/STM32 三平台 3 轮 A/B 与 C6/STM32 Exact 结果保留为
历史纠偏证据；它们不能覆盖后续 EXE，也不能扩展当前证书范围。Exact 是产物回放，
不进入 A/B、不等于 Fast。

### 当前 production EXE：运行时查询；旧快照不冒充当前

以下是历史 production EXE
`7b45eccf6dabbb4a23ebac269c7f8c1f1a04d1cf9a59e7acb5a4fe7fc7453476`
（44,863,488 bytes）。当时的评估器曾签发两个精确 Fast 资格：

| 精确身份 | Core | NativeRelink v4 证书键 | 历史裁决 |
| --- | --- | --- | --- |
| `arduino:avr:yun` | AVR 1.8.6 | `7d0f3abb…` | `qualified-native-relink` |
| `arduino:avr:uno` | AVR 1.8.6 | `7ff683e3…` | `qualified-native-relink` |

当前评估器重新读取这两份证书时会因缺少现行 lane-boundary/四阶段绑定而 fail-closed，
所以它们的**当前规则复算 Fast 数为 0**，不能继续显示为当前 Fast。该历史 EXE 当时的
ESP32 Fast 资格为 0，SAMD Fast 资格也为 0。MKR Zero 的旧证书绑定
`fe1450c5…`，不能授权后续 EXE。内置 `ck_forge_qualified_targets.v1.json` 只有静态候选身份，
没有 `performance_ab`，因此不是 Fast 白名单。Exact 只是在完整证据相同时回放产物，也不
签发证书或把 `force-platform` 改成 `allow-fast`。

当前或新构建 EXE 的唯一事实来源是下方查询脚本。没有当前证书时，ESP32-C3、C5、C6、
S3、H2、P4 与 Adafruit Feather ESP32-S3 显示为 `qualification-pending`，不是
`incompatible`；真实构建仍使用原生 Arduino CLI Release。只有当前 EXE/Core/工具链/完整
FQBN 的 `simple → complex → medium → simple-return` 四阶段 A/B 全部通过且证书可复算，
才进入 Fast-qualified 计数。

可重复审计命令：

```powershell
node scripts/Report-CKForgeFastQualifications.cjs --exe target/release/appsdesktop.exe --format text
node scripts/Report-CKForgeFastQualifications.cjs --exe target/release/appsdesktop.exe --architecture esp32 --format text
node --test scripts/Report-CKForgeFastQualifications.test.mjs
```

历史 Yun 与 Uno 的 cold `simple` 分别慢于原生 3.18% 与 26.40%，所以该快照的首次编译不
宣称 Fast，也不宣称达到 30%～40% 目标。旧 38-FQBN AVR 矩阵、MKR Zero 报告和所有
ESP32/STM32/PortableFast 报告继续保留为历史证据，不会被删除或迁移成当前资格。

## 产品路由接入

产品已采用 fail-closed 基线：`force-platform` 直接使用未注入 CK 加速变换的 `release`，
PortableFast 不再是未资格目标的默认通道。后续把某个目标升级为 Fast 时必须遵守：

1. 默认使用原生 Arduino CLI；
2. 仅当 `qualificationKey` 与当前主机、production EXE、CLI、Core、工具链、完整 FQBN、sketch 类别、adapter/engine 及 CK 合同完全匹配，且报告为 `qualified-fast` 或 NativeRelink 报告为 `qualificationStatus=qualified` 时启用证书明确授权的 CK Fast；
3. 报告缺失、过期、字段不匹配或状态为 `not-qualified` 时 fail closed 回原生 CLI；
4. 任何产品源码、编译合同、Core 或工具链更新后重新 A/B；
5. 兼容性报告不能替代性能资格报告。

## v4 Fast 证据与 NativeRelink v3 本机绑定（更新至 2026-07-26）

性能候选与资格报告使用 `schemaVersion: 4`，除 `operation` 和 `candidateProfile` 外，
还必须携带固定 portable-edit 序列、sequence SHA-256 和四阶段门禁证据。每条 CK 阶段
还必须证明 `candidateRoute: qualification-token-probe`、实际 `buildMode` 和
`fallbackUsed: false`：冷 `simple` 可使用 `full-build` 或 `fast-relink`，而
`complex`、`medium`、`simple-return` 只能使用真实 `fast-relink`。允许的能力是：

- `compile + portable-fast`：只允许原生 Core recipe + command-scoped ccache 的普通编译候选；
- `compile + quick-fast`：只允许普通编译使用 QuickFast；
- `upload-ready + quick-fast`：只允许上传前的 QuickFast 产物构建；
- `upload-ready + shared-fast`：只允许上传前的 SharedFast 产物构建。

三者互不继承。尤其是普通编译的 QuickFast A/B 通过，不代表上传产物钩子、
分区文件或 objcopy 流程已经验证，不能放行 QuickFast/SharedFast 上传。未持有对应
`upload-ready` 证据时，上传必须使用原生 Release。

每份 v4 报告同时绑定 `hostIdentitySha256` 与 `sampleSetSha256`。前者是当前机器、
CK sysroot 和宿主环境的隐私哈希，不能用通用的 `windows/x86_64` 代替；后者等于
评估器实际读取的原始候选 JSON 字节 SHA-256。因此证书不能跨机器复用，也不能只
手填汇总数字。只读资格 loader 已接入运行时；加载持久证书时会重新计算原始候选文件
SHA-256、报告文件 SHA-256 和当前本机环境指纹。内置清单没有 `performance_ab`，不是
Fast 白名单。旧 EXE 的 Uno/MKR Zero、Yun 与 38-FQBN AVR 证书只对各自旧 EXE 有效；
`7b45eccf…` 的精确 Yun 与 Uno 证书也只是历史快照。它们不形成跨 Core 版本、跨 FQBN
或跨主机授权。
任何未持有当前 EXE／当前身份精确证书的目标仍 fail-closed 使用原生 Release。严格相同产物的 Exact
回放不等于持有性能证书。

旧 `schemaVersion: 1/2/3` 不包含完整 token-bound Fast 执行边界，评估器会明确拒绝，不能自动迁移成 v4。

### 本地只读证书目录

运行时只从 `<CK sysroot>/state/qualifications/<qualificationKey>/` 读取证书，固定文件为：

```text
certificate.json
candidate.json
report.json
artifact-manifest.json
artifacts/...
```

`certificate.json` 使用 `ck.forge.local-performance-certificate` schema v2，只保存原始
候选、门禁报告和产物清单的 SHA-256；它本身不生成资格。普通 Fast 的候选和报告必须是
v4，旧 fresh/repeat v2 或 v3 证据不得安装为新资格。`artifact-manifest.json`
使用 `ck.forge.qualification-artifact-set` schema v1，并逐项保存相对路径、字节数和
文件 SHA-256。loader 为只读实现，不会创建、修复或自动迁移证书。

NativeRelink 使用同一 `schemaId` 下的专用 certificate schema v4，保存
`candidateProfile: native-relink-compile-only`、原始 evidence SHA-256 和报告 SHA-256。
旧 v3 NativeRelink 证书没有 production EXE 绑定，必须 fail closed，不能自动升级或
沿用。普通 QuickFast/SharedFast 的本地 performance certificate v2 不因此改号。

加载时会重新计算候选、报告、产物清单、每个产物、当前 Arduino CLI 可执行文件、
当前 host/sysroot 指纹和当前生成源码 SHA-256，并重新计算 A/B 中位数、p95、变异系数
与 qualificationKey。目录名、完整 canonical FQBN、Core、CLI、工具链、源码、本机、
构建合同、operation/profile 任一不一致即忽略该证书。重复能力、目录数量超限、符号
链接逃逸、绝对/父级产物路径或超限文件也会 fail closed。目录不存在时行为与过去
完全相同：普通编译和上传继续使用原生 Release。

生产 EXE 的任何重建、代码签名、时间戳写入或其他字节级修改都会改变
`productionExecutableSha256` 并使既有 QuickFast、SharedFast 和 NativeRelink 证书
立即失效。因此正式分发应先
完成最终 Release 构建、可信代码签名和时间戳，再以这个最终 EXE 重新运行完整 A/B、
生成对应 profile 证书并做无 qualification token 的普通启动验证；不得在认证后再签名
并继续沿用签名前的证书。

这是本地完整性与环境绑定，不是发布者签名或远程信任体系；公开生态证书将来仍需
单独的签名、撤销和可信发布策略。
