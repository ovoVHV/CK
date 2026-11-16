const listeners=new Set<(event:{payload:string})=>void>();
export async function listen(name:string,callback:(event:{payload:string})=>void){
 if(name==='serial-data') listeners.add(callback);
 return ()=>listeners.delete(callback);
}
export function emitSample(payload:string){for(const callback of listeners)callback({payload});}
