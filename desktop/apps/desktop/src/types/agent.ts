export type AgentInjectMode = 'append' | 'replace';

export interface AgentWorkspaceBlockSummary {
    id: string;
    type: string;
    parentId: string | null;
    nextId: string | null;
    fieldValues: Record<string, string>;
}

export interface AgentWorkspaceSnapshot {
    blockCount: number;
    topBlockTypes: string[];
    blocks: AgentWorkspaceBlockSummary[];
    json: string;
    xml: string;
    code: string;
}

export interface AgentToolboxEntry {
    type: string;
    category: string;
    categoryPath: string;
    displayPath: string;
    xmlTemplate: string;
    keywords: string | string[];
    libraryId?: string | null;
}

export interface AgentToolboxSnapshot {
    blockCount: number;
    blocks: AgentToolboxEntry[];
}

export interface AgentBoardInfo {
    activeBoard: string;
    fqbn: string;
    boardName: string;
    options: Record<string, string>;
    pins: Array<[string, string]>;
    detailsRaw: unknown | null;
}

export interface AgentLibraryInfo {
    id: string;
    name: string;
    version: string;
    location: string;
    path: string;
}

export interface AgentPinUsage {
    pin: string;
    blockId: string;
    blockType: string;
    fieldName: string;
}

export interface AgentPinConflict {
    pin: string;
    usages: AgentPinUsage[];
}

export interface AgentPinConflictResult {
    usages: AgentPinUsage[];
    conflicts: AgentPinConflict[];
}

export interface AgentIssueOption {
    id: string;
    label: string;
    impact: string;
}

export interface AgentDiagnosis {
    issueId: string;
    summary: string;
    reason: string;
    options: AgentIssueOption[];
}

export interface AgentLibraryInstallResult {
    ok: boolean;
    installedTarget: string;
    message: string;
}

export interface AgentInjectResult {
    mode: AgentInjectMode;
    insertedBlockIds: string[];
    insertedCount: number;
    stitchedCount?: number;
    totalBlockCount: number;
    error?: string;
}

export interface AgentCompileOptions {
    code?: string;
    fqbn?: string;
    silent?: boolean;
}

export interface AgentCompileResult {
    ok: boolean;
    fqbn: string;
    code: string;
    log: string;
    diagnosis: AgentDiagnosis | null;
    rawResult: string;
}

export interface AgentGlmChatRequest {
    images?: string[];
    reasoningEffort?: string;
    reasoningProtocol?: string;
    historyMessages?: Array<{
        role: 'user' | 'assistant' | 'system' | 'tool';
        content: string;
        images?: string[];
        tool_calls?: any[];
        tool_call_id?: string;
        reasoning_content?: string;
        name?: string;
    }> | null;
    apiKey?: string | null;
    model?: string | null;
    runId?: string | null;
    userMessage: string;
    systemPrompt?: string | null;
    contextJson?: string | null;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    tools?: any[];
    toolChoice?: any;
    baseUrl?: string;
}

export interface AgentGlmChatResult {
    model: string;
    content: string;
    finishReason: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    rawJson: string;
    toolCalls?: any[];
    reasoningContent?: string | null;
}

export interface AgentLlmDeltaPayload {
    runId: string;
    delta: string;
    reasoningDelta: string | null;
    done: boolean;
    model: string | null;
    finishReason: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    toolCalls?: any[];
}

export interface CKBlocklyAgentContextSnapshot {
    collectedAt: string;
    hardware: AgentBoardInfo;
    toolbox: AgentToolboxSnapshot;
    workspace: AgentWorkspaceSnapshot;
    libraries: AgentLibraryInfo[];
    pinConflicts: AgentPinConflictResult;
}

export interface CKBlocklyAgentBridge {
    readWorkspaceBlocks: () => AgentWorkspaceSnapshot;
    readToolboxBlocks: () => AgentToolboxSnapshot;
    getBoardInfo: () => Promise<AgentBoardInfo>;
    getInstalledLibraries: () => Promise<AgentLibraryInfo[]>;
    installLibrary: (name: string, version?: string | null) => Promise<AgentLibraryInstallResult>;
    injectBlocks: (xml: string, mode?: AgentInjectMode) => AgentInjectResult;
    clearWorkspace: () => { clearedBlocks: number };
    compile: (options?: AgentCompileOptions) => Promise<AgentCompileResult>;
    checkPinConflicts: () => AgentPinConflictResult;
    diagnoseError: (log: string) => AgentDiagnosis;
    collectContext: () => Promise<CKBlocklyAgentContextSnapshot>;
    getBlockDetails: (blockType: string) => { xmlTemplate: string; generatedCode: string; fields: string[]; inputs: Array<{ name: string; type: string }>; error?: string };
    injectRawArduinoCode: (setupCode: string, loopCode: string) => { ok: boolean; message: string };
    batchCreateBlocks: (args: BatchCreateBlocksArgs) => BatchCreateBlocksResult;
    buildProgram: (program: { setup?: any[]; loop?: any[] }) => { success: boolean; error?: string; totalBlocks: number };
}

// ============================================================
// batchCreateBlocks 扁平化积木创建接口
// ============================================================

/** 单个积木的配置 */
export interface BatchBlockConfig {
    /** 临时 ID，用于 connections 中引用（如 "b1", "b2"） */
    id: string;
    /** 积木类型名 */
    type: string;
    /** 字段键值对 */
    fields?: Record<string, any>;
    /** 输入配置（shadow 块或引用其他临时 ID） */
    inputs?: Record<string, {
        shadow?: { type: string; fields?: Record<string, any> };
        blockRef?: string;
    }>;
}

/** 连接规则 */
export interface BatchConnectionRule {
    /** 要操作的积木（临时 ID） */
    block: string;
    /** 连接动作：put_into=放入容器, chain_after=串联在后面, set_as_input=设置为值输入 */
    action: 'put_into' | 'chain_after' | 'set_as_input';
    /** 目标积木（临时 ID 或已有积木的真实 ID） */
    target: string;
    /** 目标输入名（set_as_input 和 put_into 时使用） */
    input?: string;
}

/** batchCreateBlocks 的参数 */
export interface BatchCreateBlocksArgs {
    blocks: BatchBlockConfig[];
    connections: BatchConnectionRule[];
    position?: { x: number; y: number };
}

/** batchCreateBlocks 的返回值 */
export interface BatchCreateBlocksResult {
    success: boolean;
    createdBlocks: Array<{ tempId: string; realId: string; type: string; ok: boolean; message?: string }>;
    connectionResults: Array<{ rule: BatchConnectionRule; ok: boolean; message?: string }>;
    totalBlockCount: number;
    error?: string;
}
