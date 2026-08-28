# CK 积木库包标准（v1 兼容 / v2 语义契约）

导入器会按本标准执行强制静态门禁，并把机器可读结果写入 `.ck-quality-report.json`。具体检查项、错误与警告分级见 [`package-quality-gates.md`](package-quality-gates.md)。

本标准把 Arduino 库、Blockly 声明式数据和 AI 可读语义放在同一个可校验的包中。新库必须使用标准目录；旧 `blocks.js` / `generator.js` 目录只作为导入迁移源保留，不会进入主 WebView 运行时。

## 标准目录

```text
my-library/
  library.json                 # Arduino/CK 库元数据
  library.properties           # 推荐：供 Arduino CLI 标准发现；缺失时 CK 兼容适配并警告
  ck-blocks.json               # 积木包机器契约（必需）
  blocks/
    blocks.json                # Blockly JSON 积木定义（必需）
    ck-generator.json          # 声明式 Arduino C/C++ 生成规则（必需）
    toolbox.json               # 侧边栏分类和默认 shadow（必需；也可用安全 XML）
  src/                         # Arduino 递归源码根和唯一 include 根
    PublicApi.h                # 根头默认作为公开 API
    driver/
      Driver.c                 # 子目录源码同样参与编译
      DriverInternal.h         # 子目录头默认作为内部实现
  assets/                      # 文档/源码资源；1.0 第三方积木 UI 不直接加载这里的媒体
```

`library.json` 的正式 JSON Schema 位于 [`docs/schemas/ck-library.schema.json`](schemas/ck-library.schema.json)，v1 积木清单位于 [`docs/schemas/ck-blocks.schema.json`](schemas/ck-blocks.schema.json)，声明式生成器位于 [`docs/schemas/ck-generator.schema.json`](schemas/ck-generator.schema.json)。所有入口必须是包内相对路径，禁止绝对路径和 `..`；blocks 和 generator 入口只能是 JSON，toolbox 只能是 JSON 或 XML。导入结果报告遵循 [`docs/schemas/ck-package-quality-report.schema.json`](schemas/ck-package-quality-report.schema.json)。

### Arduino `src/` 递归布局

CK 遵循 Arduino 1.5+ 库布局：只要包中存在 `src/`，`src/` 及其任意子目录内的 C/C++/汇编源码都属于同一个库。`src/Example.c`、`src/driver/Example.c` 和 `src/vendor/chip/Example.cpp` 都是合法结构，不要求把源码搬到 `src/` 根目录。源码发现必须递归、稳定排序且不能跟随符号链接或 Windows junction；包级文件数、单文件大小、总大小和路径边界门禁仍然有效。

快速重链接同样保留源码相对目录，两个不同目录下的同名 `foo.c` 不得写入同一对象文件。原生 `.c` 和 `.S/.s` 必须复用当前板卡 Core 在编译数据库中给出的对应语言 recipe；没有可靠 recipe 证据时自动回退 Arduino CLI，不从 C++ 命令猜测工具链参数。源码树内容、编译依赖和 `.d` 证据共同参与缓存校验，深层头文件修改、删除、移动或等长替换都会让旧对象和 Exact Match 失效。

Arduino 编译时只把 `src/` 加入 include 搜索路径，不会把每个子目录分别加入 `-I`。因此：

- `src/PublicApi.h` 使用 `#include <PublicApi.h>`；
- 需要公开 `src/driver/Sensor.h` 时使用 `#include <driver/Sensor.h>`，并在两个清单中都写 `driver/Sensor.h`；
- `src/driver/Internal.h` 等内部头可以由同目录源码用引号引用，不应仅为让裸文件名可见而扩大全局 include 路径；
- 不允许依赖两个子目录中的同名头由搜索顺序“碰巧”选中。

推荐同时提供 `library.properties`，且其中 `includes` 只能列出 `src/` 下真实存在的安全相对头文件路径；允许 `.h`、`.hh`、`.hpp`、`.hxx`，也兼容模板/内联头 `.inc`、`.ipp`、`.tpp`。禁止绝对路径、`..`、源码文件和目录。若 `library.json.includes` 与 `library.properties.includes` 同时存在，两者必须声明同一组规范化路径。

