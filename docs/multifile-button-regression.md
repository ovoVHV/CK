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
