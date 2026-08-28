# CK Contract Inventory Audit

状态：审计完成，运行时未迁移。更新时间：2026-08-25。

本报告只做合同治理、分类和风险登记，没有重写 V2、没有放宽 fail-closed，也没有新增运行时合同。机器可读清单见 [`docs/specification/contracts.json`](specification/contracts.json)。清单是内部审计资料，不是运行时授权注册表。

## 结论先行

CK 目前不是“版本号太多”这么简单，而是四种不同问题被写进了相似的 `vN`、`contractId` 或 `schemaVersion` 字段：

1. 真正的持久化 Schema：`.ck`、板卡包、积木包、质量报告、上传清单等。这些版本轴应保留，但只能在边界解析、校验、迁移。
2. 稳定行为 Contract：CK Forge 和 NativeRelink 的运行/安全语义。这些目前应冻结，不能因为内部实现修复继续升 vN。
3. 当前门槛 Policy：性能百分比、样本数、p95、资源和产物等价规则。这些应独立于行为合同，策略变化使证据过期，不自动产生新 Contract。
4. 具体实现 Identity：EXE、CLI、Core、工具链、验证器、规则集、源码和内容的 SHA-256/组件摘要。身份变化应重新验证证据，不应伪装成 Schema breaking change。

最危险的三个现状：

- F-001 已完成最小兼容性 bugfix：Rust builder、Forge parser、Compile Doctor、板卡锁、Specification 和 bundled candidate manifest 现在统一使用当前 `v9`；历史 `v8` 仍被明确拒绝，不做 alias。
- 通用 FLFE 门禁与 ESP32 库专项脚本存在不同性能口径（通用资格 25%，专项脚本 20%）。两者的 workload scope 没有在一个权威策略入口统一表达，列为 **F-002 High**。
- NativeRelink certificate、board passport 和 package quality report 同时承载 Schema、行为合同、Policy 和 producer/content Identity，导致实现修复很容易被解释为合同升级，列为 **F-003 High**。
- Portable/local performance certificate 与 NativeRelink certificate 复用 `ck.forge.local-performance-certificate` 这个 `schemaId`，只靠 `schemaVersion=2/4` 区分，列为 **F-006 High**。

F-001 的修复没有创建 v10、没有迁移或伪造性能证据：bundled manifest 只保留候选边界，仍不能直接授予 Fast；不具备当前 v9 和完整身份的证据继续 fail-closed 到原生 Arduino CLI Release。

## 审计方法

扫描了 `docs/`、`docs/schemas/`、Rust (`apps/desktop/src-tauri/src`、`crates/ck_core/src`)、TypeScript/JavaScript 服务、Node/PowerShell 验证脚本和测试。搜索项包括：

```text
schema_version  schemaVersion  contract  contract_version
ruleset_version validator_version policy identity_schema evidence_version
v1 v2 v3 v4 v8 v9 v13
```

只把会被生产、读取、迁移、运行时判断、证据过期或授权门禁消费的版本纳入清单；纯 UI 文案和仅注释中的历史字符串不单列。内部缓存格式按职责分组，但仍登记其主要 owner 和消费者。

## Contract Inventory

下表是人类可读摘要；完整字段、生产者/消费者和证据路径在机器清单中保持一一对应。

