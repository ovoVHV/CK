import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { SerialMonitor } from './SerialMonitor';
import { useUiText } from '../i18n/uiText';

export const HardwarePanel: React.FC = () => {
    const { tr } = useUiText();
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
        setBoards(tr("正在扫描硬件... (初次运行可能需要下载工具链)", "Scanning hardware... (first run may download toolchain)"));
        try {
            const result = await invoke<string>("arduino_board_list");
            setBoards(result);
        } catch (e) {
            setBoards(`${tr("错误", "Error")}: ${e}`);
        } finally {
            setLoading(false);
        }
    };

    const runDemo = async () => {
        setLoading(true);
        setBoards(tr("正在初始化编译引擎...", "Initializing build engine..."));
        try {
            const result = await invoke<string>("verify_sketch_demo");
            setBoards(result);
        } catch (e) {
            setBoards(`${tr("编译错误", "Build error")}: ${e}`);
        } finally {
            setLoading(false);
        }
    };

    const runUpload = async () => {
        if (!selectedPort) {
            setBoards(tr("请先选择一个串口！", "Please select a serial port first."));
            return;
        }
        setLoading(true);
        setBoards(tr(`正在向 ${selectedPort} 烧录固件...`, `Uploading firmware to ${selectedPort}...`));
        try {
            const result = await invoke<string>("upload_sketch_demo", { port: selectedPort });
            setBoards(result);
        } catch (e) {
            setBoards(`${tr("烧录错误", "Upload error")}: ${e}`);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div style={styles.container}>
            <div style={styles.header}>
                <h3>{tr("硬件设备", "Hardware Devices")}</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <select
                        value={selectedPort}
                        onChange={(e) => setSelectedPort(e.target.value)}
                        style={{ padding: '5px', borderRadius: '4px', border: '1px solid #44475a', backgroundColor: '#44475a', color: 'white' }}
                    >
                        {ports.length === 0 && <option value="">{tr("未发现串口", "No serial ports found")}</option>}
                        {ports.map(p => (
                            <option key={p.port_name} value={p.port_name}>
                                {p.port_name} ({p.description})
                            </option>
                        ))}
                    </select>
                    <button onClick={refreshPorts} style={styles.iconBtn} title={tr("刷新串口", "Refresh serial ports")}>🔄</button>
                </div>
                <div>
                    <button onClick={scanBoards} disabled={loading}>
                        {loading ? tr("处理中...", "Working...") : tr("扫描开发板", "Scan Boards")}
                    </button>
                    <button onClick={runDemo} disabled={loading} style={{ marginLeft: '10px', backgroundColor: '#6272a4', color: 'white', border: 'none', padding: '5px 10px', borderRadius: '4px', cursor: 'pointer' }}>
                        ⚡ {tr("测试编译引擎", "Test Build Engine")}
                    </button>
                    <button onClick={runUpload} disabled={loading || !selectedPort} style={{ marginLeft: '10px', backgroundColor: '#50fa7b', color: '#282a36', border: 'none', padding: '5px 10px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
                        🔥 {tr("烧录", "Upload")}
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
