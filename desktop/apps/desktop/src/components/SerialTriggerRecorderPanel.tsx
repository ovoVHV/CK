import React, { useEffect, useMemo, useState } from 'react';
import {
    DEFAULT_SERIAL_TRIGGER_POST_WINDOW_MS,
    DEFAULT_SERIAL_TRIGGER_PRE_WINDOW_MS,
    MAX_SERIAL_TRIGGER_RECORDS,
    MAX_SERIAL_TRIGGER_WINDOW_MS,
    type SerialTriggerComparator,
    type SerialTriggerConfig,
    type SerialTriggerRecorderSummary,
} from '../services/serial_trigger_recorder';
import { useTranslation } from 'react-i18next';

export interface SerialTriggerChannelOption {
    channelId: string;
    label: string;
    color: string;
}

interface SerialTriggerRecorderPanelProps {
    channels: SerialTriggerChannelOption[];
    summary: SerialTriggerRecorderSummary;
    captureExported: boolean;
    serialPaused: boolean;
    onArm: (config: SerialTriggerConfig) => void;
    onCancel: () => void;
    onFreeze: () => void;
    onExport: () => void;
}

const COMPARATOR_LABELS: Record<SerialTriggerComparator, string> = {
    gt: '>',
    gte: '≥',
    lt: '<',
    lte: '≤',
    eq: '=',
    neq: '≠',
};

const STATE_LABEL_KEYS: Record<SerialTriggerRecorderSummary['state'], string> = {
    idle: 'trigger.state.idle',
    armed: 'trigger.state.armed',
    capturing: 'trigger.state.capturing',
    frozen: 'trigger.state.frozen',
};

const STATE_STYLES: Record<SerialTriggerRecorderSummary['state'], string> = {
    idle: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
    armed: 'bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300',
    capturing: 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
    frozen: 'bg-brand-50 text-brand-700 dark:bg-brand-950/50 dark:text-brand-300',
};

const toSecondsText = (milliseconds: number): string => String(milliseconds / 1_000);

