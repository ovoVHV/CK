# CK 1.0 产品化验收矩阵

更新时间：2026-07-16。

> 本矩阵描述的是 **CK 1.0 本机验证／封闭测试候选**的功能边界，不是公开正式发布声明。功能项标为“完成”也不自动表示 EXE、MSI、NSIS 已与同一冻结源码和同一轮 gate 绑定。

> 2026-07-16 的产品源码晚于现存 `v1-release-evidence-manifest.json`；该清单只作历史记录，当前源码仍是 candidate。必须重新生成同源 gate、生产产物、原生冒烟与真板证据后才可更新机器裁决。

> 本轮新增了 TFT 图片有界缓存、数据图模式下隐藏串口终端暂停接收，以及 Agent／扩展修复 SSE 超限 fail-closed。它们都是上一份 `desktop-memory-regression.json` 之后的产品源码变更，因此旧报告即使记录 `passed` 也已失效；当前候选必须以新冻结源码和新 production EXE 重跑 10 轮原生内存回归。

本文逐项核对产品化收尾清单，防止“做过一点”被写成“已经完整上线”。状态只使用三种：**完成（1.0 边界）**、**部分底座**、**明确延期**。自动化、安装包和真板的当前裁决只以 [`v1-release-evidence-manifest.json`](../artifacts/release/v1-release-evidence-manifest.json) 的 `status`、`releaseClass` 及其哈希绑定为准；判据见 [`v1-release-readiness.md`](v1-release-readiness.md)。

## 封闭测试证据边界

- 内置积木兼容报告包含 147 种可见积木、AVR Nano/C6 共 294 个生成格；另有 **7 套代表性 generator 输出仅完成 compile-only**。这些记录必须保持 `hardwareTested=false`，不能解释为 7 套真板、外设、无线或时序验证。
- 发布 gate 的确定性示例集合固定为 **5 套**：C6 板卡包、v2 I2C 积木包、Nano 板卡包、深层原生 Arduino 库和声明式串口积木包。
- 第三方运行时只接受通过门禁的声明式 JSON/XML，并在结构、来源、路径、资源、模板和输出预算任一条件不满足时 fail-closed。Legacy `blocks.js` / `generator.js` 不执行；旧包获批、哈希匹配或质量报告通过也不改变这一点。
- 每个封闭测试候选都必须绑定可核验 Git commit，或绑定可复算源码树 manifest／SHA-256／冻结时间；EXE、MSI、NSIS、最终 production EXE 原生冒烟与代表性 C6 真板证据必须由同一 evidence manifest 关联。缺失或失配时机器裁决保持候选。
- 首次编译的 30%～40% 目标不能引用单次截图或历史平均值。CK 1.0 必须以同一工程、COM 口与结构化硬件属性（芯片、修订、实体 Flash、明确检测到的 PSRAM）、production PID、完整 C6 FQBN、Core／CLI／工具链／构建签名、源码冻结和 gate，严格交替形成恰好 3 份 `firstProjectCold` 与 3 份 `readyInstallCold` 成功上传样本；六次验证窗口不得重叠，整批最多 2 小时且不超过 72 小时。这里不宣称已经完成工程级 MAC 绑定。median 和 nearest-rank p95 都至少改善 30%，并由最终 evidence manifest 重新计算、哈希引用。汇总不反向引用最终 manifest，以免形成循环证据。

## 1.0 必须完成的六项

