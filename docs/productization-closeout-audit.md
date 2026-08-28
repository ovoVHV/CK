# CK 产品化收尾审计

更新时间：2026-07-14。

## 结论

附件列出的六项产品化 P0 已全部形成实现闭环，其可交付口径限定为 **1.0 本机验证／封闭测试候选**，而不是公开正式发布。这里的完成口径仍然有限：第三方生态只开放声明式包；锁定重建针对本机“上一个可用版本”，不等于诊断包跨机自动安装；板卡认证也只覆盖精确登记的 Core、完整 FQBN 与真机配置。发布候选仍须通过整套自动化、原生桌面和代表性 C6 真板门禁，且同一 evidence manifest 必须绑定冻结源码、gate 时间、production EXE、MSI、NSIS 及其 SHA-256，不能把局部或历史证据扩大成当前产物、所有板卡或公开发布证明。

功能实现闭环不直接产生发布资格。当前裁决只读取 [`v1-release-evidence-manifest.json`](../artifacts/release/v1-release-evidence-manifest.json) 的 `status`、`releaseClass` 及其源码／产物／报告哈希绑定；本审计不复制某次 gate、同路径产物或瞬时哈希的结论，也不会提前写入尚未发生的通过。

## 六项真实状态

| 收尾项 | 当前状态 | 发布影响 | 最小可交付边界 |
| --- | --- | --- | --- |
| 积木到源码映射 | **已完成**：编译会话冻结代码 SHA-256、源文件、行 span、block ID/type、生成 section 与置信度到 `ck-sourcemap.json`；后端验证代码哈希和边界后原子落盘 | 错误卡片只定位本次 sketch；第三方库、过期代码或不一致 span 明确不猜测 | 保留 source map schema/version；后续可扩展表达式级列区间，但不能降低当前 fail-closed 边界 |
| 缺失积木保险箱 | **已完成第一阶段无损边界**：JSON/XML 未知 block type 在送入 Blockly 前被识别，工程以原始内容只读打开；禁止编译、上传和覆盖保存，支持原样导出、打开库管理器与安全重试 | 缺包工程不会静默删除积木；1.0 不提供可编辑 placeholder，因此补包前必须保持只读 | 将来若做 placeholder，仍须证明完整原始子树可逆；1.0 不以可编辑性换取数据风险 |
| 声明式包迁移 | **已完成 v1**：支持有限确定性操作、dry-run、精确旧包/新包哈希、迁移前检查点、工程磁盘 CAS，以及包目录与工程联合提交/回滚；启动时恢复未完成事务 | 只迁移工程已记录且可验证的声明式包版本；没有可信旧版本记录时阻止，不猜测 | v1 不执行迁移 JavaScript；新增操作必须继续保持纯数据、确定性与可回滚 |
| 滚动恢复稿与启动恢复 | **已完成**：普通语义编辑约 12 秒防抖写入独立恢复稿，使用临时文件和原子替换、内容哈希、数量/总量限额与损坏隔离；启动只提示比正式工程更新且内容不同的候选 | 恢复当前工程前创建正式检查点；成功正式保存后清理对应草稿；全部数据仅在本机 | 后续可改善语义 diff 展示，但不影响 1.0 恢复闭环 |
| `ck.lock` 驱动干净构建 | **已完成本机可用版本边界**：从“上一个可用版本”物化精确锁定依赖到隔离临时根，禁止全局 Arduino 库、隐式依赖解析、Fast Relink 历史对象和同名回退；校验依赖哈希、完整 FQBN、CLI 与工具链 | 可以审计本机基线是否仍可重建；QuickFast 基线只称 compile-only。诊断包跨机自动安装/复现仍未实现，也不作承诺 | 若将来做跨机复现，需另建离线依赖载荷、Core 物化与签名/许可证策略，不能复用“本机已安装”假设 |
| 第三方 JavaScript 禁用与声明式运行边界 | **1.0 fail-closed 边界已完成**：第三方 `blocks.js`/`generator.js` 不再进入主 WebView；质量报告、白名单或精确哈希批准均不授予执行权。可导入包只使用 JSON 定义、`ck-generator` 声明式规则和安全 toolbox，并有外部资源/回调及输出预算门禁 | 可开放符合声明式标准的第三方包；仍不能宣传“任意第三方脚本已沙箱化” | 1.0 保持 `legacy-disabled`。只有未来产品明确需要脚本生态时，才新增独立 extension host 或等效强隔离运行时，默认无网、无文件、无进程并带超时/内存/输出上限 |

## 代码证据

