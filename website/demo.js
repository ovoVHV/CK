import * as Blockly from 'blockly';
import { setBlocklyBoard } from '../desktop/apps/desktop/src/components/blockly_setup';
import { arduinoGenerator, setArduinoGeneratorTarget, stripBlockMarkers } from '../desktop/apps/desktop/src/components/arduino_generator';

const num = value => `<shadow type="math_number"><field name="NUM">${value}</field></shadow>`;
const delay = `<block type="control_delay"><field name="UNIT">MS</field><value name="TIME">${num(500)}</value></block>`;
const print = text => `<block type="serial_print"><field name="NEWLINE">TRUE</field><value name="MSG"><shadow type="text"><field name="TEXT">${text}</field></shadow></value></block>`;
const setup = body => `<block type="controls_setup_custom" x="28" y="28"><statement name="DO">${body}</statement></block>`;
const loop = (body, y=170) => `<block type="controls_loop_custom" x="28" y="${y}"><statement name="DO">${body}</statement></block>`;
const serial = `<block type="serial_setup"><value name="BAUD">${num(115200)}</value></block>`;
const chain = (first, next) => first.replace(/<\/block>$/, `<next>${next}</next></block>`);
const digital = level => `<block type="io_digital_write"><value name="PIN">${num(13)}</value><value name="LEVEL"><shadow type="io_level"><field name="LEVEL">${level}</field></shadow></value></block>`;
export const examples = {
    blink: {name:'让第一盏灯亮起来', board:'arduino:avr:uno', label:'Arduino Uno', xml:`${setup(`<block type="set_pin_mode"><field name="MODE">OUTPUT</field><value name="PIN">${num(13)}</value></block>`)}${loop(chain(digital('HIGH'), chain(delay, chain(digital('LOW'), delay))),148)}`},
    serial: {name:'听见硬件的回应', board:'arduino:avr:uno', label:'Arduino Uno', xml:`${setup(serial)}${loop(chain(print('Hello, CK LAB!'),delay),148)}`},
    wifi: {name:'把硬件连上网络', board:'esp32:esp32:esp32s3', label:'ESP32-S3', xml:`${setup(chain(serial, chain(`<block type="wifi_connect"><field name="SSID">MyWiFi</field><field name="PASSWORD">12345678</field></block>`, '<block type="wifi_wait_until_ready"></block>')))}${loop('',240)}`},
};
let workspace;
let selected='blink';
let code='';
const download = (name, text, type) => {
    const url=URL.createObjectURL(new Blob([text],{type}));
    const link=document.createElement('a');link.href=url;link.download=name;link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
};
export function startDemo() {
    const mount=document.querySelector('#blockly-demo');
    if (!mount) return;
    workspace=Blockly.inject(mount, {
        media:'/assets/blockly/', renderer:'zelos', sounds:false, trashcan:true,
        grid:{spacing:24,length:2,colour:'#e0ddd6',snap:true},
        move:{scrollbars:true,drag:true,wheel:true},
        zoom:{controls:true,wheel:false,startScale:0.8,maxScale:1.5,minScale:0.45,scaleSpeed:1.1},
    });
    const renderCode=()=>{
        try {
            code=stripBlockMarkers(arduinoGenerator.workspaceToCode(workspace));
            document.querySelector('#generated-code').textContent=code;
            document.querySelector('#demo-status').textContent='本地生成 · 可拖动积木 / 点击数值修改';
            document.querySelector('#download-project').disabled=false;
            document.querySelector('#copy-code').disabled=false;
        } catch(e) {
            document.querySelector('#demo-status').textContent='代码生成失败，请重置示例：'+e.message;
            document.querySelector('#download-project').disabled=true;
            document.querySelector('#copy-code').disabled=true;
        }
    };
    const load=id=>{
        selected=id;
        const example=examples[id];
        setBlocklyBoard(example.board);setArduinoGeneratorTarget(example.board,id==='wifi'?'3.3.6':'1.8.6');
        workspace.clear();
        Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(`<xml xmlns="https://developers.google.com/blockly/xml">${example.xml}</xml>`),workspace);
        document.querySelector('#demo-board').textContent=example.label;
        document.querySelectorAll('[data-example]').forEach(b=>{b.classList.toggle('active',b.dataset.example===id);b.setAttribute('aria-pressed',String(b.dataset.example===id));});
        renderCode();Blockly.svgResize(workspace);
    };
    workspace.addChangeListener(event=>{if(!event.isUiEvent)renderCode();});
    document.querySelectorAll('[data-example]').forEach(button=>button.addEventListener('click',()=>load(button.dataset.example)));
    document.querySelector('#reset-demo').addEventListener('click',()=>load(selected));
    document.querySelector('#copy-code').addEventListener('click',async()=>{
        try{await navigator.clipboard.writeText(code);document.querySelector('#demo-status').textContent='生成代码已复制';}
        catch{document.querySelector('#demo-status').textContent='未能访问剪贴板，请在代码面板中选择并复制。';}
    });
    document.querySelector('#download-project').addEventListener('click',()=>{
        const example=examples[selected];
        const xml=Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(workspace));
        download(`CK-LAB-${selected}.ck`,JSON.stringify({format:'ck-project',schema_version:1,migration_version:1,name:example.name,board:example.board,board_package_id:example.board,xml,code,options:'',created_at:new Date().toISOString()},null,2),'application/json');
    });
    const observer=new ResizeObserver(()=>Blockly.svgResize(workspace));observer.observe(mount);
    const requested=new URLSearchParams(location.search).get('example');
    load(Object.hasOwn(examples,requested) ? requested : 'blink');
    // Expose only serializable demo data to local acceptance checks.
    window.ckLabDemo={getCode:()=>code,getExample:()=>selected,getBlocks:()=>workspace.getAllBlocks(false).map(b=>({id:b.id,type:b.type})),getXml:()=>Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(workspace))};
}
