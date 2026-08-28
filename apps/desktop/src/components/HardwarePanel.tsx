import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { SerialMonitor } from './SerialMonitor';

export const HardwarePanel: React.FC = () => {
    const [boards, setBoards] = useState<string>("");
    const [loading, setLoading] = useState(false);
    const [ports, setPorts] = useState<{ port_name: string, description: string }[]>([]);
    const [selectedPort, setSelectedPort] = useState<string>("");

    // Initial load
    React.useEffect(() => {
        refreshPorts();
    }, []);

    const refreshPorts = async () => {
        try {
            const list = await invoke<{ port_name: string, description: string }[]>("list_serial_ports");
            setPorts(list);
            if (list.length > 0 && !selectedPort) {
                setSelectedPort(list[0].port_name);
            }
        } catch (e) {
            console.error("Failed to list ports", e);
        }
    };

    const scanBoards = async () => {
        setLoading(true);
        setBoards("正在扫描硬件... (初次运行可能需要下载工具链)");
        try {
            const result = await invoke<string>("arduino_board_list");
            setBoards(result);
        } catch (e) {
            setBoards(`错误: ${e}`);
        } finally {
            setLoading(false);
        }
    };

    const runDemo = async () => {
        setLoading(true);
        setBoards("正在初始化编译引擎...");
        try {
            const result = await invoke<string>("verify_sketch_demo");
            setBoards(result);
        } catch (e) {
            setBoards(`编译错误: ${e}`);
        } finally {
            setLoading(false);
        }
    };

    const runUpload = async () => {
        if (!selectedPort) {
            setBoards("请先选择一个串口！");
            return;
        }
        setLoading(true);
        setBoards(`正在向 ${selectedPort} 烧录固件...`);
        try {
            const result = await invoke<string>("upload_sketch_demo", { port: selectedPort });
            setBoards(result);
        } catch (e) {
            setBoards(`烧录错误: ${e}`);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div style={styles.container}>
            <div style={styles.header}>
                <h3>硬件设备</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <select
                        value={selectedPort}
                        onChange={(e) => setSelectedPort(e.target.value)}
                        style={{ padding: '5px', borderRadius: '4px', border: '1px solid #44475a', backgroundColor: '#44475a', color: 'white' }}
                    >
                        {ports.length === 0 && <option value="">未发现串口</option>}
                        {ports.map(p => (
                            <option key={p.port_name} value={p.port_name}>
                                {p.port_name} ({p.description})
                            </option>
                        ))}
                    </select>
                    <button onClick={refreshPorts} style={styles.iconBtn} title="刷新串口">🔄</button>
                </div>
                <div>
                    <button onClick={scanBoards} disabled={loading}>
                        {loading ? "处理中..." : "扫描开发板"}
                    </button>
                    <button onClick={runDemo} disabled={loading} style={{ marginLeft: '10px', backgroundColor: '#6272a4', color: 'white', border: 'none', padding: '5px 10px', borderRadius: '4px', cursor: 'pointer' }}>
                        ⚡ 测试编译引擎
                    </button>
                    <button onClick={runUpload} disabled={loading || !selectedPort} style={{ marginLeft: '10px', backgroundColor: '#50fa7b', color: '#282a36', border: 'none', padding: '5px 10px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
                        🔥 烧录
                    </button>
                </div>
            </div>
            <pre style={styles.body}>{boards}</pre>

            {/* Embed Serial Monitor if a port is known (even if not selected, but better if selected) */}
            {selectedPort && (
                <SerialMonitor />
            )}
        </div>
    );
};

const styles: { [key: string]: React.CSSProperties } = {
    container: {
        marginTop: '20px',
        padding: '10px',
        backgroundColor: '#282a36',
        color: '#f8f8f2',
        border: '1px solid #44475a',
        borderRadius: '8px',
        textAlign: 'left',
    },
    header: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '10px',
    },
    body: {
        backgroundColor: '#1e1f29',
        padding: '10px',
        borderRadius: '4px',
        overflowX: 'auto',
        fontSize: '12px',
    },
    iconBtn: {
        backgroundColor: 'transparent',
        border: 'none',
        cursor: 'pointer',
        fontSize: '16px',
    }
};
