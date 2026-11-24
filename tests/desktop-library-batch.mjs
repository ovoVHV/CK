// CK_LIBRARY_BATCH points to a build.py output. Run with Start-Preview.ps1.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {connectDesktop} from './desktop-client.mjs';
const root = path.resolve(process.env.CK_LIBRARY_BATCH);
const read = f => JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const config = read(process.env.CK_V9_ENGINE_CONFIG);
const out = path.join(config.paths.evidenceRoot,'batch-'+Date.now());
const pause = ms=>new Promise(r=>setTimeout(r,ms));
fs.mkdirSync(out,{recursive:true});
const report = {status:'RUNNING',engine:config.engineVersion,upload:false,runs:[]};
const save = ()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
const button = `document.querySelector('[data-ck-role="build-compile-action"]')`;
let c;
async function wait(expr,label,seconds=45) {
    for(const end=Date.now()+1000*seconds;Date.now()<end;) {
        const v=await c.evaluate(expr); if(v)return v; await pause(160);
    }
    throw Error('Timed out: '+label);
}
async function open(file,id,value,input) {
    const msg = JSON.stringify({requestId:randomUUID(),path:file,source:'library-batch'});
    for(let i=0;i<150;i++){
        await c.evaluate(`(()=>{const title=document.querySelector('[data-ck-role="workspace-project-identity"]')?.title||'';if(title.replaceAll('\\\\','/').startsWith(${JSON.stringify(out.replaceAll('\\','/')+'/')})){[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='不保存，继续打开')?.click();}return true})()`);
        if(await c.evaluate(`(()=>{const w=window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace,b=w?.getBlockById(${JSON.stringify(id)});return b&&Number(b.getInputTargetBlock(${JSON.stringify(input)})?.getFieldValue('NUM'))===${value}&&!document.querySelector('[data-ck-role="project-load-progress"]')&&document.querySelector('[data-ck-role="workspace-project-identity"]')?.title.endsWith(${JSON.stringify(path.basename(file))})})()`))return;
        if(i%8===0)await c.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${msg}})`);
        await pause(250);
    }
    throw Error('Project did not load: '+file);
}
async function compile(label) {
    await wait(`${button}?.disabled===false`,'compile ready');
    const i=await c.evaluate('window.__kitBuilds.length');
    await c.evaluate(`${button}.click()`);
    const row=await wait(`window.__kitBuilds[${i}]?.done?window.__kitBuilds[${i}]:null`,label,300);
    await wait(`${button}?.disabled===false`,'compile completed');
    return row;
}
try {
    c=await connectDesktop();
    const packages = fs.readdirSync(path.join(root,'packages'));
    const suite=[];
    for(const id of packages){
        const p=path.join(root,'packages',id),lib=read(path.join(p,'library.json'));
        const expected=read(path.join(p,'examples/expected.json')), archive=path.join(root,`${id}-${lib.version}.zip`);
        for (const board of expected.boards ?? [expected.board]) {
            function exampleFor(filename) {
                if(board===expected.board)return filename;
                const dir=path.join(p,'examples'),prefix=path.basename(filename,'.ck')+'-';
                const matches=fs.readdirSync(dir).filter(f=>f.startsWith(prefix)&&f.endsWith('.ck')&&read(path.join(dir,f)).board===board);
                assert.equal(matches.length,1,`Expected one ${filename} variant for ${board}`);
                return matches[0];
            }
            const x={...expected,board,positive:exampleFor(expected.positive),negative:exampleFor(expected.negative)};
            for(const name of [x.positive,x.negative])assert.equal(read(path.join(p,'examples',name)).board,board);
            const installed=path.join(config.paths.sysroot,'libraries',x.board.replaceAll(':','_'),id);
            if(fs.existsSync(installed)){
                // Never replace an existing user's library, even if its version happens to match.
                const compare=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
                    const f=path.join(dir,entry.name);
                    if(entry.isDirectory())compare(f);else assert(fs.readFileSync(f).equals(fs.readFileSync(path.join(installed,path.relative(p,f)))),'Existing package differs: '+f);
                }};compare(p);
            }
            await c.evaluate(`window.__TAURI_INTERNALS__.invoke('import_library',${JSON.stringify({path:archive,board:x.board,boardPackageId:x.board})})`);
            assert.equal(read(path.join(installed,'library.json')).id,id);
            suite.push({id,lib,p,x,archive});
        }
    }
    await c.evaluate(`(()=>{window.__kitBuilds=[];const original=window.fetch.bind(window);window.fetch=async(url,options)=>{
        const u=new URL(String(url),location.href);
        if(u.hostname!=='ipc.localhost'||decodeURIComponent(u.pathname.slice(1))!=='compile_sketch')return original(url,options);
        const args=JSON.parse(options.body),row={code:args.code,sourceMap:args.sourceMapJson,board:args.fqbn};window.__kitBuilds.push(row);
        const r=await original(url,options);row.kind=r.headers.get('Tauri-Response');row.body=await r.clone().text();row.done=true;return r;
    };return true})()`);
    for(const {id,lib,p,x,archive} of suite){
        const row={id,zipSHA256:createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),board:x.board,checks:[]};
        report.runs.push(row);save();
        for(const [name,source,value] of [['demo',x.positive,x.repair],['invalid',x.negative,x.invalid]]){
            const key=`${id}-${x.board.split(':')[2]}`;
            const file=path.join(out,`${key}-${name}.ck`);
            fs.copyFileSync(path.join(p,'examples',source),file);
            await open(file,x.blockId,value,x.input);
            const r=await compile(id+' '+name);
            assert.equal(r.board,x.board);
            assert(r.code.includes('#include <'+lib.includes[0]+'>'));
            fs.writeFileSync(path.join(out,`${key}-${name}.ino`),r.code);
            if(name==='demo'){
                assert.equal(r.kind,'ok',r.body.slice(-2200));
                const result=JSON.parse(JSON.parse(r.body));
                const receipt=read(path.join(result.path,'native-graph-host-receipt.json'));
                assert.equal(receipt.backend,'ck-build-engine-v9');
                assert.equal(receipt.worker.fqbn,x.board);
                const firmware=receipt.worker.artifacts.find(a=>a.name===('sketch.ino.'+(x.board.startsWith('arduino:avr:')?'hex':'bin')));assert(firmware);
                const hash=createHash('sha256').update(fs.readFileSync(path.join(result.path,firmware.name))).digest('hex');assert.equal(hash,firmware.sha256);
                row.firmwareSHA256=hash;row.core=receipt.worker.propertyExpansion?.coreVersion;
                row.checks.push('demo compiled');row.backend=receipt.backend;
                row.artifacts=receipt.worker.artifacts.map(a=>a.name);
            } else {
                assert.equal(r.kind,'error');
                const msg=JSON.parse(r.body);
                assert(msg.split('\n').some(line=>line.includes('error:')&&line.includes(x.errorCode)),msg.slice(-2400));
                assert(JSON.parse(r.sourceMap).mappings.some(m=>m.blockId===x.blockId));
                const selector=`document.querySelector(${JSON.stringify(`[data-id="${x.blockId}"]`)})`;
                await wait(`${selector}?.classList.contains('ck-block-compile-error')`,'marked '+x.blockId);
                const info=await c.evaluate(`(()=>{const c=window.CK_NATIVE_REGRESSION.getCurrent(),b=c.workspace.getBlockById(${JSON.stringify(x.blockId)}),btn=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='定位积木');if(btn)btn.click();return {id:b.id,warning:b.getIcon(c.Blockly.icons.WarningIcon.TYPE)?.getText(),stroke:getComputedStyle(b.pathObject.svgPath).stroke,locate:!!btn}})()`);
                assert(info.warning?.includes('编译错误'));assert.equal(info.stroke,'rgb(220, 38, 38)');assert(info.locate);
                row.checks.push('negative: compiler error, red outline, warning icon, locate button');
                row.error={code:x.errorCode,...info};save();
                await c.evaluate(`(()=>{window.CK_NATIVE_REGRESSION.getCurrent().workspace.getBlockById(${JSON.stringify(x.blockId)}).getInputTargetBlock(${JSON.stringify(x.input)}).setFieldValue(${JSON.stringify(String(x.repair))},'NUM');return true})()`);
                await wait(`!${selector}?.classList.contains('ck-block-compile-error')`,'clear stale warning');
                const fixed=await compile(id+' repaired');assert.equal(fixed.kind,'ok',fixed.body.slice(-2000));
                const cpp=code=>code.replace(/ *\/\* @ck(?:-source-(?:begin|end))?:v1:[0-9a-f]+ \*\//g,'');
                assert.equal(cpp(fixed.code),cpp(fs.readFileSync(path.join(out,`${key}-demo.ino`),'utf8')));
                row.checks.push('repair: warning cleared and build succeeded');
            }
            save();console.log(id,name,'OK');
        }
    }
    report.status='PASS';
} catch(e) {report.status='FAIL';report.error=String(e.stack);console.error(e);process.exitCode=1;}
finally{if(report.status==='FAIL'&&c){report.lastView=await c.evaluate(`document.body.innerText.slice(-2000)`).catch(()=>null);}
    save();c?.close();console.log('Report:',out);}
