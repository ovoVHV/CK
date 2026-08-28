# CK 桌面内存与资源生命周期基线

更新时间：2026-08-25（历史问题样本采集于 2026-07-16）。

本页定义 CK 1.0 桌面端的内存边界和复测方法。它关注可复现的线性增长、后台进程与有界缓冲，不用某一时刻的任务管理器数字冒充跨机器的固定内存承诺。Windows 工作集会受 WebView2、文件缓存和系统内存压力影响；裁决时同时观察进程树私有内存、JavaScript heap、DOM/document 数、Blockly workspace 注册表以及 Arduino CLI/GCC 子进程。

## 已确认的旧版本问题

在旧 production EXE 的同一 C6 工程上，反复执行“打开工程 → 返回主页 → 再打开工程”，并在每轮后请求 V8 垃圾回收，得到以下诊断证据：

- 每轮增加 1 个 document 和约 2384 个仍可达 DOM node；`Blockly.Workspace.getAll()` 中持续残留 `blocklyTrashcanFlyout`，其 `targetWorkspace` 指向已经 dispose 的主工作区。
- `Blockly.getMainWorkspace()` 在主工作区 dispose 后仍返回旧对象。
- WebView 渲染进程工作集由约 61.0 MiB 增至 168.7 MiB，私有内存由约 71.1 MiB 增至 139.8 MiB。
- CK 主进程加全部 WebView2 子进程的工作集合计由约 171.0 MiB 增至 328.4 MiB，私有内存合计由约 242.1 MiB 增至 313.1 MiB。
- 同一段循环中 V8 heap 只由约 11.93 MiB 变为 12.28 MiB，而 DOM node 为 14804 → 17198 → 19582 → 21966，说明主要问题是 Blockly/DOM 生命周期，不是普通 JavaScript 数组。

这些数字只描述该本机旧构建的复现场景，不能直接作为其他电脑的常驻内存承诺。

## CK 1.0 已建立的边界

### Blockly 与界面资源

- Workspace 卸载时先显式 dispose Blockly 12 垃圾桶拥有的 flyout，再 dispose 主工作区。
- 只有全局 main workspace 仍指向本次旧对象时才清空，不能误清新工程。
- Blockly 12 每次 `inject()` 都会向复用的全局 `WidgetDiv` 再绑定一次键盘监听；CK 在下一次注入前隐藏并以无子节点克隆替换该单例，使新工作区只拥有本轮监听。
- `SerialMonitor`、独立控制台及板卡安装事件在异步注册晚于卸载时立即注销。
- 串口数据图可见时，隐藏的文本终端暂停接收新数据但保留已有 scrollback；切回文本视图后从当前串口数据继续，不在后台维护第二份持续增长的终端历史。
- ResizeObserver 触发的 Blockly resize 使用单一 RAF，并在卸载时取消；toast 只保留一个可取消计时器。
- TFT 图片读取前后都复核源文件大小，单个源文件最多 16 MiB；解码缓存最多 64 项、估算总量 128 MiB，单项估算最多 64 MiB。当前工作区仍引用的图片会被保护，不为满足 LRU 预算而静默淘汰；如果全部候选都仍在使用则拒绝新增并提示缩小或移除图片。图片替换、清空和工作区卸载会释放缓存引用，解码用临时 Blob URL 无论成功失败都在 `finally` 中撤销。

### 有界数据

