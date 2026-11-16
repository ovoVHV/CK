const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'components', 'Workspace.tsx');
let content = fs.readFileSync(filePath, 'utf-8');

const startStr = '    const runAgentCommand = useCallback(async (rawInput: string) => {';
const endStr = '    const handleCancel = async () => {';

const startIndex = content.indexOf(startStr);
const endIndex = content.indexOf(endStr, startIndex);

if (startIndex === -1 || endIndex === -1) {
    console.error(`Could not find bounds. start=${startIndex}, end=${endIndex}`);
    process.exit(1);
}

const newCode = `    const runAgentCommand = useCallback(async (rawInput: string) => {
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
                        setAgentStepStatus(1, 'completed', \`调用工具: \${toolName}\`);
                        appendAgentMessage('assistant', \`🛠️ 正在执行工具: \${toolName}\`);
                    },
                    onToolEnd: (toolName: string, result: string) => {
                        console.log(\`Tool \${toolName} finished with len \${result.length}\`);
                    },
                    onAssistantMessage: (content: string) => {
                        appendAgentMessage('assistant', content);
                    },
                    onFinish: (reason: string) => {
                        setAgentRunning(false);
                    },
                    onError: (err: any) => {
                        appendAgentMessage('assistant', \`发生错误: \${err.message}\`);
                        setAgentRunning(false);
                    }
                });
                (window as any)._agentEngineInstance = engine;
                engine.run(text).catch((err: any) => {
                     appendAgentMessage('assistant', \`运行失败: \${err.message}\`);
                     setAgentRunning(false);
                });
            });
        } else {
            engine.run(text).catch((err: any) => {
                 appendAgentMessage('assistant', \`运行失败: \${err.message}\`);
                 setAgentRunning(false);
            });
        }
    }, [agentRunning, appendAgentMessage]);

`;

const newContent = content.substring(0, startIndex) + newCode + content.substring(endIndex);
fs.writeFileSync(filePath, newContent, 'utf-8');
console.log('Replacement successful.');
