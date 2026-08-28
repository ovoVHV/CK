# CK 编译器与第三方包回归基线（历史快照）

更新时间：2026-08-25（基线数据采集于 2026-07-12）。

这份文档保留 2026-07-12 同机回归数据和安全约束，不能作为当前客户机的性能承诺或 Fast 资格。后续修改编译器、库管理器、板卡导入或预热逻辑时，不能只确认“能编译”，还必须用当前 production EXE 复跑对应基线。

## 当前硬指标

| 场景 | 门槛 | 本轮实测 |
| --- | --- | --- |
| AVR Nano 首次冷编译，相对标准 Arduino CLI | 缩短 30%–40% | 三组 31.8%、36.0%、31.8%，中位数 31.8% |
| 大项目 A 切换到项目 B | 不超过 2500 ms | 1398 ms |
| 大项目 B 切回项目 A | 不超过 2500 ms | 1488 ms |
| 普通 QuickFast 改代码 | 必须命中快速链接 | 685 ms |
| 未改代码精确命中 | 不重新编译 | 67–100 ms |
| 第三方库头文件修改 | 正确失效且不全量重编 | 约 1500 ms，只重编真实依赖对象 |
| Nano 旧引导程序上传 transport | 不超过 4 秒，失败必须回退兼容路径 | direct avrdude 约 2.45 秒；Arduino CLI 基线 7.61 秒 |
| Nano 原生软件完整上传 | 不超过 4.5 秒 | 多轮 2.90–4.10 秒；direct transport 稳定约 2.45–2.76 秒 |

性能数字是同一台开发机上的回归基线，不是对所有电脑的绝对承诺。判断是否退化时优先比较同机多次样本的中位数和最差样本。

## 原生软件多板实测

以下数据来自 Tauri 原生窗口直接调用正式编译命令，不是网页模拟或单独调用编译器。ESP32 的“迁移/准备”包含一次性淘汰无身份的旧缓存；它不能与已有有效缓存的快速路径混为一谈。

| 板卡与场景 | 迁移、强制重建或首次准备 | 原样重复 | 改逻辑后的 QuickFast |
| --- | ---: | ---: | ---: |
| ESP32-C5 + WiFi | 后台准备 144.5 s；前台落地 14.5 s | 1.24 s | 14.25 s |
| ESP32-S3 + WiFi | 旧缓存迁移 367.95 s | 1.38 s | 19.48 s |
| Arduino Nano | 强制刷新后 10.15 s | 0.64 s | 1.50 s |
| Arduino Mega | 9.54 s | 0.66 s | 1.92 s |
| Nano `cpu=atmega328old` | 13.08 s | 0.67 s | - |

官方 Arduino CLI 核心兼容烟测同时通过：Nano 8.15 s、Mega 6.93 s、ESP32-C5 116.55 s、ESP8266 24.53 s。官方 `-Os` 与 CK QuickFast `-O1/-g0` 使用不同缓存身份，不能交叉冒充命中。

## 原生软件上传实测

Arduino Nano `cpu=atmega328old`、COM5、同一空白普通固件：

| 场景 | 实测 |
| --- | ---: |
| Arduino CLI 兼容路径，仅 transport | 7.612 s |
| 直接 avrdude，仅 transport | 约 2.45 s |
| Tauri 重启后首次完整上传 | 3.333 s（准备与缓存确认 0.719 s，transport 2.599 s） |
| 后续完整上传 | 多轮 2.902–4.100 s；准备与缓存确认 0.406–1.088 s，transport 2.484–2.758 s |
| 串口监视器原本打开 | 2.901/2.970 s；关闭端口 132/137 ms，上传后恢复 35/40 ms |

最终前端会话序号保护接入后再次从原生“视图 → 打开串口监视 → 普通上传”执行：后端请求 3.850 s，界面总耗时 4.1 s，串口关闭 134 ms、恢复 39 ms，使用 direct avrdude 且无 CLI fallback。准备阶段会受当次缓存确认和日志环境影响，因此回归门槛按完整上传 4.5 秒、transport 3 秒分别判断。

