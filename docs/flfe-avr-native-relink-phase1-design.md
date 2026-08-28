# FLFE AVR NativeRelinkCompileOnly Phase 1 设计

> **历史设计快照（superseded，2026-07-19）：**下方“可实施设计／尚未启用”等状态保留为实施前记录，已被正式资格结果取代，不应再用于判断当前产品状态。最终 production EXE `fe1450c5a719adcf6851fd41e7f8315c9961a49d98d6c353bcfafea27549aa0f`（43,314,176 bytes）已对精确 `arduino:avr:uno` / AVR Core 1.8.6 完成 5 轮 A/B 并取得 NativeRelink v4 本机热编辑资格；complex / medium / simple-return 分别比原生快 37.15% / 50.12% / 43.47%，冷 `simple` 慢 19.39%，所以首编仍未获加速资格。普通无 qualification token 运行已验证 `authorization=certified` 并进入 `native-relink-compile-only`。证书精确绑定主机、EXE、CLI、Core、工具链、完整 FQBN、adapter/engine 和证据哈希，不能外推到 Nano/Mega、其他 AVR Core、上传或其他操作。权威状态见 [正式报告](../artifacts/benchmarks/flfe-avr-native-relink-formal-20260719-exefe1450c5.json) 与 [性能资格门禁](ck-forge-performance-no-regression-gate.md)。
>
> 以下正文原样保留当时设计假设、补丁拆分与目标值；其中的未来时态和旧性能估计属于历史，不覆盖上述正式结果。

> 状态：可实施设计，不代表当前产品已经启用。  
> 目标：在保留 Arduino AVR Core 原生 Release 编译语义的前提下，让同一完整 FQBN、同一依赖闭包下的源码编辑绕过 Arduino CLI 编排，只执行必须的 sketch 编译、LTO 链接、objcopy 和 size。  
> 非目标：首次空缓存编译、上传、任意第三方 AVR Core、含库链接单元的工程、跨 Core/FQBN 复用。

## 1. 为什么先做 AVR

当前 `arduino:avr:uno` 的 `Release` 构建目录已经具备直接增量所需的主要原生证据：

- `compile_commands.json` 存在；本机样本有 26 条编译记录；
- sketch 的 CCDB 命令直接使用当前 Core 的 `avr-g++`，保留 `-Os -flto`；
- Core 对象已经由 Arduino CLI 封装为 `core/core.a`；
- CCDB 对象旁有 GCC depfile；
- `recipe.c.combine.pattern` 保留 `-flto -fuse-linker-plugin`；
- `recipe.objcopy.eep.pattern`、`recipe.objcopy.hex.pattern` 和 `recipe.size.pattern` 都是可直接执行的普通命令。

因此 Phase 1 不改变优化等级、不注入 ccache、不跳过 LTO，也不重写 Core 的编译参数。它只省去 Arduino CLI 对板卡、库、prebuild 和增量状态的重复编排。

现有 AVR Release CCDB **可以复用，但不能直接盲用**：

- CCDB 的 `output` 字段可能为空，需要从 `-o` 提取对象路径；
- CCDB 不描述最终链接对象顺序、objcopy、size 和 Arduino CLI 额外生成的 `with_bootloader` 文件；
- 当前 `validate_ccdb_profile_contract` 对 Release 只返回“无需 fast contract”，没有验证原生命令身份；
- 仅有 CCDB 不能证明 Core、头文件、响应文件、链接 recipe 或工具二进制仍然与基线一致。

这些缺口必须由独立的 `NativeRelinkManifest` 和每次执行前的强门禁补齐。

## 2. Phase 1 的精确边界

只有同时满足下列条件才尝试 `NativeRelinkCompileOnly`：

1. 调用意图明确为 `CompileOnly`，不是上传、后台暖机或锁定依赖恢复；
2. `profile == Release`、依赖策略为 `Managed`；
3. canonical FQBN 以 `arduino:avr:` 开头；
4. 同一完整 FQBN 已经由 Arduino CLI 成功完成过一次原生 Release；
5. CLI、Core、工具链、完整 FQBN、build signature、build options 与 Release property contract 全部匹配基线；
6. include 集合与预处理指令指纹不变，且仅含平台 Core 可提供的 `Arduino.h`；
7. CCDB 中除 Core 单元外只有一个 sketch 单元；出现任何 library/non-Core 编译单元就回退；
8. `core.a`、CCDB、响应文件、depfile、依赖内容和 recipe 证据完整；
9. 源码满足 `direct-cpp-no-auto-prototypes-v1` 的受限翻译合同；
10. 构建目录没有未清理的 dirty marker。

