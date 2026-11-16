# CK Build Engine V9.0 · Production Foundation

版本 `9.0.0-alpha.1`；协议 1；会话缓存 schema 1。V9 是产品化研发主线，当前可交付物是显式选择的测试候选，不是默认生产发布。

## 模块与接口

| 模块 | 实现 | 契约 |
|---|---|---|
| Frontend | `src/resolver.mjs`, `discovery.mjs`, `frontend.mjs`, `native/frontend.mjs` | 固定 ESP32-S3 / Core 3.3.6 规则；无法证明的库选择或语法回退官方前端 |
| Scheduler | `src/scheduler.mjs` | 内容身份和依赖顺序决定 Reuse / Restore / Execute；时间戳不授权 |
| Asset Engine | `native/src/bin/assets.rs`, `src/asset-engine.mjs` | G1 最终枚举版本；全量 SHA-256，目录成员，句柄前后身份；构建前后各执行一次 |
| Session Cache | `BuildSession` + `NativeScheduler` | 内存授权，每工作区 128 MiB 默认预算；无持久化授权，无跨工程共享 |
| Process Manager | `native/src/bin/job.rs`, `src/controller.mjs` | 挂起创建→加入 Windows Job→恢复；工作区互斥、排队、取消、零活动进程验证 |
| Executor | `src/native/plan.mjs`, `src/execute-command.mjs` | Node/Ninja 调用原版 GCC、GNU ld；合格镜像转换器保留官方回退 |
| Host Adapter | `desktop/crates/ck_core/src/builder/demo/native_graph_backend.rs` | 受宿主管理的桥接进程通过 stdout 直接返回结构化结果；宿主独立验证、导出十个文件并确认租约 |

公开消息形状见 `src/interfaces.d.ts`；运行时入口用 `protocol.mjs` 校验版本、源码摘要、请求 ID 和目标。所有错误也携带请求身份。CLI 元数据展开仍由 Arduino CLI 负责。完整 Arduino 平台兼容尚未完成。当前配置要求明确的 SOURCE_DATE_EPOCH；源程序使用 `__TIMESTAMP__` 时提前回退。第三方库中的时间相关宏仍须纳入后续兼容资格测试，不能宣称通用 C++ 时间语义已经覆盖。

## 请求生命周期

1. 只有测试启动器设置 `CK_V9_CONFIG` 才使用 V9。配置缺失、显式关闭或目标不匹配时走现有 v6。
2. 宿主创建独立请求目录和源码输入，通过自己的受管理子进程请求本机控制器。回环端点使用本次启动的随机令牌。该令牌不是独立安全主体。
3. 每次桌面启动生成新的会话工作区根，避免崩溃后的新桌面清理或写入旧会话目录。控制器在物理工作区键上排队，在获得租约前不写源码。每个工作区由独立 worker 和 Windows Job 持有；不同工作区可独立执行。默认最多四个工作区，空闲淘汰终止 worker 并丢失授权。
4. 前置全量验证、前端、调度执行、十个产物观察、后置全量验证和源码复核全部成功后，才提交内存构建记录。
5. 宿主从直接返回的清单读取每个产物，拒绝重复/缺失名字、重解析路径、越界路径和大小/摘要不符；导出后重新读取并核验。
6. 宿主通过独立 ack 释放目录租约。确认超时或导出失败终止 worker，清除授权；取消排队请求不会提前放行后面的请求。无法验证进程树退出时隔离工作区。

`ENGINE_UNAVAILABLE` 仅在桥接连接初始拒绝且未派发请求时允许自动回退。超时、未知执行状态、内容错误或进程退出未确认均返回失败；不能一边残留执行、一边启动 v6。用户可用独立回退入口重新启动冻结的 v6。

## 内容覆盖与来源

配置直接声明 sysroot、实际 Node/CLI/Ninja、CLI YAML、用户库根、工作区和证据目录。受测平台的 Core、SDK、编译器、CTags、esptool 的版本父目录完整校验，包含安装的版本成员。当前使用的引擎源码和二进制也在根集合中；附加库逐个加入根集合。

V8 旧实验脚本、旧 Node 副本和不参与此配置搜索的旧测试库不再构成 V9 运行依赖。V9 的字节数不能冒充 V8-G 同一资产集合的性能对照。所有实际根、文件数和读取字节数随每次收据保存。

V8-G 原始压缩包保持原位，摘要及来源文件清单在 `provenance/`。桌面源码是冻结导入，V9 只修改独立副本。前端静态 dist 作为固定资源随源码基线导入；本里程碑未修改 Blockly UI，后续 UI 研发需补齐其前端源码构建链。

## 明确的信任范围

T1：信任当前桌面、控制器、运行时和执行结果通道，保护缓存损坏、陈旧或部分结果和已经覆盖的异常。所有授权在桌面会话结束后失效。磁盘收据和候选图只有诊断作用。

前后两次内容身份相同不证明中间整个搜索命名空间不可变。V9 不抵抗能任意控制同用户进程的攻击者，不声称独立可信根，不授权免哈希。普通用户可用，无 UAC、无 Windows 服务安装、无云端编译依赖。

## 保留的开关与禁止项

默认配置 `enabled:false`；测试启动配置显式开启。独立发现、前端重放、会话历史可分别关闭。Rust 是候选验证后端，Node 参考模式用于回归对照。G3 观察优化、替换 GNU ld、链接 hash-size 实验、跨工程 PCH/对象共享和免哈希均不开放。

## 平台依据

平台设计参考 Microsoft Windows Job Objects / Nested Jobs 文档的 Job 继承与 Kill-on-close 语义，以及 Tauri 2 的独立应用 identifier 配置。实际行为以此版本的进程树和桌面测试为准。

参考文档：`https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects`，`https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs`，`https://v2.tauri.app/reference/config/`。
