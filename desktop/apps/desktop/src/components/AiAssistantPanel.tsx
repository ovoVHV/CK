import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AI_ATTACHMENT_ACCEPT, aiAttachmentBytes, importAiAttachment, validateAiAttachments, type AiAttachment } from '../services/ai_attachments';
import * as Blockly from 'blockly';
import { ArrowUp, ArrowLeft, Check, ChevronDown, ChevronRight, CircleAlert, CircuitBoard, Code2, Loader2, MessageSquare, Plus, Settings2, Sparkles, Square, Undo2, X, History, Pencil, Trash2, Paperclip, FileText, FolderOpen, Copy } from 'lucide-react';
import { applyAiPreview, aiWorkspaceSnapshot, type AiPreview } from '../services/ai_workspace';
import { runAiTask, validateAiConnection, AiPrivacyFilter, type AiHost, type AiIntent } from '../services/ai_assistant_runtime';
import { requestAiModel } from '../services/ai_transport';
import type { AiTaskProgress, AiValidationRecord } from '../services/ai_candidate';
import type { AiLibraryPreview } from '../services/ai_library_authoring';
import { aiRequirementStatus, type AiAcceptance, type AiBehaviorResult } from '../services/ai_acceptance';
import type { AiTaskCheckpoint } from '../services/ai_task_checkpoint';
import { validateAiContext, type AiMemory, type AiUsage, type AiChatMessage } from '../services/ai_context';
import { DEFAULT_AI_PREFERENCES, AiChatWriter, newAiChat, loadAiPreferences, saveAiPreferences, listAiChats, loadAiChat, deleteAiChat, type AiPreferences, type AiChat, type AiChatListEntry } from '../services/ai_chat_store';
import './AiAssistantPanel.css';

export interface AiAssistantPanelProps {
    open: boolean;
    intent: AiIntent;
    sessionKey: string;
    projectKey: string;
    projectPath?: string;
    host: AiHost;
    boardLabel: string;
    disabledReason?: string;
    onClose: () => void;
    onCode: () => void;
    onLayout: () => void;
    beforeApply: () => Promise<unknown>;
    onCompile: () => Promise<{ ok: boolean; log: string }>;
}
const SETTINGS_KEY = 'ck_ai_connection_v1';
// Credentials persist only through the native current-user encrypted store.
let sessionConnection: AiPreferences = { ...DEFAULT_AI_PREFERENCES };
function readConnection() {
    try {
        const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        return { ...sessionConnection, baseUrl: sessionConnection.baseUrl || String(saved.baseUrl || ''), model: sessionConnection.model || String(saved.model || '') };
    } catch { return { ...sessionConnection }; }
}
const reasonText = (error: unknown) => error instanceof Error ? error.message : String(error);
const modeLabel = { generate: '搭建积木', edit: '修改积木', explain: '解释积木', repair: '修复报错', library: '制作积木库' };

