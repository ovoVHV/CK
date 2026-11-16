import sys

file_path = r'c:\Users\AI\Documents\CK\apps\desktop\src\components\Workspace.tsx'

try:
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    start_str = '    const runAgentCommand = useCallback(async (rawInput: string) => {'
    end_str = '    const handleCancel = async () => {'

    start_idx = content.find(start_str)
    if start_idx == -1:
        with open('replace_log.txt', 'w') as log:
            log.write('start not found\n')
        sys.exit(1)

    end_idx = content.find(end_str, start_idx)
    if end_idx == -1:
        with open('replace_log.txt', 'w') as log:
            log.write('end not found\n')
        sys.exit(1)

    new_code = """    const runAgentCommand = useCallback(async (rawInput: string) => {
        const text = String(rawInput || '').trim();
        if (!text) return;

        appendAgentMessage('user', text);
        if (agentRunning) {
            appendAgentMessage('assistant', '上一个任务还在执行，请稍等完成后再发送。');
            return;
        }

        const bridge = (window as any).CK_BLOCKLY_AGENT;
        if (!bridge) {
            appendAgentMessage('assistant', 'AI Bridge 未就绪，请稍后重试。');
            return;
        }

        setAgentRunning(true);
        setAgentThoughtText('');
        
        let engine = (window as any)._agentEngineInstance;
        if (!engine) {
            // @ts-ignore
            import('../services/agent_engine').then(({ AgentEngine }) => {
                engine = new AgentEngine({
                    onStart: () => {
                        initAgentSteps(['思考中', '规划动作']);
                        setAgentStepStatus(0, 'completed', '开始思考');
                        openAgentStep(1);
                    },
                    onDelta: (delta: string, reasoning: string | null) => {
                        if (reasoning) {
                            setAgentThoughtText(prev => prev + reasoning);
                        }
                    },
                    onToolStart: (toolName: string, args: any) => {
                        setAgentStepStatus(1, 'completed', `调用工具: ${toolName}`);
                        appendAgentMessage('assistant', `🛠️ 正在执行工具: ${toolName}`);
                    },
                    onToolEnd: (toolName: string, result: string) => {
                        console.log(`Tool ${toolName} finished with len ${result.length}`);
                    },
                    onAssistantMessage: (content: string) => {
                        appendAgentMessage('assistant', content);
                    },
                    onFinish: (reason: string) => {
                        setAgentRunning(false);
                    },
                    onError: (err: any) => {
                        appendAgentMessage('assistant', `发生错误: ${err.message}`);
                        setAgentRunning(false);
                    }
                });
                (window as any)._agentEngineInstance = engine;
                engine.run(text).catch((err: any) => {
                     appendAgentMessage('assistant', `运行失败: ${err.message}`);
                     setAgentRunning(false);
                });
            });
        } else {
            engine.run(text).catch((err: any) => {
                 appendAgentMessage('assistant', `运行失败: ${err.message}`);
                 setAgentRunning(false);
            });
        }
    }, [agentRunning, appendAgentMessage, initAgentSteps, setAgentStepStatus, openAgentStep, setAgentThoughtText]);

"""

    new_content = content[:start_idx] + new_code + content[end_idx:]

    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(new_content)

    with open('replace_log.txt', 'w') as log:
        log.write('Success\n')
except Exception as e:
    with open('replace_log.txt', 'w') as log:
        log.write(f'Error: {e}\n')
