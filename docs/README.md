# CK 文档入口

更新时间：2026-08-26。

这里是 CK 文档的维护入口。当前状态只看运行时证据和 `current-feature-inventory.md`，历史报告中的 EXE 哈希、资格数量和测速结果不能直接代表当前安装包。

## 当前使用

- [当前功能总清单](current-feature-inventory.md)：产品能力、边界和证据的单一状态索引。
- [CK 1.0 现有功能审核清单](CK-1.0-feature-review-checklist.md)：按实际界面入口说明“在哪里、怎么用、看到什么、有什么边界”的老板版功能地图。
- [CK Specification 索引](specification/README.md)：正式合同、本机稳定合同、内部合同和延期合同。
- [合同版本治理](contract-governance.md)：禁止无必要的新版本轴，规定合同家族、兼容和变更门。
- [合同收口项目](contract-convergence-project.md)：分阶段盘点、冻结、迁移 Canonical Model 和统一证据 Envelope。
- [合同版本审计报告](contract-inventory.md)：仓库级 Schema / Contract / Policy / Identity 盘点和风险清单。
- [机器可读合同清单](specification/contracts.json)：只读治理清单，不参与运行时授权。
- [第三方包质量门禁](package-quality-gates.md)：板卡包、积木库和 Arduino ZIP 的导入检查。
- [积木库包标准](blockly-library-package-standard.md)：v1 兼容和 v2 语义元数据。
- [第三方板卡护照](third-party-board-passport.md)：板卡、Core、FQBN、引脚和验证证据。
- [CK Project Format v1](ck-project-format-v1.md)：`.ck` 工程格式和迁移边界。
- [Extension SDK](extension-sdk/README.md)：`ckpkg` CLI、教程和发布合同。
- [FLFE 门禁](ck-forge-performance-no-regression-gate.md)：Fast 资格和原生回退规则。
- [编译回归摘要](compile-regression-summary.md)：冷编译、Exact、热编辑、上传和产物门禁汇总。

## V2 入口

- 正式 Schema：[ck-blocks-v2.schema.json](schemas/ck-blocks-v2.schema.json)
- 可导入示例库：[ck_example_i2c_sensor_v2.zip](../examples/importable-packages/ck_example_i2c_sensor_v2.zip)
- 示例源码：[ck_example_i2c_sensor_v2](../examples/importable-packages/ck_example_i2c_sensor_v2/)
- V2 元数据说明：[metadata-v2 README](../examples/metadata-v2/README.md)

## 历史资料

`flfe-*202607*`、`*-phase1-design.md`、`v1-*` 和旧候选汇总用于复核设计演进与历史证据。它们可以解释为什么当前门禁采用 fail-closed，但不参与当前资格授权。需要最新状态时运行：

```powershell
node scripts/Report-CKForgeFastQualifications.cjs --format text
```

## 维护规则

1. 新增或修改正式合同时，同时更新 `docs/specification/README.md` 和 `docs/specification/index.json`。
2. 任何绑定 EXE、Core、工具链或证据哈希的报告都必须标注“当前”或“历史快照”；不能把旧哈希写成当前状态。
3. Schema、SDK 和测试直接读取的文件不能删除；废弃设计只保留为历史资料或明确移除所有入口后再删除。
4. 产品状态以 `current-feature-inventory.md` 为准，路线图不等于已交付功能。