AVR 直传只覆盖官方 `arduino:avr:uno`、`nano`、`mega`。命令必须从当前已安装核心的 `platform.txt`、`boards.txt`、`installed.json` 和实际 FQBN 菜单选项解析，且逐项校验 avrdude、配置文件、MCU、协议、端口、波特率和唯一应用 HEX。Leonardo、Micro 等需要 1200-baud touch 或端口重枚举的板卡，以及非 AVR 平台，继续使用 Arduino CLI 兼容路径。

## P0+ 第一阶段功能回归基线

这些功能已经接入原生 `Workspace` 或串口绘图器，但范围刻意受限。回归时既要确认正常功能，也要确认“不确定内容不会被误判或自动控制硬件”。运行轨迹第一阶段接入后，前端 TypeScript 检查、63 项服务测试和生产构建均通过。

| 功能 | 已完成的第一阶段行为 | 必须保持的限制 |
| --- | --- | --- |
| Flash/RAM 资源预算 | 从成功编译/普通上传日志读取 Flash 与 RAM 已用量、总量和比例；与同 FQBN 上一次成功结果比较；80%/90% 分级提示 | 失败构建以及断点/轨迹固件不覆盖普通工程成功基线；容量失败卡片仍需显示链接器原始区域信息 |
| 可操作错误卡片 | 对缺头文件、串口不可用、ESP 握手失败、固件过大和板卡环境变化生成确定性卡片，并连接库搜索、端口重扫、BOOT 帮助、资源面板和板卡设置 | 未匹配的 C/C++、第三方核心或工具错误保留原始日志，不生成猜测按钮；环境变化不自动清缓存 |
| 精确引脚风险图与编译前体检 | 编译/上传前分析当前精确板卡包清单中声明的全部引脚；支持别名、能力、保留资源、配置条件风险、搜索筛选和积木定位；内置规则及质量门禁通过的 v2 第三方积木 pin role 共用同一分析器；可证明的同一积木引脚重复会阻断 | Schema 不能证明发布者没有漏脚；动态表达式保持未知；跨积木复用只在明确声明独占时警告；目录外引脚、未连接输入和无效字面量只提示；无板厂或 CK 证据时不推断电气能力、保留脚或物理排针位置 |
| 运行轨迹与采样覆盖率 | 从 `Workspace` 上传独立轨迹固件，以非暂停方式标记已采样命中的积木，显示采样覆盖、最近路径、采样命中次数和采样点间时间，并支持点击定位 | 默认最多 64 个积木、每 4 个检查点采样一次、40 ms 全局发送间隔（约 25 帧/秒）、最近路径固定 32 条；所有次数均为采样命中，不得宣称精确执行次数或无干扰耗时 |
| 串口触发录制 | 对已解析的结构化数值通道支持 6 种比较符、前后时间窗、环形缓冲、立即冻结、重新布防和带上下文 CSV 导出 | 每侧窗口不超过 30 秒，单次不超过 5000 条；冻结只作用于本地捕获，不暂停开发板、不发送设备命令；时间以主机接收时刻为准 |
| 本地工程检查点与滚动恢复 | 编译、上传、恢复及主动放弃修改前保存正式检查点；普通语义编辑约 12 秒防抖写入独立有界恢复稿。一次打开工程只自动提示最新有效稿，旧稿不形成弹窗队列；暂不处理或成功覆盖后，本会话抑制同磁盘基线旧稿，重新打开后再判断。恢复当前工程前再建检查点，所选稿保留到正式保存成功 | 检查点每工程 20 个、单个 5 MiB、总量 40 MiB；恢复稿每工程最多 3 份并另有字节/全局边界；均仅在本机。会话抑制不是删除；尚无逐积木语义 diff；缺包时进入未知积木只读保护而不是删除 |

### 功能级不变式

