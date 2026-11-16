// Local-only screenshot fixture. Real CK components; synthetic project/serial data.
// This module is never included in the public website bundle.
import React from 'react';
import {createRoot} from 'react-dom/client';
import * as Blockly from 'blockly';
import {setBlocklyBoard} from '../../desktop/apps/desktop/src/components/blockly_setup';
import {initializeI18n} from '../../desktop/apps/desktop/src/i18n';
import {RecoveryDraftModal} from '../../desktop/apps/desktop/src/components/RecoveryDraftModal';
import {SerialPlotter} from '../../desktop/apps/desktop/src/components/SerialPlotter';
import {DialogProvider} from '../../desktop/apps/desktop/src/contexts/DialogContext';
import {emitSample} from './sample-events';
import {EditorFixture} from './editor-fixture';

await initializeI18n();
setBlocklyBoard('arduino:avr:uno');
const noop=()=>{};
function project(delay:number, extra:boolean){
 const ws=new Blockly.Workspace();
 const xml=`<xml xmlns="https://developers.google.com/blockly/xml"><block type="controls_setup_custom" id="setup" x="24" y="24"><statement name="DO"><block type="serial_setup" id="serial"><value name="BAUD"><shadow type="math_number" id="baud"><field name="NUM">115200</field></shadow></value></block></statement></block><block type="controls_loop_custom" id="loop" x="24" y="140"><statement name="DO"><block type="serial_print" id="print"><field name="NEWLINE">TRUE</field><value name="MSG"><shadow type="text" id="message"><field name="TEXT">Hello, CK LAB!</field></shadow></value><next><block type="control_delay" id="delay"><field name="UNIT">MS</field><value name="TIME"><shadow type="math_number" id="interval"><field name="NUM">${delay}</field></shadow></value>${extra?'<next><block type="serial_print" id="extra"><field name="NEWLINE">TRUE</field><value name="MSG"><shadow type="text" id="extra-text"><field name="TEXT">Ready for the next idea.</field></shadow></value></block></next>':''}</block></next></block></statement></block></xml>`;
 Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(xml),ws);
 const workspaceJson=JSON.stringify(Blockly.serialization.workspaces.save(ws));ws.dispose();
 return {workspaceJson,sourceCode:`void setup() { Serial.begin(115200); }\nvoid loop() {\n Serial.println("Hello, CK LAB!");\n delay(${delay});\n${extra?' Serial.println("Ready for the next idea.");\n':''}}`,board:'Arduino Uno',fqbn:'arduino:avr:uno',boardPackageId:'arduino:avr:uno',options:'{}'};
}
const meta={schemaVersion:1,id:'ck-lab-sample',projectId:'ck-lab-sample',projectPath:'D:\\CK 示例工程\\串口小实验.ck',projectName:'串口小实验 · 示例工程',createdAt:'2026-11-09T07:30:00Z',diskBaselineHash:'example',diskBaselineModifiedAt:null,fullStateHash:'example-data',board:'Arduino Uno',fqbn:'arduino:avr:uno',boardPackageId:'arduino:avr:uno',options:'{}',byteSize:2048};
function SerialFixture(){
 function feed(){
  const rows=Array.from({length:280},(_,i)=>JSON.stringify({temperature:+(24+3.5*Math.sin(i/27)+9*Math.exp(-Math.pow((i-180)/19,2))).toFixed(2),humidity:+(48+8*Math.cos(i/36)).toFixed(2)}));
  emitSample(rows.join('\n')+'\n');
 }
 return <main className="sample-shell"><header className="sample-heading"><div><b>CK / 串口曲线</b><span>实际界面组件 · 合成示例数据 · 未连接硬件</span></div><button onClick={feed}>载入示例数据</button></header><div className="plot-shell"><SerialPlotter paused={false} port="示例端口" baudRate={115200}/></div></main>;
}
const mode=new URLSearchParams(location.search).get('view');
createRoot(document.getElementById('root')!).render(<DialogProvider>{mode==='editor'||mode==='error'?<EditorFixture error={mode==='error'}/>:mode==='serial'?<SerialFixture/>:<><div className="sample-ribbon">CK 实际恢复组件 · 示例工程，非用户数据</div><RecoveryDraftModal candidate={meta} draft={{...meta,...project(250,true)}} currentState={project(500,false)} onKeepForLater={noop} onDiscard={noop} onRestoreAsNew={noop} onRestoreCurrent={noop}/></>}</DialogProvider>);