为兼容现有 CK 积木库，有有效 `library.json` 和递归 `src/`、但缺少 `library.properties` 的包不会仅因此被拒绝。CK 会生成编译兼容适配并在质量报告中记录 `missing-arduino-library-properties` 警告；这只保证 CK 内的适配链路，不表示该包能被标准 Arduino IDE/CLI 独立发现。缺少或损坏 `library.json`、不可读取的 `library.properties`、危险 `includes` 和跨清单公开头不一致仍是阻止项。

## ck-blocks.json

```json
{
  "schema_version": 1,
  "id": "my-library",
  "display_name": "My Library",
  "description": "Controls an I2C sensor module.",
  "keywords": ["sensor", "i2c"],
  "compatibility": {
    "boards": ["arduino:avr:*"],
    "architectures": ["avr", "esp32"]
  },
  "entrypoints": {
    "blocks": "blocks/blocks.json",
    "generator": "blocks/ck-generator.json",
    "toolbox": "blocks/toolbox.json"
  },
  "blocks": [
    {
      "type": "sensor_read_temperature",
      "display_name": "Read temperature",
      "description": "Reads the current temperature and returns degrees Celsius.",
      "category": "Sensors",
      "kind": "value",
      "keywords": ["temperature", "read"],
      "fields": [
        {
          "name": "BUS",
          "kind": "dropdown",
          "description": "I2C bus used by the sensor.",
          "required": true,
          "default": "Wire",
          "options": [{ "label": "Wire", "value": "Wire" }]
        }
      ],
      "inputs": [],
      "output": "Number",
      "requires": ["Wire.h", "MySensor.h"]
    }
  ]
}
```

## ck-generator.json

生成器是严格 JSON 数据，不是 JavaScript。每条规则必须属于同包 `blocks.json` 定义且由 `ck-blocks.json` 声明的同名积木；未知字段、重复 type、错误占位符或超限内容都会阻止导入。

```json
{
  "schema": "ck-generator",
  "version": 1,
  "rules": [
    {
      "type": "sensor_read_temperature",
      "kind": "expression",
      "template": "sensor.readTemperature({{field:BUS}})",
      "order": 2,
      "includes": {
        "sensor": "#include <MySensor.h>"
      },
      "setup": {
        "sensor": "sensor.begin({{field:BUS}});"
      }
    }
  ]
}
```

v1 只接受四种占位符：`{{field:NAME}}`、`{{field_json:NAME}}`、`{{value:NAME}}`、`{{statement:NAME}}`。`kind: statement` 返回语句文本；`kind: expression` 返回文本和 `order`（0–99）。`includes`、`declarations`、`setup` 是按稳定 key 去重的声明式产物。

运行时上限与 Schema 同步：文档最大 512 KiB、最多 128 条规则、单模板最大 16 KiB、每类产物最多 16 项、全部模板合计最大 384 KiB；每次规则调用的动态片段和最终输出另有 64/128 KiB 硬上限，越界直接失败，不产生部分声明式产物。JSON Schema 无法表达的“type 全局唯一”和聚合字节数由导入器和运行时再次校验。

## 数据资源边界

“声明式”不自动等于“无网络”。CK 1.0 的 CSP 尚不能作为第三方包沙箱，因此 blocks/toolbox 数据会递归拒绝 HTTP(S)、协议相对 URL、`file:`、`data:`、`blob:`、WebSocket、CSS `url()`、`src`/`href`/`url` 字段、`field_image`、XML 资源元素/外部实体，以及可触发 toolbox 回调的 `custom` / `callbackKey`。包内媒体资源在提供经过校验的资产解析器之前也不进入第三方积木 UI；需要图片的包应先使用文本标签。

## 字段约束

| 字段 | 要求 | 用途 |
| --- | --- | --- |
| `schema_version` | 必须为 `1` | 允许后续平滑升级格式 |
| `id` | ASCII 字母、数字、点、下划线、短横线 | 稳定的库标识，建议与目录名一致 |
| `entrypoints` | 包内相对文件路径 | 运行时唯一入口，不依赖目录猜测 |
| `blocks[].type` | 字母开头，仅字母、数字、下划线 | Blockly 全局唯一类型 |
| `display_name` / `description` | 非空 | AI 选择积木时的核心语义 |
| `kind` | `statement`、`value`、`hat`、`terminal` | 描述连接形态 |
| `fields` | 静态字段声明 | 告诉 AI 可设置字段、默认值和选项 |
| `inputs` | 值/语句输入声明 | 告诉 AI 如何连接其他积木 |
| `output` | Blockly 输出检查类型 | 约束值积木的连接 |
| `requires` | 头文件或能力名 | 用于依赖分析和编译预热 |

