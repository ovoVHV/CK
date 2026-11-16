let mode='normal';
export const setFixtureMode=(value:string)=>{mode=value;};
const listeners=new Set<(event:any)=>void>();
export const listen=async(_name:string,listener:(event:any)=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);};
const call=(name:string,args:unknown)=>({id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}});
export async function invoke(command:string,args:any){
 if(command==='cancel_glm_stream')return 'cancelled';
 if(mode==='slow')await new Promise(resolve=>setTimeout(resolve,15000));
 if(mode==='error')throw new Error('LLM API HTTP 401: Test credential rejected. 请检查 API 密钥。');
 const req=args.req;await new Promise(resolve=>setTimeout(resolve,200));
 if(mode==='long'){const text=('这是用于检查长文本换行和滚动的测试说明。当前工作区包含循环与等待积木。\n\n'+ 'very_long_error_or_library_identifier_'.repeat(5)+'\n').repeat(8);return {content:text,finishReason:'stop',toolCalls:[]};}
 if(!req.historyMessages.some((x:any)=>x.role==='tool'))return {content:'',finishReason:'tool_calls',toolCalls:[call('read_workspace',{})]};
 return {content:'',finishReason:'tool_calls',toolCalls:[call('propose_change',{summary:'将等待时间从 1000 毫秒改为 500 毫秒，保留其他积木。',edits:[{action:'set_field',blockId:'delay',field:'MS',value:500}]})]};
}