| 当前名称 | 所在文件 | 当前版本 | 分类 | 生产者 | 消费者 | 运行时决策 | 证据失效 | 生命周期 | 风险 | 建议 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CK Project Format | `docs/schemas/ck-project.schema.json`; `apps/desktop/src-tauri/src/project.rs` | schema 1 / migration 1 | Schema | 工程序列化、迁移 | Workspace、恢复、导出 | 是 | 否 | ACTIVE | 低 | 保留 v1；只在导入边界迁移 |
| Project Submission | `docs/schemas/ck-project-package.schema.json`; `project_submission.rs` | schema 1 | Schema | 提交导出器 | 提交导入、验收报告 | 是 | 否 | ACTIVE | 低-中 | 与活动工程和内容 SHA 分离 |
| Legacy Block Package | `ck-blocks.schema.json`; `Validate-ImportablePackage.mjs` | schema 1 | Schema | 旧包作者 | 导入边界、ckpkg | 是 | 是 | RETIRED | 中 | 只读/迁移，不授予 V2 认证 |
| Block Package V2 | `ck-blocks-v2.schema.json`; `lib_custom_registry.rs`; `block_catalog.ts` | schema 2 | Schema | 声明式包工具 | 包门禁、目录、AI 元数据、generator | 是 | 是 | FROZEN | 高 | V2 保持严格；本轮不做 V3 |
| Declarative Generator | `ck-generator.schema.json`; `declarative_block_runtime.ts` | version 1 | Schema | 包作者 | 声明式运行时、包门禁 | 是 | 是 | ACTIVE | 中 | schema 保留 v1；实现用 digest |
| Board Package | `ck-board.schema.json`; 板卡护照文档 | schema 1 | Schema | 板卡包作者、导入门禁 | 板卡选择、引脚、Core、编译上传 | 是 | 是 | ACTIVE | 中 | 包格式与 Core/板卡身份分离 |
| Board Passport / `ck.lock` | `ck-board-lock.schema.json`; `board_passport.rs` | schema 1 + `certification_engine_contract` | MIXED / NEEDS_SPLIT | 护照生成器、认证生产器 | 板卡可用性、编译、引脚预检 | 是 | 是 | FROZEN | 高 | 保留 v1；未来拆 format、contract、producer/subject digest |
| Package Quality Report | `ck-package-quality-report.schema.json`; `package_quality.rs` | schema 2 | Schema | Rust/Node 验证器 | 导入、库管理器、质量 UI | 是 | 是 | ACTIVE | 高 | report schema 不随 validator/ruleset 一起升级 |
| Quality ruleset / validator / hash | `package_quality.rs`; `package-quality-gates.md`; `Validate-ImportablePackage.mjs` | validator 0.1.0; ruleset v2; contract SHA | MIXED / NEEDS_SPLIT | 验证器 | 包授权和 UI | 是 | 是 | ACTIVE | 高 | 门槛用 Policy；实现和规则内容用 digest；旧报告重新检查 |
| Package Migrations | `ck-migrations.schema.json`; `Validate-ImportablePackage.mjs` | schema 1 | Schema | 迁移作者 | 包导入边界 | 是 | 否 | ACTIVE | 低 | 只允许数据迁移，拒绝可执行迁移 |
| `ckpkg` CLI | `scripts/ckpkg.mjs`; Extension SDK | 1.0.0 | Identity | SDK 发布流程 | 扩展作者和 CI | 否 | 否 | ACTIVE | 低 | 工具版本保留，认证时绑定可执行文件/规则 digest |
| Extension SDK release channel | `ck-extension-sdk-release-channel.schema.json` | schema 1；SDK 1.0.0 | Schema | SDK 发布流程 | SDK 安装/发布检查 | 否 | 是 | ACTIVE | 低-中 | artifact URL、bytes、SHA-256 属于 Identity |
| Extension SDK artifact sidecar | `ck-extension-sdk-release-artifact.schema.json` | schema 1 | Schema | SDK 发布流程 | 发布完整性检查 | 否 | 是 | ACTIVE | 低 | 与包质量报告版本解耦 |
| CK Forge engine | `ck-forge/v1`; `ck_forge.rs`; Compile Doctor | engine/schema/product 1 | Contract | Forge runtime | 编译路由、资格、诊断 | 是 | 是 | FROZEN | 中 | 冻结公共行为；实现变化只更新 identity |
| PortableFast experimental route | `demo.rs`; `Evaluate-CKForgePerformanceGate.cjs`; portable lane doc | profile `portable-fast`；历史 recipe/policy IDs | Contract | 历史 FLFE runner、profile selector | 历史验证器、profile selector | 是 | 是 | RETIRED | 中 | 只保留历史读取/拒绝，不生成新证据或扩展路线 |
| Fast/build contract | `demo.rs`; `ck_forge.rs`; Compile Doctor; board-lock schema | 当前统一 v9；历史 v8 仅拒绝 | MIXED / NEEDS_SPLIT | Rust builder、Forge | 缓存、证书、Compile Doctor、资格 | 是 | 是 | FROZEN | 高（已修复分裂） | 以 builder marker 为权威；旧 v8 证据重新资格化，不创建 v10 |
| Toolchain identity | `demo.rs`; `toolchain_identity.rs`; `ck_forge.rs` | identity key v13；cache schema 6 | MIXED / NEEDS_SPLIT | 身份扫描器、缓存写入器 | 缓存、资格绑定、诊断 | 是 | 是 | ACTIVE | 高 | v13 作为历史输入；未来组件摘要化，缓存 schema 在边界演进 |
| Forge built-in qualification manifest | `ck-forge-qualification-manifest.schema.json`; `ck_forge.rs`; bundled manifest | schema 2；当前 contract v9；候选-only | MIXED / NEEDS_SPLIT | 资格清单生成器 | 内置资格解析器、Forge 路由 | 是 | 是 | FROZEN | 中（已修复分裂） | manifest 只描述候选边界；性能证据仍必须由当前 loader 独立验证 |
| Forge performance evidence formats | `ck-forge-performance-ab-candidate.schema.json`; qualification report; local certificate | candidate/report schema 4；local certificate schema 2 | Schema | performance evaluator、证书安装器 | 性能门禁和证据加载 | 是 | 是 | FROZEN | 高 | 保持数据格式与 Policy/Identity 分离 |
| Forge artifact set/bundle | `ck-forge-qualification-artifact-set.schema.json`; artifact bundle schema | schema 1 / 1 | Schema | artifact capture/evaluator | 产物等价门禁、证书验证 | 是 | 是 | FROZEN | 中 | policy ID 独立，不升 build Contract |
| Forge regression report | `ck-forge-regression-report.schema.json`; `Run-CKForgeRegression.cjs` | outer schema 2；nested v1 | Schema | cross-board runner | regression verifier、历史摘要 | 是 | 是 | FROZEN | 中 | 只在报告边界读取版本 |
| FLFE performance policy | `ck_forge.rs`; `Evaluate-CKForgePerformanceGate.cjs`; `Run-CKForgeNativeAB.cjs` | policy v3；通用门槛 25% | Policy | 资格 runner、Forge 常量 | 资格 key、Fast 授权 | 是 | 是 | FROZEN | 高 | Policy 独立；改变门槛只使证据过期 |
| ESP32 library performance policy | `Run-CKEsp32LibraryEditRegression.cjs` | 专项 policy v1；20% | Policy | ESP32 专项 runner | 专项报告和回归验证 | 是 | 是 | FROZEN | 高 | 明确仅为专项 workload，不得冒充通用资格 |
| NativeRelink certificate | certificate v4；local certificate v2；binding v3 | Schema + binding + contract/policy | MIXED / NEEDS_SPLIT | 资格评估、证书安装 | Fast 路由、报告、护照 | 是 | 是 | FROZEN | Critical | 保留旧格式；未来统一 Envelope，旧证据只重新验证 |
| Certification engine contract | board-lock 字段；各 adapter engine ID | AVR v2；SAMD/ESP32 phase1 v1 | MIXED / NEEDS_SPLIT | 护照生成器、NativeRelink adapter | 证书、资格、板卡锁 | 是 | 是 | FROZEN | 高 | 冻结 adapter；分离能力语义与 producer identity |
| ESP32 library evidence | `esp32_library_relink.rs`; ESP32 regression runner | manifest/evidence v4；policy v1 | MIXED / NEEDS_SPLIT | Rust 证据捕获、runner | 专项验证、诊断 | 是 | 是 | FROZEN | 中-高 | 保持资格专用，不扩成通用路线 |
| NativeRelink manifest | `native_relink.rs`; SAMD/STM32 adapters | AVR manifest v3；SAMD/STM32 phase1 v1；translation/access v1 | MIXED / NEEDS_SPLIT | Rust NativeRelink adapters | NativeRelink gate、资格工具 | 是 | 是 | FROZEN | 高 | 只做 correctness/security/fallback 修复，不加新 adapter |
| Release Core seed | `release_core_seed.rs` | manifest/certificate schema 1；engine v1 | MIXED / NEEDS_SPLIT | Rust core seed | Core 对象复用门禁 | 是 | 是 | FROZEN | 中 | 内部证据，不升级为公共合同 |
| Recipe capability | `recipe_capability.rs`; `Run-CKForgeNativeAB.cjs` | capability schema 2；artifact manifest 1 | Schema | native baseline analyzer | 资格候选评估 | 是 | 是 | FROZEN | 中 | 观察结果永不直接授权 Fast |
| Artifact equivalence policies | generic/AVR/ESP32/compile-only policy IDs | policy IDs v1/v2 | Policy | Forge/runner | 产物门禁、证书验证 | 是 | 是 | FROZEN | 中 | 保留 policy ID，集中 owner；不升 build contract |
| Compile diagnostics / Doctor | `compile_doctor.ts`; `lib.rs` | diagnostics schema 1；doctor report schema 2 | MIXED / NEEDS_SPLIT | Rust diagnostics、桌面 Doctor | Workspace UI、资源/路由解释 | 是 | 否 | ACTIVE | 高 | UI 只消费规范化结果，不能自行授权 Fast |
| Regression/batch reports | `Run-CKEsp32...`; `Run-CKAvr...`; batch verifiers | 多个 plan/report/fixture/batch v1；AVR topology v2 | Schema | Node regression runners | 验证器、历史摘要 | 是 | 是 | FROZEN | 中 | 只保留 runner 边界；不以报告版本授予 Fast |
| Internal cache/recovery/upload formats | `demo.rs`; recovery/checkpoint/upload/diagnostic services | hotset 2、build meta 3、toolchain 6/7、其他多为 1 | Schema | 构建、恢复、上传服务 | cache/recovery/upload/诊断 | 是 | 是 | ACTIVE | 中 | 不在本轮合并；以后集中边界适配 |
| Build/content identities | build signature、property/source/content SHA-256 | digest fields | Identity | builder/evidence producers | 缓存、证书、产物和包门禁 | 是 | 是 | ACTIVE | 中 | 明确 digest scope；实现变化不自动升 Contract |
| Library Package Metadata | `ck-library.schema.json`; library importer | 无显式 `schema_version` | Schema | `library.properties` 导入器、包作者 | 库管理器、质量门禁、编译解析 | 是 | 是 | ACTIVE | 中 | 先记录当前形状；有真实迁移需求再加兼容字段 |