- 引脚体检不能仅因两个不同积木使用同一引脚而阻断；共享总线、重复读取和先后复用都可能合法。
- 只有 `pin_preflight.ts` 显式登记的积木和同一积木内可证明的 distinct 规则可以成为 blocker。
- 运行轨迹必须继续使用独立轨迹固件；普通上传和断点调试固件不能因为启用过轨迹而永久带入 TRACE 运行时。
- 恢复稿旧版本只作为有界冗余，不得在关闭一个提示后自动级联弹出；同一打开工程会话的抑制键必须绑定工程和磁盘基线，不能跨工程或跨重新打开沿用。
- 覆盖当前工作区后不得立即删除唯一恢复依据；所选稿保留到正式保存成功。未知积木、检查点失败、另存取消或保存失败都不得提前清理稿件。
- 轨迹固件默认最多登记 64 个积木，每 4 个检查点采样一次，并对所有 TRACE 帧执行 40 ms 全局最小发送间隔；提高任何一项预算都必须重新做小内存板卡和串口时序回归。
- 桌面端最近路径必须保持固定 32 条，接收速率与 UI 发布必须继续受限，不能改为无界事件数组或逐帧刷新 Blockly SVG。
- “采样覆盖率”“采样命中次数”和采样点间时间不得在 UI、日志或导出中改称精确执行覆盖、精确执行次数或无干扰性能数据。
- 断点和轨迹固件包含额外运行时，其 Flash/RAM 结果不得覆盖普通工程资源基线。
- 串口触发器达到记录上限必须冻结并标记 `truncated`，不能扩容为无限数组，也不能静默覆盖触发后的数据。
- 串口触发 CSV 必须保留触发规则、实际触发值、相对触发时间、串口、波特率和输入积压丢弃数。
- 检查点必须原样保留正式工程序列化 JSON；不得改成仅保存 block XML、生成代码或可见字段的简化快照。
- 单个检查点损坏不能让同一工程的其他健康检查点全部不可见。
- 恢复当前工作区前必须成功创建 `before_restore` 保护点；该保护失败时不能继续破坏性恢复。

## 编译器约束

