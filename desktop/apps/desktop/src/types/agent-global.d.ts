import type { CKBlocklyAgentBridge, CKBlocklyAgentContextSnapshot } from './agent';
import type { BlockCatalogSnapshot } from '../services/block_catalog';

declare global {
    interface Window {
        CK_BLOCKLY_AGENT?: CKBlocklyAgentBridge;
        CK_Agent_Context?: CKBlocklyAgentContextSnapshot | null;
        CK_BLOCK_CATALOG?: BlockCatalogSnapshot;
    }
}

export {};