- 主界面编译日志 state 最多 2,000,000 字符且最多 8000 行，超限只保留最新诊断、资源统计和产物尾部，并显示一次截断标记。
- 后端编译器输出按 8 KiB 读取块、最多 16 KiB 单条记录和固定容量通道逐层限流；编译通道最多 256 条、上传通道最多 100 条。返回前端的完整编译日志最多 2 MiB，上传最终日志最多 1 MiB，均保留可核对的头部、关键诊断尾部和唯一截断标记。
- Fast Relink、Flash 探测、Core 属性和其他直接工具输出使用并发有界 drain；需要继续解析的工具一旦超过预算会排空子进程后 fail-closed，不会拿截断文本继续猜测构建或硬件结果。
- 包管理同步命令的 stdout/stderr 分别最多保留 8 MiB/2 MiB；Core 安装实时输出按 4 KiB 读取并保持合法 UTF-8 跨块字符，单次 UI/log 事件不超过 16 KiB，最终错误摘要最多 256 KiB。超长无换行输出不会堵满管道或形成无界字符串。
- `compile_metrics.jsonl` 最多保留最新 4096 条有效记录且文件不超过 2 MiB；历史超限或损坏文件通过有界尾部恢复，单条超长记录不会在启动排序或诊断读取时造成无界分配。
- 主串口 xterm scrollback 为 8000 行；独立控制台为 8000 行，待处理编译队列最多 2000 行。
- 板卡安装日志最多 500 行，单行最多 2000 字符。
- SerialPlotter、运行轨迹、调试协议解析、恢复稿和后台预热沿用各自已有的通道、记录、字节或数量上限。
- per-FQBN 编译锁与 per-build-path CCDB 锁只保存弱引用，不永久记住每个历史键。
- LLM 取消记录限制为 256 条、10 分钟 TTL，run ID 最多 256 bytes 且禁止控制字符。Agent SSE 限制为原始流 8 MiB、单条待解析行 256 KiB、4096 个事件、正文与推理合计 4 MiB、64 次工具调用、工具名 256 bytes、单次参数 512 KiB 且参数总量 1 MiB；扩展修复 SSE 限制为原始流 4 MiB、单条待解析行 256 KiB、2048 个事件和正文 1 MiB。非成功 HTTP 响应正文最多读取 256 KiB。任一预算超限都会主动丢弃流、返回可操作错误并 fail-closed，不会执行 Agent 的截断工具调用，也不会应用截断的扩展修复结果。

### 安全取消前台构建

- 每次普通编译/上传使用独立 UUID run ID 和独立取消 token。
- 等待 compile lock 时可立即取消，不会释放或干扰当前 owner。
- 获得锁后，CK 只终止该 run 登记的 Arduino CLI/GCC 进程树；Windows 使用 `taskkill /PID ... /T /F`，随后仍由原编译任务 wait/reap Child，确认退出后才释放 compile lock。
- 上传的 QuickFast、SharedFast、原生 Release（以及仅用于旧基线重放的历史 PortableFast）和 Flash transport 共用同一 run token；取消后不得继续 fallback 或写 Flash。PortableFast 已退出未资格目标的默认产品路由。
- 前端保持“正在安全停止”状态，后端确认进程退出后才允许下一次编译；上传前关闭过的串口监视器仍由原操作 finally 恢复。

### 退出与后台进程回收

- Tauri 的 `ExitRequested` / `Exit` 进入同一个幂等 shutdown coordinator：先关闭串口，再同时取消前台编译、后台 warmup、Core/库安装命令和上传/恢复会话，并等待每个任务自己的 owner `wait` / `reap` 子进程。
- 安装命令的 spawn、登记和退出门禁使用同一互斥区，避免“退出已拍快照、随后又启动一个 CLI”的竞态；上传在 1.0 中保持后端单会话，generation guard 防止旧 guard 清除新会话。
- Windows 只对本 CK 实例实际 spawn 并登记的 PID 执行 `taskkill /PID ... /T /F`，同时保留对应进程句柄直到终止请求完成，降低 PID 复用误杀风险；不会枚举进程名或终止用户自行运行的 Arduino CLI、Python、GCC 和其他 CK 实例。
- 协调器最多等待 15 秒并记录具体未回收类别；超时不会被写成“已确认清理完成”。普通“取消 Core 安装”仍只作用于该 CoreInstall scope，不会波及并行的只读库搜索或其他已登记命令。

## 最终 production EXE 的内存回归

> **证据失效提醒：**上述 TFT 图片缓存、隐藏串口暂停和 SSE fail-closed 均发生在上一份原生内存报告之后。此前即使 `desktop-memory-regression.json` 仍标记为 `passed`，也只能作为历史诊断，不能继承给当前候选。必须在本轮源码冻结、完整 gate 和新 production EXE 生成后，用该同哈希 EXE 重新执行 10 轮原生内存回归并生成新报告。

冻结源码后的最终原生冒烟必须使用同哈希 production EXE，并至少执行：