| 清单项 | 状态 | 1.0 已交付边界 | 不冒充的能力 | 主要证据 |
| --- | --- | --- | --- | --- |
| `ck-sourcemap` | **完成（1.0 边界）** | 编译会话冻结代码 SHA-256、文件、积木 ID/type、生成 section 和行 span；后端复核后原子写入，只定位哈希一致的本次 sketch | 不猜第三方库、过期源码或错误 span；尚未做运行崩溃到积木 | [`compile_source_map.ts`](../apps/desktop/src/services/compile_source_map.ts)、[`compile_source_map.test.mjs`](../apps/desktop/src/services/compile_source_map.test.mjs) |
| 缺失积木保险箱 | **完成（1.0 边界）** | JSON/XML 未知类型在进入 Blockly 前被拦截，完整原始字节、结构和哈希保留；工程只读，可原样导出、补包和重试；保存、编译、上传 fail-closed | 1.0 没有可编辑占位积木，不能称为“缺包后仍可继续编辑” | [`unknown_block_guard.ts`](../apps/desktop/src/services/unknown_block_guard.ts)、[`UnknownBlocksProtectionPanel.tsx`](../apps/desktop/src/components/UnknownBlocksProtectionPanel.tsx) |
| 声明式包迁移 | **完成（v1）** | `renameBlockType`、`renameField`、`mapEnum` 等纯数据操作；dry-run、迁移前检查点、精确包/工程 CAS、联合提交、失败回滚和崩溃恢复 | 不执行迁移 JavaScript；没有可信旧版本证据时阻止而不猜测 | [`ck-migrations.schema.json`](schemas/ck-migrations.schema.json)、[`block_package_migration_tx.rs`](../apps/desktop/src-tauri/src/block_package_migration_tx.rs) |
| 滚动恢复稿与崩溃恢复 | **完成（v1 提示合同）** | 普通语义编辑约 12 秒防抖、原子落盘、内容去重、项目/全局数量和字节上限、损坏隔离；每次打开工程只提示最新有效稿，旧稿不自动排队。“暂不处理”或成功覆盖后同一会话抑制同基线旧稿，所选稿保留到正式保存；重新打开后允许重新判断 | 当前差异是时间/摘要，不是逐积木语义 diff；会话抑制不是删除或跨设备同步 | [`recovery-drafts-v1.md`](recovery-drafts-v1.md)、[`recovery_drafts.rs`](../apps/desktop/src-tauri/src/recovery_drafts.rs)、[`WorkspaceRecoveryDrafts.test.mjs`](../apps/desktop/src/components/WorkspaceRecoveryDrafts.test.mjs) |
| `ck.lock` 干净重建 | **完成（本机可用版本边界）** | 从“上一个可用版本”物化精确依赖到隔离根，校验哈希、完整 FQBN、CLI、工具链；禁止全局库、隐式同名回退和 Fast Relink 历史对象 | 不是诊断包跨机自动安装 Core/依赖；QuickFast 只证明 compile-only | [`last_working_version.rs`](../apps/desktop/src-tauri/src/last_working_version.rs)、[`demo.rs`](../crates/ck_core/src/builder/demo.rs) |
| 第三方代码隔离 | **完成（1.0 fail-closed）** | 只激活通过门禁的声明式 JSON/XML 与受限生成规则；外部/内联脚本、回调、远程资源、危险文本和超预算输出拒绝；`blocks.js`/`generator.js` 永久 `legacy-disabled` | 不是“任意第三方 JavaScript 已沙箱化”；1.0 根本不执行第三方脚本 | [`extension_loader.ts`](../apps/desktop/src/services/extension_loader.ts)、[`declarative_block_runtime.ts`](../apps/desktop/src/services/declarative_block_runtime.ts) |

六项都要求持续通过恶意输入、篡改、崩溃恢复和 fail-closed 回归。任何一项测试变红，不能仅凭本表维持“完成”状态。

## 桌面资源生命周期

| 能力 | 状态 | 1.0 边界与裁决 |
| --- | --- | --- |
| Blockly/DOM 释放 | **完成（1.0 边界）** | 显式释放垃圾桶 flyout、旧 main workspace、异步监听器和 resize RAF；最终 production EXE 仍必须通过 10 轮工程进入/返回的 DOM、heap 和私有内存斜率回归 |
| 有界日志与串口历史 | **完成（1.0 边界）** | 编译日志 2,000,000 字符/8000 行，主串口 scrollback 8000 行，独立队列与安装日志另有更小硬上限；切到数据图时隐藏文本终端暂停接收但保留现有历史；超限保留最新证据并明确提示，不承诺无限历史 |
| TFT 图片缓存 | **完成（1.0 边界）** | 源文件 16 MiB、单个解码项估算 64 MiB、总缓存 64 项／128 MiB；临时 Blob URL 必须撤销，当前工作区引用不得静默淘汰，预算不足时 fail-closed 并提示用户缩小或移除图片 |
| Agent／扩展修复 SSE | **完成（1.0 边界）** | 对原始字节、待解析行、事件、正文／推理和工具参数设置独立硬上限；超限中断并返回可操作错误，不执行 Agent 的截断工具调用，也不应用截断修复；完整数值见内存基线文档 |
| 安全取消编译/上传 | **完成（1.0 边界）** | UUID 隔离每个 run；锁等待可取消，运行中只 kill 本 run 的 Arduino CLI/GCC 树并 wait 后释放锁；最终原生冒烟必须证明取消后无旧进程、无旧锁等待和无取消后 Flash transport |
| 进程与缓存注册表 | **完成（1.0 边界）** | 编译锁和 CCDB 锁使用弱引用；LLM 取消状态有容量/TTL/输入上限，不保留整段原始 SSE 事件；不把 Windows 可回收工作集宣传成固定常驻值 |

完整测量口径、旧版本复现数据与最终阈值见 [`desktop-memory-lifecycle.md`](desktop-memory-lifecycle.md)。源码实现与自动化通过不替代最终同哈希 production EXE 的原生内存回归；本轮边界变更后的旧 EXE／旧报告不能继续用于当前候选。

## 中期生态与证据链

