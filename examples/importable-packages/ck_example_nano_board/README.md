# CK 示例 Nano 板卡包

这个目录本身就是板卡包源码。发布时将整个目录压缩成 ZIP，确保 `board.json` 位于 ZIP 根目录或唯一顶层目录。

关键约束：

- `id` 必须稳定、可用作目录名，并与包目录名称一致。
- `fqbn_base` 必须是 Arduino CLI 能识别的真实 FQBN。
- `arduino_core.package` 声明核心 ID，`version` 记录该包验证过的版本。
- `icon` 使用包内相对路径，不能指向开发者电脑上的绝对路径。
- `pins` 保留最小 `label`/`value` 格式，用于演示旧 v1 包仍可导入。质量报告会明确提示缺少能力、风险和来源，不会把该示例冒充为精确引脚认证；新板卡请参考相邻的 `ck_example_c6_board`。

本示例使用仓库中已安装并完成兼容测试的 `arduino:avr@1.8.6`，编译目标为 `arduino:avr:nano`。
