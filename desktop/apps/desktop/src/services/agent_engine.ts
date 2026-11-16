import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { getAgentSystemPrompt } from './agent_prompts';
import { AGENT_TOOLS, executeAgentTool } from './agent_tools';
import { AgentLlmDeltaPayload, AgentGlmChatRequest, AgentGlmChatResult } from '../types/agent';

// 简易UUID生成器
function generateUuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export interface AgentMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: any[];
    tool_call_id?: string;
    name?: string;
}

export interface AgentEngineCallbacks {
    onStart?: () => void;
    // 当 LLM 开始输出思考或正文流时触发
    onDelta?: (delta: string, reasoningDelta: string | null) => void;
    // 当一个完整的 LLM 轮次结束，且它是返回给用户的文本时
    onAssistantMessage?: (content: string) => void;
    // 当准备执行一个工具时（可以用于 UI 显示 "正在执行: xx工具"）
    onToolStart?: (toolName: string, args: any) => void;
    // 当一个工具执行完成时
    onToolEnd?: (toolName: string, result: string) => void;
    onFinish?: (reason: string) => void;
    onError?: (error: Error) => void;
}

export interface AgentRunOptions {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
}

export class AgentEngine {
    private isRunning: boolean = false;
    private currentRunId: string | null = null;
    private maxRounds: number = 100;

    // 我们在此保存多轮对话上下文
    private history: AgentMessage[] = [];

    constructor(
        private callbacks: AgentEngineCallbacks
    ) {
        // 初始化时放入 System Prompt
        this.history.push({
            role: 'system',
            content: getAgentSystemPrompt()
        });
    }

