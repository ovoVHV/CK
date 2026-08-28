# CK 1.0 发布就绪判据与证据索引

更新时间：2026-07-16。

> **发布类别始终限定为本机验证与封闭测试，不等同于公开正式分发。** 本页只定义验收判据，不缓存或代替某次运行的发布结论，也不代表所有板卡、Core、配置或第三方包已经验证。

CK 1.0 只有在本页列出的四层证据同时成立、且证据与同一份冻结源码和同一组交付产物绑定时，才可称为达到本机验证与封闭测试分发标准。**当前裁决只读取 [`v1-release-evidence-manifest.json`](../artifacts/release/v1-release-evidence-manifest.json) 的 `status`、`releaseClass` 及其哈希绑定；本页和其他 Markdown 中的功能状态不得覆盖该机器裁决。**

> **当前状态（2026-07-16）：**现存 evidence manifest 早于后续产品源码修改，因此仅是历史证据；当前源码为新的 candidate。即使旧文件仍记录 `passed`，在重新冻结并跑完同源四层门槛前也不能称为当前候选已经通过。

## 四层发布门槛

| 层级 | 必须满足 | 机器可读证据 |
| --- | --- | --- |
| 自动化与生产构建 | 格式、全部前端/Rust/脚本、**恰好 5 套**确定性示例包、Extension SDK、production build、MSI 和 NSIS 全通过；不得跳过 gate | [`v1-release-gates.json`](../artifacts/release/v1-release-gates.json) |
| 内置积木/Core 兼容 | 147 种可见积木在 AVR Nano/C6 的 294 个生成格全部通过；**7 套代表性 generator 输出只做 compile-only 7/7，报告必须保持 `hardwareTested=false`**，不得写成 7 套真板验证 | [`builtin-block-generator-audit.json`](../artifacts/release/builtin-block-generator-audit.json)、[`core-compatibility-results.json`](../artifacts/release/core-compatibility-results.json) |
| 最终 production EXE 原生冒烟 | 必须启动与 manifest 哈希相同的最终 production EXE，核对主页/主题/工作区、完整系统路径、声明式包边界、未知积木保护、恢复入口、搜索、体检布局和无水平溢出；执行 10 轮工程进入/返回内存斜率。本轮 TFT 图片缓存、隐藏串口暂停和 SSE 边界加入后，旧 EXE 的内存报告不得复用 | [`v1-native-smoke.json`](../artifacts/release/v1-native-smoke.json)、[`desktop-memory-regression.json`](../artifacts/release/desktop-memory-regression.json)、[`desktop-memory-lifecycle.md`](desktop-memory-lifecycle.md) |
| 代表性 C6 真板链路 | 在最终 production EXE 上完成 COM 设备体检、冷编译、Exact、热编辑、普通上传、单调分段进度、产物哈希门禁及篡改拒绝；另由普通上传进入真实 Arduino CLI/GCC 后做 run-scoped 安全取消，连续确认无工具孤儿／Flash transport，并立即仅编译成功 | [`v1-c6-hardware-regression.json`](../artifacts/release/v1-c6-hardware-regression.json)、[`v1-c6-upload-progress.json`](../artifacts/release/v1-c6-upload-progress.json)、[`v1-c6-device-health.json`](../artifacts/release/v1-c6-device-health.json)、[`v1-c6-manifest-gate.json`](../artifacts/release/v1-c6-manifest-gate.json)、[`v1-c6-safe-cancel.json`](../artifacts/release/v1-c6-safe-cancel.json) |

最终交付索引由 [`v1-release-evidence-manifest.json`](../artifacts/release/v1-release-evidence-manifest.json) 汇总源码身份、门禁时间、报告、production EXE、MSI、NSIS、Extension SDK、真板证据和 SHA-256。若任一引用缺失、生成时间早于最后源码修改、哈希不一致或状态非通过，机器清单必须将裁决保持或退回候选，不得由人工文案补写为通过。生成器、原生报告绑定契约和 `failed`／`candidate_evidence_stale` 的区别见 [`release-evidence-manifest.md`](release-evidence-manifest.md)。

当前仓库中的旧 `desktop-memory-regression.json` 生成于上述三项内存边界落地之前，只能保留为历史诊断。下一份可用于 1.0 裁决的报告必须在新源码冻结、完整 gate、production build 后，绑定新 EXE 的实际 SHA-256 和同一 WebView2/CDP 会话重新运行；不能仅改文档或复制旧 `passed` 状态。

