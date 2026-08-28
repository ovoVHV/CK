# CK 第三方包自动质量门禁

本文记录 CK 当前实际执行的第三方板卡包、积木包导入门禁。门禁位于 Tauri 后端的真实安装事务中，不依赖发布者手动运行脚本。

## 执行时机

1. ZIP 先解压到临时目录。
2. CK 定位唯一的 `board.json` 或 `library.json` 包根目录。
3. 自动完成静态质量检查并计算内容 SHA-256。
4. 存在 `error` 时停止导入，旧版本不会被覆盖。
5. 只有通过门禁的包才进入用户目录，并写入 `.ck-quality-report.json`。

`warning` 不阻止导入，但会出现在质量报告和界面状态中。`error` 必须由包作者修复。

普通 Arduino ZIP 使用同一 fail-closed 原则，但不强迫作者补 `library.json`：CK 在调用 Arduino CLI 前检查 ZIP 路径/链接/大小、唯一标准库根、递归 `src/**` 或旧根目录/`utility/**` 源码、`library.properties` 可读性、许可证提示和源归档 SHA-256。确定错误会在 CLI 看见 ZIP 前阻止；缺少 `library.properties` 或许可证属于明确兼容警告。CLI 安装后，CK 定位唯一实际安装目录，复核内容 SHA-256 和元数据，随后写入 `package_kind: "arduino-library"` 的质量报告与本地来源标记。报告篡改或库源码变化后，列表只显示失败状态，不能沿用旧证据。该报告只授权 `import-gate` 与 `compile-resolver`，不会让普通 Arduino 库获得积木目录或运行时权限。

## 通用检查

- 清单必须是合法 JSON 对象。
- 包 ID 必须为 ASCII、安全且可直接作为目录名，不能静默改名。
- 包版本必须符合 SemVer。
- 作者、说明和许可证用于第三方来源追踪；缺少时产生警告。
- 所有入口和资源必须是包内相对路径，禁止绝对路径和 `..`。
- 对包内文件按排序后的相对路径与内容计算 SHA-256，安装标记和质量报告本身不参与哈希。

## 板卡包检查

- `schema_version` 必须为 `1`。
- `fqbn_base` 必须是无菜单参数的 `vendor:architecture:board`。
- `arduino_core.package` 必须与 FQBN 的前两段一致。
- `arduino_core.version` 是旧 v1 推荐版本别名；每个包必须提供 `recommended_version` 或该旧别名，让界面能给出最佳选择。新包使用 `recommended_version`、`version_range`、`tested_versions` 和带具体原因的对象式 `known_incompatible`；无原因的版本字符串不再接受。只有低于 `minimum` 或明确命中不兼容项才因版本阻止，`maximum_exclusive` 以上只提示并重新验证。非 Arduino 官方核心还必须提供 HTTP(S) 索引地址。
- `architecture`、FQBN 与核心包三者必须一致。
- 图标必须是存在于包内的安全相对路径；远程 HTTP(S) 图标会破坏离线可复现性并阻止导入。
- 引脚 `label`/`value` 必须非空、长度受限，`value` 与 `aliases` 在整块板上不能产生大小写无关的歧义。最多声明 512 个引脚。
- 旧包只有 `label`/`value` 时仍可导入，但会生成 `missing-detailed-pin-metadata`、能力和证据完整度警告；缺失字段一律解释为“未知”，不能从名字猜测。
- 新包可在每个引脚上声明 `aliases`、`capabilities`、`risks`、`reserved_by`、`sharing`、`connector`、`source` 和 `evidence`。`reserved_by` 兼容旧的单字符串，也可用去重字符串数组声明多个板载资源。一旦声明，这些字段的空值、重复项、未知字段、非法风险等级、越界长度或重复连接器位置都会阻止导入。
- `risks[].severity` 只接受 `blocker`、`warning`、`notice`；可选 `roles` 限定积木使用角色。`when.options` 必须引用同一清单中真实存在的 `custom_menus` 键和值，不能用不存在的配置制造条件风险。`when.features` 可声明 CK 支持的工程特征（当前为 `wifi`），只有工程实际使用对应积木或源码 API 时才激活；未知特征会被导入门禁拒绝。
- `source`/`evidence` 是可审计来源，不等于 CK 真板认证。证据类型、引用、定位信息和可选 SHA-256 均受结构和长度约束。
- 自定义菜单的选项值必须唯一，默认值必须真实存在。
- `extends` 不能逃出包目录。
- `libraries/` 中的每个子目录必须是合法 Arduino 库；包含 `ck-blocks.json` 时继续执行完整积木门禁。
- 一旦声明板卡护照，`hardware_variants`、`validation_profiles` 和 `smoke_tests` 必须同时存在，ID 引用、物理固定选项与默认档案必须一致。
- `validation_profiles.options` 必须声明为完整选项；真实目标无菜单时允许完整集合 `{}`，否则空集合失败。环境门禁还要与 Arduino CLI 的真实菜单契约逐项比对，不能静默使用默认值。FQBN option key/value 只接受 ASCII 字母数字及 `_-.`。
- `validation_matrix.max_cases` 不得超过 64；include 必须可解析，exclude 必须给出原因。
- smoke test 只能引用包内 `.ino` 和固定模式，不接受命令、参数、环境变量或安装 hook。导入阶段不执行 sketch，也不接触设备。

