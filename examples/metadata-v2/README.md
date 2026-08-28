# CK 积木元数据 v2 示例

`ck-blocks-v2.example.json` 是独立的规范 fixture，用于演示和自动测试 v2 机器契约。可直接导入的完整包位于 `examples/importable-packages/ck_example_i2c_sensor_v2/`；它不会替换 `ck_example_serial_blocks` 的 v1 兼容性样例。

示例完整声明了：

- SPDX 许可证与结构化依赖；
- 功能语义、字段、输入和返回值；
- 板卡能力、总线和硬件资源占用；
- Arduino C++ 代码生成阶段与调用行为；
- 可机器执行的约束、示例预期和稳定错误码。

正式 Schema 位于 [`../../docs/schemas/ck-blocks-v2.schema.json`](../../docs/schemas/ck-blocks-v2.schema.json)。当前运行时同时接受 v1 和 v2；只有八类元数据齐全且当前质量报告有效的 v2 包，才可被自动组合、冲突分析和后续 AI 能力当作可信输入。
