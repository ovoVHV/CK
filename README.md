# CK

CK 是面向 Arduino 兼容板卡的桌面图形化编程与工程诊断工具。仓库包含
Tauri/React 桌面端、Rust 构建核心、CK Extension SDK、扩展包规范、测试和
可导入示例。

## 从源码运行

环境要求：Node.js 20、Rust stable、Windows WebView2，以及 Tauri 2 所需的
原生构建工具。

```powershell
cd apps/desktop
npm ci
npm run desktop:dev
```

生成安装包：

```powershell
cd apps/desktop
npm ci
npm run desktop:build
```

本仓库不提交下载后的板卡 Core、用户工程、缓存、诊断包、构建产物或本机
性能资格证据。公开源码构建在缺少有效资格证据时会 fail-closed 回退到原生
Arduino CLI Release 路径，不会把未经认证的路径冒充为快速编译。

## CK 扩展包开发指南

CK 提供三条明确分离的导入链路：开发板包、声明式积木库包和普通 Arduino 源码库。前两者属于 CK 扩展包；Arduino 源码库只作为编译依赖，三者不能混装，以免板卡身份、Blockly 数据和原生依赖互相污染。所有正式文件合同、Schema、证据等级与延期格式统一从 [`CK Specification`](docs/specification/README.md) 查阅。

## 开发板包

开发板包 ZIP 的根目录或唯一顶层目录必须包含 `board.json`：

```text
my-board/
  board.json
  assets/
  libraries/              # 可选，仅属于该精确板卡包的声明式积木库或 Arduino 源码子库
    my-board-blocks/
      library.json
      ck-blocks.json
      blocks/
```

最小 `board.json` 示例：

```json
{
  "schema_version": 1,
  "id": "esp8266_custom",
  "name": "My Custom ESP8266 Board",
  "version": "1.0.0",
  "fqbn_base": "esp8266:esp8266:generic",
  "description": "Custom ESP8266 target",
  "arduino_core": {
    "package": "esp8266:esp8266",
    "version": "3.1.2",
    "recommended_version": "3.1.2",
    "version_range": {
      "minimum": "3.1.0",
      "maximum_exclusive": "4.0.0"
    },
    "tested_versions": ["3.1.2"],
    "index_url": "https://arduino.esp8266.com/stable/package_esp8266com_index.json"
  }
}
```

旧 v1 的 `arduino_core.version` 是推荐版本别名，不是核心死锁。真正面向多 BOM 发布时，应继续声明物理变体、完整 FQBN 配置、有限验证矩阵和受控 smoke sketch；完整标准见 `docs/third-party-board-passport.md`。实际使用的核心版本与验证证据写入安装后生成的 `ck.lock`。

在“新建工程”页面点击“第三方板卡”，可以从 GitHub/Gitee 仓库读取板卡包，也可以在同一窗口选择本地 ZIP。板卡选择仍只在新建工程页面完成，编辑器内部不会切换项目板卡。

## CK 积木库包

新积木库必须使用标准目录：

```text
my-library/
  library.json
  ck-blocks.json
  blocks/
    blocks.json
    ck-generator.json
    toolbox.json             # 也可用通过资源门禁的 XML
  src/                    # 可选，递归支持 src/** 下的 .c/.cpp/.S 等 Arduino 源码
  assets/                 # 可选资源
```

`ck-blocks.json` 是机器契约，声明稳定 ID、板卡/架构兼容性、入口文件以及每个积木的语义。全局搜索和 AI 目录只使用清单与当前真实工具箱的交集。完整字段说明与 JSON Schema 位于：

- `docs/blockly-library-package-standard.md`
- `docs/schemas/ck-blocks.schema.json`
- `docs/schemas/ck-generator.schema.json`

CK 1.0 不在主 WebView 执行第三方 `blocks.js` / `generator.js`；质量报告或精确哈希批准也不会授予执行权。第三方积木只通过严格 JSON 定义和声明式生成规则激活，blocks/toolbox 中的远程或内联资源引用同样会被拒绝。

板卡包、积木库和纯 Arduino 深层原生库的完整可导入示例统一位于 `examples/importable-packages/`。该目录同时提供可读源码、可直接导入的 ZIP 和确定性重建脚本。开发积木库时也可选择包根目录的 `library.json`，发布时应确保 `library.json` 位于 ZIP 根目录或唯一顶层目录。

## Arduino 源码库

不提供积木的普通 Arduino 库不要伪装成 CK 积木包。在编辑器“库管理器 -> 本地导入”中选择“Arduino 源码库”，导入 Arduino IDE 兼容的 ZIP。CK 会先于 Arduino CLI 检查归档路径、链接、大小、唯一库根、递归 `src/**` 或旧根目录/`utility/**` 源码、`library.properties`、许可证提示和内容 SHA-256；确定性错误会在安装前阻止。CLI 安装后还会复核实际目录内容并写入可篡改检测的 `arduino-library` 质量报告。缺少 `library.properties` 或许可证的兼容库可带警告导入，但不会伪装成标准完整包或积木库。

## 导入与验证

Extension SDK 现在提供统一的 `ckpkg` 开发者命令。解压 [`CK-Extension-SDK-1.0.0.zip`](artifacts/release/CK-Extension-SDK-1.0.0.zip) 后，在 SDK 根目录运行 `npm install --global .` 即可注册 Windows/macOS/Linux 命令入口：

```powershell
ckpkg create my-sensor
ckpkg validate .\my-sensor
ckpkg test .\my-sensor
ckpkg compile .\my-sensor esp32-c6
ckpkg pack .\my-sensor --out .\my-sensor-0.1.0.zip
```

`compile` 只接受包作者在 `ckpkg.json` 中明确映射到完整 FQBN 与 sketch 的 profile，或显式 `--fqbn`/`--example`；它调用真实 Arduino CLI、只编译不上传，失败不会伪造为通过。全部命令提供稳定退出码、`--json` 与 `--output` 机器报告。完整用法见 [`docs/extension-sdk/ckpkg.md`](docs/extension-sdk/ckpkg.md)，从零创建传感器包见 [`完整教程`](docs/extension-sdk/sensor-library-tutorial.md)。SDK 聚合采用 Apache-2.0，机器可读本地发布地址见 [`release-channel.json`](docs/extension-sdk/release-channel.json)；没有真实公开托管地址时 `public_url` 保持空值。

1. 在编辑器打开“库管理器”。
2. 选择“本地导入 -> CK 第三方积木库”，导入 ZIP 或 `library.json`。
3. 确认库出现在“你安装的 CK 积木库”，展开“质量与证据”查看质量报告和五阶段轻量证据护照；板卡和系统库应显示“受保护”。
4. 在侧边栏底部全局搜索积木，搜索结果会显示来源分类。
5. 编译一个最小工程，确认生成器与当前板卡核心版本兼容。

运行内置核心兼容 smoke 测试：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-CoreCompatibility.ps1
```

该脚本会使用本机已安装的 AVR Nano、AVR Mega、ESP32-C5、ESP32-C6 和 ESP8266 Core，并运行内置积木生成器的代表性 compile-only 矩阵。编译通过不等于真板上传或运行验证。
