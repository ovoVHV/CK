import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {build} from 'esbuild';
const root=path.dirname(fileURLToPath(import.meta.url)),temp=path.resolve(root,'../../node_modules/.cache/ck-ai-attachment-tests');fs.mkdirSync(temp,{recursive:true});const entry=path.join(temp,'entry.mjs'),output=path.join(temp,'runtime.mjs');
fs.writeFileSync(entry,`export * from ${JSON.stringify(path.join(root,'ai_attachments.ts'))};export * from ${JSON.stringify(path.join(root,'ai_context.ts'))};export * from ${JSON.stringify(path.join(root,'ai_chat_store.ts'))};`);
await build({entryPoints:[entry],outfile:output,platform:'node',format:'esm',bundle:true,packages:'external',logLevel:'silent'});
const {importAiAttachment,readAiAttachment,validateAiAttachments,prepareAiConversation,estimateAiTokens,DEFAULT_AI_PREFERENCES,readAiChatHistory}=await import(pathToFileURL(output));
test('UTF-8 source imports and paginates without truncating material or treating file data as instructions',async()=>{
 const text='GPIO13 中文\n'+'x'.repeat(13000),f=await importAiAttachment(new File([text],'驱动.cpp'));
 assert.equal(f.name,'驱动.cpp');assert.equal(f.content,text);let result='',offset=0;do{const page=readAiAttachment([f],f.id,offset);result+=page.text;offset=page.nextOffset;}while(offset!==null);assert.equal(result,text);
 assert.throws(()=>readAiAttachment([f],'unknown'));assert.throws(()=>readAiAttachment([f],f.id,-1));
});
test('invalid UTF-8, unsupported binary, oversized and excessive attachments fail explicitly',async()=>{
 for(const f of [new File([new Uint8Array([0xff,0xfe,0x80])],'bad.txt'),new File(['binary'],'bad.zip'),new File(['x'.repeat(128001)],'large.txt'),new File(['\0binary'],'bad.ino')])await assert.rejects(importAiAttachment(f));
 const f=await importAiAttachment(new File(['text'],'valid.txt'));assert.throws(()=>validateAiAttachments([f,f]));assert.throws(()=>validateAiAttachments(Array.from({length:5},(_,i)=>({...f,id:String(i)}))));
 assert.throws(()=>validateAiAttachments([{...f,kind:'image',content:'https://private.test/file'}]));
});
test('pictures remain real visual inputs, token estimate does not count base64 as prose, history index survives compaction',async()=>{
 const image={id:'image',name:'接线.png',kind:'image',mime:'image/png',size:500000,content:'data:image/png;base64,'+'a'.repeat(600000)},text={id:'source',name:'驱动.cpp',kind:'text',mime:'text/plain',size:5,content:'pin13'};
 const messages=[{id:'first',role:'user',text:'查看接线与源码',attachments:[image,text]}];
 const result=await prepareAiConversation({messages,settings:{contextTokens:16384,responseTokens:2048,autoCompact:true},fixedTokens:3000,summarize:async()=>{throw Error('One image should fit without summarization');}});
 assert.equal(result.history[0].images[0],image.content);assert(result.history[0].content.includes('驱动.cpp'));assert(!result.history[0].content.includes('pin13'));
 assert(estimateAiTokens(result.history)>2000&&estimateAiTokens(result.history)<5000);
 assert.equal(readAiChatHistory(messages,{query:'接线'}).messages[0].attachments[1].id,'source');
 assert.equal(DEFAULT_AI_PREFERENCES.autoApply,true);assert.equal(DEFAULT_AI_PREFERENCES.reasoningEffort,'auto');
});
test('multibyte text is budgeted in UTF-8 bytes together with image data',()=>{
 const image={id:'i1',name:'i.png',kind:'image',mime:'image/png',size:900000,content:'data:image/png;base64,'+'a'.repeat(925000)};
 const text={id:'t1',name:'t.txt',kind:'text',mime:'text/plain',size:384000,content:'中'.repeat(128000)};
 assert.throws(()=>validateAiAttachments([image,{...image,id:'i2'},text,{...text,id:'t2'}]),/过大/);
});