Phase 1 不通过板型白名单猜测兼容性。`arduino:avr:*` 只是架构上限，最终仍按当前安装 Core 的实际能力和证据逐目标判断。缺少 CCDB、recipe、depfile 或安全命令时静默使用原生 Arduino CLI。

## 3. 调用意图必须显式传递

`CompileProfile::Release` 同时被普通编译和上传 fallback 使用，单靠 profile 无法安全区分操作。应新增：

```rust
pub enum CompileIntent {
    CompileOnly,
    UploadReady,
    Background,
    LockedReplay,
}
```

为了不改变已有调用者的默认行为，推荐先增加带 intent 的新入口；旧入口内部使用 `CompileIntent::UploadReady` 或 `Background` 这类不授权 NativeRelink 的保守默认值。Desktop 普通编译入口显式传 `CompileOnly`；上传入口显式传 `UploadReady`。

没有 intent 证据时绝不运行 NativeRelink。

## 4. 独立 NativeRelinkManifest

不能直接依赖 `BuildMeta`：公平资格测试会使用 `Exact Deny`，当前 Release/Deny 会删除并且不重新提交 `BuildMeta`。NativeRelink 必须有独立提交标记，例如：

`%TEMP%/CK_Builds/metadata/native_relink_<fqbn-safe>_rel.v1.json`

建议字段如下：

```json
{
  "schemaVersion": 1,
  "engineContract": "ck-native-relink-avr-release-compile-only-v1",
  "capabilityClass": "avr-release-core-archive-plus-single-sketch",
  "canonicalFqbn": "arduino:avr:uno",
  "profile": "release",
  "buildSignature": "...",
  "cliVersion": "...",
  "toolchainKey": "...",
  "toolchainIdentityGeneration": 0,
  "projectName": "sketch_..._rel.ino",
  "canonicalProjectDir": "...",
  "canonicalBuildDir": "...",
  "buildOptionsSha256": "...",
  "propertyContractSha256": "...",
  "recipeContract": {
    "combineSha256": "...",
    "objcopyEepSha256": "...",
    "objcopyHexSha256": "...",
    "sizeSha256": "...",
    "archiveFile": "core/core.a"
  },
  "ccdb": {
    "schema": "release-ccdb-v1",
    "size": 0,
    "sha256": "...",
    "entryCount": 0,
    "commandGraphSha256": "...",
    "sketchSourceRelativePath": "sketch/name.ino.cpp",
    "sketchObjectRelativePath": "sketch/name.ino.cpp.o",
    "sketchCommandSha256": "...",
    "sketchDepfileSha256": "...",
    "nonCoreNonSketchEntryCount": 0
  },
  "coreArchive": {
    "relativePath": "core/core.a",
    "size": 0,
    "sha256": "..."
  },
  "dependencyContentSignature": "...",
  "libraryTreeSignature": 0,
  "includeAnalysis": {
    "headers": ["arduino.h"],
    "preprocessorFingerprint": "...",
    "synthesisSafe": true
  },
  "translationContract": "direct-cpp-no-auto-prototypes-v1",
  "lastSource": {
    "rawSha256": "...",
    "normalizedSha256": "...",
    "backupRelativePath": "native_relink_backup_..._rel.ino"
  },
  "sketchObject": {
    "relativePath": "sketch/name.ino.cpp.o",
    "size": 0,
    "sha256": "...",
    "depfileSha256": "..."
  },
  "outputs": {
    "artifactManifest": {},
    "eep": { "relativePath": "name.eep", "size": 0, "sha256": "..." },
    "sizeSummary": []
  }
}
```

说明：

- `toolchainKey` 必须覆盖当前 Core 的 compiler、linker、objcopy、size、platform/boards 和 bootloader 内容身份；
- `propertyContractSha256` 应对当前本地 resolver 重新展开的必要 Release 属性做排序哈希，不能相信清单中自报的命令；
- `commandGraphSha256` 使用展开 response file 后的命令身份；response file 的规范路径、长度和 SHA-256 都进入身份；
- manifest 自身不是可信输入。每次消费前都要从当前文件和 resolver 重算关键字段；
- manifest 用临时文件 + rename 最后提交，源码备份先写，manifest 最后写。

## 5. 源码编辑门禁

仅“include 名字没变”不够。Phase 1 使用两个并行门禁。

### 5.1 依赖图门禁

- 上次与当前 `RelinkIncludeAnalysis.headers` 完全一致；
- `preprocessor_fingerprint` 完全一致；
- `synthesis_safe == true`；
- 只允许字面量 `#include <Arduino.h>`；
- 不允许新增/删除/移动条件编译、宏 include、续行 directive、digraph directive。

