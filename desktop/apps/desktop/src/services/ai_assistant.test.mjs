import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import * as Blockly from 'blockly';
import 'blockly/blocks';
const root = path.dirname(fileURLToPath(import.meta.url));
const temp = path.resolve(root, '../../node_modules/.cache/ck-ai-tests'); fs.mkdirSync(temp, { recursive: true });
const entry = path.join(temp, 'entry.mjs');
fs.writeFileSync(entry, `export * from ${JSON.stringify(path.join(root, 'ai_workspace.ts'))};export * from ${JSON.stringify(path.join(root, 'ai_assistant_runtime.ts'))};export * from ${JSON.stringify(path.join(root, 'ai_candidate.ts'))};`);
const output = path.join(temp, 'runtime.mjs');
await build({ entryPoints: [entry], outfile: output, platform: 'node', format: 'esm', bundle: true, packages: 'external', logLevel: 'silent' });
const { aiAvailableCatalog, previewAiProposal, applyAiPreview, aiWorkspaceSnapshot, aiBlockSchema, aiReadWorkspace, parseAiProposal,
    AiPrivacyFilter, validateAiConnection, runAiTask, AI_TASK_LIMITS, expandAiBlockGraph, generateAiCandidate, compactAiSchema } = await import(pathToFileURL(output));
Blockly.defineBlocksWithJsonArray([
    { type: 'ai_test_root', message0: '程序 %1', args0: [{ type: 'input_statement', name: 'DO' }] },
    { type: 'ai_test_step', message0: '等待 %1', args0: [{ type: 'field_number', name: 'MS', value: 1000, min: 0 }], previousStatement: null, nextStatement: null },
    { type: 'ai_test_enum', message0: '状态 %1', args0: [{ type: 'field_dropdown', name: 'STATE', options: [['开启', 'ON'], ['关闭', 'OFF']] }], previousStatement: null, nextStatement: null },
    { type: 'ai_test_wifi', message0: 'WiFi %1 密码 %2', args0: [{ type: 'field_input', name: 'SSID', text: 'private-network' }, { type: 'field_input', name: 'PASSWORD', text: 'test-private-password' }], previousStatement: null, nextStatement: null },
]);
const catalog = ['ai_test_root','ai_test_step','ai_test_enum','ai_test_wifi','math_number'].map(type => ({ type, source: 'toolbox', keywords: [type] }));
const open = () => {
    const workspace = new Blockly.Workspace();
    Blockly.serialization.workspaces.load({ blocks: { languageVersion: 0, blocks: [{ type: 'ai_test_root', id: 'root', x: 30, y: 40,
        inputs: { DO: { block: { type: 'ai_test_step', id: 'first', fields: { MS: 1000 }, next: { block: { type: 'ai_test_step', id: 'second', fields: { MS: 2000 } } } } } } }] } }, workspace);
    return workspace;
};
const plan = edits => parseAiProposal({ summary: '调整等待时间', edits });
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

test('local edit preview does not mutate original, preserves unrelated block IDs and position', () => {
    const workspace = open();
    try {
        const before = aiWorkspaceSnapshot(workspace);
        const preview = previewAiProposal(workspace, plan([{ action: 'set_field', blockId: 'first', field: 'MS', value: 500 }]), catalog);
        assert.equal(aiWorkspaceSnapshot(workspace), before);
        assert.equal(preview.changed, 1); assert.equal(preview.added, 0); assert.equal(preview.removed, 0);
        const blocks = JSON.parse(preview.after).blocks.blocks;
        assert.equal(blocks[0].id, 'root'); assert.equal(blocks[0].x, 30);
        assert.equal(blocks[0].inputs.DO.block.next.block.id, 'second');
        assert.equal(blocks[0].inputs.DO.block.next.block.fields.MS, 2000);
    } finally { workspace.dispose(); }
});

test('one undo/redo restores the complete transaction and emits content notifications', async () => {
    const workspace = open(); const events = [];
    try {
        await settle(); workspace.clearUndo(); workspace.addChangeListener(e => events.push(e.type));
        const before = aiWorkspaceSnapshot(workspace);
        const preview = previewAiProposal(workspace, plan([{ action: 'set_field', blockId: 'first', field: 'MS', value: 500 }]), catalog);
        applyAiPreview(workspace, preview); await settle();
        assert.equal(workspace.getBlockById('first').getFieldValue('MS'), 500);
        workspace.undo(false); await settle(); assert.equal(aiWorkspaceSnapshot(workspace), before);
        workspace.undo(true); await settle(); assert.equal(workspace.getBlockById('first').getFieldValue('MS'), 500);
        assert.equal(events.filter(e => e === 'ck_ai_workspace_edit').length, 3);
    } finally { workspace.dispose(); }
});

test('stale preview cannot overwrite a subsequent user edit', () => {
    const workspace = open();
    try {
        const preview = previewAiProposal(workspace, plan([{ action: 'set_field', blockId: 'first', field: 'MS', value: 500 }]), catalog);
        workspace.getBlockById('second').setFieldValue(3000, 'MS');
        assert.throws(() => applyAiPreview(workspace, preview), /已有变化/);
        assert.equal(workspace.getBlockById('first').getFieldValue('MS'), 1000);
    } finally { workspace.dispose(); }
});

test('unknown blocks, fields, invalid dropdowns and incompatible connections fail without mutation', () => {
    const workspace = open(); const before = aiWorkspaceSnapshot(workspace);
    try {
        for (const edit of [
            { action: 'set_field', blockId: 'first', field: 'GUESS', value: 1 },
            { action: 'append', blockId: 'first', block: { type: 'invented_block' } },
            { action: 'append', blockId: 'first', block: { type: 'ai_test_enum', fields: { STATE: 'UNKNOWN' } } },
            { action: 'append', blockId: 'first', block: { type: 'math_number', fields: { NUM: 1 } } },
            { action: 'append', blockId: 'first', block: { type: 'ai_test_step', fields: { GUESSED: 1 } } },
            { action: 'append', blockId: 'root', input: 'MISSING', block: { type: 'ai_test_step' } },
        ]) { assert.throws(() => previewAiProposal(workspace, plan([edit]), catalog)); assert.equal(aiWorkspaceSnapshot(workspace), before); }
    } finally { workspace.dispose(); }
});

test('append and replacement preserve the following statement; removal heals the chain', () => {
    const workspace = open();
    try {
        const append = previewAiProposal(workspace, plan([{ action: 'append', blockId: 'first', block: { type: 'ai_test_enum', fields: { STATE: 'OFF' } } }]), catalog);
        applyAiPreview(workspace, append);
        assert.equal(workspace.getBlockById('first').getNextBlock().type, 'ai_test_enum');
        assert.equal(workspace.getBlockById('first').getNextBlock().getNextBlock().id, 'second');
        const replacement = previewAiProposal(workspace, plan([{ action: 'replace', blockId: 'first', block: { type: 'ai_test_step', fields: { MS: 300 } } }]), catalog);
        applyAiPreview(workspace, replacement);
        assert.equal(workspace.getBlockById('root').getInputTargetBlock('DO').getFieldValue('MS'), 300);
        const removal = previewAiProposal(workspace, plan([{ action: 'remove', blockId: workspace.getBlockById('root').getInputTargetBlock('DO').id }]), catalog);
        applyAiPreview(workspace, removal);
        assert.equal(workspace.getBlockById('root').getInputTargetBlock('DO').type, 'ai_test_enum');
    } finally { workspace.dispose(); }
});