## 版本判断泄漏

以下是已经确认的业务层/验证器层分支。它们不在本轮重构，但必须作为后续迁移顺序：

| 位置 | 观察 | 风险 |
| --- | --- | --- |
| `scripts/Validate-ImportablePackage.mjs`、`scripts/ckpkg.mjs` | 在导入/质量边界区分 block schema v1/v2 | 位置合理，但应输出一个 normalized package，避免下游继续判断版本 |
| `apps/desktop/src-tauri/src/lib_custom_registry.rs` | 目录、元数据完整度和 output contract 多处直接判断 `manifest.schema_version == 2` | 高；目录业务层认识 V1/V2，未来会出现分支漂移 |
| `apps/desktop/src/services/block_catalog.ts` | 将 v1 适配成 `v1-adapted`、v2 作为原生路径 | 中；应由边界 decoder 产出统一目录模型 |
| `scripts/Report-CKForgeFastQualifications.cjs` | 直接分支 certificate schema v4 与旧 v2 | 高；虽然旧证书不能授权 Fast，但历史读取/拒绝逻辑应集中 |
| `scripts/Verify-CKAvrFullQualificationBatch.cjs` | 直接硬查 evidence schema v2、certificate schema v4、report schema v1 | 中-高；验证器重复知道多个格式版本 |
| `ck_forge.local-performance-certificate` | Portable/local certificate schema v2 与 NativeRelink certificate schema v4 复用一个 schemaId | 高；证书族边界依赖版本分支，未来容易误读 |
| `apps/desktop/src/services/compile_doctor.ts` | 诊断 schema/report 版本与当前 Forge contract 共同决定 UI 证据有效性 | 高；展示层不应成为授权真值 |
| `crates/ck_core/src/builder/demo.rs` | cache schema、toolchain identity 和 property contract 在 builder 内直接比较 | 中；缓存边界可以这样做，但需与公共合同区分 |
| `Workspace`、上传器、恢复、AI、library manager | 未发现新的独立 `schema_version` 授权轴；主要通过服务/报告结果消费 | 当前风险较低，但迁移后应只消费 Canonical model |

