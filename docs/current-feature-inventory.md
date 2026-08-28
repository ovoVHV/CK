# CK 当前功能总清单

更新时间：2026-08-26。

本文是 CK 当前产品能力的**单一状态索引**。用户更新日志负责说明界面变化，各专题文档负责保存协议和安全边界；“某项是否已经完成”以本文为准。状态变化时应先更新本文，再同步更新日志或路线图。

面向产品逐项体验和人工勾选的审核版见 [`CK-1.0-feature-review-checklist.md`](CK-1.0-feature-review-checklist.md)。该审核版负责入口和体验步骤，状态裁决仍以本文为准。

> 本清单中的“已完成”只说明实现与所列证据边界，不等于公开正式发布。CK 1.0 的发布范围始终限定为**本机验证／封闭测试**；当前候选裁决只以 [`v1-release-evidence-manifest.json`](../artifacts/release/v1-release-evidence-manifest.json) 的 `status`、`releaseClass` 及其源码／产物哈希绑定为准，稳定判据见 [`v1-release-readiness.md`](v1-release-readiness.md)。

> **当前证据状态（2026-08-26）：**每次产品源码或构建合同修改都会使旧的 release evidence manifest 退回历史状态；当前源码是否可作为候选，必须重新冻结、完整运行 gate、生产构建、原生冒烟与代表性真板闭环。旧 JSON 中即使仍写着 `passed`，也不能覆盖这一时序事实。

> **FLFE 资格口径（2026-08-26）：**当前 Fast 数量、证书哈希和授权目标不写死在文档中，只以 [`Report-CKForgeFastQualifications.cjs`](../scripts/Report-CKForgeFastQualifications.cjs) 对当前运行或待发布 production EXE 的复算结果为准。任何旧 EXE（包括 `7b45eccf…`、`f47acdd2…`、`792c3ab2…`）的证书和测速报告都只是历史快照，不能授权新 EXE。没有当前证书时显示“Fast 待验证”，不表示不兼容，真实构建继续使用原生 Arduino CLI Release。`ck_forge_qualified_targets.v1.json` 是候选/兼容身份清单，不是 Fast 白名单；Exact 也不是 Fast。

## 状态口径

- **已完成且验证**：功能已经接入正式桌面链路，并至少有自动化回归、原生窗口回归或真板证据之一。这里的“验证”不自动扩大到所有板卡、Core 或物理配置。
- **已完成待真机覆盖**：实现和自动化测试已存在，但最新代码尚未获得对应真板、完整配置或完整五阶段矩阵证据。
- **已记录未实现**：只有设计、Schema 预留或路线图，不应出现在界面或宣传中冒充可用功能。
- 证据标记：`A` = 自动化测试/构建，`N` = Tauri 原生窗口流程，`H` = 真板写入或运行验证，`E` = 已保存的历史结构化证据。

## 一、已完成且验证

### 1. 本地桌面工程与编辑体验

| 能力 | 当前行为与边界 | 证据 |
| --- | --- | --- |
| CK Project Format v1 | 新建工程默认保存为版本化 `.ck` 单文件 JSON，保留板卡包 ID、可重建完整 FQBN 的板卡目标与菜单选项、代码、正式 Blockly 数据和未知扩展字段；历史 `.maker`/无版本 `.ck` 只读打开不改盘，下一次显式保存做纯数据迁移，未来版本拒绝覆盖；单文件同目录临时写入并原子替换 | `A`：[`project.rs`](../apps/desktop/src-tauri/src/project.rs)、[格式规范](ck-project-format-v1.md)、[`ck-project.schema.json`](schemas/ck-project.schema.json) |
| 板卡选择边界 | 物理板卡只在新建工程的外部选板流程确定；编辑器内部只能修改当前板卡允许的编译选项，不提供快速换板 | `A`：[`BoardSelector.tsx`](../apps/desktop/src/components/BoardSelector.tsx)、[`BoardConfigModal.test.mjs`](../apps/desktop/src/components/BoardConfigModal.test.mjs) |
| 完整编译目标 | 板卡设置显示可换行、可选择的完整 FQBN 和全部菜单选项；无效或已被 Core 删除的选项会阻止构建，不静默退回默认值 | `A/N`：[`BoardConfigModal.tsx`](../apps/desktop/src/components/BoardConfigModal.tsx)、[`board_fqbn.test.mjs`](../apps/desktop/src/services/board_fqbn.test.mjs) |
| 未保存修改保护 | 返回主页、打开其他工程或退出前提供“保存并继续 / 不保存 / 取消”；破坏性覆盖前会创建保护检查点 | `A`：[`blockly_change_guard.test.mjs`](../apps/desktop/src/services/blockly_change_guard.test.mjs) |
| 积木全局搜索 | 从当前真实工具箱和已通过门禁的清单交集生成搜索目录；结果携带所属分类/库来源，第三方清单不能凭空声明不可见积木 | `A`：[`block_catalog.ts`](../apps/desktop/src/services/block_catalog.ts)、[`block_catalog.test.mjs`](../apps/desktop/src/services/block_catalog.test.mjs) |
| 三态主题 | 浅色、深色、跟随系统可在主页和工作区切换并记忆；Blockly 工作区、飞出区、代码视图和主要面板有对应主题规则 | `A`：[`app_theme.test.mjs`](../apps/desktop/src/services/app_theme.test.mjs)、[`ThemeVisualRegression.test.mjs`](../apps/desktop/src/components/ThemeVisualRegression.test.mjs) |
| 简洁／工程视图 | 顶部“视图”菜单可切换并记忆显示偏好；简洁视图仅折叠完整 FQBN、缓存和通过/信息型技术证据，错误、上传风险、引脚问题、资源风险和安全门禁始终保留；工程视图显示全部证据 | `A/N`：[`workspace_view_mode.ts`](../apps/desktop/src/services/workspace_view_mode.ts)、[`WorkspaceDisplayMode.test.mjs`](../apps/desktop/src/components/WorkspaceDisplayMode.test.mjs) |
| 独立工程体检入口 | 工程体检与输出日志分离；收起后保留窄入口和已有结果，重新展开不会自动触发真机检测；展开面板可调整宽度，积木定位不要求重新体检 | `A`：[`EngineeringHealthDock.test.mjs`](../apps/desktop/src/components/EngineeringHealthDock.test.mjs)、[`WorkspaceHealthDockInteraction.test.mjs`](../apps/desktop/src/components/WorkspaceHealthDockInteraction.test.mjs) |
| 安装版可写数据根 | 安装版和开发版都优先使用当前用户现有的 `Documents/CK`，避免 7GB 级 Core/库环境复制或分裂；不再向 exe/Program Files 旁写入。Documents 缺失时回退本地应用数据，再回退用户 home；候选根必须通过真实创建、写入、同步和删除探针，已有但不可写的 CK 根会阻止启动而不是静默新建第二套环境 | `A`：[`lib.rs`](../apps/desktop/src-tauri/src/lib.rs) 中 `ck_root_dir_tests` |

主题和布局已经有自动化规则，但不代表所有第三方积木自定义 CSS、所有 DPI 和每一种窗口尺寸都已人工视觉验收。

### 2. 编译、缓存与上传安全