CK 1.0 还必须提供 [`first-compile-performance-summary.json`](../artifacts/release/first-compile-performance-summary.json)：两种 cold 模式各恰好 3 个同源、同 PID、成功上传样本，并按 First／Ready 严格交替且验证窗口不重叠，median 与 p95 改善均达到 30%。最终清单会重算统计并复核工程、端口、真机、完整 FQBN、Core 版本、Arduino CLI、工具链、构建签名、按模式声明的 compile／upload profile、优化等级、源码冻结、gate、EXE 与时序策略；缺失或任一字段漂移均不得通过。

## 当前裁决入口

- 当前候选是否通过、绑定哪次 gate、使用哪份源码、EXE／MSI／NSIS 的实际哈希、签名状态以及原生／真板证据是否同源，只看 [`v1-release-evidence-manifest.json`](../artifacts/release/v1-release-evidence-manifest.json)。
- [`v1-release-gates.json`](../artifacts/release/v1-release-gates.json)、原生冒烟和真板报告是被清单引用的分层证据；脱离 evidence manifest 的历史 `passed`、截图或同路径文件不能继承当前资格。
- 本页不复制具体 run ID、瞬时文件大小或哈希，避免下一次冻结和构建后形成第二套冲突裁决。

## 源码与证据绑定

- 有 Git 元数据时记录可核验 commit；无 Git 时按稳定相对路径排序记录发布输入文件的逐文件 SHA-256，生成可复算源码树 manifest，并记录该 manifest 的 SHA-256 与 `frozenAt`，不得虚构提交号。
- 完整 gate、production EXE、MSI、NSIS、原生冒烟和代表性真板报告必须共同引用同一源码身份；任一后续源码或产物变更都会使旧绑定失效。
- evidence manifest 必须记录 gate run ID／起止时间、源码树身份、产物生成顺序、逐产物 SHA-256 和证据报告 SHA-256，且在生成时复核所有引用。
- 无论机器裁决为何，发布口径均只限本机验证与封闭测试；公开正式分发仍需独立满足可信代码签名、时间戳及安装／升级验证。

## 五套确定性示例包

发布 gate 只接受以下 **5 套**可导入 ZIP，不把 SDK、源码目录或临时归档重复计算成更多示例：

1. `ck_example_c6_board.zip`
2. `ck_example_i2c_sensor_v2.zip`
3. `ck_example_nano_board.zip`
4. `ck_example_native_deep.zip`
5. `ck_example_serial_blocks.zip`

## 安装与数据边界

- Windows 安装包必须同时生成 MSI 与 NSIS，并包含 Arduino CLI 1.4.1、ccache 4.10.2、GPL-3.0 文本和第三方 notices。
- 安装版只写当前用户可写的 CK 数据根，优先复用 `Documents/CK`；不得写 exe 或 Program Files 旁，也不得静默改用 PATH 中另一版 CLI。
- `prebuilt_cores` 的 canonical 写路径是 CK sysroot 内部；旧 sibling 只允许受控同卷原子迁移/唯一兼容读取。
- 编译器驱动可经 ccache；所有非编译工具必须继续使用当前 Core 的精确路径，或在架构前缀明确、内容无冲突时采用不经 ccache 的直达转发。

## 发布口径和已知限制

