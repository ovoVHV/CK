import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AI_ATTACHMENT_ACCEPT, aiAttachmentBytes, importAiAttachment, validateAiAttachments, type AiAttachment } from '../services/ai_attachments';
import * as Blockly from 'blockly';
import { ArrowUp, ArrowLeft, Check, ChevronDown, CircleAlert, CircuitBoard, Code2, Gauge, Loader2, MessageSquare, Plus, Settings2, Sparkles, Square, Undo2, X, History, Pencil, Trash2, Paperclip, FileText, FolderOpen, Copy, Wrench } from 'lucide-react';
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
import { PanelResizeHandle, useSavedPanelSize } from './PanelResizeHandle';
import { noDeviceGrants, type AiDeviceGrants, type NewProjectSource } from '../services/ai_project_device';
import { useUiText } from '../i18n/uiText';

export interface AiAssistantPanelProps {
    open: boolean;
    intent: AiIntent;
    sessionKey: string;
    projectKey: string;
    projectPath?: string;
    host: AiHost;
    boardLabel: string;
    devicePort:string;
    deviceBaud:number;
    verifyMembers:(members:string)=>Promise<void>;
    onVerifiedUpload:(proof:{source:string;members:string},check:()=>void)=>Promise<boolean>;
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

export function AiAssistantPanel(props: AiAssistantPanelProps) {
    const { tr } = useUiText();
    const modeLabel = { generate: tr('搭建积木', 'Build blocks'), edit: tr('修改积木', 'Edit blocks'), explain: tr('解释积木', 'Explain blocks'), repair: tr('修复报错', 'Fix error'), library: tr('制作积木库', 'Create block library') };
    const latest = useRef(props); latest.current = props;
    const [connection, setConnection] = useState<AiPreferences>(readConnection);
    const [preferencesReady, setPreferencesReady] = useState(false);
    const [savingSettings, setSavingSettings] = useState(false);
    const [page, setPage] = useState<'chat'|'settings'|'history'|'access'>('chat');
    const previousPage = useRef(page);
    const [draft, setDraft] = useState('');
    const [attachments, setAttachments] = useState<AiAttachment[]>([]);
    const [importing, setImporting] = useState(false);
    const [loadingModels, setLoadingModels] = useState(false);
    const [manualModel, setManualModel] = useState(false);
    const listedModel = connection.modelChoices.includes(connection.model);
    const customModel = manualModel || (!!connection.model && !listedModel);
    const fileInput = useRef<HTMLInputElement>(null);
    const importGeneration = useRef(0);
    const projectPath = props.projectKey.startsWith('file:') ? (props.projectPath || props.projectKey.slice(5)).replace(/^\\\\\?\\/, '') : tr('尚未保存 · 当前工程', 'Unsaved · Current project');
    const deepseek = connection.apiProtocol !== 'responses' && (connection.reasoningProtocol === 'deepseek' || (connection.reasoningProtocol === 'auto' && (()=>{try{return new URL(connection.baseUrl).hostname==='api.deepseek.com';}catch{return false;}})()));
    const efforts = deepseek ? [['auto',tr('模型默认','Model default')],['none',tr('关闭思考','Off')],['low',tr('低','Low')],['high',tr('高','High')],['max',tr('最高','Max')]] : [['auto',tr('模型默认','Model default')],['none',tr('关闭思考','Off')],['low',tr('低','Low')],['medium',tr('中','Medium')],['high',tr('高','High')],['max',tr('最高（需API支持）','Max (API required)')]];
    const [messages, setMessages] = useState<AiChatMessage[]>([]);
    const [chat, setChat] = useState<AiChat>(() => newAiChat(props.projectKey));
    const permissionScope=JSON.stringify([props.open,props.sessionKey,chat.id,props.host.target(),props.devicePort,props.deviceBaud,connection.baseUrl,connection.model]);
    const pathParts=props.projectPath?.split(/[\\/]/);
    const entry=pathParts?.[pathParts.length-1];
    const folderProject=!!entry&&/\.ck$/i.test(entry)&&pathParts?.[pathParts.length-2]===entry.slice(0,-3);
    const [sourceReview,setSourceReview]=useState<{files:NewProjectSource[];finish:(yes:boolean)=>void}>();
    const authority=useRef({scope:permissionScope,grants:{...noDeviceGrants},ticket:0});
    const [,refreshGrants]=useState(0);
    if(authority.current.scope!==permissionScope)authority.current={scope:permissionScope,grants:{...noDeviceGrants},ticket:0};
    const grant=(key:keyof AiDeviceGrants,yes:boolean)=>{
        const a=authority.current; a.grants={...a.grants,[key]:yes};
        if(key==='serial'&&!yes)a.grants.send=false;
        if(key==='upload')a.ticket++;
        refreshGrants(n=>n+1);
    };
    const uploadAfterApply=useRef<{candidate:AiPreview;check:()=>void}|null>(null);
    const [memory, setMemory] = useState<AiMemory>();
    const [usage, setUsage] = useState<AiUsage>();
    const [chatList, setChatList] = useState<AiChatListEntry[]>([]);
    const [storeReady, setStoreReady] = useState(false);
    const [storeStatus, setStoreStatus] = useState(() => tr('正在读取聊天', 'Loading chats'));
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
    const [panelWidth, savePanelWidth] = useSavedPanelSize('ck_ai_panel_width_v2', 360);
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
    useEffect(()=>{
        if(sourceReview&&(!authority.current.grants.create||props.disabledReason))sourceReview.finish(false);
    },[permissionScope,authority.current.grants.create,props.disabledReason,sourceReview]);
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
        setStoreError(''); setStoreStatus(value.revision ? tr('已保存到本机', 'Saved locally') : tr('新聊天', 'New chat'));
        follow.current = true;
    };
    const refreshChats = async (projectKey = props.projectKey) => {
        const result = await listAiChats(projectKey);
        if (latest.current.projectKey !== projectKey) return;
        setChatList(result.chats);
        if (result.unreadable) setNotice(tr(`有 ${result.unreadable} 份聊天记录无法读取，原文件已保留；可继续使用当前聊天。`, `${result.unreadable} chat log(s) could not be read and were preserved on disk; you can continue with the current chat.`));
    };

