# 多文件工程：桌面编译按钮回归

重构编译/上传前，先守住这条用户操作路径。`tests/desktop-project-folder.mjs` 保留文件树、保存冲突和直接 IPC 对照；`tests/desktop-project-folder-button.mjs` 单独跑真实工具栏、当前模式和未保存头文件。两者不能互相替代。

## 复跑

使用 PowerShell 7、配套的 Windows 预览 EXE 与同一版本仓库，提前准备**独立的测试数据目录**，含 Nano 和 ESP32-S3 对应的已安装 Core、工具链、CLI 配置及空的测试用 sketchbook。用 `config.example.json` 生成指向该目录、Node 24 和 Ninja 的测试配置，启用 V9，`allowedFqbns` 保留两个目标族。为本次运行单独指定 `workspaceRoot`（以 `runtime/CK_Builds/v9/sessions` 结尾）与 `evidenceRoot`，并先创建证据目录。不要使用日常 CK 数据目录：夹具会安装一个只用于测试的声明式积木，测试结束后工程与夹具保留供复查。

从仓库根目录执行（`$engineConfig` 和 `$previewExe` 分别为上述配置文件及预览程序的绝对路径）：

```powershell
$cfg = Get-Content -Raw -LiteralPath $engineConfig | ConvertFrom-Json
$env:CK_MF_PRIVATE_SYSROOT = $cfg.paths.sysroot
$env:CK_V91_DESKTOP_DATA_ROOT = Join-Path $cfg.paths.evidenceRoot 'desktop'
$env:CK_V91_PROJECTS_ROOT = Join-Path $cfg.paths.evidenceRoot 'projects'
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $cfg.paths.evidenceRoot 'webview'
./scripts/Start-Preview.ps1 -EngineConfig $engineConfig -PreviewExe $previewExe -CdpPort 19356 -Harness (Resolve-Path tests/desktop-project-folder-button.mjs)
```

`-CdpPort` 选一个未占用的本地端口。看控制台最后的 `REPORT` 路径；`report.json` 按点击保留完整 FQBN、Core、耗时、请求标识、编译任务数、固件 SHA-256 和对应收据的位置，同目录另存各次主程序与日志。失败返回非零退出码。

## 判定方法

- 同名文件夹工程含 `.ck`、`Blink.h`、`Blink.cpp` 和 `src/Timing.h`。测试积木只负责生成调用；实际函数在工程的 `Blink.cpp` 里。积木与手写主程序传入不同的串口文本，函数另输出头文件里的版本文本。
- 在两种模式下都在文件树中编辑头文件，确认编辑器标脏且磁盘仍为旧值，直接点工具栏「编译」。要求磁盘与本次收据都变为新值，主程序哈希不变，唯一重编对象为 `Blink.cpp.o`。
- 校验**当前按钮请求**的主程序、项目路径、板卡选项和收据，再读磁盘上的 Nano 应用 HEX（解码数据记录）或 ESP32-S3 应用 BIN。要求找到当前模式和头文件标记，旧标记消失；再次点击时 No-Op 命中，发现、原型、对象编译、链接、镜像任务均为零，固件哈希不变。

## 首次基线 · 2026-11-24

`v9.1.0-alpha.56`（`46ae42e`），本机普通 Windows 用户，新测试工程和 V9 会话。12 次按钮编译均通过。单位为秒，从点击到编译按钮恢复且进度浮层消失；每格一次，不能用来判断 P95 或与其他机器比较。

| 实际板卡 / Core | 积木首次 | 积木改头文件 | 积木原样 | 切到手写源码 | 源码改头文件 | 源码原样 |
|---|---:|---:|---:|---:|---:|---:|
| `arduino:avr:nano:cpu=atmega328` / 1.8.8 | 15.465 | 2.044 | 0.898 | 1.742 | 1.995 | 0.969 |
| `esp32:esp32:esp32s3` / 3.3.6 | 78.088 | 18.880 | 2.779 | 10.520 | 18.824 | 2.745 |

Nano 的对象编译任务数依次为 `27 / 1 / 0 / 1 / 1 / 0`，S3 为 `58 / 1 / 0 / 1 / 1 / 0`。S3 两次改头文件均重新发现依赖，耗时分别为 6.31 秒和 6.39 秒。这里验证的是多文件固件构建，不涉及串口上传或真机运行。

## 步骤 2：重构后的验收方法

复跑时使用包含当前前端的预览程序。设置 `CK_MF_FRONTEND_DIST` 为打包时的 `dist` 目录，测试会从运行中的 WebView 取入口脚本、核对 SHA-256，并将它和 EXE 指纹写进同一份 `report.json`。原生后端、编译结果和取消结果均不替换。