| 能力 | 当前行为与边界 | 证据 |
| --- | --- | --- |
| 三类构建路径 | 区分 Exact Match、持证 NativeRelink/Fast Relink 和完整构建；Exact 只回放完整证据相同的产物，不等于 Fast。NativeRelink 仅在 v4 本机证书精确匹配时启用，其他真实编译走原生 Release；日志显示实际编译、授权来源、锁等待、缓存未命中原因和 profile | `A/N/E/H`：[`compile_accel.rs`](../apps/desktop/src-tauri/src/compile_accel.rs)、[`demo.rs`](../crates/ck_core/src/builder/demo.rs)、[`ck_forge.rs`](../apps/desktop/src-tauri/src/ck_forge.rs)、[性能资格门禁](ck-forge-performance-no-regression-gate.md) |
| 可解释缓存身份 | 代码、完整 Arduino 库源码集合与 manifest、Core 源码/variant、关键编译工具、完整 FQBN、菜单选项、平台文件和 ESP32 分区内容进入缓存/构建身份；缺证、旧 schema、删除源码或身份变化会回退重建。官方安装／导入造成的版本、目录或时间戳变化可失效；运行期间手工原地替换 SDK 静态库或编译器 sysroot 且刻意保留包元数据、长度与时间戳，仍需重启 CK 并执行“清除缓存后重编译” | `A/N/H`：[`cache_tests.rs`](../crates/ck_core/tests/cache_tests.rs)、[`demo.rs`](../crates/ck_core/src/builder/demo.rs) 中 Core/依赖/对象缓存与性能门禁、[编译器回归基线](compiler-and-package-regression-baseline.md) |
| Core/工具链身份扫描缓存 | 持久化元数据缩短跨进程复核；同一进程还按 canonical sysroot、完整 FQBN、Core 版本和工具计划缓存最多 64 个已强校验身份，5 分钟后回到完整证明，并在 Core 安装、卸载或索引更新时立即失效。热命中仍复核平台拓扑、关键配置、编译器、SDK 静态库和上传工具；任何不一致回到强内容扫描。该缓存不代替用户库检查、不授予 Fast，也不改变完整身份门禁 | `A`：[`demo.rs`](../crates/ck_core/src/builder/demo.rs) 中进程内／持久化身份缓存与变更失效回归、[CK Forge v1](ck-forge-v1.md) |
| ESP32 `3.3.6-cn` 镜像身份 | 默认配置同时保留官方 ESP32 索引和极狐 JihuLab 国内镜像；Core 管理器可明确选择 `3.3.6-cn`。只有安装收据、归档校验、package.json、工具计划和内容身份共同证明它是已审计的 `3.3.6` 分发镜像时，资格查找才规范化到官方 `3.3.6` 身份；真实编译路径和版本显示仍保持 `3.3.6-cn`。任一证明不匹配即 fail-closed，其他后缀版本不自动借证 | `A`：[`sysroot.rs`](../crates/ck_core/src/sysroot.rs)、[`demo.rs`](../crates/ck_core/src/builder/demo.rs)、[`ck_forge.rs`](../apps/desktop/src-tauri/src/ck_forge.rs)、[`CoreManagerModal.test.mjs`](../apps/desktop/src/components/CoreManagerModal.test.mjs) |
| 编译目标预证明 | 板卡与完整 FQBN 选项稳定 300 ms 后机会性触发；300 ms 是前端防抖，不是完成时限。后端只读取本机已安装的 `boards.txt`、别名、Core 与工具链身份，不运行 CLI、不编译、不上传、不下载、不写 Flash；按完整 FQBN 单飞并使用绑定工具链身份代际的短期缓存。结果只提前准备身份诊断，正式编译仍重复全部权威校验，预证明成功不授予 Fast 或证书 | `A`：[`Workspace.tsx`](../apps/desktop/src/components/Workspace.tsx)、[`compile_target_preproof.ts`](../apps/desktop/src/services/compile_target_preproof.ts)、[`lib.rs`](../apps/desktop/src-tauri/src/lib.rs) |
| 有界构建缓存维护 | 成功编译／上传响应完成后再调度普通回收：全进程单飞、最多每 10 分钟一次、延迟 2 秒；重复低盘请求同样受 10 分钟节流，显式强制维护才可绕过。低于 2 GiB 可用空间时首轮可同步压力回收，有效上限最多 512 MiB。外层 build-use 读写门禁覆盖缓存使用生命周期，内层 budget 门禁只串行化预算操作，固定按 `build-use → budget → board lock` 取锁；前台消费者在等待前发布意图，使正在递归扫描的维护及时取消并重试，避免排队 writer 与已有 reader 形成死锁。`CK_Builds/build` 容器固定保留，只按直接工程目录分别计量与淘汰，不跟随链接或重解析点 | `A`：[`compile_accel.rs`](../apps/desktop/src-tauri/src/compile_accel.rs)、[`accel.rs`](../crates/ck_core/src/builder/accel.rs)、[后续边界](flfe-cache-maintenance-followups.md)。退出协调、ENOSPC 幂等重试、源码／build 成对 LRU 仍为 P1 |
| 冷阶段结构化计时 | 编译结果保留运行工具预检、Arduino CLI 子进程墙钟、依赖／产物封存、NativeRelink 基线捕获提交、BuildMeta/Core 快照和构建后缓存快照六个精确毫秒字段；解析器只接受完整、非负、有界的标准行，并在诊断输出裁剪后仍保存结构化值。它用于定位冷编译时间花在哪里，不代表这些阶段已经加速，也不改变性能资格结论 | `A`：[`demo.rs`](../crates/ck_core/src/builder/demo.rs)、[`lib.rs`](../apps/desktop/src-tauri/src/lib.rs) 中冷阶段 timing 解析回归 |
| 两级精确重建当前配置 | 默认“重建缓存/重新编译/重新烧录”只针对当前完整 FQBN，清工程构建层但保留内容校验的 ccache；高级“彻底刷新”才忽略 ccache、强制重新生成 Core 与依赖，并明确提示 ESP32 可能需要数分钟。两种操作都在应用内确认板卡、完整目标和影响范围 | `A/N/H`：[`demo.rs`](../crates/ck_core/src/builder/demo.rs)、[`BoardConfigModal.test.mjs`](../apps/desktop/src/components/BoardConfigModal.test.mjs)、C6 冷建/Exact/热编辑回归摘要 |
| Arduino 库解析 | 支持 `library.properties depends=` 传递闭包、架构过滤、`.d` 依赖失效、标准 `src/**` 递归源码和 legacy `utility/`；两个深层同名源码保持不同对象身份。CK 默认只解析受管 `CK/sketchbook/libraries` 与明确配置的库，不读取原生 Arduino IDE 的 `Documents/Arduino/libraries`，避免通用库显式注入后覆盖板卡 Core；该目录不会被修改 | `A`：[`lib.rs`](../apps/desktop/src-tauri/src/lib.rs)、[`demo.rs`](../crates/ck_core/src/builder/demo.rs) 内相关 Rust 回归 |
| ESP32 首次工程编译 | QuickFast/SharedFast 先按 include、架构、CK 精确作用域和 `depends=` 闭包解析，不再无条件递归扫描整个用户 sketchbook；Windows GCC `.d` 路径按 GNU make 转义正确还原，依赖签名可以稳定写入并供 Exact 复用。工程内由 Workspace 按完整 FQBN 和真实生成源码预热；成功前台构建只消费完全相同的 pending，请求期间产生的新编辑会保留。启动热集保存实际完整 FQBN，全局最多 32 个且同一基础板型最多 4 个；安装库存只校验有效性，新安装不会任意偏向某块内置板，手动“全部预热”也只执行排名后的 TOP-N | `A/N/H`：[`compile_accel.rs`](../apps/desktop/src-tauri/src/compile_accel.rs)、[`silent_precompile_scheduler.ts`](../apps/desktop/src/services/silent_precompile_scheduler.ts)、[`Workspace.tsx`](../apps/desktop/src/components/Workspace.tsx)、[`demo.rs`](../crates/ck_core/src/builder/demo.rs)、C6 原生回归摘要 |
| 干净安装加速工具 | Windows bundle 携带 Arduino CLI 1.4.1、ccache 4.10.2 与 GPL 文本；工具按内容 SHA-256 通过同目录 staging/previous 事务更新。所有后端板卡解析统一使用 bundled CLI 和主配置，不再下载硬编码 0.35.0 或回退 PATH | `A`：[`client.rs`](../crates/arduino/src/client.rs)、[`lib.rs`](../apps/desktop/src-tauri/src/lib.rs) 中 `bundled_resource_install_tests` |
| ccache 工具链 shim | 扫描当前 sysroot 实际安装的编译器并只为 gcc/g++/cc/c++/clang 建立 ccache shim；归档、链接、size 和所有 `recipe.objcopy.*` 配方改走当前 Core 的精确真实工具路径。仅架构前缀且内容无冲突的 objcopy/objdump 可作为直达兼容转发，绝不经 ccache；无前缀或同名异内容工具拒绝平铺。Core 后装后会在编译/暖机/Fast Relink 前幂等补齐，无工具时不冒充启用 | `A`：[`sysroot.rs`](../crates/ck_core/src/sysroot.rs)、[`demo.rs`](../crates/ck_core/src/builder/demo.rs) 中 fresh-install、冲突拒绝与 AVR objcopy 专项 |
| 预构建 Core 目录 | 新写统一使用 `sysroot/prebuilt_cores`；历史相邻缓存只在 canonical 为空、真实目录且同卷时原子移动，不复制大目录。失败或 canonical 非空时允许唯一历史 sibling 兼容读，清理覆盖两者但不跟随链接或任意外部根 | `A`：[`sysroot.rs`](../crates/ck_core/src/sysroot.rs)、[`demo.rs`](../crates/ck_core/src/builder/demo.rs) |
| 真实进度和耗时 | 首次构建、强制重建和上传显示真实阶段与已用时间；长阶段使用动态等待而不是把伪百分比长期卡在 95% | `A/N`：[`compile_progress.test.mjs`](../apps/desktop/src/services/compile_progress.test.mjs)、[`CompileProgressOverlay.test.mjs`](../apps/desktop/src/components/CompileProgressOverlay.test.mjs) |
| 有界日志与退出回收 | 编译、上传、Fast Relink、Flash 探测、Core/库安装和桌面诊断分别设置读取块、单事件、通道及最终文本上限；超限保留头尾证据或 fail-closed。退出时仅按本实例登记的 PID/generation 取消并等待前台构建、warmup、安装和上传 owner 回收，不按进程名扫杀 | `A/N`：[`demo.rs`](../crates/ck_core/src/builder/demo.rs)、[`lib.rs`](../apps/desktop/src-tauri/src/lib.rs)、[`desktop-memory-lifecycle.md`](desktop-memory-lifecycle.md) |
| ESP32 多段上传进度 | 引导、分区、应用和文件系统按真实字节汇总为单调 0–100%，显示当前段和地址，不再每段重置百分比 | `A/H`：[`Benchmark-CompileUploadNative.ps1`](../scripts/Benchmark-CompileUploadNative.ps1)、[C6 真板计划与结果](esp32-c6-hardware-regression-plan.md) |
| 上传产物门禁 | ESP32/AVR 上传清单绑定完整 FQBN、构建签名、分区、烧录地址、大小和 SHA-256；缺失、错配或篡改在写 Flash 前拒绝，恢复固件也不能绕过 | `A/N/H`：[`upload_artifact_manifest.rs`](../apps/desktop/src-tauri/src/upload_artifact_manifest.rs)、[`Test-UploadManifestGateNative.ps1`](../scripts/Test-UploadManifestGateNative.ps1) |
| ESP32 实体 Flash 门禁 | 普通上传前用 Core 自带工具只读探测芯片和实体 Flash；配置容量大于实体容量时在写入前阻止，不从 N16R8 等名称猜容量 | `A/N/H`：[`device_health.rs`](../apps/desktop/src-tauri/src/device_health.rs)、C3/C5/C6 保存证据 |
| AVR 直传 | 官方 Uno/Nano/Mega 在配方和产物严格校验后使用 direct avrdude；任何不适用或失败自动回退 Arduino CLI。真板性能证据目前最完整的是 Nano 旧引导程序 | `A/N/H`：[`compiler-and-package-regression-baseline.md`](compiler-and-package-regression-baseline.md) |
| 上传串口互斥 | 上传前同步关闭串口监视器并释放端口，结束后按会话序号恢复；旧会话不能抢回新会话端口 | `A/N/H`：[`WorkspaceUploadOutcome.test.mjs`](../apps/desktop/src/components/WorkspaceUploadOutcome.test.mjs)、[上传实测](compiler-and-package-regression-baseline.md#原生软件上传实测) |
| 一键编译回归摘要 | 统一汇总 C3/C5/C6/S3/AVR 的冷编译、Exact、热编辑、上传和产物门禁，输出控制台、Markdown、JSON；只聚合证据，不暗中编译或把历史结果冒充本轮实测 | `A`：[`Summarize-CompileRegression.test.mjs`](../scripts/Summarize-CompileRegression.test.mjs)、[使用说明](compile-regression-summary.md) |

保存的一键五板摘要是**历史证据汇总**，不能仅凭汇总文案宣称 25/25 已在同一候选上重跑。历史 C6 会话曾记录三轮首次工程冷编译中位数 98.39 秒、Exact 1.7～1.9 秒、热编辑 20.0～29.2 秒、普通上传 26.4 秒，并记录错误分区清单在 transport 前被拒绝、经 SharedFast 重新封存后上传。该性能数据可作为历史基线；它是否绑定当前候选，只由 evidence manifest 对具体 EXE、源码树和报告哈希的关联决定。机器记录见 `artifacts/release/v1-c6-*.json`；五板聚合见 [`compile-regression-summary.md`](../artifacts/benchmarks/compile-regression-summary.md)。

2026-07-17～18 的 FLFE 边界回归已单独留档。历史 PortableFast 虽能按部分 Core recipes 完成 compile-only，但同机直接 Arduino CLI 诊断显示 STM32 F401RE、H2、P4 与 Feather S3 的 fresh/repeat 均明显更慢；其中 STM32 曾为 `62.644/68.416s`，原生为 `37.608/16.149s`。因此 PortableFast 已退出默认路由，兼容成功、缓存存在或 Exact 命中都不能显示为 Fast。

前一版 production EXE `fe1450c5a719adcf6851fd41e7f8315c9961a49d98d6c353bcfafea27549aa0f` 已完成两套精确目标的 5 轮 `simple → complex → medium → simple-return` 公平 A/B。Uno 热编辑中位数为 CK `3.969/3.338/3.633s` 对原生 `6.314/6.691/6.426s`，分别快 37.15% / 50.12% / 43.47%；MKR Zero 为 CK `4.268/4.258/4.386s` 对原生 `7.264/7.691/6.809s`，分别快 41.25% / 44.63% / 35.59%。两份历史报告均为 5 trials、零 edit fallback、产物角色与资源等价、`qualified`；对应旧 EXE 的本机 v4 证书目录键为 `4bfe55cb…` 与 `e28010e6…`。普通无 token 启动也曾验证由该旧证书授权进入 NativeRelink，但此证据不会跨 EXE 沿用。

同一历史 A/B 中，首次 `simple` 冷基线的 Uno 为 CK `12.856s` 对原生 `10.768s`（慢 19.39%），MKR Zero 为 CK `13.218s` 对原生 `10.698s`（慢 23.56%）。2026-07-19 production EXE `821a2c10…` 的 AVR 完整矩阵进一步确认：冷编译 CK／原生 CLI 中位数为 9383.6598 / 7815.367 ms，112 个适用样本中有 110 个 CK 更慢；因此不能宣传首次编译已加速或已达到 30%～40% 冷编译目标。正常用户路径另行验证的 C6 `47.378→2.438s`、STM32 `42.265→1.648s` 是历史 Exact 功能证据：它们是完整身份与产物相同时的回放，不是重新编译，不进入 A/B，也不授予 Fast。旧 `53dd76b7…` 三平台 A/B、`7f10e3f8…` A/B/Exact、`3fcaf092…` C6 WiFi-cycle、`0cce8cd1…` 兼容回归及更早报告全部只保留为历史证据。详见 [2026-07-19 AVR 完整矩阵](../artifacts/benchmarks/ck-avr-full-matrix-exe821a2c10-20260719.json)、[AVR 历史正式报告](../artifacts/benchmarks/flfe-avr-native-relink-formal-20260719-exefe1450c5.json)、[SAMD 历史正式报告](../artifacts/benchmarks/flfe-samd-mkrzero-native-relink-formal-20260719-exefe1450c5.json)、[AVR 真实编译矩阵](ck-avr-real-compile-regression-matrix.md)、[FLFE 性能资格与原生底线](ck-forge-flfe-portable-lane.md) 与 [性能资格门禁](ck-forge-performance-no-regression-gate.md)。

2026-08-25 当前 production EXE 的 Fast 资格不在本文固定列出；请运行资格审计脚本查看当前证书目录、EXE SHA-256 和实际授权目标。`f47acdd2…`、`792c3ab2…` 等旧报告仍保留用于历史对照，不能作为当前客户机资格依据。带第三方库和 Core SPI 的专项结果也必须以当前 EXE 重新认证后才能授予产品 Fast；未认证目标继续走原生 Release。详见 [FLFE 性能门禁](ck-forge-performance-no-regression-gate.md) 和 [文档入口](README.md)。

### 3. 工程体检与可解释诊断

| 能力 | 当前行为与边界 | 证据 |
| --- | --- | --- |
| Flash/RAM 资源预算 | 从成功普通编译/上传读取程序空间和内部静态 RAM，与同完整 FQBN 上次成功值比较，并作 80%/90% 分级；ESP32 Maximum 是 APP 分区，不是整颗 Flash，RAM 不含 PSRAM | `A/N/H`：[`compile_resources.test.mjs`](../apps/desktop/src/services/compile_resources.test.mjs)、[`ResourceBudgetPanel.test.mjs`](../apps/desktop/src/components/ResourceBudgetPanel.test.mjs) |
| 可解释资源增长归因 | 在当前与基线都存在可信 GNU linker map、完整 FQBN／分类规则／容量一致且分组增量能与编译器总量逐字节对账时，按库、Core、生成代码和明确的链接／对齐残差解释 Flash/RAM 变化；缺 map、配置变化或和总量不一致时只显示总变化，拒绝猜测某个库或积木 | `A`：[`resource_map.rs`](../apps/desktop/src-tauri/src/resource_map.rs)、[`resource_growth.test.mjs`](../apps/desktop/src/services/resource_growth.test.mjs) |
| 可操作错误卡片 | 对缺头文件、串口不可用、ESP 握手失败、固件过大和板卡环境变化给出确定性操作；未知错误保留原日志，不猜按钮 | `A/N`：[`compile_issue_cards.test.mjs`](../apps/desktop/src/services/compile_issue_cards.test.mjs)、[`BuildIssueCards.tsx`](../apps/desktop/src/components/BuildIssueCards.tsx) |
| 精确引脚风险图 | 读取当前精确板卡包声明的全量引脚、别名、能力、保留资源、条件风险、连接器位置和积木占用；可按 GPIO、别名、能力、风险和积木搜索并定位。风险可按完整 FQBN 菜单或工程特征激活，例如 UART0 上传、USB/JTAG、OPI Flash/PSRAM，以及经典 ESP32 的 WiFi+ADC2。未占用引脚保持视觉中性，板卡级风险仍可查看但不冒充当前工程正在发生的警告；实际占用后再按条件升级 | `A/N`：[`pin_preflight.test.mjs`](../apps/desktop/src/services/pin_preflight.test.mjs)、[`PinPreflightPanel.test.mjs`](../apps/desktop/src/components/PinPreflightPanel.test.mjs) |
| 引脚误报边界 | 只有可验证的确定问题阻止；动态表达式、旧积木、缺失电气证据和发布者单方面 blocker 保持未知/警告，不借用同芯片另一块板的数据 | `A`：[P0+ 可靠性基线](p0-plus-reliability-roadmap.md#精确引脚风险图与编译前体检结构契约已接入) |
| ESP32 真机体检 | 只读识别芯片、实体 Flash、明确报告的 PSRAM 和当前配置；会短暂复位但不编译、擦除或写 Flash。本机卡片显示完整 MAC 和完整 FQBN，日志、诊断包和持久记录仍脱敏 | `A/N/H`：[`DeviceHealthPanel.test.mjs`](../apps/desktop/src/components/DeviceHealthPanel.test.mjs)、[`Test-DeviceHealthNative.ps1`](../scripts/Test-DeviceHealthNative.ps1) |

### 4. 积木调试、运行轨迹与串口数据

| 能力 | 当前行为与边界 | 证据 |
| --- | --- | --- |
| 积木软断点 | 右键可执行积木设置断点；“调试上传”单独生成调试固件，支持附加、命中高亮、继续、单步和结束。普通上传不带调试运行时 | `A/N/H（覆盖范围有限）`：[`block_debugger.test.mjs`](../apps/desktop/src/services/block_debugger.test.mjs)、[`Test-BlockDebuggerHardwareNative.ps1`](../scripts/Test-BlockDebuggerHardwareNative.ps1) |
| 调试脱机安全 | 固件收到桌面 ATTACH 才启用断点；软件不在时重启不会永久卡住；协议帧从普通串口输出中过滤 | `A/N/H（覆盖范围有限）`：[`block_debug_session.test.mjs`](../apps/desktop/src/services/block_debug_session.test.mjs) |
| 非暂停运行轨迹 | 使用独立轨迹固件显示采样覆盖、最近路径、命中次数和采样点间时间；默认 64 积木、每 4 点采样、40 ms 全局限频、桌面保留最近 32 条 | `A/N`：[`block_trace.test.mjs`](../apps/desktop/src/services/block_trace.test.mjs)、[`BlockTracePanel.tsx`](../apps/desktop/src/components/BlockTracePanel.tsx) |
| 轨迹解释边界 | 结果是受限的“采样命中”，不是精确执行次数、源码覆盖率或零干扰性能分析；结束后板上仍是轨迹固件，需要普通上传恢复正式固件 | `A/N`：[P0+ 可靠性记录](p0-plus-reliability-roadmap.md#运行轨迹与采样覆盖率第一阶段已完成) |
| 串口监视与绘图 | 识别 JSON、CSV、`key=value` 和纯数值行，提供实时曲线、最新值、暂停、清空和 CSV 导出；切到数据图时，隐藏的文本终端停止接收新数据但保留已有 scrollback，避免同一串口流在两个视图中重复增长 | `A/N`：[`serial_data_parser.ts`](../apps/desktop/src/components/serial_data_parser.ts)、[`SerialPlotter.tsx`](../apps/desktop/src/components/SerialPlotter.tsx)、[`FrontendMemoryLifecycle.test.mjs`](../apps/desktop/src/components/FrontendMemoryLifecycle.test.mjs) |
| 串口触发录制 | 支持数值通道、6 种比较符、触发前后各最多 30 秒、最多 5000 条、手动冻结/重新布防和带上下文 CSV；只冻结本地窗口，不控制开发板 | `A/N`：[`serial_trigger_recorder.test.mjs`](../apps/desktop/src/services/serial_trigger_recorder.test.mjs)、[`SerialTriggerRecorderPanel.tsx`](../apps/desktop/src/components/SerialTriggerRecorderPanel.tsx) |
| 桌面资源生命周期 | 显式释放 Blockly 垃圾桶 flyout 和旧 main workspace；异步监听器、ResizeObserver RAF 与 toast 计时器均有卸载清理；编译/串口/独立控制台/安装日志设字符或行数硬上限。TFT 图片源文件限制 16 MiB，解码缓存限制 64 项／128 MiB（单项估算最多 64 MiB）；当前工作区仍引用的图片不会被静默淘汰，替换、清空和卸载会释放引用，临时 Blob URL 在解码后始终撤销 | `A/N`：[`desktop-memory-lifecycle.md`](desktop-memory-lifecycle.md)、[`extension_loader.ts`](../apps/desktop/src/services/extension_loader.ts)、[`FrontendMemoryLifecycle.test.mjs`](../apps/desktop/src/components/FrontendMemoryLifecycle.test.mjs)、[`blockly_workspace_lifecycle.test.mjs`](../apps/desktop/src/services/blockly_workspace_lifecycle.test.mjs) |
| AI／SSE 资源门禁 | Agent 对话和扩展修复流分别限制原始字节、待解析行、事件数、正文／推理及工具参数；任一预算超限即中断流并 fail-closed，不执行或应用截断结果。错误响应正文也有独立 256 KiB 上限 | `A`：[`bounded_sse.rs`](../apps/desktop/src-tauri/src/bounded_sse.rs)、Desktop Rust SSE 预算测试 |
| 前台构建安全取消 | 编译与上传按独立 UUID 隔离；锁等待可立即取消，运行中只终止本 run 的 Arduino CLI/GCC 进程树并 wait 后释放锁；上传 fallback 与 Flash 前继续检查同一 token | `A/N`：[`desktop-memory-lifecycle.md`](desktop-memory-lifecycle.md)、`ck_core` build cancellation 测试、Desktop foreground build state/compile lock 测试 |

调试和轨迹的代码目标支持 ESP32、ESP8266 与 Arduino AVR，但“支持该架构”不等于每一块板、每个 Core、每一种用户主串口用法都已真板验证。用户程序主动读取主 `Serial` 时，当前版本会阻止启动调试，避免吞掉命令。

### 5. 第三方板卡、积木库与自动质量门禁

| 能力 | 当前行为与边界 | 证据 |
| --- | --- | --- |
| 分离的包类型 | 第三方板卡包、CK 声明式积木库和普通 Arduino 源码库走不同导入入口，避免板卡身份、积木数据和纯编译依赖混淆；旧 JavaScript 包只保留数据并提示作者手工迁移，不激活，也不由 v1 声明式升级事务自动转换 | `A/N`：[扩展开发指南](../README.md)、[`LibraryManagerModal.tsx`](../apps/desktop/src/components/LibraryManagerModal.tsx) |
| 统一目录与 Schema | 提供 `board.json`、`library.json`、v1/v2 `ck-blocks.json`、`ck-generator.json` 和质量报告正式 Schema；v2 结构化语义、参数/输出、依赖、硬件资源、生成行为、限制、示例和错误信息 | `A`：[积木库包标准](blockly-library-package-standard.md)、[`schemas`](schemas) |
| CK 包导入静态门禁 | 第三方板卡和 CK 积木 ZIP 先进入 staging，检查安全路径、大小/数量、大小写重复、符号链接、清单、SemVer、入口、依赖、许可证形状、Schema、工具箱/定义/生成器静态一致性和内容 SHA-256；确定错误阻止，风险给警告 | `A/N`：[`package_quality.rs`](../apps/desktop/src-tauri/src/package_quality.rs)、[`Validate-PackageSchemas.test.mjs`](../scripts/Validate-PackageSchemas.test.mjs) |
| 普通 Arduino ZIP 质量门禁 | “Arduino 源码库”ZIP 在调用 Arduino CLI 前检查安全路径、链接、大小、唯一库根、递归 `src/**`/旧布局、元数据和内容 SHA-256；确定错误阻止，缺 `library.properties`/许可证可明确警告。安装后复核唯一实际目录和内容身份，写入 `arduino-library` 质量报告；手工复制或其他入口不会借用该证据 | `A/N`：[`arduino_zip_quality.rs`](../apps/desktop/src-tauri/src/arduino_zip_quality.rs)、[`LibraryManagerModal.tsx`](../apps/desktop/src/components/LibraryManagerModal.tsx)、[质量门禁边界](package-quality-gates.md#安装后与运行时复核) |
| 原子安装与运行时复核 | 质量报告和来源标记随包写入，正式目录原子替换、失败恢复旧版；运行时重新核对包种类、ID、消费者授权和内容哈希，手工篡改后不继续加载声明式数据 | `A`：[质量门禁说明](package-quality-gates.md#安装后与运行时复核) |
| 声明式安全运行时 | 第三方 Blockly 定义、工具箱与代码生成只接受通过门禁的 JSON/XML 数据入口；生成模板通过操作白名单、参数/输出预算、资源 URL 和危险文本检查，任一条件失败即 fail-closed。旧 `blocks.js`/`generator.js` 无论来源批准、质量报告或哈希匹配均为 `legacy-disabled`，不在主 WebView 或迁移链路执行 | `A`：[`declarative_block_runtime.ts`](../apps/desktop/src/services/declarative_block_runtime.ts)、[`extension_runtime_isolation.test.mjs`](../apps/desktop/src/services/extension_runtime_isolation.test.mjs) |
| 声明式升级事务 | `ck-migrations.json` v1 只允许确定性重命名/枚举映射；先 dry-run、精确校验旧/新包和工程记录并创建检查点，再联合提交包与工程。失败及异常启动会恢复两侧备份；缺少可信旧版本证据时直接阻止 | `A`：[`block_package_migration_tx.rs`](../apps/desktop/src-tauri/src/block_package_migration_tx.rs)、[迁移协议](block-package-migration-v1.md) |
| Arduino 原生 `src/**` | 接受 `src/foo.c`、`src/driver/foo.c`、`src/vendor/**/*.c/.cpp/.S` 等标准递归布局；只把 `src/` 作为 include 根，保留相对路径和语言 recipe，深层文件变化会让相关缓存失效 | `A`：[`blockly-library-package-standard.md`](blockly-library-package-standard.md#arduino-src-递归布局)、Rust 递归库测试 |
| 随板卡分发子库 | `board-package-libraries/<board_package_id>/<library_id>` 按精确板卡包 ID 隔离；多个自制板共用同一 FQBN 时不会串用另一块板的引脚、配置或依赖 | `A`：[`package-quality-gates.md`](package-quality-gates.md#已明确延后的质量工程项)、C6 分发 fixture |
| 四级板卡护照 | 明确区分结构已检查、环境已就绪、本机已编译、真板已验证；板卡卡片显示证据时间、Core、完整 FQBN、具体真板和过期原因，并可筛选 | `A/N`：[`board_passport.rs`](../apps/desktop/src-tauri/src/board_passport.rs)、[`board_passport.test.mjs`](../apps/desktop/src/services/board_passport.test.mjs) |
| 积木库轻量证据护照 | 在库管理器按结构、v2 八类语义、安全声明式运行、真实编译、真板五阶段展示当前已有证据；缺证保持待验证，Legacy JavaScript 显示已阻止，不计算综合分，也不冒充 CK 官方背书 | `A/N`：[`block_package_passport.ts`](../apps/desktop/src/services/block_package_passport.ts)、[`BlockPackagePassport.tsx`](../apps/desktop/src/components/BlockPackagePassport.tsx)、[证据边界](block-package-evidence-passport.md) |
| 宽松但可审计的 Core 策略 | 只有低于 minimum 或命中带原因的 known incompatible 才阻止；非推荐、较新或范围内未实测版本可继续但提示重新验证 | `A/N`：[第三方板卡护照](third-party-board-passport.md#核心版本不是死锁) |
| 本机 compile-only 认证 | 按板厂声明的有限完整配置档案编译受控包内 smoke，并把包哈希、实际 Core、工具链、完整 FQBN、分区和构建证据写入 `ck.lock`；设备 smoke 不会在普通导入时自动执行 | `A/N`：[`board_passport.rs`](../apps/desktop/src-tauri/src/board_passport.rs)、[C6 第三方包认证记录](esp32-c6-hardware-regression-plan.md#第三方-c6-板卡包自动认证补充回归) |
| 可导入示例 | 提供且只计数 5 套确定性示例 ZIP：Nano 板卡、C6 多配置板卡（含随板深层 C 子库）、声明式串口积木、v2 I2C 传感器积木与纯 Arduino 深层原生库；同时提供对应可读目录和重建脚本。纯 Arduino ZIP 从专用入口导入后也会获得独立原生库质量报告，但不会变成积木库 | `A`：[`examples/importable-packages`](../examples/importable-packages)、[`Validate-ImportableExamples.test.mjs`](../scripts/Validate-ImportableExamples.test.mjs) |
| CK Extension SDK | 将扩展标准、Schema、五类示例源码/可导入 ZIP、离线验证器、完整传感器积木教程和逐文件 SHA-256 manifest 打为独立确定性归档；两次隔离构建逐字节一致。SDK 聚合采用 Apache-2.0，带 npm `bin`、机器可读本地发布地址和旁路归档哈希元数据；公开 URL 未真实配置时保持 `null` | `A`：[`Build-ExtensionSdk.ps1`](../scripts/Build-ExtensionSdk.ps1)、[`extension-sdk/README.md`](extension-sdk/README.md)、[`release-channel.json`](extension-sdk/release-channel.json) |
| `ckpkg` CLI / CI | 统一 `create/validate/test/compile/pack`；创建完整 v2 声明式模板，保留 Arduino 递归 `src/`；输出稳定机器报告和退出码；profile 只消费包作者显式 FQBN/sketch，compile 调真实 Arduino CLI 且不上传；pack 在门禁后原子生成确定性单根 ZIP。SDK 提供可复制的 GitHub Actions 流水线 | `A`：[`ckpkg.mjs`](../scripts/ckpkg.mjs)、[`ckpkg.md`](extension-sdk/ckpkg.md)、[`ckpkg.test.mjs`](../scripts/ckpkg.test.mjs) |
| CK Forge / FLFE 跨板构建底座与回归入口 | 机器身份 `ck-forge/v1` 在真实编译、上传和后台任务前执行分层路由。Fast 只统计绑定所查 production EXE 的有效四阶段 A/B 证书，文档中的旧证书均为历史快照；loader 复算主机、EXE、CLI、Core、工具链、完整 FQBN、源码、adapter/engine、报告、lane 边界空闲策略和产物哈希后才授权。ESP32-C3/C5/C6/S3/H2/P4 与 Feather S3 使用同一通用资格流程，未持证时显示“Fast 待验证”并继续走原生 `release`，不是不兼容。候选目标、普通兼容回归、Exact 和历史证书都不进入 Fast 计数；普通编译资格也不继承为上传资格。历史 PortableFast 已退出默认路由 | `A/N/E`：[`ck_forge.rs`](../apps/desktop/src-tauri/src/ck_forge.rs)、[`Report-CKForgeFastQualifications.cjs`](../scripts/Report-CKForgeFastQualifications.cjs)、[`Report-CKForgeFastQualifications.test.mjs`](../scripts/Report-CKForgeFastQualifications.test.mjs)、[`Run-CKForgeNativeAB.cjs`](../scripts/Run-CKForgeNativeAB.cjs)、[`NativeRelink certificate schema v4`](schemas/ck-forge-native-relink-certificate.schema.json)、[2026-07-19 AVR 历史完整矩阵](../artifacts/benchmarks/ck-avr-full-matrix-exe821a2c10-20260719.json)、[AVR 真实编译矩阵](ck-avr-real-compile-regression-matrix.md)、[CK Forge v1](ck-forge-v1.md)、[A/B 不回退门禁](ck-forge-performance-no-regression-gate.md) |
| CK Specification 统一索引 | 将工程、提交容器、板卡、积木、生成器、迁移、质量报告、SDK 与证据合同按 Normative/Stable local/Internal/Deferred 分类，并用机器可读索引防止延期设计被宣传成已上线格式 | `A`：[`specification/README.md`](specification/README.md)、[`specification/index.json`](specification/index.json)、[`Validate-SpecificationIndex.test.mjs`](../scripts/Validate-SpecificationIndex.test.mjs) |

静态门禁证明的是“当前本机规则检查通过”，不是 CK 官方安全认证、许可证兼容结论或真板认证。CK 1.0 通过彻底禁用第三方 JavaScript 执行来形成安全边界，而不是把静态检查或本机批准冒充脚本沙箱。

### 6. 工程保护、可用版本和诊断包

| 能力 | 当前行为与边界 | 证据 |
| --- | --- | --- |
| 工程检查点 | 编译、上传、恢复、主动放弃修改前自动保护，也可手动保存；保留正式 Blockly JSON、代码、板卡和选项，按工程展示并恢复 | `A/N`：[`project_checkpoints.rs`](../apps/desktop/src-tauri/src/project_checkpoints.rs)、[`ProjectCheckpointsManualCreate.test.mjs`](../apps/desktop/src/components/ProjectCheckpointsManualCreate.test.mjs) |
| 检查点删除 | 支持逐条危险确认删除；删除、恢复、创建互斥，删除不修改当前工作区、源码或已烧录固件 | `A`：[`ProjectCheckpointsDelete.test.mjs`](../apps/desktop/src/components/ProjectCheckpointsDelete.test.mjs) |
| 滚动恢复稿 | 普通语义编辑约 12 秒防抖原子落盘，按内容哈希去重并实施单项目/全局限额；损坏稿隔离。每次打开工程只自动提示最新一份有效稿，旧稿不是自动队列；“暂不处理”或成功覆盖后，同一会话抑制该基线的其余旧稿。覆盖前再建正式检查点，所选稿保留到正式保存成功后再随该工程稿件清理；重新打开工程允许重新判断并提示 | `A/N`：[`recovery-drafts-v1.md`](recovery-drafts-v1.md)、[`recovery_drafts.rs`](../apps/desktop/src-tauri/src/recovery_drafts.rs)、[`recovery_drafts.test.mjs`](../apps/desktop/src/services/recovery_drafts.test.mjs)、[`WorkspaceRecoveryDrafts.test.mjs`](../apps/desktop/src/components/WorkspaceRecoveryDrafts.test.mjs) |
| 未知积木只读保险箱 | JSON/XML 工程在进入 Blockly 前检查未知类型；命中后保留原始序列化文本、UTF-8 SHA-256 和工程元数据，只读展示并禁止编译、上传、覆盖保存，支持原样导出、补装包、重试和检查点恢复 | `A/N`：[`unknown_block_guard.ts`](../apps/desktop/src/services/unknown_block_guard.ts)、[`unknown_block_guard.test.mjs`](../apps/desktop/src/services/unknown_block_guard.test.mjs) |
| 编译会话源码映射 | 生成源码时记录 block ID/type、section、行 span 与置信度；编译开始冻结代码 SHA-256，后端复核后原子写 `ck-sourcemap.json`。只定位哈希一致的本次 sketch，第三方库与过期源码明确不猜测 | `A`：[`compile_source_map.ts`](../apps/desktop/src/services/compile_source_map.ts)、[`compile_source_map.test.mjs`](../apps/desktop/src/services/compile_source_map.test.mjs) |
| 上一个可用版本 | 普通固件成功上传且清单、芯片和实体 Flash 证据完整后保存工程、源码、`ck.lock`、Core/工具链、完整 FQBN、优化、分区、全部烧录段/SHA-256、真机和资源证据；Exact 缓存上传会返回同一命中构建的 Flash/RAM `used/maximum` 与结构化警告数，任一测量缺失或越界即拒绝形成新基线；调试/轨迹固件不覆盖。用户可经危险确认删除本机基线、依赖快照和固件副本，删除不改当前工程或板上固件 | `A/N/H`：[`last_working_version.rs`](../apps/desktop/src-tauri/src/last_working_version.rs)、[`LastWorkingVersionModal.tsx`](../apps/desktop/src/components/LastWorkingVersionModal.tsx)、[功能说明](last-working-version-and-diagnostics.md) |
| 比较与三种恢复 | 支持与当前工程比较，以及恢复工程、恢复固件、完整恢复三种恢复；差异解释积木、源码、依赖、Core、工具链、菜单、分区、真机和资源变化 | `A/N/H`：[`last_working_version.test.mjs`](../apps/desktop/src/services/last_working_version.test.mjs)、C6 恢复固件真板证据 |
| 恢复安全 | 恢复固件前重新核对芯片族、实体 Flash、完整 FQBN、分区地址、产物集合和 SHA-256；完整恢复不静默联网安装/降级 Core，被替换依赖保留本地备份 | `A/N/H`：[`last_working_version.rs`](../apps/desktop/src-tauri/src/last_working_version.rs) |
| 锁定依赖复编译 | 从可用版本的 `ck.lock` 物化精确依赖到隔离构建根，校验哈希、完整 FQBN、CLI 和工具链；禁用全局 Arduino 库、隐式依赖解析、同名回退与 Fast Relink 历史对象。QuickFast 只报告 compile-only，完整上传清单才验证可上传集合 | `A`：[`last_working_version.rs`](../apps/desktop/src-tauri/src/last_working_version.rs)、[`demo.rs`](../crates/ck_core/src/builder/demo.rs) |
| 本地工程诊断 ZIP | 导出完整工程、仅生成源码或无源码三档，默认脱敏 Wi-Fi、用户名、路径和串口内容；另一台电脑可离线导入并生成中文摘要，不自动上传或提交 Issue | `A/N`：[`diagnostic_bundle.rs`](../apps/desktop/src-tauri/src/diagnostic_bundle.rs)、[`DiagnosticBundleModal.test.mjs`](../apps/desktop/src/components/DiagnosticBundleModal.test.mjs) |
| 工程健康与项目验收报告 | 从文件菜单按需生成检查项式报告，不计算虚假总分；包含当前目标、编译、资源、依赖锁、检查点、引脚和四级板卡护照。护照的结构／环境／本机编译／真板证据严格绑定当前精确包、完整 FQBN、Core 版本与有效状态；缺证保持待验证。可导出脱敏 JSON 和无脚本可打印 HTML，由系统打印功能另存 PDF | `A`：[`project_acceptance_report.test.mjs`](../apps/desktop/src/services/project_acceptance_report.test.mjs)、[`ProjectAcceptanceReportModal.test.mjs`](../apps/desktop/src/components/ProjectAcceptanceReportModal.test.mjs) |
| `project.ckpkg` 工程提交与只读验收 | 在现有验收报告弹窗中明确选择不含源码／可编辑工程／生成源码／两者四档，可选附加脱敏 `ck.lock` 与构建证据。独立格式标记、manifest/schema、固定路径和逐文件大小/SHA-256；输入先冻结为有界内存快照，条目不落盘、不执行、不联网、不烧录、不写当前工程。导出和检查均显示容器文件名/SHA-256、实际源码范围及真正附加的锁/构建证据；编译与资源只接受同一 run 对当前积木、源码、板卡包、完整 FQBN 和 Core 的精确绑定。完整性校验不等于发布者身份签名 | `A`：[`project_submission.rs`](../apps/desktop/src-tauri/src/project_submission.rs)、[`project_submission.test.mjs`](../apps/desktop/src/services/project_submission.test.mjs)、[格式说明](project-submission-format.md) |

检查点目前每工程最多 20 个、单个 5 MiB、总量 40 MiB；滚动恢复稿每工程最多 3 份，并另有单稿、单工程和全局字节边界。旧恢复稿是安全冗余，不是依次弹出的历史列表。两者都只保存在本机应用数据目录，不是完整版本管理。恢复稿、检查点和可用版本可能包含源码、Wi-Fi 密钥及第三方库，应按本机敏感数据管理。

### 7. 已有真板证据的精确范围

| 目标 | 已有证据 | 不能据此扩大解释 |
| --- | --- | --- |
| Arduino Nano ATmega328P 旧引导程序 | `H`：原生编译/上传、串口关闭恢复和 direct avrdude 性能；完整上传多轮约 2.90–4.10 秒 | 不代表所有 AVR 板或所有 USB 重枚举板都可直传 |
| ESP32-C3，Core 3.3.6 | `E/H`：冷编译、Exact、热编辑、上传、产物门禁 | 保存证据属于历史导入证据；是否绑定某个候选由机器清单裁决 |
| ESP32-C5 N16R8，Core 3.3.6，指定 16M/PSRAM/分区 FQBN | `E/H`：实体 Flash/PSRAM、冷/热编译、多段上传和门禁 | 不代表其他 C5 BOM、Flash/PSRAM 组合或 Core 版本 |
| ESP32-C6 N16，Core 3.3.6，指定 16M/分区 FQBN | `E/H`：历史本机会话完成真机体检、三次首次工程冷编译、Exact、热编辑、多段上传和错误清单阻断；冷编译为 98.24/104.42/98.39 秒，中位数 98.39 秒，第三轮 ccache 72/72 命中 | 相对用户最初 317.7 秒日志缩短 69.0%，但相对后期 102.83 秒基线只再缩短 4.3%；只证明所记录的本机、Core 3.3.6、完整 FQBN 和 Wi-Fi 工程。是否属于当前候选证据，以 evidence manifest 的源码树、EXE 与报告哈希绑定为准 |
| ESP32-S3，Core 3.3.6 | `H`：调试闭环与同配置缓存复用 | 完整五阶段覆盖只按机器一键摘要中实际存在且哈希有效的阶段计数 |
| ESP8266 | `A/N`：调试固件编译、缓存复用和协议回归 | 不把协议与构建回归自动解释为完整五阶段真板证据 |

## 二、已完成待真机覆盖

| 实现 | 已完成部分 | 仍缺的证据 |
| --- | --- | --- |
| 新冷编译缓存口径 | 清理报告已经能区分完整 FQBN 范围、ccache 是否保留、预构建 Core 是否保留、强制 recache 和 pending 标记 | 需要新原生证据把这些字段完整写入 C3/C5/C6/S3/AVR 报告；旧证据中的部分字段仍为 `unknown` |
| 五板一键回归矩阵 | 摘要器、JSON/Markdown 格式、严格缺证状态和采集脚本已经完成 | 具体覆盖数、缺失阶段和采集批次只读取机器一键摘要；缺证必须保持 `missing`，本文不缓存瞬时分数 |
| 深层原生子库真机构建 | 从真实 C6 分发 ZIP 到质量报告、事务安装、精确作用域和候选解析的隔离 E2E 已通过；Wi-Fi compile-only smoke 会调用深层 C 源码 | 日常快速测试没有强制跑耗时 C6 冷编译；仍应在 C6 本机认证/回归中保留一次真实编译链接证据 |
| 串口关闭尾包与真实连接元数据 | 后端关闭/异常/读循环退出前刷新尾部，前端导出使用后端确认的端口和波特率，相关自动化测试已接入 | 仍需在高频串口、真实拔插和异常断开下做压力回归，确认没有重复尾包或 UI 卡顿 |
| 非 Nano 的 AVR 直传覆盖 | Uno/Nano/Mega 的严格配方解析和 CLI 回退逻辑已经实现 | Uno、Mega 不能继承 Nano 的真板上传证据；Leonardo/Micro 明确不在直传范围 |
| UI 视觉收口 | 深色 Blockly、数字字段对比度、选中分类、窄工程体检入口已有代码和视觉规则测试 | 仍需常用 DPI/缩放、窄窗口及第三方积木样式的原生人工巡检；不能把规则测试当作全部视觉设备通过 |

## 三、已记录未实现

以下能力目前不得写成“已上线”：

1. **串口黑匣子 `.cktrace` 和离线回放**：已完成技术审计，确定应在 Rust 串口读线程记录原始字节，采用有界异步队列、GAP 丢帧事件、原子落盘、CRC32/SHA-256 和纯离线播放；文件格式、录制器和回放 UI 尚未实现。详见 [`deferred-platform-roadmap.md`](deferred-platform-roadmap.md#d11-串口黑匣子-cktrace已完成可行性审计待分阶段实现)。
2. **真机断言和设备侧测试报告**：尚未解决无副作用求值、失败后的安全状态、小内存协议和重复测试隔离，因此没有“断言温度”“两秒内收到消息”等正式积木。该延期不包括已经上线的只读工程健康／项目验收报告。
3. **变量探针、表达式求值和精确源码级覆盖率**：当前只有软断点和受限采样轨迹；没有安全的任意变量求值、设备侧精确计数或零干扰性能分析。
4. **恢复稿积木语义 diff**：滚动恢复与启动候选已经完成，但恢复对话框尚未把每个字段/积木变化翻译为语义差异；当前展示时间、工程和内容摘要。
5. **官方/厂商签名认证中心**：没有发布者验签、CK 签名、云端持续多 Core 矩阵、证书撤回或跨机器可移植认证。本机 `ck.lock` 不等于官方认证。
6. **统一运行事件协议与硬件时间轴**：断点、轨迹、串口和上传仍是各自事件链路，没有统一时钟、会话 Schema 和跨来源时间轴。
7. **教室/实验室一致性管理**：没有批量环境检查、机器编组、跨电脑依赖复现报告或集中部署。
8. **证据型 AI 诊断与自动积木工程生成**：v2 元数据和 `window.CK_BLOCK_CATALOG` 已提供可靠输入基础，但 AI 的受约束检索、组合、编译修复闭环没有作为产品功能完成；[`blockly-agent-design.md`](blockly-agent-design.md) 是设计文档，不是上线证明。
9. **第三方元数据可视化补齐向导**：依赖、Core 范围、许可证、硬件资源和积木语义已有 Schema 与示例，但没有表单向导、自动迁移和包重打包 UI。该大项已明确暂缓，不插队编译器收尾。
10. **任意第三方 JavaScript 宿主和完整动态认证**：1.0 已 fail-closed，旧脚本不进入 WebView；若未来要重新支持脚本，仍需独立 extension host。逐示例生成/编译、最终依赖版本绑定和许可证兼容结论仍未完成。
11. **串口触发录制高级能力**：没有曲线事件注释、多条件/滞回、设备侧时间戳对齐、自动暂停设备或自动发送控制命令。
12. **原生 USB 稳定设备身份直传**：上传后 COM 号变化的板卡仍依赖 Arduino CLI 和重新扫描；未建立跨重枚举的稳定设备匹配。
13. **全板卡 × 全配置 × 全积木真编译矩阵**：1.0 已覆盖 139 种静态工具箱积木与 8 种动态函数积木（共 147 种）的 AVR Nano/ESP32-C6 生成矩阵和 7 套代表性真实 compile-only 输出；另已完成 Arduino AVR Boards 1.8.6 的 38 个完整 FQBN × 3 类受控负载矩阵（114 单元、112 适用、2 预期跳过、896 次 compile-only）。后者证明的是该 Core 版本上的三类负载，不等于 147 种积木逐一覆盖全部 38 个 FQBN。全部机器记录仍保持 `hardwareTested=false`，没有、也不应宣称每个受支持 Core、每个菜单组合和每块真板均已逐项跑完。
14. **跨机器诊断包自动复现**：本机可用版本已有 `ck.lock` 隔离复编译；诊断 ZIP 导入仍只做脱敏摘要与完整性校验，不会自动联网物化 Core/工具链/依赖。
15. **跨厂商 Core 引用与非 Windows 直接属性快路径**：Arduino 允许 `build.core=VENDOR_ID:CORE_ID` 引用另一平台的 Core；1.0 的本地合成快路径只验证同平台的简单 Core ID，跨厂商引用继续由 Arduino CLI 兼容处理，不宣称 ready-install 加速。macOS/Linux 的 `runtime.os`、主机后缀覆盖与直接属性解析尚未完成原生等价回归，也不得从 Windows 证据外推。
16. **复杂条件头文件的 Fast Relink 性能等价**：传递库闭包当前有 10 轮上限，源码抓取到的条件 `#include` 会先按候选处理，深层私有同名头也可能让本地解析无法唯一判定。此类工程必须回退 Arduino CLI 取得最终编译结论，不能宣称 ReadyInstall 加速；后续需要显式的闭包耗尽诊断、条件宏求值和公开/私有头可见性模型。该边界影响加速命中率，不允许绕过完整编译确认或复用未经验证的产物。
17. **历史预构建库存 JSON 编码迁移**：当前 Gate、Core 兼容报告、源码冻结、原生证据、性能摘要与最终证据清单均统一输出 UTF-8 无 BOM；旧 `.prebuild-inventory.json` 仅作为隔离归档，尚未批量迁移。它不进入 1.0 发布裁决或 Node 汇总，未来若重新启用该历史库存，必须先完成无 BOM 重写、哈希重算和兼容读取测试。
18. **内置直接 PDF**：`project.ckpkg` 提交与本地只读验收已完成；报告仍通过后端生成的无脚本 HTML 配合系统“打印／另存为 PDF”，不得宣传为 CK 内置 PDF 渲染器。
19. **CK Lab 课程/作业系统**：当前只有项目验收报告与只读提交包，没有课程编排、作业下发、班级环境一致性或教师批量验收协议；它仍是延期产品方向。

六项 P0 收尾的实现证据、边界和发布门槛统一记录在 [`productization-closeout-audit.md`](productization-closeout-audit.md)。

## 四、推荐下一步

按收益、风险和用户当前目标排序：

1. **持续生成可复算的 1.0 封闭测试候选证据。** 每次候选先冻结源码；无 Git 时生成源码树 manifest、SHA-256 和冻结时间，再跑完格式、前端/Rust/脚本、恰好 5 套确定性示例、生产构建、MSI／NSIS、同哈希 EXE 原生桌面和 C6 真板闭环，并由 evidence manifest 保存机器可读报告、安装包哈希和已知限制。
2. **用同一摘要逐步补齐 25/25 证据。** 各目标缺失阶段保持 `missing`，按兼容真板与完整配置实际到手顺序补证，不能为全绿而复用不相容旧结果；当前完成度只看机器摘要。
3. **持续验证声明式生态边界。** CK 1.0 对旧 JavaScript 始终 fail-closed；新包持续跑恶意 JSON、远程资源、篡改、迁移回滚、输出预算和同名依赖污染用例。
4. **实现 `.cktrace` 最小可靠闭环。** 第一阶段只做原始字节录制、版本化 manifest、GAP/截断、原子保存和完整性校验；第二阶段做纯离线串口监视/绘图回放。先不做变量探针、断言或统一时间轴。
5. **补跨机复现设计，不自动扩张当前承诺。** 只有在依赖载荷、Core/工具链物化、许可证与签名边界明确后，才把诊断 ZIP 从“摘要”提升为“可复现包”。

## 主要证据入口

- 用户可见功能说明：[`release_notes.ts`](../apps/desktop/src/data/release_notes.ts)
- 编译与包回归边界：[`compiler-and-package-regression-baseline.md`](compiler-and-package-regression-baseline.md)
- 当前一键摘要：[`compile-regression-summary.md`](../artifacts/benchmarks/compile-regression-summary.md)
- 第三方静态门禁：[`package-quality-gates.md`](package-quality-gates.md)
- 板卡护照和 Core 策略：[`third-party-board-passport.md`](third-party-board-passport.md)
- 调试与可靠性范围：[`p0-plus-reliability-roadmap.md`](p0-plus-reliability-roadmap.md)
- 明确暂缓项：[`deferred-platform-roadmap.md`](deferred-platform-roadmap.md)
- 可用版本与诊断包：[`last-working-version-and-diagnostics.md`](last-working-version-and-diagnostics.md)
- 产品化收尾审计：[`productization-closeout-audit.md`](productization-closeout-audit.md)
- CK Forge FLFE（Fast Link For Ever）分层路由：[`ck-forge-flfe-portable-lane.md`](ck-forge-flfe-portable-lane.md)
- Arduino 库拓扑快速路实证：[`flfe-library-topology-qualification-20260727.md`](flfe-library-topology-qualification-20260727.md)
- ESP32 带库同图编辑首版资格：[`flfe-esp32-library-edit-qualification-20260823.md`](flfe-esp32-library-edit-qualification-20260823.md)
- FLFE 跨板卡正式测速：[`flfe-cross-board-speed-20260823.md`](flfe-cross-board-speed-20260823.md)
