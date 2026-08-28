# CK 第三方板卡护照与自动验证标准

更新时间：2026-07-13。

这套标准解决的不是“CK 官方逐块替板厂试板”，而是让板厂声明一次真实硬件和有限验证范围，由 CK 自动完成确定性的结构、环境和编译检查。每一种物理 BOM 只需要一块代表样板完成可选真机验证；客户不必重新逐板认证。

板卡护照是 `board.json` 的 v1 加法扩展。旧 v1 包仍可导入，但只能得到“结构检查”状态，不能因为有一个合法 FQBN 就显示成“已编译”或“真机已验证”。完整 JSON Schema 位于：

- [`schemas/ck-board.schema.json`](schemas/ck-board.schema.json)
- [`schemas/ck-board-lock.schema.json`](schemas/ck-board-lock.schema.json)

## 精确引脚目录

`pins` 仍以旧版 `label`/`value` 为最小兼容格式。板厂不需要等待 CK 为每块自制板手工写规则，但要让精确引脚风险图可用，应为每个引脚补充机器可读事实：

```json
{
  "label": "D12 / USB D-",
  "value": "12",
  "aliases": ["GPIO12", "IO12", "USB_D_MINUS"],
  "capabilities": ["digital", "usb", "interrupt"],
  "risks": [{
    "code": "usb-jtag-active",
    "severity": "warning",
    "title": "集成 USB/JTAG 正在使用此引脚",
    "detail": "作为 GPIO 输出可能中断 USB 连接。",
    "roles": ["digital-output"],
    "when": { "options": { "JTAGAdapter": ["builtin"] } }
  }],
  "reserved_by": "native-usb",
  "sharing": "exclusive",
  "connector": { "id": "J1", "side": "left", "position": 7 },
  "source": "publisher-declaration",
  "evidence": [{
    "kind": "schematic",
    "reference": "hardware/rev-a-schematic.pdf",
    "locator": "J1.7 / U1.GPIO12",
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }]
}
```

- `aliases` 用于板厂丝印、Arduino 常量和芯片 GPIO 名之间的精确检索；别名不能与其他引脚值或别名冲突。
- `capabilities` 只记录发布者能用 Core、原理图或实测证明的能力。没有声明就显示“未知”，不能按 MCU 型号自动补全板级事实。
- `risks` 给出稳定代码、等级和可选角色；`when.options` 的所有键和值必须真实存在于 `custom_menus`。多个菜单条件采用“同时满足”语义，值数组表示其中任一值。`when.features` 可引用 CK 已定义的工程特征（当前内置特征为 `wifi`），只有工程实际出现对应功能积木或源码 API 时风险才激活；未知特征不能被导入门禁接受。
- `reserved_by` 描述板载外设或系统功能；可写一个非空字符串，也可写最多 32 个不重复非空字符串的数组。`sharing` 只接受 `exclusive`、`shared`、`board-defined`。
- `connector` 提供可视化排针位置；同一连接器、侧边和位置不能重复。
- `source`/`evidence` 用于追溯，不会自动升级为发布者签名或 CK 认证。引用外部资料时应同时提供稳定版本或内容哈希。

旧包缺少这些可选字段只产生质量警告，不阻止导入；新包一旦声明了错误或互相矛盾的结构则直接阻止，避免错误的“精确图”比没有图更危险。

## 分级状态

| 等级 | 自动检查 | 需要真板 | 可否跨机器复用 |
| --- | --- | --- | --- |
| 结构检查通过 | ZIP、路径、清单、ID、引用、受控 smoke 文件、内容哈希 | 否 | 包本身可以 |
| 环境检查通过 | 核心包、实际核心版本、真实 FQBN、菜单键和值、工具链身份 | 否 | 只有签名证据可以 |
| 本机编译通过 | 声明的完整档案和有限矩阵、固定 smoke sketch、资源预算 | 否 | 本机证据不可以 |
| 发布者验证（保留协议，尚未上线签名验收） | 发布者对包哈希、核心身份和验证记录签名 | 视声明范围 | 可以，但仍是发布者声明 |
| CK 认证（未来认证中心） | CK 基础设施复验并签名，可撤回 | 按认证范围 | 可以 |
| 真机验证 | 芯片、Flash、PSRAM、上传和受控运行时 smoke | 每种物理 BOM 一块代表样板 | 只有签名记录可以 |

