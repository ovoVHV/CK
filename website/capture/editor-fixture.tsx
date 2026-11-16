// Local screenshot fixture: real editor components with an explicitly labeled sample.
import React, {useEffect, useRef, useState} from 'react';
import * as Blockly from 'blockly';
import {getToolbox} from '../../desktop/apps/desktop/src/components/blockly_setup';
import {BlockDock} from '../../desktop/apps/desktop/src/components/BlockDock';
import {BuildIssueCards} from '../../desktop/apps/desktop/src/components/BuildIssueCards';
import {buildBlockCatalog} from '../../desktop/apps/desktop/src/services/block_catalog';
import {getBlocklyVisualTheme} from '../../desktop/apps/desktop/src/theme/blockly_visual_themes';
import {markCompileError, revealCompileError} from '../../desktop/apps/desktop/src/services/compile_block_feedback';
import type {CompileIssueCard} from '../../desktop/apps/desktop/src/services/compile_issue_cards';

const theme=getBlocklyVisualTheme('original','dark');
const issue:CompileIssueCard={id:'compiler-diagnostic',severity:'error',certainty:'certain',title:'赋值目标不是变量',summary:'数字 1 不能作为赋值目标。请在左侧放入可以修改的变量。',explanationCode:'compile.diagnostic.generic',explanationParams:{},rawDiagnostic:'lvalue required as left operand of assignment',evidence:'lvalue required as left operand of assignment',sourceFile:'sketch.ino',sourceLine:4,sourceColumn:5,details:[],blockContext:{blockId:'bad-assignment',blockType:'math_compound_assign_custom',label:'1 += 0',section:'loop',sourceLine:4,flowLocation:'循环中',confidence:'exact'}};
export function EditorFixture({error=false}:{error?:boolean}){
 const mount=useRef<HTMLDivElement>(null),[workspace,setWorkspace]=useState<Blockly.WorkspaceSvg|null>(null);
 useEffect(()=>{
  const labels=new Blockly.Workspace();
  window.CK_BLOCK_CATALOG=buildBlockCatalog('arduino:avr:uno',getToolbox('arduino:avr:uno','', '1.8.6'),[],type=>{let b;try{b=labels.newBlock(type);return b.toString(160,'');}finally{b?.dispose(false);}},'zh-CN');labels.dispose();
  const ws=Blockly.inject(mount.current!,{renderer:'thrasos',theme,media:'/blockly/media/',sounds:false,move:{drag:true,scrollbars:true},zoom:{startScale:1,controls:true},grid:{spacing:24,length:2,colour:'#334155'}});
  Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(`<xml xmlns="https://developers.google.com/blockly/xml"><block type="controls_loop_custom" id="loop" x="70" y="65"><statement name="DO">${error?'<block type="math_compound_assign_custom" id="bad-assignment"><field name="OP">+=</field><value name="VAR"><block type="math_number"><field name="NUM">1</field></block></value><value name="VALUE"><shadow type="math_number"><field name="NUM">0</field></shadow></value></block>':'<block type="serial_print" id="print"><field name="NEWLINE">TRUE</field><value name="MSG"><shadow type="text"><field name="TEXT">Hello, CK!</field></shadow></value></block>'}</statement></block></xml>`),ws);
  if(error)markCompileError(ws.getBlockById('bad-assignment')!,'编译错误：lvalue required as left operand of assignment');
  setWorkspace(ws);return()=>ws.dispose();
 },[error]);
 return <main className="sample-shell ck-workspace-shell" data-ck-blockly-skin="original"><header className="sample-heading"><div><b>CK / {error?'积木报错定位':'快速选择与插入积木'}</b><span>实际编辑器组件 · {error?'重现已验证的错误示例，未在此页面编译':'内置积木示例，可实际搜索与插入'}</span></div></header><div style={{height:error?300:620,position:'relative',border:'1px solid #334155',borderRadius:12,overflow:'hidden'}}><div ref={mount} style={{position:'absolute',inset:0}}/>{!error&&workspace&&<BlockDock workspace={workspace} renderer="thrasos" theme={theme} visualStyle="original"/>}</div>{error&&<BuildIssueCards issues={[issue]} onAction={()=>{}} onLocateBlock={id=>workspace&&revealCompileError(workspace,id)}/>}</main>;
}
