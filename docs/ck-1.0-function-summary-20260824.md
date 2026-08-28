# CK 1.0 当前功能与边界摘要

更新时间：2026-08-25

## 产品定位

CK 是面向 Arduino 兼容板卡的桌面图形化编程工具。它把积木编辑、源码生成、编译、上传、串口调试、板卡/库扩展和可复算的构建证据放在同一工程内。当前交付定位是 Windows 本机与封闭测试版，不等同于完成代码签名、时间戳和公开分发审核的正式安装版。

## 用户可直接使用的功能

### 工程与积木编辑

- Blockly 积木工作区、拖拽连接、撤销/重做、缩放和工程恢复。
- 内置积木库按板块分类，支持全局搜索；搜索结果显示所属板块。
- 自定义积木颜色、积木参数编辑、板卡引脚下拉和硬件约束提示。
- 积木 ID 与生成源码标记保持关联，可从错误或诊断结果定位回积木。
- `.ck` 工程保存积木、源码、板卡配置、依赖和工程元数据；当前规范为 CK Project Format v1，并保留迁移版本字段。
- 工程检查点、上一个可用版本、工程恢复和基线差异入口。

### 板卡、库和扩展

- ESP32、AVR、SAMD、STM32、ESP8266、RP2040、Renesas 等已安装 Arduino Core 的板卡解析。
- 板卡包、积木库和普通 Arduino ZIP 导入。
- 第三方包目录、JSON Schema、依赖、许可证、硬件资源、生成行为和示例的结构化描述。
- 导入质量门禁：路径穿越/链接、大小、目录结构、元数据、依赖、许可证、兼容性、内容哈希和生成器一致性检查。
- 普通 Arduino 库支持 `src/**` 递归布局、深层目录和 legacy `utility/`；不会把同名深层文件错误合并。
- Extension SDK、`ckpkg` 创建/校验/测试/打包流程和示例包。
- 第三方 JavaScript 生成器默认 fail-closed；未通过声明式门禁的 legacy 脚本不执行。

### 编译与上传

- “编译”和“普通上传”保持两个独立的一键操作，避免误烧录。
- 原生 Arduino CLI Release 回退路径覆盖未认证目标和不兼容配置。
- Exact Match、同板缓存复用、快速重链、ccache、并行编译和编译锁。
- 完整 FQBN、Core、工具链、配置、源码指纹和依赖签名绑定；身份不一致时拒绝复用旧缓存。
- 刷新当前板卡缓存前有明确确认入口，支持重新生成并烧录。
- 上传前串口监视器自动释放，上传后恢复；上传进度、日志、产物清单和 Flash/RAM 资源统计。
- Flash/RAM 预算按板卡报告的实际上限计算，支持不同 FlashSize、分区方案和 PSRAM 菜单。
- 编译医生/工程体检：依赖、Core、板卡认证、资源、引脚冲突、缺失库和上一次可用版本状态。

### FLFE 快速编译

FLFE（Fast Link For Ever）使用严格的“先证明等价，再允许加速”策略：

- 当前 production EXE 和正式 Fast 资格不在摘要中固定写死；证书必须绑定正在运行的 EXE、主机、CLI、Core、工具链、完整 FQBN、adapter、源码和产物证据。请运行 `node scripts/Report-CKForgeFastQualifications.cjs --format text` 查询。
- `f47acdd2…`、`792c3ab2…` 等旧 EXE 的资格和测速记录只作历史对照，不能授权覆盖安装后的新 EXE。
- 未取得当前证书的目标继续走原生 Arduino CLI Release；同芯片家族、Exact 命中和候选身份清单都不会继承 Fast 资格。
- 正式资格要求五轮 `simple -> complex -> medium -> simple-return` A/B、编辑阶段至少 25% 中位数提速、绝对收益门槛、p95 不回退、产物等价和无 CLI fallback。
- 冷首次编译只记录，不宣传为快速；Exact 命中是缓存复用，不等同于重新编译加速。
- STM32 F401RE 的历史实测比原生慢并被产物门禁拦截，因此保持原生路径，直到当前 EXE 重新取得证据。
- 带库的 ESP32 同图编辑专项只代表历史 qualification-only 证据；普通产品路径仍以当前 EXE 的独立库证书为准。

