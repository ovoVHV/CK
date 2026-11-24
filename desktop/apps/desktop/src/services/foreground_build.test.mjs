import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Load the real lifecycle and result codes; only the device/UI effects are supplied.
async function moduleUrl(file, imports={}) {
    let text=await readFile(new URL(file,import.meta.url),'utf8');
    for(const [name,url] of Object.entries(imports))text=text.replace(`from '${name}'`, `from '${url}'`);
    return 'data:text/javascript;base64,'+Buffer.from(ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText).toString('base64');
}
const result=await moduleUrl('build_operation_result.ts');
const {runForegroundBuild}=await import(await moduleUrl('foreground_build.ts',{'./build_operation_result':result}));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};}
function session(){
    const events=[];let current=true,cancelled=false;
    const run={isCurrentSession:()=>current,isCancelled:()=>cancelled,
        execute:async()=>{events.push('execute');return 'compile_succeeded';},
        onFailure:(_,cancelled)=>events.push(cancelled?'cancel':'error'),
        stopTimer:()=>events.push('stop timer'), restoreSerial:async()=>{events.push('restore');},unlock:r=>events.push(r)};
    return {events,run,cancel:()=>{cancelled=true;},invalidate:()=>{current=false;}};
}
test('cancel while upload checkpoint is pending: no backend dispatch and timer released',async()=>{
    const s=session(),checkpoint=deferred();s.run.beforeUpload=()=>checkpoint.promise;
    const pending=runForegroundBuild(s.run);s.cancel();assert.deepEqual(s.events,[]);
    checkpoint.resolve();assert.equal(await pending,false);assert.deepEqual(s.events,['stop timer','restore','cancelled']);
});
for(const outcome of ['success','failure','cancel'])test(`upload ${outcome}: waits for serial restoration before unlock`,async()=>{
    const s=session(),restore=deferred(),entered=deferred();
    s.run.beforeUpload=async()=>s.events.push('checkpoint');
    s.run.execute=async()=>{s.events.push('release serial','upload');if(outcome==='success')return 'upload_succeeded';if(outcome==='cancel')s.cancel();throw Error('device operation stopped');};
    s.run.restoreSerial=()=>{s.events.push('restore');entered.resolve();return restore.promise;};
    const pending=runForegroundBuild(s.run);await entered.promise;
    assert.deepEqual(s.events,['checkpoint','release serial','upload',...(outcome==='success'?[]:[outcome==='cancel'?'cancel':'error']),'stop timer','restore']);
    restore.resolve();assert.equal(await pending,outcome==='success');assert.equal(s.events.at(-1),{success:'upload_succeeded',failure:'failed',cancel:'cancelled'}[outcome]);
});
test('an invalidated run cannot unlock its successor after awaiting serial recovery',async()=>{
    const s=session(),restore=deferred(),entered=deferred();s.run.restoreSerial=()=>{entered.resolve();return restore.promise;};
    const pending=runForegroundBuild(s.run);await entered.promise;s.invalidate();restore.resolve();assert.equal(await pending,false);assert.deepEqual(s.events,['execute','stop timer']);
});
test('ordinary compile schedules its frozen checkpoint only after final unlock',async()=>{
    const s=session();s.run.afterCompile=()=>s.events.push('checkpoint');assert(await runForegroundBuild(s.run));assert.deepEqual(s.events,['execute','stop timer','restore','compile_succeeded','checkpoint']);
});

for (const cancelled of [false, true]) test(`started compile preserves its input after ${cancelled ? 'cancellation' : 'failure'}`, async () => {
    const s = session();
    s.run.execute = async () => {
        s.events.push('execute');
        if (cancelled) s.cancel();
        throw Error('compile interrupted');
    };
    s.run.afterCompile = () => s.events.push('checkpoint');
    assert.equal(await runForegroundBuild(s.run), false);
    assert.deepEqual(s.events, ['execute', cancelled ? 'cancel' : 'error', 'stop timer', 'restore', cancelled ? 'cancelled' : 'failed', 'checkpoint']);
});

const {restoreUploadMonitor}=await import(await moduleUrl('foreground_upload_serial.ts'));
test('upload reopens on the original settings after temporary USB disappearance',async()=>{
    const delays=[];let attempts=0;
    assert(await restoreUploadMonitor(()=>true,async()=>{if(++attempts===1)throw Error('busy');},async ms=>{delays.push(ms);}));
    assert.equal(attempts,2);assert.deepEqual(delays,[150]);
});
test('changing the serial owner during retry suppresses another open',async()=>{
    let owner=true,attempts=0;
    assert.equal(await restoreUploadMonitor(()=>owner,async()=>{attempts++;throw Error('gone');},async()=>{owner=false;}),false);
    assert.equal(attempts,1);
});
test('reports the final serial failure only after bounded retries',async()=>{
    let attempts=0;const waits=[];
    await assert.rejects(restoreUploadMonitor(()=>true,async()=>{throw Error(`absent ${++attempts}`);},async ms=>{waits.push(ms);}),/absent 5/);
    assert.deepEqual(waits,[150,200,350,500]);
});
