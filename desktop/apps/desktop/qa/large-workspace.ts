// Isolated browser benchmark: real CK blocks/generator and production services.
// No native IPC, user projects, installed libraries or compiler invocations.
import * as Blockly from 'blockly';
import '../src/components/blockly_setup';
import { setBlocklyBoard } from '../src/components/blockly_setup';
import { arduinoGenerator } from '../src/components/arduino_generator';
import { createBlocklyEditScheduler } from '../src/services/blockly_edit_scheduler';
import { installBlocklyViewportCulling } from '../src/services/blockly_viewport';
import { applyBlocklyVisualSkin, applyBlocklyVisualSkinToBlocks } from '../src/services/blockly_visual_skin';
import { refreshBlockBreakpointVisuals } from '../src/services/block_breakpoints';
import { shouldProcessBlocklyContentEvent } from '../src/services/blockly_change_guard';
import {createBlocklyCodePreview} from '../src/services/blockly_code_preview';
import {loadBlocklyWorkspaceProgressively} from '../src/services/blockly_progressive_load';

setBlocklyBoard('arduino:avr:uno');
const ws = Blockly.inject(document.getElementById('workspace')!, {
    renderer: 'thrasos', sounds: false, trashcan: true,
    move: {scrollbars:true,drag:true,wheel:true},
    zoom: {controls:true,wheel:true,startScale:0.7,minScale:0.3,maxScale:2},
});
let viewport: ReturnType<typeof installBlocklyViewportCulling> | undefined;
let loading = false, optimized = true, generations = 0;
const generationMs: number[] = [];
const preview=createBlocklyCodePreview();
let pendingPreview:Promise<void>|null=null;
const backends:string[]=[];
const update = () => { pendingPreview=(async()=>{
    const start = performance.now();
    const result=optimized?await preview.request(ws,'arduino:avr:uno','zh-CN'):{current:true,code:null};
    if(!result.current)return;
    backends.push(result.code===null?'main-thread':'worker');
    if(result.code===null)arduinoGenerator.workspaceToCode(ws);
    generationMs.push(performance.now() - start);
    generations++;
    refreshBlockBreakpointVisuals(ws, new Set());
})(); };
const scheduler = createBlocklyEditScheduler(update, {isInteracting:()=>ws.isDragging()});
ws.addChangeListener((e:any)=>{
    if(loading || !shouldProcessBlocklyContentEvent(e)) return;
    preview.invalidate(e,ws);
    if(optimized) {
        const block=e.blockId && ws.getBlockById(e.blockId);
        if(block) applyBlocklyVisualSkinToBlocks([block], 'original');
        scheduler.schedule();
    } else {
        update();
        applyBlocklyVisualSkin(ws,'original');
    }
});
const frame = ()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
const hash = async(text:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(x=>x.toString(16).padStart(2,'0')).join('');
const percentile=(values:number[],q:number)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*q))] || 0;
const state=()=>JSON.stringify(Blockly.serialization.workspaces.save(ws));
const number=(id:string,value:number)=>({type:'math_number',id,fields:{NUM:value}});
let originalState = '';
const api = {
    workspace:ws,
    async load(count=50100,useOptimization=true) {
        loading=true; optimized=useOptimization; scheduler.cancel(); viewport?.dispose(); ws.clear();
        const start=performance.now();let produced=0;
        const entries:any[]=[];
        const loadFrames:number[]=[];let lastFrame=start,sampling=true;
        const sample=()=>{if(!sampling)return;const now=performance.now();loadFrames.push(now-lastFrame);lastFrame=now;requestAnimationFrame(sample);};
        requestAnimationFrame(sample);
        try {
            let stack=0;
            while(produced<count) {
                let head:any,tail:any;
                for(let j=0;j<50 && produced<count;j++) {
                    const id=`stress-${produced}`;
                    const entry:any={type:'io_digital_write',id,inputs:{PIN:{block:number(`${id}-pin`,13)},LEVEL:{block:number(`${id}-level`,1)}}};
                    if(!head) head=entry;else tail.next={block:entry};tail=entry;produced+=3;
                }
                head.x=(stack%20)*620+30;head.y=Math.floor(stack/20)*2800+30;
                entries.push(head);
                stack++;
            }
            if(optimized) {
                viewport=installBlocklyViewportCulling(ws);
                viewport.beginBulkLoad();
                await loadBlocklyWorkspaceProgressively({blocks:{languageVersion:0,blocks:entries}},ws,{
                    stageStack:block=>viewport!.stageLoadedStack(block),
                    onProgress:progress=>{document.getElementById('status')!.textContent=` ${progress.completed} / ${progress.total} blocks`;},
                });
                viewport.endBulkLoad();
            } else Blockly.serialization.workspaces.load({blocks:{languageVersion:0,blocks:entries}},ws);
        } finally {loading=false;}
        await frame();await frame();
        sampling=false;
        originalState=state();preview.seed(ws,JSON.parse(originalState));generations=0;generationMs.length=0;
        const result={requested:count,count:ws.getAllBlocks(false).length,loadMs:performance.now()-start,loadFrameP95:percentile(loadFrames,0.95),loadFrameMax:Math.max(...loadFrames),svgNodes:ws.getParentSvg().querySelectorAll('*').length,viewport:viewport?.stats};
        document.getElementById('status')!.textContent=` ${result.count} blocks loaded`;
        return result;
    },
    async motion() {
        scheduler.flush();const before=state();const deltas:number[]=[];let previous=performance.now();
        for(let i=0;i<90;i++) {ws.scroll(-((i%30)*15),-((i%30)*20));await frame();const now=performance.now();deltas.push(now-previous);previous=now;}
        const zoomStates:any[]=[];
        for(const scale of [0.6,0.5,0.4,0.3,0.3,0.4,0.5,0.6,0.7,1,0.3,1]){
            ws.setScale(scale);await frame();await frame();const now=performance.now();deltas.push(now-previous);previous=now;
            zoomStates.push({scale,overview:viewport?.stats.overview,svgNodes:ws.getParentSvg().querySelectorAll('*').length});
        }
        ws.zoomToFit();await frame();await frame();const fit={scale:ws.scale,overview:viewport?.stats.overview};
        ws.setScale(0.3);await frame();await frame();
        const proxy=ws.getCanvas().querySelector('[data-ck-overview-id]');
        proxy?.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));await frame();await frame();
        const doubleClickRestored=ws.scale>=0.8&&!viewport?.stats.overview;
        const after=state();return {p50:percentile(deltas,0.5),p95:percentile(deltas,0.95),max:Math.max(...deltas),panP95:percentile(deltas.slice(0,90),0.95),zoomP95:percentile(deltas.slice(90),0.95),unchanged:before===after,viewport:viewport?.stats,zoomStates,fit,doubleClickRestored};
    },
    async edit() {
        const block=ws.getBlockById('stress-0-level')!;const before=state();const sourceBefore=arduinoGenerator.workspaceToCode(ws);generations=0;generationMs.length=0;
        const start=performance.now();Blockly.Events.setGroup(true);
        for(let i=0;i<12;i++)block.setFieldValue(String(i+2),'NUM');
        Blockly.Events.setGroup(false);
        const frames:number[]=[];let last=performance.now(), sampling=true;
        const sample=()=>{if(!sampling)return;const now=performance.now();frames.push(now-last);last=now;requestAnimationFrame(sample);};requestAnimationFrame(sample);
        await new Promise(r=>setTimeout(r,1200));scheduler.flush();await pendingPreview;sampling=false;
        const editWall=performance.now()-start;const code=arduinoGenerator.workspaceToCode(ws);
        ws.undo(false);await new Promise(r=>setTimeout(r,400));scheduler.flush();await pendingPreview;
        const undoRestored=before===state();const codeRestored=sourceBefore===arduinoGenerator.workspaceToCode(ws);
        ws.undo(true);await new Promise(r=>setTimeout(r,400));scheduler.flush();await pendingPreview;
        return {editWall,generations,generationMs,backends,editFrameP95:percentile(frames,0.95),editFrameMax:Math.max(...frames),undoRestored,codeRestored,redoValue:block.getFieldValue('NUM'),sourceChanged:sourceBefore!==code,codeHash:await hash(code),stateBytes:before.length};
    },
    async verify() {
        scheduler.flush();const current=state();const headless=new Blockly.Workspace();
        try {
            Blockly.serialization.workspaces.load(JSON.parse(current),headless);
            const actual=arduinoGenerator.workspaceToCode(ws), restored=arduinoGenerator.workspaceToCode(headless);
            return {count:ws.getAllBlocks(false).length,restoredCount:headless.getAllBlocks(false).length,codeEqual:actual===restored,stateHash:await hash(current),codeHash:await hash(actual),initialStateBytes:originalState.length};
        }finally{headless.dispose();}
    },
    async offscreenEdit() {
        scheduler.cancel();loading=true;
        const root=ws.getTopBlocks(false).at(-1)!;
        const number=root.getInputTargetBlock('LEVEL')!;
        const value=number.getFieldValue('NUM');const before=state();
        const wasParked=root.getSvgRoot().parentElement?.hasAttribute('data-ck-viewport-parking');
        Blockly.Events.disable();
        try{
            number.setFieldValue(12345678,'NUM');await frame();await frame();
            const parkedBounds=root.getBoundingRectangle();
            viewport?.dispose();viewport=undefined;
            number.render();root.render();await frame();await frame();
            const shownBounds=root.getBoundingRectangle();
            const geometryEqual=JSON.stringify(parkedBounds)===JSON.stringify(shownBounds);
            number.setFieldValue(value,'NUM');await frame();await frame();
            viewport=optimized?installBlocklyViewportCulling(ws):undefined;await frame();await frame();
            return {wasParked,geometryEqual,unchanged:before===state()};
        } finally{Blockly.Events.enable();loading=false;}
    },
};
(window as any).CK_STRESS=api;
