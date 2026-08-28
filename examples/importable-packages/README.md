# CK 可导入包示例

这个目录同时提供板卡包和 CK 积木库包。子目录是可修改的源码，旁边同名的 ZIP 是可直接交给 CK 导入器的发布包。

```text
importable-packages/
  ck_example_nano_board/          # 板卡包源码
    board.json
    LICENSE
    assets/board.webp
  ck_example_nano_board.zip       # 可直接导入的板卡包
  ck_example_c6_board/            # 第三方、多 BOM 板卡护照示例
    board.json
    LICENSE
    assets/board.svg
    libraries/
      ck_example_c6_native/       # 只属于该板卡包的原生 Arduino 子库
        library.json
        library.properties
        src/
          CKExampleC6Native.c
          vendor/protocol/codec.c # 深层原生源码保持原目录
    smoke/
      wifi_compile/wifi_compile.ino
      zigbee_compile/zigbee_compile.ino
  ck_example_c6_board.zip         # 可直接导入的多配置板卡包
  ck_example_serial_blocks/       # 积木库源码
    library.json
    ck-blocks.json
    LICENSE
    blocks/
      blocks.json                  # 无执行能力的 Blockly JSON
      ck-generator.json            # 受限 C/C++ 模板规则
      toolbox.xml
  ck_example_serial_blocks.zip    # 可直接导入的积木库包
  ck_example_i2c_sensor_v2/       # 完整 v2 语义 + 原生 Arduino src 示例
    library.json
    library.properties
    ck-blocks.json
    ck-migrations.json             # 仅含确定性 rename/map 声明
    migration-fixtures/
      legacy-1.5.0.workspace.json  # 与迁移声明配对的旧工作区
    blocks/
    src/
      CKExampleSensor.cpp
      CKExampleSensorMath.c
      internal/CKExampleSensorCodec.c
  ck_example_i2c_sensor_v2.zip    # 可直接导入的 v2 积木库包
  ck_example_native_deep/         # 没有 Blockly 的纯原生 Arduino 库
    library.json
    library.properties             # depends / architectures / includes
    LICENSE
    README.md
    src/
      foo.c
      driver/foo.cpp
      vendor/deep/foo.c
  ck_example_native_deep.zip      # 从“Arduino ZIP”入口导入
  Build-Examples.ps1              # 校验并确定性重建五个 ZIP
```

## 导入板卡包

1. 回到 CK 的新建工程页面。
2. 打开“第三方板卡”。
3. 选择最小兼容示例 `ck_example_nano_board.zip`，或选择完整板卡护照示例 `ck_example_c6_board.zip`。
4. 导入后在外部新建工程页选择对应板卡；编辑器内部不负责切换物理板卡。

板卡只在新建工程页面选择。编辑器内部不会用这个示例切换当前工程的板卡。

`board.json` 中的 `id` 是 CK 内部稳定 ID，目录名应与它一致；`fqbn_base` 才是 Arduino CLI 的真实编译目标。Nano 包保留最小 v1 写法，用来验证旧包仍可导入。C6 包演示三种物理 BOM、三个完整配置档案、受控 smoke sketch 和有上限的 include/exclude 矩阵。

`arduino_core.version` 在旧 v1 包中解释为推荐版本，不是精确锁。新包应同时写 `recommended_version`、已测试范围和 `tested_versions`；实际使用的核心版本只记录到安装后生成的 `ck.lock`。非推荐版本不会仅因版本不同而被阻止：已测试、范围内未实测或高于测试上界时均允许继续，并显示黄色复验提示；只有低于最低要求或命中已知不兼容范围才因版本阻止。

C6 示例还在 `libraries/ck_example_c6_native/` 内随板分发一个原生 Arduino 子库。它同时包含 `src/CKExampleC6Native.c` 与更深层的 `src/vendor/protocol/codec.c`，不要求作者把原生文件拍平。导入后该库只安装到 `board-package-libraries/ck_example_c6_board/`，不会泄漏给共用 `esp32:esp32:esp32c6` 的其他板卡包；Wi-Fi compile-only smoke 会包含公共头并调用库函数，因此本机板卡认证会真实编译和链接这两个 C 源文件。

精确引脚风险图不要求 CK 官方为每块自制板手写代码。板厂在自己的 `pins` 中逐步补充 `aliases`、`capabilities`、`risks`、`reserved_by`、`sharing`、`connector`、`source` 和 `evidence` 即可；最小的 `label`/`value` 旧写法仍能导入，但缺少的事实只显示“未知”。同一 Arduino FQBN 下的不同第三方板卡仍以各自包 `id` 区分，搜索和体检读取被选中包自己的引脚目录，不借用其他板卡数据。详细合同见 [`../../docs/third-party-board-passport.md`](../../docs/third-party-board-passport.md)。

可单独执行离线声明校验：

```powershell
node ..\..\scripts\Validate-BoardPackage.mjs .\ck_example_c6_board
```

## 导入积木库包

1. 打开任意工程的“库管理器”。
2. 进入“本地导入”，选择“CK 第三方积木库”。
3. 选择 `ck_example_serial_blocks.zip`。
4. 在侧边栏底部搜索“串口”“消息”或“示例”，结果来源应显示“可导入示例”。

