# 从源码构建 CK alpha.46

这份说明对应当前仓库布局。历史文档中的 `apps/desktop` 在当前版本位于 `desktop/apps/desktop`。

## 开发环境

- Windows x64，PowerShell 7。
- Node.js 24 与 npm（控制器的随包版本固定为 24.13.0）。
- Rust stable 的 `x86_64-pc-windows-msvc` 工具链；Visual Studio C++ Build Tools 和 Windows SDK。
- Microsoft WebView2 Runtime，用于运行桌面 WebView。
- 完整 Rust 编译需要数 GB 可用空间，可用 `-TargetRoot` 把构建输出放到其他磁盘。

```powershell
pwsh -File scripts/Build-Source.ps1 -TargetRoot E:/CK-Targets -OutputDirectory E:/CK-Preview
```

首次执行会联网下载依赖。运行工具来自 `scripts/source-tools.json` 中的固定上游地址，下载及解包文件均校验 SHA-256。Node、Ninja、Arduino CLI 和 ccache 不提交到 Git。Rust 与前端依赖保留锁文件；`cargo fetch --locked` 完成后，已有的 Rust 构建脚本使用离线模式。

如果下载失败，保留错误，不要通过删除哈希检查解决。重新运行会验证并复用已完成的工具。

## 分步构建与验证

```powershell
node scripts/prepare-source.mjs
npm ci --prefix desktop/apps/desktop
cargo fetch --locked --manifest-path native/Cargo.toml
cargo fetch --locked --manifest-path desktop/Cargo.toml
pwsh -File scripts/Build-Native.ps1 -TargetDir E:/CK-Targets/native
npm --prefix desktop/apps/desktop run build:web
pwsh -File scripts/Build-Desktop.ps1 -TargetDir E:/CK-Targets/desktop -OutputDir E:/CK-Preview

node scripts/check.mjs
node --test tests/*.test.mjs
node --test desktop/apps/desktop/src/services/ai*.test.mjs
```

桌面真实编译测试还需要板卡 Core 与对应工具链；AI 实际服务测试需要用户自己的 API 配置。默认单测不要求购买模型服务，不使用作者的密钥。`scripts/Test-Core.ps1` 执行 Rust ck_core 测试，需要先准备 Arduino CLI 及 Cargo 依赖。

## 运行桌面与原生构建控制器

`CK-V9-Preview.exe` 可以启动桌面。要让开发版连接 V9 控制器：

1. 在自己的 Arduino 数据目录安装所需 Core。不要把 Core、缓存和用户工程提交到仓库。
2. 将 `config.example.json` 复制到被 Git 忽略的 `local/engine.json`。
3. 替换所有示例路径：`sysroot` 是包含 `packages` 的实际数据根目录；`cliConfig` 是对应的 Arduino YAML；`userLibraries` 是所配置的 sketchbook 库目录；`node` 和 `ninja` 指向当前仓库的 `runtime` 工具；`cli` 指向预览目录下的 `bin/arduino-cli.exe`。
4. `workspaceRoot` 和 `evidenceRoot` 使用自己可写的独立目录，将 `features.enabled` 设为 `true`。
5. 通过启动脚本创建新的桌面/控制器会话：

```powershell
pwsh -File scripts/Start-Preview.ps1 -EngineConfig ./local/engine.json -PreviewExe E:/CK-Preview/CK-V9-Preview.exe
```

正式包的启动器会管理这些路径；源码开发说明采用显式配置，避免覆盖现有安装。不要从别人机器复制会话授权或性能证书。没有当前有效资格的路径按实现回退或拒绝，不应伪造为已验证。

## 生成 Windows 安装包

在完成上述构建后，准备 NSIS 的 `makensis.exe`。从 Microsoft 官方下载 WebView2 Evergreen Bootstrapper，校验其 Microsoft 数字签名后放到 `installer/MicrosoftEdgeWebview2Setup.exe`。该文件不随 Git 源码发布。

```powershell
node scripts/package-installer.mjs E:/CK-Preview E:/CK-Release "C:/Program Files (x86)/NSIS/makensis.exe"
```

每次使用空的交付目录，脚本会拒绝覆盖已有 staging。自建包不是官方签名发行；重新分发前核对第三方组件许可、源码提供义务和更新策略。官方更新签名私钥不在仓库中。

## CK LAB 网站

`website/` 保留网站源代码、样式和图解。该站的发布构建另外需要明确的 `CK_LAB_RELEASE_INFO` 记录，以及 `website/drivers-catalog.json` 中逐项验证的驱动 ZIP。仓库不附带驱动二进制、服务器凭据或官方发布密钥。具体流程见 `website/README.md`。网站构建不属于桌面构建的前置步骤。