在两块板的 12 次成功编译之后，脚本用一个独立 Nano 文件夹工程验证异常路径：

| 操作 | 必须观察到的结果 |
|---|---|
| 文件树编辑头文件，外部写入另一个版本，直接点编译 | 文件保存报冲突；编译 IPC 为零；磁盘与编辑器各自保留自己的版本 |
| 手写源码中加入 `#error` | 原生编译返回该错误，编译按钮恢复，进度浮层消失 |
| 更改源码，点编译再取消 | 后端确认取消的编号与编译请求一致；出现已取消提示；按钮和浮层恢复 |
| 取消后改回可编译源码 | 再次点同一按钮可以成功；从实际 HEX 读到手写模式标记和外部头文件版本 |
| 同一行 C++ 在积木与手写分支里分别被改动 | 源码模式点编译时产生同步冲突；编译 IPC 为零；用户可查看两种版本，未选时不能应用 |

普通编译出错、取消、重试期间，测试同时旁路观察串口打开和关闭命令，要求均为零。`foreground_build.test.mjs` 另测上传等待检查点、恢复串口后再解锁、端口临时消失的重试及旧会话失效；这些状态测试不代表开发板烧录或物理串口重连通过。

后续性能任务：评估附带 `.h` / `.cpp` 修改是否改变了依赖发现所需的输入。仅改常量时，S3 仍可能重新发现依赖并执行 CTags。需要覆盖条件包含、宏与候选库变化再决定能否复用；本轮未修改引擎。

### 步骤 2 本机结果 · 2026-11-24

基于 `46ae42e`，普通 Windows 用户；最终预览程序 SHA-256 `dac3ab83cc87b6663fc9d70c0399680662daa77db60a32a9a8d33f64cdc62948`，WebView 实际入口脚本 SHA-256 `bacebbe181a891c6873d70570a2f81e4125de0871fc753e8fef8da379faf2a57`。按钮验收报告 `folder-button-IFDiDq/report.json` 为 `PASS`，包含 12 次成功按钮编译及上述 5 项异常与恢复检查。

| 板卡 | 积木首次 | 积木改头文件 | 积木原样 | 切到手写源码 | 源码改头文件 | 源码原样 |
|---|---:|---:|---:|---:|---:|---:|
| Nano / AVR 1.8.8 | 7.050 s | 2.040 s | 0.858 s | 1.667 s | 2.017 s | 0.891 s |
| ESP32-S3 / 3.3.6 | 43.947 s | 18.807 s | 2.820 s | 10.246 s | 18.576 s | 2.785 s |

每格是本次运行的一次点击。使用新工程和新 V9 会话，已安装的 Core 与系统文件缓存没有清空，不用于计算冷机加速率或 P95。两种架构在两种模式下改头文件均仅重编 `Blink.cpp.o`；原样重编均未执行编译、链接或生成镜像，应用固件 SHA-256 不变。

本轮 TypeScript 检查、前端和原生预览程序构建成功。构建生命周期、串口重试、检查点、板卡身份与上传结果等相关测试 23/23 通过；组件套件为 303/311，8 项失败均可在重构前复现。本机没有物理串口，未作真机烧录验收。

编译检查点保存的是本次输入的源码，用来恢复当时的编辑现场。已开始的普通编译即使报错或中途取消，也保留这个语义。它不更新“上一个可用版本”。

以下 8 项在本轮最终组件套件中仍失败，且在重构前可复现；未设置跳过。复核时按文件和行为逐项关闭：

| 组件测试文件（`desktop/apps/desktop/src/components`） | 待处理项 |
|---|---|
| `CompileDoctorPanel.test.mjs` | 缺少测试读取的 `p0-plus-reliability-roadmap.md` |
| `FrontendMemoryLifecycle.test.mjs` | 工作区定时器清理与 Blockly resize 合并 |
| `WorkspaceCompileIssueLateAlias.test.mjs` | 迟到的别名证据重新标记并定位报错积木 |
| `WorkspaceCompileTargetPreproof.test.mjs` | 构建前板卡核对只读断言 |
| `WorkspaceDeviceHealth.test.mjs` | 缺少测试读取的 `esp32-c6-hardware-regression-plan.md` |
| `WorkspaceHealthDockInteraction.test.mjs` | 设备面板非模态布局 |
| `WorkspaceRecoveryDrafts.test.mjs` | 另存写盘时又编辑，须保留当前工程与恢复状态 |
| `WorkspaceRecoveryDrafts.test.mjs` | 正式保存只允许一个写入者，并重跑最新保存 |
