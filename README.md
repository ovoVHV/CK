# CK · 图形化硬件 IDE

<p align="center"><img src="desktop/apps/desktop/public/brand/ck-app.png" width="112" alt="CK" /></p>

**搭积木、让 AI 协作、在本机编译，并能定位错误和恢复工程。**

CK 面向 Arduino 兼容硬件，把 Blockly 编辑、AI 编程、原生增量编译、上传、串口调试、库管理和工程恢复放在同一个 Windows 桌面应用中。

当前源码版本：**9.1.0-alpha.52**，预览版。原作者与维护者：**CKYAN（[@ovoVHV](https://github.com/ovoVHV)）**。

本版[工程主页](docs/alpha.52-release-notes.txt)支持按板卡、名称和置顶状态筛选，文件操作菜单标有“更多”；同时包含[编程工作区布局更新](docs/alpha.51-release-notes.txt)。

[下载安装包](https://ckswitch.site/download/) · [作者声明与署名方式](AUTHORS.md) · [源码构建](docs/BUILDING.md) · [AI 使用说明](docs/ai-assistant-guide.md) · [问题反馈](https://github.com/ovoVHV/CK/issues)

**CK LAB 官方QQ群：1080798212**（交流使用、反馈问题与编译性能日志）。

## 核心能力

| 能力 | 可以做什么 |
| --- | --- |
| 图形化编辑 | Blockly 积木、同步 C++ 代码、搜索和快速插入、第三方积木库；工程保存板卡与配置 |
| 工程内源码编程 | 同一工程切换积木 / 源码，手写 Arduino C/C++，共用 V9 编译、上传、串口和日志；支持 .ino 导入导出 |
| AI 编程 | 自填 API 地址、模型和密钥；聊天管理、上下文压缩、思考强度、图片与文件附件；读工程、改积木、补库、编译和修复 |
| AI 制作库 | 生成声明式积木与 C++ 库，校验、试编译后安装加载；支持完整 Arduino 库文件夹结构 |
| 本地编译加速 | CK Build Engine V9 自行管理库发现、依赖图、对象、PCH、链接和镜像任务；Rust 完整资产校验与 Windows 进程管理 |
| 报错定位 | 在可可靠映射时，把编译错误定位到积木并显示提示；第三方作者不必专门编写报错逻辑 |
| 编译日志反馈 | 复制完整输出；主动预览脱敏诊断后提交 CK LAB，每次编译只保存一份并返回报告编号 |
| 工程恢复 | 检查点、恢复稿、缺库保护、依赖锁及符合条件的上一个可用版本恢复 |
| 板卡与硬件 | Core 与完整菜单配置管理、声明式引脚资源与冲突检查；按实际板卡能力显示诊断功能 |
| 连接与调试 | 驱动指南、串口监视与曲线、已接入目标的积木运行轨迹和软断点 |

编译在本机完成，**不需要联网来获得编译加速**，也不要求管理员服务。首次下载 Core、工具或库需要联网；使用远程 AI API 时，相关上下文会发送给用户选择的模型服务。

积木改动自动合并到源码，同一处修改冲突时逐项选择。串口、AI 面板可拖动调节大小，库管理器可从工具栏直接打开。源码模式支持单文件 Sketch 和已安装的 C++ 库，手写内容随 `.ck`、检查点和恢复稿保存；编译使用当前选中模式的程序。切回积木不会将任意 C++ 自动转换成积木。多文件源码工程、源码 AI 和源码调试尚未提供，见 [源码编程说明](docs/source-editor.md) 与 [alpha.50 源码模式验证范围](docs/alpha.50-publication.md)。

## 性能与测试范围

部分已测试代码和配置中，本地编译相对对照路径取得了约 40% 的提速。**这不是所有电脑、所有代码、所有 Core 或首次编译的统一保证。** 冷构建、改码、相同源码和历史恢复是不同路径，不能混用成绩。

我们只测试了部分代码与板卡组合。若增量编译出现问题，请反馈 CK/Core 版本、完整板卡配置、复现代码和脱敏日志；可以切回兼容编译路径核对。报告中的性能目标也不等于已经通过的成绩。

alpha.46 的 AI 板卡链路已在本机对 10 种目标完成 20 次真实编译，并通过 155 项 AI 服务测试。该项自动化使用受控模型响应验证工具链，不代表任意模型都能完成复杂项目，也不代表全部板卡已通过真机验证。详情见 [公开测试说明](docs/PUBLICATION.md)。

## AI 与板卡

AI 编程、补库和编译跟随 CK 当前选择的板卡、Core 和完整配置。后续板卡包通过同一能力接口接入；缺失的引脚或硬件信息保持“未知”。**AI 编程支持范围与芯片仿真支持范围分开**，不能从支持编译推断为支持仿真或已经验证真机。

AI 能力依赖所配置模型的工具调用、上下文和多模态支持。密钥由用户提供；仓库不包含可用 API 密钥。Windows 本机记住密钥使用当前用户的 DPAPI。

## 源码结构

```text
desktop/         React / Blockly 桌面界面、Tauri 宿主、Rust ck_core
src/             Node 原生构建控制器、发现图、前端、调度与收据
native/          Rust 资产验证、进程树、启动器、文本转换与更新助手
update-protocol/ 更新清单与签名验证协议
tests/           引擎单测及真实桌面/板卡测试入口
docs/            构建说明、AI/扩展规范、版本说明与测试边界
website/         CK LAB 网站源代码与图解
feedback-server/ 私有编译诊断接收服务、防重复与限流
scripts/         构建、依赖准备、打包与验证脚本
```

这是 Node / TypeScript / Rust 协作的架构，不是整个项目已改写为 Rust。GNU 工具链与板卡 Core 保留各自上游实现和许可证。

## 从源码构建

需要 Windows x64、PowerShell 7、Node.js 24、Rust stable（MSVC）、Visual Studio C++ Build Tools / Windows SDK，以及 WebView2。初次准备开发依赖需要联网。

```powershell
git clone https://github.com/ovoVHV/CK.git
cd CK
pwsh -File scripts/Build-Source.ps1
```

脚本准备按 SHA-256 固定的运行工具、安装前端依赖、构建 Rust 助手和独立预览 EXE。源码仓库不存放工具链、用户工程、API 密钥、缓存或机器授权。运行 V9 及生成安装包的步骤见 [BUILDING.md](docs/BUILDING.md)。

## 第三方库与板卡开发

- [完整 Arduino C++ 库目录打包](docs/complete-arduino-library-packages.md)
- [积木库格式](docs/blockly-library-package-standard.md)
- [库向 AI 声明能力](docs/library-ai-capabilities.md)
- [引脚、资源与冲突声明](docs/library-hardware-contract.md)
- [AI 库制作流程](docs/ai-library-authoring.md)
- [第三方板卡声明](docs/third-party-board-passport.md)

旧版本开发文档保留供参考；其中的旧路径与旧资格结论不能替代当前构建说明和版本记录。

## 作者与来源

我把 CK 开源，是希望它能帮助大家学习和创造。如果你使用了 CK 的源码或具体实现，也希望你能在 README、软件“关于”页面或相应说明中标注作者与来源：

> 本项目使用或基于 CK 开源项目的部分技术与实现。原作者：**CKYAN（@ovoVHV）**。
> 原始仓库：**https://github.com/ovoVHV/CK**

完整声明及可复制署名见 [AUTHORS.md](AUTHORS.md)。上述醒目标注是作者倡议；使用条件以 [Apache License 2.0](LICENSE) 为准，请保留适用的许可、版权及 [NOTICE](NOTICE) 声明。第三方组件保留自己的许可，见 [第三方说明](THIRD_PARTY_NOTICES.md)。
