# CK Forge FLFE：性能资格与原生不回退底线

状态：Stable local（2026-08-25；当前资格必须按正在运行的 production EXE 动态复算，文档不再把旧 EXE 的证书写成当前状态）。

FLFE（**Fast Link For Ever**）是 CK Forge 的长期优化方向，不是“所有目标都贴上 Fast
标签”的承诺。CK 只有在同一主机、Arduino CLI、Core、工具链、完整 FQBN、sketch
类别和构建合同通过相对原生 Arduino CLI 的 A/B 不回退门禁后，才可以启用或展示
Fast。能够编译、存在缓存目录、第二次比第一次快，都不能单独证明 CK 比原生快。
各展示面的统一状态词和待收口 UI 见[支持状态展示审计](flfe-support-surface-audit-20260725.md)。

## 库兼容模型：按构建语义，不按库名

FLFE 的快速底座不得以“遇到一个库增加一个 `if 库名`”作为扩展方式。正式快速路径只按
Arduino 构建语义识别库图：literal include 的首次出现顺序、唯一 header provider、
`library.properties depends=` 的稳定传递闭包、Arduino 1.5 `src/**` 与 legacy
root/`utility/` 布局、C/C++/汇编编译单元、真实 CCDB/depfile、树内容哈希和对象顺序。
满足同一组语义的未知库应自动受益；provider 歧义、不安全路径、precompiled archive、
自定义 `ldflags` 等当前不能可靠重现的形态必须 fail-closed 回到原生 Arduino CLI，不能
为了命中 Fast 猜测或修改第三方源码。

2026-07-21 development candidate `7b45eccf6dabbb4a…` 已用随机命名的
`CKTopoA17/B29/C43/D61` 真实验证：深层 `src/**`、混合 C/C++、header-only、
A→B→C 声明依赖、第二个直接库、include 重排、部分删除与精确恢复均不依赖熟知库名。
新增、重排、删除和恢复走 `native-relink-graph-transition`，同图编辑走
`native-relink-compile-only`；各阶段 CK 与原生 CLI 的 HEX/EEP、源码、资源和 CCDB
编译单元集合等价，临时库全部清理。单轮报告为
[`ck-avr-generic-topology-uno-exe7b45eccf6d-20260721-t2.json`](../artifacts/benchmarks/ck-avr-generic-topology-uno-exe7b45eccf6d-20260721-t2.json)，
报告 SHA-256 为 `03b47d9190bfa896f6f61c993d24c1c5a319741fa09fc145ea5166271e9915bd`。
三轮正式依赖序列另完成 42 次配对编译并通过独立只读复核，见
[`ck-avr-dependency-edit-uno-exe7b45eccf6d-20260721-t3.json`](../artifacts/benchmarks/ck-avr-dependency-edit-uno-exe7b45eccf6d-20260721-t3.json)。

边界也必须公开：`ck_core/NativeRelink` 当前产品资格仍主要覆盖 AVR，不能从上述结果外推
到所有架构。桌面外围仍有 BusIO、AVR NeoPixel、FastLED 内部目录和 Wire/SPI 分类的
历史兼容适配；它们不是 FLFE 的通用能力，也不得继续扩张。迁移顺序固定为：先把保留的
legacy adapter 做成内容寻址、原子生成并纳入构建签名；再以当前 FQBN/Core 的真实头文件
索引、manifest/`depends=`、父包所有权和原生 recipe 替代静态库名；不确定时回退 CLI；
最后在真实旧包和随机命名回归同时通过后删除静态适配。错误后的缺库安装建议可以保留
名称映射，但不得参与 provider 选择、快速资格或缓存信任。

## 当前三种产品决策

| CK Forge 决策 | 编译 profile | 用户口径 |
| --- | --- | --- |
| `allow-fast` | 证书声明的精确 profile；当前为 `native-relink-compile-only` | 完整身份持有有效的正确性与性能资格；只允许执行证书明确授权的 adapter/engine 与 operation。Exact 仍是独立回放能力。 |
| `force-platform` | `release` | 未知/新 Core、第三方板卡、未验证菜单组合或缺少性能资格；需要真实编译时使用未注入 CK 加速变换的原生 Arduino CLI 流程，不标记为 Fast。完整身份和产物证据完全相同时可安全 Exact 回放，但 Exact 不等于 Fast 资格。 |
| `block` | 无 | 只用于确定性不兼容；未知版本本身不得触发。 |

`force-platform` 不是失败。它保证合法 Core 仍能按自己的 recipes、hooks、分区与产物
规则构建，但不会注入 ccache compiler shim、私有增量目录、跳过 hook、对象拼接或
direct link。编译前的 Exact 只复用同一完整身份下已重新核验的相同产物集合；公平 A/B
采集会强制禁用 Exact，避免把产物回放冒充编译器速度。只有低于最低版本或命中带理由的
已知不兼容范围才阻止。