`toolbox.json`（或通过同一资源门禁的 XML）仍是“当前真实可见积木”的准则。`blocks` 目录负责补充语义；AI 只应使用清单与当前工具箱的交集，不能仅凭清单猜测积木可用。

## 运行时发现

后端 `get_all_libraries` 会返回：

- `block_manifest`：已校验的完整清单；
- `block_entrypoints`：解析后的真实绝对入口；
- `block_search_entries`：面向搜索/AI 的逐积木索引；
- `diagnostics`：无效清单、危险路径、缺失入口和类型冲突；
- `has_blocks`、`has_generator`、`has_toolbox`：可直接用于前端加载判断。

前端在板卡和扩展加载完成后生成 `window.CK_BLOCK_CATALOG`。该目录只包含当前侧边栏真实可见的类型，并携带 XML 模板、分类、字段、输入、依赖和所属库；更新时会派发 `ck-block-catalog-updated` 事件。

## 旧库迁移

旧入口 `blocks.js`、`generator.js`、`src/blocks.js` 不再可执行。质量报告、内容 SHA-256 或历史“本机批准”只能证明身份，不能把主 WebView 变成沙箱；在没有独立 extension host 或等效强隔离时一律 `legacy-disabled`。迁移时把 Blockly 定义改成 `blocks/blocks.json`，把生成逻辑改成 `blocks/ck-generator.json`，保留或改写通过资源门禁的 toolbox JSON/XML，新增 `ck-blocks.json`，并为每个工具箱顶层积木补齐 `blocks[]` 声明。

## v2：面向质量门禁和 AI 的完整语义契约

v1 解决“积木叫什么、入口在哪里、基本如何连接”；v2 继续解决“它实际做什么、依赖什么、占用什么、生成什么以及失败后如何处理”。正式 Schema 位于 [`docs/schemas/ck-blocks-v2.schema.json`](schemas/ck-blocks-v2.schema.json)，独立示例位于 [`examples/metadata-v2/ck-blocks-v2.example.json`](../examples/metadata-v2/ck-blocks-v2.example.json)。

v2 不改变包的标准目录，仍使用 `ck-blocks.json` 作为唯一机器契约；清单中的 `schema_version` 改为 `2`。桌面后端同时接收 v1 和 v2：v1 保持兼容并标记为 `v1-adapted`，v2 必须通过完整机器元数据、路径、跨文件一致性和内容哈希门禁。可导入 v2 示例位于 [`examples/importable-packages/ck_example_i2c_sensor_v2`](../examples/importable-packages/ck_example_i2c_sensor_v2)，独立 fixture 继续用于 Schema 回归。

### 每个积木必须声明的八类证据

| 字段 | 机器含义 | 主要消费者 |
| --- | --- | --- |
| `semantics` | 目的、实际行为、副作用和概念标签 | 搜索、文档、AI 选块 |
| `dependencies` | 库、Core、头文件、工具或能力，以及版本和许可证 | 依赖目录、静态兼容提示和后续供应链门禁输入 |
| `output` | 是否有值连接、Blockly 类型、单位和可空性 | 连接校验、AI 组合 |
| `hardware` | GPIO、总线、定时器、网络、存储等资源及共享规则 | 引脚体检、资源冲突分析 |
| `generation` | 目标语言、代码形态、include/API 调用和各生成阶段 | 定义/生成器一致性检查、行为审计 |
| `constraints` | 稳定规则 ID、严重度、目标、操作符、提示和恢复方法 | 导入门禁、编译前体检 |
| `examples` | 可复现参数、预期代码片段、真机行为和适用板卡 | 示例编译、文档、AI 验证 |
| `errors` | 稳定错误码、原因和可操作恢复步骤 | 错误卡片、客服和自动诊断 |