export const SerialTriggerRecorderPanel: React.FC<SerialTriggerRecorderPanelProps> = ({
    channels,
    summary,
    captureExported,
    serialPaused,
    onArm,
    onCancel,
    onFreeze,
    onExport,
}) => {
    const { t: translate } = useTranslation('serial');
    const t = translate as unknown as (key: string, options?: Record<string, unknown>) => string;
    const [expanded, setExpanded] = useState(false);
    const [selectedChannelId, setSelectedChannelId] = useState('');
    const [comparator, setComparator] = useState<SerialTriggerComparator>('gt');
    const [thresholdText, setThresholdText] = useState('60');
    const [preSecondsText, setPreSecondsText] = useState(
        toSecondsText(DEFAULT_SERIAL_TRIGGER_PRE_WINDOW_MS),
    );
    const [postSecondsText, setPostSecondsText] = useState(
        toSecondsText(DEFAULT_SERIAL_TRIGGER_POST_WINDOW_MS),
    );

    useEffect(() => {
        if (channels.length === 0) {
            setSelectedChannelId('');
            return;
        }
        if (!channels.some((channel) => channel.channelId === selectedChannelId)) {
            setSelectedChannelId(channels[0].channelId);
        }
    }, [channels, selectedChannelId]);

    useEffect(() => {
        if (summary.state === 'capturing' || summary.state === 'frozen') setExpanded(true);
    }, [summary.state]);

    const draftConfig = useMemo<SerialTriggerConfig | null>(() => {
        const threshold = Number(thresholdText);
        const preSeconds = Number(preSecondsText);
        const postSeconds = Number(postSecondsText);
        if (
            !selectedChannelId
            || thresholdText.trim() === ''
            || preSecondsText.trim() === ''
            || postSecondsText.trim() === ''
            || !Number.isFinite(threshold)
            || !Number.isFinite(preSeconds)
            || !Number.isFinite(postSeconds)
            || preSeconds < 0
            || postSeconds < 0
            || preSeconds * 1_000 > MAX_SERIAL_TRIGGER_WINDOW_MS
            || postSeconds * 1_000 > MAX_SERIAL_TRIGGER_WINDOW_MS
        ) {
            return null;
        }

        return {
            channelId: selectedChannelId,
            comparator,
            threshold,
            preWindowMs: preSeconds * 1_000,
            postWindowMs: postSeconds * 1_000,
        };
    }, [comparator, postSecondsText, preSecondsText, selectedChannelId, thresholdText]);

    const activeConfig = summary.config;
    const activeChannelLabel = activeConfig
        ? channels.find((channel) => channel.channelId === activeConfig.channelId)?.label
            || activeConfig.legacyChannel
            || activeConfig.channelId
        : '';
    const isLocked = summary.state !== 'idle';
    const statusDetail = (() => {
        if (!activeConfig) return t('trigger.configureHint');
        const condition = `${activeChannelLabel} ${COMPARATOR_LABELS[activeConfig.comparator]} ${activeConfig.threshold}`;
        if (summary.state === 'armed') return t('trigger.armedDetail', { condition });
        if (summary.state === 'capturing') {
            return t('trigger.capturingDetail', { label: activeChannelLabel, value: summary.triggerValue, count: summary.bufferedRecords });
        }
        if (summary.state === 'frozen') {
            const before = summary.triggerIndex ?? 0;
            const after = Math.max(0, summary.bufferedRecords - before - 1);
            return t('trigger.frozenDetail', { count: summary.bufferedRecords, before, after });
        }
        return t('trigger.configureHint');
    })();

    const arm = () => {
        if (draftConfig) onArm(draftConfig);
    };

    return (
        <section
            className="shrink-0 min-w-0 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-800/40"
            data-ck-role="serial-trigger-recorder"
            data-ck-trigger-state={summary.state}
        >
            <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                className="w-full min-w-0 h-8 px-2.5 flex items-center gap-2 text-left hover:bg-slate-100/80 dark:hover:bg-slate-800 rounded-lg"
                aria-expanded={expanded}
                data-ck-action="toggle-serial-trigger-recorder"
            >
                <svg className="w-3.5 h-3.5 shrink-0 text-brand-600 dark:text-brand-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 12h3l2-6 4 12 2-6h5" />
                </svg>
                <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200 whitespace-nowrap">{t('trigger.title')}</span>
                <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold whitespace-nowrap ${STATE_STYLES[summary.state]}`}>
                    {t(STATE_LABEL_KEYS[summary.state])}
                </span>
                {summary.state === 'frozen' && (
                    <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold whitespace-nowrap ${captureExported
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                        : 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300'}`}>
                        {captureExported ? t('trigger.exported') : t('trigger.notExported')}
                    </span>
                )}
                <span className="min-w-0 truncate text-[9px] text-slate-400 dark:text-slate-500">{statusDetail}</span>
                <svg
                    className={`ml-auto w-3.5 h-3.5 shrink-0 text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 9l6 6 6-6" />
                </svg>
            </button>

            {expanded && (
                <div className="border-t border-slate-200 dark:border-slate-700 px-2.5 py-2 flex flex-col gap-2">
                    <div className="min-w-0 flex flex-wrap items-end gap-1.5">
                        <label className="min-w-[112px] flex-1 text-[9px] font-semibold text-slate-500 dark:text-slate-400">
                            {t('trigger.series')}
                            <select
                                value={selectedChannelId}
                                onChange={(event) => setSelectedChannelId(event.target.value)}
                                disabled={isLocked || channels.length === 0}
                                className="mt-0.5 w-full h-7 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 text-[10px] text-slate-700 dark:text-slate-200 disabled:opacity-50"
                                data-ck-field="trigger-channel"
                            >
                                {channels.length === 0 && <option value="">{t('trigger.waitingSeries')}</option>}
                                {channels.map((channel) => (
                                    <option key={channel.channelId} value={channel.channelId}>{channel.label}</option>
                                ))}
                            </select>
                        </label>

                        <label className="w-[62px] text-[9px] font-semibold text-slate-500 dark:text-slate-400">
                            {t('trigger.comparator')}
                            <select
                                value={comparator}
                                onChange={(event) => setComparator(event.target.value as SerialTriggerComparator)}
                                disabled={isLocked}
                                className="mt-0.5 w-full h-7 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 text-[11px] text-slate-700 dark:text-slate-200 disabled:opacity-50"
                                data-ck-field="trigger-comparator"
                            >
                                {Object.entries(COMPARATOR_LABELS).map(([value, label]) => (
                                    <option key={value} value={value}>{label}</option>
                                ))}
                            </select>
                        </label>

                        <label className="w-[92px] text-[9px] font-semibold text-slate-500 dark:text-slate-400">
                            {t('trigger.threshold')}
                            <input
                                type="number"
                                value={thresholdText}
                                onChange={(event) => setThresholdText(event.target.value)}
                                disabled={isLocked}
                                className="mt-0.5 w-full h-7 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 text-[10px] font-mono text-slate-700 dark:text-slate-200 disabled:opacity-50"
                                data-ck-field="trigger-threshold"
                            />
                        </label>

                        <label className="w-[82px] text-[9px] font-semibold text-slate-500 dark:text-slate-400">
                            {t('trigger.beforeSeconds')}
                            <input
                                type="number"
                                min="0"
                                max={MAX_SERIAL_TRIGGER_WINDOW_MS / 1_000}
                                step="0.5"
                                value={preSecondsText}
                                onChange={(event) => setPreSecondsText(event.target.value)}
                                disabled={isLocked}
                                className="mt-0.5 w-full h-7 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 text-[10px] font-mono text-slate-700 dark:text-slate-200 disabled:opacity-50"
                                data-ck-field="trigger-pre-seconds"
                            />
                        </label>

                        <label className="w-[82px] text-[9px] font-semibold text-slate-500 dark:text-slate-400">
                            {t('trigger.afterSeconds')}
                            <input
                                type="number"
                                min="0"
                                max={MAX_SERIAL_TRIGGER_WINDOW_MS / 1_000}
                                step="0.5"
                                value={postSecondsText}
                                onChange={(event) => setPostSecondsText(event.target.value)}
                                disabled={isLocked}
                                className="mt-0.5 w-full h-7 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 text-[10px] font-mono text-slate-700 dark:text-slate-200 disabled:opacity-50"
                                data-ck-field="trigger-post-seconds"
                            />
                        </label>

                        <div className="flex items-center gap-1.5 ml-auto">
                            {summary.state === 'idle' && (
                                <button
                                    type="button"
                                    onClick={arm}
                                    disabled={!draftConfig}
                                    className="h-7 px-2.5 rounded-md bg-brand-600 text-[10px] font-semibold text-white hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed"
                                    data-ck-action="arm-serial-trigger"
                                >
                                    {t('trigger.startWaiting')}
                                </button>
                            )}
                            {summary.state === 'armed' && (
                                <button
                                    type="button"
                                    onClick={onCancel}
                                    className="h-7 px-2.5 rounded-md border border-slate-300 dark:border-slate-600 text-[10px] font-semibold text-slate-600 dark:text-slate-300 hover:border-red-300 hover:text-red-600"
                                    data-ck-action="cancel-serial-trigger"
                                >
                                    {t('trigger.cancelWaiting')}
                                </button>
                            )}
                            {summary.state === 'capturing' && (
                                <button
                                    type="button"
                                    onClick={onFreeze}
                                    className="h-7 px-2.5 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 text-[10px] font-semibold text-amber-700 dark:text-amber-300"
                                    data-ck-action="freeze-serial-trigger"
                                >
                                    {t('trigger.freezeNow')}
                                </button>
                            )}
                            {summary.state === 'frozen' && (
                                <>
                                    <button
                                        type="button"
                                        onClick={onExport}
                                        className="h-7 px-2.5 rounded-md bg-brand-600 text-[10px] font-semibold text-white hover:bg-brand-700"
                                        data-ck-action="export-serial-trigger"
                                    >
                                        {t('export.csv')}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={arm}
                                        disabled={!draftConfig}
                                        className="h-7 px-2 rounded-md border border-slate-300 dark:border-slate-600 text-[10px] font-semibold text-slate-600 dark:text-slate-300 disabled:opacity-40"
                                        data-ck-action="rearm-serial-trigger"
                                    >
                                        {t('trigger.rearm')}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={onCancel}
                                        className="h-7 px-2 rounded-md border border-slate-300 dark:border-slate-600 text-[10px] font-semibold text-slate-600 dark:text-slate-300"
                                        data-ck-action="finish-serial-trigger"
                                    >
                                        {t('trigger.end')}
                                    </button>
                                </>
                            )}
                        </div>
                    </div>

                    <div className="min-w-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[9px] text-slate-500 dark:text-slate-400" aria-live="polite">
                        <span>{statusDetail}</span>
                        <span>{t('trigger.limits', { records: MAX_SERIAL_TRIGGER_RECORDS, seconds: MAX_SERIAL_TRIGGER_WINDOW_MS / 1_000 })}</span>
                        {summary.truncated && (
                            <span className="font-semibold text-amber-700 dark:text-amber-300">
                                {t('trigger.truncated')}
                            </span>
                        )}
                        {serialPaused && (summary.state === 'armed' || summary.state === 'capturing') && (
                            <span className="font-semibold text-amber-700 dark:text-amber-300">
                                {t('trigger.serialPaused')}
                            </span>
                        )}
                    </div>

                    <div className="rounded-md bg-blue-50/80 dark:bg-blue-950/30 px-2 py-1 text-[9px] text-blue-700 dark:text-blue-300">
                        {t('trigger.explanation')}
                    </div>
                </div>
            )}
        </section>
    );
};
