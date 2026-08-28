# FLFE 通用加速路线：兼容、预热与真实增量分层

状态：工程路线建议（不代表已交付或已取得性能资格）  
适用范围：Arduino CLI 可构建的官方及第三方 Core；非 Arduino 构建系统需要独立适配器与独立基准。

## 1. 不可回避的冷编译边界

对于任意此前未知、绝对空缓存的新 Core，如果 CK 必须完整保留该 Core 的原生
recipes、hooks、编译参数、链接规则和产物规则，那么 CK 的保守路径本质上仍要调用同一个
Arduino CLI 和同一套工具链，并额外执行身份、依赖与产物门禁。因此不能数学上承诺：

> 任意板卡、任意 Core、任意机器的绝对冷编译都稳定快于原生 Arduino CLI。

这个限制不能靠把工作移到计时器之前、把 Exact 产物复用称为重新编译、跳过未知 Core hook，
或更换优化等级来掩盖。合理且可验证的 FLFE 目标应拆成三项：

1. **Honest Cold**：未知 Core 使用原生 Release 路径，冷编译不发生显著回退。
2. **Selected/Prewarmed**：用户选板并空闲后，以原生 Release 做受控预证和预热，使首次点击更快；
   证据必须明确标记为 prewarmed，不能冒充 cold。
3. **Hot Edit**：已有可信原生基线后，对真实源码编辑使用经 A/B 认证的增量引擎，并在任何不确定时
   回退 Arduino CLI。

树莓派 SBC 的 Linux/CMake/cross-compile 工程不属于 Arduino CLI 比较对象；Raspberry Pi Pico、
RP2040/RP2350 的 Arduino Core 才进入本路线。其他构建系统应建立自己的原生基线和资格模型。

## 2. 产品能力分层

| 层级 | 允许的行为 | 用户口径 |
| --- | --- | --- |
| FLFE Compatible | 原生 Release、完整身份和门禁、Authenticated Exact | 兼容并安全复用，不宣称冷编译加速 |
| FLFE Prewarmed | 当前完整 FQBN 的原生 Release 身份预证和空闲预热 | 选板后的首次点击更快，明确标注预热 |
| FLFE Accelerated | 通过目标、操作和 workload 资格的 NativeRelink/专用 Fast 路径 | 对已覆盖的真实编辑场景宣称加速 |

未知 Core、Core 更新、完整 FQBN 菜单变化、CLI/工具链或构建合同变化都应先回到
FLFE Compatible。仅在重新获得当前身份下的证据后，才恢复更高层级；合法未知版本不应仅因
“未列入矩阵”而被阻止编译。

## 3. 近期可落地项

### 3.1 修正基准：真实代码编辑已进入普通 Fast 门禁

`scripts/Run-CKForgeNativeAB.cjs` 的通用 QuickFast/SharedFast 资格已经从相同源码的
fresh/repeat 改为固定 `simple → complex → medium → simple-return`。每阶段禁用 Exact，
使用同一机器、CLI、Core、完整 FQBN、jobs 和源码序列与原生 CLI 配对，并检查 Fast route、
recipe capability、资源、产物、构建路径和未执行上传。四阶段必须全部通过独立 v3 门禁；
`passed` 仍只表示证据完整，不会自行签发证书。

带真实第三方库的 include 增删和库实现编辑仍属于下一层 workload 资格，不得由这份无库的
portable-edit 结果自动继承。

### 3.2 选板身份预证

在 `apps/desktop/src-tauri/src/lib.rs` 增加只读 `preproof_compile_target`：

- 以完整 FQBN（包括全部菜单选项）为键合并并发；
- 持有 managed-package 读取门禁；
- 后台调用现有 `derive_toolchain_identity` 和 Core 版本解析；
- 前端统一选板出口在 FQBN 稳定 150～300 ms 后调用；
- 快速切板时取消旧任务；失败不改变正式编译的 fail-closed 行为。

这只把首次强身份扫描移出编译按钮路径，不提前编译代码，也不授予 Fast 资格。

### 3.3 身份解析租约

当前 `core_cache_signature`、`expected_core_cache_identity` 和
`fast_profile_ccache_namespace_for_target` 会在一次请求内重复解析同一工具链。应增加接收已解析
toolchain key 的内部变体：

1. 编译开始时取得强身份；
2. 构建期间复用该不可变请求值；
3. 产物完成后再次解析并要求 key 相同；
4. 仅在末端复验通过后写入 BuildMeta、Core identity 和 Exact commit marker。

这样把 N 次扫描压缩为“开头一次、末端一次”，同时保留对构建期间 Core/工具链变化的检测。

### 3.4 Exact 前延迟运行时预检

`compile_sketch_string_with_policy` 当前在 Exact 判断前调用
`direct_engine::preflight_runtime_tools`。应改成 lazy，只在确实要启动 Arduino CLI 或直接增量引擎时
执行。Authenticated Exact 已由工具链、FQBN、依赖和产物证据绑定，不需要为了不启动的编译器
再次解析 boards/platform/tools。上传前仍必须保留上传工具与产物强门禁。

### 3.5 后处理移出响应关键路径

- ESP32 linker-map 分类属于资源展示，不是编译/上传安全门禁。改为后端注册 build token 后懒加载，
  不接受前端任意本地路径。
- builder 已产生的强哈希产物 manifest 应由桌面端直接用于 compile-time seal，避免同一请求重复哈希。
- 上传前 `validate_upload_artifacts_for_transport` 仍要重新全量哈希，不能因 compile-time seal 而跳过。

### 3.6 当前选板的原生 Release 预热