### 调试与串口

- 串口监视器、结构化串口数据视图、串口绘图和 CSV 导出。
- 编译日志、上传日志、可解释缓存命中/未命中原因和阶段耗时。
- 断点/调试固件能力按板卡与调试协议边界显示，不对不支持的板卡伪装可用。
- 运行轨迹、积木高亮、执行次数和调试协议基础已存在；真机断言与变量探针仍属于后续扩展范围。

### 诊断、恢复与证据

- 上一个可用版本：保存工程检查点、源码、`ck.lock`、完整 FQBN、Core、工具链、分区、固件段、构建签名、哈希、资源和真机信息。
- 工程差异报告：代码、积木、库、Core、工具链、分区和设备变化可解释化展示。
- 一键导出诊断包，支持完整工程、只含生成源码或不含源码三种隐私模式，并对 Wi-Fi、路径、用户名和串口内容脱敏。
- 编译错误可映射回积木、缺失库和影响位置；错误卡片提供重新扫描、安装库或查看依赖入口。
- 发布/验收证据清单、源码树 manifest、冻结记录、EXE/安装包哈希和质量报告。

## 当前已实测的快速编译数据

历史跨板卡表格见 [FLFE 跨板卡测速报告](flfe-cross-board-speed-20260823.md)，不代表当前 EXE。当前资格请以运行时审计为准；下列数字仅作历史基线：

- ESP32-C6：36.83%～39.11%
- ESP32-C3：37.09%～38.28%
- ESP32-S3：34.97%～37.03%
- ESP32-C5：36.69%～37.71%
- Arduino Uno：58.09%～58.51%
- Arduino Mega：56.35%～57.13%
- ESP32-S2：34.99%～37.38%
- 经典 ESP32：29.92%～31.19%
- ESP32-H2：37.36%～37.81%

这些数字只代表同机 compile-only A/B 的编辑阶段，不代表冷编译、上传耗时、真板外设行为或其他 Core 版本。

## 仍明确保留的边界

- ESP32-P4 本轮测速因用户要求收尾而中止，继续原生路径；历史测试曾发现产物不等价，不能直接放行。
- ESP8266、Nano、Leonardo 尚未完成本轮新证书；ESP8266 当前没有 NativeRelink 适配器，不能从 ESP32 证书继承快速资格。
- STM32 当前没有性能资格，原生 CLI 更快。
- Windows MSI/NSIS 安装器已经生成并完成临时目录安装、启动和卸载冒烟；仍未完成可信代码签名、时间戳和跨机器升级验收，因此不能宣传为公开正式发行版。安装器哈希和机器可读证据见 `artifacts/release/CK-1.0.0-installer-artifacts-20260824.json`。
- 第三方任意 JavaScript 沙箱执行、AI 自动生成工程、真机断言、变量探针和 `.cktrace` 离线回放不属于本版已承诺能力。

## 重要入口

- 生产程序：`target/release/appsdesktop.exe`
- 便携发布包：`artifacts/release/CK-1.0.0-FLFE-20260824-portable.zip`
- Windows 安装器：`artifacts/release/installers/CK-1.0.0-FLFE-20260824-x64-setup.exe`（NSIS）与 `CK-1.0.0-FLFE-20260824-x64.msi`（MSI）
- Fast 资格查询：`node scripts/Report-CKForgeFastQualifications.cjs --format text`
- 当前功能清单：[current-feature-inventory.md](current-feature-inventory.md)
- 扩展标准：[blockly-library-package-standard.md](blockly-library-package-standard.md)
- 文档维护入口：[docs/README.md](README.md)
- V2 可导入示例：[ck_example_i2c_sensor_v2.zip](../examples/importable-packages/ck_example_i2c_sensor_v2.zip)