## PortableFast 的纠偏

`portable-fast` 曾作为未资格目标的实验兼容通道：保留 Core 原生 hooks/recipes，同时
注入命令级 ccache 和独立 `pfast2` build path。跨板 compile-only 回归证明它可以产出
正确产物，但随后与同机、同 CLI、同 FQBN 的直接 Arduino CLI 诊断比较发现：

| 目标 | CK PortableFast | 原生 Arduino CLI | 结论 |
| --- | ---: | ---: | --- |
| STM32 F401RE fresh | 62.644 s | 37.608 s | CK 慢 66.6% |
| STM32 F401RE repeat | 68.416 s | 16.149 s | CK 为原生 4.24 倍 |
| ESP32-H2 fresh / repeat | 85.457 / 53.756 s | 51.635 / 24.238 s | 两阶段均回退 |
| ESP32-P4 fresh / repeat | 85.368 / 51.883 s | 53.008 / 22.252 s | 两阶段均回退 |
| Feather ESP32-S3 fresh / repeat | 86.977 / 53.608 s | 59.791 / 26.299 s | 两阶段均回退 |

这些是单轮诊断，不冒充正式 P50/P95；但它们已经足以否定“PortableFast 已证明更快”。
因此 PortableFast 不再是 `force-platform` 的产品默认路由，也不能作为通用加速卖点。
旧 profile 和 `pfast2` 报告只保留用于历史复现、失效分析和后续优化实验。

## 当前资格查询与 `7b45eccf…` 历史快照

下列数据绑定历史 production EXE
`7b45eccf6dabbb4a23ebac269c7f8c1f1a04d1cf9a59e7acb5a4fe7fc7453476`，大小
`44,863,488` bytes。当时的门禁曾为下列两个**精确完整 FQBN/Core 身份**签发
NativeRelink v4 本机资格：

| 精确目标 | 5 轮热编辑 CK / 原生中位数 | 相对原生 | 冷基线 | 裁决 |
| --- | --- | --- | --- | --- |
| `arduino:avr:yun`，AVR Core 1.8.6 | complex `2.087/5.079s`；medium `2.136/5.224s`；simple-return `2.147/5.199s` | 快 58.91% / 59.10% / 58.71% | `8.187/7.935s`，CK 慢 3.18% | 热编辑 `qualified`；冷编译不合格 |
| `arduino:avr:uno`，AVR Core 1.8.6 | complex `2.712/5.287s`；medium `2.713/5.070s`；simple-return `2.621/5.013s` | 快 48.71% / 46.48% / 47.72% | `9.502/7.518s`，CK 慢 26.40% | 热编辑 `qualified`；冷编译不合格 |

两份证书目录键分别为 `7d0f3abb…` 与 `7ff683e3…`。证书、原始 evidence 和资格 report
的 SHA-256 仍可核对，但当前更严格的 lane-boundary/四阶段评估器会拒绝这两份旧证书；
因此它们的**当前规则复算 Fast 数为 0**。旧证书精确绑定主机、
production EXE、Arduino CLI、Core、工具链、完整 FQBN、源码/工作负载、adapter、engine、
artifact policy、原始报告与产物哈希；任一变化都回原生 Release。Yun 或 Uno 的资格不能
外推到 Nano/Mega/其他 AVR 身份或其他 Core 版本。

该历史 EXE 当时的 **ESP32 Fast 资格数为 0**。`ck_forge_qualified_targets.v1.json` 中列出的
ESP32、C3、C5、C6、S2、S3 等条目只是可识别的候选/兼容身份，没有 `performance_ab`
或该 EXE 的 NativeRelink v4 证书，不能把它们计作 Fast。ESP32 的 Core 缓存、Exact、
QuickFast/SharedFast 历史实现、真板编译或上传成功也都不能替代性能资格。

ESP32-C3、C5、C6、S3、H2、P4 与 Adafruit Feather ESP32-S3 均属于同一通用资格流程的
**待四阶段验证目标**，不是“不兼容目标”，更不是需要逐板写死的专用实现。没有绑定当前
EXE/Core/工具链/完整 FQBN 的有效证书时，它们继续使用原生 Arduino CLI Release；只有
`simple → complex → medium → simple-return` 四阶段 A/B 全部通过后才显示 Fast。

可重复查询当前 EXE 的实际持证目标：

