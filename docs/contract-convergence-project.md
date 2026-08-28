# CK 合同收口项目

状态：项目立项，尚未迁移运行时。更新时间：2026-08-25。

本文件是一个工程治理项目，不是新的 Schema、Contract 或 Version。它的目的，是把现有多个版本轴收敛到少数稳定的合同家族，避免安全门禁之间互相解释、互相放行或互相失效。项目完成前，现有格式和证据继续按原合同运行；任何兼容性变化必须保持 fail-closed。

## 项目目标

1. 只有持久化机器可读数据格式拥有 `schema_version`。
2. 运行行为使用稳定 `contract_id`，行为实现变化使用实现身份和哈希，不因为普通重构自动升合同版本。
3. 门禁判据使用 `policy_id`，不把性能阈值、质量规则和行为合同混成一个版本。
4. EXE、CLI、validator、Core、工具链和规则集使用 SHA-256 等证据身份，身份变化只使证据过期，不自动升级合同。
5. 所有输入在边界完成 `decode → validate → migrate → normalize`，核心逻辑只消费 Canonical Internal Model，不散落 `schema_version == N` 分支。
6. 编译、上传、板卡、包质量、性能和上一个可用版本共用一个 Evidence Envelope，重复的 producer、subject、environment、status 和 provenance 只定义一次。

## 当前版本轴盘点

以下是立项时的初始清单。它不是新的运行时真值；迁移前不得删除或重命名现有字段。

| 当前名称 | 初始分类 | 收口目标 | 当前动作 |
| --- | --- | --- | --- |
| CK Forge v1 | 运行行为 | `build/arduino-compatible-1` | 冻结公共行为名，内部实现继续独立演进 |
| qualification schema v2 | 持久化数据格式 | 归入资格清单 Schema | 保留格式版本，补家族归属 |
| NativeRelink certificate v4 | 持久化证据格式 | 归入 Evidence Envelope 的 certificate 结果 | 不因实现修复自动升版本 |
| certification engine contract v5 | 混合轴 | 拆为认证行为合同 + producer/evidence identity | 先画消费者关系，再迁移 |
| Fast build contract v8/v9 split | 运行行为/实现混合轴 | 归入 `build/arduino-compatible-1` + implementation digest | F-001；先统一内置资格与当前运行时，禁止创建 v10 |
| toolchain identity schema v13 | 身份快照格式 | 组件数组 + 统一身份 Envelope | 允许新增已知 component，不默认升 major |
| performance policy v3 | 门禁判据 | `portable-edit-v3` | 保持 policy 独立，不写进 build contract 版本 |
| package quality report v2 | 持久化数据格式 | Quality Report Schema | 与 ruleset/policy 分开记录 |
| block schema v2 | 持久化数据格式 | Block Package Schema | 保留 v2，后续只做兼容扩展 |
| package quality ruleset v2 | 门禁判据 | `package-validation/declarative-safe-1` + ruleset identity | 不与 report schema 共用版本号 |

迁移期间每一项都必须标记生命周期：`ACTIVE`、`FROZEN` 或 `RETIRED`。`RETIRED` 只允许作为迁移或历史证据输入，不得生成新的绿色授权。

## 目标合同分层

### 1. 持久化格式

只有这些对象使用 `schema_version`：`.ck`、`ck.lock`、`ck-blocks.json`、板卡包、质量报告、证据 Envelope 和迁移输入。未知未来 major 必须拒绝；已知旧版本只能在边界迁移到当前 Canonical Form。

### 2. 运行行为

运行行为使用稳定的 `contract_id`，例如：

```text
build/arduino-compatible-1
package-validation/declarative-safe-1
board-certification/local-certification-1
recovery/local-checkpoint-1
```

只有旧消费者无法安全解释、会导致错误授权/上传/产物或安全边界改变的 breaking change，才允许升级 `contract_id` 的 major。

### 3. 门禁策略

性能和质量判据单独使用 `policy_id`，例如 `portable-edit-v3`。阈值从 20% 调到 25%、样本数变化或 p95 规则变化，应更新 policy 和证据，不得伪装成新的 build contract。

### 4. 实现与证据身份

EXE、CLI、validator、Core、工具链、规则集、源码和配置使用 digest/identity。实现重新编译、增加安全检查或补充 linker script 时，先更新组件身份和证据失效条件；只有持久化格式或行为真的不兼容，才考虑版本升级。

## Compatibility Epoch

目标引入 `CK Compatibility Epoch 1` 作为整套合同组合的兼容边界。Epoch 不取代各持久化格式版本，也不把所有对象强行改成 v1；它只回答“这些 Canonical Model 能否在同一 CK 世界中互相工作”。

Epoch 1 的初始组合：