该积木只使用 Arduino 各核心通用的 `Serial.begin` 和 `Serial.println` API，因此清单将兼容范围声明为全部板卡和架构。制作硬件专用积木时，应将 `compatibility.boards` 或 `compatibility.architectures` 收窄到真实支持范围。

要参考完整 v2 机器语义和原生 Arduino 库布局，请导入 `ck_example_i2c_sensor_v2.zip`。`src/` 是递归源码根，允许把原生库按真实结构保留为 `src/foo.c`、`src/driver/foo.cpp` 或更深层目录；只有 `src/` 本身是公开 include 根，嵌套公开头在 `library.properties` 中按 `driver/foo.h` 这类相对路径声明。

### 导入纯 Arduino 源码库

`ck_example_native_deep.zip` 没有 `ck-blocks.json`，不能从“CK 第三方积木库”按钮导入。请在库管理器进入“本地导入”，选择右侧“Arduino 源码库 → 选择 Arduino ZIP”。CK 会先检查归档路径/链接/大小、唯一 Arduino 库根、递归 `src/**` 或旧布局、元数据和内容 SHA-256，再交给 Arduino CLI 兼容安装；安装后复核实际目录并生成 `package_kind: arduino-library` 的质量报告。它只进入编译依赖与源码身份解析，不会伪装为侧边栏积木，也不会获得积木运行时权限。

可以新建任意带 `Wire` 的 Arduino 工程，包含 `CKNativeDeep.h` 与 `driver/CKNativeDriver.h`，或参考包内 `examples/native_deep_smoke/native_deep_smoke.ino`。一次真实编译会同时覆盖根级 `src/foo.c`、嵌套 `src/driver/foo.cpp`、深层 `src/vendor/deep/foo.c` 和 `depends=Wire` 依赖闭包。两个 `foo.c` 路径不得被拍平成同一个对象。

旧 Arduino 1.0 的根目录源码加 `utility/` 不与标准 `src/` 包混装。独立兼容夹具位于 `scripts/fixtures/importable-packages/legacy_utility_library`，只供自动化验证编译发现规则，不会进入任何用户 ZIP。危险 `includes=../escape.h` 负面夹具也只在 `scripts/fixtures` 中，重建脚本的显式包清单不会读取它。

### 验证积木包迁移演示

`ck_example_i2c_sensor_v2.zip` 内的 `ck-migrations.json` 把 1.x 的 `ck_example_read_temperature` 重命名为 v2 类型，把字段 `I2C_ADDRESS` 重命名为 `ADDRESS`，再将旧枚举 `72/73` 映射为 `0x48/0x49`。配对的 `migration-fixtures/legacy-1.5.0.workspace.json` 同时覆盖根积木、input shadow 与不透明 `extraState/mutation`；后两者必须原样保留。

导入 v2 ZIP 后，迁移集成应先显示 dry-run 的版本路径、受影响积木和三项操作，创建迁移前检查点后才允许提交。任何无路、多路、环、未映射枚举或字段碰撞都必须阻止写入。离线作者回归可直接执行：

```powershell
node ..\..\scripts\Validate-ImportablePackage.mjs .\ck_example_i2c_sensor_v2 --kind block
```

## 重新打包

修改示例后，在本目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Build-Examples.ps1
```

脚本会解析五个示例包中的 JSON 清单，调用板卡护照离线校验器检查变体、完整配置、引用、矩阵边界和 smoke sketch，再检查 v1/v2 标准积木入口、迁移契约、纯原生 Arduino 清单、`library.properties` 交叉声明、安全相对路径与必要文件。文件按 ordinal 路径排序，ZIP 时间戳固定为 1980-01-01；同一输入重复重建会得到相同 SHA-256。ZIP 内只保留唯一顶层包目录，这是当前 CK 导入器支持的发布结构。

需要在临时目录只重建部分包时，可使用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Build-Examples.ps1 `
  -OutputDirectory .\out `
  -Package ck_example_native_deep,ck_example_i2c_sensor_v2
```

CK 导入时还会运行真实后端质量门禁，检查跨文件积木类型、声明式生成规则、核心契约、路径安全、许可证和内容哈希。通过后，安装目录会生成 `.ck-quality-report.json`；完整规则见 [`../../docs/package-quality-gates.md`](../../docs/package-quality-gates.md)。CK 1.0 的第三方可信入口只接受 JSON 积木定义、`ck-generator` JSON 与 JSON/XML 工具箱；旧 `blocks.js`/`generator.js` 即使有本机哈希审批也保持禁用。

面向 AI 检索、组合和冲突分析的 v2 完整语义清单位于 `ck_example_i2c_sensor_v2/`，并由 `Build-Examples.ps1` 生成可导入 ZIP。它演示语义、结构化依赖、输出、硬件资源、代码生成、约束、示例和错误恢复八类机器元数据；`ck_example_serial_blocks` 继续保留为 v1 兼容性回归样例。独立 Schema fixture 见 [`../metadata-v2/ck-blocks-v2.example.json`](../metadata-v2/ck-blocks-v2.example.json)。
