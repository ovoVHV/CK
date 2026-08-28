import React, { useEffect, useRef } from 'react';
import { useLogs } from '../hooks/useLogs';

export const LogPanel: React.FC = () => {
    const { logs, clearLogs } = useLogs();
    const bottomRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [logs]);

    return (
        <div style={styles.container}>
            <div style={styles.header}>
                <h3>系统日志</h3>
                <button onClick={clearLogs}>清空</button>
            </div>
            <div style={styles.logBody}>
                {logs.map((log, index) => (
                    <div key={index} style={styles.logEntry}>
                        <span style={getLevelStyle(log.level)}>[{log.level}]</span>
                        <span style={styles.timestamp}>{new Date(log.timestamp).toLocaleTimeString()}</span>
                        <span>{log.message}</span>
                    </div>
                ))}
                <div ref={bottomRef} />
            </div>
        </div>
    );
};

const getLevelStyle = (level: string): React.CSSProperties => {
    switch (level.toUpperCase()) {
        case 'ERROR': return { color: '#f87171', fontWeight: 'bold' };
        case 'WARN': return { color: '#fbbf24', fontWeight: 'bold' };
        case 'INFO': return { color: '#38bdf8', fontWeight: 'bold' };
        case 'DEBUG': return { color: '#64748b' };
        default: return { color: '#e2e8f0' };
    }
};

const styles: { [key: string]: React.CSSProperties } = {
    container: {
        display: 'flex',
        flexDirection: 'column',
        height: '300px',
        borderTop: '1px solid #293548',
        backgroundColor: '#0b1220',
        color: '#e2e8f0',
        fontFamily: 'ui-monospace, "Cascadia Code", Consolas, Menlo, monospace',
        fontSize: '12px',
        fontVariantNumeric: 'tabular-nums',
    },
    header: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '4px 10px',
        backgroundColor: '#111827',
        borderBottom: '1px solid #293548',
        color: '#94a3b8',
        fontSize: '11px',
        fontWeight: 'bold',
        letterSpacing: '0.02em',
    },
    logBody: {
        flex: 1,
        overflowY: 'auto',
        padding: '8px 10px',
        lineHeight: 1.6,
    },
    logEntry: {
        marginBottom: '2px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
    },
    timestamp: {
        color: '#64748b',
        margin: '0 8px',
    },
};