### 5.2 直接 C++ 翻译门禁

不要在 Phase 1 依赖 `fast_update_ino_cpp` 的启发式原型提取。新增严格 lexer，合同为 `direct-cpp-no-auto-prototypes-v1`：

- 正确识别注释、字符串、字符字面量与 brace depth；解析不确定即拒绝；
- 拒绝 template、namespace、class method、operator、lambda、raw string、宏生成函数等复杂结构；
- 允许纯数据 `struct`、全局变量和普通顶层自由函数；
- 每个用户自由函数名唯一，不允许 overload；
- 对用户函数的每个调用，定义必须已经出现在调用之前，递归调用除外；
- `setup`、`loop` 由 `Arduino.h` 声明，不受“先定义”限制；
- 生成的 `.ino.cpp` 只做：`#include <Arduino.h>`、指向 canonical `.ino` 的 `#line`、随后原样源码；不自动发明 prototype。

这样 Arduino 自动 prototype 不会参与名称查找或 overload 选择；如果受限源码仍不能由 C++ 编译器接受，直接编译失败并回退 CLI。复杂 Arduino 草图后续可通过“直接调用当前 Core 的 ctags/prototype 工具并验证输出”的 Phase 2 扩展，不能在 Phase 1 放宽猜测。

本项目 `portable-edit` 的 simple、complex、medium、simple-return 都符合该受限合同：帮助函数先定义后调用、无 overload，因而可以覆盖第一轮资格 A/B。

## 6. 原生编译、LTO、链接、objcopy 与 size

### 6.1 sketch 编译

从已认证的 Release CCDB 取唯一 sketch entry：

- 不改 compiler path；
- 不改 `-Os`、`-g`、`-flto`、MCU、defines、includes 或 response file；
- 不注入 ccache 环境；
- 只把 `-o` 改为本次事务目录下的临时对象；源文件仍是构建目录中的当前 `.ino.cpp`；
- 命令 cwd 保持 CCDB 的原始 `directory`。

编译成功后要求临时 `.o` 和 `.d` 均为普通非 reparse 文件，且位于事务目录内；depfile 必须能解析到非空、存在且仍受 sysroot/build 根约束的依赖集合。

### 6.2 LTO 链接

Phase 1 只允许一个非 Core 对象，即本次临时 sketch 对象。Core 仍使用原生 CLI 生成且 SHA-256 匹配的 `core.a`。

从当前本地 Release property resolver 获取 `recipe.c.combine.pattern`，并严格要求：

- 无未展开 `{...}`；
- 无 shell meta；
- compiler/tool 路径由当前工具链身份覆盖；
- `{object_files}` 只替换为临时 sketch 对象；
- `{archive_file}` / `{archive_file_path}` 只替换为已认证的 `core.a`；
- recipe 的有效 LTO 状态与基线完全一致。官方 AVR 1.8.6 的 sketch 是 `-flto`，链接必须仍含 `-flto -fuse-linker-plugin`；
- 输出 ELF 改到事务目录，不能直接覆盖上一个成功 ELF。

含任意 library/non-Core 对象时 Phase 1 回退，避免猜测 Arduino 的链接对象顺序、archive-only、precompiled、`ldflags` 和全局构造顺序。

### 6.3 objcopy 与 size

对当前 resolver 的原生命令依次执行：

1. `recipe.objcopy.eep.pattern`；
2. `recipe.objcopy.hex.pattern`；
3. `recipe.size.pattern`。

所有命令必须是可安全 token 化的直接命令。只允许把已知的最终 ELF/eep/hex 精确路径 token 替换为事务路径，不能字符串模糊替换。`size` 输出继续由 `parse_size_summary_lines` 解析；没有匹配时不能伪造 0 字节。

Phase 1 是 compile-only，不生成 Arduino CLI 的 `with_bootloader.hex/bin`。成功前删除这些旧辅助文件和旧 `.ck-upload-artifacts.json`，防止它们冒充当前源码。普通上传必须走 `UploadReady` 原生 CLI，并重新生成、封存上传清单。

## 7. 事务、dirty marker 与回退

dirty marker 建议放在 build root：`.ck-native-relink-dirty-v1.json`。

执行顺序：