1. 打开固定 `c6_regression` 工程，完整 FQBN 必须为 `esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB`，并取得非空生成源码指纹；完成当前生成源码的代码感知预热并连续确认工具链静默后，再记录 CK 进程树、renderer heap、documents、nodes、listeners 和 Blockly workspaces。启动/板卡级 Core 预热不得覆盖精确工程源码槽。
2. 连续 10 次“返回主页 → 打开同一工程”，每轮稳定后采样；不得对真实 Tauri WebView 调用 `setViewportSize`。
3. 主页状态必须满足 `Blockly.getMainWorkspace() == null`，且不得存在指向已 dispose 主工作区的 trashcan flyout；工程状态只允许当前主工作区及其当前子 flyout。
4. 自动化打开工程后通过 CDP `Input.dispatchMouseEvent` 发送一次不改变界面的真实 `mouseMoved`，只用于触发 Blockly 官方声音预加载回调并注销其 `pointermove`/`touchstart` 两个一次性监听；不使用页面内 `dispatchEvent()` 合成不可信事件。
5. 强制 GC 后，主页和工程页都比较第 10 轮与第 2 轮：renderer heap 增量不超过 5 MiB、DOM node 增量不超过 1500、DOM 事件监听器增量不超过 3、CK 主进程与 WebView2 常驻进程的私有内存增量不超过 32 MiB；任一指标持续线性上升即失败。趋势窗口至少包含 9 个有限数样本，缺失字段不得按零处理。
6. 证据记录完整 CK 子进程树，并将进程明确分为 `root`、`resident_webview`、`known_toolchain` 与 `unknown_descendant`。每个正式指标组必须在连续两次空闲轮询后采集，并在采集后立即再次确认无污染；期间发现工具链时丢弃整组指标并重试，同时在 JSON 中保留等待时间、污染进程哈希与重试历史。15 分钟内无法取得干净样本时，整体门禁失败且 `result_kind` 标为 `inconclusive`，不能发布一份看似干净的结果；最终候选证据还要求整轮 `contamination=clean`、观测次数和丢弃组数均为零，不能用后续重试掩盖反复后台编译。
7. 为避免漏掉父 `arduino-cli` 已退出但 GCC/esptool 仍存活的情况，除当前 CK 后代树外，还扫描命令或可执行位置明确关联当前 CK 根目录或 `CK_Builds` 的已知工具进程。该扫描只记录脱敏后的命令 SHA-256、来源分类和创建时间，不把完整用户名或命令行写入发布证据。
8. 安全取消使用独立的 [`Test-SafeCancelNative.ps1`](../scripts/Test-SafeCancelNative.ps1)：固定从普通上传按钮启动，先清理当前完整 FQBN 缓存以确保进入真实 Arduino CLI/GCC，再用页面本次 `upload_sketch` 的 UUID 调用 `cancel_foreground_build`。只有后端返回“owned process tree terminated and waited”、原上传 Promise 被拒绝、没有 `avrdude` 或 esptool `write_flash`／串口 transport、CK 后代工具树与全局 CK/`CK_Builds` 关联孤儿连续三次为零后，才允许以新 UUID 立即执行“仅编译”；恢复编译必须成功且日志中的 compile-lock wait 不超过 5 秒。esptool `elf2image` 是构建打包，允许出现且不算 Flash transport。报告同时锁定工程源码指纹、完整 FQBN 和端口前后不变。
9. 用合成大日志验证前后端编译/上传日志、独立控制台、串口、包管理输出和持久化编译指标的硬上限；覆盖超长无换行、跨块 UTF-8、损坏记录和并发写入，不能依赖“正常用户不会产生这么多输出”。

强制 GC 只用于识别仍可达对象和比较循环斜率，不代表 CK 会主动频繁强制垃圾回收。最终内存机器结果写入 `artifacts/release/desktop-memory-regression.json`；安全取消真板结果写入 `artifacts/release/v1-c6-safe-cancel.json`。两者都通过共享 binding 引用同一源码树、gate、production EXE、WebView2/CDP 会话和前后复核时间，且只由最终 evidence manifest 决定是否属于当前封闭测试候选。