理想迁移顺序仍是：

```text
decode -> validate -> migrate -> normalize -> canonical model -> business logic
```

## 审计发现

### F-001：Fast/build contract v8/v9 分裂（已修复）

- 根因是 Forge 中残留了独立的 v8 常量/manifest，而 Rust builder 与其他消费者已进入 v9；同一份资格输入在不同层被不同合同解释。
- 修复后 `current_forge_contract_id()` 直接返回 builder 的 `FAST_BUILD_CONTRACT_SIGNATURE_MARKER`；bundled manifest 的 `contract_id` 与该值一致，Compile Doctor、board-lock 和 Specification 也由同一值约束。
- v9 增加了 native file/path identity 证据约束，是实现/证据身份强化；本轮没有证明对外行为语义 breaking。因此不把 v8 alias 成 v9：v8 manifest、certificate、passport、report 只能作为历史输入并被当前授权拒绝，必须重新资格化。
- manifest 没有 `performance_ab`，仍是 candidate-only；修复没有迁移性能证据，也没有放宽任何 Fast、FQBN、Core、toolchain、artifact 或 hash 门禁。
- 回归结果：Forge 集成测试 49/49；跨层 Node 检查 16/16。错误/历史 v8 输入均保持 `force-platform` / native Release。

### F-002 High：性能 Policy 有不同工作负载口径

