import type {
    AgentCompileOptions,
    AgentCompileResult,
    AgentInjectMode,
    AgentInjectResult,
    AgentLibraryInstallResult,
    AgentToolboxSnapshot,
    CKBlocklyAgentBridge,
    CKBlocklyAgentContextSnapshot,
} from '../types/agent';

export interface AgentRequirementPlan {
    requiredBlockTypes: string[];
    installCandidates?: Array<{ name: string; version?: string | null }>;
}

export interface AgentRequirementResult {
    satisfied: boolean;
    missingBlockTypes: string[];
    installedLibraries: string[];
    installAttempts: Array<{ name: string; ok: boolean; message: string }>;
}

const getBridge = (): CKBlocklyAgentBridge => {
    if (typeof window === 'undefined' || !window.CK_BLOCKLY_AGENT) {
        throw new Error('Blockly Agent Bridge is not ready');
    }
    return window.CK_BLOCKLY_AGENT;
};

const resolveMissingTypes = (
    toolbox: AgentToolboxSnapshot,
    requiredBlockTypes: string[]
): string[] => {
    const available = new Set(toolbox.blocks.map((item) => item.type));
    const missing = new Set<string>();
    for (const type of requiredBlockTypes) {
        const clean = String(type || '').trim();
        if (!clean) continue;
        if (!available.has(clean)) {
            missing.add(clean);
        }
    }
    return Array.from(missing);
};

export const BlocklyAgent = {
    bridge(): CKBlocklyAgentBridge {
        return getBridge();
    },

    async collectContext(): Promise<CKBlocklyAgentContextSnapshot> {
        return getBridge().collectContext();
    },

    async installLibrary(name: string, version?: string | null): Promise<AgentLibraryInstallResult> {
        return getBridge().installLibrary(name, version);
    },

    injectBlocks(xml: string, mode: AgentInjectMode = 'append'): AgentInjectResult {
        return getBridge().injectBlocks(xml, mode);
    },

    clearWorkspace(): { clearedBlocks: number } {
        return getBridge().clearWorkspace();
    },

    async compile(options?: AgentCompileOptions): Promise<AgentCompileResult> {
        return getBridge().compile(options);
    },

    async ensureRequirements(plan: AgentRequirementPlan): Promise<AgentRequirementResult> {
        const bridge = getBridge();
        const installedLibraries: string[] = [];
        const installAttempts: Array<{ name: string; ok: boolean; message: string }> = [];

        let toolbox = bridge.readToolboxBlocks();
        let missingBlockTypes = resolveMissingTypes(toolbox, plan.requiredBlockTypes || []);
        if (missingBlockTypes.length === 0) {
            return {
                satisfied: true,
                missingBlockTypes: [],
                installedLibraries,
                installAttempts,
            };
        }

        const candidates = plan.installCandidates || [];
        for (const candidate of candidates) {
            if (missingBlockTypes.length === 0) break;
            const name = String(candidate?.name || '').trim();
            if (!name) continue;

            const installRes = await bridge.installLibrary(name, candidate.version ?? null);
            installAttempts.push({ name, ok: installRes.ok, message: installRes.message });
            if (installRes.ok) {
                installedLibraries.push(installRes.installedTarget);
                toolbox = bridge.readToolboxBlocks();
                missingBlockTypes = resolveMissingTypes(toolbox, plan.requiredBlockTypes || []);
            }
        }

        return {
            satisfied: missingBlockTypes.length === 0,
            missingBlockTypes,
            installedLibraries,
            installAttempts,
        };
    },
};
