import type { AiAttachment } from './ai_attachments';
import { invoke } from '@tauri-apps/api/core';
import { DEFAULT_AI_CONTEXT, type AiContextSettings, type AiChatMessage, type AiMemory } from './ai_context';
import type { AiConnection } from './ai_assistant_runtime';
import type { AiTaskCheckpoint } from './ai_task_checkpoint';

export interface AiPreferences extends AiConnection, AiContextSettings { rememberKey: boolean; autoApply: boolean; reasoningEffort: string; reasoningProtocol: string; modelChoices: string[] }
export interface AiChat { schemaVersion: 1; id: string; projectKey: string; title: string; updatedAt: number; revision: number; messages: AiChatMessage[]; memory?: AiMemory; draft: string; draftAttachments?: AiAttachment[]; task?: AiTaskCheckpoint; taskError?: string }
export interface AiChatListEntry { id: string; title: string; updatedAt: number; messages: number }
export const DEFAULT_AI_PREFERENCES: AiPreferences = { baseUrl: '', model: '', apiKey: '', apiProtocol:'chat', rememberKey: true, autoApply: true, reasoningEffort: 'auto', reasoningProtocol: 'auto', modelChoices: [], ...DEFAULT_AI_CONTEXT };
export const newAiChat = (projectKey: string): AiChat => ({ schemaVersion: 1, id: crypto.randomUUID(), projectKey, title: '新聊天', updatedAt: Date.now(), revision: 0, messages: [], draft: '' });
export const loadAiPreferences = () => invoke<AiPreferences | null>('ai_load_preferences');
export const saveAiPreferences = (value: AiPreferences) => invoke<void>('ai_save_preferences', { value });
export const listAiChats = (projectKey: string) => invoke<{ chats: AiChatListEntry[]; unreadable: number }>('ai_list_chats', { projectKey });
export const loadAiChat = (id: string, projectKey: string) => invoke<AiChat>('ai_load_chat', { id, projectKey });
export const deleteAiChat = (chat: AiChat) => invoke<void>('ai_delete_chat', { id: chat.id, projectKey: chat.projectKey, revision: chat.revision });

// Serialize writes for a chat, including drafts arriving while the previous IPC
// is in flight. Revision checks also prevent overwrites from another window.
export class AiChatWriter {
    private queue: Promise<void> = Promise.resolve();
    private revisions = new Map<string, number>();
    private failed: unknown;
    constructor(private write = (value: AiChat) => invoke<number>('ai_save_chat', { value })) {}
    remember(chat: AiChat) { this.revisions.set(chat.id, chat.revision); }
    save(chat: AiChat) {
        const copy = structuredClone(chat);
        const action = this.queue.then(async () => {
            if (this.failed) throw this.failed;
            try {
                copy.revision = this.revisions.get(copy.id) ?? copy.revision;
                const revision = await this.write(copy); this.revisions.set(copy.id, revision);
            } catch (error) { this.failed = error; throw error; }
        });
        this.queue = action.catch(() => {});
        return action;
    }
    async flush() { await this.queue; if (this.failed) throw this.failed; }
    revision(id: string) { return this.revisions.get(id) ?? 0; }
}
