# CK 示例 C6 多配置板卡包

这是一个“板厂拥有自己的硬件系列，但复用公开 Arduino Core 目标”的完整示例。它不是对现实商品的认证，也不能把示例中的引脚和 BOM 原样用于量产板。

示例重点：

- `pins` 演示精确引脚合同：别名、能力、连接器位置、保留用途、按 `JTAGAdapter` 配置生效的 USB 风险，以及可追溯来源。示例证据只是 `board.json` 自身定位，不是真实产品认证；正式板厂应替换为带版本或 SHA-256 的原理图、数据手册或测试报告。
- `hardware_variants` 把 N4、N8、N16 三种物理 BOM 分开，Flash 容量不能靠用户随意猜。
- `validation_profiles` 为每个 BOM 给出完整菜单选项；`options_complete: true` 表示发布者确认没有省略影响 FQBN 的菜单。
- `validation_matrix` 以 `max_cases` 限制组合数量，演示发布流水线预留的分组 pairwise、显式 include 和有理由的 exclude。当前桌面 v1 不展开它，不能因为字段存在就宣称矩阵通过。
- `smoke_tests` 只能引用包内 `.ino`，没有 `command`、`args`、`env` 或安装 hook。导入仅做离线检查；用户启动本地认证后，桌面会逐 profile 实际编译声明的 `compile-only` smoke，设备模式不会自动执行。
- `libraries/ck_example_c6_native` 演示随板卡包分发的原生 Arduino 子库。`src/CKExampleC6Native.c` 与 `src/vendor/protocol/codec.c` 会保留原有层级并按单一 `src/` include 根递归编译；导入后它只进入 `board-package-libraries/ck_example_c6_board/`，不会因为共用 ESP32-C6 FQBN 而泄漏给其他板卡。Wi-Fi smoke 包含该库公共头并调用函数，本机认证会真实完成编译和链接。
- smoke 的 Flash/RAM/警告预算会按编译日志执行；`timeout_seconds` 当前只进入证据，证据会写 `timeout_enforced: false`，不能当成已实现强制超时。
- `arduino_core.version` 是旧 v1 客户端兼容字段，与 `recommended_version` 含义相同，并不是强制锁定版本。非推荐 Core 允许导入和使用，但会显示黄色复验提示；只有低于最低要求或命中已知不兼容范围才因版本阻止。

修改后可独立检查：

```powershell
node ..\..\..\scripts\Validate-BoardPackage.mjs .
```

正式板厂应把 `vendor`、引脚、能力、每个 BOM 的实际容量、核心范围和 smoke sketch 换成真实数据，并至少用每种物理 BOM 的一块样板生成真机证据。