通用 Forge/AVR 门禁要求中位数至少 25% 且绝对收益至少 500 ms，同时 p95 不回退、CV 不超过 20%；ESP32 库专项 runner 另有 20% 的 same-graph edit 门槛。专项结果不能直接授予通用板卡 Fast 资格。应保留不同 `policy_id`，并显式记录 workload scope。

### F-003 High：证书/护照混合四类职责

`ck-board-lock.schema.json` 的 `certification_engine_contract`、NativeRelink certificate、package quality report 的 validator/ruleset/hash 同时影响格式解析、行为判断、门槛和内容身份。实现修复因此容易造成大范围版本升级和证据失效。未来拆分前，继续使用现有字段并 fail-closed。

### F-004 High：toolchain v13 是身份 key，不是行为合同

`ck_toolchain_cache_key_v13_portable_inputs` 与持久化 toolchain cache schema 6/目录 v6 是不同职责。Core、CLI、编译器或扫描器内容变化应由组件 digest 使证据过期；不能把扫描器实现变化直接升级 Fast/build Contract。

### F-005 Medium：版本判断泄漏到业务服务

`lib_custom_registry.rs`、`block_catalog.ts`、`ckpkg.mjs`、资格报告脚本和 Compile Doctor 直接认识 v1/v2/v4。导入边界这样做是合理的，目录、UI 和报告消费层不应继续自己判断历史版本。阶段 2 再集中 decoder/normalizer。

### F-006 High：两个证书族复用一个 schemaId

Portable/local performance certificate 使用 `ck.forge.local-performance-certificate` + schema v2；NativeRelink certificate 复用相同 schemaId + schema v4。当前靠版本和字段交叉拒绝，未来容易被新消费者误读。后续可给证书族不同稳定 Schema ID，或统一小型 Envelope 的 `kind` 字段；本轮不改格式。

## 必须保留、冻结、改成 Policy 或 digest 的范围

### 必须保留的 Schema 轴

- CK Project Format v1、Project Submission v1、Board Package v1、Board Lock v1。
- Block Package V2、Declarative Generator v1、Package Quality Report v2、现有迁移输入。
- 上传清单、恢复稿、检查点、诊断包等真正持久化格式。