板卡清单的 JSON Schema 位于 [`schemas/ck-board.schema.json`](schemas/ck-board.schema.json)。板卡护照、分级验证、核心升级和 `ck.lock` 证据规则见 [`third-party-board-passport.md`](third-party-board-passport.md)。

## 积木包检查

- `library.json` 与 `ck-blocks.json` 都必须存在，且 ID 必须一致。
- `src/` 是 Arduino 递归源码根：允许 `src/foo.c`、`src/driver/foo.c` 和更深层源码；只有 `src/` 本身是 include 根，不能依赖把每个子目录静默加入 `-I`。
- 推荐提供 Arduino CLI 可发现的 `library.properties`。有可用 `library.json` 但缺少该文件时，CK 启用兼容适配并生成 `missing-arduino-library-properties` 警告，不阻止导入；这不等于标准 Arduino 工具已能独立发现该库。缺少有效 `library.json` 或 `library.properties` 存在但不可读取仍会阻止。
- `library.properties` 版本必须与 `library.json` 一致；`includes` 只能是 `src/` 下真实存在的安全相对头文件路径。嵌套公开头必须写成 `driver/foo.h`，绝对路径、`..`、源码文件、空值和重复项会阻止导入。
- `library.json.includes` 与 `library.properties.includes` 同时存在时必须一致；只在 `library.json` 声明而未在 `library.properties` 声明会产生兼容性警告。
- `ck-blocks.json` 必须声明非空 `blocks` 目录以及 blocks、generator、toolbox 三个入口。
- v2 必须显式声明语义、结构化依赖、输出、硬件资源、生成行为、约束、示例和错误八类证据；缺失、未知字段或越界引用会阻止导入。
- 需要参与精确引脚体检的参数，必须把具体 `field`/`input` 声明成 `gpio`、`adc`、`pwm` 或 `interrupt` 资源，并用 `capabilities` 补充 `uart-rx`、`uart-tx` 等用途。`i2c`、`spi`、`uart` 的 `board-default` 声明表示总线或控制器占用，不会被猜成某个物理引脚；若积木同时允许用户指定 SDA/SCL 等脚，应另外声明对应的物理引脚资源。
- 所有积木类型必须合法且唯一。
- `kind`、`output`、字段、下拉默认值和输入声明必须内部一致。
- 板卡与架构兼容选择器必须合法。
- 工具箱 XML/JSON 必须能解析；工具箱积木集合必须与清单完全一致。
- blocks 入口必须是严格 JSON 定义，generator 入口必须是符合 [`ck-generator.schema.json`](schemas/ck-generator.schema.json) 的 `ck-generator` v1 JSON，toolbox 入口只接受 JSON/XML；`.js`、`.mjs`、`.cjs` 和其他可执行/未知后缀直接阻止。
- 每个清单积木必须在 blocks JSON、ck-generator rules 和 toolbox 中一一对应；额外或缺失 type 都会阻止。
- blocks/toolbox 数据递归拒绝外部和内联资源：HTTP(S)、协议相对 URL、`file:`、`data:`、`blob:`、WebSocket、CSS `url()`、资源属性、`field_image`、XML 外部实体/资源元素，以及 `custom` / `callbackKey` 运行时回调。当前不依赖 CSP 提供此保证，包内图片也要等安全资产解析器后才开放。
- 声明式生成器执行文档、规则、模板、产物数量、聚合模板字节和单次渲染输出硬上限；任何越界都 fail-closed，避免少量规则放大为无界 UI/生成输出。

