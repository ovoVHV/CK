# CK Extension SDK 1.0.0

这个 SDK 是 CK 1.0 的离线扩展开发资料包，面向第三方板卡、声明式积木库和原生 Arduino 库作者。它只包含公开契约、可修改示例、确定性打包工具与静态校验器，不需要复制 CK 主应用源码。

## 先看边界

- `Validate-BoardPackage.mjs` 和 `Validate-ImportablePackage.mjs` 给出的是当前规则集下的本地静态检查结果，不是 CK 官方认证、发布者签名或真板验证。
- Schema 校验、质量报告或内容 SHA-256 不能证明作者身份，也不能证明固件在某块实体硬件上工作。
- CK 可以检查许可证字段、许可证文件和声明的一致性，但不会替作者作出法律意义上的许可证兼容结论。第三方代码、素材和依赖的授权责任仍属于包发布者。
- `source`、`evidence` 和本机生成的 `local-static` 报告是可审计证据，不会自动升级成“CK 官方”“真板已验证”或“推荐包”。
- CK 1.0 的第三方积木运行时只接受声明式 JSON：`blocks.json`、`ck-generator.json` 和 JSON/XML toolbox。旧 `blocks.js` / `generator.js` 不会进入主 WebView 执行。
- Core 的 `recommended_version` 是推荐选择，不是无条件锁死。低于最低版本或命中已知不兼容范围才应阻止；未经测试或超过已测上界应显示复验警告。
- **SDK 聚合包以 Apache License 2.0 发布。** 根 `LICENSE` 与 `NOTICE` 约束 SDK 自身；示例和第三方依赖仍以各自目录中的许可证为准，不能把 SDK 许可推定为第三方内容的授权结论。

## 包内结构

```text
CK-Extension-SDK-1.0.0/
  README.md
  LICENSE
  NOTICE
  manifest.json
  release-channel.json            # 机器可读发布地址与许可状态
  package.json                    # npm bin: ckpkg
  docs/
    blockly-library-package-standard.md
    ckpkg.md
    sensor-library-tutorial.md
    block-package-migration-v1.md
    package-quality-gates.md
    third-party-board-passport.md
    schemas/
      ck-board.schema.json
      ck-board-lock.schema.json
      ck-extension-sdk-release-artifact.schema.json
      ck-extension-sdk-release-channel.schema.json
      ck-library.schema.json
      ck-blocks.schema.json
      ck-blocks-v2.schema.json
      ck-generator.schema.json
      ck-migrations.schema.json
      ck-package-quality-report.schema.json
  examples/importable-packages/
    ck_example_nano_board/          # 最小板卡包
    ck_example_c6_board/            # 多配置板卡护照与随板原生库
    ck_example_serial_blocks/       # 最小声明式积木库
    ck_example_i2c_sensor_v2/       # v2 语义、迁移和递归 src
    ck_example_native_deep/         # 纯 Arduino 深层原生库
    *.zip                           # 与上述源码对应、可直接导入 CK
    Build-Examples.ps1
  ci/
    github-actions-ckpkg.yml
    github-actions-ckpkg-trusted.yml
  scripts/
    ckpkg.mjs
    ckpkg.test.mjs
    JsonSchemaValidator.mjs
    Validate-BoardPackage.mjs
    Validate-ImportablePackage.mjs
    Validate-PackageSchemas.test.mjs
    Verify-ExtensionSdk.ps1
```

`manifest.json` 列出除自身之外的每个归档文件路径、字节数和 SHA-256。它用于检测 SDK 传输损坏，不代表发布者签名或来源认证。

## 发布地址

- 规范本地产物路径是：`artifacts/release/CK-Extension-SDK-1.0.0.zip`。它需要与当前源码重新构建并通过旁路 SHA-256 校验后，才可作为本轮候选分发物；该路径不是发布者签名。
- `release-channel.json` 同时给出版本、许可证、归档名与 `public_url`。在 CK 尚未配置真实公开托管地址前，`public_url` 保持 `null`；工具和 CI 不会虚构下载链接。
- 公开托管后，应在受保护分支配置不可变下载 URL 与归档 SHA-256，再启用 `ci/github-actions-ckpkg-trusted.yml`。

## 选择从哪个示例开始

| 要做的扩展 | 起点 | 重点 |
| --- | --- | --- |
| 最小自制板卡 | `ck_example_nano_board` | `board.json`、图标、Core 推荐版本 |
| ESP32 多 Flash/PSRAM/BOM 板卡 | `ck_example_c6_board` | 完整 FQBN 配置、硬件变体、引脚证据、smoke tests、随板库隔离 |
| 只有积木、无原生源码 | `ck_example_serial_blocks` | 声明式积木、生成规则、toolbox 一致性 |
| 传感器积木 + Arduino 库 | `ck_example_i2c_sensor_v2` | AI 可读语义、硬件资源、依赖、迁移事务、递归 `src/` |
| 原生 Arduino ZIP | `ck_example_native_deep` | `src/foo.c`、`src/driver/foo.cpp`、更深层源码及公开头文件规则 |

