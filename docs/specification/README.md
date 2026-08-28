# CK Specification 索引

版本：1.0。更新时间：2026-08-25。

这里是 CK 文件格式、扩展合同和证据边界的统一入口。它解决“规范散落在很多文档里”的问题，不重新复制各 Schema，也不把内部实现自动升级为公开承诺。

## 规范状态

- **Normative（正式合同）**：生产代码和验证器已经消费；不兼容变更必须提升 schema/version，并提供迁移或明确拒绝。
- **Stable local（本机稳定合同）**：用于 CK 本机证据或提交容器；尚无发布者签名/跨机器认证中心。
- **Internal（内部合同）**：实现已经稳定，但尚未承诺第三方直接生成；外部工具不得依赖未公开字段。
- **Deferred（延期）**：只有设计，不属于当前产品合同。

机器可读索引见 [`index.json`](index.json)。

合同版本治理见 [`contract-governance.md`](../contract-governance.md)。除非存在不可兼容的机器可读变化，新增需求必须扩展现有合同家族，不得创建新的独立版本生命周期。

合同收口的实施计划见 [`contract-convergence-project.md`](../contract-convergence-project.md)。该项目文档不是新的运行时合同，迁移完成前不改变现有格式或证书路径。

仓库级合同盘点见 [`contracts.json`](contracts.json) 和 [`合同版本审计报告`](../contract-inventory.md)。该清单是只读的内部治理证据，不参与运行时授权；它登记每个版本概念的分类、生产者、消费者、证据失效关系和生命周期，防止后续新增未登记的版本轴。

## 1. 工程与提交

| 合同 | 版本 | 状态 | 文档/Schema | 边界 |
| --- | --- | --- | --- | --- |
| CK Project Format | v1 | Normative | [`ck-project-format-v1.md`](../ck-project-format-v1.md)、[`ck-project.schema.json`](../schemas/ck-project.schema.json) | `.ck` 是可编辑单文件工程；旧 `.maker` 可迁移，不默认内嵌检查点、构建历史或报告 |
| CK Project Submission | v1 | Stable local | [`project-submission-format.md`](../project-submission-format.md)、[`ck-project-package.schema.json`](../schemas/ck-project-package.schema.json) | `project.ckpkg` 是只读提交/传输容器，不是活动工程；完整性不等于发布者签名 |
| 工程检查点 | v1 | Internal | [`current-feature-inventory.md`](../current-feature-inventory.md) | 本机有界保护点，不是 Git 或跨机版本管理协议 |
| 滚动恢复稿 | v1 | Internal | [`recovery-drafts-v1.md`](../recovery-drafts-v1.md) | 自动只提示最新有效稿；旧稿不排队，同会话抑制不等于删除，所选稿保留到正式保存 |

## 2. 第三方板卡

| 合同 | 版本 | 状态 | 文档/Schema | 边界 |
| --- | --- | --- | --- | --- |
| CK Board Package | v1 | Normative | [`ck-board.schema.json`](../schemas/ck-board.schema.json) | 描述精确板卡包、Core 策略、完整配置、引脚和有限验证 profile |
| CK Board Passport/Lock | v1 | Stable local | [`third-party-board-passport.md`](../third-party-board-passport.md)、[`ck-board-lock.schema.json`](../schemas/ck-board-lock.schema.json) | 四级证据绑定包内容、完整 FQBN、Core 和工具链；本机证据不是 CK 官方认证 |

## 3. 第三方积木与原生库

| 合同 | 版本 | 状态 | 文档/Schema | 边界 |
| --- | --- | --- | --- | --- |
| CK Library Manifest | v1 | Normative | [`ck-library.schema.json`](../schemas/ck-library.schema.json) | 包身份、版本、许可证和入口基础合同 |
| CK Block Contract | v1/v2 | Normative | [`blockly-library-package-standard.md`](../blockly-library-package-standard.md)、[`ck-blocks.schema.json`](../schemas/ck-blocks.schema.json)、[`ck-blocks-v2.schema.json`](../schemas/ck-blocks-v2.schema.json) | v2 描述语义、依赖、输出、硬件、生成、约束、示例和错误；发布者声明不等于真板证据 |
| CK Declarative Generator | v1 | Normative | [`ck-generator.schema.json`](../schemas/ck-generator.schema.json) | 只允许受限数据模板；Legacy JavaScript 不执行 |
| CK Package Migration | v1 | Normative | [`block-package-migration-v1.md`](../block-package-migration-v1.md)、[`ck-migrations.schema.json`](../schemas/ck-migrations.schema.json) | 只允许确定性纯数据迁移，必须 dry-run、检查点和事务回滚 |
| CK Package Quality Report | v2 | Stable local | [`package-quality-gates.md`](../package-quality-gates.md)、[`ck-package-quality-report.schema.json`](../schemas/ck-package-quality-report.schema.json) | 本机静态质量报告，不证明作者身份、许可证法律结论、真实编译或真板运行 |
| CK Block Evidence Passport | v1 | Stable local | [`block-package-evidence-passport.md`](../block-package-evidence-passport.md) | 轻量汇总结构、语义、安全运行、编译和真板证据；缺证保持待验证，不打综合分 |

