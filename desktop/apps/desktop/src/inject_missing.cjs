const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'components', 'Workspace.tsx');
let content = fs.readFileSync(filePath, 'utf-8');

const endStr = '    const handleCancel = async () => {';
const endIdx = content.indexOf(endStr);

if (endIdx === -1) {
    console.error('Could not find handleCancel');
    process.exit(1);
}

const missingCode = `
    const startResizing = useCallback((e: React.MouseEvent) => {
        setIsResizing(true);
    }, []);

    const startCodeResizing = useCallback((e: React.MouseEvent) => {
        setIsCodeResizing(true);
    }, []);

    const startAgentPanelResizing = useCallback((e: React.MouseEvent) => {
        setIsAgentPanelResizing(true);
    }, []);

    const stopAgentRun = useCallback(() => {
        setAgentRunning(false); 
        if ((window as any)._agentEngineInstance) {
            (window as any)._agentEngineInstance.cancel();
        }
    }, [setAgentRunning]);

    const popoutConsoleWindow = useCallback(async () => {
        try {
            // @ts-ignore
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('open_detached_console');
            setConsoleDetached(true);
        } catch (e: any) {
            console.error('Failed to pop out console', e);
        }
    }, [setConsoleDetached]);

    const dockConsoleToMain = useCallback(() => {
        setConsoleDetached(false);
    }, [setConsoleDetached]);

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (isResizing) {
                const newHeight = window.innerHeight - e.clientY - 24;
                if (newHeight > 100 && newHeight < window.innerHeight - 100) {
                    setConsoleHeight(newHeight);
                }
            } else if (isCodeResizing) {
                const newWidth = e.clientX;
                if (newWidth > 200 && newWidth < window.innerWidth - 300) {
                    setCodeWidth(newWidth);
                }
            } else if (isAgentPanelResizing) {
                const newWidth = window.innerWidth - e.clientX;
                if (newWidth > 300 && newWidth < window.innerWidth - 300) {
                    setAgentPanelWidth(newWidth);
                    localStorage.setItem('ck_agent_panel_width', newWidth.toString());
                }
            }
        };

        const handleMouseUp = () => {
            setIsResizing(false);
            setIsCodeResizing(false);
            if (isAgentPanelResizing && agentPanelRef.current) {
                const finalW = agentPanelRef.current.offsetWidth;
                if (finalW > 0) localStorage.setItem('ck_agent_panel_width', finalW.toString());
            }
            setIsAgentPanelResizing(false);
        };

        if (isResizing || isCodeResizing || isAgentPanelResizing) {
            window.addEventListener('mousemove', handleMouseMove);
            window.addEventListener('mouseup', handleMouseUp);
            document.body.style.userSelect = 'none';
            if (isCodeResizing || isAgentPanelResizing) {
                document.body.style.cursor = 'ew-resize';
            } else {
                document.body.style.cursor = 'ns-resize';
            }
        }

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
        };
    }, [isResizing, isCodeResizing, isAgentPanelResizing, setConsoleHeight, setCodeWidth, setAgentPanelWidth]);

`;

const newContent = content.substring(0, endIdx) + missingCode + content.substring(endIdx);
fs.writeFileSync(filePath, newContent, 'utf-8');
console.log('Successfully restored missing UI logic hooks.');
