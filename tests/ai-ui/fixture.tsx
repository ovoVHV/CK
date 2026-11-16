import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Blockly from 'blockly';
import 'blockly/blocks';
import { AiAssistantPanel } from '../../desktop/apps/desktop/src/components/AiAssistantPanel';
import { setFixtureMode } from './tauri';
Blockly.defineBlocksWithJsonArray([
 { type:'fixture_loop',message0:'重复执行 %1',args0:[{type:'input_statement',name:'DO'}],colour:'#306d64' },
 { type:'fixture_delay',message0:'等待 %1 毫秒',args0:[{type:'field_number',name:'MS',value:1000,min:0}],previousStatement:null,nextStatement:null,colour:'#386f9f' },
]);
const catalog=['fixture_loop','fixture_delay'].map(type=>({type,keywords:[type],source:'toolbox' as const}));
function Fixture(){
 const canvas=useRef<HTMLDivElement>(null),workspace=useRef<Blockly.WorkspaceSvg|null>(null);
 const [open,setOpen]=useState(true),[dark,setDark]=useState(false),[board,setBoard]=useState('arduino:avr:uno'),[intent,setIntent]=useState({id:0,kind:'generate' as const});
 useEffect(()=>{if(!canvas.current)return;const ws=Blockly.inject(canvas.current,{toolbox:{kind:'categoryToolbox',contents:[]},scrollbars:true,trashcan:true,renderer:'zelos'});workspace.current=ws;
 Blockly.serialization.workspaces.load({blocks:{languageVersion:0,blocks:[{type:'fixture_loop',id:'loop',x:60,y:60,inputs:{DO:{block:{type:'fixture_delay',id:'delay',fields:{MS:1000}}}}}]}},ws);
 const resize=()=>Blockly.svgResize(ws);window.addEventListener('resize',resize);return()=>{window.removeEventListener('resize',resize);ws.dispose();};},[]);
 useEffect(()=>{document.documentElement.classList.toggle('dark',dark);},[dark]);
 return <div className="fixture-shell"><div className="fixture-label">CK AI · 本地界面验收 / 模型响应为测试数据，不代表模型效果</div>
 <header className="fixture-toolbar"><strong>CK <span>编辑工作台</span></strong><div><button onClick={()=>setDark(!dark)}>切换明暗</button><select aria-label="测试场景" onChange={e=>setFixtureMode(e.target.value)}><option value="normal">修改方案</option><option value="long">长回复</option><option value="error">服务错误</option><option value="slow">慢响应/取消</option></select><button onClick={()=>setBoard(board.includes('uno')?'esp32:esp32:esp32s3 · Core 3.3.6-cn · PSRAM enabled':'arduino:avr:uno')}>切换板卡</button><button onClick={()=>{setOpen(!open);setIntent({id:Date.now(),kind:'generate'});}}>AI 助手</button></div></header>
 <main className="fixture-main"><div className="fixture-canvas" ref={canvas}/><AiAssistantPanel open={open} intent={intent} sessionKey={board}
 host={{workspace:()=>workspace.current,catalog:()=>catalog,target:()=>({board}),identity:()=>board,diagnostics:()=>[{diagnostic:'测试错误：缺少声明',blockId:'delay'}]}}
 boardLabel={board} onClose={()=>setOpen(false)} onCode={()=>setOpen(false)} onLayout={()=>{if(workspace.current)Blockly.svgResize(workspace.current);}}
 beforeApply={async()=>{}} onCompile={async()=>({ok:false,log:'测试模式没有执行编译'})}/></main><footer className="fixture-status">就绪 · 实际 Blockly 工作区 / 可预览、应用和撤销</footer></div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