Arduino 1.5+ 的 `src/` 是递归源码根。`src/xxx.c`、`src/driver/xxx.c` 和更深层的 `src/vendor/chip/xxx.cpp` 都是合法输入，不需要拍平；只有 `src/` 本身是公共 include 根。门禁同时兼容纯 C、纯 C++、header-only 以及旧 Arduino 1.0 根目录/`utility/` 布局；`library.properties` 缺失会明确警告而不是伪装成标准包。如果 `src/` 和旧布局混装，软件会允许导入但标记风险，并要求用明确 profile 做真实编译。

## 最短开发流程

1. 在 SDK 根目录注册开箱即用的 `ckpkg` 命令（Node.js 20+）：

   ```powershell
   npm install --global .
   ckpkg --help
   ```

   不希望全局安装时，所有命令都可等价写成 `node .\scripts\ckpkg.mjs ...`。`package.json` 的标准 `bin` 映射会在 Windows 生成 `ckpkg.cmd`，在 macOS/Linux 生成 `ckpkg` 启动入口。

2. 使用统一 CLI 创建完整 v2 声明式积木包：

   ```powershell
   ckpkg create my-sensor --dir .\packages
   ```

   `create` 保留标准 Arduino 递归 `src/`，并生成声明式 `generator/`、`examples/`、`tests/` 与显式编译 profile；它不会生成或执行第三方 JavaScript。已有板卡包和原生 Arduino 库可直接从 `validate` 开始。

3. 使用 Schema 编辑清单；积木库确保 manifest、Blockly 定义、生成规则和 toolbox 中的 block type 一一对应。
4. 统一执行静态门禁与纯数据合约测试：

   ```powershell
   ckpkg validate .\packages\my-sensor
   ckpkg test .\packages\my-sensor
   ```

5. 使用包作者在 `ckpkg.json` 中明确声明的 profile 做真实 compile-only：

   ```powershell
   ckpkg compile .\packages\my-sensor esp32-c6
   ```

   未声明的别名不会被猜测；也可显式传入 `--fqbn` 和包内 `--example`。该命令调用真实 Arduino CLI，只编译、不上传，工具/Core/源码失败都会返回非零退出码。默认工具查找排除包树内同名可执行文件；报告绑定可执行文件 SHA-256，并把版本明确标成工具自报而非官方签名。

6. 门禁通过后生成确定性发布 ZIP：

   ```powershell
   ckpkg pack .\packages\my-sensor --out .\packages\my-sensor-0.1.0.zip
   ```

7. 板卡包也可单独运行底层声明校验器：

   ```powershell
   node .\scripts\Validate-BoardPackage.mjs .\my-board --core-version 3.3.6
   ```

8. 积木库或原生 Arduino 库也可单独运行底层校验器：

   ```powershell
   node .\scripts\Validate-ImportablePackage.mjs .\my-block-library --kind block
   node .\scripts\Validate-ImportablePackage.mjs .\my-arduino-library --kind native
   ```

9. 修改 SDK 自带示例后，确定性重建五个 ZIP：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\examples\importable-packages\Build-Examples.ps1
   ```

10. 检查 SDK 内 Schema、CLI 与示例契约：

   ```powershell
   node --test .\scripts\Validate-PackageSchemas.test.mjs
   node --test .\scripts\ckpkg.test.mjs
   ```

11. 导入 CK 后仍会执行主应用后端的真实质量门禁。离线脚本通过不等于安装一定通过：运行中的 CK 版本可能使用更新规则，且环境/Core/真机门禁只有主应用能够完成。

完整命令、`ckpkg.json` profile、退出码、机器 JSON 和 CI 用法见 [`docs/ckpkg.md`](ckpkg.md)。最小 GitHub Actions 文件位于 `ci/github-actions-ckpkg.yml`。

从零创建传感器积木库的完整教程见 [`docs/sensor-library-tutorial.md`](sensor-library-tutorial.md)，内容覆盖语义元数据、声明式代码生成、依赖与硬件资源、真实 compile-only、导入 CK 和证据护照。

## 校验 SDK 归档

在 SDK 外运行随附校验器：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Verify-ExtensionSdk.ps1 `
  -ArchivePath .\CK-Extension-SDK-1.0.0.zip
```

校验器检查单一根目录、安全路径、大小、SHA-256、清单覆盖和固定 ZIP 时间戳。它验证的是文件完整性，不验证作者身份。

## 发布前最低清单

- 包 ID、目录名、版本、作者、许可证声明一致。
- 没有绝对路径、`..`、符号链接、junction、远程/内联资源或可执行积木入口。
- 每个依赖都带名称和版本范围；Core 兼容范围区分 minimum、recommended、tested 和 known incompatible。
- 板卡的完整配置组合来自真实 Core 菜单；Flash、PSRAM、分区和引脚事实有来源，未知内容保持“未知”，不靠型号名猜测。
- v2 积木声明功能语义、参数/返回值、依赖、适用板卡、引脚/总线资源、生成行为、限制、示例和错误信息。
- 迁移只有唯一、无环、完全映射的声明式路径；提交前有 dry-run 和工程检查点。
- 完成离线检查后，再在目标 CK 版本、推荐 Core 和代表性真板上复验。只有记录了相应证据，才可以描述为“本机编译通过”或“真板验证通过”。
