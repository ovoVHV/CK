# `project.ckpkg` 工程提交与只读验收

`project.ckpkg` 是 CK 1.0 面向课堂、比赛和封闭测试的本地工程提交容器。它使用 ZIP 作为底层压缩传输层，但不是普通 ZIP 改后缀：容器必须同时具有固定格式标记、独立 manifest/[机器可读 JSON Schema](schemas/ck-project-package.schema.json)、固定安全路径、逐文件大小和 SHA-256，并通过 Rust 导入门禁。缺少任意一项都会被拒绝。

## 导出范围

用户必须明确选择四档之一：

- 不含源码：仅验收 JSON 和后端生成的无脚本可打印 HTML；
- 可编辑工程：额外包含当前 Blockly JSON；
- 生成源码：额外包含当前生成源码；
- 可编辑工程和生成源码：同时包含两者。

任何含源码档都要求用户再次确认敏感信息风险。积木字段或生成源码可能含 Wi-Fi 名称、密码、令牌和个人内容；CK 不会通过修改源码来“脱敏”并破坏工程。默认档不含源码。`ck.lock` 与构建证据均为可选项；`ck.lock` 只有在原始 SHA-256 及每项 `name/version/contentSha256` 与本次报告完全匹配时才可加入，并会移除本机源路径和快照路径。

每个包必含：

```text
META-INF/CKPROJECT
ck-project-package.json
report/project-acceptance.json
report/project-acceptance.html
```

可选路径仅限：

```text
project/workspace.json
source/generated.ino
environment/ck.lock
evidence/build-summary.json
```

manifest 明确记录 `schemaVersion`、`format`、`kind`、`generatedBy`、`sourceScope`、`networkUsed=false`、`uploadPerformed=false`、验收摘要和每个载荷的 `size/SHA-256/role/redacted`。

导出完成后，软件还会显示提交包文件名（不含父目录）和整个 `.ckpkg` 容器的 SHA-256。只读打开时会重新从同一内存快照计算该哈希，并明确显示实际源码范围、是否真正附加了脱敏 `ck.lock`、是否真正附加了构建证据；“报告中存在依赖锁记录”与“容器实际携带 ck.lock”是两个不同状态。

编译与资源数据只有在同一冻结构建 run 同时绑定当前积木 SHA-256、生成源码 SHA-256、板卡包、完整 FQBN、Core ID 和 Core 版本时才可进入报告。同 FQBN 下编辑积木、切换 Core，或较晚返回的旧异步结果都会保持“未验证”，不能借用。

## 只读导入边界

导入先把不超过 32 MiB 的普通本地文件读成一个有界内存快照，再从该快照解压并验证 ZIP 条目；不会把条目解压到磁盘，不执行第三方脚本或包内 HTML，不联网，不烧录，也不自动创建、覆盖或切换工程。门禁拒绝：

- 未知 schema、format 或 kind；
- 路径穿越、反斜杠路径、绝对路径、重复/大小写冲突路径；
- 符号链接、Windows reparse 输入、ZIP 特殊文件、加密条目；
- 未声明路径、缺少必需路径、角色或脱敏标志不一致；
- 单文件/总量超限、逐文件大小或 SHA-256 不符；
- 验收摘要与报告不一致；
- 可编辑工程、生成源码、脱敏锁或构建证据与工程指纹、完整 FQBN、Core、依赖不一致；
- HTML 中的脚本、事件处理器、外链、主动内容或与后端重新生成结果不一致。

导入摘要展示包文件名与 SHA-256、实际载荷组成、工程、板卡、完整 FQBN、Core、编译、Flash/RAM 已用量和总量、依赖、真机、检查点和健康检查。只读打开入口不依赖当前本机工程是否能生成报告；关闭或重新打开弹窗会清除上一提交包摘要，旧提交不会冒充刚选择的文件。

公开 JSON Schema 与 Rust 导入器共用 [`ck-project-package-parity-corpus.json`](schemas/ck-project-package-parity-corpus.json) 反例语料，覆盖时间、SHA-256 大小写、源码披露、逐角色大小和源码范围/路径集合。任一侧接受这些反例都视为回归失败。

## 可信度口径

“完整性已校验”表示本次打开时，固定容器结构、逐文件哈希和交叉证据一致；它不等于发布者身份签名。CK 1.0 没有为 `project.ckpkg` 提供发布者签名、证书链或撤销服务。可打印报告由后端生成无脚本 HTML，用户可通过系统打印保存 PDF；这不是 CK 内置 PDF 渲染器。
