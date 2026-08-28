# CK 可导入积木库示例

这个目录是最小但完整的 CK 第三方积木包：

- `library.json` 提供库的安装与展示元数据。
- `ck-blocks.json` 提供 AI、全局搜索和兼容过滤所需的机器契约。
- `blocks/blocks.json` 以纯 JSON 注册 Blockly 外观与字段。
- `blocks/ck-generator.json` 使用受限模板生成与当前 Arduino 核心兼容的 C++ 代码。
- `blocks/toolbox.xml` 决定积木是否真实出现在侧边栏中。

`ck-blocks.json` 中声明的积木类型必须与工具箱、积木 JSON 和生成规则一一对应。入口必须是包内相对路径，不允许绝对路径或 `..`。CK 1.0 不会在主界面执行第三方 `blocks.js` 或 `generator.js`；内容哈希审批也不能把旧 JavaScript 变成沙箱。