```powershell
node scripts/Report-CKForgeFastQualifications.cjs --exe target/release/appsdesktop.exe --format text
node scripts/Report-CKForgeFastQualifications.cjs --exe target/release/appsdesktop.exe --architecture esp32 --format text
```

脚本只统计重新复算通过且绑定所查 EXE 哈希的 v4 证书；候选清单、Exact 命中和其他 EXE
的历史证书均不进入计数。它还会把回归目录中的目标列为 `qualification-pending`，并明确
“待验证不等于不兼容”；该待办数量不会混入 `Fast-qualified targets`。

首次 `simple` 是建立原生基线的冷阶段，不属于 NativeRelink 加速范围，而且上述历史两套结果
都慢于原生。故该旧门禁当时只证明**受限热编辑**快于原生；当前门禁已不再接受这些证书。
它们不证明首次编译已经加速，也不满足
30%～40% 冷编译目标。普通上传、后台暖机、锁定恢复以及其他目标仍走其安全原生路径。

### 前一版 EXE 的 Uno / MKR Zero 历史资格

EXE `fe1450c5a719adcf6851fd41e7f8315c9961a49d98d6c353bcfafea27549aa0f` 曾为精确
Uno 与 MKR Zero 身份签发热编辑资格，历史报告和证书继续保留：

- [AVR Uno 历史正式 A/B](../artifacts/benchmarks/flfe-avr-native-relink-formal-20260719-exefe1450c5.json)
- [SAMD MKR Zero 历史正式 A/B](../artifacts/benchmarks/flfe-samd-mkrzero-native-relink-formal-20260719-exefe1450c5.json)

其中 MKR Zero 的旧证书只绑定 `fe1450c5…`，对后续 EXE 均已过期。保留历史证据不等于
把旧资格迁移到新 EXE。

## 已被取代的三平台候选 A/B（EXE `53dd76b7…`）

> 本节保留 2026-07-18 的历史数据用于解释 PortableFast/通用 repeat 路线为何被纠偏，
> 已被上节最终 EXE 的精确 NativeRelink 资格取代，不能代表当前 production EXE。

该历史 production EXE SHA-256 为
`53dd76b738fc510c2e52bee7b91206e2daa57e40615d31efbdf81eb01a5796fa`，大小
`40,997,376` bytes。C6、AVR Uno 和 STM32 F401RE 都在同一主机、同一 bundled CLI、
同一 Core/FQBN、同一源码和 8 个并行任务下完成 3 组交替配对 A/B；两条通道使用相同
全局缓存策略、独立 fresh build path，且 `Exact` 被强制禁用。

| 目标 | CK fresh / 原生 fresh | CK repeat / 原生 repeat | 结论 |
| --- | ---: | ---: | --- |
| ESP32-C6，Core 3.3.6 | 42.130 / 42.288 s | 21.599 / 21.015 s | fresh 快 0.375%，repeat 慢 2.778%；不合格 |
| Arduino Uno，AVR Core 1.8.6 | 6.817 / 6.892 s | 4.894 / 4.542 s | fresh 快 1.088%，repeat 慢 7.758%；不合格 |
| STM32 Nucleo F401RE，Core 2.12.0 | 35.444 / 36.565 s | 16.018 / 15.599 s | fresh 快 3.064%，repeat 慢 2.687%；不合格 |

三份报告的 `status: passed` 只表示 A/B 采集、身份绑定、产物/资源等价和禁止上传等检查
通过，不表示 CK 赢得性能资格。三者都没有同时达到中位数至少快 10%、绝对收益至少
500 ms 且 p95 不回退的门槛。因此该历史候选当时 **Fast qualified = 0**，30%～40% 冷编译目标
尚未达到；它也不与后续 EXE 的历史证书合并成当前资格：

- [C6 A/B v1](../artifacts/benchmarks/ck-forge-20260718-flfe-53dd76b7-c6-native-ab-v1.json)
- [AVR A/B v1](../artifacts/benchmarks/ck-forge-20260718-flfe-53dd76b7-avr-native-ab-v1.json)
- [STM32 A/B v1](../artifacts/benchmarks/ck-forge-20260718-flfe-53dd76b7-stm32-native-ab-v1.json)

## 正常用户路径的 Exact（不是 Fast 资格）

正常产品路径另行验证了严格相同源码、完整身份、依赖闭包、资源统计和产物集合的 Exact
回放：C6 冷建 `47.378s`、Exact `2.438s`；STM32 冷建 `42.265s`、Exact `1.648s`。
STM32 报告只有“非 CK 内置板卡卡片”的非阻止警告，其产物、资源和依赖闭包检查均通过。