积木清单的 v1/v2 JSON Schema 分别位于 [`schemas/ck-blocks.schema.json`](schemas/ck-blocks.schema.json) 和 [`schemas/ck-blocks-v2.schema.json`](schemas/ck-blocks-v2.schema.json)，声明式生成器 Schema 位于 [`schemas/ck-generator.schema.json`](schemas/ck-generator.schema.json)。

## 质量报告格式

```json
{
  "schema_version": 2,
  "package_kind": "block-library",
  "package_id": "vendor_sensor",
  "status": "passed",
  "source_content_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "error_count": 0,
  "warning_count": 0,
  "validator_id": "ck.local-package-quality",
  "validator_version": "0.1.0",
  "ruleset_version": "ck-package-quality-v2",
  "generated_at": "2026-07-13T12:00:00.000Z",
  "contract_sha256": "1111111111111111111111111111111111111111111111111111111111111111",
  "certification_level": "local-static",
  "validated_consumers": ["import-gate", "runtime-loader", "block-catalog", "pin-preflight", "compile-resolver"],
  "checks": [
    {
      "code": "toolbox-catalog-consistency",
      "status": "passed",
      "message": "Toolbox block types match ck-blocks.json."
    }
  ]
}
```

状态只有 `passed`、`passed_with_warnings` 和 `failed`。后续 AI、库管理器和发布服务应读取此报告，不应重新猜测目录是否合法。`certification_level: local-static` 只表示当前本机规则集完成了离线静态检查，不等于发布者签名、CK 官方认证或真板验证；报告先记录规则集版本、生成时间和规则哈希，为后续升级时判断证据是否需要重新检查提供输入。当前运行时尚未依据规则集版本自动重认证，具体边界见下文。

`validated_consumers` 按包种类生成，不能把同一组能力套给所有包：板卡报告只声明导入、板卡运行时加载和引脚体检；积木库另外声明积木目录与编译解析；原生 Arduino 库只声明导入和编译解析。该字段表示当前规则集确实为对应消费路径检查过报告，不是功能清单。

## 安装后与运行时复核

- 软件枚举第三方板卡和加载声明式积木数据时会重新计算对应已安装目录的内容哈希；自定义板卡按精确包 ID 进入编译/上传时，也会复核该板卡作用域及其随包子库。文件被手工替换后，旧报告立即失效，不能只靠保留 `.ck-quality-report.json` 继续运行。
- 全局库、架构库和 Arduino 用户库仍作为原生编译候选参与解析，其源码签名会驱动构建缓存失效。通过 CK“Arduino 源码库”ZIP 入口安装的目录可携带独立 `arduino-library` 报告；Arduino CLI 索引安装、用户手工复制或既有目录不会借用该报告，也不得因此描述为已通过 CK 导入门禁。
- 板卡包按精确包 ID 解析自己的配置、引脚和依赖。两个自制板即使共用同一个 Arduino FQBN，也不会共享板卡级积木、库目录或引脚目录。
- 声明式积木运行时要求报告种类为 `block-library`、报告包 ID 与当前 `library.json` 精确一致、状态为通过或带警告通过，并显式包含 `runtime-loader` 消费者；只有三入口完整且质量报告仍有效时才返回 `declarative-safe`。`not-applicable` 只表示没有积木运行时，不能借它激活声明式包。
- 旧安装中由 CK 管理、没有用户安装标记且已经符合声明式三入口的随附包，首次扫描缺少报告时会执行同一静态门并落盘绑定当前内容哈希的报告；这不是来源白名单。已有报告一旦因内容变化而失败，扫描不会自动刷新或掩盖篡改。
- 旧 `blocks.js` / `generator.js` 即使有通过报告、精确内容 SHA-256 和历史本机批准，也始终返回 `legacy-disabled` 并清空运行入口。批准记录是来源/身份记录，不是 JavaScript 沙箱；CK 1.0 没有强隔离 extension host，因此不会把它们送入主 WebView。
- 原生 Arduino C/C++ 库允许 `src/foo.c`、`src/vendor/foo.c` 以及更深层目录，仍按 Arduino 的单一 `src/` include 根递归编译；这种目录灵活性不会放宽 ZIP 路径、符号链接、依赖清单和内容哈希门禁。
- 工程保存的是 `board_package_id` 与完整 FQBN 两个不同身份；库导入、积木加载、编译和上传均携带精确包 ID。包被删除或认证失效后，只允许查看工程，不会静默退回同 FQBN 的内置板卡继续构建。
- 第三方板卡删除只接受与 `board.json.id` 精确一致、通过包 ID 门禁的单一目录名；FQBN 不会改写成目录名。空值、全空白、首尾空白、超长 ID、绝对路径和路径穿越会在任何文件操作前拒绝。板卡根、两类专属库根、最终目标以及从卷根到它们的全部现存祖先都必须是普通目录，不得包含符号链接、junction 或其他 Windows reparse point；root 与 target 还会分别 canonicalize，target 必须是 canonical root 的严格直接子。编译加速 settings 的目录链与文件也执行同样的链接检查，合法 Windows 卷根或 Unix `/` 本身不会被误判。删除前必须从该目录自己的 `board.json` 保存 `fqbn_base`；旧包仅有 `fqbn` 时可提取其 base，双字段冲突则阻止删除。删除后无论 Arduino CLI 板卡同步成功与否，都会用原子设置更新移除这个 base 下已学习的全部完整 FQBN；两个包共用同一 base 时采取保守策略忘记该 base 的全部预热目标，只损失缓存性能，后续使用可重新学习。专属库或同步异常会进入命令返回日志；原子设置清理失败属于部分完成并返回错误，不能再用无条件的 `Deleted` 掩盖。