- Arduino CLI 首编译产生的临时 shim 源路径与原库路径必须映射到同一个逻辑缓存身份；缓存仍按 FQBN、编译参数、源码和头文件时间签名隔离。
- GCC 生成的 `.d` 文件是对象失效的事实来源。一个库头文件变化不能再让所有核心和无关库对象一起重编。
- `library.properties` 的 `depends=` 必须自动形成传递依赖闭包，支持版本约束写法；调用方不需要手工枚举 Adafruit Unified Sensor 等依赖。
- Arduino 预处理文件中的旧原型只接受 `#line` 标记过的声明，不能把 `DHT sensor(2, DHT11);` 这类全局对象构造复制成第二份声明。
- 首次编译完成后不应同步执行只服务于下一次项目切换的对象缓存复制。对象缓存在真正进入 Fast Relink 前准备。
- 预编译快照按目录结构、文件大小和内容比较；内容相同时不能因为时间戳变化整目录重写。
- 精确命中检查必须对重复的 include 目录和源文件去重，不能按每条 compile command 重复扫描同一目录。
- 核心缓存身份必须包含实际安装的核心版本、`platform.txt`、`platform.local.txt`、`boards.txt`、`programmers.txt` 和工具版本；缺少身份文件或签名不符的旧 `core.a` 不得复用。
- 板卡菜单选项必须进入实际编译和上传 FQBN，不能只用于后台预热；不同选项的产物必须分目录保存。
- 板卡设置提供两级重建：默认“重建缓存/重新编译/重新烧录”只清理当前完整 FQBN 的工程构建、元数据、预构建 Core 和依赖对象缓存，保留按源码内容寻址的全局 ccache；高级“彻底刷新”才写入一次性强制重建标记并让下一次前台编译设置 `CCACHE_RECACHE`。后台预热遇到彻底刷新标记必须让路。
- QuickFast/SharedFast 的最终 `-g0` 位于 Core response file 之后，CCDB 门禁会有界展开 response file 再判断最后有效的 `-O1/-g0/-fno-lto`；缺失、嵌套异常或合同不一致时拒绝复用。Release 保持 Core 原生旗标。
- `silent=true` 的预编译不能把自己登记为人工编译，否则会检测到自己的 pending 标记并永远跳过。
- 已加载工程的自动预热只有一个所有者：Workspace 必须使用当前生成源码和完整 FQBN 调度代码感知预热；HardwareContext 不得再并行发送 `code=null` 的配置预热。启动/板卡级默认预热只能准备 Core，不能把 canonical 草图写入或覆盖精确工程源码槽。
- 前台编译或上传成功时，只消费与本次完整 FQBN、扩展代次和完整源码字节完全一致的待执行预热；编译期间产生的新编辑、新板卡配置或新扩展代次必须保留。失败和取消不得把待执行请求当成已经满足。
- 最近板卡热集和启动预热必须保存实际使用的完整 FQBN。并发锁仍可按基础板型串行化，但 `FlashSize`、分区、PSRAM、USB 等选项不能在预热目标、历史统计或 Core 身份中丢失。
- “ready install 新工程”性能口径只清项目 build/meta 与依赖对象暂存，允许复用通过既有身份门禁的精确目标 Core；证据必须同时证明 `prebuilt_core_validated=true`、Core 实际注入、`fastRelink=true`、`fullBuild=false`、`exactMatch=false`，任一缺失都失败。它不能代替无 Core 的 `firstProjectCold` 或用户主动 `hardRefreshCold`。
- ready-install 的首次 CCDB 合成只允许用于 `QuickFast`、精确身份 Core 已实际注入、项目 meta/backup/CCDB 全部不存在且没有 `extra_libs` 的场景；此时当前 include 被视为初始 added 集合，仍须经过核心库解析、CCDB profile contract、真实 GCC、链接、资源统计和上传产物门禁。任一证据不完整、存在外部库或合成失败都回到 Arduino CLI，不得扩大快速路径。
- Fast Relink 性能证据使用机器可解析日志 `fast_relink_ccdb_prepare`、`fast_relink_dependency_cache_staging` 和 `fast_relink_dependency_objects`，分别记录 CCDB 来源/耗时、暂存对象数，以及依赖对象恢复/编译数、ccache 可用性与可取得的命中增量。ReadyInstallCold 必须明确命中 `method=synthetic status=success`，并拒绝同周期任何 `method=arduino-cli-only-compilation-database`；Sibling、失败或未创建不能冒充无 CLI 的首次快速编译。ccache 计数器是 `global_best_effort`，缺失或被并发重置时必须写 `ccache_metrics_available=false`，不能把全局增量冒充当前工程的精确命中率。
- 前台上传成功后不得再启动同板卡冗余预热；本次上传编译已经填充缓存，重复预热会抢占下一次编译锁。
- C6 发布回归中的普通上传必须明确报告上传专用的 `Upload compile lock wait`，普通编译锁行不能冒充；缺少字段不能解释成 0。原始 evidence、upload cycle 与顶层汇总必须三方一致，warmup 标志必须显式为 `false` 且 failures 为显式空数组；等待超过 5 秒、原始日志出现等待匹配预热或复用兼容后台预热均使证据失败。
- Exact Match 的返回值和界面日志必须同时携带缓存元数据中同一完整 FQBN、构建签名与源码命中的 Flash/RAM `used/maximum` 摘要及结构化 `warning_count`。普通固件成功上传创建“上一个可用版本”时，四项资源值、结构化警告数任一缺失或越界都必须拒绝保存该基线；一键 C6 回归还必须拒绝早于本次上传开始时间的旧基线，不能把同 FQBN 的历史成功版本冒充本轮证据。
- AVR 直传配方任何一步不适用或校验失败时必须回退 Arduino CLI；只有 direct 进程成功退出时才能立即返回，不能在已经成功烧录后重复上传。
- 串口监视器关闭必须等待后端同步释放端口；恢复使用带会话序号的重试，旧编译/上传会话不得重新抢占新会话端口。

## 第三方包门禁约束

本地 JSON、本地 ZIP、GitHub/Gitee ZIP、Gitee raw 下载都必须经过同一质量报告。任何入口都不能直接写正式安装目录。

安装顺序固定为：

1. 下载或解压到 staging。
2. 校验安全相对路径、文件数、单文件大小、总解压大小、大小写重复路径和符号链接。
3. 校验 manifest、SemVer、包 ID、入口文件、积木目录、工具箱、生成器、板卡核心契约和内置库。
4. 写入 `.ck-quality-report.json` 和来源标记。
5. 原子替换正式目录；失败时恢复旧版本。

