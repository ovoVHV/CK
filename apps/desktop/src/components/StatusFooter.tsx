import React, { useEffect, useRef, useState } from 'react';
import { Activity, ArrowDown, Cpu, Loader2, Radio, Usb, Zap } from 'lucide-react';

interface StatusFooterProps {
    bytesReceivedRef: React.MutableRefObject<number>;
    linesReceivedRef: React.MutableRefObject<number>;
    baudRate: number;
    activePort: string | null;
    monitorPort: string | null;
    monitorBaudRate: number | null;
    isSerialMonitorOpen: boolean;
    isSerialMonitorSwitching: boolean;
    boardName: string;
}

export const StatusFooter = React.memo(({
    bytesReceivedRef,
    linesReceivedRef,
    baudRate,
    activePort,
    monitorPort,
    monitorBaudRate,
    isSerialMonitorOpen,
    isSerialMonitorSwitching,
    boardName,
}: StatusFooterProps) => {
    const [stats, setStats] = useState({ kbps: 0, lps: 0 });
    const [rxActive, setRxActive] = useState(false);
    const rxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        const interval = setInterval(() => {
            const bytes = bytesReceivedRef.current;
            const lines = linesReceivedRef.current;
            bytesReceivedRef.current = 0;
            linesReceivedRef.current = 0;

            const next = {
                kbps: Number((bytes / 1024).toFixed(1)),
                lps: lines,
            };
            setStats((previous) => previous.kbps === next.kbps && previous.lps === next.lps ? previous : next);

            if (bytes > 0) {
                setRxActive(true);
                if (rxTimerRef.current) clearTimeout(rxTimerRef.current);
                rxTimerRef.current = setTimeout(() => {
                    setRxActive(false);
                    rxTimerRef.current = null;
                }, 150);
            }
        }, 1000);
        return () => {
            clearInterval(interval);
            if (rxTimerRef.current) clearTimeout(rxTimerRef.current);
        };
    }, [bytesReceivedRef, linesReceivedRef]);

    useEffect(() => {
        if (!isSerialMonitorOpen) {
            bytesReceivedRef.current = 0;
            linesReceivedRef.current = 0;
            setStats({ kbps: 0, lps: 0 });
            setRxActive(false);
        }
    }, [bytesReceivedRef, isSerialMonitorOpen, linesReceivedRef]);

    const isMonitoring = isSerialMonitorOpen && Boolean(monitorPort) && monitorBaudRate !== null;

    return (
        <div className="h-7 bg-[#f8fafc] dark:bg-slate-900 border-t border-[#dce3ec] dark:border-slate-800 flex items-center px-3 text-[10px] justify-between shrink-0 select-none z-50 transition-colors duration-200">
            <div className="flex items-center min-w-0" title={`开发板: ${boardName}`}>
                <Cpu size={14} className="mr-1.5 shrink-0 text-slate-400 dark:text-slate-500" />
                <span className="font-bold text-slate-600 dark:text-slate-300 truncate max-w-[220px]">
                    {boardName || '未选择开发板'}
                </span>
            </div>

            <div className="flex items-center gap-3 min-w-0">
                {isMonitoring && (
                    <div className="hidden sm:flex items-center gap-3 text-slate-500 dark:text-slate-400">
                        <div className="flex items-center gap-1" title="串口接收状态">
                            <ArrowDown size={10} className={rxActive ? 'text-teal-500' : 'text-slate-300 dark:text-slate-600'} />
                            <span className={`w-1.5 h-1.5 rounded-full ${rxActive ? 'bg-teal-500' : 'bg-slate-300 dark:bg-slate-700'}`} />
                            <span className={rxActive ? 'font-mono font-bold text-teal-600 dark:text-teal-400' : 'font-mono font-bold'}>RX</span>
                        </div>
                        <div className="flex items-center gap-1 min-w-[62px]" title="接收速率">
                            <Activity size={10} />
                            <span className="font-mono tabular-nums">{stats.kbps.toFixed(1)} KB/s</span>
                        </div>
                        <div className="flex items-center gap-1 min-w-[42px]" title="每秒接收行数">
                            <Zap size={10} />
                            <span className="font-mono tabular-nums">{stats.lps} Hz</span>
                        </div>
                    </div>
                )}

                <div className="h-4 w-px bg-slate-200 dark:bg-slate-700" />
                {isSerialMonitorSwitching ? (
                    <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400" title={`${activePort || ''} @ ${baudRate}`}>
                        <Loader2 size={12} className="animate-spin" />
                        <span className="font-medium">正在应用串口设置</span>
                    </div>
                ) : isMonitoring ? (
                    <div className="flex items-center gap-1.5 text-teal-700 dark:text-teal-400" title="串口监视器已打开">
                        <Radio size={12} />
                        <span className="font-mono font-bold">{monitorPort}</span>
                        <span className="text-slate-300 dark:text-slate-700">|</span>
                        <span className="font-mono tabular-nums">{monitorBaudRate} baud</span>
                    </div>
                ) : activePort ? (
                    <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400" title={`已选择 ${baudRate} baud，串口监视器未打开`}>
                        <Usb size={12} />
                        <span className="font-mono font-bold">{activePort}</span>
                        <span>监视器未打开</span>
                    </div>
                ) : (
                    <div className="flex items-center gap-1.5 text-slate-400 dark:text-slate-500">
                        <Usb size={12} />
                        <span>未选择串口</span>
                    </div>
                )}
            </div>
        </div>
    );
});