当前运行时已经强制内容完整性、包种类、通过状态与消费者授权。`ruleset_version` / `contract_sha256` 的跨版本兼容策略仍作为下一层迁移门禁：升级验证器时应先提供“一键重新检查”，再把不兼容旧规则集改为强制过期，避免在没有迁移入口时让所有已安装包突然不可用。旧规则集在重新检查前不得升级为 CK 官方或真板认证。

当前 `contract_sha256` 是对稳定规则契约名称清单的摘要，不是 Schema 文件与验证器源码的完整源码哈希；它只能标识 CK 声明的合同版本。后续若用于跨机器签名认证，必须升级为可复现的 Schema、验证器构件和规则配置组合摘要。

### 当前静态认证仍不证明的事项

- v2 的 `constraints`、单积木板卡/架构约束和错误目录已经结构化并可供搜索，但尚无覆盖所有约束种类的通用编译前执行器；只有已经接线的引脚资源规则会进入当前确定性体检。
- v2 依赖当前会检查字段结构、SemVer 选择器、头文件声明一致性和许可证声明形状，但尚未把声明的库版本或许可证与本机最终安装版本、Arduino CLI 实际解析结果及许可证兼容结论逐项绑定；这些字段目前是可审计的发布者声明，不是完整供应链认证。
- 定义/生成器一致性确认每个清单积木存在 JSON 定义和声明式生成规则，并执行结构、资源与输出上限校验；它仍不证明真实字段、输入和最终 C/C++ 与示例语义完全一致，`expected_code_contains` 留给受控编译认证执行。
- “无第三方 JavaScript”不等于所有数据天然安全：资源 URL 和回调键由导入门与前端加载器双重拒绝，生成文本由预算限制；当前 CSP 为 null，文档和界面不得用 CSP 或“默认无网”来描述保证。未来若重新开放脚本，必须先有独立进程或等效强隔离，而不是恢复哈希批准后在 WebView 执行。
- 当前正式 Schema 已覆盖板卡清单、v1/v2 积木清单、[`library.json`](schemas/ck-library.schema.json) 和 [`.ck-quality-report.json`](schemas/ck-package-quality-report.schema.json)。许可证检查证明声明形状和文件是否存在，不自动给出许可证兼容或可再分发结论。

## 自动验证命令

```powershell
ckpkg validate .\my-extension --json --output .\artifacts\validate.json
ckpkg test .\my-extension --json --output .\artifacts\test.json
ckpkg compile .\my-extension esp32-c6 --json --output .\artifacts\compile.json
ckpkg pack .\my-extension --out .\artifacts\my-extension.zip --json
cargo test -p appsdesktop block_package_tests
cargo test -p appsdesktop package_quality
cargo test -p appsdesktop board_dependency_quality_tests
node --test .\scripts\Validate-BoardPackage.test.mjs
node --test .\scripts\Validate-PackageSchemas.test.mjs
node .\scripts\Validate-BoardPackage.mjs .\examples\importable-packages\ck_example_c6_board
powershell -NoProfile -ExecutionPolicy Bypass -File .\examples\importable-packages\Build-Examples.ps1
```