板卡包和 `board-package-libraries/<board_id>` 必须作为一个事务提交。新板卡不带内置库时，要删除旧板卡遗留的专属库目录。

## 回归命令

```powershell
cargo test -p ck_core --all-targets -- --nocapture
cargo test -p appsdesktop --lib -- --nocapture
cargo run -p ck_core --bin verify_ck_quickfast
cargo run -p ck_core --bin verify_big_project_switch
cargo run -p ck_core --bin verify_first_compile_speed
cargo run -p ck_core --bin test_incremental
cargo run -p ck_core --bin test_lib_cache_invalidation
& .\scripts\Test-CoreCompatibility.ps1
node --test .\scripts\Validate-BoardPackage.test.mjs
node --test .\scripts\Validate-PackageSchemas.test.mjs
node .\scripts\Validate-BoardPackage.mjs .\examples\importable-packages\ck_example_c6_board --core-version 3.3.6
& .\examples\importable-packages\Build-Examples.ps1
```

前端和桌面后端还要执行：

```powershell
Set-Location .\apps\desktop
node --test .\src\services\compile_resources.test.mjs .\src\services\compile_issue_cards.test.mjs .\src\services\pin_preflight.test.mjs .\src\services\block_trace.test.mjs .\src\services\serial_trigger_recorder.test.mjs
npm run build
cargo check -p appsdesktop
cargo test -p appsdesktop project_checkpoints --lib -- --nocapture
npm run tauri dev
```

原生窗口启动后，另开一个 PowerShell 执行搜索、来源标签和横向溢出冒烟检查：

```powershell
& .\scripts\Test-NativeEditor.ps1
```

## 当前未完成项

- 官方发布服务的多核心编译矩阵、签名、撤回和兼容等级尚未实现。
- 内置积木需要继续按受支持核心版本逐包运行生成代码编译矩阵。
- 性能基线目前覆盖 Nano 的深度最高；ESP32-S3 无有效快照时的一次性核心构建仍重，需要建立 C3/C5/S3 的多轮 P50/P95 冷启动预算和可发布预构建核心方案。
- P1：旧版完整 warmup build 快照目前仍会写入磁盘，但其恢复路径已禁用；在形成可重定位的构建身份前，不得重新启用包含绝对路径的 payload。1.0 稳定后需要补快照格式迁移、保留上限和孤儿目录清理，避免长期使用造成磁盘增长。
- 原生 USB 板卡若上传后更换 COM 号，目前仍依赖 Arduino CLI 与端口重新扫描；在没有稳定设备身份匹配前，不把它们纳入 AVR 直传。
- 精确引脚风险图已经覆盖 v2 第三方积木 pin role、板卡包别名/能力/保留资源/条件风险和可声明的共享规则；仍不解析动态引脚表达式，也不会在缺少板厂或 CK 证据时推断 USB/BOOT/Flash 等电气事实。发布者单方面声明的 blocker 会降为警告，内置板卡仍需随具体 Core 版本持续扩充证据与误报基线。
- 串口触发录制尚无曲线事件注释、多条件/滞回、设备侧时间戳对齐或自动设备控制；冻结录制继续只表示本地数据窗口冻结。
- 崩溃恢复闭环已补齐普通编辑防抖恢复稿、最新候选、完整状态哈希、原子落盘、覆盖前检查点和会话级重复提示抑制；旧稿不是自动队列，所选稿保留到正式保存。仍未实现逐积木语义 diff。候选判定比较恢复稿与磁盘工程，不使用全局 `clean_shutdown` 标记。
- 运行轨迹第一阶段尚不支持按用户所选流程插桩、精确执行次数、设备侧聚合统计或与读取主 `Serial` 的用户程序共存；当前结果只能解释为受限采样命中。
- 真机断言仍未实现，必须先通过无副作用求值与安全失败策略门禁。“上一个可用版本”已接入工程/依赖/配置/多段固件恢复，并在恢复固件前重新执行芯片、Flash、FQBN、分区、地址和哈希校验。
- Blockly 12 的兼容加载路径仍会从依赖内部触发 `Workspace.getAllVariables()` 弃用警告；应用代码已使用 VariableMap API，升级 Blockly 13 时必须专项回归旧工程 XML/JSON。
