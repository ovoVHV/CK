import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

export interface LogEvent {
    level: string;
    message: string;
    timestamp: string;
    target: string;
}

export function useLogs() {
    const [logs, setLogs] = useState<LogEvent[]>([]);

    useEffect(() => {
        // Listen for 'log://stream' events from Rust
        const unlisten = listen<LogEvent>('log://stream', (event) => {
            setLogs((prev) => [...prev, event.payload]);
        });

        return () => {
            unlisten.then((f) => f());
        };
    }, []);

    const clearLogs = () => {
        setLogs([]);
    };

    return { logs, clearLogs };
}