export function AiAssistantPanel(props: AiAssistantPanelProps) {
    const latest = useRef(props); latest.current = props;
    const [connection, setConnection] = useState<AiPreferences>(readConnection);
    const [preferencesReady, setPreferencesReady] = useState(false);
    const [savingSettings, setSavingSettings] = useState(false);
    const [settings, setSettings] = useState(false);
    const [draft, setDraft] = useState('');
    const [attachments, setAttachments] = useState<AiAttachment[]>([]);
    const [importing, setImporting] = useState(false);
    const [loadingModels, setLoadingModels] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);
    const importGeneration = useRef(0);
    const projectPath = props.projectKey.startsWith('file:') ? (props.projectPath || props.projectKey.slice(5)).replace(/^\\\\\?\\/, '') : '尚未保存 · 当前工程';
    const deepseek = connection.reasoningProtocol === 'deepseek' || (connection.reasoningProtocol === 'auto' && (()=>{try{return new URL(connection.baseUrl).hostname==='api.deepseek.com';}catch{return false;}})());
    const efforts = deepseek ? [['auto','模型默认'],['none','关闭思考'],['low','低'],['high','高'],['max','最高']] : [['auto','模型默认'],['none','关闭思考'],['low','低'],['medium','中'],['high','高'],['max','最高（需API支持）']];
    const [messages, setMessages] = useState<AiChatMessage[]>([]);
    const [chat, setChat] = useState<AiChat>(() => newAiChat(props.projectKey));
    const [memory, setMemory] = useState<AiMemory>();
    const [usage, setUsage] = useState<AiUsage>();
    const [historyOpen, setHistoryOpen] = useState(false);
    const [chatList, setChatList] = useState<AiChatListEntry[]>([]);
    const [storeReady, setStoreReady] = useState(false);
    const [storeStatus, setStoreStatus] = useState('正在读取聊天');
    const [storeError, setStoreError] = useState('');
    const [chatAction, setChatAction] = useState(false);
    const [deleteId, setDeleteId] = useState('');
    const [renameId, setRenameId] = useState('');
    const [renameTitle, setRenameTitle] = useState('');
    const [visibleMessages, setVisibleMessages] = useState(80);
    const [intent, setIntent] = useState(props.intent);
    const [stream, setStream] = useState('');
    const [step, setStep] = useState('');
    const [busy, setBusy] = useState(false);
    const [stopping, setStopping] = useState(false);
    const [plan, setPlan] = useState<string[]>([]);
    const [progress, setProgress] = useState<AiTaskProgress[]>([]);
    const [validations, setValidations] = useState<AiValidationRecord[]>([]);
    const [acceptance, setAcceptance] = useState<AiAcceptance>();
    const [behavior, setBehavior] = useState<AiBehaviorResult>();
    const [task, setTask] = useState<AiTaskCheckpoint>();
    const [applying, setApplying] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [preview, setPreview] = useState<AiPreview>();
    const [libraryPreview, setLibraryPreview] = useState<AiLibraryPreview>();
    const [libraryLoaded, setLibraryLoaded] = useState(false);
    const pendingLibrary = useRef(libraryPreview); pendingLibrary.current = libraryPreview;
    const [autoInstallLibrary, setAutoInstallLibrary] = useState(true);
    const libraryIdentity = useRef('');
    const [expanded, setExpanded] = useState(false);
    const [stale, setStale] = useState(false);
    const [undoState, setUndoState] = useState<string>();
    const [drawer, setDrawer] = useState(false);
    const [available, setAvailable] = useState(1200);
    const [availableHeight, setAvailableHeight] = useState(600);
    const compact = availableHeight < 560;
    const panel = useRef<HTMLElement>(null);
    const input = useRef<HTMLTextAreaElement>(null);
    const scroll = useRef<HTMLDivElement>(null);
    const follow = useRef(true);
    const request = useRef<AbortController | null>(null);
    const mount = useRef(true);
    const working = useRef(false);
    const undoEvent = useRef<Blockly.Events.Abstract | null>(null);
    const planIdentity = useRef('');
    const originFocus = useRef<HTMLElement | null>(null);
    const scope = useRef(intent); scope.current = intent;
    const pending = useRef(preview); pending.current = preview;
    const canConnect = Boolean(connection.baseUrl && connection.model && connection.apiKey);
    const writer = useRef(new AiChatWriter());
    const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const pendingSave = useRef<AiChat | undefined>(undefined);
    const chatRef = useRef(chat);
    chatRef.current = { ...chat, messages, memory, draft, draftAttachments: attachments, task };
    const flushChat = async () => {
        clearTimeout(saveTimer.current);
        const value = pendingSave.current; pendingSave.current = undefined;
        if (value) await writer.current.save(value);
        await writer.current.flush();
    };
    const adoptChat = (value: AiChat) => {
        importGeneration.current++; setAttachments(value.draftAttachments || []); setImporting(false);
        setLibraryPreview(undefined); setLibraryLoaded(false);
        setProgress([]); setPlan([]); setValidations([]);
        setTask(value.task); setAcceptance(value.task?.acceptance); setBehavior(undefined);
        writer.current.remember(value); chatRef.current = value;
        setChat(value); setMessages(value.messages); setMemory(value.memory || undefined); setDraft(value.draft || '');
        setPreview(undefined); setUndoState(undefined); undoEvent.current = null;
        setUsage(undefined); setStream(''); setError(''); setNotice(value.taskError || ''); setVisibleMessages(80);
        setStoreError(''); setStoreStatus(value.revision ? '已保存到本机' : '新聊天');
        follow.current = true;
    };
    const refreshChats = async (projectKey = props.projectKey) => {
        const result = await listAiChats(projectKey);
        if (latest.current.projectKey !== projectKey) return;
        setChatList(result.chats);
        if (result.unreadable) setNotice(`有 ${result.unreadable} 份聊天记录无法读取，原文件已保留；可继续使用当前聊天。`);
    };

    useEffect(() => {
        let cancelled = false;
        loadAiPreferences().then(value => { if (!cancelled) { if (value) { sessionConnection = { ...DEFAULT_AI_PREFERENCES, ...value, apiKey: value.apiKey || sessionConnection.apiKey }; setConnection(sessionConnection); } setPreferencesReady(true); } })
            .catch(cause => { if (!cancelled) { setError('读取全局设置失败：' + reasonText(cause)); setPreferencesReady(true); } });
        return () => { cancelled = true; };
    }, []);
    useEffect(() => {
        let cancelled = false;
        request.current?.abort(); request.current = null; setBusy(false); setStoreReady(false); setHistoryOpen(false);
        setMessages([]); setDraft(''); setMemory(undefined); setPreview(undefined); setStoreStatus('正在读取聊天');
        void (async () => {
            try {
                await flushChat();
                const result = await listAiChats(props.projectKey);
                const value = result.chats.length ? await loadAiChat(result.chats[0].id, props.projectKey) : newAiChat(props.projectKey);
                if (cancelled) return;
                writer.current = new AiChatWriter(); adoptChat(value); setChatList(result.chats); setStoreReady(true);
                if (result.unreadable) setNotice(`有 ${result.unreadable} 份聊天无法读取，原文件保留；可继续使用当前聊天。`);
            } catch (cause) { if (!cancelled) setStoreError(reasonText(cause)); }
        })();
        return () => { cancelled = true; };
    }, [props.projectKey]);
    useEffect(() => {
        if (!storeReady || chat.projectKey !== props.projectKey || (!messages.length && !draft && !attachments.length && !chat.revision && !writer.current.revision(chat.id))) return;
        const value = { ...chatRef.current, updatedAt: Date.now(), draft: connection.apiKey ? draft.split(connection.apiKey).join('[已隐藏 API 密钥]') : draft };
        pendingSave.current = value; setStoreStatus('正在保存…'); clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
            if (pendingSave.current !== value) return;
            pendingSave.current = undefined;
            void writer.current.save(value).then(() => { if (chatRef.current.id === value.id) setStoreStatus('已保存到本机'); })
                .catch(cause => { if (mount.current) { setStoreError(reasonText(cause)); setStoreStatus('保存失败'); } });
        }, 350);
    }, [messages, draft, attachments, memory, task, chat.title, chat.id, storeReady, props.projectKey]);
    useEffect(() => () => { void flushChat().catch(() => {}); }, []);

    useEffect(() => { mount.current = true; return () => { mount.current = false; request.current?.abort(); }; }, []);
    useEffect(() => {
        const token = libraryPreview?.token, host = props.host.library;
        return () => { if (token && host) void host.discard(token).catch(() => undefined); };
    }, [libraryPreview?.token]);
    useEffect(() => { setLibraryPreview(undefined); setLibraryLoaded(false); }, [props.sessionKey]);
    useEffect(() => {
        if (props.open) return;
        request.current?.abort();
        // Keep the request busy until native compilation/installation settles.
        // Reopening the panel must not race a still-running rollback.
        setStream('');
    }, [props.open]);
    useEffect(() => {
        if (request.current) { request.current.abort(); setStopping(true); }
        importGeneration.current++; setAttachments([]); setImporting(false);
        setPreview(undefined); setStream(''); setError(''); setNotice(''); setUndoState(undefined); undoEvent.current = null;
    }, [props.sessionKey]);
    useEffect(() => {
        if (!props.open) return;
        originFocus.current = document.activeElement as HTMLElement;
        const timer = setTimeout(() => input.current?.focus(), 0);
        return () => { clearTimeout(timer); if (originFocus.current?.isConnected) originFocus.current.focus(); };
    }, [props.open]);
    useEffect(() => {
        if (!props.open) return;
        setIntent(props.intent);
        if (request.current) { request.current.abort(); setStopping(true); }
        setPreview(undefined); setStream(''); setError('');
        if (props.intent.kind === 'repair') setDraft('请分析这次编译错误，说明原因，并给出尽量小的积木修改方案。');
        else if (props.intent.kind === 'explain') setDraft('请解释选中的积木及其输入，说明执行顺序和用途。');
        else if (props.intent.kind === 'edit') setDraft('');
    }, [props.intent.id]);
    useEffect(() => {
        const workspace = props.host.workspace();
        if (!workspace) return;
        const changed = (event: Blockly.Events.Abstract) => {
            if (event.isUiEvent || working.current) return;
            if (pending.current) setStale(props.host.identity() !== planIdentity.current || aiWorkspaceSnapshot(workspace) !== pending.current.before);
            setUndoState(current => current && current === aiWorkspaceSnapshot(workspace) ? current : undefined);
        };
        if (pending.current) setStale(props.host.identity() !== planIdentity.current || aiWorkspaceSnapshot(workspace) !== pending.current.before);
        workspace.addChangeListener(changed);
        return () => workspace.removeChangeListener(changed);
    }, [props.host, props.sessionKey]);
    useLayoutEffect(() => {
        if (!props.open) return;
        const parent = panel.current?.parentElement;
        if (!parent) return;
        const resize = () => { setDrawer(parent.clientWidth < 980); setAvailable(parent.clientWidth); setAvailableHeight(parent.clientHeight); latest.current.onLayout(); };
        const observer = new ResizeObserver(resize); observer.observe(parent); resize();
        return () => observer.disconnect();
    }, [props.open]);
    useLayoutEffect(() => { props.onLayout(); }, [props.open, drawer]);
    useLayoutEffect(() => {
        const textarea = input.current;
        if (!textarea || !props.open || settings || historyOpen) return;
        // Grow only with the draft, then scroll inside the capped input. Reading
        // the CSS limits also respects the shorter layout above an open console.
        const style = getComputedStyle(textarea);
        const minimum = parseFloat(style.minHeight);
        const maximum = parseFloat(style.maxHeight);
        textarea.style.height = '0px';
        const contentHeight = textarea.scrollHeight;
        textarea.style.height = `${Math.max(minimum, Math.min(maximum, contentHeight))}px`;
        textarea.style.overflowY = contentHeight > maximum ? 'auto' : 'hidden';
    }, [draft, props.open, settings, historyOpen, available, availableHeight]);
    useEffect(() => {
        if (follow.current && scroll.current) scroll.current.scrollTop = messages.length || preview || error || notice ? scroll.current.scrollHeight : 0;
    }, [messages, stream, step, preview, expanded, error, notice]);

    const stop = () => {
        request.current?.abort(); setStopping(true);
        setStream(''); setStep('正在停止模型请求和候选编译…');
    };
    const startTask = (kind: AiIntent['kind'], prompt = '') => {
        if (busy || applying) return;
        setIntent({ id: Date.now(), kind });
        setDraft(prompt); setPreview(undefined); setLibraryPreview(undefined); setLibraryLoaded(false); setError(''); setNotice('');
        input.current?.focus();
    };
    const addAttachments = async (files: File[]) => {
        if (!files.length || importing || busy || applying) return;
        const generation = ++importGeneration.current, session = latest.current.sessionKey, chatId = chatRef.current.id;
        setImporting(true);setError('');
        try {
            if (files.length + attachments.length > 4) throw Error('每条消息最多附加 4 个文件');
            const imported = await Promise.all(files.map(importAiAttachment));
            if (!mount.current || generation !== importGeneration.current || session !== latest.current.sessionKey || chatId !== chatRef.current.id) return;
            const combined=validateAiAttachments([...attachments, ...imported]);
            if(aiAttachmentBytes(messages.flatMap(m=>m.attachments||[]))+2*aiAttachmentBytes(combined)>8*1024*1024) throw Error('这份聊天的附件接近上限，请新建聊天后添加；已有附件保留。');
            setAttachments(combined);
        } catch(cause) { if (generation===importGeneration.current && mount.current) setError(reasonText(cause)); }
        finally { if (generation===importGeneration.current && mount.current) setImporting(false); }
    };
    const updateControls = async (patch: Partial<AiPreferences>) => {
        if (busy || applying || savingSettings || !preferencesReady) return;
        setSavingSettings(true);setError('');
        const value={...connection,...patch};
        try {await saveAiPreferences(value);sessionConnection=value;setConnection(value);}
        catch(cause){setError('设置未保存：'+reasonText(cause));}
        finally{setSavingSettings(false);}
    };
    const fetchModels = async () => {
        if (loadingModels) return;setLoadingModels(true);setError('');
        const base=connection.baseUrl, key=connection.apiKey;
        try {const models=await invoke<string[]>('ai_list_models',{baseUrl:base,apiKey:key});
            setConnection(old=>old.baseUrl===base&&old.apiKey===key?{...old,modelChoices:models,model:old.model||models[0]}:old);
        } catch(cause){setError(reasonText(cause));}finally{if(mount.current)setLoadingModels(false);}
    };
    const commitPreview = async (candidate: AiPreview, identity: string, session: string, automatic: boolean, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        if (session!==latest.current.sessionKey || latest.current.disabledReason || identity!==latest.current.host.identity()) throw Error('工程状态已变化，未应用方案');
        await latest.current.beforeApply();
        signal?.throwIfAborted();
        if (!mount.current || session!==latest.current.sessionKey || latest.current.disabledReason || identity!==latest.current.host.identity()) throw Error('工程状态已变化，未应用方案');
        const workspace=latest.current.host.workspace(); if (!workspace) throw Error('工作区已关闭');
        working.current=true;
        try {undoEvent.current=applyAiPreview(workspace,candidate);}
        finally {working.current=false;}
        setPreview(undefined);setTask(undefined);setUndoState(aiWorkspaceSnapshot(workspace));
        setMessages(old=>[...old,{id:crypto.randomUUID(),role:'assistant',text:`操作记录：${automatic?'AI 已自动应用':'用户已确认应用'}本次修改。新增 ${candidate.added} · 修改 ${candidate.changed} · 删除 ${candidate.removed}。\n${candidate.changes.map(c=>`${c.kind==='added'?'新增':c.kind==='removed'?'删除':'修改'}：${c.after||c.before}`).join('\n').slice(0,2400)}\n可撤销；尚未验证真机。`}]);
        setNotice('已应用到当前工程。可点击撤销或使用 Ctrl+Z；保存工程后写入工程文件。');
    };
    const send = async (resume?: AiTaskCheckpoint) => {
        if ((!draft.trim() && !attachments.length && !resume) || importing || savingSettings || busy || applying || chatAction || !storeReady || !preferencesReady || props.disabledReason || storeError) return;
        if (!canConnect) { setSettings(true); return; }
        if(!resume && aiAttachmentBytes(messages.flatMap(m=>m.attachments||[]))+2*aiAttachmentBytes(attachments)>8*1024*1024){setError('这份聊天的附件接近上限，请新建聊天，或移除待发送附件；已有聊天保留。');return;}
        const controller = new AbortController(); request.current = controller;
        const started = performance.now();
        const current = () => mount.current && request.current === controller && !controller.signal.aborted;
        const prompt = resume ? '继续已保存任务，保留原需求和固定验收条件，重新验证后完成任务。' : draft.trim() || '请结合所附资料协助当前工程。';
        const privateFilter = latest.current.host.workspace() ? new AiPrivacyFilter(latest.current.host.workspace()!, connection.apiKey) : undefined;
        const safePrompt = privateFilter?.redact(prompt) || prompt;
        const requestIdentity = latest.current.host.identity();
        const requestSession = latest.current.sessionKey;
        let committedLibrary = false, committedProject = false;
        const sentAttachments = resume ? [] : attachments.map(f=>f.kind==='text'?{...f,content:privateFilter?.redact(f.content)||f.content}:f);
        setAttachments([]);
        setLibraryPreview(undefined); setLibraryLoaded(false);
        setAcceptance(resume?.acceptance); setBehavior(undefined); if (!resume) { setTask(undefined); setChat(old => ({ ...old, taskError: undefined })); }
        setDraft(''); setError(''); setNotice(''); setPreview(undefined); setStale(false); setStream(''); setBusy(true); setStopping(false); setPlan([]); setProgress([]); setValidations([]); follow.current = true;
        setMessages(old => [...old, { id: crypto.randomUUID(), role: 'user' as const, text: safePrompt, attachments: sentAttachments }]);
        if (!messages.length && chat.title === '新聊天') setChat(old => ({ ...old, title: safePrompt.replace(/\s+/g,' ').slice(0,60) }));
        try {
            const result = await runAiTask({ prompt, attachments: sentAttachments, autoApply: connection.autoApply, conversation: messages, memory, contextSettings: connection,
                resume, onCheckpoint: value => { if (mount.current && request.current === controller && latest.current.sessionKey === requestSession) setTask(value); },
                onAcceptance: value => { if (current()) setAcceptance(value); },
                onBehavior: value => { if (current()) { setBehavior(value); setMessages(old => [...old, { id: crypto.randomUUID(), role: 'assistant', text: `行为验证记录：${value.status === 'passed' ? '固定场景通过' : value.status === 'failed' ? '存在失败断言' : '未验证'}，${value.checks.length} 项断言，${(value.elapsedMs/1000).toFixed(1)} 秒。${value.reason || ''}${value.checks.filter(c=>!c.ok).map(c=>`\n${c.id}：期望${c.expected}，实际${c.actual}`).join('').slice(0,2400)}\n固件指令模拟，未连接真机。` }]); } },
                onMemory: value => { if (current()) setMemory(value); }, onUsage: value => { if (current()) setUsage(value); },
                intent: scope.current, connection, host: {
                    workspace: () => latest.current.host.workspace(), catalog: () => latest.current.host.catalog(),
                    target: () => latest.current.host.target(), identity: () => latest.current.host.identity(),
                    get boardProfile() { return latest.current.host.boardProfile; },
                    get projectIdentity() { return latest.current.host.projectIdentity; },
                    get libraryInventory() { return latest.current.host.libraryInventory; },
                    diagnostics: () => latest.current.host.diagnostics(),
                    inspectCandidate: candidate => latest.current.host.inspectCandidate(candidate),
                    validateCandidate: (candidate, context) => latest.current.host.validateCandidate(candidate, context),
                    get validateBehavior() { return latest.current.host.validateBehavior; },
                    get library() { return latest.current.host.library; },
                }, transport: requestAiModel,
                onPlan: steps => { if (current()) setPlan(steps); },
                onValidation: value => { if (current()) { setValidations(old => [...old, value]); setMessages(old => [...old, { id: crypto.randomUUID(), role: 'assistant', text: `验证记录：${value.scope === 'library' ? `库「${value.label || ''}」` : '工程候选'}第 ${value.attempt} 次本地编译${value.ok ? '通过' : '未通过'}，${(value.elapsedMs / 1000).toFixed(1)} 秒，未应用、未上传。${value.diagnostics.map(d => d.message).join('；').slice(0, 1800)}` }]); } },
                onLibraryInstalled: library => {
                    committedLibrary = true;
                    if (mount.current && request.current === controller && latest.current.sessionKey === requestSession) {
                        setMessages(old => [...old, { id: crypto.randomUUID(), role: 'assistant', text: `补库记录：${library.name} v${library.version} 已验证、安装并加载，${library.types.length} 个新积木可用。正在继续原工程任务，${connection.autoApply?'验证成功后将自动应用工程修改':'工程方案仍需确认应用'}。尚未真机验证。` }]);
                    }
                },
                signal: controller.signal, onText: text => { if (current()) setStream(text); }, onStep: text => {
                    if (current()) { setStep(text); setProgress(old => old[old.length - 1]?.text === text ? old : [...old.slice(-49), { text, elapsedMs: Math.round(performance.now() - started) }]); }
                } });
            if (!current()) { if(result.library) await latest.current.host.library?.discard(result.library.token); return; }
            planIdentity.current = result.identity || requestIdentity;
            setStream(''); setPreview(result.preview); setExpanded(false);
            setMessages(old => [...old, { id: crypto.randomUUID(), role: 'assistant' as const, text: result.text }]);
            if (result.preview && connection.autoApply) {
                await commitPreview(result.preview, result.identity || requestIdentity, requestSession, true, controller.signal);
                committedProject = true;
            }
            if (result.library) {
                libraryIdentity.current = requestIdentity;
                setLibraryPreview(result.library);
                if (autoInstallLibrary) {
                    if (requestIdentity !== latest.current.host.identity()) throw Error('工程或板卡已变化，库未安装');
                    await latest.current.host.library!.install(result.library, controller.signal, text => { if(current())setStep(text); });
                    committedLibrary = true;
                    // Native finalization is the commit point. A stop pressed while
                    // its success reply is in flight cannot undo a completed install.
                    if(mount.current && latest.current.sessionKey === requestSession && pendingLibrary.current?.token === result.library.token) {
                        setLibraryLoaded(true); setNotice('库已安装并加载。新积木已出现在分类和搜索中，可直接拖入，也可切回编程助手使用。');
                        setMessages(old => [...old,{id:crypto.randomUUID(),role:'assistant',text:`安装记录：${result.library!.name} v${result.library!.version} 已加载，${result.library!.types.length}个积木可用。仅完成当前板卡试编译，尚未真机验证。`}]);
                    }
                }
            }
        } catch (cause) {
            if (current()) { setError(reasonText(cause)); setStream(''); setDraft(old=>old||prompt); setAttachments(sentAttachments); }
        } finally { if (mount.current && request.current === controller) {
            if (controller.signal.aborted && latest.current.sessionKey === requestSession) { if(!committedProject)setPreview(undefined); setNotice(committedProject ? '修改已经应用，可撤销。后续任务已停止。' : committedLibrary ? '已停止。已安装的库保留；当前工程积木未修改。' : '已停止，本次请求没有修改工程。'); if(!committedProject){setDraft(old=>old||prompt);setAttachments(sentAttachments);} }
            setBusy(false); setStopping(false); setStep(''); request.current = null;
        } }
    };
    const installLibrary = async () => {
        if (!libraryPreview || busy || applying || props.disabledReason || !props.host.library) return;
        if(libraryIdentity.current !== props.host.identity()){setError('板卡、工程或库集合已变化，请重新制作验证');return;}
        const controller=new AbortController();request.current=controller;setBusy(true);setStopping(false);setError('');
        const requestSession=props.sessionKey;
        try {
            await props.host.library.install(libraryPreview,controller.signal,setStep);
            if(mount.current && latest.current.sessionKey===requestSession && pendingLibrary.current?.token===libraryPreview.token){setLibraryLoaded(true);setNotice(controller.signal.aborted?'库已完成安装并加载；停止时安装已经提交。':'新库已安装并加载，可直接使用。');setMessages(old=>[...old,{id:crypto.randomUUID(),role:'assistant',text:`安装记录：${libraryPreview.name} v${libraryPreview.version} 已加载。`}]);}
        } catch(cause){if(mount.current&&request.current===controller){if(controller.signal.aborted)setNotice('已停止安装，未完成的安装已撤回。');else setError(reasonText(cause));}}
        finally{if(mount.current&&request.current===controller){setBusy(false);setStopping(false);setStep('');request.current=null;}}
    };
    const apply = async (compile: boolean) => {
        if (!preview || busy || applying || stale || props.disabledReason) return;
        const identity = props.sessionKey;
        const plan = preview;
        setApplying(true); setError(''); working.current = true;
        try {
            await commitPreview(plan, planIdentity.current, identity, false);
            if (compile) {
                setNotice('已应用，正在执行本地编译…');
                const result = await latest.current.onCompile();
                if (identity !== latest.current.sessionKey) return;
                setNotice(result.ok ? '本地编译通过。硬件运行效果仍需上传后验证。' : '本地编译未通过或已取消。可以撤销，或点击“分析最新错误”。');
                setMessages(old => [...old, { id: crypto.randomUUID(), role: 'assistant', text: result.ok ? '操作记录：本地编译通过，尚未验证实体硬件。' : '操作记录：本地编译失败或取消，需要读取最新诊断。' }]);
            }
        } catch (cause) { if (mount.current) setError(reasonText(cause)); }
        finally { working.current = false; if (mount.current) setApplying(false); }
    };
    const saveSettings = async () => {
        if (savingSettings) return; setSavingSettings(true);
        try {
            const value = { ...validateAiConnection(connection), ...validateAiContext(connection), rememberKey: connection.rememberKey, autoApply: connection.autoApply, reasoningEffort: connection.reasoningEffort, reasoningProtocol: connection.reasoningProtocol, modelChoices: connection.modelChoices };
            await saveAiPreferences(value);
            sessionConnection = value;
            try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ baseUrl: value.baseUrl, model: value.model })); } catch { /* Session-only use still works. */ }
            setConnection(value); setSettings(false); setError(''); setNotice(value.rememberKey ? '全局设置已保存，密钥已用当前 Windows 用户加密，下次启动可继续使用。' : '全局设置已保存；密钥仅在当前会话使用，已删除磁盘上的保存密钥。');
        } catch (cause) { setError(reasonText(cause)); }
        finally { setSavingSettings(false); }
    };
    const chooseChat = async (id?: string) => {
        if (busy || applying || chatAction) return; setChatAction(true);
        try { await flushChat(); const value = id ? await loadAiChat(id,props.projectKey) : newAiChat(props.projectKey);
            adoptChat(value); setHistoryOpen(false); setSettings(false); setIntent({id:Date.now(),kind:'generate'}); await refreshChats();
        } catch (cause) { setStoreError(reasonText(cause)); } finally { setChatAction(false); }
    };
    const removeChat = async (id: string) => {
        setChatAction(true);
        try { await flushChat(); const value=await loadAiChat(id,props.projectKey); await deleteAiChat(value);
            if (chat.id===id) adoptChat(newAiChat(props.projectKey)); setDeleteId(''); await refreshChats();
        } catch (cause) { setStoreError(reasonText(cause)); } finally { setChatAction(false); }
    };
    const renameChat = async () => {
        if (!renameTitle.trim()) return; setChatAction(true);
        try { await flushChat(); const value=await loadAiChat(renameId,props.projectKey); value.title=renameTitle.trim().slice(0,120); value.updatedAt=Date.now();
            writer.current.remember(value); await writer.current.save(value); if(chat.id===value.id)setChat(old=>({...old,title:value.title}));setRenameId('');await refreshChats();
        } catch(cause) { setStoreError(reasonText(cause)); } finally { setChatAction(false); }
    };
    const close = () => { if (busy) stop(); props.onClose(); };
    if (!props.open) return null;
    const actualWidth = Math.min(360, available);
    return <aside ref={panel} className={`ck-ai-panel ${drawer ? 'ck-ai-panel--drawer' : ''} ${compact ? 'ck-ai-panel--compact' : ''} ${availableHeight < 360 ? 'ck-ai-panel--tight' : ''}`} style={{ width: actualWidth }}
        data-ck-role="ai-assistant" aria-label="CK AI 积木助手" onKeyDown={event => {
            if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); if (settings) setSettings(false); else if(historyOpen)setHistoryOpen(false);else close(); }
        }}>
        <header className="ck-ai-header">
            <div className="ck-ai-heading"><span className="ck-ai-mark"><Sparkles size={17} /></span><strong>CK AI</strong><span>积木助手</span></div>
            <div className="ck-ai-actions">
                <button type="button" aria-label="聊天记录" title="聊天记录 · 切换、重命名、删除" aria-pressed={historyOpen} disabled={busy || applying || importing || chatAction || !storeReady} onClick={() => {setHistoryOpen(!historyOpen);setSettings(false);void flushChat().then(()=>refreshChats()).catch(cause=>setStoreError(reasonText(cause)));}}><History size={17}/></button>
                <button type="button" aria-label="新对话" title="新对话" disabled={busy || applying || chatAction || !storeReady} onClick={() => void chooseChat()}><Plus size={17} /></button>
                <button type="button" aria-label="查看生成代码" title="查看生成代码" onClick={props.onCode}><Code2 size={17} /></button>
                <button type="button" aria-label="模型连接设置" title="模型连接设置" aria-pressed={settings} disabled={busy || applying || !preferencesReady} onClick={() => { setSettings(!settings); setHistoryOpen(false); setError(''); }}><Settings2 size={17} /></button>
                <button type="button" aria-label="关闭 AI 面板" title={busy ? '停止请求并关闭' : '关闭 AI 面板'} disabled={applying} onClick={close}><X size={17} /></button>
            </div>
        </header>
        <div className="ck-ai-context"><CircuitBoard size={14} /><span title={props.boardLabel}>{props.boardLabel || '尚未选择板卡'}</span><span className="ck-ai-mode">{modeLabel[intent.kind]}{intent.blockId ? ' · 已选中' : ''}</span></div>
        {!settings && !historyOpen && <><div className="ck-ai-currentchat"><span title={chat.title}>{chat.title}</span><small role="status">{storeStatus}</small></div>
            <div className="ck-ai-task-modes" aria-label="AI任务模式">
                <button type="button" aria-pressed={intent.kind !== 'library'} disabled={busy || applying} onClick={()=>startTask('generate')}>编程助手</button>
                <button type="button" aria-pressed={intent.kind === 'library'} disabled={busy || applying} onClick={()=>startTask('library')}>制作积木库</button>
            </div>
            {intent.kind === 'library' && <label className="ck-ai-library-auto"><input type="checkbox" checked={autoInstallLibrary} disabled={busy || applying} onChange={e=>setAutoInstallLibrary(e.target.checked)}/>验证通过后自动安装并加载</label>}
            {intent.kind !== 'library' && <p className="ck-ai-library-auto">缺少积木时，可自动补建库并继续。</p>}
        </>}
        {settings ? <form className="ck-ai-settings" onSubmit={event => { event.preventDefault(); void saveSettings(); }}>
            <button type="button" className="ck-ai-back" onClick={() => { setSettings(false); setError(''); }}><ArrowLeft size={15} />返回对话</button>
            <h2>连接你的模型</h2><p>使用支持工具调用的 Chat Completions API。模型服务由你选择，费用由服务商收取。</p>
            <label>API 地址<input autoFocus type="url" value={connection.baseUrl} placeholder="https://api.example.com/v1" autoComplete="off" spellCheck={false} onChange={e => setConnection({ ...connection, baseUrl: e.target.value, modelChoices: [], reasoningEffort: 'auto', apiKey: connection.baseUrl===e.target.value?connection.apiKey:'' })} /></label>
            <label>模型名称<input list="ck-ai-model-options" value={connection.model} placeholder="填写服务商提供的模型名称" autoComplete="off" spellCheck={false} onChange={e => setConnection({ ...connection, model: e.target.value })} /></label>
            <datalist id="ck-ai-model-options">{connection.modelChoices.map(m=><option key={m} value={m}/>)}</datalist>
            <button type="button" className="ck-ai-secondary" disabled={loadingModels||!connection.baseUrl||!connection.apiKey} onClick={()=>void fetchModels()}>{loadingModels?'正在获取…':'获取服务商模型列表'}</button>
            <label>API 密钥<input type="password" value={connection.apiKey} placeholder="填写或替换密钥" autoComplete="off" spellCheck={false} onChange={e => setConnection({ ...connection, apiKey: e.target.value })} /></label>
            <label className="ck-ai-checkbox"><input type="checkbox" checked={connection.rememberKey} onChange={e=>setConnection({...connection,rememberKey:e.target.checked})}/>在这台电脑记住密钥，所有工程共用</label>
            <label>思考参数协议<select value={connection.reasoningProtocol} onChange={e=>setConnection({...connection,reasoningProtocol:e.target.value,reasoningEffort:'auto'})}><option value="auto">自动（识别官方 DeepSeek 地址）</option><option value="standard">标准 reasoning_effort</option><option value="deepseek">DeepSeek thinking + reasoning_effort</option></select></label>
            <p className="ck-ai-privacy">思考强度由服务商和模型支持情况决定，不等同于智商。默认不额外发送思考参数；选择档位后会实际发送，接口拒绝时显示错误，不会悄悄忽略。DeepSeek 中转接口可手动选择协议。</p>
            <div className="ck-ai-setting-divider"/>
            <h3>上下文与用量</h3>
            <label>上下文预算（tokens）<input aria-label="上下文预算" type="number" min={16384} max={262144} step={1024} value={connection.contextTokens} onChange={e=>setConnection({...connection,contextTokens:Number(e.target.value)})}/></label>
            <label>单次回复预留（tokens）<input aria-label="单次回复预留" type="number" min={1024} max={32768} step={1024} value={connection.responseTokens} onChange={e=>setConnection({...connection,responseTokens:Number(e.target.value)})}/></label>
            <label className="ck-ai-checkbox"><input type="checkbox" checked={connection.autoCompact} onChange={e=>setConnection({...connection,autoCompact:e.target.checked})}/>输入预算达到约 80% 时自动压缩</label>
            <p className="ck-ai-privacy">预算应不超过所用模型的实际限制。包含工具定义、历史和回复预留，用量为估算，账单以服务商为准。压缩也会调用模型；完整聊天仍保留在本机。</p>
            <p className="ck-ai-privacy">密钥用当前 Windows 用户加密保存，不写入工程或导出包。修改 API 地址会清空输入框中的旧密钥，避免发给错误服务。</p>
            {error && <div role="alert" className="ck-ai-error"><CircleAlert size={16} /><span>{error}</span></div>}
            <button className="ck-ai-primary" type="submit" disabled={savingSettings}>{savingSettings?'正在保存…':'保存连接设置'}<Check size={15} /></button>
        </form> : historyOpen ? <section className="ck-ai-history" aria-label="当前工程聊天记录">
            <div className="ck-ai-history-head"><div><h2>聊天记录</h2><p>当前工程 · 本机保存</p></div><button type="button" className="ck-ai-secondary" disabled={chatAction} onClick={()=>void chooseChat()}><Plus size={14}/>新聊天</button></div>
            {storeError && <p role="alert" className="ck-ai-error">{storeError}</p>}
            {!chatList.length && <p className="ck-ai-history-empty">还没有已保存的聊天。发送第一条需求后会自动保存。</p>}
            <div className="ck-ai-history-list">{chatList.map(row=><div key={row.id} className={`ck-ai-history-row ${row.id===chat.id?'is-active':''}`}>
                {renameId===row.id ? <form onSubmit={e=>{e.preventDefault();void renameChat();}}><input autoFocus aria-label="聊天名称" maxLength={120} value={renameTitle} onChange={e=>setRenameTitle(e.target.value)}/><button className="ck-ai-secondary" disabled={chatAction||!renameTitle.trim()}>保存</button><button type="button" className="ck-ai-text-button" onClick={()=>setRenameId('')}>取消</button></form> : <>
                    <button type="button" className="ck-ai-chat-select" disabled={chatAction} onClick={()=>void chooseChat(row.id)}><strong>{row.title}</strong><small>{new Date(row.updatedAt).toLocaleString()} · {row.messages} 条消息</small></button>
                    <div className="ck-ai-chat-actions"><button type="button" aria-label={`重命名 ${row.title}`} disabled={chatAction} onClick={()=>{setRenameId(row.id);setRenameTitle(row.title);}}><Pencil size={14}/></button><button type="button" aria-label={`删除 ${row.title}`} disabled={chatAction} onClick={()=>setDeleteId(row.id)}><Trash2 size={14}/></button></div>
                </>}
                {deleteId===row.id && <div className="ck-ai-delete-confirm"><span>删除这份聊天记录？</span><button type="button" className="ck-ai-secondary" disabled={chatAction} onClick={()=>void removeChat(row.id)}>确认删除</button><button type="button" className="ck-ai-text-button" onClick={()=>setDeleteId('')}>取消</button></div>}
            </div>)}</div>
        </section> : <>
            <div className="ck-ai-feed" ref={scroll} onScroll={() => { const node = scroll.current; if (node) follow.current = node.scrollHeight - node.clientHeight - node.scrollTop < 60; }}>
                {intent.kind === 'library' && !busy && !libraryPreview && <div className="ck-ai-library-intro"><strong>把硬件能力做成可复用积木</strong><p>说明硬件型号、需要的操作和参数。已有驱动时提供接口用法；CK 会生成库、检查积木并试编译，然后按上方开关加载。</p><small>新库先适配当前板卡；缺少硬件资料时 AI 会询问，不代表真机验证。</small></div>}
                {messages.length === 0 && intent.kind !== 'library' && <div className="ck-ai-welcome">
                    <span className="ck-ai-eyebrow">从一个想法开始</span><h2>你说想法，<br />一起搭成积木。</h2><p>搭建新程序、修改选中部分，<br />或从编译错误找到下一步。</p>
                    <div className="ck-ai-starters">{[
                        ['让板载 LED 每秒闪烁', '搭一个可以直接编辑的程序', Plus],
                        ['请先读取当前程序，解释它的执行过程', '看懂已有积木的逻辑', MessageSquare],
                        ['请读取最近的编译诊断，分析原因并提出最小修改', '从真实错误开始修复', CircleAlert],
                    ].map(([title, detail, Icon], index) => { const Glyph = Icon as typeof Plus; return <button type="button" key={String(title)} onClick={() => startTask(index === 1 ? 'explain' : index === 2 ? 'repair' : 'generate', String(title))}><Glyph size={17} /><span><strong>{String(title)}</strong><small>{String(detail)}</small></span><ChevronRight size={14} /></button>; })}</div>
                </div>}
                {storeError && <p role="alert" className="ck-ai-error">{storeError}</p>}
                {memory && <details className="ck-ai-memory"><summary>已压缩 {memory.compressions} 次 · 原聊天仍保留</summary><p>{memory.summary}</p></details>}
                {task && !busy && !preview && !libraryPreview && <section className="ck-ai-resume" aria-label="已保存的任务草稿">
                    <strong>任务草稿已保留</strong><p>{task.nodes.length} 个暂存节点 · {task.acceptance?.requirements.length || 0} 项验收条件</p>
                    <small>继续时重新核对工程、板卡和库，并重新编译。不会自动应用旧方案。</small>
                    <div><button type="button" className="ck-ai-primary" disabled={applying || chatAction || !storeReady || Boolean(props.disabledReason) || Boolean(storeError)} onClick={()=>void send(task)}>继续任务</button>
                    <button type="button" className="ck-ai-text-button" disabled={applying || chatAction} onClick={()=>{setTask(undefined);setChat(old=>({...old,taskError:undefined}));setAcceptance(undefined);setBehavior(undefined);}}>放弃草稿</button></div>
                </section>}
                {messages.length>visibleMessages&&<button type="button" className="ck-ai-secondary ck-ai-older" onClick={()=>{follow.current=false;setVisibleMessages(count=>count+80);}}>查看更早的 {Math.min(80,messages.length-visibleMessages)} 条消息</button>}
                {messages.slice(-visibleMessages).map(message => <article key={message.id} className={`ck-ai-message ck-ai-message--${message.role}`}>
                    <span className="ck-ai-message-label">{message.role === 'user' ? '你' : 'CK AI'}</span><div>{message.text}</div>
                    {message.attachments?.map(file=><details className="ck-ai-attachment-view" key={file.id}><summary><FileText size={12}/>{file.name}</summary>{file.kind==='image'?<img src={file.content} alt={file.name}/>:<pre>{file.content}</pre>}</details>)}
                </article>)}
                {busy && <div className="ck-ai-current"><div className="ck-ai-step" role="status"><Loader2 size={14} className="ck-ai-spin" />{step || '正在连接模型'}</div>{stream && <div className="ck-ai-stream">{stream}</div>}</div>}
                {(plan.length > 0 || progress.length > 0) && <details className="ck-ai-task-progress"><summary>任务过程 · {progress.length} 条记录</summary>
                    {plan.length > 0 && <><strong>任务计划</strong><ol>{plan.map((text, i) => <li key={i}>{text}</li>)}</ol></>}
                    <ol>{progress.map((item, i) => <li key={i}><time>{(item.elapsedMs / 1000).toFixed(1)}s</time>{item.text}</li>)}</ol>
                </details>}
                {validations.length > 0 && <section className="ck-ai-validations" aria-label="候选编译验证记录">
                    <strong>方案本地验证记录</strong>
                    {validations.map(record => <details key={record.runId} className={record.ok ? 'is-pass' : 'is-fail'}>
                        <summary>{record.scope === 'library' ? '库' : '工程'} · 第 {record.attempt} 次 · {record.ok ? '编译通过' : '编译未通过'} · {(record.elapsedMs / 1000).toFixed(1)}s</summary>
                        {record.diagnostics.map((item, i) => <p key={i}>{item.label ? `积木：${item.label}\n` : ''}{item.message}</p>)}
                        <pre>{record.log}</pre>
                    </details>)}
                    <small>编译结果仅对应这份候选方案；功能行为及真机效果仍需验证。</small>
                </section>}
                {task?.repairScope && <section className="ck-ai-repair-scope" aria-label="固定的修复范围">
                    <strong>修复范围 · 仅 {task.repairScope.fields.length} 个既有字段</strong>
                    <p>首次送验为字段修改。后续修复保持积木结构和其他字段不变；需要扩展时会停止并说明。</p>
                    <small>此检查限制修改范围，不代表全部需求或真机行为已验证。</small>
                </section>}
                {acceptance && <section className="ck-ai-acceptance" aria-label="需求验收清单">
                    <div className="ck-ai-acceptance-title"><strong>需求验收</strong><span>条件已固定</span></div>
                    <ul>{aiRequirementStatus(acceptance,behavior).map(row=><li key={row.id} data-status={row.status}>
                        <span className="ck-ai-verdict">{row.status === 'passed' ? '场景通过' : row.status === 'failed' ? '未通过' : '待验证'}</span><span>{row.text}<small>{row.method === 'simulation' ? '固件指令模拟' : row.method === 'hardware' ? '需要真实硬件' : '需要人工核对'}</small></span>
                    </li>)}</ul>
                    {behavior?.reason && <p>{behavior.reason}</p>}
                    {behavior && <details><summary>查看本次 {behavior.checks.length} 项断言</summary>{behavior.checks.map(c=><p key={c.id}><b>{c.ok?'通过':'失败'} · {c.id}</b><br/>期望：{c.expected}<br/>实际：{c.actual}</p>)}</details>}
                    <small>模拟通过仅覆盖列出的场景。第三方库无需额外接口；未模拟的硬件功能保持待验证。</small>
                </section>}
                {libraryPreview && <section className="ck-ai-proposal" aria-label="生成的积木库">
                    <div className="ck-ai-proposal-title"><Check size={16}/><strong>{libraryLoaded ? '库已加载' : '库已通过试编译'}</strong></div>
                    <p><b>{libraryPreview.name}</b> · v{libraryPreview.version}</p><p>{libraryPreview.types.length} 个积木 · {libraryPreview.files.length} 个文件</p>
                    <details className="ck-ai-library-files"><summary>查看库文件与试编译代码</summary><ul>{libraryPreview.files.map(file=><li key={file}>{file}</li>)}</ul><pre>{libraryPreview.source}</pre></details>
                    <small>当前板卡试编译通过，尚未验证真机；安装后也可在库管理器卸载。</small>
                    <div className="ck-ai-proposal-actions">
                        {!libraryLoaded && <button type="button" className="ck-ai-primary" disabled={busy || applying || Boolean(props.disabledReason)} onClick={()=>void installLibrary()}>安装并加载</button>}
                        {libraryLoaded && <button type="button" className="ck-ai-primary" disabled={busy || applying} onClick={()=>{setIntent({id:Date.now(),kind:'generate'});setDraft(`请使用刚创建的“${libraryPreview.name}”库搭建示例，先查询实际积木结构。`);input.current?.focus();}}>用这个库搭建程序</button>}
                        <button type="button" className="ck-ai-secondary" disabled={busy || applying} onClick={()=>{setApplying(true);void props.host.library?.export(libraryPreview).then(path=>{if(path)setNotice(`已导出：${path}`);}).catch(cause=>setError(reasonText(cause))).finally(()=>setApplying(false));}}>导出库 ZIP</button>
                        {!libraryLoaded && <button type="button" className="ck-ai-text-button" disabled={busy || applying} onClick={()=>setLibraryPreview(undefined)}>放弃</button>}
                    </div>
                </section>}
                {preview && <section className="ck-ai-proposal" aria-label="待确认的积木修改">
                    <div className="ck-ai-proposal-title"><Check size={16} /><strong>修改预览</strong><span>尚未应用</span></div>
                    <p>新增 <b>{preview.added}</b> · 修改 <b>{preview.changed}</b> · 删除 <b>{preview.removed}</b></p>
                    <button className="ck-ai-details" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>查看具体变化<ChevronDown size={14} /></button>
                    {expanded && <ul className="ck-ai-changes">{preview.changes.map(change => <li key={change.id}>
                        <span>{change.kind === 'added' ? '新增' : change.kind === 'removed' ? '删除' : '修改'}</span>
                        {change.before && <div className={change.kind === 'removed' ? 'ck-ai-removed' : ''}>{change.before}</div>}
                        {change.after && <div>{change.kind === 'changed' ? '→ ' : ''}{change.after}</div>}
                    </li>)}</ul>}
                    <small>候选副本已通过结构检查和本地编译；尚未验证硬件。</small>
                    {stale && <p role="status" className="ck-ai-stale">工程已有变化，请重新生成方案。</p>}
                    <div className="ck-ai-proposal-actions"><button type="button" className="ck-ai-primary" disabled={stale || applying || busy || Boolean(props.disabledReason)} onClick={() => void apply(false)}>{applying ? <Loader2 size={15} className="ck-ai-spin" /> : <Check size={15} />}应用修改</button>
                        <button type="button" className="ck-ai-secondary" disabled={stale || applying || busy || Boolean(props.disabledReason)} onClick={() => void apply(true)}>应用并编译</button>
                        <button type="button" className="ck-ai-text-button" disabled={applying} onClick={() => setPreview(undefined)}>放弃</button></div>
                </section>}
                {error && <div role="alert" className="ck-ai-error"><CircleAlert size={16} /><span>{error}</span></div>}
                {notice && <div role="status" className="ck-ai-notice">{notice}</div>}
                {undoState && !busy && !applying && <button className="ck-ai-secondary ck-ai-undo" type="button" disabled={Boolean(props.disabledReason)} onClick={() => {
                    const workspace = props.host.workspace();
                    const stack = workspace?.getUndoStack() || [];
                    if (!workspace || aiWorkspaceSnapshot(workspace) !== undoState || stack[stack.length - 1] !== undoEvent.current) { setUndoState(undefined); setError('工程已有其他修改，请使用 Ctrl+Z 按顺序撤销。'); return; }
                    workspace.undo(false); setUndoState(undefined); setNotice('已撤销本次 AI 修改。');
                    setMessages(old=>[...old,{id:crypto.randomUUID(),role:'assistant',text:'操作记录：用户已撤销本次 AI 修改。'}]);
                }}><Undo2 size={14} />撤销本次修改</button>}
            </div>
            <footer className="ck-ai-composer">
                {!canConnect && <button type="button" className="ck-ai-connect" onClick={() => { setSettings(true); setError(''); }}><span className="ck-ai-dot" />先连接你的模型<ChevronRight size={14} /></button>}
                {props.disabledReason && <p className="ck-ai-disabled" role="status">{props.disabledReason}</p>}
                <div className="ck-ai-usage" title={`包含工具定义和近期对话；回复预留 ${connection.responseTokens} tokens。模型实际限制与账单以服务商为准。`}><span>{usage ? `上下文 ≈ ${Math.ceil(usage.estimatedInputTokens/100)/10}k / ${Math.round(connection.contextTokens/1024)}k` : `上下文预算 ${Math.round(connection.contextTokens/1024)}k`}</span><span>{usage?.requests ? `${usage.requests} 次请求` : '发送后估算用量'}</span></div>
                {usage?.inputTokens!=null && <div className="ck-ai-token-detail">服务商返回：输入 {usage.inputTokens.toLocaleString()} / 输出 {(usage.outputTokens||0).toLocaleString()} tokens（本次合计）</div>}
                <input ref={fileInput} type="file" accept={AI_ATTACHMENT_ACCEPT} multiple hidden aria-label="选择 AI 附件" onChange={e=>{const files=Array.from(e.target.files||[]);e.target.value='';void addAttachments(files);}}/>
                {attachments.length>0&&<div className="ck-ai-attachments" aria-label="待发送附件">{attachments.map(file=><div key={file.id}><span title={`${file.name} · ${Math.ceil(file.size/1024)} KB`}>{file.kind==='image'?<img src={file.content} alt=""/>:<FileText size={14}/>}<span>{file.name}</span></span><button type="button" aria-label={`移除附件 ${file.name}`} disabled={busy||applying||importing} onClick={()=>setAttachments(old=>old.filter(f=>f.id!==file.id))}><X size={13}/></button></div>)}</div>}
                <div className="ck-ai-input-shell"><textarea ref={input} value={draft} maxLength={6000} rows={2} aria-label="发给 AI 的需求" placeholder={intent.kind === 'edit' ? '想怎样修改选中的积木？' : '描述你想搭建或修改的功能…'} disabled={applying}
                    onPaste={event=>{const files=Array.from(event.clipboardData.files);if(files.length){event.preventDefault();void addAttachments(files);}}}
                    onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
                    <div className="ck-ai-input-bottom"><button type="button" className="ck-ai-attach" aria-label="添加图片或文件" title="图片、UTF-8 文本和代码 · 最多4个；支持粘贴图片" disabled={busy||applying||importing} onClick={()=>fileInput.current?.click()}>{importing?<Loader2 size={16} className="ck-ai-spin"/>:<Paperclip size={16}/>}</button><span>Ctrl + Enter 发送</span><button type="button" className="ck-ai-inline-action" disabled={busy||applying} onClick={()=>startTask('repair','请读取最近一次编译的诊断，分析错误原因并提出最小修改方案。')}>分析最新错误</button>{busy ? <button type="button" className="ck-ai-send" aria-label="停止 AI 请求" disabled={stopping} onClick={stop}><Square size={14} fill="currentColor" /></button> : <button type="button" className="ck-ai-send" aria-label="发送需求" disabled={(!draft.trim()&&!attachments.length) || importing || savingSettings || applying || chatAction || !storeReady || !preferencesReady || Boolean(props.disabledReason) || Boolean(storeError)} onClick={() => void send()}><ArrowUp size={18} /></button>}</div>
                </div>
                <div className="ck-ai-controls" aria-label="AI 模型与应用模式">
                    <select aria-label="当前 AI 模型" title={connection.model || '选择模型'} value={connection.model} disabled={busy||applying||savingSettings} onChange={e=>{if(e.target.value==='__custom__')setSettings(true);else void updateControls({model:e.target.value,reasoningEffort:'auto'});}}>
                        {!connection.model&&<option value="">选择模型</option>}{[...new Set([connection.model,...connection.modelChoices].filter(Boolean))].map(m=><option value={m} key={m}>{m}</option>)}<option value="__custom__">添加 / 获取模型…</option>
                    </select>
                    <select aria-label="思考强度" title="思考强度：接口须支持所选档位" value={connection.reasoningEffort} disabled={busy||applying||savingSettings} onChange={e=>void updateControls({reasoningEffort:e.target.value})}>{efforts.map(([value,label])=><option key={value} value={value}>思考 · {label}</option>)}</select>
                    <select className="ck-ai-apply-mode" aria-label="AI 修改模式" value={connection.autoApply?'auto':'manual'} disabled={busy||applying||savingSettings} onChange={e=>void updateControls({autoApply:e.target.value==='auto'})}><option value="auto">AI 自动修改 · 可撤销</option><option value="manual">手动确认后修改</option></select>
                </div>
                <div className="ck-ai-project-path"><FolderOpen size={12}/><span title={projectPath}>{projectPath}</span><button type="button" aria-label="复制工程路径" disabled={!props.projectKey.startsWith('file:')} onClick={()=>void navigator.clipboard.writeText(projectPath).then(()=>setNotice('工程路径已复制')).catch(()=>setError('复制失败，请从路径提示中查看'))}><Copy size={12}/></button></div>
                <p className="ck-ai-footnote">{connection.autoApply?'校验通过即修改当前工程；保存后写入文件。':'校验后预览，确认后修改。'}附件会发送到所选服务；图片需视觉模型，文字不支持自动识别所有秘密。</p>
            </footer>
        </>}
    </aside>;
}