- [C6 normal Exact](../artifacts/benchmarks/ck-forge-20260718-flfe-53dd76b7-c6-normal-exact-v1.json)
- [STM32 normal Exact](../artifacts/benchmarks/ck-forge-20260718-flfe-53dd76b7-stm32-normal-exact-v1.json)

Exact 是完整证据相同后的产物复用，不是重新运行编译器；它不会被计入 fresh/repeat A/B，
也不会把 `force-platform` 升级为 `allow-fast`。当前 C6 normal cold 仍没有相对原生的
配对性能资格，因此不能写“用户首编已加速”。

## 其他前一候选证据

`7f10e3f8…` 的三平台 A/B/Exact、`3fcaf092…` 的 C6 WiFi-cycle、`0cce8cd1…` 的 STM32/H2/P4/Feather S3/Leonardo/ESP8266
以及更早报告仍保留在机器索引中，但均为 previous-candidate 或历史证据，不代表当前 EXE，
也不授予 Fast。此前 `localhost:1420` 未带 custom-protocol 参数的启动尝试仍是失败冒烟，
不进入通过矩阵或发布结论。

## 当前缓存维护边界

成功编译或上传返回后，普通缓存预算维护会离开响应路径：全进程单飞、最多每 10 分钟一次，
先延迟 2 秒，并在前台编译、暖机、上传或恢复消费者出现时取消扫描并等待后续重试。维护任务
持有 build cache 门禁的独占侧，上述消费者持有共享侧，因此不会删除正在使用的构建目录。
当临时缓存卷可用空间低于 2 GiB 时改为同步压力回收，有效缓存上限最多 512 MiB。

out-of-tree 的 `CK_Builds/build` 容器本身固定保留，LRU 只把其直接工程目录分别计量和淘汰；
链接、重解析点和固定 metadata 不会被跟随删除。退出协调、ENOSPC 后只重试可证明幂等的准备
阶段，以及源码／build 两侧成对 LRU 仍是明确 P1，见
[缓存维护后续项](flfe-cache-maintenance-followups.md)。这些维护不跳过工具链身份、依赖闭包、
产物清单、SHA-256 或上传前门禁。

## 性能资格

权威门禁见
[`ck-forge-performance-no-regression-gate.md`](ck-forge-performance-no-regression-gate.md)。
普通 QuickFast/SharedFast v4 候选与正式 NativeRelink `portable-edit` 资格均至少需要
5 个交替配对 trial，并固定使用 `simple → complex → medium → simple-return`。普通 Fast
必须四阶段通过；NativeRelink 只授权三个热编辑阶段。被认证的每个阶段都必须通过
route/capability/产物/资源门禁，中位数至少快 25%、绝对收益至少 500 ms，且 p95 不得比原生慢。资格键绑定：

- 主机与操作系统；
- Arduino CLI 二进制和版本；
- Core package、architecture、version；
- 工具链内容身份；
- 完整 canonical FQBN 及菜单选项；
- sketch 类别和源码身份；
- CK 构建合同及相对原生的属性差异。

任一身份变化都会让资格失效并回到原生 Release。兼容性报告、板卡护照、单次成功、
Exact 命中或旧 Core 的速度结果都不能替代性能资格。本地只读资格 loader 已接入运行时；
只有查询脚本对**所查 production EXE**重新复算通过的精确证书才能显示或执行 NativeRelink
Fast。上表 Yun 与 Uno 只是 `7b45eccf…` 的历史快照；不能据此描述正在运行或新构建的 EXE。
其他目标、Core 版本、菜单组合和 operation 在取得自己的证书前显示“Fast 待验证”。

## 历史证据边界

2026-07-17 的 minimum/configuration/compatibility、STM32 pfast2 和 ESP32 广覆盖报告仍在
[`flfe-regression-record-20260717.md`](flfe-regression-record-20260717.md) 与
[`artifacts/benchmarks/index.json`](../artifacts/benchmarks/index.json) 中原样保存。它们能
证明当时绑定 EXE 下的 compile-only 正确性、依赖闭包和历史路由，不能证明当前产品应继续
选择 PortableFast，更不能证明所有板卡或 Core 已获得加速。

## FLFE 当前承诺

1. 合法 Core 不因未列入 Fast 资格而被阻止；需要真实编译时，未资格目标使用原生 Release。
2. 没有正式 A/B 证据就不显示 Fast、不注入实验优化。
3. 快速资格不跨主机、Core、工具链、完整 FQBN 或构建合同复用。
4. 任何实测性能回退都会撤销快速路由，修复后重新资格。
5. 完整身份和产物证据相同的 Exact 可独立安全复用，但不冒充编译器性能资格。
6. “For Ever” 表示持续扩大已证明的快速覆盖，不表示未经验证地承诺所有目标更快。
