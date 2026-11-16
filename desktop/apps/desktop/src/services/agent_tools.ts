import { BlocklyAgent } from './blockly_agent';
import { AbsParser } from './abs_parser';
export interface LlmToolFunctionDef {
    name: string;
    description?: string;
    parameters?: any;
}

export interface LlmToolDef {
    type: 'function';
    function: LlmToolFunctionDef;
}

// 供 LLM 使用的可用工具清单（OpenAI Function Calling 格式）
export const AGENT_TOOLS: LlmToolDef[] = [
    {
        type: 'function',
        function: {
            name: 'read_workspace',
            description: '读取当前工作区的所有积木，返回积木数量、类型、连接关系和字段值。当你需要了解用户当前已经拼了什么积木时调用此工具。',
            parameters: {
                type: 'object',
                properties: {}
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_toolbox',
            description: '读取当前环境下所有可用的积木类型清单。由于总体积木可能高达上百种，为了避免被截断，此工具仅返回精简信息（积木 type 和所在的分类）。你可以传入可选的 query 来搜索特定类型名称或类别的积木。如果找不到想要的积木，多次传入不同的 query 搜索！',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: '可选参数。搜索包含此关键词的积木 type 或分类。留空则返回所有积木的精简列表。'
                    }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_board_info',
            description: '获取当前选定板卡的信息，包括FQBN、引脚列表(支持的引脚名称)和配置选项。用于验证引脚分配是否合理。',
            parameters: {
                type: 'object',
                properties: {}
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'install_library',
            description: '安装一个用于附加传感器的 Arduino 库（扩展包）。当 read_toolbox 中找不到所需的积木时调用此工具。库名需准确传递。',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: '要安装的库名，例如 "Servo"'
                    },
                    version: {
                        type: 'string',
                        description: '版本号（可选参数）'
                    }
                },
                required: ['name']
            }
        }
    },

    {
        type: 'function',
        function: {
            name: 'compile',
            description: '编译当前工作区内的代码（积木转换为代码后编译），返回编译成功与否，如果失败会包含详细报错日志。这是验证代码是否正确的最关键一步。',
            parameters: {
                type: 'object',
                properties: {}
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'check_pin_conflicts',
            description: '检查当前工作区的积木连线是否存在硬件引脚冲突。虽然编译可能通过，但引脚冲突通常会导致运行时硬件异常，建议在复杂连线后使用。',
            parameters: {
                type: 'object',
                properties: {}
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'clear_workspace',
            description: '危险操作：清空当前工作区的所有积木。只有当用户明确要求"清空"、"重写"时才调用。',
            parameters: {
                type: 'object',
                properties: {}
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_block_details',
            description: `获取指定积木类型的详细信息：XML 模板、生成的 C/C++ 代码示例、可配置字段和输入接口名称。

在调用 inject_blocks 之前，必须先为每个要使用的积木类型调用此工具，以确认正确的 XML 格式。

返回内容说明：
- xmlTemplate: 该积木类型的标准 XML 表示，直接用于 inject_blocks
- generatedCode: 该积木默认生成的 C++ 代码示例，帮助你理解该积木的语义
- fields: 可以设置的字段名列表（对应 XML 中的 <field name="...">）
- inputs: 输入接口名称列表（对应 XML 中的 <value name="..."> 或 <statement name="...">`,
            parameters: {
                type: 'object',
                properties: {
                    type: {
                        type: 'string',
                        description: '积木类型名（block type），例如 "serial_println"。可从 read_toolbox 的结果中获取。'
                    }
                },
                required: ['type']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'write_abs',
            description: `【★★★ 必须用这个工具构建完整程序 ★★★】用缩进式积木语法快速编写程序。不需要写繁琐的 JSON！
用法：提供一段基于缩进的伪代码文本。
语法规则：
- 积木调用：block_type(参数1, 参数2...)
- 变量引用：$变量名 (例如 $count, $i)
- 数字：直接写数字 (例如 10, 3.14)
- 字符串：带引号 (例如 "hello")
- 命名输入/语句块：使用 @输入名: 加换行缩进 (例如 @DO: )
示例：
controls_setup_custom()
    @DO:
        serial_setup(9600)
        var_set_custom(i, 0)
        controls_for(i, 1, 10, 1)
            @DO:
                serial_print(TRUE, $i)
controls_loop_custom()
    @DO:
        time_delay(1000)
`,
            parameters: {
                type: 'object',
                properties: {
                    code: {
                        type: 'string',
                        description: 'ABS 语法的程序代码'
                    }
                },
                required: ['code']
            }
        }
    }
];

// 执行工具调用的映射表
export const executeAgentTool = async (
    name: string,
    argsString: string
): Promise<string> => {
    try {
        const args = argsString.trim() ? JSON.parse(argsString) : {};

        switch (name) {
            case 'write_abs': {
                if (!args.code) return "Error: 缺少必需参数 code";
                try {
                    const parser = new AbsParser();
                    const parseResult = parser.parse(args.code);
                    if (!parseResult.success) {
                        return `⚠️ 解析 ABS 错误:\n${parseResult.errors.join('\n')}`;
                    }
                    const result = BlocklyAgent.bridge().buildProgram({
                        setup: parseResult.setup || [],
                        loop: parseResult.loop || []
                    });
                    if (result.success) {
                        return `✅ 程序构建成功！共 ${result.totalBlocks} 个积木。`;
                    } else {
                        return `⚠️ 构建完成但有问题(${result.totalBlocks}个积木):\n${result.error}`;
                    }
                } catch (e: any) {
                    return `write_abs 失败: ${e?.message || String(e)}`;
                }
            }
            case 'read_workspace': {
                const ctx = await BlocklyAgent.collectContext();
                const ws = ctx.workspace;
                // 精简输出：只返回摘要信息，不再返回完整的 json/xml/code 以节省上下文
                const summary = {
                    blockCount: ws.blockCount,
                    topBlockTypes: ws.topBlockTypes,
                    // 只保留前 30 个积木的关键信息
                    blocks: (ws.blocks || []).slice(0, 30).map(b => ({
                        id: b.id,
                        type: b.type,
                        fieldValues: b.fieldValues
                    })),
                    truncated: (ws.blocks || []).length > 30
                };
                return JSON.stringify(summary, null, 2);
            }
            case 'read_toolbox': {
                const ctx = await BlocklyAgent.collectContext();
                let blocks = ctx.toolbox.blocks || [];
                if (args.query) {
                    const q = String(args.query).toLowerCase();
                    blocks = blocks.filter(b => {
                        const entry = b as any;
                        const keywords = Array.isArray(entry.keywords)
                            ? entry.keywords.join(' ')
                            : String(entry.keywords || '');
                        return (entry.type || '').toLowerCase().includes(q)
                            || (entry.category || '').toLowerCase().includes(q)
                            || keywords.toLowerCase().includes(q)
                            || String(entry.libraryId || '').toLowerCase().includes(q);
                    });
                }
                const simplified = blocks.map(b => ({
                    type: b.type,
                    category: b.category,
                    keywords: (b as any).keywords || [],
                    libraryId: (b as any).libraryId || null
                }));
                return JSON.stringify({
                    query: args.query || null,
                    totalCount: (ctx.toolbox.blocks || []).length,
                    returnedCount: simplified.length,
                    blocks: simplified
                }, null, 2);
            }
            case 'get_block_details': {
                if (!args.type) return "Error: 缺少必需参数 type";
                const details = BlocklyAgent.bridge().getBlockDetails(args.type);
                if (details.error) {
                    return `获取积木详情失败: ${details.error}`;
                }
                return JSON.stringify(details, null, 2);
            }

            case 'get_board_info': {
                const ctx = await BlocklyAgent.collectContext();
                return JSON.stringify(ctx.hardware, null, 2);
            }
            case 'check_pin_conflicts': {
                if (BlocklyAgent.bridge().checkPinConflicts) {
                    const conflicts = await BlocklyAgent.bridge().checkPinConflicts();
                    return JSON.stringify(conflicts, null, 2);
                }
                return JSON.stringify({ conflicts: [] });
            }
            case 'clear_workspace': {
                await BlocklyAgent.injectBlocks('<xml xmlns="https://developers.google.com/blockly/xml"></xml>', 'replace');
                return "工作区已清空。";
            }
            case 'install_library': {
                if (!args.name) return "Error: 缺少必需参数 name";
                try {
                    await BlocklyAgent.installLibrary(args.name, args.version);
                    return `成功安装库: ${args.name}`;
                } catch (e: any) {
                    return `安装库 ${args.name} 失败: ${e.message || String(e)}`;
                }
            }
            case 'compile': {
                try {
                    const res = await BlocklyAgent.compile();
                    // Assuming compile() returns AgentCompileResult which might not have 'success', 
                    // Let's assume it has success or code/message.
                    const isSuccess = (res as any).success === true || (res as any).code === 0 || (res as any).status === 'success';
                    if (isSuccess) {
                        return "编译成功！没有错误。";
                    } else {
                        const logObj = (res as any).compiler_log || (res as any).log || (res as any).message || JSON.stringify(res);
                        // 如果失败，自动尝试 diagnose
                        if (BlocklyAgent.bridge().diagnoseError) {
                            try {
                                const diag = await BlocklyAgent.bridge().diagnoseError(logObj);
                                return JSON.stringify({
                                    result: "编译失败",
                                    raw_log: logObj,
                                    diagnose_hints: diag
                                });
                            } catch {
                                return `编译失败，日志:\n${logObj}`;
                            }
                        }
                        return `编译失败，日志:\n${logObj}`;
                    }
                } catch (e: any) {
                    return `调用编译服务失败: ${e.message || String(e)}`;
                }
            }
            default:
                return `Error: 未知的工具调用名称: ${name}`;
        }
    } catch (err: any) {
        return `工具执行抛出异常: ${err.message || String(err)}`;
    }
};
