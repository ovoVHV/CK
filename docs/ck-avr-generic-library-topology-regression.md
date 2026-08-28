# CK AVR 通用 Arduino 库拓扑回归

这套回归用于回答一个明确问题：FLFE 的库切换优化是否依据 Arduino
库的结构和依赖关系工作，而不是对 Wire、SPI、EEPROM 或其他真实库逐个写特例。

## 覆盖范围

正向 fixture 使用没有业务含义的固定名称，覆盖：

- `src/` 单个 C++ 翻译单元；
- 同一库 `src/` 下的 C++ 与深层 C 翻译单元；
- 只有头文件、没有翻译单元的库；
- `A -> B -> C` 两层 `library.properties:depends`，并由库源码中的递归
  `#include` 形成相同的真实编译可达闭包；
- 两个直接库的 include 顺序交换；
- 库图增加、同图代码编辑、部分移除和精确恢复。

每个翻译单元的相对路径、语言、字节数和 SHA-256 都进入拓扑清单。每个阶段分别记录
库成员集合、Arduino CLI 递归发现的预期有序库、预期有序翻译单元和编译路线，不能把
成员集合误写成顺序证据。

`library.properties:depends` 在本回归中只提供依赖候选和声明一致性，不能单独证明一个库
会参与 Arduino 构建。真实可达性必须来自草图或已可达库源码的 `#include`/depfile；仅在
`depends` 中出现、却没有源码引用的库不能被 CK 擅自加入链接。

执行顺序是：

1. Core-only 冷基线；
2. 加入完整通用拓扑；
3. 有序依赖图不变，只编辑代码；
4. 交换直接 include 顺序，形成有序依赖图迁移；
5. 移除一个直接库，保留两层传递依赖；
6. 恢复到第 2 步的精确源码和完整拓扑。

预期的 Arduino FIFO 递归发现顺序为：

- 加入、同图编辑和恢复：`A, D, B, C`；
- include 重排：`D, A, B, C`；
- 部分移除：`A, B, C`。

其中 `C` 是只有头文件的传递依赖，因此没有自己的 CCDB 翻译单元。对应的预期 CCDB
库翻译单元顺序为 `A.cpp, D.cpp, B.cpp, BDetail.c`、重排后的
`D.cpp, A.cpp, B.cpp, BDetail.c`，以及部分移除后的 `A.cpp, B.cpp, BDetail.c`。

依赖增加、移除以及 include 顺序变化必须使用
`native-relink-graph-transition`；只有 include 顺序和依赖集合均未变化的普通代码
编辑才能使用 `native-relink-compile-only`。AVR GCC LTO 的最终 HEX 会受链接对象
顺序影响，因此 include 重排不是普通同图编辑。Exact 不属于本测试的成功路线。

每个阶段都将 CK 与原生 Arduino CLI 成对编译，并比较：

- 源码 SHA-256；
- Flash 与 RAM 字节数；
- AVR application HEX 的角色、大小和 SHA-256；
- EEPROM 产物的角色、大小和 SHA-256；
- CK 与原生构建目录中 `compile_commands.json` 的原始库翻译单元条目、首次出现的
  库组顺序，以及按已封存库清单规范化后的翻译单元顺序；
- 每个被观察库源码与构建目录内普通 `.o` 文件的一对一绑定；
- 加入完整拓扑与最终恢复之间的 CK/原生各自精确等价。

Arduino CLI 会并行准备同一库的多个编译命令，因此同一库内部的原始 CCDB 条目顺序可能
受 worker 调度影响。报告保留 `rawCcdbEntryOrderedTUs`，但不拿这项不稳定顺序冒充链接
顺序或发布门禁。门禁检查的是：CCDB 中首次出现的库组顺序、每个库完整且无重复的 TU
成员、源码/对象一对一绑定，以及按已封存库清单规范化后的 `normalizedOrderedTUs`。
这些证据仍不是最终链接命令顺序，也不能单独证明链接器实际采用了相同顺序。HEX/EEP
精确等价、路由门禁和规范化 CCDB 证据必须同时通过。

## 只读查看计划

```powershell
node scripts/Run-CKAvrGenericLibraryTopologyRegression.cjs --plan --target uno
```

该命令不会编译、清缓存、安装 fixture、上传或访问串口。

## 候选 EXE 一键执行

推荐使用带候选身份和清理边界的 PowerShell 封装：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/Run-CKAvrGenericLibraryTopologyCandidate.ps1 `
  -Output artifacts/benchmarks/ck-avr-generic-topology-uno-t1.json `
  -ExpectedExecutableSha256 <64位production EXE SHA-256> `
  -Target uno `
  -Trials 1 `
  -DebugPort 9223 `
  -MinFreeGiB 12
```

该封装会验证 `target/release/appsdesktop.exe` 的精确 SHA-256，以正常
`http://tauri.localhost/` production 页面启动 CDP，移除 qualification token，
并显式向 runner 授予一次 cache reset 和临时 fixture 安装权限。无论成功失败，
finally 都会停止本次 app/CLI 进程、恢复环境变量、安全回收带所有权标记的 fixture，
并检查调试端口和临时库没有残留。

## 直接执行 runner

先启动与待测 production EXE 对应的 CDP 测试实例，再执行：

```powershell
node scripts/Run-CKAvrGenericLibraryTopologyRegression.cjs `
  --execute `
  --target uno `
  --trials 1 `
  --allow-cache-reset `
  --allow-fixture-install `
  --output artifacts/benchmarks/ck-avr-generic-topology-uno-t1.json
```

执行采用 no-clobber：若 `sketchbook/libraries` 中已经存在任一固定 fixture
目录，测试直接停止，不覆盖现有库。每个临时库都有本次运行 token、拓扑清单
哈希和库名绑定的所有权标记。结束或失败时只清理由这些标记授权的固定目录。

## 负向语义格

以下 Arduino 库语义不进入正向 NativeRelinkGraphTransition 路线：

- `dot_a_linkage=true`；
- `precompiled=full`；
- 自定义 `ldflags`。

这些格子当前是策略边界，不属于本正向矩阵中的真实执行格。它们的要求不是“尽量快”，
而是在尚未证明可合成等价链接语义时，先保持
缓存清理边界，再回退原生 Arduino CLI。不能通过放宽 HEX/EEP 等价门禁来让它们
伪装成通过。

## 边界

这是一套 compile-only 工具链回归，不上传、不打开串口，也不代表真板外设已验证。
名称无关的 fixture 可以证明通用拓扑处理，但仍不能把所有第三方 Arduino 库都
假定为可安全 NativeRelink；不支持的复杂语义必须 fail closed。
