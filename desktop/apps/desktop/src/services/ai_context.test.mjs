import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const root=path.dirname(fileURLToPath(import.meta.url));
const temp=path.resolve(root,'../../node_modules/.cache/ck-ai-context-tests');fs.mkdirSync(temp,{recursive:true});
const entry=path.join(temp,'entry.mjs'),output=path.join(temp,'runtime.mjs');
fs.writeFileSync(entry,`export * from ${JSON.stringify(path.join(root,'ai_context.ts'))};export * from ${JSON.stringify(path.join(root,'ai_chat_store.ts'))};`);
await build({entryPoints:[entry],outfile:output,platform:'node',format:'esm',bundle:true,packages:'external',logLevel:'silent'});
const {prepareAiConversation,estimateAiTokens,validateAiContext,DEFAULT_AI_CONTEXT,splitAiToolHistory,AiChatWriter,newAiChat,historicalText,readAiChatHistory}=await import(pathToFileURL(output));
const settings={contextTokens:16384,responseTokens:2048,autoCompact:true};
const messages=()=>Array.from({length:40},(_,i)=>({id:`m${i}`,role:i%2?'assistant':'user',text:`必须保留第${i}项约束，`+'sample data '.repeat(300)}));
test('older chat details remain searchable after compression and long messages have explicit continuation',()=>{
 const source=[{id:'long',role:'user',text:'记住GPIO17 '+('detail '.repeat(1500))+'END'},{id:'other',role:'user',text:'无关内容'}];
 const first=readAiChatHistory(source,{query:'GPIO17'});assert.equal(first.total,1);assert.equal(first.messages[0].nextTextOffset,6000);
 const second=readAiChatHistory(source,{messageId:'long',textOffset:6000});assert.equal(second.messages[0].nextTextOffset,null);assert(second.messages[0].text.endsWith('END'));
 assert.equal(first.messages[0].text+second.messages[0].text,source[0].text);assert.throws(()=>readAiChatHistory(source,{textOffset:1}),/messageId/);
});
test('context limits reserve output and estimates include Chinese, code and tools',()=>{
 assert.deepEqual(validateAiContext(DEFAULT_AI_CONTEXT),DEFAULT_AI_CONTEXT);
 for(const value of [{...settings,contextTokens:100},{...settings,responseTokens:16384},{...settings,responseTokens:NaN}])assert.throws(()=>validateAiContext(value));
 assert(estimateAiTokens('汉字测试')>estimateAiTokens('abcd'));assert(estimateAiTokens({tools:[{name:'schema',parameters:'x'.repeat(1000)}]})>300);
 assert.match(historicalText('__CK_PRIVATE_2__'),/重新读取/);
});
test('compression keeps complete local transcript and latest messages, resumes from stable prefix',async()=>{
 const source=messages(),before=JSON.stringify(source);let memory,requests=0;
 const prepared=await prepareAiConversation({messages:source,settings,fixedTokens:4000,onMemory:value=>memory=value,summarize:async text=>{
  requests++;const parsed=JSON.parse(text);assert(parsed.messages.every(row=>row.id&&row.text));return '保留目标：读取传感器；不得阻塞；温度单位摄氏度；尚未做真机验证。';
 }});
 assert(requests>0);assert.equal(JSON.stringify(source),before);assert(memory);assert.equal(prepared.history.at(-1).content,source.at(-1).text);
 assert(estimateAiTokens(prepared.history)+4000<=settings.contextTokens-settings.responseTokens);
 const continued=await prepareAiConversation({messages:source,memory,settings,fixedTokens:4000,summarize:async()=>{throw Error('Already compressed prefix must not be resent');}});
 assert.deepEqual(continued.history,prepared.history);
});
test('failed or disabled compression preserves original messages and never submits oversized request',async()=>{
 const source=messages(),before=JSON.stringify(source);
 await assert.rejects(prepareAiConversation({messages:source,settings:{...settings,autoCompact:false},fixedTokens:4000,summarize:async()=>{throw Error('must not call');}}),/上下文已满/);
 await assert.rejects(prepareAiConversation({messages:source,settings,fixedTokens:4000,summarize:async()=>{throw Error('cancelled');}}),/cancelled/);
 assert.equal(JSON.stringify(source),before);
});
test('tool compaction splits only complete exchanges, preserving the current paired result',()=>{
 const h=[{role:'user',content:'request'},{role:'assistant',content:'',tool_calls:[{id:'a'}]},{role:'tool',tool_call_id:'a',content:'old'},
 {role:'assistant',content:'',tool_calls:[{id:'b'},{id:'c'}]},{role:'tool',tool_call_id:'b',content:'new'},{role:'tool',tool_call_id:'c',content:'new'}];
 const split=splitAiToolHistory(h);assert.equal(split.older.length,2);assert.equal(split.recent.length,3);
 assert.equal(split.recent[0].tool_calls.length,2);assert.equal(split.recent[2].tool_call_id,'c');assert.deepEqual(split.prefix,[h[0]]);
});
test('chat writer serializes revision changes and refuses to overwrite after a conflict',async()=>{
 const calls=[];const writer=new AiChatWriter(async value=>{calls.push(structuredClone(value));await new Promise(r=>setTimeout(r,5));return value.revision+1;});
 const c=newAiChat('test-project');c.messages=[{id:'1',role:'user',text:'first'}];
 const a=writer.save(c);c.messages.push({id:'2',role:'assistant',text:'second'});const b=writer.save(c);await Promise.all([a,b]);await writer.flush();
 assert.deepEqual(calls.map(v=>v.revision),[0,1]);assert.deepEqual(calls.map(v=>v.messages.length),[1,2]);assert.equal(writer.revision(c.id),2);
 let count=0;const failing=new AiChatWriter(async()=>{count++;throw Error('revision conflict');});
 await assert.rejects(failing.save(c),/conflict/);await assert.rejects(failing.save(c),/conflict/);assert.equal(count,1);
});
