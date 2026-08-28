# FLFE STM32 OrderedImmutableObjects Phase 1

状态：**隔离引擎与真实直链证据完成，尚未接入产品、Forge 或上传。**

本阶段只覆盖完整身份：

- FQBN：`STMicroelectronics:stm32:Nucleo_64:pnum=NUCLEO_F401RE`
- Core：`STMicroelectronics:stm32@2.12.0`
- 工具链：`xpack-arm-none-eabi-gcc@14.2.1-1.1`
- operation：`CompileOnly`
- profile：`Release`
- 依赖：仅 Core 自带 `SrcWrapper`，不允许第三方库

这不是“STM32 全系列已加速”的声明。其他板型、菜单组合、Core 版本和工具链必须独立捕获构建图、验证正确性并通过性能资格。

## 1. 为什么不能套 AVR/SAMD 模型

本机 Arduino CLI 真实基线包含 212 条 CCDB：

| 分区 | 数量 | 链接方式 |
|---|---:|---|
| sketch | 2 | `.ino.cpp.o` 与 `requiredLibraries.cpp.o` 直接链接 |
| Core 内置 `SrcWrapper` | 180 | 直接链接 |
| Core/variant/system | 30 | 其中 6 个直接链接，24 个进入 `core.a` |

最终链接顺序是：

1. 新的 sketch 对象；
2. `requiredLibraries.cpp.o`；
3. 180 个 Core 内置库对象；
4. 6 个 variant/system 对象；
5. `core.a`（24 个成员）；
6. C/C++ 运行库。

所以 STM32 能力类定义为：

`OrderedImmutableObjects + CoreArchive`

引擎必须保存 188 个非 archive 对象的原始顺序；热编辑只允许第一个 sketch 对象变化，其余 187 个对象必须保持内容身份不变。

## 2. 动态捕获，不写死绝对命令

隔离模块位于：

`crates/ck_core/src/builder/demo/stm32_native_relink.rs`

捕获时验证：

- CCDB 必须恰好形成 `2 + 180 + 30` 的已认证构建图；
- 每个 CCDB 源文件只能位于 build root 或当前 Core root；
- 每个输出必须位于 build root；
- 链接命令中的 188 个对象必须是 CCDB 输出的唯一有序子集；
- CCDB 补集必须是 24 个 `core/` 对象，且其文件名多重集合与 `core.a` 成员一致；
- sketch 编译命令必须与 CCDB 的参数向量完全一致；
- `sketch/build.opt` 作为 response file 单独封印；
- default linker script 与 system linker script 都必须在当前 Core root 内，并记录大小与 SHA-256；
- 编译、链接、objcopy、size 的实际可执行文件必须位于当前工具链 root；Windows CCDB 省略 `.exe` 时只允许解析同路径的 `.exe`；
- BIN、HEX、ELF、MAP、sketch object 和 depfile 都形成可复算封印。

这意味着 Core 或工具链升级不会误继承本轮图；图形改变会 fail-closed，先回到 Arduino CLI 原生 Release。

## 3. 事务与安全边界

进入任何工具调用前先检查：

- intent 必须是 `CompileOnly`；
- profile 必须是 `release`；
- 第三方库列表必须为空；
- access mode 只能是 `qualification-probe` 或 `certified`；
- authorization key、完整 FQBN、Core、CLI、工具链和 property contract 必须匹配；
- 受信翻译证明必须绑定当前源码，只接受 `Arduino.h`，并拒绝 `__FILE__`、`__BASE_FILE__` 和用户 `#line`。

`UploadReady`、`Background`、`LockedReplay` 会在读取构建状态和执行工具前拒绝；隔离测试确认工具调用数为 0。

执行采用可回滚事务：

1. 复算 CCDB、build options、build.opt、187 个冻结对象、24 个 archive 输入、`core.a`、依赖头文件、工具和链接脚本；
2. 备份 `.ino.cpp`、object、depfile、MAP、ELF、BIN、HEX；
3. 创建结构化 dirty marker；
4. 依次执行 sketch compile、link、objcopy BIN、objcopy HEX、size；
5. 重新解析 depfile，依赖集合必须与基线一致；GCC 对同一 header 的重复条目会去重，但不允许新增依赖；
6. 再次复算所有冻结输入，并封印新 BIN/HEX/ELF；
7. 原子提交下一份 manifest，再清理备份和 dirty marker。

