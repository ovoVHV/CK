# 从零开发一个 CK 传感器积木包

本教程使用 CK Extension SDK 1.0.0 自带的 `sensor-v2` 模板，完成创建、修改、静态检查、真实 compile-only、确定性打包和导入 CK。教程不执行第三方 JavaScript，也不会上传开发板。

> 最可靠的起点是让 `ckpkg create` 生成一套已经通过当前 Schema 和合约测试的完整文件，再在它上面修改。不要从网页片段手抄一套不完整清单。

## 1. 准备环境

- Node.js 20 或更高版本。
- CK Extension SDK 1.0.0。
- 若要真实编译，安装 Arduino CLI、目标 Core，并准备完整 FQBN。

在 SDK 根目录运行：

```powershell
npm install --global .
ckpkg --version --json
```

不全局安装时，把后续 `ckpkg` 替换为 `node .\scripts\ckpkg.mjs`。

## 2. 创建一套可验证模板

```powershell
ckpkg create my-i2c-sensor --dir .\packages
cd .\packages\my-i2c-sensor
ckpkg validate .
ckpkg test .
```

`create` 完成后会立即运行模板自身的门禁；目标目录已经存在时会拒绝覆盖。主要结构是：

```text
my-i2c-sensor/
  library.json
  library.properties
  ck-blocks.json
  blocks/
    blocks.json
    toolbox.xml
  generator/
    ck-generator.json
  src/
    <包专属公共头和 C++ 源码>
    internal/
      <包专属深层 C 源码>
  examples/
    serial_temperature/
      serial_temperature.ino
  tests/
    ckpkg-tests.json
  ckpkg.json
  LICENSE
  README.md
```

模板会为 C/C++ 符号和文件名生成稳定、包专属的前缀，防止两个扩展包安装后发生全局符号冲突。不要随意把这些文件拍平；Arduino 1.5+ 会递归编译 `src/**`，只有 `src/` 本身是公共 include 根。

## 3. 修改身份、作者和许可证

`library.json` 是 Arduino/CK 库身份，许可证字段是 SPDX 字符串，不是对象。生成文件已经包含合法 ID、版本、架构和公共头；先只修改这些值：

```json
{
  "id": "my-i2c-sensor",
  "name": "My I2C Sensor CK extension",
  "version": "0.1.0",
  "description": "读取 I2C 传感器并提供声明式积木。",
  "author": "Your Name",
  "license": "MIT",
  "architectures": ["*"],
  "includes": ["<保留 create 生成的公共头文件名>"]
}
```

上面尖括号说明必须替换为 `create` 已生成的真实 `includes[0]`，不能把占位文字保存进文件。同步修改 `library.properties` 的 `name`、`version`、`author`、`maintainer`；两份版本必须一致。`LICENSE` 要包含你真正选择的许可证正文。

`ck-blocks.json` 的许可证合同则是对象，模板已经生成：

```json
{
  "spdx_id": "MIT",
  "file": "LICENSE"
}
```

SDK 自身的 Apache-2.0 不会自动覆盖你的扩展、素材或依赖。

## 4. 保持四处 block type 一致

一个积木 type 必须同时出现在：

1. `ck-blocks.json` 的 `blocks[].type`；
2. `blocks/blocks.json` 的定义 `type`；
3. `generator/ck-generator.json` 的 `rules[].type`；
4. `blocks/toolbox.xml` 的 `<block type="...">`。

查看模板实际生成的 type：

```powershell
$manifest = Get-Content .\ck-blocks.json -Raw | ConvertFrom-Json
$manifest.blocks[0].type
```

若要重命名，四处必须一次改完，然后立刻运行 `ckpkg validate .`。只改显示文字时，不要改 type。

`blocks/blocks.json` 的根是 Blockly 定义数组，不是 `{ "blocks": [...] }` 包装对象。模板中的单项形状类似：

```json
[
  {
    "type": "<四处相同的真实 type>",
    "message0": "读取 I2C 温度 地址 %1",
    "args0": [
      {
        "type": "field_dropdown",
        "name": "ADDRESS",
        "options": [["0x48", "0x48"], ["0x49", "0x49"]]
      }
    ],
    "output": "Number",
    "colour": 178,
    "tooltip": "从指定 I2C 地址读取摄氏温度。",
    "helpUrl": ""
  }
]
```

尖括号仍表示“保留生成值”，不是可直接保存的字面量。

## 5. 检查 v2 八类机器语义

`ck-blocks.json` 是搜索、工程体检、证据护照和未来受约束 AI 的机器合同。顶层必须包含：

- `schema_version: 2`、包 ID、显示名和说明；
- `license`；
- blocks/generator/toolbox 三个安全相对入口；
- 至少一个完整积木对象。

每个积木必须明确包含八类信息：

1. `semantics`：`purpose`、`behavior`、`side_effects`、`concepts`；
2. `dependencies`：库、Core、头文件、工具或能力依赖；
3. `output`：连接形状、类型、单位和可空性；
4. `hardware`：GPIO、ADC、I2C、SPI、UART、定时器等资源；
5. `generation`：语言、形状、确定性和各输出区段；
6. `constraints`：可确定检查、严重度、提示与恢复方法；
7. `examples`：字段值、示例工程和预期行为；
8. `errors`：大写稳定错误码、原因和恢复方法。

模板已经给出完整 I2C 温度积木。修改时尤其注意：