除 `examples` 外，这些证据字段在 Schema 允许没有项目时也要显式写空数组或空资源集合，不能省略来表达“没有”。例如不占硬件资源应写 `"hardware": { "resources": [] }`，没有已知错误应写 `"errors": []`。每个积木仍必须至少提供一个结构化示例，不能用空 `examples` 冒充已有使用证据。这样门禁能够区分“发布者确认没有”和“发布者忘记声明”。

### 依赖、许可证与版本

- 包级 `license.spdx_id` 使用 SPDX 标识，`license.file` 指向包内许可证文件。
- 包级 `dependencies` 表示所有积木共同依赖；积木级 `dependencies` 只补充该积木独有依赖。运行时目录会合并并去重两者。
- Arduino 库依赖必须写稳定库名、版本范围、头文件和许可证；Core、工具和能力也使用同一结构，不能再把任意文字混入 `requires`。
- 当前本机门禁会校验依赖结构、SemVer 选择器、头文件交叉声明与许可证字段形状；它尚未把声明版本和许可证逐项绑定到最终安装内容、Arduino CLI 的实际解析结果或许可证兼容结论。因此这些字段当前是机器可读的发布者声明和诊断输入，不能单独宣传为 CK 已完成供应链认证。
- v1 的 `requires` 会被前端目录适配：明确以 `.h`/`.hpp` 结尾的项归为 `header`，其他无法判定的项保守归为 `capability`。适配结果不会进入 `metadata_completeness`，也不等于发布者已经通过 v2 认证。

### 硬件资源与生成行为

硬件资源的 `source` 明确资源来自哪个字段、输入、固定值或板卡默认值；`sharing` 明确独占、共享或由板卡决定。第三方板卡只有提供对应的可信能力声明后，`board-capability` 约束才可通过。任何无法确定的硬件关系只能产生警告，不能由 AI 猜测为安全。

`generation` 是声明式行为摘要，不是第二段生成器。`emissions` 描述 include、全局区、setup、loop、语句或表达式将生成什么；`calls` 列出关键 API。导入门禁把它与 `ck-generator.json` 和受控示例输出比较。两者都不会授予第三方代码访问 WebView、网络、文件系统或进程的能力。

### 统一目录的信任规则

`window.CK_BLOCK_CATALOG` 的目录格式版本为 `2`，同时容纳 v1 和 v2 包：

- `metadata_source` 为 `v2` 或 `v1-adapted`；
- `metadata_completeness` 只列出发布者真实声明的八类字段；
- `output_contract` 把 v1 字符串输出和 v2 结构化输出统一为同一形状；
- `dependencies` 合并包级、积木级依赖，并把 v1 `requires` 标记为迁移来源；
- v1 字符串示例会变成带 `legacy-example-*` ID 的结构化只读示例。

搜索可以继续展示 v1 积木，但自动组合、冲突判定和行为证明只能把“v2 八类元数据齐全 + 当前质量报告有效”的积木当作可信输入。任何清单、入口或生成器文件在安装后发生变化，都必须让旧质量报告和认证失效。

### v2 门禁最低要求

当前桌面后端对 v2 执行以下确定性检查：

1. 校验 v2 必填区段和公开 Schema，拒绝未知顶层/积木字段、绝对路径和 `..`。
2. 校验包 ID、目录、入口、工具箱类型、积木定义类型和生成器类型一一对应。
3. 校验 SPDX 标识语法和包内许可证文件；校验结构化依赖、SemVer 选择器和生成 include 与依赖声明的一致性。
4. 校验输出形状、字段/输入引用、硬件资源来源、约束引用、结构化示例和错误码。
5. 校验示例引用的工程/生成代码位于包内且真实存在。
6. 根据 `hardware.resources` 进入引脚和资源体检；只有明确声明的资源关系才参与确定性冲突判断。
7. 对包内容生成 SHA-256 质量指纹，写入机器可读质量报告，并在每次加载时复核；安装后篡改会直接失去可信状态。

逐示例编译、生成代码语义验证和许可证兼容性结论属于更高一级的动态认证。声明式运行时消除了第三方 JavaScript 执行面，但不证明生成的 C/C++ 业务逻辑正确；质量报告界面会明确标注本机静态检查不等于 CK 官方背书、发布者签名或真板认证。

门禁结果必须继续采用“确定问题阻止、潜在风险警告”的原则。代码风格、说明完整度和未测试的新 Core 版本不能被误判为已知不兼容。