- 编译会话 source map 与错误定位：[`compile_source_map.ts`](../apps/desktop/src/services/compile_source_map.ts)、[`arduino_generator.ts`](../apps/desktop/src/components/arduino_generator.ts)、[`Workspace.tsx`](../apps/desktop/src/components/Workspace.tsx)。
- 未知积木只读保护：[`unknown_block_guard.ts`](../apps/desktop/src/services/unknown_block_guard.ts)、[`Workspace.tsx`](../apps/desktop/src/components/Workspace.tsx)。
- 滚动恢复稿与检查点：[`recovery_drafts.rs`](../apps/desktop/src-tauri/src/recovery_drafts.rs)、[`recovery_drafts.ts`](../apps/desktop/src/services/recovery_drafts.ts)、[`project_checkpoints.rs`](../apps/desktop/src-tauri/src/project_checkpoints.rs)。
- 声明式迁移事务：[`block_package_migration_tx.rs`](../apps/desktop/src-tauri/src/block_package_migration_tx.rs)、[`block_package_migration_transaction.ts`](../apps/desktop/src/services/block_package_migration_transaction.ts)、[`block-package-migration-v1.md`](block-package-migration-v1.md)。
- 锁与可用版本隔离重建：[`last_working_version.rs`](../apps/desktop/src-tauri/src/last_working_version.rs)、[`demo.rs`](../crates/ck_core/src/builder/demo.rs)。
- 第三方声明式加载与旧脚本拒绝边界：[`extension_loader.ts`](../apps/desktop/src/services/extension_loader.ts)、[`declarative_block_runtime.ts`](../apps/desktop/src/services/declarative_block_runtime.ts)。

## 推荐收尾顺序

1. **跑 1.0 发布门禁**：格式、全部前端/Rust/脚本回归、确定性示例 ZIP、生产构建与安装包哈希统一出报告。
2. **补代表性原生证据**：在发布构建中验证未知积木只读、恢复稿、声明式示例导入和锁定复编译；用与候选配置相容的代表性 C6 完成冷/Exact/热编辑/上传/产物门禁。
3. **保持声明式边界**：CK 1.0 对旧 JavaScript 始终 fail-closed；只有未来明确需要脚本生态时才建设独立宿主，不为兼容性开白名单后门。
4. **公开已验证矩阵与限制**：139 种静态工具箱积木与 8 种动态函数积木，共 147 种、294 个目标生成格；其中 7 个目标级 generator fixture 只完成真实 compile-only，机器报告保持 `hardwareTested=false`。生成、编译和具体真板证据分开呈现，未跑组合保持未知。
5. **固定示例集合**：发布 gate 只把 C6 板卡、v2 I2C、Nano 板卡、深层原生库和声明式串口积木这 5 套 ZIP 计为确定性示例包，SDK 和源码目录不重复计数。
6. 1.0 稳定后再实现 `.cktrace`、资源归因、跨机依赖物化、开发者 CLI/CI 和发布者签名中心。

## 发布口径

- **实现边界可以说**：缺包工程无损只读、滚动恢复、编译会话 source map、声明式包质量门禁/迁移、本机锁定依赖复编译与真机上传门禁已形成 1.0 实现闭环；交付口径仅限本机验证／封闭测试。
- **现在不能说**：任意第三方脚本已沙箱化；未知积木可以安全编辑；诊断包能跨机自动安装并复现全部依赖；所有 ESP32/AVR 型号和配置均已真板验证；本地质量报告等同官方签名认证。
- **不能仅凭本文说**：某个 EXE 已通过最终 production 原生冒烟，某个 MSI／NSIS 已通过完整 gate，或某次 C6 会话已绑定当前候选。上述当前结论只由 evidence manifest 的同源哈希绑定裁决；没有 commit 或可复算源码树 manifest 的历史证据不能写成可复现发布。
- **1.0 封闭测试验收门槛**：冻结源码（无 Git 时保存可复算源码树 manifest、SHA-256 和冻结时间），自动化与生产构建全绿，恰好 5 套示例 ZIP 可重复，MSI／NSIS 与 gate 哈希一致，同哈希 production EXE 的原生冒烟和 C6 代表性真板链路通过，最后生成机器可读 evidence manifest 与已知限制。
- **开放生态边界**：只开放声明式包并保持 fail-closed；Legacy JavaScript 不执行。恶意 JSON、远程资源、篡改、迁移回滚、输出上限和同名依赖污染回归必须持续全绿。未来若开放脚本，另行要求进程隔离、超时、权限与崩溃隔离回归。
