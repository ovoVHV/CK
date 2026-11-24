# CK 外设样板库

选好板卡，在 **库管理器 → 导入** 中选择下面的**一个 ZIP**。板卡 Core 须预先安装；导入和使用不需要 AI 密钥、网络或另装驱动。Uno 打开包中的 `examples/demo.ck`，ESP32-S3 打开 `examples/demo-s3.ck`。同目录的 `invalid` 示例只改了一个参数，适合练习定位错误。

| 导入包 | 接线和现象 | 故意填错 → 修复 |
|---|---|---|
| [位置舵机 1.1.0](import/ck_position_servo-1.1.0.zip) | Uno D9 / S3 GPIO9 接信号，独立供电并共地；空载在 75° 与 105° 之间切换。读取的是命令角度，没有位置反馈。 | 初始化通道 `3 → 1` |
| [SSD1306 OLED 1.0.0](import/ck_oled_ssd1306-1.0.0.zip) | 4 针 128×64 SSD1306 接默认 Wire，示例交替显示 25% / 75% 进度条；不适用于 SH1106、SPI 或 128×32。 | 7 位地址 `62 → 60`（0x3C；若模块跳线为 0x3D，填 61） |
| [DHT22 温湿度 1.1.0](import/ck_dht22-1.1.0.zip) | DHT22 / AM2302 的 DATA 接 Uno D2 或 S3 GPIO2，按模块要求上拉。S3 使用 3.3 V。9600 波特率，每 2.1 秒打印温度、湿度与有效性。不是 DHT11。 | 初始化通道 `3 → 1` |

Arduino AVR 使用随包的 Servo 1.2.2。Uno 的 Servo 定时基于 Timer1；Mega2560 的驱动先分配 Timer5。ESP32-S3 使用 Arduino-ESP32 3.x 的 LEDC，由 Core 分配 50 Hz 通道。库声明信号引脚和资源类型，不把某一固定定时器报为所有板卡的占用；定时器占用证据不完整时，资源检查保留“部分覆盖”。OLED 的地址来自积木输入，使用板卡自带的 Wire。DHT 的 DATA 同时需要数字输入与输出；如果接了运行时变量，静态检查不能断言具体占用哪一个脚。

`profiles/` 定义积木、生成规则、资源与正反例；`drivers/` 是 CK 的 C++ 驱动或适配层；`upstream/` 存放完整上游源码 ZIP。驱动目录、许可证和来源说明随每个成品分发。CK 自有部分使用 Apache-2.0，以下上游源码保留原许可：

| 上游源码 | 许可 | 随包路径 |
|---|---|---|
| [Arduino Servo 1.2.2](https://github.com/arduino-libraries/Servo/tree/1.2.2) | LGPL-2.1-or-later | `libraries/Servo/LICENSE.txt` |
| [Adafruit DHT 1.4.6](https://github.com/adafruit/DHT-sensor-library/tree/1.4.6) | MIT | `libraries/DHT_sensor_library/license.txt` |
| [Adafruit Unified Sensor 1.1.15](https://github.com/adafruit/Adafruit_Sensor/tree/1.1.15) | Apache-2.0 | `libraries/Adafruit_Unified_Sensor/LICENSE.txt` |

从仓库根目录运行（Python 3.9+ 与 Node.js，输出目录须不存在）：

```powershell
py -3 library-kit/peripherals/build.py ./my-peripherals
```

配方先验证三个上游归档的 SHA-256，再复制原库完整目录并打包。最后检查文件、积木 ID、错例和 ZIP 内容。要复核结构与冲突，在桌面前端依赖已安装的源码仓库运行 `node tests/peripheral-library-contracts.mjs ./my-peripherals`。脚本使用 CK 的实际 schema 和资源检查器。桌面回归另用 `CK_LIBRARY_BATCH` 指向这批输出，通过 `scripts/Start-Preview.ps1` 运行 `tests/desktop-library-batch.mjs`，须提前准备独立 CK 测试数据和两块板的 Core。不要使用日常工程与库目录。

错例在积木生成的 C++ 里对常量配置做编译期检查；引脚和角度仍可接表达式。警告图标、红框、跳转和修改后消除标记都由 CK 处理。第三方作者无需编写 UI 或提交 `.ck-quality-report.json`。独立驱动内部报错不一定能归属到单个积木。

## 2026-11-25 本机验收

普通 Windows 用户，CK 9.1.0-alpha.56 预览。Uno / AVR Core 1.8.8 与 ESP32-S3 / Core 3.3.6，各用同一组交付 ZIP。每个组合均从桌面按钮执行正常示例、故意报错和修复重编，共 18 次。检查了真实 HEX/BIN、选中的库来源、报错实例的红框与感叹号、“定位积木”按钮和修复后标记消失。未连接物理串口，三件外设的动作、读数和显示均未作实物确认。其他板卡、Core 版本未验收。本轮不测编译速度。

[逐项结果与交付 ZIP 的 SHA-256](desktop-results.json)。