当前上线的是本机结构、环境、编译和真机证据；发布者签名、CK 签名与撤回属于保留协议和未来认证中心。将来接入后，界面必须保留“本机”“发布者”“CK”三个来源，不能把发布者自签名显示成 CK 认证，也不能把本机成功编译显示成整个系列真机通过。

## 核心版本不是死锁

`arduino_core` 的版本策略示例：

```json
{
  "package": "esp32:esp32",
  "version": "3.3.6",
  "recommended_version": "3.3.6",
  "version_range": {
    "minimum": "3.3.0",
    "maximum_exclusive": "4.0.0"
  },
  "tested_versions": ["3.3.6"],
  "known_incompatible": [
    {
      "version": "3.3.4",
      "reason": "发布者已复现该版本的分区生成错误",
      "reference_url": "https://example.invalid/board/issues/12"
    }
  ]
}
```

选择规则固定如下：

1. `version` 是旧 v1 的兼容字段，只解释为 `recommended_version` 的别名，不是精确版本锁。两者同时出现时必须相同。
2. 优先安装或使用 `recommended_version`。推荐版不产生版本提示，但没有匹配证据时仍需执行验证。
3. `tested_versions` 表示发布者实际跑过的版本。若当前版本已测试但不是 `recommended_version`，仍允许使用并显示黄色复验提示；只有推荐版本可直接显示为推荐状态。证据只有在包哈希、实际核心版本和工具链身份全部一致时才能复用。
4. `version_range.minimum` 是硬性兼容下限；低于它才阻止。
5. `version_range.maximum_exclusive` 只是“发布者已测试范围”的上界。达到或超过它不阻止使用，只显示“新核心待复验”，自动运行本地矩阵后可继续。
6. 范围内但不在 `tested_versions` 的版本同样允许使用，显示提示并自动复验。
7. 只有低于 `minimum` 或命中 `known_incompatible` 才因版本阻止。`known_incompatible` 必须带具体原因，不能用空泛的“未测试”代替。
8. `ck.lock` 记录本机实际使用的 `actual_version`，不复制一个人为强制的目标版本。

因此，核心升级不会让板卡永久卡死，也不会拿旧核心的成功缓存冒充新核心已经通过。

## 物理 BOM 与完整配置档案

`hardware_variants` 描述能拿在手里的真实型号，例如 N4、N8、N16R8。至少记录：

- 稳定变体 ID 和可读名称；
- 芯片、Flash 字节数、PSRAM 字节数；
- 与物理 BOM 绑定的 `fixed_options`；
- 该 BOM 的默认验证档案。

`validation_profiles` 描述完整 Arduino CLI 菜单后缀。每个档案必须：

- 指向一个 `hardware_variant`；
- 设置 `options_complete: true`；
- 在 `options` 中列出完整菜单键和值，不只写 FlashSize；
- 引用一个或多个受控 smoke test。

`options_complete` 是发布者声明，不是无条件信任。环境检查必须读取 `arduino-cli board details`，确认每个键和值真实存在，并用排序后的完整选项生成 canonical FQBN。少字段、未知值或 BOM 固定选项不一致都不能静默降级为默认值。

如果真实 Arduino 目标完全没有菜单，完整选项集合就是 `{}`，高级护照可以明确写 `options_complete: true, options: {}`。这不是“省略配置”的逃生口：只要后端读取到任意菜单键，空对象就会因不完整而失败。所有进入 FQBN 的 option key/value 只允许 ASCII 字母、数字、`_`、`-`、`.`；逗号、等号、冒号、空白或其他字符一律拒绝。

物理变体仍在新建工程的外部选板流程确定；编辑器内部只能调整该变体允许的编译选项，不能借验证档案实现快速换板。

## 有限矩阵，不跑笛卡尔积

`validation_matrix` 是受限扩展和发布流水线预留契约，支持两种策略：

