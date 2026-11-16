import * as Blockly from 'blockly';
import '../components/blockly_setup';
import {arduinoGenerator} from '../components/arduino_generator';

// Capture actual built-in implementation identities before extension loading.
// A package override is not silently replaced with a similarly named built-in.
const builtInBlocks = new Map(Object.entries(Blockly.Blocks));
const builtInGenerators = new Map(Object.entries(arduinoGenerator.forBlock));
const builtInInitializers = new Map(Object.entries(Blockly.Blocks).map(([type, definition]) => [type, definition.init]));
const builtInDefinitions = new Map(Object.entries(Blockly.Blocks).map(([type, definition]) => [type, Object.entries(definition)]));
const generatorImplementation = new Map(Object.entries(arduinoGenerator).filter(([key, value]) => (
    typeof value === 'function' || key.startsWith('ORDER_') || key === 'INDENT'
)));

function canUseBuiltInWorker(types: Set<string>) {
    return ![...generatorImplementation].some(([key, value]) => arduinoGenerator[key] !== value)
        && [...types].every(type => {
            const definition = Blockly.Blocks[type];
            const entries = builtInDefinitions.get(type);
            return builtInBlocks.get(type) === definition
                && builtInInitializers.get(type) === definition?.init
                && entries?.length === Object.keys(definition || {}).length
                && entries.every(([key, value]) => definition[key] === value)
                && builtInGenerators.has(type)
                && builtInGenerators.get(type) === arduinoGenerator.forBlock[type];
        });
}

export function createBlocklyCodePreview() {
    let worker: Worker | null = null;
    let version = 0;
    let disposed = false;
    let settle: ((value: string | null) => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cachedWorkspace: Blockly.WorkspaceSvg | null = null;
    let cachedState: ReturnType<typeof Blockly.serialization.workspaces.save> | null = null;
    const dirtyRoots = new Set<string>();
    const snapshotWorkspace = (workspace: Blockly.WorkspaceSvg) => {
        const serializers = Blockly.registry.getAllItems(Blockly.registry.Type.SERIALIZER, true);
        if (cachedWorkspace !== workspace || !cachedState?.blocks
            || !(serializers?.blocks instanceof Blockly.serialization.blocks.BlockSerializer)) {
            cachedState = Blockly.serialization.workspaces.save(workspace);
        } else {
            // Only simple field edits can use this cache. Topology, variable,
            // mutation, move, undo-create/delete and unknown events invalidate it.
            const blocks = cachedState.blocks.blocks.map((state: any) => dirtyRoots.has(state.id)
                ? Blockly.serialization.blocks.save(workspace.getBlockById(state.id)!, {addCoordinates:true,doFullSerialization:false})
                : state);
            const next: Record<string, unknown> = Object.create(null);
            for (const [key, serializer] of Object.entries(serializers || {})) {
                const value = key === 'blocks' ? {languageVersion:0,blocks} : (serializer as any).save(workspace);
                if (value) next[key] = value;
            }
            cachedState = next;
        }
        cachedWorkspace=workspace;dirtyRoots.clear();
        return cachedState;
    };
    const stop = () => {
        if (timer) clearTimeout(timer);
        timer = undefined;
        worker?.terminate(); worker = null;
        settle?.(null); settle = null;
    };
    return {
        seed(workspace: Blockly.WorkspaceSvg, state?: ReturnType<typeof Blockly.serialization.workspaces.save>) {
            cachedWorkspace=workspace;
            cachedState=state ?? Blockly.serialization.workspaces.save(workspace);
            dirtyRoots.clear();
        },
        invalidate(event?: {type?:string;element?:string;blockId?:string}, workspace?:Blockly.WorkspaceSvg) {
            version++;
            if (event?.type==='change' && event.element==='field' && event.blockId && workspace===cachedWorkspace && cachedState) {
                const block=workspace.getBlockById(event.blockId);
                if (block) dirtyRoots.add(block.getRootBlock().id);
                else cachedState=null;
            } else cachedState=null;
        },
        async request(workspace: Blockly.WorkspaceSvg, fqbn: string, locale: 'zh-CN' | 'en-US', snapshot?: ReturnType<typeof Blockly.serialization.workspaces.save>) {
            const id = ++version;
            stop();
            if (disposed || typeof Worker === 'undefined') return {current:!disposed,code:null};
            const blocks = workspace.getAllBlocks(false);
            const types = new Set(blocks.map(block => block.type));
            if (blocks.length < 2000 || !canUseBuiltInWorker(types)) return {current:true,code:null};
            const state = snapshot ?? snapshotWorkspace(workspace);
            const code = await new Promise<string | null>(resolve => {
                settle = resolve;
                try {
                    worker = new Worker(new URL('./blockly_preview.worker.ts', import.meta.url), {type:'module'});
                    const activeWorker = worker;
                    worker.onmessage = event => {
                        if (worker !== activeWorker || event.data.id !== id) return;
                        const result = typeof event.data.code === 'string' ? event.data.code : null;
                        if (timer) clearTimeout(timer);
                        timer=undefined; settle=null;worker?.terminate();worker=null;
                        resolve(result);
                    };
                    worker.onerror = () => { if (worker === activeWorker) stop(); };
                    timer=setTimeout(stop,120000);
                    // One JSON string avoids structured-cloning hundreds of
                    // thousands of tiny objects on the editor thread.
                    worker.postMessage({id,serialized:JSON.stringify(state),fqbn,locale});
                } catch { stop(); }
            });
            // Extensions can finish loading while a worker is running, without
            // a Blockly content event. Never publish a now-obsolete implementation.
            return {current: !disposed && version===id, code:canUseBuiltInWorker(types) ? code : null};
        },
        dispose() {disposed=true;version++;stop();cachedState=null;cachedWorkspace=null;dirtyRoots.clear();},
    };
}