- “ESP32-C6 真板通过”只绑定报告中的具体芯片、实体 Flash/明确 PSRAM、Core、工具链和完整 FQBN，不能代替 C3/C5/S3 或其他配置。
- 生成矩阵与 compile-only 不是物理外设、无线关联或时序验证。
- 第三方生态只开放通过质量门禁的声明式 JSON/XML 包，并保持 fail-closed；Legacy `blocks.js` / `generator.js` 只保留迁移数据，**不在主 WebView 或迁移链路执行**，质量报告、白名单或哈希匹配均不授予执行权。
- “干净重建”针对本机上一个可用版本，不承诺诊断 ZIP 在另一台电脑自动联网物化依赖。
- 当前缓存身份强校验 Core 源码、variant、关键编译工具、Arduino 库完整可见源码与 manifest；但若用户绕过包管理器，在 CK 运行期间手工原地替换 SDK 预编译静态库或编译器 sysroot，并刻意保留原包版本、文件长度和时间戳，进程内 memo 不能承诺识别。完成这种开发者级操作后必须重启 CK，并使用高级“彻底刷新”后重编译；不得把默认内容缓存重建或普通 Exact 命中当作对这种篡改的证明。
- `.cktrace`、真机断言、内置直接 PDF、项目 SBOM 和运行 backtrace／时间轴按 [`v1-acceptance-matrix.md`](v1-acceptance-matrix.md) 明确延期或仅有底座。`ckpkg` CLI／CI、可信 linker map 边界内的资源归因、本地工程验收报告以及本地无签名边界的 `project.ckpkg` 提交／只读验收已经完成，不再列为延期；它们各自的证据边界仍不得扩大。
- Windows 安装包若没有可信发布证书，Authenticode 状态会是 `NotSigned`。它可用于本机/封闭测试，但公开正式分发前应完成代码签名、时间戳和安装/升级验证；不得把未签名写成“签名已通过”。
- 当前候选的首编摘要只消费上游已脱敏的固定 `c6_regression`／COM12 原生报告，最终 evidence manifest 还会对所有引用 JSON 做完整 MAC 和绝对路径 fail-closed 扫描。面向任意工程的通用摘要 CLI 后续仍应增加“输出前扫描并替换敏感投影”的独立 P1 门禁；不能只报失败却把原值继续写进失败报告。

## 证据保留规则

1. 先冻结源码；有 Git 时记录 commit，无 Git 时生成可复算源码树 manifest、SHA-256 和冻结时间；随后运行完整发布门禁，不能只跑失败项。
2. 同一 evidence manifest 必须绑定源码身份、gate run ID／起止时间、production EXE、MSI、NSIS 及各自 SHA-256。
3. 只启动该轮门禁生成且 SHA-256 与 manifest 一致的 production EXE 做原生与真板验证；MSI 和 NSIS 也必须与该轮 gate 接受的哈希一致。
4. 当前 1.0 机器裁决直接要求报告集合记录并校验精确 C6 FQBN／工程／串口、结构化芯片和实体 Flash、缓存清理、冷编译／Exact／热编辑／上传、上传进度、错误产物清单阻断，以及普通上传在真实 Arduino CLI/GCC 阶段的 run-scoped 取消与新 run 立即编译恢复。安全取消还必须证明没有 `avrdude` 或 esptool 写入／串口 transport、后端完成 terminate-and-wait、工具树和全局 CK 关联孤儿连续归零、恢复编译 lock wait 不超过 5 秒；`elf2image` 构建打包不算 Flash transport。首次编译稳定性汇总会结构化复核 Core／CLI／工具链／构建签名／优化等级的公共身份，按 cold 模式严格核对真实 compile／upload／baseline profile 和精确缓存清理身份，并独立验证 Exact、热编辑及基线时间包络；六份样本还必须绑定同一工程、端口、结构化硬件属性与无重叠时序。这里不宣称已经完成工程级 MAC 绑定。逐烧录段和更细工具明细仍保留在编译、上传与诊断日志中，不能扩大为所有板卡配置的认证。
5. 人工截图只作视觉补充，机器 JSON、原始日志和产物哈希才是裁决证据。
6. 先生成不引用最终清单、严格 First／Ready 交替且恰好 3+3 的首次编译稳定性汇总，再由最终 evidence manifest 单向引用它；任何后续源码、交付产物或证据报告变更都要求重新执行本流程。
7. 不得在正在供用户操作的 Tauri/WebView2 窗口上调用 Playwright `setViewportSize` 或保留 CDP 设备尺寸覆盖；窄窗口回归必须使用隔离测试页或原生窗口尺寸。所有连接真实 CK 窗口的原生 CDP 回归必须先调用共享的 `native-cdp-viewport-guard.cjs`，清除历史设备尺寸覆盖，并同时核对 Tauri 原生窗口物理尺寸与 `window.innerWidth × devicePixelRatio`、`#root`、`.app-root` 右边界；只比较 DOM 与合成视口会漏掉“二者同为旧宽度、原生窗口已变宽”的最大化黑边。清除后仍不一致时必须失败并要求重启 CK 或执行真实原生窗口缩放；产品 CSS 不负责掩盖调试器修改的 compositor 视口。