```text
Project Schema       v1
Block Package Schema v2
Generator Schema     v1
Board Package Schema v1
Quality Report       v2
ck.lock              v1
```

启动或导入流程先校验 Epoch 组合，再执行单项迁移/重新验证/拒绝。Epoch 变化必须有全局迁移说明和完整回归，不能由某个模块私自判断。

## Canonical Internal Model

读取器只在边界处理旧格式：

```text
decode → validate → migrate → normalize
                         ↓
                 CanonicalProject
                 CanonicalPackage
                 CanonicalBoard
                 CanonicalBuildIdentity
                 CanonicalEvidence
```

编译器、上传器、UI、恢复、板卡护照和 AI 消费者禁止散落按版本号分支。版本判断、未知字段策略、默认值、迁移和拒绝原因集中在各自 decoder/normalizer；下游只认一种 Canonical 结构。

## Evidence Envelope

后续证据统一收口为一个 Envelope；本项目阶段只立合同，不立即替换现有报告：

```json
{
  "evidence_schema": 1,
  "kind": "compile",
  "producer": {},
  "subject": {},
  "environment": {},
  "result": {},
  "artifacts": [],
  "created_at": ""
}
```

`kind` 可以是 `compile`、`upload`、`package-validation`、`board-device` 或 `performance`。各类专用结果放在 `result`，公共的来源、过期、哈希和状态只在 Envelope 定义一次。旧报告先作为迁移输入，不能因为包装成 Envelope 就自动恢复认证。

## 实施阶段

### 阶段 A：只读盘点与冻结

- [x] 建立 `docs/specification/contracts.json` 审计清单，只记录版本轴的分类、消费者、失效关系和生命周期；它是治理资料，不是运行时注册表。
- [ ] 为每个当前版本轴指定唯一 owner、消费者、输入输出和失效条件。
- [ ] 将 FLFE/NativeRelink 相关公共行为标记为 `FROZEN`；只允许安全修复、回归修复、兼容修复和原生回退修复。
- [ ] 禁止新增未登记的 `vN`、`contract_sha256` 或重复过期判断。

### 阶段 B：统一身份与索引

- [ ] 为工具链身份改成组件数组模型；旧 v13 作为迁移输入，当前读写器只产出 Canonical 身份。
- [ ] 将认证引擎版本拆成认证行为合同和 producer/evidence identity。
- [ ] Specification 人类索引、机器索引和 `contracts.json` 三者由同一检查测试校验。
- [ ] 增加版本/合同影响搜索，发现重复消费者后再改代码。

### 阶段 C：边界迁移

- [ ] 为 `.ck`、包、锁文件、质量报告、证书和历史性能报告建立统一的 decode/validate/migrate/normalize 入口。
- [ ] 先在测试夹具中覆盖旧版本、未知版本、缺字段、错误 hash、错误 Epoch 和错误 producer。
- [ ] 下游逐步改为 Canonical Model；每迁移一个消费者就删除对应的散落版本分支。

### 阶段 D：证据收口

- [ ] 设计 Evidence Envelope Schema，并保留各类 `result` 的专用约束。
- [ ] 编译、上传、板卡、包质量、性能和上一个可用版本先双写/回读，再切换消费者。
- [ ] 统一证据过期判断：合同定义“什么叫有效”，producer/subject/environment digest 定义“这次是否仍有效”。

### 阶段 E：发布门禁

- [ ] 所有公共合同都有唯一 Specification 条目、Schema/Contract owner、生命周期和迁移/拒绝测试。
- [ ] 旧 EXE/Core/工具链/validator/hash 只能标历史，不能跨 Epoch 或跨 producer 授权。
- [ ] 运行完整 Schema、Specification、证书、路由、上传和回归测试后，才允许更新安装包和发布证据。

## 完成判据

本项目只有在以下条件全部满足时才算完成：

1. 仓库中所有公共版本号都能在 Registry 中找到唯一分类和 owner。
2. 新增一个安全检查不会要求无理由创建新的 build/certificate/toolchain contract 版本。
3. 核心下游不再按 `schema_version` 分支，只消费 Canonical Model。
4. 证据有效性由合同 + producer/subject/environment digest 共同决定，旧证据不会被新 EXE 冒充复用。
5. 未知未来版本、错误 Epoch、错误 hash 和迁移失败均可解释地 fail-closed。
6. Specification、Registry、Schema、验证器、测试和用户功能清单保持一致。

## 明确不做

- 不为了治理而创建“统一合同框架 v1”。
- 不立即重命名现有文件、证书目录或历史报告。
- 不删除历史证据，不把历史版本伪装成当前版本。
- 不放宽 hash、路径、产物、Core、FQBN 或上传安全门禁。
- 不在迁移完成前同时维护两套互相独立的“当前真值”。
