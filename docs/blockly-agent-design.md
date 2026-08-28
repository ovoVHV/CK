# CK Blockly Agent 设计方案（可执行版）

> 目标：实现一个可落地的 Blockly Agent，不靠“猜积木”，而是先读取当前环境（工作区、toolbox、板卡、库），再按步骤执行，失败时给出可解释错误和可选修复方案。

## 1. 现状能力盘点（基于当前仓库）

### 1.1 已有能力（可直接复用）

1. 工作区读写
- 前端可直接读取/保存 Blockly 状态（`Blockly.serialization.workspaces.save/load`）。
- 后端项目读写命令已存在：`project::load_project`、`project::save_project`、`project::save_project_as`。

2. 当前可用积木读取
- `Workspace.tsx` 在合并系统积木 + 板卡扩展 + 库扩展后，会构建搜索索引（`toolboxSearchEntriesRef`），已包含 `type/category/xml/keywords`。

3. 板卡上下文读取
- 后端已有 `get_board_details(fqbn)`，可拿到 `arduino-cli board details --format json` 输出。

4. 库上下文与管理
- 后端已有 `get_all_libraries`（当前板卡可见库清单）。
- 后端已有 `search_arduino_libraries` / `install_arduino_library` / `uninstall_arduino_library`。

5. 编译与日志
- 后端已有 `compile_sketch`，返回 JSON（`path/log/artifacts/customLibraries/arduinoLibraries/cliUsageLines`）。
- 前端已有 `build-log` 流式日志订阅。

### 1.2 当前缺口（Agent 还缺什么）

1. 没有统一的 Agent Tool 层（现在能力分散在 UI 与 Tauri command）。
2. 没有标准化的 Context Snapshot 结构（Agent 每轮需要固定输入）。
3. 没有“错误分类 -> 解释原因 -> 给用户选项 -> 按选项继续执行”的闭环。
4. 没有“缺积木时自动补齐”的严格流程（先查现有、再装库、最后再生成新库）。

## 2. Agent 总体架构

```text
用户意图
  -> Context Collector
     - 读工作区已有积木
     - 读当前可用积木(合并后的 toolbox)
     - 读板卡引脚/选项
     - 读已安装库
  -> Planner
     - 任务拆解
     - 缺口分析（缺积木? 缺库? 参数冲突?）
  -> Executor (逐步执行)
     - 安装库/注入积木/修改参数
     - 每一步都做校验
  -> Verifier
     - 静态检查（引脚冲突等）
     - 编译验证
  -> Diagnoser
     - 错误归因（可解释）
     - 生成可选修复方案
  -> User Decision
     - 用户选择后继续下一步
```

## 3. Agent 上下文模型（每轮都要收集）

```json
{
  "hardware": {
    "activeBoard": "esp32:esp32:esp32c5",
    "boardDetails": {},
    "pins": []
  },
  "toolbox": {
    "blocks": [
      {
        "type": "servo_attach",
        "category": "执行器",
        "categoryPath": "控制 > 执行器",
        "xmlTemplate": "<block type=\"servo_attach\"></block>",
        "keywords": "servo attach pin"
      }
    ]
  },
  "workspace": {
    "json": {},
    "xml": "",
    "blocks": [
      {
        "id": "abc",
        "type": "controls_if",
        "fields": {"PIN": "9"},
        "parentId": null
      }
    ]
  },
  "libraries": [
    {
      "id": "Servo",
      "name": "Servo",
      "version": "1.2.2",
      "location": "Global"
    }
  ]
}
```

## 4. Agent Tool 定义（必须具备）

| Tool | 目的 | 建议来源 |
|---|---|---|
| `read_workspace_blocks()` | 读取当前工作区积木（json/xml/summary） | 前端 `workspaceRef` + Blockly serialization |
| `read_toolbox_blocks()` | 读取“当前真实可用”的积木清单（不是静态猜测） | `toolboxSearchEntriesRef` + Blockly runtime |
| `get_board_info()` | 获取板卡引脚、菜单选项、能力 | `get_board_details` + `activeBoard/options` |
| `get_installed_libraries()` | 获取当前板卡相关库 | `get_all_libraries` |
| `install_library(name, version?)` | 安装 Arduino 库 | `install_arduino_library` |
| `inject_blocks(xml, mode)` | 向工作区追加/替换积木 | `Blockly.Xml.domToWorkspace` |
| `clear_workspace()` | 清空工作区 | `workspace.clear()` |
| `compile(code?, fqbn?)` | 编译验证并拿日志 | `compile_sketch` |
| `check_pin_conflicts()` | 静态检测引脚冲突 | 基于 workspace block fields 扫描 |
| `diagnose_error(log)` | 把日志转成用户可理解问题 | 规则引擎 + LLM |

说明：
- `read_toolbox_blocks()` 必须返回“合并后 toolbox”视图（系统 + 板卡 + 库）。
- Agent 决策前，不允许直接假设某个 block type 一定存在。

## 5. 执行主循环（一步读取一步执行）

1. 收集上下文
- 调 `read_workspace_blocks` + `read_toolbox_blocks` + `get_board_info` + `get_installed_libraries`。

