// A different discovery frontend cannot repair exhausted host resources.
// Do not turn a native tool failure into a second complete compiler run.
export function isResourceExhaustion(error){
 return error?.code==='ENOSPC'||error?.code==='ENOMEM'||/No space left on device|not enough space on (?:the )?disk|disk (?:is )?full|磁盘空间不足|磁碟空間不足|Cannot allocate memory|out of memory|std::bad_alloc/i.test(String(error?.message??error));
}
export function attachFallbackAttempt(result,attempt,totalMs){
 return {...result,wallMs:totalMs,fallbackAttempts:[{label:attempt.label,elapsedMs:attempt.wallMs,error:attempt.error,phases:attempt.phases},...(result.fallbackAttempts??[])]};
}
