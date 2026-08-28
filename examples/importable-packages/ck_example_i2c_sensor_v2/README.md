# CK I2C 传感器积木 v2 示例

这是一个可直接打包导入的积木库示例。`library.json` 供 CK 导入器和质量门禁读取，`library.properties` 保证同一份源码也能被 Arduino CLI 标准库发现；`ck-blocks.json` 不只列出积木名称，还完整声明了语义、依赖、返回值、硬件资源、代码生成行为、约束、示例和错误恢复信息。

软件导入时会执行结构、路径、许可证、跨文件一致性和内容哈希门禁。积木外观使用 `blocks/blocks.json`，生成规则使用受限的 `blocks/ck-generator.json`；它们不具备网络、文件、进程或主界面脚本执行能力。安装后的文件发生变化会令原质量报告失效，必须重新导入后才能恢复可信状态。

本示例仅用于说明包格式和质量门禁，不代表某一款真实 I2C 传感器的协议认证。

`src/CKExampleSensorMath.c` 与 `src/internal/CKExampleSensorCodec.c` 用来验证第三方库安装时会完整保留并编译根级、嵌套目录中的 C 源文件。`src/internal/CKExampleSensorCodec.h` 使用标准 `extern "C"` 保护，`CKExampleSensor.cpp` 会实际调用两份 C 实现，因此文件缺失或递归复制失效都会在链接阶段被发现。

## 1.x → 2.0.0 声明式迁移演示

`ck-migrations.json` 只包含数据操作，不包含 JavaScript：

1. `renameBlockType`：`ck_example_read_temperature` → `ck_example_read_temperature_v2`；
2. `renameField`：`I2C_ADDRESS` → `ADDRESS`；
3. `mapEnum`：`72/73` → `0x48/0x49`。

`migration-fixtures/legacy-1.5.0.workspace.json` 是配对的旧 Blockly JSON。它用根积木和 input shadow 覆盖两个枚举分支，同时在 `extraState` 中放入一个看似积木的原始对象，用于证明迁移器不会深入或改写第三方不透明状态。重建 ZIP 前，`Validate-ImportablePackage.mjs` 会逐项执行契约覆盖检查；漏映射、危险路径、额外脚本字段或包 ID 不一致都会阻止打包。

软件集成应把迁移作为“预览 → 检查点 → 提交”的事务，不应在导入 ZIP 时静默改工程。阻断计划中的候选工作区只能用于影响预览，不能覆盖原工程。

2026-07-13 本机回归：同一示例工程已分别通过 Arduino AVR Core 1.8.6（Nano）和 ESP32 Core 3.3.6（ESP32-C6）实际编译。该记录只证明这两个明确目标的编译兼容性，不代表所有 `architectures=*` 目标已经动态认证。