不要放宽现有 QuickFast prewarm 资格。增加独立 `NativeReleaseActiveWarmup`：

- 仅当前完整 FQBN，最多一个任务；
- 选板后延迟 1～2 秒且仅在空闲、电源和磁盘条件允许时启动；
- 用户编译到来时立即取消或安全让路；
- 使用未改写的 Core recipes/hooks；
- 预热结果不能直接授予 Fast，也不能记录为 cold 性能证据。

## 4. PortableFast 的重新定位

PortableFast 的历史慢速数据受到旧 in-tree build 路径回退影响，out-of-tree 修复后值得重测，但只能
作为实验候选：

- C6、STM32、AVR 至少各测 fresh、same-source、hot-edit；
- 分离 `ccache-only` 与 `ccache + prebuild restore guard`；
- 清理候选 namespace，保持原生和 CK 的 CLI/FQBN/jobs 一致；
- 记录 ccache hit/miss 与 wrapper 固定开销；
- 结果先进入实验报告，不写入正常 Forge capability。

PortableFast 通过覆盖 `compiler.path` 接入 ccache，并追加可选 prebuild restore hook。它不能天然适配
Clang、Python 驱动、shell-heavy、自定义 response-file 或非 GCC recipe。未通过当前工具链和操作的
A/B 资格前，`force-platform` 必须继续选择 Release。

## 5. NativeRelink：真实代码变更的主路线

不要把 QuickFast 的 `-O1`、跳 hook 或专用打包行为直接推广到新 Core。应将当前 profile 拆成正交
策略：

- `CompilerContract`：Native / FastO1；
- `IncrementalEngine`：ArduinoCli / NativeRelink；
- `ArtifactGoal`：CompileOnly / UploadReady。

NativeRelink 在原生 Release 成功基线上复用现有 CCDB、依赖证明、对象和链接门禁，但必须满足：

1. 工具链、完整 FQBN、Core、CLI 和构建合同未变；
2. 原始源码确实变化，不能计入 Exact；
3. include/preprocessor 指纹和依赖图满足当前资格类别；
4. CCDB 中每个源码、编译命令和输出对象都可证明且唯一；
5. 使用原生编译参数重编 sketch 或确定变化单元；
6. 使用原生 combine/size/必要 objcopy 规则；
7. 未知 hook、shell recipe、缺失对象、地址或产物异常立即回 Arduino CLI；
8. 末端身份与产物证明完成后才提交缓存元数据。

资格应新增独立的 `HotEdit + NativeRelink` 能力，不能复用 QuickFast 的证书。

## 6. 资格 Schema v2

当前本地资格将证书绑定到精确 `sketchSha256`，因此一份证书只能解锁基准源码，用户编辑后即失效；
直接删除该字段又会把单一样本结果错误推广到任意程序。Schema v2 应改为：

- `workloadSuiteId` 与 `sampleSetSha256`：绑定标准、不可变的源码序列；
- `sourceCapabilityClass`：例如 `same-include-edit`、`header-delta`、`library-edit`；
- `operation`：compile-only、upload-ready 分开；
- `compilerContract`、`incrementalEngine`、`artifactGoal`：对应实际候选能力；
- 完整 FQBN、Core 版本、CLI、工具链、主机、引擎合同继续严格绑定；
- fresh/edit 各自的 P50、P95、CV、样本数和绝对/相对收益；
- 资源、依赖闭包、产物等价和失败回退证据；
- 对未知 hook/recipe 的明确不支持范围。

运行时仍必须执行源码特征和依赖门禁。证书只授权其声明的能力类别，不能成为跳过安全检查的通票。

## 7. 推荐抽样矩阵

抽样应覆盖工具链和 recipe 风格，而不是只堆同一系列板名：

- AVR8：Uno、Mega、Leonardo；
- ESP32：Xtensa 与 RISC-V，普通和大 Flash/PSRAM 菜单；
- ESP8266；
- STM32：F/G/H 中至少两个不同系列；
- RP2040/RP2350：官方 mbed 与常用 Arduino-Pico Core 分开；
- SAMD21/SAMD51；
- Renesas UNO R4；
- nRF52 或其他 ARM GCC 第三方 Core；
- 至少一个声明式导入的第三方板卡包。

每个目标至少保留 cold、prewarmed、same-source Exact、no-change/Exact-disabled、hot-edit、header-delta、
library-edit、upload-ready 八种证据。Core 更新后先回原生 Release，自动或人工重新资格。

## 8. 性能与磁盘纪律

- 每轮矩阵前后记录 C 盘可用空间；
- 临时 native/A-B 目录必须使用带 run id 的独立目录并在证据完成后清理；
- 不删除当前 production EXE、已安装 Core、用户库或仍被基线引用的构建目录；
- 预热最多保留当前目标和一个最近目标；
- ccache、Core、build、metadata 分类别计量和限额；
- 低磁盘时停止预热、优先清理已过期临时证据和 LRU 构建缓存。

## 9. 发布口径

只有满足对应证据的层级才能展示对应文案：

- Exact：写“复用已验证产物”，不写“重新编译只需 X 秒”；
- Prewarmed：写“已预热”，不写“冷编译加速”；
- NativeRelink/QuickFast：仅在当前身份与 workload capability 有效时写“FLFE 加速”；
- 未知或更新 Core：写“原生兼容路径”，不能写“不支持”，也不能未经验证写“Fast”。

FLFE 的长期价值应是：覆盖面持续扩大，同时任何新 Core 都先安全可用、任何加速都可解释、可撤销、
可复测。