    useEffect(() => {
        let cancelled = false;
        loadAiPreferences().then(value => { if (!cancelled) { if (value) { sessionConnection = { ...DEFAULT_AI_PREFERENCES, ...value, apiKey: value.apiKey || sessionConnection.apiKey }; setConnection(sessionConnection); } setPreferencesReady(true); } })
            .catch(cause => { if (!cancelled) { setError(tr('读取全局设置失败：', 'Failed to load AI settings: ') + reasonText(cause)); setPreferencesReady(true); } });
        return () => { cancelled = true; };
    }, []);
    useEffect(() => {
        let cancelled = false;
        request.current?.abort(); request.current = null; setBusy(false); setStoreReady(false); setPage('chat');
        setMessages([]); setDraft(''); setMemory(undefined); setPreview(undefined); setStoreStatus(tr('正在读取聊天', 'Loading chats'));
        void (async () => {
            try {
                await flushChat();
                const result = await listAiChats(props.projectKey);
                const value = result.chats.length ? await loadAiChat(result.chats[0].id, props.projectKey) : newAiChat(props.projectKey);
                if (cancelled) return;
                writer.current = new AiChatWriter(); adoptChat(value); setChatList(result.chats); setStoreReady(true);
                if (result.unreadable) setNotice(tr(`有 ${result.unreadable} 份聊天无法读取，原文件保留；可继续使用当前聊天。`, `${result.unreadable} chat log(s) could not be read and were preserved on disk; you can continue with the current chat.`));
            } catch (cause) { if (!cancelled) setStoreError(reasonText(cause)); }
        })();
        return () => { cancelled = true; };
    }, [props.projectKey]);
    useEffect(() => {
        if (!storeReady || chat.projectKey !== props.projectKey || (!messages.length && !draft && !attachments.length && !chat.revision && !writer.current.revision(chat.id))) return;
        const value = { ...chatRef.current, updatedAt: Date.now(), draft: connection.apiKey ? draft.split(connection.apiKey).join(tr('[已隐藏 API 密钥]', '[API key redacted]')) : draft };
        pendingSave.current = value; setStoreStatus(tr('正在保存…', 'Saving…')); clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
            if (pendingSave.current !== value) return;
            pendingSave.current = undefined;
            void writer.current.save(value).then(() => { if (chatRef.current.id === value.id) setStoreStatus(tr('已保存到本机', 'Saved locally')); })
                .catch(cause => { if (mount.current) { setStoreError(reasonText(cause)); setStoreStatus(tr('保存失败', 'Save failed')); } });
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
        setPage('chat');
        request.current?.abort();
        // Keep the request busy until native compilation/installation settles.
        // Reopening the panel must not race a still-running rollback.
        setStream('');
    }, [props.open]);
    useLayoutEffect(()=>{
        if(props.open && page==='chat' && previousPage.current!=='chat') input.current?.focus({preventScroll:true});
        previousPage.current=page;
    },[page,props.open]);
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
        if (props.intent.kind === 'repair') setDraft(tr('请分析这次编译错误，说明原因，并给出尽量小的积木修改方案。', 'Analyze this build error, explain the cause, and propose the smallest block fix.'));
        else if (props.intent.kind === 'explain') setDraft(tr('请解释选中的积木及其输入，说明执行顺序和用途。', 'Explain the selected blocks and their inputs, including execution order and purpose.'));
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
        const resize = () => {
            // AI is exclusive with the code and health inspectors. The console
            // shares the canvas column and never reduces the width or height here.
            setDrawer(parent.clientWidth < 900); setAvailable(parent.clientWidth); setAvailableHeight(parent.clientHeight);
        };
        const observer = new ResizeObserver(resize); observer.observe(parent);
        resize();
        return () => observer.disconnect();
    }, [props.open]);
    useLayoutEffect(() => { props.onLayout(); }, [props.open, drawer]);
    useLayoutEffect(() => {
        const textarea = input.current;
        if (!textarea || !props.open || page !== 'chat') return;
        // Grow only with the draft, then scroll inside the capped input. Reading
        // the CSS limits also respects the shorter layout above an open console.
        const style = getComputedStyle(textarea);
        const minimum = parseFloat(style.minHeight);
        const maximum = parseFloat(style.maxHeight);
        textarea.style.height = '0px';
        const contentHeight = textarea.scrollHeight;
        textarea.style.height = `${Math.max(minimum, Math.min(maximum, contentHeight))}px`;
        textarea.style.overflowY = contentHeight > maximum ? 'auto' : 'hidden';
    }, [draft, props.open, page, available, availableHeight, panelWidth]);
    useEffect(() => {
        if (follow.current && scroll.current) scroll.current.scrollTop = messages.length || preview || error || notice ? scroll.current.scrollHeight : 0;
    }, [messages, stream, step, preview, expanded, error, notice]);

    const stop = () => {
        request.current?.abort(); setStopping(true);
        setStream(''); setStep(tr('正在停止模型请求和候选编译…', 'Stopping model request and candidate build…'));
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
            if (files.length + attachments.length > 4) throw Error(tr('每条消息最多附加 4 个文件', 'Up to 4 files can be attached per message'));
            const imported = await Promise.all(files.map(importAiAttachment));
            if (!mount.current || generation !== importGeneration.current || session !== latest.current.sessionKey || chatId !== chatRef.current.id) return;
            const combined=validateAiAttachments([...attachments, ...imported]);
            if(aiAttachmentBytes(messages.flatMap(m=>m.attachments||[]))+2*aiAttachmentBytes(combined)>8*1024*1024) throw Error(tr('这份聊天的附件接近上限，请新建聊天后添加；已有附件保留。', 'Attachments in this chat are near the size limit. Start a new chat to add more; existing attachments are kept.'));
            setAttachments(combined);
        } catch(cause) { if (generation===importGeneration.current && mount.current) setError(reasonText(cause)); }
        finally { if (generation===importGeneration.current && mount.current) setImporting(false); }
    };
    const updateControls = async (patch: Partial<AiPreferences>) => {
        if (busy || applying || savingSettings || !preferencesReady) return;
        setSavingSettings(true);setError('');
        const value={...connection,...patch};
        try {await saveAiPreferences(value);sessionConnection=value;setConnection(value);}
        catch(cause){setError(tr('设置未保存：', 'Failed to save settings: ')+reasonText(cause));}
        finally{setSavingSettings(false);}
    };
    const fetchModels = async () => {
        if (loadingModels) return;setLoadingModels(true);setError('');
        const base=connection.baseUrl, key=connection.apiKey;
        try {const models=await invoke<string[]>('ai_list_models',{baseUrl:base,apiKey:key});
            setConnection(old=>old.baseUrl===base&&old.apiKey===key?{...old,modelChoices:models,model:old.model||(models.length===1?models[0]:'')}:old);
        } catch(cause){setError(reasonText(cause));}finally{if(mount.current)setLoadingModels(false);}
    };
    const commitPreview = async (candidate: AiPreview, identity: string, session: string, automatic: boolean, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        if (session!==latest.current.sessionKey || latest.current.disabledReason || identity!==latest.current.host.identity()) throw Error(tr('工程状态已变化，未应用方案', 'Project state changed; proposal not applied'));
        await latest.current.beforeApply();
        if(candidate.verifiedInputs)await latest.current.verifyMembers(candidate.verifiedInputs.members);
        signal?.throwIfAborted();
        if (!mount.current || session!==latest.current.sessionKey || latest.current.disabledReason || identity!==latest.current.host.identity()) throw Error(tr('工程状态已变化，未应用方案', 'Project state changed; proposal not applied'));
        const workspace=latest.current.host.workspace(); if (!workspace) throw Error(tr('工作区已关闭', 'Workspace is closed'));
        working.current=true;
        try {undoEvent.current=applyAiPreview(workspace,candidate);}
        finally {working.current=false;}
        setPreview(undefined);setTask(undefined);setUndoState(aiWorkspaceSnapshot(workspace));
        setMessages(old=>[...old,{id:crypto.randomUUID(),role:'assistant',text:tr(`操作记录：${automatic?'AI 已自动应用':'用户已确认应用'}本次修改。新增 ${candidate.added} · 修改 ${candidate.changed} · 删除 ${candidate.removed}。\n${candidate.changes.map(c=>`${c.kind==='added'?'新增':c.kind==='removed'?'删除':'修改'}：${c.after||c.before}`).join('\n').slice(0,2400)}\n可撤销；尚未验证真机。`, `Action log: ${automatic?'AI automatically applied':'User confirmed'} changes. Added ${candidate.added} · Modified ${candidate.changed} · Removed ${candidate.removed}.\n${candidate.changes.map(c=>`${c.kind==='added'?'Added':c.kind==='removed'?'Removed':'Modified'}: ${c.after||c.before}`).join('\n').slice(0,2400)}\nUndoable; not yet verified on physical hardware.`)}]);
        setNotice(tr('已应用到当前工程。可点击撤销或使用 Ctrl+Z；保存工程后写入工程文件。', 'Applied to current project. Click Undo or press Ctrl+Z to revert; save the project to persist.'));
    };
    const uploadAppliedRepair=async(candidate:AiPreview)=>{
        const permit=uploadAfterApply.current;
        if(!permit||permit.candidate!==candidate)return false;
        uploadAfterApply.current=null;
        permit.check();
        if(!candidate.verifiedInputs)throw Error(tr('候选缺少主程序或附带文件的验证记录，未上传', 'Candidate lacks verified sketch or source inputs; upload skipped'));
        const selected=latest.current.devicePort;
        try {
            const ok=await latest.current.onVerifiedUpload(candidate.verifiedInputs,permit.check);
            if(!ok)throw Error(tr('上传未完成；请查看编译输出，排除错误后再授权', 'Upload did not complete; check build output and re-authorize after fixing errors'));
            const text=tr(`修复固件已上传到 ${selected}。尚未验证 LED、接线或其他实体行为。`, `Repaired firmware uploaded to ${selected}. Physical LEDs, wiring, and runtime behavior have not been verified.`);
            if(mount.current&&latest.current.devicePort===selected){setNotice(text);setMessages(old=>[...old,{id:crypto.randomUUID(),role:'assistant',text}]);}
            return true;
        }finally{try{permit.check();grant('upload',false);}catch{/* A revoked or replaced grant stays unchanged. */}}
    };
    const send = async (resume?: AiTaskCheckpoint) => {
        if ((!draft.trim() && !attachments.length && !resume) || importing || savingSettings || busy || applying || chatAction || !storeReady || !preferencesReady || props.disabledReason || storeError) return;
        if (!canConnect) { setPage('settings'); return; }
        if(!resume && aiAttachmentBytes(messages.flatMap(m=>m.attachments||[]))+2*aiAttachmentBytes(attachments)>8*1024*1024){setError(tr('这份聊天的附件接近上限，请新建聊天，或移除待发送附件；已有聊天保留。', 'Attachments in this chat are near the limit. Start a new chat or remove pending attachments; existing chats are preserved.'));return;}
        const controller = new AbortController(); request.current = controller;
        const started = performance.now();
        const current = () => mount.current && request.current === controller && !controller.signal.aborted;
        const prompt = resume ? tr('继续已保存任务，保留原需求和固定验收条件，重新验证后完成任务。', 'Resume the saved task, keep the original requirements and fixed acceptance checks, re-verify, and complete the task.') : draft.trim() || tr('请结合所附资料协助当前工程。', 'Please assist with the current project using the attached materials.');
        const privateFilter = latest.current.host.workspace() ? new AiPrivacyFilter(latest.current.host.workspace()!, connection.apiKey) : undefined;
        const safePrompt = privateFilter?.redact(prompt) || prompt;
        const requestIdentity = latest.current.host.identity();
        const requestSession = latest.current.sessionKey;
        const permit=authority.current, ticket=permit.ticket;
        uploadAfterApply.current=null;
        const mayUpload=!resume && scope.current.kind==='repair' && permit.grants.upload;
        const checkGrant=()=>{
            controller.signal.throwIfAborted();
            if(!mount.current||!latest.current.open||authority.current!==permit||!permit.grants.upload||permit.ticket!==ticket)throw Error(tr('单次上传授权已失效，未启动新的刷写', 'One-time upload grant expired; no new flash started'));
        };
        let committedLibrary = false, committedProject = false;
        const createdPaths:string[]=[];
        const sentAttachments = resume ? [] : attachments.map(f=>f.kind==='text'?{...f,content:privateFilter?.redact(f.content)||f.content}:f);
        setAttachments([]);
        setLibraryPreview(undefined); setLibraryLoaded(false);
        setAcceptance(resume?.acceptance); setBehavior(undefined); if (!resume) { setTask(undefined); setChat(old => ({ ...old, taskError: undefined })); }
        setDraft(''); setError(''); setNotice(''); setPreview(undefined); setStale(false); setStream(''); setBusy(true); setStopping(false); setPlan([]); setProgress([]); setValidations([]); follow.current = true;
        setMessages(old => [...old, { id: crypto.randomUUID(), role: 'user' as const, text: safePrompt, attachments: sentAttachments }]);
        if (!messages.length && (chat.title === '新聊天' || chat.title === 'New chat')) setChat(old => ({ ...old, title: safePrompt.replace(/\s+/g,' ').slice(0,60) }));
        try {
            const result = await runAiTask({ prompt, attachments: sentAttachments, autoApply: connection.autoApply, conversation: messages, memory, contextSettings: connection,
                resume, onCheckpoint: value => { if (mount.current && request.current === controller && latest.current.sessionKey === requestSession) setTask(value); },
                onAcceptance: value => { if (current()) setAcceptance(value); },
                onBehavior: value => { if (current()) { setBehavior(value); setMessages(old => [...old, { id: crypto.randomUUID(), role: 'assistant', text: tr(`行为验证记录：${value.status === 'passed' ? '固定场景通过' : value.status === 'failed' ? '存在失败断言' : '未验证'}，${value.checks.length} 项断言，${(value.elapsedMs/1000).toFixed(1)} 秒。${value.reason || ''}${value.checks.filter(c=>!c.ok).map(c=>`\n${c.id}：期望${c.expected}，实际${c.actual}`).join('').slice(0,2400)}\n固件指令模拟，未连接真机。`, `Behavior check: ${value.status === 'passed' ? 'scenario passed' : value.status === 'failed' ? 'assertions failed' : 'unverified'}, ${value.checks.length} assertions, ${(value.elapsedMs/1000).toFixed(1)}s. ${value.reason || ''}${value.checks.filter(c=>!c.ok).map(c=>`\n${c.id}: expected ${c.expected}, got ${c.actual}`).join('').slice(0,2400)}\nFirmware instruction simulation; no physical board connected.`) }]); } },
                onMemory: value => { if (current()) setMemory(value); }, onUsage: value => { if (current()) setUsage(value); },
                intent: scope.current, connection, host: {
                    workspace: () => latest.current.host.workspace(), catalog: () => latest.current.host.catalog(),
                    target: () => latest.current.host.target(), identity: () => latest.current.host.identity(),
                    get boardProfile() { return latest.current.host.boardProfile; },
                    get projectIdentity() { return latest.current.host.projectIdentity; },
                    get libraryInventory() { return latest.current.host.libraryInventory; },
                    get device(){return latest.current.host.device;},
                    grants:()=>authority.current===permit?permit.grants:noDeviceGrants,
                    diagnostics: () => latest.current.host.diagnostics(),
                    inspectCandidate: candidate => latest.current.host.inspectCandidate(candidate),
                    validateCandidate: (candidate, context) => latest.current.host.validateCandidate(candidate, context),
                    get validateBehavior() { return latest.current.host.validateBehavior; },
                    get library() { return latest.current.host.library; },
                }, transport: requestAiModel,
                confirmSources:files=>new Promise(resolve=>{
                    if(!current()||authority.current!==permit||!permit.grants.create){resolve(false);return;}
                    const abort=()=>finish(false);
                    const finish=(yes:boolean)=>{controller.signal.removeEventListener('abort',abort);clearTimeout(timer);setSourceReview(undefined);resolve(yes);};
                    const timer=setTimeout(abort,120000);
                    controller.signal.addEventListener('abort',abort,{once:true});
                    setStep(tr('等待确认新建文件', 'Waiting for confirmation to create files'));setPage('chat');setSourceReview({files,finish});
                }),
                onSourcesCreated:paths=>{
                    createdPaths.push(...paths);
                    if(mount.current && request.current===controller && latest.current.sessionKey===requestSession && chatRef.current.id===chat.id)
                        setMessages(old=>[...old,{id:crypto.randomUUID(),role:'assistant',text:tr(`工程文件已创建：\n${paths.join('\n')}\n已写入磁盘；可在工程文件树管理。`, `Project files created:\n${paths.join('\n')}\nWritten to disk; manage them in the Project Files tree.`)}]);
                },
                onPlan: steps => { if (current()) setPlan(steps); },
                onValidation: value => { if (current()) { setValidations(old => [...old, value]); setMessages(old => [...old, { id: crypto.randomUUID(), role: 'assistant', text: tr(`验证记录：${value.scope === 'library' ? `库「${value.label || ''}」` : '工程候选'}第 ${value.attempt} 次本地编译${value.ok ? '通过' : '未通过'}，${(value.elapsedMs / 1000).toFixed(1)} 秒，未应用、未上传。${value.diagnostics.map(d => d.message).join('；').slice(0, 1800)}`, `Validation: ${value.scope === 'library' ? `Library "${value.label || ''}"` : 'Project candidate'} attempt #${value.attempt} local build ${value.ok ? 'passed' : 'failed'} in ${(value.elapsedMs / 1000).toFixed(1)}s (not applied or uploaded). ${value.diagnostics.map(d => d.message).join('; ').slice(0, 1800)}`) }]); } },
                onLibraryInstalled: library => {
                    committedLibrary = true;
                    if (mount.current && request.current === controller && latest.current.sessionKey === requestSession) {
                        setMessages(old => [...old, { id: crypto.randomUUID(), role: 'assistant', text: tr(`补库记录：${library.name} v${library.version} 已验证、安装并加载，${library.types.length} 个新积木可用。正在继续原工程任务，${connection.autoApply?'验证成功后将自动应用工程修改':'工程方案仍需确认应用'}。尚未真机验证。`, `Library installed: ${library.name} v${library.version} verified, installed, and loaded (${library.types.length} new blocks available). Continuing original project task; ${connection.autoApply?'project edits will auto-apply after verification':'project changes still require confirmation'}. Not yet verified on hardware.`) }]);
                    }
                },
                signal: controller.signal, onText: text => { if (current()) setStream(text); }, onStep: text => {
                    if (current()) { setStep(text); setProgress(old => old[old.length - 1]?.text === text ? old : [...old.slice(-49), { text, elapsedMs: Math.round(performance.now() - started) }]); }
                } });
            if (!current()) { if(result.library) await latest.current.host.library?.discard(result.library.token); return; }
            planIdentity.current = result.identity || requestIdentity;
            setStream(''); setPreview(result.preview); setExpanded(false);
            setMessages(old => [...old, { id: crypto.randomUUID(), role: 'assistant' as const, text: result.text }]);
            if(result.preview && mayUpload && authority.current===permit && permit.ticket===ticket && permit.grants.upload){
                uploadAfterApply.current={candidate:result.preview,check:checkGrant};
            }
            if (result.preview && connection.autoApply) {
                await commitPreview(result.preview, result.identity || requestIdentity, requestSession, true, controller.signal);
                committedProject = true;
                await uploadAppliedRepair(result.preview);
            }
            if (result.library) {
                libraryIdentity.current = requestIdentity;
                setLibraryPreview(result.library);
                if (autoInstallLibrary) {
                    if (requestIdentity !== latest.current.host.identity()) throw Error(tr('工程或板卡已变化，库未安装', 'Project or board changed; library not installed'));
                    await latest.current.host.library!.install(result.library, controller.signal, text => { if(current())setStep(text); });
                    committedLibrary = true;
                    // Native finalization is the commit point. A stop pressed while
                    // its success reply is in flight cannot undo a completed install.
                    if(mount.current && latest.current.sessionKey === requestSession && pendingLibrary.current?.token === result.library.token) {
                        setLibraryLoaded(true); setNotice(tr('库已安装并加载。新积木已出现在分类和搜索中，可直接拖入，也可切回编程助手使用。', 'Library installed and loaded. New blocks are ready in toolbox categories and search.'));
                        setMessages(old => [...old,{id:crypto.randomUUID(),role:'assistant',text:tr(`安装记录：${result.library!.name} v${result.library!.version} 已加载，${result.library!.types.length}个积木可用。仅完成当前板卡试编译，尚未真机验证。`, `Install log: ${result.library!.name} v${result.library!.version} loaded with ${result.library!.types.length} blocks. Compiled for current board only; not verified on hardware.`)}]);
                    }
                }
            }
        } catch (cause) {
            if (current()) { setError(reasonText(cause)); setStream(''); setDraft(old=>old||prompt); setAttachments(sentAttachments); }
        } finally {
            if(mayUpload && authority.current===permit && permit.grants.upload && permit.ticket===ticket && (!uploadAfterApply.current || controller.signal.aborted))grant('upload',false);
            if (mount.current && request.current === controller) {
            if (controller.signal.aborted && latest.current.sessionKey === requestSession) { if(!committedProject)setPreview(undefined); setNotice((committedProject ? tr('积木修改已经应用，可撤销。后续任务已停止。', 'Block edits were already applied (undoable). Subsequent steps stopped.') : committedLibrary ? tr('已停止。已安装的库保留；当前工程积木未修改。', 'Stopped. Installed library was kept; project blocks were not modified.') : tr('已停止，本次请求未修改工程积木。', 'Stopped; no project blocks were modified.'))+(createdPaths.length?tr(` 已写入的 ${createdPaths.length} 个源码文件保留。`, ` ${createdPaths.length} written source file(s) were kept.`):'')); if(!committedProject){setDraft(old=>old||prompt);setAttachments(sentAttachments);} }
            setBusy(false); setStopping(false); setStep(''); request.current = null;
        } }
    };
    const installLibrary = async () => {
        if (!libraryPreview || busy || applying || props.disabledReason || !props.host.library) return;
        if(libraryIdentity.current !== props.host.identity()){setError(tr('板卡、工程或库集合已变化，请重新制作验证', 'Board, project, or installed libraries changed; please regenerate and re-verify'));return;}
        const controller=new AbortController();request.current=controller;setBusy(true);setStopping(false);setError('');
        const requestSession=props.sessionKey;
        try {
            await props.host.library.install(libraryPreview,controller.signal,setStep);
            if(mount.current && latest.current.sessionKey===requestSession && pendingLibrary.current?.token===libraryPreview.token){setLibraryLoaded(true);setNotice(controller.signal.aborted?tr('库已完成安装并加载；停止时安装已经提交。', 'Library installed and loaded; installation had already committed when stopped.'):tr('新库已安装并加载，可直接使用。', 'New library installed and loaded. Ready to use.'));setMessages(old=>[...old,{id:crypto.randomUUID(),role:'assistant',text:tr(`安装记录：${libraryPreview.name} v${libraryPreview.version} 已加载。`, `Install log: ${libraryPreview.name} v${libraryPreview.version} loaded.`)}]);}
        } catch(cause){if(mount.current&&request.current===controller){if(controller.signal.aborted)setNotice(tr('已停止安装，未完成的安装已撤回。', 'Installation stopped; incomplete install rolled back.'));else setError(reasonText(cause));}}
        finally{if(mount.current&&request.current===controller){setBusy(false);setStopping(false);setStep('');request.current=null;}}
    };
    const apply = async (compile: boolean) => {
        if (!preview || busy || applying || stale || props.disabledReason) return;
        const identity = props.sessionKey;
        const plan = preview;
        setApplying(true); setError(''); working.current = true;
        try {
            await commitPreview(plan, planIdentity.current, identity, false);
            if(await uploadAppliedRepair(plan))return;
            if (compile) {
                setNotice(tr('已应用，正在执行本地编译…', 'Applied; running local build…'));
                const result = await latest.current.onCompile();
                if (identity !== latest.current.sessionKey) return;
                setNotice(result.ok ? tr('本地编译通过。硬件运行效果仍需上传后验证。', 'Local build passed. Upload to hardware to verify runtime behavior.') : tr('本地编译未通过或已取消。可以撤销，或点击“分析最新错误”。', 'Local build failed or was cancelled. Undo or click "Analyze Latest Error".'));
                setMessages(old => [...old, { id: crypto.randomUUID(), role: 'assistant', text: result.ok ? tr('操作记录：本地编译通过，尚未验证实体硬件。', 'Action log: Local build passed; physical hardware not yet verified.') : tr('操作记录：本地编译失败或取消，需要读取最新诊断。', 'Action log: Local build failed or cancelled; inspect latest diagnostics.') }]);
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
            setConnection(value); setPage('chat'); setError(''); setNotice(value.rememberKey ? tr('全局设置已保存，密钥已用当前 Windows 用户加密，下次启动可继续使用。', 'Settings saved. API key is encrypted for the current Windows user and persists across restarts.') : tr('全局设置已保存；密钥仅在当前会话使用，已删除磁盘上的保存密钥。', 'Settings saved. API key is kept for this session only; any saved key on disk was cleared.'));
        } catch (cause) { setError(reasonText(cause)); }
        finally { setSavingSettings(false); }
    };
    const chooseChat = async (id?: string) => {
        if (busy || applying || chatAction) return; setChatAction(true);
        try { await flushChat(); const value = id ? await loadAiChat(id,props.projectKey) : newAiChat(props.projectKey);
            adoptChat(value); setPage('chat'); setIntent({id:Date.now(),kind:'generate'}); await refreshChats();
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
    const maxWidth = Math.max(0, Math.min(860, drawer ? available - 32 : available - 360));
    const minWidth = Math.min(320, maxWidth);
    const actualWidth = Math.max(minWidth, Math.min(panelWidth, maxWidth));
    return <aside ref={panel} className={`ck-ai-panel ${drawer ? 'ck-ai-panel--drawer' : ''} ${compact ? 'ck-ai-panel--compact' : ''} ${availableHeight < 360 ? 'ck-ai-panel--tight' : ''}`} style={{ width: actualWidth }}
        data-ck-role="ai-assistant" aria-label={tr('CK AI 积木助手', 'CK AI Assistant')} onKeyDown={event => {
            if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); if (page !== 'chat') setPage('chat'); else close(); }
        }}>
        <PanelResizeHandle target={panel} axis="width" size={actualWidth} min={minWidth} max={maxWidth} onCommit={savePanelWidth} label={tr('调整 AI 面板宽度', 'Resize AI panel width')} />
        <header className="ck-ai-header">
            <div className="ck-ai-heading"><span className="ck-ai-mark"><Sparkles size={15} /></span><strong>CK AI</strong>
                {page==='chat' && (chat.revision || messages.length || (storeStatus !== '新聊天' && storeStatus !== 'New chat')) ? <span className="ck-ai-chat-caption" title={`${chat.title} · ${storeStatus}`}>{chat.title === '新聊天' ? tr('新聊天', 'New chat') : chat.title}</span> : null}
            </div>
            <div className="ck-ai-actions">
                {page==='chat' && <>
                <button type="button" aria-label={tr('聊天记录', 'Chat history')} title={tr('聊天记录 · 切换、重命名、删除', 'Chat history · Switch, rename, delete')} disabled={busy || applying || importing || chatAction || !storeReady} onClick={() => {setPage('history');void flushChat().then(()=>refreshChats()).catch(cause=>setStoreError(reasonText(cause)));}}><History size={17}/></button>
                <button type="button" aria-label={tr('新对话', 'New chat')} title={tr('新对话', 'New chat')} disabled={busy || applying || chatAction || !storeReady} onClick={() => void chooseChat()}><Plus size={17} /></button>
                <button type="button" aria-label={tr('查看生成代码', 'View generated code')} title={tr('查看生成代码', 'View generated code')} onClick={props.onCode}><Code2 size={17} /></button>
                <button type="button" aria-label={tr('模型连接设置', 'Model connection settings')} title={tr('模型连接设置', 'Model connection settings')} disabled={busy || applying || !preferencesReady} onClick={() => { setPage('settings'); setError(''); }}><Settings2 size={17} /></button>
                </>}
                <button type="button" aria-label={tr('关闭 AI 面板', 'Close AI panel')} title={busy ? tr('停止请求并关闭', 'Stop request and close') : tr('关闭 AI 面板', 'Close AI panel')} disabled={applying} onClick={close}><X size={17} /></button>
            </div>
        </header>
        {page==='chat' && <>
          <div className="ck-ai-scopebar">
            <div className="ck-ai-task-modes" role="group" aria-label={tr('AI任务模式', 'AI task mode')}>
                <button type="button" aria-pressed={intent.kind !== 'library'} disabled={busy || applying} onClick={()=>startTask('generate')}>{tr('编程助手', 'Coding')}</button>
                <button type="button" aria-pressed={intent.kind === 'library'} disabled={busy || applying} onClick={()=>startTask('library')}>{tr('制作积木库', 'Library Builder')}</button>
            </div>
            <button type="button" className="ck-ai-access-entry" title={`${props.boardLabel || tr('尚未选择板卡', 'No board selected')} · ${tr('工程文件与设备权限', 'Project files & device permissions')}`} onClick={()=>setPage('access')}><CircuitBoard size={14}/>{tr('工程与设备', 'Project & Device')}</button>
          </div>
        </>}
        {page==='access' ? <section className="ck-ai-permissions" aria-label={tr('工程与设备', 'Project & Device')}>
            <button type="button" autoFocus className="ck-ai-back" onClick={()=>setPage('chat')}><ArrowLeft size={15}/>{tr('返回对话', 'Back to chat')}</button>
            <h2>{tr('工程与设备', 'Project & Device')}</h2><p>{tr('仅对当前对话与目标有效', 'Applies to this chat and target only')}</p>
            <fieldset><legend><FolderOpen size={15}/>{tr('工程文件', 'Project Files')}</legend><p title={projectPath}>{projectPath}</p>
                <label><span>{tr('读取工程源码', 'Read project source')}<small>{tr('文件内容可发送给所选模型', 'File contents may be sent to the selected model')}</small></span><input type="checkbox" checked={authority.current.grants.files} disabled={!props.projectPath||(busy&&!authority.current.grants.files)} onChange={e=>grant('files',e.target.checked)}/></label>
                <label><span>{tr('在 src/ 下新建源码', 'Create source files under src/')}<small>{folderProject?tr('保留已有文件，不覆盖同名文件', 'Keeps existing files without overwriting'):tr('需要先保存为独立文件夹工程', 'Save as a standalone folder project first')}</small></span><input type="checkbox" checked={authority.current.grants.create} disabled={!authority.current.grants.create&&(!folderProject||!!props.disabledReason||busy)} onChange={e=>grant('create',e.target.checked)}/></label>
            </fieldset>
            <fieldset><legend><CircuitBoard size={15}/>{tr('串口设备', 'Serial Device')}</legend><p>{props.boardLabel || tr('未选板卡', 'No board selected')} · {props.devicePort ? `${props.devicePort} · ${props.deviceBaud} baud` : tr('未选择串口', 'No port selected')}</p>
                {props.devicePort && <>
                    <label><span>{tr('读取串口回包', 'Read serial responses')}<small>{tr('新收到的文本可发送给模型', 'Newly received text may be sent to the model')}</small></span><input type="checkbox" checked={authority.current.grants.serial} disabled={busy&&!authority.current.grants.serial} onChange={e=>grant('serial',e.target.checked)}/></label>
                    <label><span>{tr('向设备发送调试文本', 'Send debug text to device')}</span><input type="checkbox" checked={authority.current.grants.send} disabled={!authority.current.grants.serial||(busy&&!authority.current.grants.send)} onChange={e=>grant('send',e.target.checked)}/></label>
                    <label><span>{tr('修复后上传一次', 'Upload once after fix')}<small>{tr('修复通过编译且应用后才写入设备', 'Flashes only after the fix compiles and is applied')}</small></span><input type="checkbox" checked={authority.current.grants.upload} disabled={busy&&!authority.current.grants.upload} onChange={e=>grant('upload',e.target.checked)}/></label>
                </>}
            </fieldset>
        </section> : page==='settings' ? <form className="ck-ai-settings" onSubmit={event => { event.preventDefault(); void saveSettings(); }}>
            <button type="button" className="ck-ai-back" onClick={() => { setPage('chat'); setError(''); }}><ArrowLeft size={15} />{tr('返回对话', 'Back to chat')}</button>
            <h2>{tr('连接你的模型', 'Connect Your Model')}</h2><p>{tr('模型服务由你选择，费用由服务商收取。', 'You choose the model provider and manage billing directly with them.')}</p>
            <label>{tr('API 地址', 'API Base URL')}<input autoFocus type="url" value={connection.baseUrl} placeholder="https://api.example.com/v1" autoComplete="off" spellCheck={false} onChange={e => {setManualModel(false);setConnection({ ...connection, baseUrl: e.target.value, modelChoices: [], reasoningEffort: 'auto', apiKey: connection.baseUrl===e.target.value?connection.apiKey:'' });}} /></label>
            <label>{tr('API 协议', 'API Protocol')}<select value={connection.apiProtocol ?? 'chat'} onChange={e=>setConnection({...connection,apiProtocol:e.target.value==='responses'?'responses':'chat'})}><option value="chat">Chat Completions</option><option value="responses">Responses</option></select></label>
            {connection.modelChoices.length>0 && <label>{tr(`模型名称（${connection.modelChoices.length} 个可选）`, `Model (${connection.modelChoices.length} available)`)}<select aria-label={tr('服务商模型列表', 'Provider model list')} value={customModel?'manual':listedModel?'id:'+connection.model:''} onChange={e=>{
                const choice=e.target.value;setManualModel(choice==='manual');
                setConnection({...connection,model:choice==='manual'?connection.model:choice.slice(3)});
            }}>
                {!connection.model && !manualModel && <option value="" disabled>{tr('选择模型', 'Select model')}</option>}
                <optgroup label={tr('服务商模型', 'Provider models')}>{connection.modelChoices.map(m=><option key={m} value={'id:'+m}>{m}</option>)}</optgroup>
                <option value="manual">{tr('手动填写…', 'Enter manually…')}</option>
            </select></label>}
            {(!connection.modelChoices.length || customModel) && <label>{connection.modelChoices.length?tr('自定义模型名称', 'Custom model name'):tr('模型名称', 'Model name')}<input aria-label={tr('手动填写模型名称', 'Custom model name')} value={connection.model} placeholder={tr('填写服务商提供的模型名称', 'Enter the model ID from your provider')} autoComplete="off" spellCheck={false} onChange={e => setConnection({ ...connection, model: e.target.value })} /></label>}
            <button type="button" className="ck-ai-secondary" disabled={loadingModels||!connection.baseUrl||!connection.apiKey} onClick={()=>void fetchModels()}>{loadingModels?tr('正在获取…', 'Fetching…'):tr('获取服务商模型列表', 'Fetch Provider Models')}</button>
            <label>{tr('API 密钥', 'API Key')}<input type="password" value={connection.apiKey} placeholder={tr('填写或替换密钥', 'Enter or replace API key')} autoComplete="off" spellCheck={false} onChange={e => {setManualModel(false);setConnection({ ...connection, apiKey: e.target.value, modelChoices: [] });}} /></label>
            <label className="ck-ai-checkbox"><input type="checkbox" checked={connection.rememberKey} onChange={e=>setConnection({...connection,rememberKey:e.target.checked})}/>{tr('在这台电脑记住密钥，所有工程共用', 'Remember API key on this PC for all projects')}</label>
            {connection.apiProtocol !== 'responses' && <label>{tr('思考参数协议', 'Reasoning protocol')}<select value={connection.reasoningProtocol} onChange={e=>setConnection({...connection,reasoningProtocol:e.target.value,reasoningEffort:'auto'})}><option value="auto">{tr('自动（识别官方 DeepSeek 地址）', 'Auto (detect official DeepSeek endpoint)')}</option><option value="standard">{tr('标准 reasoning_effort', 'Standard reasoning_effort')}</option><option value="deepseek">DeepSeek thinking + reasoning_effort</option></select></label>}
            <div className="ck-ai-setting-divider"/>
            <h3>{tr('上下文与用量', 'Context & Usage')}</h3>
            <label>{tr('上下文预算（tokens）', 'Context budget (tokens)')}<input aria-label={tr('上下文预算', 'Context budget')} type="number" min={16384} max={262144} step={1024} value={connection.contextTokens} onChange={e=>setConnection({...connection,contextTokens:Number(e.target.value)})}/></label>
            <label>{tr('单次回复预留（tokens）', 'Response reserve (tokens)')}<input aria-label={tr('单次回复预留', 'Response reserve')} type="number" min={1024} max={32768} step={1024} value={connection.responseTokens} onChange={e=>setConnection({...connection,responseTokens:Number(e.target.value)})}/></label>
            <label className="ck-ai-checkbox"><input type="checkbox" checked={connection.autoCompact} onChange={e=>setConnection({...connection,autoCompact:e.target.checked})}/>{tr('输入预算达到约 80% 时自动压缩', 'Auto-compact when input reaches ~80% of budget')}</label>
            <p className="ck-ai-privacy">{tr('预算应不超过所用模型的实际限制。包含工具定义、历史和回复预留，用量为估算，账单以服务商为准。压缩也会调用模型；完整聊天仍保留在本机。', 'Keep budget within your model’s real limit. Includes tool definitions, history, and reply reserve; counts are estimates. Compaction also calls the model while keeping full history locally.')}</p>
            <p className="ck-ai-privacy">{tr('密钥用当前 Windows 用户加密保存，不写入工程或导出包。修改 API 地址会清空输入框中的旧密钥，避免发给错误服务。', 'API keys are encrypted per Windows user and never written into projects or bundles. Changing the API URL clears the key field to prevent leaking it to another endpoint.')}</p>
            {error && <div role="alert" className="ck-ai-error"><CircleAlert size={16} /><span>{error}</span></div>}
            <button className="ck-ai-primary" type="submit" disabled={savingSettings}>{savingSettings?tr('正在保存…', 'Saving…'):tr('保存连接设置', 'Save Connection Settings')}<Check size={15} /></button>
        </form> : page==='history' ? <section className="ck-ai-history" aria-label={tr('当前工程聊天记录', 'Project chat history')}>
            <button type="button" autoFocus className="ck-ai-back" onClick={()=>setPage('chat')}><ArrowLeft size={15}/>{tr('返回对话', 'Back to chat')}</button>
            <div className="ck-ai-history-head"><div><h2>{tr('聊天记录', 'Chat History')}</h2><p>{tr('当前工程 · 本机保存', 'Current project · Saved locally')}</p></div><button type="button" className="ck-ai-secondary" disabled={chatAction} onClick={()=>void chooseChat()}><Plus size={14}/>{tr('新聊天', 'New chat')}</button></div>
            {storeError && <p role="alert" className="ck-ai-error">{storeError}</p>}
            {!chatList.length && <p className="ck-ai-history-empty">{tr('还没有已保存的聊天。发送第一条需求后会自动保存。', 'No saved chats yet. Chats save automatically after your first message.')}</p>}
            <div className="ck-ai-history-list">{chatList.map(row=><div key={row.id} className={`ck-ai-history-row ${row.id===chat.id?'is-active':''}`}>
                {renameId===row.id ? <form onSubmit={e=>{e.preventDefault();void renameChat();}}><input autoFocus aria-label={tr('聊天名称', 'Chat title')} maxLength={120} value={renameTitle} onChange={e=>setRenameTitle(e.target.value)}/><button className="ck-ai-secondary" disabled={chatAction||!renameTitle.trim()}>{tr('保存', 'Save')}</button><button type="button" className="ck-ai-text-button" onClick={()=>setRenameId('')}>{tr('取消', 'Cancel')}</button></form> : <>
                    <button type="button" className="ck-ai-chat-select" disabled={chatAction} onClick={()=>void chooseChat(row.id)}><strong>{row.title === '新聊天' ? tr('新聊天', 'New chat') : row.title}</strong><small>{new Date(row.updatedAt).toLocaleString()} · {tr(`${row.messages} 条消息`, `${row.messages} messages`)}</small></button>
                    <div className="ck-ai-chat-actions"><button type="button" aria-label={tr(`重命名 ${row.title}`, `Rename ${row.title}`)} disabled={chatAction} onClick={()=>{setRenameId(row.id);setRenameTitle(row.title);}}><Pencil size={14}/></button><button type="button" aria-label={tr(`删除 ${row.title}`, `Delete ${row.title}`)} disabled={chatAction} onClick={()=>setDeleteId(row.id)}><Trash2 size={14}/></button></div>
                </>}
                {deleteId===row.id && <div className="ck-ai-delete-confirm"><span>{tr('删除这份聊天记录？', 'Delete this chat?')}</span><button type="button" className="ck-ai-secondary" disabled={chatAction} onClick={()=>void removeChat(row.id)}>{tr('确认删除', 'Delete')}</button><button type="button" className="ck-ai-text-button" onClick={()=>setDeleteId('')}>{tr('取消', 'Cancel')}</button></div>}
            </div>)}</div>
        </section> : <>
            <div className="ck-ai-feed" ref={scroll} onScroll={() => { const node = scroll.current; if (node) follow.current = node.scrollHeight - node.clientHeight - node.scrollTop < 60; }}>
                {messages.length === 0 && !task && intent.kind === 'generate' && !draft && <div className="ck-ai-shortcuts" role="group" aria-label={tr('新对话快捷操作', 'Quick actions')}>
                    <button type="button" onClick={()=>startTask('generate',tr('让板载 LED 每秒闪烁', 'Make the onboard LED blink every second'))}><Plus size={14}/>{tr('闪灯示例', 'Blink example')}</button>
                    <button type="button" onClick={()=>startTask('explain',tr('解释当前程序', 'Explain the current program'))}><MessageSquare size={14}/>{tr('解释当前程序', 'Explain program')}</button>
                </div>}
                {storeError && <p role="alert" className="ck-ai-error">{storeError}</p>}
                {memory && <details className="ck-ai-memory"><summary>{tr(`已压缩 ${memory.compressions} 次 · 原聊天仍保留`, `Compacted ${memory.compressions}x · Full chat preserved`)}</summary><p>{memory.summary}</p></details>}
                {task && !busy && !preview && !libraryPreview && <section className="ck-ai-resume" aria-label={tr('已保存的任务草稿', 'Saved task draft')}>
                    <strong>{tr('任务草稿已保留', 'Saved task draft')}</strong><p>{tr(`${task.nodes.length} 个暂存节点 · ${task.acceptance?.requirements.length || 0} 项验收条件`, `${task.nodes.length} staged nodes · ${task.acceptance?.requirements.length || 0} acceptance checks`)}</p>
                    <small>{tr('继续时重新核对工程、板卡和库，并重新编译。不会自动应用旧方案。', 'Resuming re-checks project, board, and libraries and compiles again. Old proposals are never auto-applied.')}</small>
                    <div><button type="button" className="ck-ai-primary" disabled={applying || chatAction || !storeReady || Boolean(props.disabledReason) || Boolean(storeError)} onClick={()=>void send(task)}>{tr('继续任务', 'Resume task')}</button>
                    <button type="button" className="ck-ai-text-button" disabled={applying || chatAction} onClick={()=>{setTask(undefined);setChat(old=>({...old,taskError:undefined}));setAcceptance(undefined);setBehavior(undefined);}}>{tr('放弃草稿', 'Discard draft')}</button></div>
                </section>}
                {messages.length>visibleMessages&&<button type="button" className="ck-ai-secondary ck-ai-older" onClick={()=>{follow.current=false;setVisibleMessages(count=>count+80);}}>{tr(`查看更早的 ${Math.min(80,messages.length-visibleMessages)} 条消息`, `Load ${Math.min(80,messages.length-visibleMessages)} earlier messages`)}</button>}
                {messages.slice(-visibleMessages).map(message => <article key={message.id} className={`ck-ai-message ck-ai-message--${message.role}`}>
                    <span className="ck-ai-message-label">{message.role === 'user' ? tr('你', 'You') : 'CK AI'}</span><div>{message.text}</div>
                    {message.attachments?.map(file=><details className="ck-ai-attachment-view" key={file.id}><summary><FileText size={12}/>{file.name}</summary>{file.kind==='image'?<img src={file.content} alt={file.name}/>:<pre>{file.content}</pre>}</details>)}
                </article>)}
                {busy && <div className="ck-ai-current"><div className="ck-ai-step" role="status"><Loader2 size={14} className="ck-ai-spin" />{step || tr('正在连接模型', 'Connecting to model')}</div>{stream && <div className="ck-ai-stream">{stream}</div>}</div>}
                {sourceReview&&<section className="ck-ai-resume ck-ai-source-review" aria-label={tr('待创建的工程文件', 'Project files to create')}>
                    <strong>{tr(`新建 ${sourceReview.files.length} 个工程文件`, `Create ${sourceReview.files.length} project file(s)`)}</strong>
                    {sourceReview.files.map(f=><details key={f.path}><summary>{f.path}</summary><pre>{f.code}</pre></details>)}
                    <div><button className="ck-ai-primary" type="button" onClick={()=>sourceReview.finish(true)}>{tr('确认创建', 'Create')}</button><button className="ck-ai-text-button" type="button" onClick={()=>sourceReview.finish(false)}>{tr('取消', 'Cancel')}</button></div>
                </section>}
                {(plan.length > 0 || progress.length > 0) && <details className="ck-ai-task-progress"><summary>{tr(`任务过程 · ${progress.length} 条记录`, `Task progress · ${progress.length} steps`)}</summary>
                    {plan.length > 0 && <><strong>{tr('任务计划', 'Plan')}</strong><ol>{plan.map((text, i) => <li key={i}>{text}</li>)}</ol></>}
                    <ol>{progress.map((item, i) => <li key={i}><time>{(item.elapsedMs / 1000).toFixed(1)}s</time>{item.text}</li>)}</ol>
                </details>}
                {validations.length > 0 && <section className="ck-ai-validations" aria-label={tr('候选编译验证记录', 'Candidate build validation log')}>
                    <strong>{tr('方案本地验证记录', 'Local validation results')}</strong>
                    {validations.map(record => <details key={record.runId} className={record.ok ? 'is-pass' : 'is-fail'}>
                        <summary>{record.scope === 'library' ? tr('库', 'Library') : tr('工程', 'Project')} · {tr(`第 ${record.attempt} 次`, `Attempt #${record.attempt}`)} · {record.ok ? tr('编译通过', 'Build passed') : tr('编译未通过', 'Build failed')} · {(record.elapsedMs / 1000).toFixed(1)}s</summary>
                        {record.diagnostics.map((item, i) => <p key={i}>{item.label ? `${tr('积木：', 'Block: ')}${item.label}\n` : ''}{item.message}</p>)}
                        <pre>{record.log}</pre>
                    </details>)}
                    <small>{tr('编译结果仅对应这份候选方案；功能行为及真机效果仍需验证。', 'Build results apply to this candidate only; runtime behavior still needs hardware verification.')}</small>
                </section>}
                {task?.repairScope && <section className="ck-ai-repair-scope" aria-label={tr('固定的修复范围', 'Locked repair scope')}>
                    <strong>{tr(`修复范围 · 仅 ${task.repairScope.fields.length} 个既有字段`, `Repair scope · ${task.repairScope.fields.length} existing field(s)`)}</strong>
                    <p>{tr('首次送验为字段修改。后续修复保持积木结构和其他字段不变；需要扩展时会停止并说明。', 'Initial check only modified field values. Follow-up repairs keep block structure unchanged and pause if expansion is needed.')}</p>
                    <small>{tr('此检查限制修改范围，不代表全部需求或真机行为已验证。', 'This constrains edit scope and does not certify full hardware behavior.')}</small>
                </section>}
                {acceptance && <section className="ck-ai-acceptance" aria-label={tr('需求验收清单', 'Acceptance checklist')}>
                    <div className="ck-ai-acceptance-title"><strong>{tr('需求验收', 'Acceptance')}</strong><span>{tr('条件已固定', 'Locked')}</span></div>
                    <ul>{aiRequirementStatus(acceptance,behavior).map(row=><li key={row.id} data-status={row.status}>
                        <span className="ck-ai-verdict">{row.status === 'passed' ? tr('场景通过', 'Passed') : row.status === 'failed' ? tr('未通过', 'Failed') : tr('待验证', 'Pending')}</span><span>{row.text}<small>{row.method === 'simulation' ? tr('固件指令模拟', 'Instruction simulation') : row.method === 'hardware' ? tr('需要真实硬件', 'Requires real hardware') : tr('需要人工核对', 'Manual review required')}</small></span>
                    </li>)}</ul>
                    {behavior?.reason && <p>{behavior.reason}</p>}
                    {behavior && <details><summary>{tr(`查看本次 ${behavior.checks.length} 项断言`, `View ${behavior.checks.length} assertions`)}</summary>{behavior.checks.map(c=><p key={c.id}><b>{c.ok?tr('通过', 'Pass'):tr('失败', 'Fail')} · {c.id}</b><br/>{tr('期望：', 'Expected: ')}{c.expected}<br/>{tr('实际：', 'Actual: ')}{c.actual}</p>)}</details>}
                    <small>{tr('模拟通过仅覆盖列出的场景。第三方库无需额外接口；未模拟的硬件功能保持待验证。', 'Simulation covers only listed scenarios; unsimulated hardware behavior remains pending verification.')}</small>
                </section>}
                {libraryPreview && <section className="ck-ai-proposal" aria-label={tr('生成的积木库', 'Generated block library')}>
                    <div className="ck-ai-proposal-title"><Check size={16}/><strong>{libraryLoaded ? tr('库已加载', 'Library loaded') : tr('库已通过试编译', 'Library compiled')}</strong></div>
                    <p><b>{libraryPreview.name}</b> · v{libraryPreview.version}</p><p>{tr(`${libraryPreview.types.length} 个积木 · ${libraryPreview.files.length} 个文件`, `${libraryPreview.types.length} blocks · ${libraryPreview.files.length} files`)}</p>
                    <details className="ck-ai-library-files"><summary>{tr('查看库文件与试编译代码', 'View library files and test sketch')}</summary><ul>{libraryPreview.files.map(file=><li key={file}>{file}</li>)}</ul><pre>{libraryPreview.source}</pre></details>
                    <small>{tr('当前板卡试编译通过，尚未验证真机；安装后也可在库管理器卸载。', 'Test-compiled for the current board, not verified on hardware; can be uninstalled in Library Manager.')}</small>
                    <div className="ck-ai-proposal-actions">
                        {!libraryLoaded && <button type="button" className="ck-ai-primary" disabled={busy || applying || Boolean(props.disabledReason)} onClick={()=>void installLibrary()}>{tr('安装并加载', 'Install & Load')}</button>}
                        {libraryLoaded && <button type="button" className="ck-ai-primary" disabled={busy || applying} onClick={()=>{setIntent({id:Date.now(),kind:'generate'});setDraft(tr(`请使用刚创建的“${libraryPreview.name}”库搭建示例，先查询实际积木结构。`, `Build an example using the newly created "${libraryPreview.name}" library; inspect its actual block definitions first.`));input.current?.focus();}}>{tr('用这个库搭建程序', 'Build with this library')}</button>}
                        <button type="button" className="ck-ai-secondary" disabled={busy || applying} onClick={()=>{setApplying(true);void props.host.library?.export(libraryPreview).then(path=>{if(path)setNotice(tr(`已导出：${path}`, `Exported: ${path}`));}).catch(cause=>setError(reasonText(cause))).finally(()=>setApplying(false));}}>{tr('导出库 ZIP', 'Export ZIP')}</button>
                        {!libraryLoaded && <button type="button" className="ck-ai-text-button" disabled={busy || applying} onClick={()=>setLibraryPreview(undefined)}>{tr('放弃', 'Discard')}</button>}
                    </div>
                </section>}
                {preview && <section className="ck-ai-proposal" aria-label={tr('待确认的积木修改', 'Pending block edits')}>
                    <div className="ck-ai-proposal-title"><Check size={16} /><strong>{tr('修改预览', 'Edit preview')}</strong><span>{tr('尚未应用', 'Not applied')}</span></div>
                    <p>{tr('新增', 'Added')} <b>{preview.added}</b> · {tr('修改', 'Modified')} <b>{preview.changed}</b> · {tr('删除', 'Removed')} <b>{preview.removed}</b></p>
                    <button className="ck-ai-details" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{tr('查看具体变化', 'View detailed diff')}<ChevronDown size={14} /></button>
                    {expanded && <ul className="ck-ai-changes">{preview.changes.map(change => <li key={change.id}>
                        <span>{change.kind === 'added' ? tr('新增', 'Added') : change.kind === 'removed' ? tr('删除', 'Removed') : tr('修改', 'Modified')}</span>
                        {change.before && <div className={change.kind === 'removed' ? 'ck-ai-removed' : ''}>{change.before}</div>}
                        {change.after && <div>{change.kind === 'changed' ? '→ ' : ''}{change.after}</div>}
                    </li>)}</ul>}
                    <small>{tr('候选副本已通过结构检查和本地编译；尚未验证硬件。', 'Candidate passed structure validation and local compile; hardware not yet verified.')}</small>
                    {stale && <p role="status" className="ck-ai-stale">{tr('工程已有变化，请重新生成方案。', 'Project changed; please regenerate the proposal.')}</p>}
                    <div className="ck-ai-proposal-actions"><button type="button" className="ck-ai-primary" disabled={stale || applying || busy || Boolean(props.disabledReason)} onClick={() => void apply(false)}>{applying ? <Loader2 size={15} className="ck-ai-spin" /> : <Check size={15} />}{tr('应用修改', 'Apply')}</button>
                        <button type="button" className="ck-ai-secondary" disabled={stale || applying || busy || Boolean(props.disabledReason)} onClick={() => void apply(true)}>{tr('应用并编译', 'Apply & Build')}</button>
                        <button type="button" className="ck-ai-text-button" disabled={applying} onClick={() => setPreview(undefined)}>{tr('放弃', 'Discard')}</button></div>
                </section>}
                {error && <div role="alert" className="ck-ai-error"><CircleAlert size={16} /><span>{error}</span></div>}
                {notice && <div role="status" className="ck-ai-notice">{notice}</div>}
                {undoState && !busy && !applying && <button className="ck-ai-secondary ck-ai-undo" type="button" disabled={Boolean(props.disabledReason)} onClick={() => {
                    const workspace = props.host.workspace();
                    const stack = workspace?.getUndoStack() || [];
                    if (!workspace || aiWorkspaceSnapshot(workspace) !== undoState || stack[stack.length - 1] !== undoEvent.current) { setUndoState(undefined); setError(tr('工程已有其他修改，请使用 Ctrl+Z 按顺序撤销。', 'Other changes were made; use Ctrl+Z to undo in order.')); return; }
                    workspace.undo(false); setUndoState(undefined); setNotice(tr('已撤销本次 AI 修改。', 'Reverted this AI edit.'));
                    setMessages(old=>[...old,{id:crypto.randomUUID(),role:'assistant',text:tr('操作记录：用户已撤销本次 AI 修改。', 'Action log: User reverted this AI edit.')}]);
                }}><Undo2 size={14} />{tr('撤销本次修改', 'Undo this edit')}</button>}
            </div>
            <footer className="ck-ai-composer">
                {props.disabledReason && <p className="ck-ai-disabled" role="status">{props.disabledReason}</p>}
                {intent.kind === 'library' ? <label className="ck-ai-library-auto"><input type="checkbox" checked={autoInstallLibrary} disabled={busy || applying} onChange={e=>setAutoInstallLibrary(e.target.checked)}/>{tr('验证通过后自动安装并加载', 'Auto-install and load after verification')}</label> : intent.kind !== 'generate' && <div className="ck-ai-intent">{modeLabel[intent.kind]}{intent.blockId ? tr(' · 已选中积木', ' · Block selected') : ''}</div>}
                <input ref={fileInput} type="file" accept={AI_ATTACHMENT_ACCEPT} multiple hidden aria-label={tr('选择 AI 附件', 'Choose AI attachments')} onChange={e=>{const files=Array.from(e.target.files||[]);e.target.value='';void addAttachments(files);}}/>
                {attachments.length>0&&<div className="ck-ai-attachments" aria-label={tr('待发送附件', 'Pending attachments')}>{attachments.map(file=><div key={file.id}><span title={`${file.name} · ${Math.ceil(file.size/1024)} KB`}>{file.kind==='image'?<img src={file.content} alt=""/>:<FileText size={14}/>}<span>{file.name}</span></span><button type="button" aria-label={tr(`移除附件 ${file.name}`, `Remove attachment ${file.name}`)} disabled={busy||applying||importing} onClick={()=>setAttachments(old=>old.filter(f=>f.id!==file.id))}><X size={13}/></button></div>)}</div>}
                {attachments.length>0 && <small className="ck-ai-attachment-note">{tr('发送时，附件将一并发给所选模型服务。', 'Attachments will be sent to the selected model provider.')}</small>}
                <div className="ck-ai-input-shell"><textarea ref={input} value={draft} maxLength={6000} rows={1} aria-label={tr('发给 AI 的需求', 'Prompt for AI')} placeholder={intent.kind === 'library' ? tr('输入硬件型号、驱动接口和需要的积木…', 'Describe the hardware model, driver interface, and blocks needed…') : intent.kind === 'edit' ? tr('想怎样修改选中的积木？', 'How would you like to modify the selected blocks?') : tr('描述你想搭建或修改的功能…', 'Describe what you want to build or change…')} disabled={applying}
                    onPaste={event=>{const files=Array.from(event.clipboardData.files);if(files.length){event.preventDefault();void addAttachments(files);}}}
                    onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
                    <div className="ck-ai-input-bottom"><button type="button" className="ck-ai-attach" aria-label={tr('添加图片或文件', 'Attach image or file')} title={tr('添加图片或文件', 'Attach image or file')} disabled={busy||applying||importing} onClick={()=>fileInput.current?.click()}>{importing?<Loader2 size={16} className="ck-ai-spin"/>:<Paperclip size={16}/>}</button><button type="button" className="ck-ai-inline-action" disabled={busy||applying} onClick={()=>startTask('repair',tr('请读取最近一次编译的诊断，分析错误原因并提出最小修改方案。', 'Read the latest build diagnostics, explain the error, and propose a minimal fix.'))}><Wrench size={13}/>{tr('分析最新错误', 'Analyze Error')}</button>{busy ? <button type="button" className="ck-ai-send" aria-label={tr('停止 AI 请求', 'Stop AI request')} title={tr('停止请求', 'Stop')} disabled={stopping} onClick={stop}><Square size={14} fill="currentColor" /></button> : <button type="button" className="ck-ai-send" aria-label={tr('发送需求', 'Send prompt')} title={tr('发送（Ctrl + Enter）', 'Send (Ctrl + Enter)')} disabled={(!draft.trim()&&!attachments.length) || importing || savingSettings || applying || chatAction || !storeReady || !preferencesReady || Boolean(props.disabledReason) || Boolean(storeError)} onClick={() => void send()}><ArrowUp size={18} /></button>}</div>
                </div>
                <div className="ck-ai-controls" aria-label={tr('AI 模型与应用模式', 'AI model and apply mode')}>
                    {!canConnect ? <button className="ck-ai-model-connect" type="button" disabled={!preferencesReady||savingSettings||busy||applying} onClick={()=>{setPage('settings');setError('');}}><Settings2 size={13}/>{tr('连接模型', 'Connect Model')}</button> : <select aria-label={tr('当前 AI 模型', 'Active AI model')} title={connection.model || tr('选择模型', 'Select model')} value={connection.model} disabled={busy||applying||savingSettings} onChange={e=>{if(e.target.value==='__custom__')setPage('settings');else void updateControls({model:e.target.value,reasoningEffort:'auto'});}}>
                        {!connection.model&&<option value="">{tr('选择模型', 'Select model')}</option>}{[...new Set([connection.model,...connection.modelChoices].filter(Boolean))].map(m=><option value={m} key={m}>{m}</option>)}<option value="__custom__">{tr('添加 / 获取模型…', 'Add / Fetch models…')}</option>
                    </select>}
                    <select aria-label={tr('思考强度', 'Reasoning effort')} title={tr('思考强度：接口须支持所选档位', 'Reasoning effort (must be supported by API)')} value={connection.reasoningEffort} disabled={busy||applying||savingSettings} onChange={e=>void updateControls({reasoningEffort:e.target.value})}>{efforts.map(([value,label])=><option key={value} value={value}>{tr('思考', 'Think')} · {label}</option>)}</select>
                    <select className="ck-ai-apply-mode" aria-label={tr('AI 修改模式', 'AI apply mode')} value={connection.autoApply?'auto':'manual'} disabled={busy||applying||savingSettings} onChange={e=>void updateControls({autoApply:e.target.value==='auto'})}><option value="auto">{tr('AI 自动修改 · 积木可撤销', 'Auto-apply · Undoable')}</option><option value="manual">{tr('手动确认后修改', 'Ask before applying')}</option></select>
                </div>
                <div className="ck-ai-statusbar">
                    <div className="ck-ai-project-path"><FolderOpen size={12}/><span title={projectPath}>{projectPath}</span><button type="button" title={tr('复制工程路径', 'Copy project path')} aria-label={tr('复制工程路径', 'Copy project path')} disabled={!props.projectKey.startsWith('file:')} onClick={()=>void navigator.clipboard.writeText(projectPath).then(()=>setNotice(tr('工程路径已复制', 'Project path copied'))).catch(()=>setError(tr('复制失败，请从路径提示中查看', 'Copy failed; check the path tooltip')))}><Copy size={12}/></button></div>
                    <details className="ck-ai-context-details"><summary title={tr('查看上下文用量', 'View context usage')} aria-label={tr('查看上下文用量', 'View context usage')}><Gauge size={13}/>{usage ? `≈${Math.ceil(usage.estimatedInputTokens/100)/10}k / ` : ''}{Math.round(connection.contextTokens/1024)}k<ChevronDown size={11}/></summary>
                        <div className="ck-ai-usage">{tr(`上下文预算 ${Math.round(connection.contextTokens/1024)}k · 回复预留 ${connection.responseTokens.toLocaleString()} tokens`, `Budget ${Math.round(connection.contextTokens/1024)}k · Reserve ${connection.responseTokens.toLocaleString()} tokens`)}{usage?.requests ? tr(` · ${usage.requests} 次请求`, ` · ${usage.requests} requests`) : ''}</div>
                        {usage?.inputTokens!=null && <div className="ck-ai-token-detail">{tr(`服务商返回：输入 ${usage.inputTokens.toLocaleString()} / 输出 ${(usage.outputTokens||0).toLocaleString()} tokens（本次合计）`, `Provider usage: ${usage.inputTokens.toLocaleString()} in / ${(usage.outputTokens||0).toLocaleString()} out tokens (session total)`)}</div>}
                        <div role="status">{storeStatus}</div>
                    </details>
                </div>
            </footer>
        </>}
    </aside>;
}
