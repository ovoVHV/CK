# 库声明硬件用途，CK 统一识别

版本：alpha.18，2026-11-04。沿用 `ck-blocks.json` schema_version 2、`hardware.claims.version: 1`，不增加按库名匹配的接口。

## 分工

- 库作者：声明每个积木使用的资源、值来自哪个字段或输入、所需能力、共享方式及覆盖程度。声明必须与实际生成代码一致。
- 板卡包：提供引脚、别名、能力、保留用途；完整资源检查还需要通过校验的 `resource_graph` 和准确的编译目标身份。
- CK：校验声明，读取当前 Blockly 值，按所选板卡解析、显示占用及冲突。软件改变字段的 UI 形态时负责保留映射，库不需要跟着修改。

新增使用现有资源语义的库，只需补元数据和通过库质量检查，不需要修改 CK 代码。新硬件语义超出当前协议、板卡模型不支持、动态表达式无法静态确定时，必须标为未覆盖或待确认；不能承诺任意库的所有电气和时序行为都已验证。

## 一个数字引脚字段的声明

以下是一个积木条目的相关片段，不是完整可安装的库清单；完整条目还需其他 v2 必填项。

```json
{
  "fields": [{ "name": "OUTPUT", "kind": "number", "description": "输出引脚", "required": true, "default": 5 }],
  "inputs": [],
  "hardware": {
    "resources": [{
      "kind": "gpio",
      "id": "output",
      "description": "输出信号",
      "source": { "kind": "field", "name": "OUTPUT" },
      "access": "write",
      "sharing": "exclusive",
      "capabilities": ["digital-output"]
    }],
    "claims": {
      "version": 1,
      "coverage": "partial",
      "templates": [{
        "id": "output-pin",
        "resource": { "kind": "field", "name": "OUTPUT", "valueType": "id" },
        "role": "digital-output",
        "exclusive": true
      }]
    }
  }
}
```

`hardware.resources` 用于引脚用途、能力和共享检查；`hardware.claims` 用于板卡资源图的绑定和冲突检查。两者应描述相同实际用途，不应只填显示文案。`OUTPUT` 必须真实存在于积木定义和字段声明中，不能只因为字段名包含 PIN 就自动认为它是引脚。

## 值来源与边界

| 库声明 | 软件处理 |
|---|---|
| `field` + `name` | 读取原始字段；若声明式加载器将数字/下拉字段转成输入，读取其真实连接值 |
| `input` + `name` | 读取输入上的数值字面量、文本、板卡引脚选择器，或加载器自己创建的数字/下拉字面量 |
| `fixed` + `value` | 使用库明确声明的固定值，按当前板卡验证 |
| `board-default` | 不凭板卡名猜测；引脚列表无法直接解析时显示未覆盖。资源声明可以通过已解析板卡图中的总线别名和路由检查默认连接 |
| 变量、算术表达式、空输入 | 标为未知或缺失，不执行生成器求值，不读取默认值冒充当前值 |

总线、地址、定时器等使用已有 claims 的 `resource`、`discriminator`、`configuration`、`signals`；是否能够检查取决于板卡图的能力。协议版本不支持或声明格式错误由现有质量门禁拒绝，不能默默降为“检查通过”。

`coverage: partial` 和 `unknown` 必须如实保留。`full` 也只是作者声明的资源覆盖程度，不等于 CK 做过硬件实测。确实不使用硬件的积木可以声明空 resources 和 full 的空 templates；不得把“尚未分析”伪装成空资源。

## 发布验证

1. 使用 `desktop/docs/schemas/ck-blocks-v2.schema.json` 和 `ck-resource-claims.schema.json` 校验；执行现有库安装质量门禁，检查字段引用、入口和版本。
2. 从真实工具箱加载积木，检查初始值、改值、保存重开、变量替换、缺失输入、非法引脚和共享冲突。
3. 分别检查引脚面板和资源面板；AVR、ESP32、第三方板卡均走声明绑定，已知内置积木的语义不允许库覆盖。
4. 核对检查前后工作区与生成代码一致；只读检查不得改接线或修改程序。

本仓库提供 13 个原始硬件包的声明式回归夹具及 ZIP SHA256，路径为 `desktop/apps/desktop/src/services/fixtures/hardware-0.2.0`。在 `desktop/apps/desktop` 下执行：

```powershell
node --test src/services/blockly_compat_analysis.test.mjs
```

这是声明读取和检查链路的验证，不是这些设备的实物兼容认证，也不改变库原有 AVR/ESP32 支持范围。