- `include-only`：只跑明确列出的档案或档案覆盖项；
- `bounded-pairwise`：以一个完整 `base_profile` 为底，在分组的少量维度上做 pairwise 覆盖。

所有矩阵都必须有 `max_cases`，schema 的绝对上限为 64。执行器达到上限必须停止并报告，不能静默丢掉后半部分，也不能扩展成无界组合。

`include` 用来保证关键出厂配置一定被测试。`exclude` 只排除确定无效的组合，必须提供 `reason`。矩阵维度只能覆盖完整档案已有的菜单键；生成后的每个 case 仍是一个完整选项集。

当前桌面自动认证 v1 **只逐个处理 `validation_profiles`，不会展开 `validation_matrix`**。本机 `ck.lock` 证据必须写 `matrix_executed: false`。矩阵只有在发布者或 CK 流水线确实展开并记录每个 case 后，才能标成已执行；清单里存在矩阵字段不等于矩阵通过。

## 受控 smoke test

板卡包不能借自动验证获得任意命令执行能力。`smoke_tests` 只允许：

- 引用包内安全相对路径的 Arduino `.ino`；
- `compile-only`、`device-upload`、`serial-runtime` 三种固定模式；
- 有上限的超时和资源预算；
- 运行时使用固定波特率和单行成功/失败 token。

不允许 `command`、`args`、`env`、PowerShell、批处理、安装 hook 或任意外部 URL 脚本。离线导入阶段绝不编译、上传或运行包内代码。

`compile-only` 只能在环境检查后按用户动作或发布流水线执行。当前桌面本地认证会逐档案读取其引用的包内 `.ino`，再次检查安全路径、普通文件、UTF-8 和 1 MiB 大小上限，然后用完整 canonical FQBN 编译。只有声明的 compile-only smoke 全部实际执行并通过时，`declared_smoke_tests_executed` 才为 `true`。旧包没有声明 smoke 时才回退 `ck-controlled-minimal-v1`。

每个成功的 compile-only 结果记录 `source_sha256`、`log_sha256`、`toolchain_key`、`build_signature`、`duration_ms`、`warning_count`，并在编译器可解析时记录 `flash_used_bytes` 与 `ram_used_bytes`。compile-result 证据还必须记录当前 `certification_engine_contract`，证明资源数据、缓存命中与实际编译参数属于同一套 CK 编译契约。声明了 Flash、RAM 或警告预算但日志缺少必要用量，或实际值超过预算，smoke 会失败。认证成功后，档案顶层 `toolchain_key` 语义必填，并且必须等于该档案唯一的证据工具链键；工具链变化会让认证过期。

ESP32 的每个成功 compile-only 结果还必须包含当前构建的 `partition_path` 和 64 位十六进制 `partition_sha256`。没有可哈希的 `partitions.csv` 时拒绝认证，不能只凭 FlashSize 文本推断分区正确。

清单中的 `timeout_seconds` 当前会原样记录为 `declared_timeout_seconds`，同时明确写 `timeout_enforced: false`。桌面 v1 尚未按该时限终止编译进程，因此这个数值不能展示成“超时门禁已执行”。

桌面仍不展开 pairwise 矩阵，所以所有本机认证证据写 `matrix_executed: false`。`device-upload` 与 `serial-runtime` 在普通认证中只记录 `skipped`，绝不自动接触设备。

`device-upload` 和 `serial-runtime` 必须显式写 `requires_user_consent: true`，客户端还必须在实际执行前再次取得用户确认。换端口、擦除 Flash 或运行测试都不能由导入动作偷偷触发。

## `ck.lock` 与三种证据

`ck.lock` 是验证结果，不是作者手写的兼容承诺。真实后端输出只使用一套 `BoardPassport` 结构：

