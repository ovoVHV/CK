# CK 无 Git 源码树冻结与发布门禁绑定

CK 当前工作区没有 `.git` 元数据，因此发布证据不得填写或推测 Git commit。`scripts/New-SourceTreeManifest.ps1` 用逐文件 SHA-256 和可复算的源码树 SHA-256 提供替代身份；它只服务于无 Git 工作区，发现 `.git` 会直接拒绝运行。

## 纳入与排除边界

冻结策略 `ck-source-tree-v1` 纳入实际构建、测试和验收输入：

- `.cargo/`、`apps/desktop/`、`crates/`、`scripts/`；
- `docs/` 与 `examples/`，因为发布 gate 会校验文档 Schema、fixture 和 5 套确定性示例包；
- 根 `Cargo.toml`、`Cargo.lock`、`README.md`；
- `apps/desktop/src-tauri/bin/arduino-cli.exe` 随桌面源码目录纳入，`tools/ccache.exe` 作为安装包资源单独纳入。

以下内容不是源码树身份，明确不纳入：

- `target/`、`dist/`、`artifacts/` 等构建结果和证据输出；
- `node_modules/`、`packages/`、`prebuilt_cores/`、`cache/` 等依赖、Core 与工具缓存；
- `tmp/`、临时扩展名和编辑器缓存；
- `state/`、`sketchbook/`、`libraries/`、`board-package-libraries/` 等用户工程、已安装库和可变应用数据；
- `examples/importable-packages/*.zip`。这些 ZIP 是 `Build-Examples.ps1` 根据同目录源码确定性生成的发布输出，输入目录仍被纳入。

工具采用白名单入口，不会从仓库根递归后再“猜测”哪些目录像源码。纳入目录中的 reparse point、路径逃逸、大小写冲突和计算期间发生的源码变化都会 fail-closed。

## 两层哈希

`source-tree-manifest.json` 按相对路径的 ordinal 顺序记录每个文件的字节数和 SHA-256。源码树哈希按以下 UTF-8（无 BOM）字节流复算：

```text
relative_path<TAB>bytes<TAB>sha256<LF>
```

逐行连接后计算 SHA-256，即得到 `tree_sha256`。manifest 自身也计算 SHA-256，用于证明清单字节没有改变。

时间不是源码内容。`frozen_at` 只写入独立的 `source-tree-freeze.json`，不会导致相同源码在不同时间生成不同 manifest。两个文件的 `source_control` 都明确为 `kind: none, commit: null`，不得虚构提交号。

## 正确调用顺序

完成所有产品源码修改后，先冻结一次；不要在其他 agent 仍修改源码时生成最终冻结：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\New-SourceTreeManifest.ps1 -Mode Create
```

随后运行完整发布 gate：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Test-ReleaseCandidate.ps1
```

`Test-ReleaseCandidate.ps1` 会：

1. 在任何构建前执行 `source-tree-freeze-preflight`；
2. 将 manifest 路径、manifest SHA-256、tree SHA-256、冻结时间和 `commit: null` 写入 `v1-release-gates.json` 的 `source_tree`；
3. 在全部自动化、生产构建和安装包 gate 后执行 `source-tree-freeze-postflight`；
4. 只有前后仍为同一份源码身份才允许完整 gate 通过。

构建过程写入的 `target/`、`dist/`、示例 ZIP 和 `artifacts/` 均在冻结边界外，所以正常 gate 不会制造自引用变化。若任何纳入的源码、测试、脚本或文档在 gate 中被改写，postflight 会失败；必须重新冻结并从头运行完整 gate，不能沿用旧的 `passed`。

需要独立核验而不重写时间或清单时运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\New-SourceTreeManifest.ps1 -Mode Verify
```

最终 evidence manifest、production EXE 原生冒烟和 C6 真板报告还应引用同一个 `manifest_sha256` 与 `tree_sha256`。源码树冻结只补齐“这批产物来自哪份源码”的身份链，不替代安装包签名、时间戳、原生冒烟或真板验证，也不会把本机/封闭测试候选提升为公开正式发布。
