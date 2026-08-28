# FLFE SAMD NativeRelink Phase 1：隔离引擎设计

> **历史设计快照（superseded，2026-07-19）：**下方“仅候选路由／尚未取得认证”等状态保留为实施过程记录，已被正式资格结果取代。最终 production EXE `fe1450c5a719adcf6851fd41e7f8315c9961a49d98d6c353bcfafea27549aa0f`（43,314,176 bytes）已对精确 `arduino:samd:mkrzero` / SAMD Core 1.8.14 完成 5 轮 A/B 并取得 NativeRelink v4 本机热编辑资格；complex / medium / simple-return 分别比原生快 41.25% / 44.63% / 35.59%，冷 `simple` 慢 23.56%，所以首编仍未获加速资格。普通无 qualification token 运行已验证 `authorization=certified` 并进入 `native-relink-compile-only`。证书精确绑定主机、EXE、CLI、Core、工具链、完整 FQBN、adapter/engine、SAMD application BIN/HEX 产物策略和证据哈希，不能外推到其他 SAMD21/SAMD51、其他 Core 版本、上传或其他操作。权威状态见 [正式报告](../artifacts/benchmarks/flfe-samd-mkrzero-native-relink-formal-20260719-exefe1450c5.json) 与 [性能资格门禁](ck-forge-performance-no-regression-gate.md)。
>
> 以下正文原样保留当时设计与待办；其中的未来时态属于历史，不覆盖上述正式结果。

状态：**已接入产品候选路由；仅资格探针/本机认证可进入，普通无证请求默认关闭**  
证据日期：2026-07-18  
首个能力样本：`arduino:samd:mkrzero` / Arduino SAMD Core 1.8.14

当前桌面 Forge 网关仍只签发 AVR NativeRelink Access，因此 production UI 尚不会为 SAMD 打开 probe/certified 路由。必须先扩展 Forge 的 SAMD `BIN + HEX + resource` 等价证据与证书合同，再同时打开桌面网关；不能用 AVR 的 HEX/EEP 合同冒充 SAMD 认证。`ck_core` 候选路由和适配器已经就位，但这个网关边界保持 fail-closed。

## 1. 为什么现在可以进入引擎阶段

可重复下界报告
[`flfe-samd-mkrzero-native-relink-lower-bound-2026-07-18T08-53-00-177Z.json`](../artifacts/benchmarks/flfe-samd-mkrzero-native-relink-lower-bound-2026-07-18T08-53-00-177Z.json)
已经用 3 轮 `complex -> medium -> simple-return` 证明：

- 原生 Arduino Release 的 sketch 热编辑中位耗时约为 6.23～6.84 秒；
- 复用同一原生命令图，仅重编 sketch、重链接并生成 BIN/HEX/size 的中位耗时约为 0.81～0.87 秒；
- 三类源码、三轮测试的 BIN、HEX 与 Flash/RAM 资源摘要全部与原生路径一致；
- 这是独立路径的字节等价证据，不是 Exact 产物回放。

该证据只授予“可以实现并继续资格验证”的资格，**不直接授予产品启用资格**。

## 2. Phase 1 精确能力图

SAMD Phase 1 不按“架构名字”猜测，而按捕获到的完整链接图授权：

```text
SingleSketchObject
  + FixedObjectSet(exactly one core/variant.cpp.o)
  + core/core.a
  + CMSIS libarm_cortexM0l_math.a
  + exact linker script
  -> ELF + MAP
  -> BIN + HEX
  -> section/resource summary
```

必须同时满足：

- 完整 FQBN、Core、CLI、工具链、Release property contract 与 Access key 相同；
- `CompileIntent::CompileOnly`，Release，attempt 0，非强制/缓存重建；
- CCDB 只有一个 sketch 编译单元，链接图只有一个 sketch 对象和一个固定 `variant.cpp.o`；
- `core.a`、CMSIS archive、linker script、variant object、命令 argv 与工具二进制内容身份全部未变；
- 仅接受经过可信“无需 Arduino 自动原型”分析器签发的直接 C++ 翻译证明；
- 没有新增第三方库编译单元、response file、prelink 或条件 hook。

出现任何额外对象、额外静态库、不同 CMSIS 组、不同 linker script 或未知 hook，都不属于本能力类，回原生 CLI。

## 3. 与 AVR 相同的安全等级

隔离模块 `samd_native_relink.rs` 不复制 AVR 的“只有 sketch + core.a”假设，但复用以下安全语义：

