# ckpkg CLI / CI

`ckpkg` 是 CK Extension SDK 的零依赖开发者命令行。它把现有板卡、积木和原生 Arduino 库门禁收束为同一个入口，但不会把本地静态检查冒充 CK 官方认证、发布者签名、真板验证或许可证法律意见。

SDK 聚合包以 Apache License 2.0 发布，根 `LICENSE`、`NOTICE` 和 manifest 明确记录这一授权。包内示例与第三方依赖仍受各自许可证约束；静态许可证检查不是法律兼容意见。

## 快速开始

需要 Node.js 20 或更新版本。SDK 解压后，先在 SDK 根目录注册标准 `bin` 入口：

```powershell
npm install --global .
ckpkg --help
ckpkg --version --json
ckpkg create my-sensor --dir .\packages
cd .\packages\my-sensor
ckpkg validate .
ckpkg test .
ckpkg compile esp32-c6
ckpkg pack . --out ..\my-sensor-0.1.0.zip
```

`package.json` 的 `bin` 字段会在 Windows 生成 `ckpkg.cmd`，在 macOS/Linux 生成带 shebang 的 `ckpkg` 入口。无需全局安装时可直接执行 `node scripts/ckpkg.mjs ...`。`ckpkg --version --json` 输出可供构建器和归档验证器交叉核对的机器版本；归档根目录、`manifest.json`、npm `package.json` 与 CLI 版本必须完全一致。`--json` 将唯一的 stdout 输出变为机器 JSON；`--output report.json` 会原子写入同一报告，适合 CI 留档。

## 命令边界

### `create`

```text
ckpkg create <package-id> [--dir <parent>] [--template sensor-v2]
```

第一版提供 `sensor-v2` 模板。它是完整声明式 v2 积木包，同时也是标准 Arduino 1.5+ 库：

```text
my-sensor/
├── library.json
├── library.properties
├── ck-blocks.json
├── ckpkg.json
├── blocks/
├── generator/ck-generator.json
├── examples/serial_temperature/serial_temperature.ino
├── tests/ckpkg-tests.json
├── src/
│   ├── <package-hash>_sensor.h/.cpp
│   ├── <package-hash>_sensor_math.c
│   └── internal/<package-hash>_sensor_codec.h/.c
├── LICENSE
└── README.md
```

`src/foo.c`、`src/driver/foo.c`、`src/vendor/chip/foo.cpp` 均保持原目录并递归交给 Arduino 构建系统；CLI 不拍平源码，也不把每个子目录私自加入 include path。生成器仍是受限 JSON，不执行第三方 JavaScript。

新包 ID 只接受规范小写 `[a-z0-9][a-z0-9._-]*`，避免 Windows/macOS 大小写目录冲突。`create` 会把稳定 SHA-256 短后缀同时加入 Blockly type、公开头文件名、C++ 类、C 函数、内部头文件和生成辅助函数。因此 `foo-bar`、`foo.bar` 与 `foo_bar` 即使转成相似代码 slug，也可以并存安装，不会出现 include 或链接符号碰撞。该限制只作用于 `create`；`validate` 继续按现有兼容门禁读取旧包，不会偷偷改名。

模板中的作者、描述、依赖和硬件事实只是待修改起点。发布前必须替换 `TODO`，并依据真实硬件收窄板卡、架构和资源声明。

### `validate`

```text
ckpkg validate [package-dir] [--kind auto|board|block|native]
ckpkg validate ./my-board --core-version 3.3.6
```

该命令直接复用 SDK 中的正式离线验证器，检查 Schema、许可证文件与声明、依赖形状、声明式生成器一致性、示例/入口路径、递归源码布局、硬件资源和 v2 AI 元数据。确定错误退出 `1`；警告不会阻止，但报告状态为 `passed_with_warnings`。

v2 积木不是只检查 block type：门禁会把语义、字段、value/statement 输入、返回形状、依赖、硬件资源来源、生成行为、限制、示例和错误信息按完整 JSON Schema 校验，再与 Blockly `argsN`、连接形状和 `ck-generator` 占位符做跨文件一致性检查。占位符只接受 `field`、`field_json`、`value` 和 `statement`，未知、未闭合、超限或指向不存在参数的规则直接阻止。

原生 Arduino 库支持纯 C、纯 C++、header-only、递归 `src/`、旧根目录/`utility/` 和无依赖库。`depends` 和 `includes` 不再被误当成必填项；它们一旦在 `library.json` 和 `library.properties` 两边同时声明，就必须一致。缺失 `library.properties`、使用旧布局或混装布局会生成机器可读警告，不会被写成“标准 Arduino Library Manager 包”。

所有包种类先经过统一文件门禁：不允许符号链接/junction，最多 4096 个文件，单文件最多 32 MiB、总量最多 128 MiB，并要求非空 `LICENSE` 和可复算内容 SHA-256。未被清单引用的危险路径也不能躲过检查；任一 checklist 为 `failed` 时总状态必定失败。

`example-compile` 在静态校验中明确为 `not_run`。通过 `validate` 不代表编译通过。

### `test`

```text
ckpkg test [package-dir]
```

