# 给其他 AI 的 CK 完整库制作规范

适用：CK 9.1.0-alpha.45 起。目标是交付**图形化封装 + 完整 Arduino 驱动目录**，用户导入一次后即可使用，不需要再次搜索、下载同一驱动。

## 直接复制原库文件夹

```text
ck_my_device/
├─ library.json                   包标识、版本、名称、架构
├─ ck-blocks.json                 v2 积木语义、资源与 AI 能力声明
├─ blocks/
│  ├─ blocks.json                 Blockly JSON 定义
│  ├─ ck-generator.json           声明式 Arduino C++ 生成规则
│  └─ toolbox.json                分类和默认参数
├─ libraries/
│  ├─ Servo/                     原库整个文件夹直接放在这里
│  │  ├─ library.properties       原样保留
│  │  ├─ src/
│  │  │  ├─ Servo.h
│  │  │  ├─ avr/Servo.cpp
│  │  │  ├─ avr/ServoTimers.h
│  │  │  └─ ...                  原有所有架构子目录原样保留
│  │  ├─ examples/
│  │  ├─ LICENSE.txt
│  │  └─ ...
│  └─ OtherDependency/            需要的其他 Arduino 依赖，同样整个放入
├─ examples/                     可直接打开的 .ck 和试编译 .ino
├─ LICENSE.txt                   外层图形化封装的许可证
└─ README.md                     接线、初始化、目标范围、限制和来源
```

- 不要把 Servo.cpp、Servo.h 从原库中逐个抽出来，不要把 src/avr 等目录拍平，不需要自己重写舵机驱动。
- 下载的 `Servo-1.2.2` 文件夹可以保持原名。判断依据是其中的 Arduino 库结构，不是必须叫 Servo。
- `libraries/` 的每个直接子文件夹是一份 Arduino 库，库根部应直接含 `library.properties`。旧格式库允许根部放头文件/源文件和 utility/。
- 多依赖放成多个并列文件夹。不能只写 `depends=...` 然后假装依赖已内置；非 Core 依赖需要实际带上。
- 上游 ZIP 先解压成文件夹；ZIP 内部不直接编译。不支持把 `libraries/下载目录/Servo/` 这类多余包装层当作库根。
- 保留原有源码、元数据、许可证和来源。无需自行添加任何 `.ck-quality-report.json`：由 CK 导入校验后生成。
- 外层如果还需要少量自己的适配代码，可另放 `src/`，配匹配的 `library.properties`；这不是嵌入原库的前提。
- `.ino` 示例和 docs/ 不会当成库源码编译。真正的库来源和依赖由 include 发现，未使用的并列库不会强制编译。
- 完整带上驱动不代表跨架构兼容：AVR Servo 不会因为放进 CK 就变成 ESP32 Servo。不要把 architectures 写成 `*` 来掩盖限制。

## 生成规则的精确形状

```json
{
  "schema": "ck-generator",
  "version": 1,
  "rules": [{
    "type": "ck_my_device_write",
    "kind": "statement",
    "includes": {"driver": "#include <ActualDriver.h>"},
    "template": "actualWrite({{value:VALUE}});\n"
  }]
}
```

- `kind` 只用 `statement` 或 `expression`。返回值积木的 Blockly `output` 必须与实际 C++ 返回值对应。
- `includes`、`declarations`、`setup` 是 `{唯一键: C++文本}` 对象，不能写成数组。
- `{{field:NAME}}` 用于真实字段；`{{value:NAME}}` 用于输入表达式；`{{statement:NAME}}` 用于语句体；`{{field_json:NAME}}` 用于字符串字段转义。
- 不要发明不存在的 API、参数、积木字段或占位符。必须读取真实原库头文件/示例后再编写映射。
- 不要给返回值积木生成无效的表达式优先级。不要在循环中反复创建 Servo 对象或把初始化放进每一次读取。
- 不同规则的声明去重键不跨规则共享。多个积木共享全局对象时，推荐在包自身的 `src/Adapter.h` 写 `extern` 声明，在 `src/Adapter.cpp` 定义一次，生成规则只输出 `#include <Adapter.h>` 和操作调用，并为外层适配库配好 `library.properties`。上游完整目录保持原样。
- 不要为了跨规则去重而反复向 Sketch 注入 `#ifndef/#define/#endif`。这些代码能编译，但当前前端会保守转入官方解析，导致无改码和改码仍有明显固定开销。1.0.0 Servo 范例犯了这个错误，1.0.1 已把共享对象移到适配层。原驱动头文件内部的保护指令不受这条建议影响，不需要修改上游驱动。
- 每个包使用唯一稳定的 `library.json.id`，所有 block type 使用该 id 前缀；更换库身份时同步修改三个 JSON 入口中的 type。