## 4. 开发者工具

| 合同 | 版本 | 状态 | 文档/Schema | 边界 |
| --- | --- | --- | --- | --- |
| `ckpkg` CLI | 1.0.0 | Normative | [`extension-sdk/ckpkg.md`](../extension-sdk/ckpkg.md) | `create/validate/test/compile/pack`；compile-only 永不上传 |
| CK Extension SDK | 1.0.0 | Stable local | [`extension-sdk/README.md`](../extension-sdk/README.md)、[`extension-sdk/LICENSE`](../extension-sdk/LICENSE)、[`release-channel.json`](../extension-sdk/release-channel.json)、[`release channel Schema`](../schemas/ck-extension-sdk-release-channel.schema.json) | SDK 聚合采用 Apache-2.0；本地发布地址已定义，公开 HTTPS 地址尚未填写，不编造 URL |
| CK Forge Build Foundation & Regression / FLFE | v1 / 普通资格策略 v3（报告 v4）/ NativeRelink 本机证书 v4（绑定 v3） | Stable local | [`ck-forge-v1.md`](../ck-forge-v1.md)、[`FLFE 性能资格与原生底线`](../ck-forge-flfe-portable-lane.md)、[`A/B 不回退门禁`](../ck-forge-performance-no-regression-gate.md)、[`candidate identity manifest`](../../apps/desktop/src-tauri/src/ck_forge_qualified_targets.v1.json)、[`candidate manifest schema`](../schemas/ck-forge-qualification-manifest.schema.json)、[`current certificate audit`](../../scripts/Report-CKForgeFastQualifications.cjs)、[`local certificate schema v2`](../schemas/ck-forge-local-performance-certificate.schema.json)、[`NativeRelink certificate schema v4`](../schemas/ck-forge-native-relink-certificate.schema.json)、[`artifact set schema`](../schemas/ck-forge-qualification-artifact-set.schema.json)、[`regression schema`](../schemas/ck-forge-regression-report.schema.json) | FLFE 只对绑定所查 production EXE 且通过 `simple → complex → medium → simple-return` 四阶段正确性与性能门禁的精确证书启用 Fast。资格门槛、试验次数和绝对收益由运行时策略、证书 schema 与审计脚本共同决定；本文不把旧 EXE 的阈值、数量或哈希当作当前状态。普通 v4 报告仍只显示为 `source-bound-sample-qualification`，不增加整板 Fast 数量。当前数量由审计脚本运行时复算，不能由旧文档或历史 EXE 证书推断。ESP32-C3/C5/C6/S3/H2/P4 与 Feather S3 未持当前证书时显示“Fast 待验证”，不是不兼容，并继续使用原生 Arduino CLI Release。候选身份、兼容回归、Exact 和历史证书均不授予整板 Fast；普通编译资格不继承为上传资格。v4 本地完整性不替代发布者签名。 |

## 5. 构建、上传与证据

| 合同 | 状态 | 文档/实现 | 边界 |
| --- | --- | --- | --- |
| 缓存/构建身份 | Internal | [`compiler-and-package-regression-baseline.md`](../compiler-and-package-regression-baseline.md) | 绑定源码、依赖、Core、工具链、完整 FQBN 和分区；第三方不应伪造内部缓存记录 |
| 上传产物清单 | Internal | [`upload_artifact_manifest.rs`](../../apps/desktop/src-tauri/src/upload_artifact_manifest.rs) | ESP32/AVR 在写入前校验角色、地址、大小和 SHA-256；完整性不是发布者身份 |
| 上一个可用版本 | Stable local | [`last-working-version-and-diagnostics.md`](../last-working-version-and-diagnostics.md) | 绑定工程、依赖、构建、固件和真机证据；恢复不能绕过安全门禁 |
| 发布证据清单 | Internal | [`release-evidence-manifest.md`](../release-evidence-manifest.md) | 只裁决同一冻结源码、EXE、安装包、原生和真板证据；旧清单不能覆盖后续源码修改 |

## 6. 版本与兼容规则

1. 每个正式 JSON 合同必须有 `schema_version` 或同等明确版本字段。
2. 读取器只自动迁移已知旧版本；未知未来 major/schema 必须 fail-closed。
3. 迁移不得丢弃未知字段、修改原文件后再报告失败，或静默改用默认板卡/Core。
4. Hash 只证明内容完整性；作者身份需要独立签名体系。
5. compile-only、真板、发布者签名和 CK 官方认证始终是不同证据等级。
6. `.ck`、`project.ckpkg`、诊断 ZIP、检查点和可用版本各有不同用途，不互相冒充。

## 7. 延期合同

以下尚未成为正式 Specification：

- `.cktrace` 串口黑匣子格式。
- CK Lab 课程/作业策略。
- 受约束 AI 工具协议。
- 发布者证书、撤销与 CK 官方认证服务。
- 跨机器自动物化 Core/工具链/依赖的复现包。

进入正式规范前，必须先有最小实现、恶意输入边界、版本迁移和机器可读测试，不允许只有文档就宣称已上线。