| 能力 | 当前状态 | 现有底座与缺口 |
| --- | --- | --- |
| 积木库四级护照 | **部分底座** | 已有结构门禁、v2 八类语义完整度、机器质量报告和板卡四级护照；尚无独立积木库四级对象/UI，也没有逐包 compile/device 覆盖计数 |
| `ckpkg` CLI / CI | **完成（开发者 CLI v1）** | Extension SDK 提供可安装的 `ckpkg` bin，统一 `create/validate/test/compile/pack`、稳定退出码、机器 JSON、确定性 ZIP 与最小 GitHub Actions；compile 只调用真实 Arduino CLI，profile 必须在包内映射到显式 FQBN 与 sketch，未知别名不猜测 |
| `ck-tests.json` 合约测试 | **部分底座** | `tests/ckpkg-tests.json` 已向第三方作者开放无执行能力的 `file-exists`、`file-contains`、`json-pointer-equals` runner，并结合正式生成器/迁移门禁；尚未形成可操纵 Blockly 字段并比对最终 C/C++ 的通用 `ck-tests.json` 合约 |
| 安全更新预演 | **部分底座** | 声明式包升级已有 dry-run/回滚，“为什么上次能用”已有事后差异；Core、Arduino 库和板卡包的隔离试升级尚未实现 |
| 资源增长归因 | **完成（可信 linker map 边界）** | 当前与基线 map、完整 FQBN、分类器和编译器总量全部一致时，按库、Core、生成代码及链接／对齐残差解释增量；分组和总量必须逐字节对账。缺 map、容量变化或证据不一致时退回总量，不猜 symbol、字体或积木因果 |
| 依赖关系图 | **部分底座** | 有 Arduino `depends=` 闭包、lock inventory 和版本差异；没有稳定图模型、循环/来源可视化 |
| 项目 SBOM 与许可证清单 | **部分底座** | 安装包带 `THIRD_PARTY_NOTICES.md`，包导入检查许可证形状；尚无项目级 `project-sbom.json` 与自动生成的 notices |

## 运行问题复现与后续平台能力

| 能力 | 当前状态 | 说明 |
| --- | --- | --- |
| `.cktrace` 黑匣子与离线回放 | **明确延期** | 已完成格式、安全和有界队列审计；录制器、容器和回放 UI 未实现 |
| 设备/主机时间校准 | **部分底座** | 轨迹协议有 `deviceMicros`、主机接收时间和回绕处理；没有统一序号、握手偏移/延迟/漂移校准 |
| 复位原因、ESP backtrace、崩溃定位积木 | **明确延期** | 现有 ELF、source map 和运行轨迹是底座，但三项链路均未上线 |
| 统一运行时间轴 | **明确延期** | 断点、轨迹、串口和上传仍是独立链路 |
| 工程健康与项目验收报告 | **完成（本地报告边界）** | 按检查项展示当前目标、编译、资源、依赖、检查点、引脚及四级板卡护照；护照证据绑定精确包、完整 FQBN、Core 与有效状态。支持脱敏 JSON、无脚本可打印 HTML 和系统另存 PDF；不是内置 PDF 生成器 |
| 真机断言与设备侧测试报告 | **明确延期** | 尚未解决无副作用求值、失败安全状态、小内存协议和重复测试隔离；不能拿本地项目验收报告冒充真机断言执行结果 |
| `project.ckpkg` 提交与导入验收 | **完成（本地无签名边界）** | 独立 schema/manifest、固定路径、逐文件大小与 SHA-256、四档显式源码范围及可选脱敏锁/构建证据；导入只读、不解压、不执行、不联网、不写工程。完整性校验不等于发布者签名，详见 [`project-submission-format.md`](project-submission-format.md) |
| 内置直接 PDF | **明确延期** | 后端生成无脚本可打印 HTML，使用系统打印保存 PDF；未实现内置 PDF 渲染器 |
| 工程绑定设备 MAC | **明确延期** | 已有本机完整 MAC 和持久化哈希设备 ID；没有项目策略、UI 和上传门禁 |
| 字段级证据分级 | **部分底座** | 板卡/引脚已有来源与部分证据，积木 catalog 有元数据来源；尚未统一为 declared/inferred/compile/device verified 及过期策略 |
| AI 确定性工具接口 | **部分底座** | 已有标准化积木元数据与本地 catalog；`searchBlocks/getBlockContract/compileVerify` 等受约束产品 API 尚未形成正式闭环 |

## 配置矩阵口径

第三方板卡采用“板厂声明的有限完整 profile + include/exclude + 明确覆盖范围”，只在低于最低 Core 或命中已知不兼容范围时阻止；推荐范围外但未确定不兼容时给警告。1.0 不穷举 Flash、分区、PSRAM、USB、CDC、JTAG、上传速度和优化等级的笛卡尔积，也不把代表性 compile-only 或一块真板扩大为全系列认证。

## 1.0 之后的优先顺序

1. `.cktrace` 原始串口录制与纯离线回放。
2. 项目 SBOM、依赖图与完整第三方 `ck-tests` 生成结果合约。
3. 安全更新预演和资源库级归因。
4. 设备时间校准、复位/backtrace 与统一运行时间轴。

完整的延期进入条件见 [`deferred-platform-roadmap.md`](deferred-platform-roadmap.md)。