## 必填语义与资源

按随包 JSON Schema 验证 `library.json` 与 `ck-blocks.json`，使用 schema_version 2。每个积木明确：用途、实际行为、字段、输入、输出、生成规则、依赖、限制、例子和常见错误。

`hardware.resources` 写明引脚来自哪个输入/字段及用途；`hardware.claims` 写已有协议能表达的共享/冲突声明。没有分析清楚的定时器、供电、总线等设 `coverage: partial/unknown` 并说明，不得伪装为全部无占用。作者不需要为报错定位另外实现界面代码。

依赖声明是描述；文件夹中的真实驱动才是可编译内容。写“已内置”必须能指出实际 `libraries/<name>` 目录。AI 阅读这些声明时不应把作者声明当成硬件测试认证。

## 批量任务可直接复制给 AI

> 请按本规范和随包 schemas，为清单中的硬件逐个制作 CK 图形化库。每个库独立目录、独立 ZIP、唯一 id 和版本。先核对上游驱动实际 API 和目标架构；将完整 Arduino 原库文件夹及所需非 Core 依赖直接放入 libraries/，保留所有子目录、原始 library.properties、许可证和来源。不要拆分/拍平源码、不要写空头文件、不要要求用户再装已宣称内置的驱动，也不要无必要重写驱动。只在 blocks/ 中制作正确的积木和 API 映射，必要时补最小适配层。补齐 ck-blocks v2 语义、资源、限制、返回值和真实示例。先执行结构预检，再通过 CK 导入和当前目标的真实编译。报告每个库实际覆盖的板卡、Core、源代码版本及失败项；未测就写未测，不得伪造质量报告、编译或真机结果。

## 导入和验收

1. 在 CK 选目标板卡，打开库管理器，导入单个库 ZIP；或选择库目录根部的 `library.json`，CK 会复制整个目录。
2. 确认工具箱和搜索中出现全部积木，检查每个默认参数、返回连接和生成代码。
   随包 `.ck` 示例必须在真实 CK 加载后保存并点击编译验证。当前桌面会把部分扩展下拉字段转换为带默认下拉积木的值输入；不能直接按原始 blocks.json 的 fields 拼出工程文件并假定它能运行。裸 Blockly 的字段测试不替代桌面加载链路。
3. 最小示例实际编译；检查使用路径来自该包 `libraries/`，不存在额外已安装驱动掩盖缺包问题。
4. 需要测试目标板卡、多个实例、参数边界、保存重开和改码编译。性能单独检查首次完整构建、无改码重编、只改一个参数三条路径；记录桌面请求总耗时和真实任务收据，不能用“成功编译”代替“加速生效”。无改码应核对无原型、编译、链接、镜像任务；参数编辑应核对实际保留的依赖对象。真实硬件运行另行验证。
5. 每个产物报告包含完整文件列表或哈希、来源、许可、兼容范围和实际测试结果。仅静态检查通过不能写“已编译通过”。

当前 CK 内置 AI 的分段草稿制作接口仍有独立的大小/文件白名单限制。本规范适用于外部 AI 生成完整目录/ZIP 后，通过标准库管理器导入；不要混淆两个入口。