    public async run(userMessage: string, options?: AgentRunOptions) {
        if (this.isRunning) {
            this.callbacks.onError?.(new Error("Agent is already running"));
            return;
        }

        this.isRunning = true;
        this.currentRunId = `agent-run-${generateUuid()}`;
        this.callbacks.onStart?.();

        // 记录用户的输入
        this.history.push({
            role: 'user',
            content: userMessage
        });

        const runFn = async () => {
            let rounds = 0;

            while (rounds < this.maxRounds) {
                if (!this.isRunning) break; // 若被取消
                rounds++;

                console.log(`[AgentEngine] Starting round ${rounds}`);

                // 1. 准备调用 LLM
                const req: AgentGlmChatRequest = {
                    userMessage: rounds === 1 ? userMessage : "(Continue with tool results)",
                    // 这里由于后端实现问题，我们需要一点小 Hack：后端必定会在 messages 最后塞入 'user_message'。
                    // 而标准的 Function Calling 往往是 tool 之后直接跟 assistant。
                    historyMessages: this.history.filter(m => m.role !== 'system'),
                    tools: AGENT_TOOLS,
                    runId: this.currentRunId!,
                    apiKey: options?.apiKey,
                    model: options?.model,
                    baseUrl: options?.baseUrl
                };

                // 中间轮发送特殊标记，后端会识别并跳过追加 user 消息
                // 这样 messages 末尾就是 tool result，模型会自然继续处理
                if (rounds > 1) {
                    req.userMessage = "__TOOL_CONTINUE__";
                }

                let unlistenDelta: UnlistenFn | null = null;
                try {
                    // 2. 绑定事件流
                    unlistenDelta = await listen<AgentLlmDeltaPayload>('agent-llm-delta', (e) => {
                        if (e.payload.runId === this.currentRunId) {
                            this.callbacks.onDelta?.(e.payload.delta, e.payload.reasoningDelta || null);
                        }
                    });

                    // 3. 调用后端
                    const result = await invoke<AgentGlmChatResult>('chat_with_glm_stream', { req });

                    // 记录 LLM 的完整响应
                    const assistantMsg: AgentMessage = {
                        role: 'assistant',
                        content: result.content
                    };

                    // 处理 function calling 返回
                    if (result.toolCalls && result.toolCalls.length > 0) {
                        assistantMsg.tool_calls = result.toolCalls;
                        this.history.push(assistantMsg);

                        // 执行所有生成的工具调用
                        // 防重复检测
                        for (const tool of result.toolCalls) {
                            if (!this.isRunning) break;

                            const name = tool.function.name;
                            const args = tool.function.arguments;
                            let parsedArgs = {};
                            try { parsedArgs = JSON.parse(args); } catch { }

                            // 防重复循环检测：从历史的 assistant tool_calls 中提取同名工具的真实参数
                            const callSignature = JSON.stringify(parsedArgs);
                            const historicalArgs = this.history
                                .filter(m => m.role === 'assistant' && m.tool_calls)
                                .flatMap(m => m.tool_calls!)
                                .filter(tc => tc.function?.name === name)
                                .slice(-3)
                                .map(tc => {
                                    try { return JSON.stringify(JSON.parse(tc.function.arguments)); }
                                    catch { return tc.function.arguments; }
                                });
                            // 只有最近 3 次调用参数完全相同才判定为死循环
                            const isDuplicate = historicalArgs.length >= 3 &&
                                historicalArgs.every(s => s === callSignature);

                            if (isDuplicate) {
                                this.history.push({
                                    role: 'tool',
                                    tool_call_id: tool.id,
                                    name: name,
                                    content: `⚠️ 系统检测到你已连续调用 ${name} 且参数完全相同。请换一种方法或改变参数。`
                                });
                                this.callbacks.onToolEnd?.(name, '⚠️ 重复调用被拦截');
                                continue;
                            }

                            this.callbacks.onToolStart?.(name, parsedArgs);

                            // 执行工具
                            let execResult = "";
                            try {
                                execResult = await executeAgentTool(name, args);
                            } catch (e: any) {
                                execResult = `工具调用内部异常: ${e.message || String(e)}`;
                            }

                            this.callbacks.onToolEnd?.(name, execResult);

                            // 记录工具调用结果，准备下一轮
                            this.history.push({
                                role: 'tool',
                                tool_call_id: tool.id,
                                name: name,
                                content: execResult
                            });
                        }
                        // 包含由于执行了工具，将进入下一轮 while 循环，让 LLM 根据结果决定下一步
                    } else {
                        // 试图在纯文本中拦截可能存在的 <tool_call> 退化调用（适配 DeepSeek R1 这类不支持严格 Function Calling 的推理模型）
                        const finalContent = result.content?.trim() || '';
                        let hasFallbackToolCall = false;

                        // 用正则匹配 <tool_call> JSON...</tool_call>
                        const toolCallMatch = finalContent.match(/<tool_call>\s*({[\s\S]*?})\s*<\/tool_call>/);
                        if (toolCallMatch) {
                            try {
                                const parsedTool = JSON.parse(toolCallMatch[1]);
                                if (parsedTool.name) {
                                    hasFallbackToolCall = true;
                                    const name = parsedTool.name;
                                    const args = typeof parsedTool.arguments === 'string'
                                        ? parsedTool.arguments
                                        : JSON.stringify(parsedTool.arguments || {});

                                    this.callbacks.onToolStart?.(name, parsedTool.arguments || {});

                                    let execResult = "";
                                    try {
                                        execResult = await executeAgentTool(name, args);
                                    } catch (e: any) {
                                        execResult = `工具调用内部异常: ${e.message || String(e)}`;
                                    }

                                    this.callbacks.onToolEnd?.(name, execResult);

                                    // 模拟放入历史记录
                                    this.history.push(assistantMsg);
                                    this.history.push({
                                        role: 'tool',
                                        tool_call_id: `fallback-${generateUuid()}`,
                                        name: name,
                                        content: execResult
                                    });
                                }
                            } catch (e) {
                                console.error('Failed to parse fallback tool_call XML block:', e);
                            }
                        }

                        if (hasFallbackToolCall) {
                            // 成功拦截到非原生工具调用，继续下一轮循环
                            continue;
                        }

                        // 如果完全没有 tool calls，表示纯文本输出，任务通常结束
                        this.history.push(assistantMsg);
                        this.callbacks.onAssistantMessage?.(finalContent || '✅ 任务完成。');
                        this.callbacks.onFinish?.(result.finishReason || 'stop');
                        break;
                    }
                } catch (err: any) {
                    this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
                    break;
                } finally {
                    if (unlistenDelta) {
                        unlistenDelta();
                    }
                }
            }

            if (rounds >= this.maxRounds) {
                this.callbacks.onFinish?.('max_rounds');
            }
        };

        try {
            await runFn();
        } finally {
            this.isRunning = false;
            this.currentRunId = null;
        }
    }

    public cancel() {
        if (this.isRunning && this.currentRunId) {
            this.isRunning = false;
            invoke('cancel_glm_stream', { runId: this.currentRunId }).catch(console.error);
            this.callbacks.onFinish?.('cancelled');
        }
    }
}
