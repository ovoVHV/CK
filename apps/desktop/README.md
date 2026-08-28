# CK Desktop 1.0

CK 是面向 Arduino、ESP32 等嵌入式目标的本地 Blockly 桌面开发环境。前端使用 React、TypeScript 与 Blockly，原生构建、串口、扩展质量门禁和恢复链路由 Tauri/Rust 提供。

## 开发

```powershell
npm install
npm run desktop:dev
```

`npm run dev` 只启动 Vite 前端，适合浏览器层调试；完整桌面调试请使用 `npm run desktop:dev`。

## 安全的生产构建

生成 Windows 安装包：

```powershell
npm run desktop:build
```

只生成 `target/release/appsdesktop.exe`，供本机原生冒烟或编译回归使用：

```powershell
npm run desktop:build:exe
```

不要直接执行 `cargo build --release`。未启用 Tauri `custom-protocol` 的 release EXE 会继续指向开发地址 `http://localhost:1420`，离开 Vite 后只能显示“连接被拒绝”。CK 在 Rust 入口处对此设有编译期硬门禁；确有底层构建需求时，也必须显式传入 `--features custom-protocol`，并先完成前端生产构建。

`npm run build` / `npm run build:web` 只生成前端静态资源，不是可分发桌面软件。

## 1.0 门禁与扩展示例

完整 1.0 自动化门禁从仓库根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-ReleaseCandidate.ps1
```

可导入板卡包、积木包、声明式迁移和原生 Arduino 深层源码库示例位于 `../../examples/importable-packages/`。产品能力与证据边界以 `../../docs/current-feature-inventory.md` 为准。