1. **意图先行**：UploadReady、Background、LockedReplay 在读取 manifest、创建 dirty marker 或执行工具之前直接拒绝。
2. **Access key**：manifest 绑定授权模式、授权 key、完整 FQBN、构建签名、CLI、工具链代际与 property contract；所有 hash 均为小写 SHA-256。
3. **内容身份与状态边界**：不能只看路径和时间戳。固定对象、archive、脚本、工具、CCDB、build options 和旧成功产物都绑定 bytes + SHA-256；manifest/backup 只能是显式 managed state root 的直接子文件，缓存重置不能借参数删除任意路径。
4. **事务目录**：新 cpp/object/depfile/ELF/MAP/BIN/HEX 全部先写入 build 内的私有 transaction dir。
5. **dirty marker**：第一个输出前先原子写 marker；任何部分提交、取消、封印失败都撤销独立 manifest，并要求清洁 Arduino CLI 重建。保留 marker 必须是有大小上限、结构正确且绑定当前 engine/manifest 的普通文件；伪造、目录或重解析点会硬阻断，不删除 build，也不启动回退。
6. **depfile 重写**：只接受单规则 GCC depfile；只把 transaction object/source 改回 canonical 路径；任何额外 transaction 依赖、多规则、Make 变量或路径逃逸均 fail-closed。
7. **原子提交**：候选全部存在且通过内容绑定后，逐个原子替换 canonical 文件；manifest 是最后一个提交标志。
8. **最终封印**：所有新产物准备完成后调用请求级身份租约/封印；回调后再次验证固定输入与新产物，防止回调期间被替换。
9. **编译/上传隔离**：SAMD 的普通 Arduino 配方会同时产出 application 与
   `with_bootloader` BIN/HEX；原生 lane 可以保留后者，CK compile-only 编辑 lane
   必须删除并证明其不存在，只绑定 application BIN/HEX；UF2、flash_args、upload
   manifest 和未知辅助固件在所有 lane 都拒绝，上传始终走原生 UploadReady 路径。
10. **取消不回退**：取消返回 Cancelled 并清理，不偷偷启动一次原生 CLI；其他 dirty failure 才允许上层执行一次清洁回退。

## 4. 当前产品适配器的边界

`demo.rs` 已通过四个窄接口接入该模块，但接入不等于默认启用：只有与当前主机、完整 FQBN、Core/工具链身份及独立 SAMD engine contract 匹配的 `qualification-probe` 或 `certified` Access 才能进入候选路由。旧 API、普通无证请求、UploadReady、Background 和 LockedReplay 均不会进入。

- `SamdCommandExecutor`：产品侧必须适配现有的受管、可取消、限量 stdout/stderr 进程执行器；
- `SamdFinalSealer`：产品侧必须同时重验请求身份租约与 Core cache 身份，并返回一个持续持有两把读租约的 guard；该 guard 必须活过最终文件复验和 manifest 原子提交；
- `SamdDependencyRefresher`：提交后重新计算依赖内容签名；
- `SamdResourceParser`：使用产品的 SAMD size 解析器生成资源摘要。

产品执行器复用 CK 的受管进程树、取消令牌和每流 2 MiB 输出上限；事务在 blocking worker 中运行，工具进程仍由请求级取消域注册、终止并回收。隔离测试继续使用 fake executor 验证事务，不在引擎里引入第二套不受管进程。

翻译证明由 AVR NativeRelink 已使用的共享可信“无需自动原型”分析器产生，再绑定 SAMD proof contract；不接受扩展包自行声明 `safe=true`。

## 5. 获得普通用户本机认证前仍需完成

1. 用 production CK 运行至少 5 轮 `simple -> complex -> medium -> simple-return` 正式 A/B：
   - 每个编辑阶段 CK 中位数至少快 10%；
   - 绝对至少快 500ms；
   - CK p95 不慢于原生 p95；
   - 每轮 BIN/HEX 与资源摘要等价；
   - structured mode 必须明确为 SAMD NativeRelink，且没有 CLI fallback。
2. 把正式 A/B 的原始证据、报告 SHA-256、主机、完整 FQBN、Core、CLI、工具链和 engine contract 写入本机 Forge 证书；未取得证书前保持默认关闭。
3. 补真实工具失败/取消、并发篡改、Core/工具链原地替换、磁盘不足等产品级故障注入；当前已有事务级相同边界测试及伪造 retained marker 回归。
4. 资格只绑定实际验证的完整身份。不能从 MKR Zero 自动推广到所有 SAMD21/SAMD51，也不能跨 Core 版本继承。

## 6. 后续通用化建议（本补丁不执行）

AVR 和 SAMD 已暴露出一组真正可共享、与架构无关的部件：安全路径/文件身份、原子状态文件、dirty 生命周期、单规则 depfile 重写、事务候选绑定和 final seal。建议在 SAMD 真实 API 与 A/B 通过后，再提取为：

```text
NativeRelinkTransactionKernel
  + ArchitectureCapabilityGraph
  + CommandGraphAdapter
  + ArtifactPolicy
```

现在直接重构 AVR 会扩大已验证路径的风险，也会在 SAMD API 尚未冻结时过早抽象，因此本轮只记录提案，不改现有 AVR 文件。
