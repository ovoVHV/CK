import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AgentLlmDeltaPayload, AgentGlmChatResult } from '../types/agent';
import type { AiTransport } from './ai_assistant_runtime';

export const requestAiModel: AiTransport = async (request, onText, signal) => {
    signal.throwIfAborted();
    const unlisten = await listen<AgentLlmDeltaPayload>('agent-llm-delta', event => {
        if (!signal.aborted && event.payload.runId === request.runId && event.payload.delta) onText(event.payload.delta);
    });
    let cancel: () => void = () => {};
    try {
        signal.throwIfAborted();
        const stopped = new Promise<never>((_, reject) => {
            cancel = () => {
                void invoke('cancel_glm_stream', { runId: request.runId }).catch(() => {});
                reject(new DOMException('请求已取消', 'AbortError'));
            };
            signal.addEventListener('abort', cancel, { once: true });
        });
        return await Promise.race([invoke<AgentGlmChatResult>('chat_with_glm_stream', { req: request }), stopped]);
    } finally { signal.removeEventListener('abort', cancel); unlisten(); }
};