1. 校验旧 manifest、当前身份、CCDB、依赖、core.a、recipes；
2. 原子写 dirty marker，记录 run nonce、旧 manifest SHA-256 和开始时间；
3. 写当前受限 `.ino.cpp`；
4. 在 build root 内创建唯一事务目录；
5. 编译临时 sketch object + depfile；
6. 链接临时 ELF；
7. 生成临时 eep/hex，执行 size；
8. 校验对象、depfile、ELF、eep、hex、size 和当前源码；
9. 用可恢复替换方式提交 sketch object/depfile、ELF、eep、hex；
10. 删除 stale `with_bootloader.*` 和上传清单；
11. 写源码备份；
12. 原子提交新 NativeRelinkManifest；
13. 最后删除 dirty marker 和事务目录。

只要步骤 2 之后发生取消、异常、命令失败、缺产物或 commit 失败：

- 原子删除 NativeRelinkManifest；
- 保留 dirty marker 直到完整 build path 已清除；
- 清除整个目标 build path，不能只删 sketch.o；
- 同一请求回退一次 Arduino CLI Release；
- CLI 成功后重新建立基线 manifest；
- CLI 也失败则保留源码诊断，绝不提交成功标记。

下次启动若看到 dirty marker，也先清 build path 和 manifest，再走 Arduino CLI。不能尝试从半提交事务中“猜测恢复”。

## 8. 可直接复用的现有函数

| 现有函数 | Phase 1 用法 | 注意事项 |
|---|---|---|
| `canonical_fast_relink_sketch_source` | 认证 project root 中 `.ino` 与请求源码字节一致 | 可直接复用 |
| `analyze_include_graph_for_relink` | include 与预处理指纹门禁 | 需要保存到独立 manifest |
| `validate_and_deduplicate_fast_relink_ccdb` | source/object/command 一一对应与 exact duplicate 去重 | 建议后续改成中性命名，Phase 1 可先从子模块调用 |
| `fast_relink_command_identity` | 展开 response file 后生成命令身份 | 可直接进入 command graph hash |
| `extract_sketch_object_path` | 从无 `output` 的 AVR CCDB 提取 `-o` | 可直接复用 |
| `resolve_compile_entry_source_path` | 规范解析 CCDB 源路径 | 可直接复用 |
| `compile_command_entry_env` | 执行原生 sketch CCDB 命令 | 必须传 `None`，不能注入 fast/ccache env；需增加安全的输出重定向 helper |
| `resolve_relink_props_direct(..., Release)` | 重新解析原生 combine/objcopy/size recipes | 不使用 fast property cache，不允许 CLI show-properties fallback |
| `select_platform_command` | Windows recipe 选择 | 可直接复用 |
| `resolve_archive_path` | 查找 Core archive | 必须再做相对 build root 与 SHA-256 门禁 |
| `build_dependency_content_signature` | 校验 CCDB 与 depfile 的强依赖内容 | 可直接复用 |
| `collect_build_artifact_manifest` | 提交当前 ELF/HEX/BIN 集合 | `.eep` 不在现有集合，需要 NativeRelinkManifest 单独记录 |
| `parse_size_summary_lines` | 生成资源统计 | 无 regex 命中必须失败或交给 CLI，不伪造数据 |
| `run_command_tokens_env` | combine/objcopy/size 直接命令 | 只允许无 shell meta，env 为 `None` |
| `sha256_file_hex`、`is_regular_file_without_symlink` | 文件身份与安全门禁 | 可直接复用 |
| `reset_build_path_for_dependency_fallback` | 失败后清理再回退 CLI | 需同时删除独立 manifest 和 dirty marker |

`fast_update_ino_cpp` 不应作为 Phase 1 的安全依据；它可继续服务已有专用 FastRelink。NativeRelink 使用上节的受限直接 C++ 翻译器。

## 9. 推荐的补丁拆分

### Patch A：纯门禁和清单，无产品路由

- 新增 `crates/ck_core/src/builder/demo/native_relink.rs`；作为 `demo.rs` 的子模块可访问现有私有 helper，避免一次性公开大量内部 API；
- 定义 manifest、recipe/CCDB contract、restricted lexer、path/regular-file 验证；
- 单元测试只使用临时目录和假工具，不启动 Arduino CLI；
- `demo.rs` 只增加 `mod native_relink;`。

### Patch B：原生基线采集

- 新增显式 `CompileIntent`；
- 普通 foreground compile 传 `CompileOnly`，上传传 `UploadReady`；
- Arduino CLI Release 成功后，在 `CompileOnly` 下尝试采集 manifest；采集失败只记录“未取得能力”，不影响原生成功；
- `Exact Deny` 仍不写 BuildMeta，但允许写独立 NativeRelinkManifest。

### Patch C：事务式 direct engine

