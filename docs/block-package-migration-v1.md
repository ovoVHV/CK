# 声明式积木包迁移 v1

更新时间：2026-07-14。

## 已交付事务边界

Library Manager 的本地 CK 积木包导入（ZIP 或包根 `library.json`）不再直接覆盖已安装包。后端先完成解包、路径与容量检查、包质量门禁、版本读取和内容 SHA-256 复核，并将候选包放入独立 `block-package-migrations-v1` 暂存事务。此时已安装包和工程文件均未改变。

如果当前工程记录的包版本/哈希与候选包不同，前端必须用原始 Blockly JSON 和候选包的 `ck-migrations.json` 执行 dry-run。只允许 `renameBlockType`、`renameField`、`mapEnum`；无唯一路径、字段冲突、枚举值未覆盖、未知操作、脚本字段或畸形工作区都会 fail-closed。预览明确列出版本、内容哈希、步骤和受影响积木，`extraState`/`mutation` 始终作为不透明数据保留。

工程没有该包的来源版本/哈希时，CK 不会把“当前碰巧安装的版本”猜成来源。若磁盘上已有不同候选包，升级会以 `BLOCK_PACKAGE_EVIDENCE_REQUIRED` 阻断并提示可操作步骤：先用当前旧包完整、安全地打开工程并普通保存一次，再重试升级。普通保存/另存只记录已通过质量门禁、成功注册且实际进入当前工具箱的声明式包；后端在写工程前重新核对其 `library.json`、SemVer、质量报告和内容哈希。清单语义明确是 `enabled-declarative-runtime-packages`，不是“工作区实际使用包”的推断。

用户确认后，CK 先建立 reason 为 `before_package_migration` 的完整工程检查点。提交端重新验证以下证据：

- 暂存包 ID、版本、质量报告和内容 SHA-256 未变化；
- 已安装包仍是预览时的版本和 SHA-256；
- 工程磁盘文件 SHA-256 未变化；
- 检查点属于同一工程，且 `workspaceJson` 与 dry-run 输入逐字相同；
- dry-run 的步骤 ID 全部存在于暂存的迁移清单；
- 迁移前后工作区 JSON 与各自 SHA-256 一致。

证据通过后，后端在同一事务中备份旧包和原工程、激活新包并替换工程。任何常规 I/O 失败都会恢复旧包与原工程；`committing`/`committed` 使用落盘状态标记，应用启动时会主动回滚进程中断留下的半提交或完成已提交事务的清理，后续迁移命令也会再次检查。迁移写入只支持单文件 `.maker`/`.ck`，并以磁盘哈希 compare-and-swap 阻止并发覆盖。

## 工程证据

迁移后的工程保留原有未知字段，并新增：

```json
{
  "ck_block_packages": {
    "schema_version": 1,
    "inventory_semantics": "enabled-declarative-runtime-packages",
    "inventory_recorded_at": "...",
    "packages": {
      "package_id": {
        "version": "2.0.0",
        "content_sha256": "...",
        "recorded_at": "...",
        "provenance": "enabled-runtime-inventory",
        "generated_code_stale": true,
        "migration": {
          "schema_version": 1,
          "from_version": "1.0.0",
          "from_content_sha256": "...",
          "manifest_sha256": "...",
          "step_ids": ["v1-to-v2"],
          "workspace_before_sha256": "...",
          "workspace_after_sha256": "...",
          "checkpoint_id": "...",
          "applied_at": "..."
        }
      }
    }
  }
}
```

普通单文件保存会保留同版本/同哈希记录中的迁移详情及其他前向兼容字段，并用当前已启用清单刷新顶层 inventory 证据。迁移不执行候选包 JavaScript；内容哈希变化会使旧质量报告失效，新包必须重新通过同一静态门禁、内容哈希和声明式三入口复核并取得 `declarative-safe`。这不是脚本授权，Legacy JavaScript 始终禁用。工程内旧生成源码明确标记为 stale，待安全声明式运行时重新载入后再由正式生成器刷新。

## 明确限制

- v1 不自动迁移 legacy 文件夹工程或 XML 工作区；它们保持原样并给出阻断原因。
- v1 事务入口覆盖 Library Manager 的本地包导入。在线仓库当前只允许安装未安装项；未来若开放在线“升级”，必须先接入同一 staging API，不能恢复直接覆盖。
- 包目录仍按板卡作用域共享。当前事务只迁移正在打开且已有来源证据的工程；其他引用同一包但没有 `ck_block_packages` 证据的旧工程会继续由未知积木保护层原样保留，不能猜测其来源版本。能被当前旧包无未知积木地完整载入的工程可先保存一次建立 enabled inventory；否则必须保留旧包并使用备份/检查点。完整跨工程升级仍需要工程依赖索引或包版本并存。
- 数据迁移不会运行或推断生成器代码。新包尚未通过声明式质量门禁时，工程可能暂时进入未知积木只读保护；门禁通过并取得 `declarative-safe` 后由用户“重新检查”载入，不存在允许第三方 JavaScript 执行的授权步骤。