保留不等于永久不变：不兼容的数据结构才升级 Schema，并且必须有迁移或明确拒绝。

### 必须冻结的 Contract/证据路线

- `ck-forge/v1` 的公共路由和原生回退语义。
- FLFE/NativeRelink 的现有行为合同、adapter ID、证书和 qualification 证据路线。
- V2 Block Package 的声明式、fail-closed、机器证据边界。

冻结期间只允许 correctness、security、fallback、regression 和兼容性修复。不要新增板卡资格体系、adapter、certificate schema、Fast 路线。

### 应保持为 Policy 的内容

- 性能门槛、样本数、p95/CV、绝对毫秒收益。
- 质量规则、许可证和依赖门槛。
- 产物角色和内容等价规则。

Policy 变化应该使匹配证据过期并要求重新验证；不应自动把 build/certificate Contract 升到下一个 vN。

### 应保持为 Identity/digest 的内容

- production EXE、Rust/Node runner、Arduino CLI、Core、编译器、SDK、分区和 linker 输入。
- validator/ruleset 内容、源码树、包内容、板卡菜单和库树。
- `buildSignature`、`propertyContractSha256` 以及 artifact/source/content SHA-256 的明确输入范围。

实现变化的默认动作是更新 producer/subject/environment identity，并重新验证证据。

### MIXED / NEEDS_SPLIT

优先级最高的是 Fast/build contract、NativeRelink certificate、board passport 的 `certification_engine_contract`、toolchain identity、package quality report 的 validator/ruleset/hash、Compile Doctor 诊断授权判断。它们本轮只登记，不重构。

另外，`ck-library.schema.json` 当前没有显式 `schema_version`。这不是本轮要强行补一个版本的理由；先保持现状并记录，只有真实 breaking 需求出现时才增加兼容字段。

## 最小修复方案

### 阶段 1：本轮，文档和机器清单

- 已建立本报告和 [`docs/specification/contracts.json`](specification/contracts.json)。
- 将合同家族、版本创建门和 FLFE 冻结规则放入 [contract-governance.md](contract-governance.md)。
- Specification 人类索引和机器索引引用本审计清单；测试验证清单存在、唯一 ID 和生命周期值。
- 不改运行时格式，不删历史证据，不新增 vN。

### 阶段 1.1：只做明显 bugfix（F-001 已完成）

- 单独处理 F-001：已将 bundled candidate manifest 对齐当前 v9；历史 v8 不再作为当前资格输入，也未建立兼容 alias。
- 已加入跨 Rust builder、Forge parser、Compile Doctor、board-lock schema、Specification 和 manifest 的一致性测试，以及历史 v8/错误合同拒绝测试。
- 该项属于 **兼容性 bugfix**，不是合同框架重构；现有性能证据不因这次修复被伪造或自动升级，需按当前身份重新验证。

### 阶段 2：边界集中

- 为 Project、Block Package、Board/Lock、Quality Report、Certificate 和 regression report 各自提供 decode/validate/migrate/normalize 入口。
- 下游逐步改成 Canonical model，删除 `schema_version == N` 的业务分支。
- 先迁移只读报告和包目录，再迁移编译/上传授权，始终 fail-closed。

### 阶段 3：证据收口

- 设计一个小型 Evidence Envelope，只承载公共 producer/subject/environment/status/expiry/digest 字段。
- 现有专用结果先双写/回读，再切换消费者；不强行抹平各类产物证据。

## 本轮明确不做

- 不创建“CK Unified Contract Framework”。
- 不做 Block Package V3，不重写现有 V2。
- 不改 FLFE 性能门槛来制造绿色结果。
- 不把旧证书、旧 EXE、旧 Core 或旧规则集重新标成当前有效。
- 不因实现修复自动新增 Contract vN。

## 机器清单与审计测试

机器清单：[`docs/specification/contracts.json`](specification/contracts.json)。

建议验证命令：

```powershell
node --test scripts/Validate-ContractInventory.test.mjs scripts/Validate-SpecificationIndex.test.mjs scripts/Validate-PackageSchemas.test.mjs
```
