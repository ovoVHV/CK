export type AiDeviceGrants = { files: boolean; create: boolean; serial: boolean; send: boolean; upload: boolean };
export const noDeviceGrants: AiDeviceGrants = {files:false,create:false,serial:false,send:false,upload:false};
export type NewProjectSource = {path:string;code:string};
export function projectSourceBatch(value:unknown,target:unknown):NewProjectSource[]{
    if(!Array.isArray(value)||value.length<1||value.length>8)throw Error('一次需要 1–8 个新源码文件');
    const board=target as {fqbn?:string;board?:string}|null;
    const avr=(board?.fqbn||board?.board||'').split(':')[1]?.toLowerCase()==='avr';
    const paths=new Set<string>();
    return value.map(f=>{
        const path=f?.path,code=f?.code;
        if(typeof path!=='string'||!path.startsWith('src/')||path.length>240||
            path.split('/').some(s=>!s||s.startsWith('.')||/[. ]$|[<>:"\\|?*\x00-\x1f\x7f]/.test(s)||/^(?:con|prn|aux|nul|(?:com|lpt)[1-9])(?:\.|$)/i.test(s))||
            !(/\.(?:h|hpp|hh|hxx|inc|ipp|tpp)$/i.test(path)||/\.(?:cpp|cc|cxx|c|S)$/.test(path))||paths.has(path.toLowerCase()))throw Error('需要 src/ 下无重复的工程源码相对路径');
        if(typeof code!=='string'||!code.trim()||code.includes('\0')||new TextEncoder().encode(code).length>65536)throw Error('源码不能为空，每个文件最多 64 KiB');
        if(avr&&/[^\x20-\x7e]/.test(path))throw Error('当前 AVR 工具链可能无法解析中文 #include 路径。新建文件及子目录请使用英文、数字等 ASCII 名称，例如 src/sampling/sample.h；工程名和代码注释可保留中文。');
        paths.add(path.toLowerCase());return {path,code};
    });
}
export type AiSerialSample = {port:string;baud:number;observedMs:number;sentBytes:number;receivedBytes:number;truncated:boolean;text:string};
export type AiDeviceHost = {
    files:(name?:string,offset?:number)=>Promise<unknown>;
    create?:(files:NewProjectSource[],check:()=>void)=>Promise<void>;
    sample:(text:string|undefined,waitMs:number,check:()=>void)=>Promise<AiSerialSample>;
};

export async function projectFilePage(names:string[], read:(name:string)=>Promise<{code:string;dirty?:boolean}>, name?:string, offset=0) {
    if(!Number.isSafeInteger(offset)||offset<0)throw Error('分页位置无效');
    if(name===undefined)return {files:names.slice(offset,offset+32),total:names.length,nextOffset:offset+32<names.length?offset+32:null};
    if(typeof name!=='string'||!names.includes(name))throw Error('只能读取当前工程文件树中列出的源码');
    const {code,dirty}=await read(name);
    return {path:name,unsaved:!!dirty,text:code.slice(offset,offset+4000),nextOffset:offset+4000<code.length?offset+4000:null};
}

export function serialRequest(args:{text?:unknown;waitMs?:unknown}, grants:AiDeviceGrants) {
    if(!grants.serial)throw Error('未授权读取所选串口');
    const text=args.text, waitMs=args.waitMs??1000;
    if(text!==undefined && (!grants.send||typeof text!=='string'||!text.length||new TextEncoder().encode(text).length>256||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)))throw Error('未授权发送串口文本，或文本无效（最多 256 字节）');
    if(typeof waitMs!=='number'||!Number.isInteger(waitMs)||waitMs<100||waitMs>3000)throw Error('串口采样窗口须为 100–3000 毫秒');
    return {text:text as string|undefined,waitMs};
}