2. 意图解析与目标拆解
- 例："接一个舵机在 D9，每秒摆动" -> 需要 `servo_attach` + `servo_write` + loop/delay。

3. 缺口分析
- 若 `servo_attach` 不在 toolbox：标记“缺积木”。
- 若目标引脚不合法：标记“参数不合法”。

4. 依赖补齐
- 优先顺序：
1. 现有 toolbox 中找等价积木。
2. 已安装库里找对应 block 包。
3. 在线安装标准库（如 Servo）。
4. 仍无 -> 进入“自动生成库”流程（从 `.h` 生成）。

5. 生成最小变更（Patch）
- 不整页重写工作区，只注入必要 XML 片段。

6. 校验
- 先跑 `check_pin_conflicts`。
- 再跑 `compile`。

7. 失败处理
- `diagnose_error(log)` 产出问题、原因、候选修复选项。
- 把选项给用户选，按选择继续执行。

8. 成功收尾
- 返回“做了什么、改了哪些积木、为什么这样改”。

## 6. 报错解释与用户选项（关键）

Agent 对每个错误必须给：
1. `发生了什么`（现象）
2. `为什么`（根因）
3. `可选解决方案`（至少 2 个，含影响）

标准结构：

```json
{
  "issueId": "missing_library_servo",
  "summary": "缺少 Servo 库，导致找不到 <Servo.h>",
  "reason": "编译日志包含 fatal error: Servo.h: No such file or directory",
  "options": [
    {
      "id": "install_servo",
      "label": "自动安装 Servo 库（推荐）",
      "impact": "会修改本地库环境"
    },
    {
      "id": "switch_block",
      "label": "改用当前已有 PWM 输出积木",
      "impact": "功能接近但不是标准舵机接口"
    },
    {
      "id": "cancel",
      "label": "取消本次修改",
      "impact": "不改变当前工程"
    }
  ]
}
```

## 7. 缺失积木时的自动补齐策略

1. 先查“已有积木”
- 以 `read_toolbox_blocks` 结果为准。

2. 再查“是否可通过安装库获得”
- 用 `search_arduino_libraries` + 已知映射（如 Servo -> `servo_attach/servo_write`）。

3. 再做“AI 转库（高级）”
- 输入：头文件/类定义。
- 输出：`library.json` + `blocks/blocks.js` + `blocks/generator.js` + `blocks/toolbox.xml`。
- 生成后先沙盒编译再挂载到正式库目录。

4. 最后才让用户手工介入
- 给出“缺哪些 API / 为什么无法自动生成”的明确说明。

## 8. 回滚与安全

1. 每次注入前创建 workspace snapshot（json + xml）。
2. 任一步失败可回滚到上一步。
3. 安装库/生成库要记录操作日志（可撤销、可追踪）。

## 9. 分阶段落地计划（建议）

### Phase A（先可用）
- 建立统一 Agent Tool 层（先不做 LLM 自动转库）。
- 打通：读取上下文 -> 缺口分析 -> 安装库 -> 注入积木 -> 编译 -> 错误解释。

### Phase B（增强）
- 引入“错误分类器 + 用户选项执行器”。
- 引入 pin/board 约束的静态检查器。

### Phase C（高级）
- 引入 C++ Header -> Blockly 的自动转库能力。
- 增加生成库质量门禁（命名冲突、generator 语法、最小编译验证）。

## 10. 验收标准

1. Agent 能准确读出：
- 当前工作区已有积木。
- 当前可用积木（toolbox 合并态）。

2. Agent 不会“凭空用不存在的积木”。

3. 编译失败时，能给出中文根因和可选方案，不只是抛原始日志。

4. 用户选择某个方案后，Agent 能继续执行而不是重新从头。

5. 任一步失败可回滚，工作区不被破坏。

## 11. 交互界面要求（聊天框 + 实时进度）

1. 入口必须显式可见
- 顶部工具栏提供 `AI 聊天` 按钮。
- 同时提供右下角浮动按钮，避免用户找不到入口。

2. 聊天区必须可追踪
- 用户消息与 Agent 回复按时间顺序展示。
- 支持自然语言命令（如“编译并解释错误”“检查引脚冲突”“安装库 Servo”）。

3. 任务进度必须逐步可见
- 每次执行生成步骤列表（`pending / in_progress / completed / failed`）。
- 每一步显示标题与可选 detail。
- 支持展开/收起进度区。

4. 实时日志必须滚动更新
- Agent 执行中的关键动作写入 `Live Logs`。
- 日志和聊天区默认自动滚动到底部，确保“正在做什么”可实时观察。

5. 错误反馈必须包含可选方案
- 失败时展示：`发生了什么` + `为什么` + `可选修复方案`。
- 方案应可点击继续执行（后续可从按钮升级为交互卡片）。

6. LLM 接入（DeepSeek 第一阶段）
- 提供 `chat_with_deepseek` 后端命令，统一走 Rust 网络请求，避免前端 CORS 与密钥暴露。
- 输入参数至少包含：`apiKey`、`model`、`userMessage`、`contextJson`。
- Key 为空时允许回退读取环境变量（`DEEPSEEK_API_KEY` / `CK_DEEPSEEK_API_KEY`）。
- DeepSeek 失败时必须回退到本地规则建议，不能让会话中断。