先执行全部静态门禁，再运行 `tests/ckpkg-tests.json`。测试文件只允许三类无执行能力的确定性检查：

- `file-exists`；
- `file-contains`（固定文本，不接受正则或命令）；
- `json-pointer-equals`。

它不会执行包内脚本、shell 命令或网络请求。积木定义、generator 和 toolbox 的 type 一致性仍由正式验证器检查。`test` 也不冒充编译；报告中的 `compilation_performed` 保持 `false`。

### `compile`

```text
ckpkg compile esp32-c6
ckpkg compile ./my-sensor esp32-c6
ckpkg compile ./my-sensor --fqbn esp32:esp32:esp32c6 --example examples/serial_temperature
```

`compile` 只调用真实 `arduino-cli compile`，不上传。Arduino CLI 未安装、Core 缺失、FQBN 错误、源码错误或链接失败都会产生非零退出码和失败报告，CLI 不提供“模拟成功”。

别名只有在包内 `ckpkg.json` 明确声明后才可使用：

```json
{
  "schema_version": 1,
  "compile_profiles": [
    {
      "id": "esp32-c6",
      "fqbn": "esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB",
      "sketch": "examples/serial_temperature",
      "description": "作者实际支持的 C6 N16 编译档案"
    }
  ]
}
```

这是一条发布者声明，不是 CK 猜测。未知别名直接退出 `2` 并提示使用 `--fqbn`；模板档案只用于演示，作者必须根据真实板卡与 Core 菜单复核完整 FQBN。`--arduino-cli` / `CK_ARDUINO_CLI` 指定工具，`--config` / `CK_ARDUINO_CONFIG` 指定配置。

编译报告记录完整 FQBN、sketch、真实退出码、耗时以及 stdout/stderr SHA-256，并保留有界日志尾部。Arduino CLI 身份只记录来源类别、可执行文件名、可执行文件 SHA-256、自报版本和版本探测退出码；自报版本不等于官方签名。显式 `--arduino-cli` 和环境变量工具会标为 untrusted，本地 CK 随附工具也只表示本机构件身份。默认 PATH 查找会逐项解析为 canonical 绝对路径并排除包目录，绝不会因为 compile 的 cwd 位于包根而执行包作者放入的同名 `arduino-cli.exe`。报告明确记录 `upload_performed: false`。

编译前后的包内容 SHA-256 必须相同；若编辑器、同步工具或其他进程在编译窗口修改包，即使 Arduino CLI 返回 `0`，`ckpkg` 也会把证据判为失败。机器报告默认只保存 `root_name`、工具来源类别和文件名，并将日志中的包根、CK 根、用户目录与临时目录脱敏，不复制本机绝对路径。

### `pack`

```text
ckpkg pack . --out ../my-sensor-0.1.0.zip
```

打包前强制运行 `test`。ZIP 使用 ordinal 路径、UTF-8、固定 `1980-01-01` 时间戳、单一包根和原子输出；相同输入产生相同字节与 SHA-256。输出必须位于源码目录外，默认不覆盖现有文件；显式 `--force` 才允许替换。

`pack` 会在校验后、归档后及发布后重复核对内容 SHA-256；并发变化会令命令失败且移除新产物。`--output` 机器报告同样必须位于包树外，检查会解析现存父目录的 canonical path，因此通过 junction 绕回包目录也会被拒绝。

## 退出码

| 代码 | 含义 |
| --- | --- |
| `0` | 命令完成；可能存在不阻止的警告 |
| `1` | Schema、测试或真实编译失败 |
| `2` | 命令参数、未知 profile 或 CLI 配置错误 |
| `3` | Arduino CLI、配置或必要环境缺失 |
| `4` | 文件系统、包读取或原子输出失败 |

自动化不得只搜索控制台中的“PASS”字符串，应读取 JSON `status` 并同时检查进程退出码。

## 最小 CI

SDK 提供两份不能混淆的 CI：

- `ci/github-actions-ckpkg.yml` 是**仓库本地开发检查**。它从当前 checkout 安装 SDK，所以同一 PR 可以修改验证器；绿色结果不是 CK 认证，也不能进入受保护证据链。
- `ci/github-actions-ckpkg-trusted.yml` 是可信验证器模板。它要求 protected `CK_TRUSTED_SDK_URL` 与 `CK_TRUSTED_SDK_SHA256`，从被测 PR 之外下载不可变 SDK，先校验固定 SHA-256 和内部 manifest，再安装 `ckpkg`。变量缺失或失配会立即失败，绝不退回 checkout 副本。SDK 已采用 Apache-2.0，但当前尚无官方公开托管 URL，因此模板只保留必填占位，不能伪造下载地址；发布到真实不可变地址并登记 SHA-256 后才能启用。用于保护分支前还应把 GitHub Actions 引用换成审查过的完整 commit SHA。

两份示例都显式绑定与 CK 1.0 封闭测试候选一致的 Arduino CLI 1.4.1 和 ESP32 Core 3.3.6，然后依次执行 validate、test、compile、pack，并上传 JSON 报告和 ZIP；不会上传固件到设备。

本地回归 CLI 自身：

```powershell
node --test .\scripts\ckpkg.test.mjs
```