test('registered third-party blocks expose real fields and dropdown values without AI metadata', () => {
    const schema = aiBlockSchema('ai_test_enum', catalog);
    assert.deepEqual(schema.fields.find(f => f.name === 'STATE').options, [['开启','ON'],['关闭','OFF']]);
    assert.equal(schema.metadataSource, 'toolbox');
    assert.throws(() => aiBlockSchema('invented', catalog));
});

test('active templates authorize hidden helper blocks without exposing unrelated registered types', () => {
    const entries = [{ type: 'math_arithmetic', source: 'toolbox', keywords: ['math'],
        xml_template: '<block type="math_arithmetic"><value name="A"><shadow type="math_number"><field name="NUM">13</field></shadow></value></block>' }];
    assert.deepEqual(aiAvailableCatalog(entries).map(e => e.type), ['math_arithmetic', 'math_number']);
    const schema = aiBlockSchema('math_number', entries);
    assert.equal(schema.fields.find(f => f.name === 'NUM').value, 13);
    assert.throws(() => aiBlockSchema('ai_test_enum', entries));
    const workspace = new Blockly.Workspace();
    try {
        workspace.newBlock('ai_test_root', 'root');
        const active = [...entries, { type: 'ai_test_root', source: 'toolbox', keywords: [] }];
        const preview = previewAiProposal(workspace, plan([{ action: 'replace', blockId: 'root', block: {
            type: 'math_arithmetic', inputs: { A: { shadow: { type: 'math_number', fields: { NUM: 13 } } } },
        } }]), active);
        assert(preview.added >= 2);
        assert.equal(workspace.getAllBlocks(false).length, 1);
    } finally { workspace.dispose(); }
});

test('temporary variable IDs never change schemas, including nested templates, and templates remain usable', () => {
    const entries = [{ type:'controls_for',source:'toolbox',keywords:[],xml_template:'<block type="controls_for"><field name="VAR">sampleIndex</field><statement name="DO"><block type="variables_set"><field name="VAR">sampleValue</field></block></statement></block>' }];
    const first = aiBlockSchema('controls_for', entries);
    const second = aiBlockSchema('controls_for', entries);
    assert.deepEqual(compactAiSchema(first), compactAiSchema(second));
    assert.deepEqual(first.template.fields.VAR,{name:'sampleIndex',type:''});
    assert.deepEqual(first.template.inputs.DO.block.fields.VAR,{name:'sampleValue',type:''});
    assert.deepEqual(first.fields.find(f=>f.name==='VAR').value,{name:'sampleIndex',type:''});
    const ws = new Blockly.Workspace();
    try {
        const block = Blockly.serialization.blocks.append(first.template, ws);
        assert.equal(block.getField('VAR').getVariable().getName(),'sampleIndex');
        assert.equal(block.getInputTargetBlock('DO').getField('VAR').getVariable().getName(),'sampleValue');
    } finally { ws.dispose(); }
});

test('variable name changes still change the inspected schema', () => {
    const entry={type:'controls_for',source:'toolbox',keywords:[]};
    const read=name=>compactAiSchema(aiBlockSchema(entry.type,[{...entry,xml_template:`<block type="controls_for"><field name="VAR">${name}</field></block>`}]));
    assert.notDeepEqual(read('left'),read('right'));
});

test('workspace reads are paginated beyond 30 blocks and preserve connections', () => {
    const workspace = open();
    try {
        for (let i = 0; i < 45; i++) workspace.newBlock('ai_test_step');
        let offset = 0; const ids = [];
        do { const result = aiReadWorkspace(workspace, offset); ids.push(...result.blocks.map(b => b.id)); offset = result.nextOffset; } while (offset !== null);
        assert.equal(ids.length, 48); assert.equal(new Set(ids).size, 48);
        assert.equal(aiReadWorkspace(workspace).blocks.find(b => b.id === 'root').inputs[0].blockId, 'first');
    } finally { workspace.dispose(); }
});

test('passwords, SSIDs and API keys are replaced before transmission and exact tokens restore locally', () => {
    const workspace = open();
    try {
        workspace.newBlock('ai_test_wifi');
        const filter = new AiPrivacyFilter(workspace, 'api-key-for-test');
        const raw = JSON.stringify(aiReadWorkspace(workspace)) + ' api-key-for-test';
        const safe = filter.redact(raw);
        for (const secret of ['test-private-password','private-network','api-key-for-test']) assert(!safe.includes(secret));
        assert.equal(filter.restoreProposal(filter.redact('test-private-password')), 'test-private-password');
        assert.throws(() => filter.restoreProposal('__CK_PRIVATE_999__'), /占位符/);
    } finally { workspace.dispose(); }
});

test('connection rejects credentials embedded in URL and cleartext remote transport', () => {
    const valid = { baseUrl: 'https://example.com/v1/', model: 'tool-model', apiKey: 'test' };
    assert.equal(validateAiConnection(valid).baseUrl, 'https://example.com/v1');
    for (const baseUrl of ['http://example.com/v1', 'https://user:password@example.com', 'https://example.com?key=secret', 'file:///test']) assert.throws(() => validateAiConnection({ ...valid, baseUrl }));
    assert.equal(validateAiConnection({ ...valid, baseUrl: 'http://127.0.0.1:1234/v1' }).model, 'tool-model');
});

test('structured privacy filtering preserves IDs, escaped secrets and short-secret placeholders', () => {
    const workspace = open();
    try {
        const wifi = workspace.newBlock('ai_test_wifi');
        wifi.setFieldValue('1', 'SSID'); wifi.setFieldValue('a"b\\c', 'PASSWORD');
        const filter = new AiPrivacyFilter(workspace, 'long-api-key');
        const safe = JSON.parse(filter.data({ id: 'id-1', type: 'version1', fields: { SSID: '1', PASSWORD: 'a"b\\c' }, label: '密码 a"b\\c，网络 1' }));
        assert.equal(safe.id, 'id-1'); assert.equal(safe.type, 'version1');
        assert.equal(filter.restoreProposal(safe.fields.SSID), '1');
        assert.equal(filter.restoreProposal(safe.fields.PASSWORD), 'a"b\\c');
        assert(!safe.label.includes('a"b\\c'));
        assert.equal(filter.redact('long-api-key'), '__CK_PRIVATE_1__');
    } finally { workspace.dispose(); }
});