`ckpkg` 随 Extension SDK 的标准 npm `bin` 分发；`npm install --global .` 后可直接调用，也可使用 `node scripts/ckpkg.mjs`。编译 profile 必须由包内 `ckpkg.json` 明确映射到完整 FQBN 和 sketch，CLI 不根据别名、芯片族或目录名猜配置。`compile` 调用真实 Arduino CLI 且永不上传；静态 `validate/test` 报告中的 `example-compile` 保持 `not_run`。完整合同见 [`extension-sdk/ckpkg.md`](extension-sdk/ckpkg.md)。

分发示例同时是后端回归夹具。示例目录或门禁契约不一致时，测试会失败。

## 下一层门禁

导入门禁只做确定、快速、离线的静态检查。核心安装、第三方 C++ 编译和设备上传不能在普通导入动作里无条件执行，否则会让导入变慢并扩大不可信代码的执行面。

下一层由本机验证器或发布流水线完成。桌面自动认证 v1 逐个验证声明的 `validation_profiles`，并实际编译档案引用的受控 `compile-only` 包内 smoke；旧包没有声明时才使用 CK 固定最小 smoke。成功证据必须带源码/日志哈希、工具链键、构建签名、资源与警告统计；ESP32 还必须带当前分区路径与 64 位分区哈希。设备 smoke 自动跳过，pairwise matrix 不展开，证据必须分别记录 `declared_smoke_tests_executed` 与 `matrix_executed: false`。声明的 timeout 当前仅记录且标为 `timeout_enforced: false`。新核心或工具链允许使用但必须重新验证；不能复用其他核心/工具链身份的旧记录。

`ck.lock` 中的本机证据不可移植，发布者签名只表示板厂自证，CK 签名才表示 CK 复验。客户端必须显示三个不同来源，不能混为一个“门禁通过”。

### 已明确延后的质量工程项

- **第三方板卡/积木包元数据可视化补齐向导：暂缓，不进入当前开发。** 它原计划帮助作者补齐依赖、推荐/兼容 Core 范围、许可证、硬件资源和积木语义：依赖与 Core 信息用于避免“只在作者电脑能编译”，许可证用于追踪来源和分发边界，硬件资源用于引脚/总线/定时器冲突检查，积木语义用于搜索、文档、确定性校验和后续受约束 AI 检索。实现完整向导还会引入 Schema 表单、版本迁移、错误定位、包重打包和多语言维护，当前收益不足以插队编译器与库管理器收尾。现阶段继续以正式 Schema、示例包和导入质量报告作为作者入口，不为省事放宽必填字段或门禁；待核心阻断问题稳定，并收集到真实第三方作者的高频填写错误后再决定只做“缺项清单/模板生成”还是完整可视化编辑器。
- **已完成（2026-07-13）：随板卡分发原生子库的端到端 fixture。** `ck_example_c6_board.zip` 现在携带 `libraries/ck_example_c6_native`，同时保留 `src/CKExampleC6Native.c` 与 `src/vendor/protocol/codec.c`。隔离根目录 Rust 回归会从真实分发 ZIP 开始，验证子报告生成、板卡与子库事务替换、`board-package-libraries/<board_package_id>/<library_id>` 精确作用域、内容完整性复核以及编译候选解析，测试不会读取或写入用户的 AppData/`Documents/CK` 安装目录。C6 的受控 Wi-Fi compile-only smoke 已包含公共头并调用原生函数，因此用户主动执行板卡本机认证时会真实编译和链接深层 C 源码；日常单元测试不强制执行耗时的 C6 冷编译。
- 在 CI 中再使用标准 Draft 2020-12 JSON Schema 引擎验证正式 Schema；当前零依赖 Node 回归实现的是项目所用关键字子集，适合本地快速门禁但不冒充完整标准实现。
- 为 Windows/macOS 默认大小写不敏感文件系统增加包 ID case-fold 冲突和引用路径真实大小写检查。不能在没有迁移方案时直接把已有混合大小写包静默改名；后续应提供诊断和一键迁移后再收紧为规范小写 ID。
- 将 v2 依赖版本与许可证声明绑定到最终安装内容、Arduino CLI 实际解析结果及许可证策略；完成前继续显示为发布者声明/静态检查，不升级为 CK 供应链认证。