- `semantics.side_effects` 和 `semantics.concepts` 都是必填数组；
- statement 积木使用 `{ "connection": "none", "types": [] }`，value 积木至少声明一个输出类型；
- `generation.emissions` 至少一项；
- `examples` 至少一项；
- `errors[].code` 必须匹配大写形式，例如 `I2C_DEVICE_NOT_FOUND`；
- 硬件事实未知时保持未知，不从板卡或模组名称猜测。

机器语义是发布者声明。Schema 通过不能证明传感器接线、精度、时序或物理行为正确。

## 6. 使用正式声明式生成器合同

`generator/ck-generator.json` 的根合同固定为：

```json
{
  "schema": "ck-generator",
  "version": 1,
  "rules": [
    {
      "type": "<四处相同的真实 type>",
      "kind": "expression",
      "template": "ckExampleReadTemperature({{field:ADDRESS}})",
      "order": 2,
      "includes": {
        "wire": "#include <Wire.h>"
      },
      "declarations": {
        "read_temperature": "float ckExampleReadTemperature(uint8_t address) { /* 受控实现 */ }"
      },
      "setup": {
        "wire_begin": "Wire.begin();"
      }
    }
  ]
}
```

这里的 `type` 和 C++ 名称应保留 `create` 生成的真实包专属值；上面只展示字段合同，不能把尖括号或示意函数体直接发布。正式键是 `schema/version/rules`，`order` 是 0–99 的整数。允许的占位符只有 `{{field:NAME}}`、`{{field_json:NAME}}`、`{{value:NAME}}`、`{{statement:NAME}}`。

不要添加 `generator.js`、脚本回调、远程资源或自定义执行 hook；CK 1.0 不执行它们。

## 7. 运行静态门禁

```powershell
ckpkg validate . --json --output ..\my-i2c-sensor.validate.json
```

重点修复所有 error：

- 包 ID/版本不一致；
- 缺许可证文件；
- 路径穿越、链接或危险归档条目；
- toolbox、Blockly 定义、generator 和清单 type 不一致；
- v2 必填语义缺项；
- 远程/内联资源或 Legacy JavaScript。

warning 可以继续，但会进入质量报告和积木库证据护照。

## 8. 运行无执行合约测试

`tests/ckpkg-tests.json` 使用 `checks`，不会执行包代码或网络。一个有效示例是：

```json
{
  "schema_version": 1,
  "checks": [
    {
      "id": "example-sketch",
      "kind": "file-exists",
      "path": "examples/serial_temperature/serial_temperature.ino"
    },
    {
      "id": "generator-contract",
      "kind": "json-pointer-equals",
      "path": "generator/ck-generator.json",
      "pointer": "/schema",
      "equals": "ck-generator"
    },
    {
      "id": "generator-uses-wire",
      "kind": "file-contains",
      "path": "generator/ck-generator.json",
      "text": "Wire.begin"
    }
  ]
}
```

执行：

```powershell
ckpkg test . --json --output ..\my-i2c-sensor.test.json
```

## 9. 配置真实 compile-only

`ckpkg.json.compile_profiles` 必须是 1–32 项数组，不是按别名索引的对象。以下是完整、有效的 Nano profile：

```json
{
  "schema_version": 1,
  "compile_profiles": [
    {
      "id": "arduino-nano",
      "fqbn": "arduino:avr:nano:cpu=atmega328old",
      "sketch": "examples/serial_temperature",
      "description": "使用包内示例做真实 compile-only。"
    }
  ]
}
```

模板还自带一个显式 ESP32-C6 profile。发布者必须依据实际 Core 菜单复核完整 FQBN，不能从“C6”别名猜选项。

```powershell
ckpkg compile . arduino-nano --json --output ..\my-i2c-sensor.nano.compile.json
```

该命令调用真实 Arduino CLI、预处理、编译并链接，但永不上传。它只证明所选 profile 的包内 sketch 与当前工具链可编译；要证明新积木生成代码，也应让该 sketch 实际包含并调用包 API。compile-only 仍不是真板验证。

## 10. 确定性打包

```powershell
ckpkg pack . --out ..\my-i2c-sensor-0.1.0.zip --json
```

`pack` 会重新门禁，按 ordinal 路径排序、固定 ZIP 时间戳，并在发布前后复核内容 SHA-256。同一输入应得到相同归档字节。

## 11. 导入 CK 后检查

1. 打开“文件/更多 → 库管理器”。
2. 选择“本地导入 → CK 第三方积木库”。
3. 选择 `my-i2c-sensor-0.1.0.zip`。
4. 在“已安装”中展开“质量与证据”。
5. 检查结构、v2 语义和安全声明式运行；真实编译/真板没有独立凭证时必须保持“待验证”。
6. 在工具箱底部搜索积木，确认结果显示名称、分类和包来源。

## 12. 发布前检查

- 使用稳定包 ID 和 SemVer，不复用版本号替换内容。
- 保存源码、素材和依赖的许可证。
- 对推荐 Core/FQBN 执行至少一次真实 `ckpkg compile`。
- 不把 compile-only 写成真板验证。
- 不把本机质量报告写成 CK 官方签名、推荐或许可证法律意见。
- 发布 ZIP 后记录文件名、字节数和 SHA-256；可信 CI 必须从被测 PR 外的不可变 HTTPS 地址下载并复核固定哈希。

完整命令合同见 [`ckpkg.md`](ckpkg.md)，正式 Schema 位于 `docs/schemas/`。CK 源码仓库中的统一规范入口为 `docs/specification/README.md`；SDK 归档只携带第三方开发所需合同，不复制内部实现文档。