const call = (name, args) => ({ id: `call-${Math.random()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const response = calls => ({ content: '', model: 'mock', finishReason: 'tool_calls', toolCalls: calls });
const setupTask = (workspace, transport) => ({ prompt: '把第一个等待改为500毫秒', intent: { id: 1, kind: 'edit', blockId: 'first' },
    connection: { baseUrl: 'https://example.com/v1', model: 'mock', apiKey: 'test-key' },
    host: { workspace: () => workspace, catalog: () => catalog, target: () => ({ board: 'arduino:avr:uno' }), diagnostics: () => [], identity: () => 'project1', validateCandidate: async () => ({ ok: true, runId: crypto.randomUUID(), sourceSha256: 'test', elapsedMs: 10, log: 'compiled', diagnostics: [], artifactCount: 1 }) },
    signal: new AbortController().signal, onStep() {}, onText() {}, transport });

test('serial reads do not authorize writes, revocation withholds fresh device data, files require a separate grant',async()=>{
    const ws=open();let round=0,reads=0,samples=0;
    const grants={files:false,serial:true,send:false,upload:false};
    try{
        const task=setupTask(ws,async req=>{
            const tools=req.historyMessages.filter(row=>row.role==='tool').map(row=>JSON.parse(row.content));
            if(round++===0)return response([call('project_files',{}),call('project_files',{path:'src/main.h'}),call('serial_sample',{text:'s'}),call('serial_sample',{waitMs:100})]);
            assert.deepEqual(tools[0].files,['src/main.h']);assert.match(tools[1].error,/授权/);
            assert.match(tools[2].error,/授权/);assert.match(tools[3].error,/授权/);
            assert.doesNotMatch(JSON.stringify(req),/PRIVATE_DEVICE_REPLY/);
            return {content:'未获得硬件验证结果',model:'mock',finishReason:'stop',toolCalls:[]};
        });
        task.host.grants=()=>grants;
        task.host.device={files:async()=>{reads++;return {files:['src/main.h']};},sample:async(text,ms,check)=>{
            check();samples++;assert.equal(text,undefined);assert.equal(ms,100);grants.serial=false;return {text:'PRIVATE_DEVICE_REPLY'};
        }};
        await runAiTask(task);assert.equal(reads,1);assert.equal(samples,1);
    }finally{ws.dispose();}
});

test('project creation requires directory discovery and a live, independent grant at commit',async()=>{
 for(const scenario of ['auto','review','denied','revoked','explain','cancelled']){
    const workspace=open();let writes=0,reviewed=0,recorded=0,round=0;
    const grants={files:false,create:scenario!=='denied',serial:false,send:false,upload:false};
    const files=[{path:'src/sampling/sample.cpp',code:'// 采样\nint sample(){return 1;}\n'}];
    const create=(batch=files)=>call('create_project_sources',{files:batch});
    try{
        const task=setupTask(workspace,async req=>{
            if(!round++){
                assert.equal(req.tools.some(t=>t.function.name==='create_project_sources'),!['denied','explain'].includes(scenario));
                return response([create(),call('project_files',{}),create([{path:'src/../outside.h',code:'// no'}]),create([{path:'src/采样/sample.h',code:'// no'}]),create()]);
            }
            const results=req.historyMessages.filter(t=>t.role==='tool').map(t=>JSON.parse(t.content));
            if(['denied','explain'].includes(scenario))assert.match(results[4].error,/不提供/);
            else{
                assert.match(results[0].error,/先用/);assert.match(results[2].error,/相对路径/);
                assert.match(results[3].error,/AVR/);
                if(scenario==='revoked')assert.match(results[4].error,/无权/);
                else assert.deepEqual(results[4].created,files.map(f=>f.path));
            }
            return {content:'结束',finishReason:'stop',toolCalls:[]};
        });
        task.autoApply=scenario==='auto';if(scenario==='explain')task.intent.kind='explain';
        task.host.grants=()=>grants;task.host.device={files:async()=>({files:[]}),create:async(batch,check)=>{check();assert.deepEqual(batch,files);writes++;}};
        task.confirmSources=async()=>{reviewed++;if(scenario==='revoked')grants.create=false;return scenario!=='cancelled';};
        task.onSourcesCreated=()=>recorded++;
        if(scenario==='cancelled')await assert.rejects(runAiTask(task),/取消创建/);else await runAiTask(task);
        assert.equal(writes,['auto','review'].includes(scenario)?1:0);assert.equal(recorded,writes);
        assert.equal(reviewed,['review','revoked','cancelled'].includes(scenario)?1:0);
    } finally{workspace.dispose();}
 }
});

test('three consecutive truncated responses stop without executing partial tools or compiling',async()=>{
 const workspace=open();let requests=0,compiles=0;
 try{
  const before=aiWorkspaceSnapshot(workspace);
  const task=setupTask(workspace,async()=>{requests++;return {...response([call('propose_change',{summary:'partial must not execute',edits:[{action:'set_field',blockId:'first',field:'MS',value:999}]})]),finishReason:'length'};});
  task.host.validateCandidate=async()=>{compiles++;throw Error('Truncated output must not compile');};
  await assert.rejects(runAiTask(task),/连续三次回复超出长度/);
  assert.equal(requests,3);assert.equal(compiles,0);assert.equal(aiWorkspaceSnapshot(workspace),before);
 }finally{workspace.dispose();}
});

test('a complete tool response resets the consecutive truncation limit and keeps valid staged edits',async()=>{
 const workspace=open();let requests=0,compiles=0;
 try{
  const before=aiWorkspaceSnapshot(workspace);
  const task=setupTask(workspace,async()=>{
   const n=requests++;
   if(n===0)return response([call('read_workspace',{})]);
   if([1,2,4,5].includes(n))return {...response([call('remove',{blockId:'first'})]),finishReason:'length'};
   if(n===3)return response([call('stage_changes',{summary:'valid edit',edits:[{action:'set_field',blockId:'first',field:'MS',value:555}]})]);
   return response([call('propose_change',{summary:'complete',edits:[]})]);
  });
  task.host.validateCandidate=async preview=>{compiles++;assert.equal(preview.proposal.edits[0].value,555);return {ok:true,runId:'run',sourceSha256:'source',elapsedMs:1,log:'ok',diagnostics:[],artifactCount:1};};
  const result=await runAiTask(task);assert(result.preview);assert.equal(requests,7);assert.equal(compiles,1);assert.equal(aiWorkspaceSnapshot(workspace),before);
 }finally{workspace.dispose();}
});

test('unplaced staged nodes cannot silently disappear from a compiled proposal',async()=>{
 const workspace=open();let round=0,compiles=0;
 try{
  const task=setupTask(workspace,async req=>{
   if(round++===0)return response([call('read_workspace',{}),call('get_block_schemas',{types:['ai_test_step']})]);
   if(round===2)return response([call('stage_blocks',{summary:'暂存两段',nodes:[{key:'firstPart',type:'ai_test_step',fields:{MS:111}},{key:'missingPart',type:'ai_test_step',fields:{MS:222}}],placements:[{action:'append',blockId:'root',input:'DO',node:'firstPart'}]})]);
   if(round===3)return response([call('propose_change',{summary:'不允许遗漏',edits:[]})]);
   if(round===4){assert.match(req.historyMessages.findLast(r=>r.role==='tool').content,/未进入方案/);assert.equal(compiles,0);return response([call('stage_blocks',{summary:'补齐遗漏',nodes:[],placements:[{action:'append',blockId:'root',input:'DO',node:'missingPart'}]})]);}
   if(round===5)return response([call('read_staged_code',{})]);
   if(round===6){const read=JSON.parse(req.historyMessages.findLast(r=>r.role==='tool').content);assert.match(read.code,/111.*222/s);assert.equal(read.compiled,false);return response([call('propose_change',{summary:'完整方案',edits:[]})]);}
   throw Error('Unexpected model request');
  });
  task.host.inspectCandidate=p=>p.proposal.edits.map(e=>String(e.block.fields.MS)).join('\n');
  task.host.validateCandidate=async()=>{compiles++;return {ok:true,runId:'run',sourceSha256:'source',elapsedMs:1,log:'ok',diagnostics:[],artifactCount:1};};
  const before=aiWorkspaceSnapshot(workspace);const result=await runAiTask(task);assert(result.preview);assert.equal(result.preview.added,2);assert.equal(compiles,1);assert.equal(aiWorkspaceSnapshot(workspace),before);
 }finally{workspace.dispose();}
});

test('staged patch rebuilds placed graphs atomically and preserves interleaved original edits',async()=>{
 const workspace=open();let round=0,compiles=0;
 try{
  const task=setupTask(workspace,async req=>{
   const last=()=>JSON.parse(req.historyMessages.findLast(r=>r.role==='tool').content);
   if(round++===0)return response([call('read_workspace',{}),call('get_block_schemas',{types:['ai_test_step','ai_test_enum']})]);
   if(round===2)return response([call('stage_changes',{summary:'保留原修改',edits:[{action:'set_field',blockId:'first',field:'MS',value:777}]})]);
   if(round===3)return response([call('stage_blocks',{summary:'搭建候选',nodes:[{key:'head',type:'ai_test_step',fields:{MS:111},next:'tail'},{key:'tail',type:'ai_test_enum',fields:{STATE:'OFF'}},{key:'unused',type:'ai_test_step'}],placements:[{action:'append',blockId:'root',input:'DO',node:'head'}]})]);
   if(round===4)return response([call('stage_blocks',{summary:'只修必要节点',patch:true,nodes:[{key:'head',type:'ai_test_step',fields:{MS:222},next:'tail'},{key:'tail',type:'ai_test_enum',fields:{STATE:'ON'}}],placements:[]})]);
   if(round===5){assert.equal(last().patched,true);return response([call('stage_blocks',{summary:'无效字段应拒绝',patch:true,nodes:[{key:'tail',type:'ai_test_enum',fields:{STATE:'INVALID'}}],placements:[]})]);}
   if(round===6){assert(last().error);return response([call('stage_blocks',{summary:'断开引用应拒绝',patch:true,nodes:[],removeKeys:['tail'],placements:[]})]);}
   if(round===7){assert.match(last().error,/找不到节点/);return response([call('read_staged_plan',{keys:['head','tail']})]);}
   if(round===8){assert.equal(last().nodes[0].fields.MS,222);assert.equal(last().nodes[1].fields.STATE,'ON');assert(!('editIndex' in last().placements[0]));return response([call('stage_blocks',{summary:'明确删除未使用草稿',patch:true,nodes:[],removeKeys:['unused'],placements:[]})]);}
   return response([call('propose_change',{summary:'完整修订',edits:[]})]);
  });
  task.host.validateCandidate=async preview=>{compiles++;assert.equal(preview.proposal.edits[0].value,777);assert.equal(preview.proposal.edits[1].block.fields.MS,222);assert.equal(preview.proposal.edits[1].block.next.block.fields.STATE,'ON');return {ok:true,runId:'run',sourceSha256:'source',elapsedMs:1,log:'ok',diagnostics:[],artifactCount:1};};
  const before=aiWorkspaceSnapshot(workspace);const result=await runAiTask(task);assert(result.preview);assert.equal(compiles,1);assert.equal(aiWorkspaceSnapshot(workspace),before);
 }finally{workspace.dispose();}
});

test('large staged graph compacts exact nodes once without duplicate calls or a model summary',async()=>{
 Blockly.defineBlocksWithJsonArray([{type:'ai_test_payload',message0:'备注 %1',args0:[{type:'field_input',name:'TEXT',text:''}],previousStatement:null,nextStatement:null}]);
 const workspace=open();let round=0;
 try{
  const task=setupTask(workspace,async req=>{
   assert(req.tools?.length,'Pure staging compaction must not spend a summary model request');
   if(round++===0)return response([call('read_workspace',{}),call('get_block_schemas',{types:['ai_test_payload']})]);
   if(round<=5){const batch=round-2,key=i=>`b${batch}n${i}_`+'k'.repeat(35);return response([call('stage_blocks',{summary:'保存分段',nodes:Array.from({length:30},(_,i)=>({key:key(i),type:'ai_test_payload',fields:{TEXT:'x'.repeat(200)},...(i<29?{next:key(i+1)}:{})})),placements:[{action:'append',blockId:'root',input:'DO',node:key(0)}]})]);}
   const state=req.historyMessages.find(r=>r.content?.startsWith('当前任务真实暂存状态：'));assert(state,'Large graph must trigger compaction');const facts=JSON.parse(state.content.slice(state.content.indexOf('{')));
   const recentStages=req.historyMessages.flatMap(r=>(r.tool_calls||[]).filter(c=>c.function.name==='stage_blocks').map(c=>JSON.parse(c.function.arguments)));
   const retainedNodes=[...facts.stagedNodes,...recentStages.flatMap(s=>s.nodes)];
   assert(facts.stagedNodes.length>=60,'Several batches must have been compacted into exact state');
   assert.equal(retainedNodes.length,120);assert.equal(new Set(retainedNodes.map(n=>n.key)).size,120,'Each node occurs exactly once across compacted state and later exchanges');
   assert.equal(facts.stagedPlacements.length+recentStages.flatMap(s=>s.placements).length,4);assert(retainedNodes.every(n=>n.fields.TEXT==='x'.repeat(200)));
   return response([call('propose_change',{summary:'完整大方案',edits:[]})]);
  });
  task.host.catalog=()=>[...catalog,{type:'ai_test_payload',source:'toolbox',keywords:['备注']}];
  task.contextSettings={contextTokens:32768,responseTokens:8192,autoCompact:true};
  const before=aiWorkspaceSnapshot(workspace);const result=await runAiTask(task);assert.equal(result.preview.added,120);assert(result.usage.compressions>0);assert.equal(aiWorkspaceSnapshot(workspace),before);
 }finally{workspace.dispose();}
});

test('repeated reads reuse a complete current-context result and report actual provider usage',async()=>{
 const workspace=open();let round=0;
 try {
  const result=await runAiTask(setupTask(workspace,async req=>{
   if(round++<2)return {...response([call('read_workspace',{})]),promptTokens:200,completionTokens:20};
   const rows=req.historyMessages.filter(m=>m.role==='tool');const ref=JSON.parse(rows.at(-1).content);
   assert.equal(ref.unchanged,true);assert.equal(ref.previousToolCallId,rows[0].tool_call_id);assert(JSON.parse(rows[0].content).blocks.length);
   return {content:'完成只读检查',model:'mock',finishReason:'stop',toolCalls:[],promptTokens:250,completionTokens:10};
  }));
  assert.equal(result.usage.inputTokens,650);assert.equal(result.usage.outputTokens,50);assert.equal(result.usage.requests,3);
 }finally{workspace.dispose();}
});

test('long conversations compact without losing original local messages or reusing historical private tokens',async()=>{
 const workspace=open();let compressed=0,memory;
 const conversation=Array.from({length:30},(_,i)=>({id:'history-'+i,role:i%2?'assistant':'user',text:'保留单位摄氏度，不得阻塞。__CK_PRIVATE_1__ '+'metadata '.repeat(400)}));
 const before=JSON.stringify(conversation);
 try {
  const task=setupTask(workspace,async req=>{
   if(!req.tools?.length){compressed++;assert(!req.userMessage.includes('__CK_PRIVATE_1__'));return {content:'用户要求摄氏度、非阻塞；尚未验证真机。',finishReason:'stop',toolCalls:[]};}
   assert(req.historyMessages.some(m=>m.content.includes('摄氏度')));assert(!JSON.stringify(req.historyMessages).includes('__CK_PRIVATE_1__'));
   return {content:'读取当前工程后再继续。',finishReason:'stop',toolCalls:[]};
  });
  task.conversation=conversation;task.contextSettings={contextTokens:16384,responseTokens:2048,autoCompact:true};task.onMemory=value=>memory=value;
  await runAiTask(task);assert(compressed>0);assert(memory.throughId);assert.equal(JSON.stringify(conversation),before);
 }finally{workspace.dispose();}
});

test('active tool compression preserves staged edits and paired calls before a valid preview',async()=>{
 const workspace=open(),before=aiWorkspaceSnapshot(workspace);let round=0,summaries=0;
 try {
  const task=setupTask(workspace,async req=>{
   assert.equal(aiWorkspaceSnapshot(workspace),before);
   if(!req.tools?.length){summaries++;return {content:'保留当前目标：将first改为500；已暂存未应用。库限制需按当前资料核对。',finishReason:'stop',toolCalls:[]};}
   const ids=new Set(req.historyMessages.flatMap(m=>m.tool_calls||[]).map(c=>c.id));for(const row of req.historyMessages.filter(m=>m.role==='tool'))assert(ids.has(row.tool_call_id));
   if(round++===0)return response([call('read_workspace',{})]);
   if(round===2)return response([call('stage_changes',{summary:'先暂存',edits:[{action:'set_field',blockId:'first',field:'MS',value:500}]})]);
   if(round<11)return response([call('get_block_documentation',{type:'ai_test_step',section:'constraints',offset:round-3,limit:1})]);
   return response([call('propose_change',{summary:'完成暂存方案',edits:[]})]);
  });
  task.host.catalog=()=>catalog.map(b=>b.type==='ai_test_step'?{...b,constraints:Array.from({length:10},(_,i)=>({id:'rule-'+i,description:'完整限制'+('x'.repeat(4500))})),metadata_completeness:['constraints']}:b);
  task.contextSettings={contextTokens:16384,responseTokens:2048,autoCompact:true};
  const result=await runAiTask(task);assert(summaries>0);assert.equal(result.preview.changed,1);assert.equal(aiWorkspaceSnapshot(workspace),before);
 }finally{workspace.dispose();}
});

test('tool loop preserves original request/context and stages a real validated preview without applying', async () => {
    const workspace = open(); const before = aiWorkspaceSnapshot(workspace); let round = 0;
    try {
        const result = await runAiTask(setupTask(workspace, async req => {
            if (round++ === 0) return response([call('read_workspace', {})]);
            assert(req.historyMessages.some(m => m.role === 'user' && m.content.includes('500毫秒') && m.content.includes('arduino:avr:uno')));
            return response([call('propose_change', { summary: '只修改第一个等待', edits: [{ action: 'set_field', blockId: 'first', field: 'MS', value: 500 }] })]);
        }));
        assert.equal(result.preview.changed, 1); assert.equal(aiWorkspaceSnapshot(workspace), before);
    } finally { workspace.dispose(); }
});

test('cancelled, incomplete or stale model response never creates an executable preview', async () => {
    for (const scenario of ['cancel','partial','edit']) {
        const workspace = open(); const controller = new AbortController();
        try {
            const task = setupTask(workspace, async () => {
                if (scenario === 'cancel') controller.abort();
                if (scenario === 'edit') workspace.getBlockById('first').setFieldValue(700, 'MS');
                return { ...response([call('propose_change', { summary: '修改', edits: [{ action: 'set_field', blockId: 'first', field: 'MS', value: 500 }] })]), finishReason: scenario === 'partial' ? 'stream_error_partial' : 'tool_calls' };
            }); task.signal = controller.signal;
            await assert.rejects(runAiTask(task));
            assert.equal(workspace.getBlockById('first').getFieldValue('MS'), scenario === 'edit' ? 700 : 1000);
        } finally { workspace.dispose(); }
    }
});

test('explanation mode cannot submit edits and calls have a finite budget', async () => {
    const workspace = open(); let count = 0;
    try {
        const task = setupTask(workspace, async req => { count++; return response([call('propose_change', { summary: '修改', edits: [{ action: 'remove', blockId: 'first' }] })]); });
        task.intent.kind = 'explain';
        await assert.rejects(runAiTask(task), /上限/); assert.equal(count, AI_TASK_LIMITS.rounds);
        assert(workspace.getBlockById('first'));
    } finally { workspace.dispose(); }
});

test('a guessed block ID is rejected until the model has read that block', async () => {
    const workspace = open();
    try {
        const task = setupTask(workspace, async () => response([call('propose_change', { summary: '猜测目标', edits: [{ action: 'remove', blockId: 'first' }] })]));
        await assert.rejects(runAiTask(task), /上限/);
        assert(workspace.getBlockById('first'));
    } finally { workspace.dispose(); }
});

test('batch schemas authorize only returned active types and expose remaining budget', async () => {
    const workspace = open(); let round = 0;
    try {
        const result = await runAiTask(setupTask(workspace, async req => {
            if (round++ === 0) return response([call('read_workspace', {}), call('get_block_schemas', { types: ['ai_test_step','ai_test_enum','invented'] })]);
            const schemas = JSON.parse(req.historyMessages.at(-1).content);
            assert.equal(schemas.schemas.length, 3); assert(schemas.schemas[2].error);
            assert.equal(schemas._budget.callsRemaining, AI_TASK_LIMITS.calls - 2);
            return response([call('propose_change', { summary: '增加实际已查结构', edits: [{ action:'append',blockId:'root',input:'DO',block:{type:'ai_test_enum',fields:{STATE:'ON'}} }] })]);
        }));
        assert.equal(result.preview.added, 1); assert.equal(workspace.getAllBlocks(false).length, 3);
    } finally { workspace.dispose(); }
});

test('a long read-only response continues with per-call feedback instead of dropping all work', async () => {
    const workspace = open(); let round = 0;
    try {
        const result = await runAiTask(setupTask(workspace, async req => {
            if (round++ === 0) return response(Array.from({length:17}, () => call('read_workspace',{})));
            const results = req.historyMessages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
            assert.equal(results.length,17); assert.equal(results[0].blocks.length,3); assert.match(results[16].error,/本调用未执行/);
            return response([call('propose_change',{summary:'继续完成局部修改',edits:[{action:'set_field',blockId:'first',field:'MS',value:500}]})]);
        }));
        assert.equal(result.preview.changed,1);
    } finally { workspace.dispose(); }
});

test('staged edits are atomic, failed reset retains earlier stage, and finalization applies nothing', async () => {
    const workspace = open(); const before=aiWorkspaceSnapshot(workspace); let round=0;
    try {
        const result=await runAiTask(setupTask(workspace,async req=>{
            assert.equal(aiWorkspaceSnapshot(workspace),before);
            switch(round++) {
                case 0:return response([call('read_workspace',{})]);
                case 1:return response([call('stage_changes',{summary:'第一段',edits:[{action:'set_field',blockId:'first',field:'MS',value:111}]})]);
                case 2:assert.equal(JSON.parse(req.historyMessages.at(-1).content).stagedEdits,1);
                    return response([call('stage_changes',{summary:'无效替换不应清除旧段',reset:true,edits:[{action:'remove',blockId:'guessed'}]})]);
                case 3:assert(JSON.parse(req.historyMessages.at(-1).content).error);
                    return response([call('stage_changes',{summary:'第二段',edits:[{action:'set_field',blockId:'second',field:'MS',value:222}]})]);
                default:return response([call('propose_change',{summary:'提交全部',edits:[]})]);
            }
        }));
        const draft=new Blockly.Workspace();
        try { Blockly.serialization.workspaces.load(JSON.parse(result.preview.after),draft);assert.equal(draft.getBlockById('first').getFieldValue('MS'),111);assert.equal(draft.getBlockById('second').getFieldValue('MS'),222); }
        finally { draft.dispose(); }
    } finally { workspace.dispose(); }
});

test('new variable symbols exist before dropdown deserialization and survive apply/undo', async () => {
    Blockly.Blocks.ai_test_variable_ref={init(){this.appendDummyInput().appendField(new Blockly.FieldDropdown(function(){return [['variable','variable'],...(this.getSourceBlock()?.workspace.getVariableMap().getAllVariables()||[]).map(v=>[v.getName(),v.getName()])]}),'NAME');this.setPreviousStatement(true);this.setNextStatement(true);}};
    const workspace=open();const before=aiWorkspaceSnapshot(workspace);
    try {
        const proposal=parseAiProposal({summary:'引入新变量',variables:[{name:'sensorReading'}],edits:[{action:'append',blockId:'root',input:'DO',block:{type:'ai_test_variable_ref',fields:{NAME:'sensorReading'}}}]});
        const preview=previewAiProposal(workspace,proposal,[...catalog,{type:'ai_test_variable_ref',source:'toolbox'}]);
        assert.equal(aiWorkspaceSnapshot(workspace),before);assert.equal(workspace.getVariableMap().getAllVariables().length,0);
        const undo=applyAiPreview(workspace,preview);assert(workspace.getVariableMap().getVariable('sensorReading',''));
        undo.run(false);assert.equal(aiWorkspaceSnapshot(workspace),before);
    } finally { workspace.dispose(); }
});

test('cancel after a valid stage discards drafts without touching the workspace', async () => {
    const workspace=open();const before=aiWorkspaceSnapshot(workspace);const ac=new AbortController();let round=0;
    try {
        const task=setupTask(workspace,async()=>{
            if(round++===0)return response([call('read_workspace',{}),call('stage_changes',{summary:'暂存',edits:[{action:'remove',blockId:'first'}]})]);
            ac.abort();return response([call('propose_change',{summary:'结束',edits:[]})]);
        });task.signal=ac.signal;await assert.rejects(runAiTask(task));assert.equal(aiWorkspaceSnapshot(workspace),before);
    } finally { workspace.dispose(); }
});

test('flat graph resolves forward references and rejects cycles, dangling or duplicate keys', () => {
    const graph={summary:'扁平连接',nodes:[{key:'root',type:'ai_test_root',inputs:{DO:'a'}},{key:'a',type:'ai_test_step',fields:{MS:250},next:'b'},{key:'b',type:'ai_test_step',fields:{MS:500}}],placements:[{action:'add_top',node:'root'}]};
    const expanded=expandAiBlockGraph(graph,new Map());
    assert.equal(expanded.proposal.edits[0].block.inputs.DO.block.next.block.fields.MS,500);
    const cycle=structuredClone(graph);cycle.nodes[2].next='a';assert.throws(()=>expandAiBlockGraph(cycle,new Map()),/存在环/);
    const dangling=structuredClone(graph);dangling.nodes[0].inputs.DO='missing';assert.throws(()=>expandAiBlockGraph(dangling,new Map()),/找不到/);
    assert.throws(()=>expandAiBlockGraph(graph,expanded.nodes),/已存在/);
    assert.equal(expandAiBlockGraph({...graph,reset:true},expanded.nodes).nodes.size,3);
});

test('flat stages compose into one validated preview and failed stages leak no nodes', async()=>{
    const workspace=open();const before=aiWorkspaceSnapshot(workspace);let round=0;
    try {
        const result=await runAiTask(setupTask(workspace,async req=>{
            assert.equal(aiWorkspaceSnapshot(workspace),before);
            switch(round++){
                case 0:return response([call('read_workspace',{}),call('get_block_schemas',{types:['ai_test_step']})]);
                case 1:return response([call('stage_blocks',{summary:'第一段',nodes:[{key:'a',type:'ai_test_step',fields:{MS:12}}],placements:[{action:'append',blockId:'root',input:'DO',node:'a'}]})]);
                case 2:return response([call('stage_blocks',{summary:'拒绝未查类型',nodes:[{key:'b',type:'ai_test_enum'}],placements:[{action:'append',blockId:'root',input:'DO',node:'b'}]})]);
                case 3:assert(JSON.parse(req.historyMessages.at(-1).content).error);return response([call('stage_blocks',{summary:'修正第二段',nodes:[{key:'b',type:'ai_test_step',fields:{MS:34}}],placements:[{action:'append',blockId:'root',input:'DO',node:'b'}]})]);
                default:return response([call('propose_change',{summary:'提交完整方案',edits:[]})]);
            }
        }));assert.equal(result.preview.added,2);assert.equal(result.preview.proposal.edits.length,2);
    }finally{workspace.dispose();}
});

test('large graphs may stage nodes before placement; incomplete responses cannot add partial nodes',async()=>{
    const workspace=open();const before=aiWorkspaceSnapshot(workspace);let round=0;
    try {
        const result=await runAiTask(setupTask(workspace,async req=>{
            assert.equal(aiWorkspaceSnapshot(workspace),before);
            switch(round++) {
                case 0:return response([call('read_workspace',{}),call('get_block_schemas',{types:['ai_test_step']})]);
                case 1:return response([call('stage_blocks',{summary:'节点暂存',nodes:[{key:'a',type:'ai_test_step',fields:{MS:42},next:'b'}],placements:[]})]);
                case 2:return {...response([call('stage_blocks',{summary:'不完整段',nodes:[{key:'b',type:'ai_test_step',fields:{MS:999}}],placements:[]})]),finishReason:'length'};
                case 3:assert.match(req.historyMessages.at(-1).content,/整轮工具均未执行/);return response([call('stage_blocks',{summary:'完整段',nodes:[{key:'b',type:'ai_test_step',fields:{MS:123}}],placements:[{action:'append',blockId:'root',input:'DO',node:'a'}]})]);
                case 4:return {content:'已经完成',finishReason:'stop'};
                default:assert.match(req.historyMessages.at(-1).content,/只有暂存/);return response([call('propose_change',{summary:'完整提交',edits:[]})]);
            }
        }));assert.equal(result.preview.added,2);assert.equal(result.preview.proposal.edits[0].block.next.block.fields.MS,123);
    }finally{workspace.dispose();}
});

test('tool-round reasoning is preserved in memory and not presented as user-facing text',async()=>{
    const workspace=open();let round=0;const visible=[];
    try {
        const task=setupTask(workspace,async req=>{
            if(round++===0)return {...response([call('read_workspace',{})]),reasoningContent:'provider continuation state'};
            assert.equal(req.historyMessages.find(m=>m.role==='assistant').reasoning_content,'provider continuation state');
            return response([call('propose_change',{summary:'改等待时间',edits:[{action:'set_field',blockId:'first',field:'MS',value:99}]})]);
        });task.onText=t=>visible.push(t);
        const result=await runAiTask(task);assert(result.preview);assert(!visible.join('').includes('provider continuation state'));
    }finally{workspace.dispose();}
});

test('library declarations reach the tool loop without granting edit authorization or exposing secrets',async()=>{
    const workspace=open(),before=aiWorkspaceSnapshot(workspace);let round=0;
    const enriched=catalog.map(b=>b.type==='ai_test_step'?{...b,library_id:'third_party_fixture',semantics:{purpose:'专用测试等待',behavior:'等待输入毫秒数',concepts:['测试计时']},constraints:[{id:'limit',description:'最大500毫秒',message:'不要超过500',severity:'warning'}],examples:[{id:'example',description:'test-key'}]}:b);
    try{
        const task=setupTask(workspace,async req=>{
            assert.equal(aiWorkspaceSnapshot(workspace),before);
            assert(!req.tools.some(t=>t.function.name==='install_library'));
            if(round++===0)return response([call('read_workspace',{}),call('list_libraries',{query:'测试计时'}),call('search_blocks',{query:'测试计时'}),call('get_block_documentation',{type:'ai_test_step',section:'constraints'}),call('get_block_documentation',{type:'ai_test_step',section:'examples'})]);
            const results=req.historyMessages.filter(m=>m.role==='tool').map(m=>({name:m.name,data:JSON.parse(m.content)}));
            assert.equal(results.find(r=>r.name==='list_libraries').data.libraries[0].libraryId,'third_party_fixture');
            assert.equal(results.find(r=>r.name==='search_blocks').data.blocks[0].type,'ai_test_step');
            assert.equal(results.find(r=>r.name==='get_block_documentation').data.records[0].id,'limit');
            assert(!JSON.stringify(results).includes('test-key'));
            if(round===2)return response([call('propose_change',{summary:'尝试未查询结构的新增',edits:[{action:'append',blockId:'root',input:'DO',block:{type:'ai_test_step',fields:{MS:20}}}]})]);
            if(round===3){assert.match(results.at(-1).data.error,/先查询/);return response([call('get_block_schema',{type:'ai_test_step'})]);}
            assert.equal(results.at(-1).data.capability.purpose,'专用测试等待');
            return response([call('propose_change',{summary:'已查询结构后新增',edits:[{action:'append',blockId:'root',input:'DO',block:{type:'ai_test_step',fields:{MS:20}}}]})]);
        });task.host.catalog=()=>enriched;
        const result=await runAiTask(task);assert.equal(result.preview.added,1);assert.equal(aiWorkspaceSnapshot(workspace),before);
    }finally{workspace.dispose();}
});


test('phase2 compiles the isolated proposal before preview and repairs actual errors without editing the project', async () => {
 const workspace=open(),before=aiWorkspaceSnapshot(workspace);let round=0;const compiled=[],records=[];
 try {
  const task=setupTask(workspace,async req=>{
   assert.equal(aiWorkspaceSnapshot(workspace),before);
   if(round++===0)return response([call('read_workspace',{}),call('set_task_plan',{steps:['保留第二个等待','修改第一个并编译验证']})]);
   if(round===2)return response([call('propose_change',{summary:'先尝试500',edits:[{action:'set_field',blockId:'first',field:'MS',value:500}]})]);
   const failure=req.historyMessages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content)).find(v=>v.compiled===false);
   assert(failure);assert.match(failure.diagnostics[0].message,/actual compiler error/);
   assert.equal(failure.repairsRemaining,2);
   return response([call('propose_change',{summary:'按错误修复为600',edits:[{action:'set_field',blockId:'first',field:'MS',value:600}]})]);
  });
  let plan;task.onPlan=v=>plan=v;task.onValidation=r=>records.push(r);
  task.host.validateCandidate=async (preview,ctx)=>{
   assert.equal(aiWorkspaceSnapshot(workspace),before);assert(!ctx.signal.aborted);
   compiled.push({preview,ctx});
   return {ok:compiled.length===2,runId:crypto.randomUUID(),sourceSha256:'candidate',elapsedMs:12,log:'actual compiler error',diagnostics:[{message:'actual compiler error',line:3}],artifactCount:compiled.length===2?1:0};
  };
  const result=await runAiTask(task);assert.equal(compiled.length,2);assert.equal(records.length,2);assert.equal(plan.length,2);
  assert.equal(compiled[0].ctx.candidateId,compiled[1].ctx.candidateId);assert.equal(result.preview.proposal.edits[0].value,600);
  assert.equal(result.preview.proposal.edits.length,1);assert.equal(aiWorkspaceSnapshot(workspace),before);
  assert.match(result.text,/尚未应用/);assert.equal(result.validations[0].ok,false);assert.equal(result.validations[1].ok,true);
 }finally{workspace.dispose();}
});

test('phase2 stops after three failed compiles with no applicable preview and keeps all failures',async()=>{
 const workspace=open(),before=aiWorkspaceSnapshot(workspace);let round=0,compiles=0;
 try {
  const task=setupTask(workspace,async()=>response(round++===0?[call('read_workspace',{})]:[call('propose_change',{summary:'修复尝试',edits:[{action:'set_field',blockId:'first',field:'MS',value:400+round}]})]));
  task.host.validateCandidate=async()=>({ok:false,runId:crypto.randomUUID(),sourceSha256:'candidate',elapsedMs:++compiles,log:'failed',diagnostics:[],artifactCount:0});
  const result=await runAiTask(task);assert.equal(compiles,3);assert.equal(result.preview,undefined);assert.equal(result.validations.length,3);assert.equal(aiWorkspaceSnapshot(workspace),before);
 }finally{workspace.dispose();}
});

test('phase2 abort waits for candidate cleanup and cannot return a successful late preview',async()=>{
 const workspace=open(),controller=new AbortController();let round=0,cleaned=false;
 try {
  const task=setupTask(workspace,async()=>response(round++===0?[call('read_workspace',{})]:[call('propose_change',{summary:'修改',edits:[{action:'set_field',blockId:'first',field:'MS',value:600}]})]));
  task.signal=controller.signal;
  task.host.validateCandidate=async(_p,ctx)=>{setTimeout(()=>controller.abort(),10);await new Promise(resolve=>ctx.signal.addEventListener('abort',()=>setTimeout(()=>{cleaned=true;resolve();},30),{once:true}));return {ok:true,log:'late',diagnostics:[]};};
  await assert.rejects(runAiTask(task));assert(cleaned);assert.equal(workspace.getBlockById('first').getFieldValue('MS'),1000);
 }finally{workspace.dispose();}
});

test('phase2 project and target changes cancel a candidate in flight and never apply stale output',async()=>{
 for(const mutate of ['workspace','target']){
  const workspace=open();let round=0,identity='original',aborted=false;
  try {
   const task=setupTask(workspace,async()=>response(round++===0?[call('read_workspace',{})]:[call('propose_change',{summary:'修改',edits:[{action:'set_field',blockId:'first',field:'MS',value:600}]})]));
   task.host.identity=()=>identity;
   task.host.validateCandidate=async(_p,ctx)=>{
    setTimeout(()=>{if(mutate==='workspace')workspace.getBlockById('second').setFieldValue(777,'MS');else identity='changed';},10);
    await new Promise(resolve=>ctx.signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));ctx.signal.throwIfAborted();
   };
   await assert.rejects(runAiTask(task),/变化/);assert(aborted);assert.equal(workspace.getBlockById('first').getFieldValue('MS'),1000);
  }finally{workspace.dispose();}
 }
});

test('phase2 infrastructure failures stop instead of spending model tokens on compile retries',async()=>{
 const workspace=open();let round=0,compiles=0;
 try {
  const task=setupTask(workspace,async()=>response(round++===0?[call('read_workspace',{})]:[call('propose_change',{summary:'修改',edits:[{action:'set_field',blockId:'first',field:'MS',value:600}]})]));
  task.host.validateCandidate=async()=>{compiles++;throw Error('native unavailable');};
  await assert.rejects(runAiTask(task),/native unavailable/);assert.equal(compiles,1);assert.equal(round,2);
 }finally{workspace.dispose();}
});

test('phase2 read-only explanations never start a compiler',async()=>{
 const workspace=open();let compiles=0;
 try {
  const task=setupTask(workspace,async()=>({content:'只解释',finishReason:'stop',toolCalls:[]}));task.intent.kind='explain';
  task.host.validateCandidate=async()=>{compiles++;throw Error('unexpected');};
  const result=await runAiTask(task);assert.equal(compiles,0);assert.equal(result.preview,undefined);
 }finally{workspace.dispose();}
});


test('phase2 headless generation consumes candidate bytes and always releases workspace/events',()=>{
 const workspace=open(),before=aiWorkspaceSnapshot(workspace);
 try{
  const preview=previewAiProposal(workspace,plan([{action:'set_field',blockId:'first',field:'MS',value:500}]),catalog);
  let candidate;
  const result=generateAiCandidate(preview,ws=>{candidate=ws;assert.notEqual(ws,workspace);return 'void setup(){delay('+ws.getBlockById('first').getFieldValue('MS')+');}\nvoid loop(){}';});
  assert.match(result.code,/delay\(500\)/);assert.equal(result.sourceMap.codeSha256.length,64);assert.equal(aiWorkspaceSnapshot(workspace),before);assert(Blockly.Events.isEnabled());assert.equal(candidate.getAllBlocks(false).length,0);
  assert.throws(()=>generateAiCandidate(preview,()=>{throw Error('generator failed');}),/generator failed/);assert(Blockly.Events.isEnabled());assert.equal(aiWorkspaceSnapshot(workspace),before);
 }finally{workspace.dispose();}
});


test('phase2 compact schemas retain complete templates and field domains and distinguish untyped output',()=>{
 const full=aiBlockSchema('ai_test_enum',catalog),compact=compactAiSchema(full);
 assert.deepEqual(compact.template,full.template);assert.deepEqual(compact.fields,full.fields);assert.deepEqual(compact.inputs,full.inputs);assert.equal(compact.hasOutput,false);
 assert.equal(aiBlockSchema('math_number',catalog).hasOutput,true);assert(compact.docs);
});

test('phase2 compaction retains exact checked schemas and original block targets without repeated schema calls',async()=>{
 const workspace=open();let round=0,compacted=false;
 try{
  const task=setupTask(workspace,async req=>{
   if(!req.tools?.length){compacted=true;return {content:'保留用户目标，准备使用已核对字段构造方案',finishReason:'stop',toolCalls:[]};}
   if(round++===0)return response([call('read_workspace',{}),call('get_block_schemas',{types:['ai_test_step','ai_test_enum']})]);
   if(round===2)return response([call('stage_blocks',{summary:'精确暂存',nodes:[{key:'head',type:'ai_test_step',fields:{MS:345},next:'tail'},{key:'tail',type:'ai_test_enum',fields:{STATE:'OFF'}}],placements:[]})]);
   if(round<9)return response([call('get_block_documentation',{type:'ai_test_step',section:'constraints',offset:round-2,limit:1})]);
   const state=req.historyMessages.map(r=>r.content).find(c=>c.includes('knownSchemas'));
   assert(compacted);assert(state);const facts=JSON.parse(state.slice(state.indexOf('{')));
   assert.deepEqual(facts.knownSchemas.find(s=>s.type==='ai_test_enum').fields,compactAiSchema(aiBlockSchema('ai_test_enum',catalog)).fields);
   assert(facts.observedBlocks.some(b=>b.id==='first'&&b.type==='ai_test_step'));
   assert.deepEqual(facts.stagedNodes.find(n=>n.key==='head'),{key:'head',type:'ai_test_step',fields:{MS:345},next:'tail'});
   if(round===9)return response([call('read_staged_plan',{keys:['tail','missing']})]);
   if(round===10){const lookup=JSON.parse(req.historyMessages.findLast(r=>r.role==='tool').content);assert.equal(lookup.nodes[0].fields.STATE,'OFF');assert.equal(lookup.nodes[1].missing,true);assert.equal(lookup.nextOffset,null);return response([call('stage_blocks',{summary:'放置精确节点',nodes:[],placements:[{action:'append',blockId:'root',input:'DO',node:'head'}]})]);}
   return response([call('propose_change',{summary:'使用保留结构',edits:[]})]);
  });
  task.host.catalog=()=>catalog.map(b=>b.type==='ai_test_step'?{...b,constraints:Array.from({length:10},(_,i)=>({id:'long-'+i,description:'x'.repeat(7000)})),metadata_completeness:['constraints']}:b);
  task.contextSettings={contextTokens:16384,responseTokens:2048,autoCompact:true};
  const result=await runAiTask(task);assert(result.preview);assert.equal(result.preview.proposal.edits[0].block.fields.MS,345);assert.equal(result.preview.proposal.edits[0].block.next.block.fields.STATE,'OFF');
 }finally{workspace.dispose();}
});
