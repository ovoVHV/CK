import { newAiLibraryDraft, stageAiLibrary, type AiLibraryDraft } from './ai_library_authoring';

export function forkAiLibrary(bundle: { packageId: string; contentSha256: string; files: Record<string,string> }) {
    if (!/^ck_ai_[a-f0-9]{12}$/.test(bundle.packageId)) throw Error('当前只支持复制修订CK AI声明式库，不覆盖第三方库');
    const files = bundle.files, manifest = JSON.parse(files['library.json']), contract = JSON.parse(files['ck-blocks.json']);
    const definitions = JSON.parse(files['blocks/blocks.json']), rules = JSON.parse(files['blocks/ck-generator.json']).rules;
    if (manifest.id !== bundle.packageId || contract.id !== bundle.packageId || !Array.isArray(definitions) || !Array.isArray(rules)
        || contract.entrypoints?.generator !== 'blocks/ck-generator.json' || !files.LICENSE) throw Error('库不具备可安全修订的声明式结构');
    let draft = newAiLibraryDraft();
    const mapping = new Map<string,string>([[bundle.packageId, draft.id]]);
    for (const path of Object.keys(files).filter(p=>p.startsWith('src/'))) mapping.set(path.slice(4), `${draft.id}_${path.slice(4)}`);
    const pattern = new RegExp([...mapping.keys()].sort((a,b)=>b.length-a.length).map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'g');
    const remap = (value: any): any => {
        if (typeof value === 'string') return value.replace(pattern,match=>mapping.get(match)!);
        if (Array.isArray(value)) return value.map(remap);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,remap(v)]));
        return value;
    };
    const typeMap = Object.fromEntries(definitions.map((d:any)=>[d.type,String(d.type).replace(bundle.packageId,draft.id)]));
    if (definitions.some((d:any)=>typeof d.type!=='string'||!d.type.startsWith(bundle.packageId+'_'))) throw Error('原库含非本库积木类型');
    const version = String(manifest.version).match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!version) throw Error('原库版本格式无效');
    draft = { ...draft, origin:{packageId:bundle.packageId,version:manifest.version,contentSha256:bundle.contentSha256,license:files.LICENSE,licenseId:contract.license?.spdx_id || 'LicenseRef-User-Review'} };
    draft = stageAiLibrary(draft,{name:manifest.name+' 修订版',description:manifest.description || manifest.name,version:`${version[1]}.${version[2]}.${Number(version[3])+1}`,
        readme:`基于 ${bundle.packageId} v${manifest.version} 修订；原内容 SHA256 ${bundle.contentSha256}。原库保留，只有用户确认的新工程方案使用修订版。\n\n${files['README.md'] || ''}`});
    for (let offset=0;offset<definitions.length;offset+=8) {
        const blocks=definitions.slice(offset,offset+8).map((definition:any)=>{
            const doc=contract.blocks?.find((r:any)=>r.type===definition.type),generator=rules.find((r:any)=>r.type===definition.type);
            if(!doc||!generator)throw Error('原库声明或生成规则缺失');
            return remap({definition,generator,documentation:{...doc,
                fieldDescriptions:Object.fromEntries((doc.fields||[]).map((f:any)=>[f.name,f.description||f.name])),
                inputDescriptions:Object.fromEntries((doc.inputs||[]).map((f:any)=>[f.name,f.description||f.name]))}});
        });
        draft=stageAiLibrary(draft,{blocks});
    }
    const sources=Object.entries(files).filter(([p])=>p.startsWith('src/')).map(([p,content])=>({path:'src/'+mapping.get(p.slice(4)),content:remap(content)}));
    for(let i=0;i<sources.length;i+=8)draft=stageAiLibrary(draft,{files:sources.slice(i,i+8)});
    return {draft:draft as AiLibraryDraft,typeMap};
}