- `board`：板卡 ID、名称、包版本、厂商和基础 FQBN；
- `source_package_sha256`、`source_content_sha256`、`installed_content_sha256` 与 `menu_schema_sha256`；
- `core_requirement`：从清单规范化出的推荐、最低、已测试上界、已测试版本和明确不兼容项；
- `core`：本次唯一实际核心字段 `installed_version`，以及 `status`、`usable`、`requires_revalidation`、已安装版本列表、警告和说明；
- `certification_engine_contract`：生成当前认证证据的 CK 编译契约；新生成的锁文件必须包含，compile-result 证据必须写入相同值；
- `profiles[]`：档案 ID、物理变体、完整 options、声明的 smoke ID、canonical `fqbn`、状态、检查时间、实际 `core_version`、认证工具链 `toolchain_key`、安装内容哈希和证据；`compile_passed`、`device_verified` 状态下这些认证身份字段语义必填；
- 顶层 `evidence_provenance` 与每条 `evidence.provenance`，明确区分 `local`、`publisher` 和 `ck`。

包内容哈希必须排除 `ck.lock`、安装来源标记和本机质量报告，避免自引用。包、核心平台、认证 `toolchain_key`、完整 FQBN、smoke sketch 或 `certification_engine_contract` 任一变化，旧记录都必须失效并重新验证。

证据语义：

- `local`：当前 CK 安装生成，只能与当前安装内容、实际核心和菜单身份一起复用；不得保存原始 MAC、芯片序列号或 USB 序列号。
- `publisher`（保留协议，尚未上线验签）：板厂私钥对规范化验证记录签名，可以随包发布；它证明“发布者声明并签过”，不等于 CK 复验。
- `ck`（未来认证中心）：CK 验证基础设施复跑后签名，支持撤回；只有这一类可以显示 CK 认证标识。

证据的 `kind` 表示结果类别，例如 `environment-result`、`compile-result`、`device-result`；`provenance` 才表示来源。发布者与 CK 证据必须使用独立 `key_id`，签名覆盖规范化记录的 `payload_sha256`。客户端必须校验包哈希、签名和撤回状态后才可展示可移植状态。

## v1 迁移

不含护照字段的旧 `board.json` 无需改 `schema_version`，继续通过原有结构门禁。迁移按以下顺序逐步完成：

Rust 后端仍能读取缺少 `certification_engine_contract` 或使用旧契约的 `ck.lock`，但只把它当作迁移输入：评估时会标记 `certification_engine_changed` 并取消旧的绿色编译认证。当前 v5 契约要求 Fast Relink 在克隆、播种或执行 `compile_commands.json` 前验证实际有效参数为 `-O1 -g0 -fno-lto`，要求 Core 归档来自同一已验证缓存身份，并把依赖对象缓存绑定到认证引擎契约；旧 `-Os` CCDB、无法证明来源的 Core 归档或旧合成规则产生的依赖对象均不得产生资源认证。用户重新运行档案认证后，CK 才会写入当前契约和新资源证据。官方 Schema 要求所有新生成的 `ck.lock` 以及其中的 compile-result 证据都带该字段；不得通过手工补字段恢复旧认证。

1. 把旧 `arduino_core.version` 复制到 `recommended_version`，保留旧字段照顾旧客户端。
2. 增加 `version_range`、`tested_versions` 和有证据的 `known_incompatible`。
3. 增加真实 `hardware_variants` 与每个 BOM 的完整 `validation_profiles`。
4. 添加最小 `compile-only` smoke sketch。
5. 最后增加有 `max_cases` 的矩阵和可选真机验证。

示例源码和可导入 ZIP 位于 [`../examples/importable-packages/ck_example_c6_board`](../examples/importable-packages/ck_example_c6_board)。离线校验命令：

```powershell
node .\scripts\Validate-BoardPackage.mjs .\examples\importable-packages\ck_example_c6_board
```

这个命令只检查声明、引用和文件安全，不会安装核心、编译或接触串口。环境、编译和真机状态必须由后续分级门禁产生。

发布流水线也可以传入将要使用的实际核心版本，提前执行相同的版本决策：

```powershell
node .\scripts\Validate-BoardPackage.mjs .\examples\importable-packages\ck_example_c6_board --core-version 4.1.0
```

这个示例会通过并提示重新验证；只有传入低于 `minimum` 或命中 `known_incompatible` 的版本才失败。