工具失败、依赖漂移或最终封印失败会恢复全部 7 个可变文件。恢复本身失败时保留 dirty 状态，后续只能做一次干净 Arduino CLI 重建，不能递归尝试直链。

编译目录出现 `.ck-upload-artifacts.json` 或 `*.with_bootloader.*` 会拒绝，CompileOnly 不能悄悄获得上传产物语义。

## 4. 隔离回归

隔离 harness 的模块测试为 13/13：

- 188/187/24 图形与顺序捕获；
- 三种非 CompileOnly intent 零工具执行；
- profile、第三方库和 access key 零工具拒绝；
- 五阶段成功事务和 manifest 提交；
- 冻结对象篡改在工具前拒绝；
- 链接失败完整回滚；
- 新增依赖拒绝并回滚；
- upload artifact 拒绝；
- retained dirty state 拒绝；
- 未知 manifest 字段拒绝；
- Core/toolchain root 逃逸拒绝；
- 链接对象数量变化拒绝。

真实 Core 隔离 harness 也成功完成复杂代码事务：

- 引擎总墙钟：`4.188s`
- sketch compile：`1.389s`
- link：`0.315s`
- objcopy BIN/HEX：`0.026s / 0.020s`
- size：`0.024s`
- 同时段原生 CLI 热编辑：`19.262s`
- 端到端改善：`78.255%`

引擎其余时间是前后两次身份哈希、事务备份与 manifest 提交；这部分不能为了数字好看而删除。

真实引擎生成的三产物与原生 CLI 逐字节一致：

| 产物 | 字节 | SHA-256 |
|---|---:|---|
| BIN | 8,660 | `e845f94326bb089559b9418c986151b1f4940ae6a701a5c73e8b37dcf54e91a2` |
| HEX | 24,443 | `97077d9a1e689cd7194edda2b8214c07bf06ef467545d78cb2c91e149bc2cf6f` |
| ELF | 41,480 | `5cb98ca9b06e09b0517ee3467ad48a4ac4cd66619549bff2afe27ed1ee2a0a8a` |

另有 3 个编辑阶段 × 3 轮的交替配对下界：

| 阶段 | 原生 CLI 中位数 | 直接命令中位数 | 改善 |
|---|---:|---:|---:|
| complex | 26.655s | 2.472s | 90.726% |
| medium | 25.743s | 2.743s | 89.346% |
| simple-return | 21.669s | 2.567s | 88.154% |

9/9 轮的 BIN、HEX、ELF 都逐字节一致，冻结对象集合的 SHA-256 没有变化。测试期间机器存在并行 Rust 构建负载，因此不能把这些数字冒充干净机正式资格；交替顺序与同一时段配对降低了负载偏差。

证据：

- `artifacts/benchmarks/flfe-stm32-f401re-native-relink-lower-bound-2026-07-18T10-38-57-390Z.json`
- `artifacts/benchmarks/flfe-stm32-f401re-native-relink-engine-isolated-20260718.json`

## 5. 接入前剩余工作

1. 由 `demo.rs` 适配现有可信 C++ 翻译分析器、取消感知进程管理器与 compile lock；
2. Forge runner 新增 STM32 adapter，身份键绑定完整 FQBN、Core 内容、工具链、CLI、主机和本引擎 contract；
3. production EXE 运行 `simple → complex → medium → simple-return`，每个热编辑至少 5 轮；
4. 要求 median 至少快 10%、绝对收益至少 500ms、p95 不回退，三产物与资源统计等价；
5. 只有本地证书写入成功后，正常用户路由才允许显示 `native-relink-compile-only`；
6. 任何其他 STM32 板型或 Core 版本都必须重新捕获与认证，不能继承 F401RE 2.12.0 的资格。

在上述接入完成前，本模块只是经过真实工具链验证的下一适配器，不改变当前产品行为。