- 实现 sketch temp compile、LTO link、eep/hex、size、commit/dirty/fallback；
- 初期用环境变量或 dev capability 开关，仅在测试构建启用；
- 日志必须输出 `native_relink_candidate`、每个 gate 的拒绝原因、各阶段耗时、fallback 原因和 artifact gate。

### Patch D：资格 A/B 后才开产品路由

- 通过官方 AVR Uno 的 correctness + performance 资格；
- 资格绑定 host、CLI、Core、toolchain、完整 FQBN、capability class 与 workload suite；
- 没有资格时继续走原生 Release，不显示 Fast。

## 10. 测试清单

### 10.1 单元测试

- Release CCDB 无 `output` 字段仍能从 `-o` 提取；
- 重复相同 CCDB 行可去重，source/object/command 冲突拒绝；
- response file 缺失、过大、递归、内容变化拒绝；
- restricted translator 接受 portable simple/complex/medium；
- forward call、overload、template、lambda、宏 include、条件 include、raw string 拒绝；
- Core 之外出现一个 library 对象即拒绝；
- combine 缺 LTO、tool path 改变、未展开 placeholder、shell meta 拒绝；
- core.a、build.options、depfile、头文件、platform.txt、compiler/objcopy/size 任一变化拒绝；
- eep/hex/ELF 缺失、空文件、symlink/reparse、越界路径拒绝；
- dirty marker 在每个阶段的崩溃模拟后都强制 clean CLI fallback；
- 失败不留下 manifest；manifest 总是最后提交；
- CompileOnly 可候选，UploadReady/Background/LockedReplay 永不候选。

### 10.2 产物等价 A/B

用独立资格脚本，至少 5 轮，顺序固定为 simple -> complex -> medium -> simple-return：

- CK simple 必须是原生 CLI 基线；后三段必须明确命中 `NativeRelinkCompileOnly`，且日志没有 Arduino CLI compile spawn；
- native lane 使用同一 bundled CLI、配置、完整 FQBN、jobs 和源码序列；
- 每阶段源码 SHA-256 必须一致；
- application `.hex` 字节 SHA-256 必须与 native lane 完全相同；
- `.eep` 必须同为存在且字节相同；
- 额外用 AVR objcopy 导出 loadable application binary 并比较 SHA-256；
- `avr-size -A` 的 `.text/.data/.bss/.noinit/.eeprom/.bootloader` 必须逐项一致；
- ELF 整文件 SHA 不作为唯一等价依据，因为调试信息可包含工程路径；仍需验证 ELF 架构、非空和 loadable sections；
- direct lane 不得残留旧 `with_bootloader.*` 或旧上传清单；
- 任何 correctness mismatch 立即取消资格，不能只看“编译成功”。

性能门槛沿用 FLFE：每个 edit 阶段相对 native median 至少快 10% 且至少 500 ms，p95 不回退，零 fallback；同时记录 backend identity、manifest gate、sketch compile、LTO link、objcopy、size、commit 的独立耗时。当前 AVR native edit 中位数约 5.1～5.5 秒，因此 direct backend 目标应低于约 4.5 秒，工程目标设为 3 秒以内更有余量。首次 simple 基线不宣称加速。

### 10.3 负向集成测试

- simple 后新增第三方 include：直接回退，CLI 决定库；
- 切换 Uno/Nano、CPU 菜单或 Core 版本：直接回退；
- 修改 Core header、platform.txt、boards.txt 或工具二进制：直接回退；
- 中断 sketch compile、link、objcopy、commit：下一次 clean CLI；
- 编译错误：清理 direct partial state，再由 CLI 复现最终诊断；
- 普通上传：无论 compile-only manifest 是否存在，都必须走 upload-ready 路径并重新封存上传产物。

## 11. 推广到其他 Core 的条件

AVR Phase 1 通过后，抽象的是能力，不是把 AVR 特例复制到全部板卡：

- `SingleSketchObject + CoreArchive + DirectRecipes`：AVR 首个能力类；
- `OrderedObjects + CoreArchive + DirectRecipes`：需先捕获并认证原生链接对象顺序；
- `PrecompiledLibraries`：需证明 archive/precompiled/ldflags 语义；
- `PlatformPackager`：ESP32、RP2040、Renesas 等必须分别证明 post-link 和上传产物；
- `NativePrototypeTool`：复杂 `.ino` 先接当前 Core 的原型工具，再扩大源码合同。

任一 Core 不具备某能力时继续使用 Arduino CLI Release。FLFE 的“通用”应来自能力探测、正确性证明和逐能力资格，而不是对未知 Core 强制走同一捷径。
