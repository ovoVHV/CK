import {storageIncludes,storageInit,storagePage,storageFunctions,storageInstall} from './storage-installer.mjs';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';import {ENGINE_VERSION} from '../src/version.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [previewArg,outArg,makensisArg]=process.argv.slice(2);if(!previewArg||!outArg||!makensisArg)throw Error('Usage: package-installer PREVIEW OUTPUT MAKENSIS');
const [preview,out,makensis]=[previewArg,outArg,makensisArg].map(value=>path.resolve(value));
if(!fs.existsSync(makensis))throw Error('NSIS compiler not found: '+makensis);
const installerName=`CK-V${ENGINE_VERSION}-Setup-x64.exe`;
const stage=path.join(out,'payload-'+ENGINE_VERSION);
if(fs.existsSync(stage)&&fs.readdirSync(stage).length)throw Error('Package staging must be empty; preserve or remove the prior candidate explicitly');
fs.mkdirSync(stage,{recursive:true});
const copy=(from,to,skip=()=>false)=>{
 if(skip(from))return;
 const st=fs.lstatSync(from);if(st.isSymbolicLink())throw Error('Unexpected link in installer payload: '+from);
 if(st.isDirectory()){fs.mkdirSync(to,{recursive:true});for(const name of fs.readdirSync(from))copy(path.join(from,name),path.join(to,name),skip);}
 else{fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);if(fs.statSync(to).size!==st.size)throw Error('Incomplete installer payload: '+to);}
};
for(const dir of ['src','bin','runtime','licenses','tests','scripts','docs']){
 const from=path.join(root,dir),to=path.join(stage,'engine',dir);
 // Internal audit captures are working evidence, not distributable runtime
 // documentation. Do not accidentally ship local research files or stale data.
 if(dir==='docs')copy(from,to,f=>path.resolve(f).toLowerCase()===path.resolve(from,'audits').toLowerCase());
 else copy(from,to);
}
if(fs.existsSync(path.join(stage,'engine/docs/audits')))throw Error('Internal audit files must not be packaged');
for(const name of ['package.json','config.example.json','LICENSE','NOTICE','AUTHORS.md','THIRD_PARTY_NOTICES.md'])copy(path.join(root,name),path.join(stage,'engine',name));
copy(preview,path.join(stage,'desktop'));copy(path.join(root,'bin/launcher.exe'),path.join(stage,'CK-V9.1.exe'));
copy(path.join(root,'installer/MicrosoftEdgeWebview2Setup.exe'),path.join(stage,'MicrosoftEdgeWebview2Setup.exe'));
fs.writeFileSync(path.join(stage,'package-id.txt'),'CK-V91-alpha-current-user\r\n');
const hash=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const tools={node:{path:'runtime/node.exe',version:'24.13.0'},ninja:{path:'runtime/ninja.exe',version:spawnSync(path.join(root,'runtime/ninja.exe'),['--version'],{encoding:'utf8'}).stdout.trim()},assets:{path:'bin/assets.exe',version:ENGINE_VERSION},job:{path:'bin/job.exe',version:ENGINE_VERSION},updateHelper:{path:'bin/update-helper.exe',version:ENGINE_VERSION},textCodec:{path:'bin/text-codec.exe',version:ENGINE_VERSION}};
for(const tool of Object.values(tools))tool.sha256=hash(path.join(root,tool.path));
fs.writeFileSync(path.join(stage,'engine/runtime-versions.json'),JSON.stringify({engineVersion:ENGINE_VERSION,tools},null,2));
fs.writeFileSync(path.join(stage,'使用说明.txt'),`CK ${ENGINE_VERSION} 本机及第二台测试包\r\n\r\n1. 启动“CK V9.1 测试版”。它不会替换 v6，也不注册 .ck 文件关联。\r\n2. 第二台缺少工具链时，先运行“准备工具链”（联网下载 ESP32 Core 3.3.6）。\r\n3. 运行“第二台资格测试”，保持电脑接通电源，关闭其他构建工作，等待完成。\r\n4. 将 所选数据目录 下的 CK-V9.1-qualification-*.zip 发回。\r\n\r\n测试包括 30 次新编辑、20 次历史恢复、20 次相同源码，另含准备构建和官方对照。全部样本均保留。\r\n性能或测试失败时会保留日志和样本，不能视为达标。第二台结果必须与本机结果一起评审。\r\nESP32 配置按实际板卡、Flash、分区、PSRAM、USB 等参数构建，支持 Core 3.3.6 和 3.3.6-cn；不再要求特定 16MB 分区。未接管的平台规则会明确提示兼容回退。首次完整编译不承诺 20 秒；各配置的实测覆盖见兼容性报告。\r\n本版本是 T1 会话级测试版，不抵抗任意恶意同用户进程；不免哈希、不启用跨工程缓存。\r\nNode、Ninja、Arduino CLI、Rust 助手随包提供，无需配置 PATH。工具链不装入程序目录。\r\n卸载保留工程、工具链和资格记录。\r\n`);
fs.writeFileSync(path.join(stage,'Run-WiFi-Comparison.cmd'),'@echo off\r\nsetlocal\r\nset CK_V91_WAIT_PAIRS=5\r\nset CK_V91_COLD_AB=1\r\nset CK_V91_WIFI_OFFICIAL=1\r\nset CK_V91_WIFI_FQBNS=["esp32:esp32:esp32","esp32:esp32:esp32c3","esp32:esp32:esp32s3"]\r\necho Running full WiFi comparisons for ESP32, ESP32-C3 and ESP32-S3. Please close the CK test desktop first.\r\nstart "" /wait "%~dp0CK-V9.1.exe" --wifi-wait-check --silent\r\nset CK_TEST_EXIT=%ERRORLEVEL%\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0engine\\scripts\\Collect-Compile-Diagnostics.ps1"\r\necho Test exit code: %CK_TEST_EXIT%. Raw results are retained.\r\npause\r\nexit /b %CK_TEST_EXIT%\r\n');
fs.writeFileSync(path.join(stage,'Run-Cold-Build-Comparison.cmd'),'@echo off\r\nsetlocal\r\nset CK_V91_COLD_PAIRS=3\r\nset CK_V91_WIFI_OFFICIAL=1\r\nif not defined CK_V91_WIFI_FQBNS set CK_V91_WIFI_FQBNS=["esp32:esp32:esp32s3"]\r\necho Running full cold-build desktop comparisons. Close the CK test desktop first.\r\nstart "" /wait "%~dp0CK-V9.1.exe" --cold-discovery-check --silent\r\nset CK_TEST_EXIT=%ERRORLEVEL%\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0engine\\scripts\\Collect-Compile-Diagnostics.ps1"\r\necho Test exit code: %CK_TEST_EXIT%. All samples are retained.\r\npause\r\nexit /b %CK_TEST_EXIT%\r\n');
fs.writeFileSync(path.join(stage,'Run-Compile-Diagnostics.cmd'),'@echo off\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0engine\\scripts\\Collect-Compile-Diagnostics.ps1"\r\npause\r\n');
fs.writeFileSync(path.join(stage,'Run-Cold-Pipeline-Comparison.cmd'),'@echo off\r\nsetlocal\r\nset CK_V91_PIPELINE_AB=1\r\nset CK_V91_COLD_PAIRS=3\r\nset CK_V91_WIFI_OFFICIAL=1\r\nif not defined CK_V91_WIFI_FQBNS set CK_V91_WIFI_FQBNS=["esp32:esp32:esp32s3"]\r\necho Running matched alpha.5 scheduling vs alpha.6 desktop cold builds. Close CK first.\r\nstart "" /wait "%~dp0CK-V9.1.exe" --cold-discovery-check --silent\r\nset CK_TEST_EXIT=%ERRORLEVEL%\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0engine\\scripts\\Collect-Compile-Diagnostics.ps1"\r\necho Test exit code: %CK_TEST_EXIT%. All raw samples are retained.\r\npause\r\nexit /b %CK_TEST_EXIT%\r\n');
fs.writeFileSync(path.join(stage,'Run-Cold-Queue-Comparison.cmd'),'@echo off\r\nsetlocal\r\nset CK_V91_QUEUE_AB=1\r\nset CK_V91_PIPELINE_AB=0\r\nset CK_V91_COLD_PAIRS=3\r\nset CK_V91_WIFI_OFFICIAL=1\r\nif not defined CK_V91_WIFI_FQBNS set CK_V91_WIFI_FQBNS=["esp32:esp32:esp32s3"]\r\necho Running independent queue and full-validation desktop comparisons. Close CK first.\r\nstart "" /wait "%~dp0CK-V9.1.exe" --cold-discovery-check --silent\r\nset CK_TEST_EXIT=%ERRORLEVEL%\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0engine\\scripts\\Collect-Compile-Diagnostics.ps1"\r\necho Test exit code: %CK_TEST_EXIT%. All samples are retained.\r\npause\r\nexit /b %CK_TEST_EXIT%\r\n');
fs.appendFileSync(path.join(stage,'使用说明.txt'),"\r\nalpha.14：统一调度器扩展到 Arduino AVR Core 1.8.8，包含 Uno、Nano 各 CPU/引导程序配置、Mega2560/1280、Leonardo、Micro；ESP32 保留 3.3.6 / 3.3.6-cn 的完整配置身份及通用优化。未知平台规则安全回退。\r\nRun-AVR-Comparison.cmd 在真实桌面 IPC 中测试首次、改码、历史恢复和相同源码，并与官方 clean 编译逐项核对。该测试不向实体板写入固件。\r\n60 帧目标活动动画继续保留，仅更新图标和进度条，隐藏时暂停。实际帧率受屏幕及系统负载影响。\r\n测试边界见 engine/docs/alpha.14-platform-scheduler.md；性能以交付报告中的实测结果为准。\r\n");
fs.writeFileSync(path.join(stage,'Run-AVR-Comparison.cmd'),'@echo off\r\nsetlocal\r\nset CK_V91_MATRIX_FQBNS=["arduino:avr:uno","arduino:avr:nano:cpu=atmega328","arduino:avr:nano:cpu=atmega328old","arduino:avr:nano:cpu=atmega168","arduino:avr:mega:cpu=atmega2560","arduino:avr:mega:cpu=atmega1280","arduino:avr:leonardo","arduino:avr:micro"]\r\necho Running AVR native desktop and official clean comparisons. Close CK first.\r\nstart "" /wait "%~dp0CK-V9.1.exe" --configuration-check --silent\r\nset CK_TEST_EXIT=%ERRORLEVEL%\r\necho Results: 所选数据目录\\configuration-check-result.json\r\necho Test exit code: %CK_TEST_EXIT%. All raw results retained.\r\npause\r\nexit /b %CK_TEST_EXIT%\r\n');
fs.writeFileSync(path.join(stage,'Run-WiFi-First-Build.cmd'),'@echo off\r\nsetlocal\r\nset CK_BUTTON_NATIVE=1\r\nset CK_BUTTON_REQUIRE_ACTIVITY=1\r\nif not defined CK_BUTTON_MAX_MS set CK_BUTTON_MAX_MS=80000\r\nset CK_BUTTON_MODES=["candidate","candidate","candidate","candidate","candidate"]\r\necho Running five complete WiFi builds through the real editor button. Close CK first.\r\nstart "" /wait "%~dp0CK-V9.1.exe" --button-cold-check --silent\r\nset CK_TEST_EXIT=%ERRORLEVEL%\r\necho Results: 所选数据目录\\button-cold-result.json\r\necho Test exit code: %CK_TEST_EXIT%. Correctness and performance are separate.\r\npause\r\nexit /b %CK_TEST_EXIT%\r\n');
fs.writeFileSync(path.join(stage,'Run-Cold-Scheduler-Comparison.cmd'),"@echo off\r\nsetlocal\r\nset CK_BUTTON_NATIVE=1\r\nset CK_BUTTON_IMAGE=1\r\nset CK_BUTTON_REQUIRE_ACTIVITY=1\r\nset CK_BUTTON_MODES=[\"reference\",\"candidate\",\"candidate\",\"reference\",\"reference\",\"candidate\",\"candidate\",\"reference\",\"reference\",\"candidate\"]\r\nset \"CK_DIAGNOSTIC_DISPATCH=%TEMP%\\ck-cold-scheduler-%RANDOM%-%RANDOM%.txt\"\r\necho Running ten complete WiFi builds with the real editor button. Close CK first.\r\nstart \"\" /wait \"%~dp0CK-V9.1.exe\" --button-cold-check --silent\r\nset CK_TEST_EXIT=%ERRORLEVEL%\r\necho Results: 所选数据目录\\button-cold-result.json\r\necho Test exit code: %CK_TEST_EXIT%. All samples are retained.\r\npause\r\nexit /b %CK_TEST_EXIT%\r\n");
fs.writeFileSync(path.join(stage,'Run-Animation-Comparison.cmd'),"@echo off\r\nsetlocal\r\nset CK_BUTTON_NATIVE=1\r\nset CK_BUTTON_ANIMATION_AB=1\r\nset CK_BUTTON_IMAGE=0\r\nset CK_DIAGNOSTIC_DISPATCH=\r\nset CK_BUTTON_REQUIRE_ACTIVITY=1\r\nset CK_BUTTON_MODES=[\"reference\",\"candidate\",\"candidate\",\"reference\",\"reference\",\"candidate\",\"candidate\",\"reference\",\"reference\",\"candidate\"]\r\necho Comparing 30 Hz and 60 fps activity with identical full builds. Close CK first.\r\nstart \"\" /wait \"%~dp0CK-V9.1.exe\" --button-cold-check --silent\r\nset CK_TEST_EXIT=%ERRORLEVEL%\r\necho Results: 所选数据目录\\button-cold-result.json\r\necho Test exit code: %CK_TEST_EXIT%. All samples retained.\r\npause\r\nexit /b %CK_TEST_EXIT%\r\n");
fs.writeFileSync(path.join(stage,'Prepare-AVR-Tools.cmd'),'@echo off\r\nsetlocal\r\necho Preparing Arduino AVR 1.8.8 in your user directory.\r\nstart "" /wait "%~dp0CK-V9.1.exe" --install-assets --avr-only --silent\r\nset CK_TEST_EXIT=%ERRORLEVEL%\r\necho Setup exit code: %CK_TEST_EXIT%.\r\npause\r\nexit /b %CK_TEST_EXIT%\r\n');
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\n仅使用 Uno/Nano/Mega 等 AVR 板卡时，可运行 Prepare-AVR-Tools.cmd，仅准备 AVR 工具，不要求下载 ESP32 SDK。标准“准备工具链”入口会检查 ESP32 和 AVR 两个平台。\r\n');
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\nalpha.15：AVR 直接展开已验证的板卡及菜单规则，省去首次 CLI 参数查询；会话调度器直接执行 AVR 原生任务，减少 Ninja/Node 重复启动。完整前后内容验证和最终宿主验证保留。未知规则仍走官方参数查询或兼容回退。\r\nRun-AVR-Performance.cmd 进行真实桌面首次、改码、相同源码 A/B，每组五次，并保留官方 CLI 对照（CLI 计时不含桌面 IPC，单独记录）。详见 engine/docs/alpha.15-avr-performance.md。\r\n');
fs.writeFileSync(path.join(stage,'Run-AVR-Performance.cmd'),'@echo off\r\nsetlocal\r\nset CK_AVR_AB=1\r\nset CK_AVR_ROUNDS=5\r\nset CK_AVR_MODES=\r\nset CK_AVR_TARGETS=["arduino:avr:uno","arduino:avr:nano:cpu=atmega328old","arduino:avr:mega:cpu=atmega2560"]\r\necho Running AVR desktop timing and official correctness comparisons. Close CK first.\r\nstart "" /wait "%~dp0CK-V9.1.exe" --avr-performance-check --silent\r\nset CK_TEST_EXIT=%ERRORLEVEL%\r\necho Results: 所选数据目录\\avr-performance-result.json\r\necho Test exit code: %CK_TEST_EXIT%. All samples retained.\r\npause\r\nexit /b %CK_TEST_EXIT%\r\n');
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\nalpha.16：修复 AVR Core 1.8.6 / 1.8.7 被误报 Uno 不存在并退回旧后端的问题。使用本机实际安装版本，不要求升级到 1.8.8；三个版本分别校验实际板卡和平台规则。日志显示直接展开参数时使用的 Core 版本。\r\nRun-AVR-Workflow.cmd 以实际桌面 IPC 检查首次、增加库、函数体修改及相同源码；已有 CK HC-SR04 示例时使用该示例，否则明确记录使用 Wire 内置库。每轮都与官方 clean 产物对照，旧后端回退不能冒充原生提速通过。\r\n');
fs.writeFileSync(path.join(stage,'Run-AVR-Workflow.cmd'),'@echo off\r\nsetlocal\r\nset CK_AVR_ROUNDS=5\r\necho Running first build, library addition, edits and identical-source desktop checks. Close CK first.\r\nstart "" /wait "%~dp0CK-V9.1.exe" --avr-workflow-check --silent\r\nset CK_TEST_EXIT=%ERRORLEVEL%\r\necho Results: 所选数据目录\\avr-workflow-result.json\r\necho Test exit code: %CK_TEST_EXIT%. All samples retained.\r\npause\r\nexit /b %CK_TEST_EXIT%\r\n');
fs.writeFileSync(path.join(stage,'Run-ESP32-Properties-Comparison.cmd'),"@echo off\r\nsetlocal\r\nset CK_BUTTON_NATIVE=1\r\nset CK_BUTTON_REQUIRE_ACTIVITY=1\r\nset CK_BUTTON_ESP_PROPERTIES=1\r\nif not defined CK_BUTTON_FQBN set CK_BUTTON_FQBN=esp32:esp32:esp32s3\r\nset CK_BUTTON_MODES=[\"candidate\",\"reference\",\"reference\",\"candidate\",\"candidate\",\"reference\",\"reference\",\"candidate\",\"candidate\",\"reference\"]\r\necho Running ten full builds with native and official board-property expansion. Close CK first.\r\nstart \"\" /wait \"%~dp0CK-V9.1.exe\" --button-cold-check --silent\r\nset CK_TEST_EXIT=%ERRORLEVEL%\r\necho Results: 所选数据目录\\button-cold-result.json\r\necho Test exit code: %CK_TEST_EXIT%. All samples are retained.\r\npause\r\nexit /b %CK_TEST_EXIT%\r\n");
fs.appendFileSync(path.join(stage,'使用说明.txt'),"\r\nalpha.17：ESP32 3.3.6 / 3.3.6-cn 根据实际板卡及菜单直接展开已验证规则，减少首次 Arduino CLI 参数查询。未知或冲突规则仍回退官方。完整前后内容校验和 60 帧目标动画保留；不针对 WiFi 库做特殊加速。Run-ESP32-Properties-Comparison.cmd 提供五组真实按钮完整构建 A/B。详见 engine/docs/alpha.17-esp32-properties.md 及交付报告。\r\n");
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\nalpha.18：按库声明统一识别硬件字段，修复数字/下拉字段转成输入后引脚丢失，以及 AVR/ESP32 资源检查未接收库声明的问题。13 个原始库、40 个声明积木完成通用链路回归。HC-SR04 的 5、6 正确显示为两个引脚；缺少声明、部分覆盖和动态值明确标记待确认。库作者规范见 engine/docs/library-hardware-contract.md，修复范围见 engine/docs/alpha.18-pin-analysis.md。\r\n');
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\nalpha.19：恢复编译和上传按钮的流畅活动动画，V9 构建日志在执行过程中实时显示资产校验、发现、编译文件、链接和固件验证。长步骤显示等待时长；活动提示不作为完成比例或成功授权依据。动画共用 60 Hz 目标回调，日志限频合并更新。详见 engine/docs/alpha.19-live-build-activity.md。\r\n');
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\nalpha.20：修复积木断点和运行轨迹的插桩控制流、等待循环结束响应、快速单步确认竞态、显式 Arduino.h 编译、串口冲突检查、波特率、重启后的旧状态、轨迹末批刷新和长链定位。结束超时可退出桌面会话，未纳入采样的积木持续显示。调试串口独占，不能暂停全部任务；未知库内部串口和阻塞调用仍需验证。本轮未连接实体板卡，不宣称硬件资格完成。详见 engine/docs/alpha.20-debug-trace-repair.md。\r\n');
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\nalpha.21：工程体检、验收报告和诊断包按实际板卡能力显示。Uno/Nano/Mega 隐藏未支持的设备体检；编译后自动更新程序空间与 RAM，普通上传后刷新可用版本与依赖锁，保存失败显示具体原因。桌面回归中的上传传输使用模拟数据，不代表实体板卡验证。详见 engine/docs/alpha.21-health-report-fix.md。\r\n');
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\nalpha.22：板卡列表接入真实编译和普通上传成功记录，自动刷新并保留到下次启动；按完整板卡配置、板卡包和 Core 分开显示。AVR 隐藏不支持的真机专项状态，专项提速资格独立显示。旧版缺少的完整记录不补造。详见 engine/docs/alpha.22-board-status.md。\r\n');
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\nalpha.23：修复中文构建目录下的依赖文件乱码、GNU 链接及容量检查失败。保留完整校验；支持范围和回归方法见 engine/docs/alpha.23-unicode-paths.md。\r\n');
fs.writeFileSync(path.join(stage,'Run-Chinese-Paths.cmd'),'@echo off\r\nsetlocal\r\necho Close CK, then run Chinese-path desktop checks.\r\nstart "" /wait "%~dp0CK-V9.1.exe" --unicode-path-check --silent\r\nset CK_TEST_EXIT=%ERRORLEVEL%\r\necho Report: 所选数据目录\\unicode-report.json\r\necho Exit code: %CK_TEST_EXIT%. All samples retained.\r\npause\r\nexit /b %CK_TEST_EXIT%\r\n');
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\nalpha.24：主页提供在线升级，可关闭自动提醒并在设置中手动检查。编程页不显示更新入口；保留用户工程、库和 Arduino 核心包。\r\n');
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\nalpha.25：采用 CK 黑白橙品牌图标与界面强调色，支持明暗主题；积木分类色、成功/警告/错误状态色保留。编译活动动画继续使用既有 60 Hz 目标调度。在线更新服务已迁移并完成大陆节点验证。\r\n');
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\nalpha.26：新安装默认将核心包、工具链、缓存、下载、日志和新工程放在安装盘的 CKData 目录；安装时可选择其他位置。升级保留原路径。主页设置提供数据目录迁移，先关闭构建进程、复制并逐文件 SHA-256 校验，再切换并重启。原目录保留供回退；外部 Arduino 核心包只有主动勾选才复制。构建缓存重新建立。\r\n');
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\nalpha.27：Core 管理器打开时自动读取真实版本索引，支持刷新和错误提示；ESP32 默认选择加速版 3.3.6-cn，安装对应 CN 源。最新版本保留供手动选择，不自动升级已安装的 Core。\r\n');
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\nalpha.28：修复同一窗口安装 Core 后 V9 仍保持关闭的问题；每次编译检查当前环境，安装完成后无需重启即可重新检测并启用原生路径。明确选择兼容模式时保持兼容模式。诊断包包含启动就绪状态和当前环境校验结果。\r\n');
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\nalpha.29：优化新安装核心包后的首次工具链身份检查，采用有上限的并行文件打开；完整内容读取、SHA-256、目录成员和前后验证继续保留，有效工具链的身份值保持兼容。无需重装核心包。\r\n');
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\nalpha.31：修复 V9 编译报错到积木的定位，提供红框、感叹号与点击定位，保留库作者原有警告。第三方库无需新增报错字段或回调，软件统一记录生成代码来源。无法可靠归属的库内部或链接器错误保留诊断，不猜测具体积木。本地连接与驱动页补充五类芯片下载、离线图解及安装方法。\r\n');
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\nalpha.32：工程保存、另存为记录 Core 版本及全部有效板卡选项（含默认值）；恢复稿、检查点和提交报告携带配置。打开工程发现 Core 不一致时保留原记录并提示确认，不自动安装或更换 Core。旧工程可继续打开，环境就绪后重新保存可补齐记录。复制代码附配置注释，实际编译输入保持不变。本轮不改变加速调度，不作新的速度承诺。\r\n');
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\nalpha.33：编程工具栏新增 CK AI 侧栏，支持自填 API 地址、模型和会话密钥。读取当前积木与实际字段，预览后应用，可撤销并执行本地编译；积木右键可解释/修改，错误卡片可请求 AI 分析。第三方库无需额外 AI 字段，模板子积木也能识别。已用真实 DeepSeek 完成 Uno 闪灯生成、选中修改、编译错误修复及实际本地编译；未做真机上传，不保证所有模型或复杂程序均能一次成功。详见 engine/docs/alpha.33-release-notes.txt。\r\n');
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\nalpha.34：修复复杂 AI 积木方案的工具调用额度、长流式响应和对话历史截断问题；支持批量读取真实积木结构、分段暂存、扁平节点连接与变量登记。暂存不会修改工程，仍需预览确认，可撤销并执行本地编译。AI 逻辑需复核，编译通过不代表实体板行为正确。详见 engine/docs/alpha.34-release-notes.txt。\r\n');
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\nalpha.35：AI 可按库声明的功能与硬件用途查找积木，按需读取真实单位、依赖、约束、示例及错误恢复。新增可用库查询与完整文档分页；区分作者声明、兼容适配和未声明。旧库不强制增加AI字段。作者填写方法见 engine/docs/library-ai-capabilities.md。\r\n');
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\nalpha.36：AI 侧栏支持按工程保存聊天、草稿和摘要，可新建、切换、重命名及删除。全局密钥可使用当前 Windows 用户加密记住并修改；上下文预算与回复预留可调，接近上限时自动压缩，保留完整本地历史供按需回查。重复只读查询复用当前结果；显示估算用量，服务商账单以实际返回为准。修改仍需预览确认。使用说明见 engine/docs/ai-assistant-guide.md。\r\n');
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\nalpha.37：AI 第二阶段加入任务计划、隔离候选编译、真实诊断和最多两次自动修复。编译通过后仍由用户预览确认，可整笔撤销。未放置的暂存节点阻止提交，AI 可读取实际生成代码核对要求；精确结构由程序保留以减少重复查询与摘要请求。支持取消原生编译进程树，保留验证记录。编译通过不代表功能逻辑或真机通过，复杂程序需要复核；不自动上传或安装依赖。详见 engine/docs/alpha.37-release-notes.txt。\r\n');
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\n'+fs.readFileSync(path.join(root,'docs/alpha.38-release-notes.txt'),'utf8').replace(/\r?\n/g,'\r\n'));
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\nalpha.39：主聊天可搜索已有能力、按需补建最小积木库，经真实试编译后自动加载并继续原工程。库与工程分别记录验证；安装失败或取消时撤回未提交安装，成功安装的库保留明确记录。工程修改仍须预览确认；不会自动下载未知驱动或上传。生成器规范补全语句/返回值类型，安装后不再反复发送草稿源码。详见 engine/docs/ai-library-authoring.md 和交付说明。\r\n');
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\n'+fs.readFileSync(path.join(root,'docs/alpha.40-release-notes.txt'),'utf8').replace(/\r?\n/g,'\r\n'));
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\n'+fs.readFileSync(path.join(root,'docs/alpha.41-release-notes.txt'),'utf8').replace(/\r?\n/g,'\r\n'));
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\n'+fs.readFileSync(path.join(root,'docs/alpha.42-release-notes.txt'),'utf8').replace(/\r?\n/g,'\r\n'));
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\n'+fs.readFileSync(path.join(root,'docs/alpha.43-release-notes.txt'),'utf8').replace(/\r?\n/g,'\r\n'));
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\n'+fs.readFileSync(path.join(root,'docs/alpha.44-release-notes.txt'),'utf8').replace(/\r?\n/g,'\r\n'));
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\n'+fs.readFileSync(path.join(root,'docs/alpha.45-release-notes.txt'),'utf8').replace(/\r?\n/g,'\r\n'));
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\n'+fs.readFileSync(path.join(root,'docs/alpha.46-release-notes.txt'),'utf8').replace(/\r?\n/g,'\r\n'));
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\n'+fs.readFileSync(path.join(root,'docs/alpha.47-release-notes.txt'),'utf8').replace(/\r?\n/g,'\r\n'));
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\n'+fs.readFileSync(path.join(root,'docs/alpha.48-release-notes.txt'),'utf8').replace(/\r?\n/g,'\r\n'));
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\n'+fs.readFileSync(path.join(root,'docs/alpha.49-release-notes.txt'),'utf8').replace(/\r?\n/g,'\r\n'));
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\n'+fs.readFileSync(path.join(root,'docs/alpha.50-release-notes.txt'),'utf8').replace(/\r?\n/g,'\r\n'));
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\n'+fs.readFileSync(path.join(root,'docs/alpha.51-release-notes.txt'),'utf8').replace(/\r?\n/g,'\r\n'));
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\n'+fs.readFileSync(path.join(root,'docs/alpha.52-release-notes.txt'),'utf8').replace(/\r?\n/g,'\r\n'));
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\n'+fs.readFileSync(path.join(root,'docs/alpha.53-release-notes.txt'),'utf8').replace(/\r?\n/g,'\r\n'));
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\n'+fs.readFileSync(path.join(root,'docs/alpha.54-release-notes.txt'),'utf8').replace(/\r?\n/g,'\r\n'));
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\n'+fs.readFileSync(path.join(root,'docs/alpha.55-release-notes.txt'),'utf8').replace(/\r?\n/g,'\r\n'));
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\n'+fs.readFileSync(path.join(root,'docs/alpha.56-release-notes.txt'),'utf8').replace(/\r?\n/g,'\r\n'));
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\n'+fs.readFileSync(path.join(root,'docs/alpha.57-release-notes.txt'),'utf8').replace(/\r?\n/g,'\r\n'));
fs.appendFileSync(path.join(stage,'使用说明.txt'),'\r\n'+fs.readFileSync(path.join(root,`docs/${ENGINE_VERSION}-release-notes.txt`),'utf8').replace(/\r?\n/g,'\r\n'));
const files=[];function scan(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(f===path.join(stage,'files.sha256.json'))continue;if(e.isDirectory())scan(f);else files.push({path:path.relative(stage,f),bytes:fs.statSync(f).size,sha256:hash(f)});}}scan(stage);
fs.writeFileSync(path.join(stage,'files.sha256.json'),JSON.stringify(files,null,2));files.push({path:'files.sha256.json'});
const escape=s=>s.replaceAll('$','$$').replaceAll('"','$\\"');
const dirs=[...new Set(files.flatMap(f=>{const a=[];let d=path.dirname(f.path);while(d!=='.'){a.push(d);d=path.dirname(d);}return a;}))].sort((a,b)=>b.length-a.length);
const uninstall=files.map(f=>`  Delete "$INSTDIR\\${escape(f.path)}"`).join('\n')+'\n'+dirs.map(d=>`  RMDir "$INSTDIR\\${escape(d)}"`).join('\n');
const nsi=`Unicode True
!include "MUI2.nsh"
!include "LogicLib.nsh"
${storageIncludes}
Name "CK LAB V${ENGINE_VERSION}"
OutFile "${escape(path.join(out,installerName))}"
InstallDir "$LOCALAPPDATA\\Programs\\CKBuildEngineV91Alpha"
InstallDirRegKey HKCU "Software\\CKBuildEngineV91Alpha" "InstallDir"
RequestExecutionLevel user
Icon "${escape(path.join(root,'desktop/apps/desktop/src-tauri/icons/icon.ico'))}"
!define MUI_ICON "${escape(path.join(root,'desktop/apps/desktop/src-tauri/icons/icon.ico'))}"
!define MUI_UNICON "${escape(path.join(root,'desktop/apps/desktop/src-tauri/icons/icon.ico'))}"
SetCompressor /SOLID lzma
VIProductVersion "${ENGINE_VERSION}.0"
VIAddVersionKey "ProductVersion" "${ENGINE_VERSION}"
VIAddVersionKey "ProductName" "CK LAB"
VIAddVersionKey "FileDescription" "CK LAB current-user installer"
VIAddVersionKey "FileVersion" "${ENGINE_VERSION}"
VIAddVersionKey "LegalCopyright" "CK"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
${storagePage}
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"
${storageFunctions}
Function .onInit
  SetShellVarContext current
${storageInit}
  System::Call 'kernel32::OpenMutexW(i 0x100000, i 0, w "Local\\CK-V91-Product-Launcher") p.r0'
  IntCmp $0 0 checkReady
    System::Call 'kernel32::CloseHandle(p r0)'
    MessageBox MB_OK "请先关闭 CK V9.1 或等待资格测试结束，再安装。"
    Abort
  checkReady:
FunctionEnd
Function un.onInit
  SetShellVarContext current
  System::Call 'kernel32::OpenMutexW(i 0x100000, i 0, w "Local\\CK-V91-Product-Launcher") p.r0'
  IntCmp $0 0 checkReady
    System::Call 'kernel32::CloseHandle(p r0)'
    MessageBox MB_OK "请先关闭 CK V9.1 或等待资格测试结束，再卸载。"
    Abort
  checkReady:
FunctionEnd
Section "CK V9.1"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "${escape(stage)}\\*"
${storageInstall}
  WriteUninstaller "$INSTDIR\\Uninstall.exe"
  WriteRegStr HKCU "Software\\CKBuildEngineV91Alpha" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CKBuildEngineV91Alpha" "DisplayName" "CK LAB"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CKBuildEngineV91Alpha" "DisplayVersion" "${ENGINE_VERSION}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CKBuildEngineV91Alpha" "DisplayIcon" "$INSTDIR\\CK-V9.1.exe,0"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CKBuildEngineV91Alpha" "UninstallString" '"$INSTDIR\\Uninstall.exe"'
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CKBuildEngineV91Alpha" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CKBuildEngineV91Alpha" "NoModify" 1
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CKBuildEngineV91Alpha" "NoRepair" 1
  CreateDirectory "$SMPROGRAMS\\CK V9.1 测试版"
  CreateShortcut "$SMPROGRAMS\\CK V9.1 测试版\\CK V9.1 测试版.lnk" "$INSTDIR\\CK-V9.1.exe"
  CreateShortcut "$SMPROGRAMS\\CK V9.1 测试版\\兼容编译模式.lnk" "$INSTDIR\\CK-V9.1.exe" "--compat"
  CreateShortcut "$SMPROGRAMS\\CK V9.1 测试版\\准备工具链.lnk" "$INSTDIR\\CK-V9.1.exe" "--install-assets"
  CreateShortcut "$SMPROGRAMS\\CK V9.1 测试版\\第二台资格测试.lnk" "$INSTDIR\\CK-V9.1.exe" "--qualify"
  CreateShortcut "$SMPROGRAMS\\CK V9.1 测试版\\板卡配置回归测试.lnk" "$INSTDIR\\CK-V9.1.exe" "--configuration-check"
  CreateShortcut "$SMPROGRAMS\\CK V9.1 测试版\\WiFi 增量检查.lnk" "$INSTDIR\\CK-V9.1.exe" "--wifi-check"
  CreateShortcut "$SMPROGRAMS\\CK V9.1 测试版\\WiFi 等待积木 A-B 检查.lnk" "$INSTDIR\\CK-V9.1.exe" "--wifi-wait-check"
  CreateShortcut "$SMPROGRAMS\\CK V9.1 测试版\\环境检查.lnk" "$INSTDIR\\CK-V9.1.exe" "--doctor"
  CreateShortcut "$SMPROGRAMS\\CK V9.1 测试版\\修复 WebView2 运行时.lnk" "$INSTDIR\\MicrosoftEdgeWebview2Setup.exe"
  CreateShortcut "$SMPROGRAMS\\CK V9.1 测试版\\使用说明.lnk" "$INSTDIR\\使用说明.txt"
  CreateShortcut "$SMPROGRAMS\\CK V9.1 测试版\\测试结果.lnk" "$INSTDIR\\CK-V9.1.exe" "--open-data"
  CreateShortcut "$SMPROGRAMS\\CK V9.1 测试版\\卸载.lnk" "$INSTDIR\\Uninstall.exe"
  CreateShortcut "$DESKTOP\\CK V9.1 测试版.lnk" "$INSTDIR\\CK-V9.1.exe"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
SectionEnd
Section "Uninstall"
  SetShellVarContext current
  ReadRegStr $0 HKCU "Software\\CKBuildEngineV91Alpha" "InstallDir"
  StrCmp $0 $INSTDIR +3
    MessageBox MB_OK "卸载位置不匹配，请从已安装版本运行卸载。"
    Abort
  IfFileExists "$INSTDIR\\package-id.txt" +3
    MessageBox MB_OK "缺少安装标识，保留文件并停止卸载。"
    Abort
${uninstall}
  Delete "$INSTDIR\\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$DESKTOP\\CK V9.1 测试版.lnk"
  Delete "$SMPROGRAMS\\CK V9.1 测试版\\CK V9.1 测试版.lnk"
  Delete "$SMPROGRAMS\\CK V9.1 测试版\\兼容编译模式.lnk"
  Delete "$SMPROGRAMS\\CK V9.1 测试版\\准备工具链.lnk"
  Delete "$SMPROGRAMS\\CK V9.1 测试版\\第二台资格测试.lnk"
  Delete "$SMPROGRAMS\\CK V9.1 测试版\\板卡配置回归测试.lnk"
  Delete "$SMPROGRAMS\\CK V9.1 测试版\\WiFi 增量检查.lnk"
  Delete "$SMPROGRAMS\\CK V9.1 测试版\\WiFi 等待积木 A-B 检查.lnk"
  Delete "$SMPROGRAMS\\CK V9.1 测试版\\环境检查.lnk"
  Delete "$SMPROGRAMS\\CK V9.1 测试版\\修复 WebView2 运行时.lnk"
  Delete "$SMPROGRAMS\\CK V9.1 测试版\\使用说明.lnk"
  Delete "$SMPROGRAMS\\CK V9.1 测试版\\测试结果.lnk"
  Delete "$SMPROGRAMS\\CK V9.1 测试版\\卸载.lnk"
  RMDir "$SMPROGRAMS\\CK V9.1 测试版"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CKBuildEngineV91Alpha"
  DeleteRegKey HKCU "Software\\CKBuildEngineV91Alpha"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
SectionEnd
`;
const script=path.join(out,'installer.nsi');fs.writeFileSync(script,'\ufeff'+nsi);
const r=spawnSync(makensis,['/V2',script],{windowsHide:true,encoding:'utf8',maxBuffer:8e6});if(r.error)throw r.error;console.log(r.stdout);if(r.status!==0)throw Error(r.stderr||'NSIS failed with exit code '+r.status);
const exe=path.join(out,installerName);fs.writeFileSync(path.join(out,`SHA256SUMS-${ENGINE_VERSION}.txt`),hash(exe)+'  '+path.basename(exe)+'\n');
console.log(JSON.stringify({installer:exe,bytes:fs.statSync(exe).size,sha256:hash(exe),stage}));
