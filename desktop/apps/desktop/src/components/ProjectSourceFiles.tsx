import { lazy, Suspense, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { ChevronRight, Code2, Ellipsis, FileCode2, FilePlus2, FileText, Folder, FolderOpen, FolderSearch, PanelRightClose, PanelRightOpen, Pencil, RefreshCw, Save, Trash2, X } from 'lucide-react';
import './ProjectSourceFiles.css';

const Editor = lazy(() => import('./SourceCodeEditor').then(m => ({default:m.SourceCodeEditor})));
const diagnostics: never[] = [];
type Doc = {name:string;code:string;original:string;revision:string};
type Action = {kind:'create'|'rename'|'delete'|'discard';name:string;revision?:string};
export type ProjectFilesHandle = {pending:()=>boolean; saveAll:()=>Promise<boolean>; refresh:()=>Promise<void>; showMain:()=>void; draft:(name:string)=>{code:string;dirty:boolean}|undefined};
type Branch = {dirs:Map<string,Branch>;files:string[]};
const branch = ():Branch => ({dirs:new Map(),files:[]});
function fileTree(names:string[]) {
    const root=branch();
    for(const name of names){
        let at=root;
        for(const part of name.split('/').slice(0,-1)){
            if(!at.dirs.has(part)) at.dirs.set(part,branch());
            at=at.dirs.get(part)!;
        }
        at.files.push(name);
    }
    return root;
}
const basename=(name:string)=>name.split('/').pop();
const dirty=(d:Doc)=>d.code!==d.original;
type TreeProps={tree:Branch;prefix:string;active:string|null;docs:Doc[];busy:boolean;disabled:boolean;menu:string|null;
    select:(name:string)=>void; setMenu:(name:string|null)=>void; action:(kind:'rename'|'delete',name:string)=>void;
    start:(event:ReactPointerEvent<HTMLButtonElement>,name:string)=>void};
function Entries(props:TreeProps) {
    const {tree,active,docs,busy,disabled,menu,select,setMenu,action}=props;
    return <>{Array.from(tree.dirs,([dir,children])=><details open key={dir}>
        <summary data-drop-dir={props.prefix+dir+'/'}><ChevronRight size={12}/><Folder size={15}/><span>{dir}</span></summary>
        <div className="ck-tree-children"><Entries {...props} prefix={props.prefix+dir+'/'} tree={children}/></div></details>)}{tree.files.map(name=>{
        const header=/\.(?:h|hh|hpp|hxx|inc|ipp|tpp)$/i.test(name), Icon=header?FileText:FileCode2;
        return <div className="ck-tree-item" key={name} data-active={active===name}>
            <div className="ck-tree-row" onContextMenu={e=>{e.preventDefault();if(!disabled&&!busy)setMenu(name);}}>
                <button type="button" title={name} aria-current={active===name?'page':undefined} className="ck-tree-leaf" disabled={busy}
                    onPointerDown={e=>{if(!disabled&&!busy)props.start(e,name);}} onClick={()=>select(name)} onKeyDown={e=>{
                        if(disabled||busy)return;
                        if(e.key==='F2'||e.key==='Delete'){e.preventDefault();action(e.key==='F2'?'rename':'delete',name);}
                    }}><Icon size={15} className={header?'ck-header-icon':'ck-unit-icon'}/><span>{basename(name)}</span>
                    {docs.some(d=>d.name===name&&dirty(d))&&<i className="ck-source-dirty" aria-label="未保存"/>}</button>
                <button type="button" className="ck-file-more" aria-label={`${name} 的文件操作`} aria-expanded={menu===name}
                    title="文件操作" disabled={disabled||busy} onClick={()=>setMenu(menu===name?null:name)}><Ellipsis size={15}/></button>
            </div>
            {menu===name&&<div className="ck-file-actions">
                <button type="button" onClick={()=>action('rename',name)}><Pencil size={13}/>重命名或移动</button>
                <button type="button" onClick={()=>action('delete',name)}><Trash2 size={13}/>删除文件</button>
            </div>}
        </div>;
    })}</>;
}
export function ProjectSourceFiles({path,disabled,dark,handle,onBuild}:{path:string;disabled:boolean;dark:boolean;handle:Ref<ProjectFilesHandle>;onBuild:()=>void}) {
    const [names,setNames]=useState<string[]|null>(), [expanded,setExpanded]=useState<boolean>(), [wide,setWide]=useState(false);
    const [docs,setDocs]=useState<Doc[]>([]), live=useRef<Doc[]>([]), [active,setActive]=useState<string|null>(null);
    const [busy,setBusy]=useState(false),lock=useRef(false),[error,setError]=useState('');
    const [menu,setMenu]=useState<string|null>(null),[action,setAction]=useState<Action|null>(null),[filename,setFilename]=useState('');
    const host=useRef<HTMLElement>(null), dialog=useRef<HTMLDialogElement>(null), refreshId=useRef(0);
    const dragged=useRef<{name:string;x:number;y:number;id:number;moving:boolean}|null>(null), swallowClick=useRef(false);
    const dropTarget=useRef<HTMLElement|null>(null), tabstrip=useRef<HTMLDivElement>(null);
    const [stage,setStage]=useState<HTMLElement|null>(null);
    const doc=docs.find(d=>d.name===active),tree=useMemo(()=>fileTree(names??[]),[names]);
    const open=expanded??(wide&&Boolean(names?.length)),entry=path.split(/[\\/]/).pop()||path;
    useLayoutEffect(()=>{
        tabstrip.current?.querySelector('[aria-current="page"]')?.scrollIntoView({block:'nearest',inline:'nearest'});
        if(!stage||!active)return;
        const covered=Array.from(stage.children).filter((el):el is HTMLElement=>el instanceof HTMLElement&&!el.classList.contains('ck-file-workbench')&&!el.inert);
        for(const el of covered)el.inert=true;
        return ()=>{for(const el of covered)el.inert=el.hidden||el.getAttribute('aria-hidden')==='true';};
    },[active,stage]);
    function update(fn:(current:Doc[])=>Doc[]){live.current=fn(live.current);setDocs(live.current);}
    useEffect(()=>{
        const surface=host.current?.parentElement;if(!surface)return;
        setStage(surface.querySelector<HTMLElement>('.ck-workspace-stage'));
        const observer=new ResizeObserver(([box])=>setWide(box.contentRect.width>=820));
        observer.observe(surface);return ()=>observer.disconnect();
    },[]);
    useEffect(()=>{
        if(!menu)return;
        const outside=(e:PointerEvent)=>{if(!(e.target as Element)?.closest('.ck-tree-item'))setMenu(null);};
        const escape=(e:KeyboardEvent)=>{if(e.key==='Escape')setMenu(null);};
        document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
        return ()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
    },[menu]);
    useEffect(()=>{if(action&&!dialog.current?.open)dialog.current?.showModal();else if(!action)dialog.current?.close();},[action]);
    async function refresh(){
        const id=++refreshId.current;
        try{const list=await invoke<string[]|null>('list_project_sources',{path});
            if(id===refreshId.current)setNames(list);
        }catch(e){if(id===refreshId.current)setError(String(e));}
    }
    useEffect(()=>{void refresh();return ()=>{++refreshId.current;};},[path]);
    async function run(fn:()=>Promise<void>){
        if(lock.current)return false;
        lock.current=true;setBusy(true);setError('');
        try{await fn();return true;}catch(e){setError(String(e));return false;}finally{lock.current=false;setBusy(false);}
    }
    async function persist(d:Doc){
        const revision=await invoke<string>('write_project_source',{path,name:d.name,code:d.code,revision:d.revision});
        update(all=>all.map(old=>old.name===d.name?{...old,original:d.code,revision}:old));
    }
    const saveAll=async()=>{
        if(lock.current||action)return false;
        const changed=live.current.filter(dirty);
        if(!changed.length)return true;
        if(disabled)return false;
        return run(async()=>{for(const d of changed){setActive(d.name);await persist(d);}});
    };
    useImperativeHandle(handle,()=>({
        draft:name=>{const d=live.current.find(item=>item.name===name&&dirty(item));return d?{code:d.code,dirty:true}:undefined;},
        pending:()=>live.current.some(dirty)||lock.current||!!action,saveAll,refresh,showMain:()=>{setActive(null);setMenu(null);}
    }));
    function select(name:string){
        setMenu(null);setError('');
        if(live.current.some(d=>d.name===name)){setActive(name);if(!wide)setExpanded(false);return;}
        void run(async()=>{
            const d=await invoke<{code:string;revision:string}>('read_project_source',{path,name});
            update(all=>[...all,{name,...d,original:d.code}]);setActive(name);if(!wide)setExpanded(false);
        });
    }
    function forget(name:string){
        update(all=>all.filter(d=>d.name!==name));
        if(active===name)setActive(live.current[live.current.length-1]?.name??null);
    }
    function closeFile(d:Doc){
        if(dirty(d)){setError('文件尚未保存。');setAction({kind:'discard',name:d.name});}else forget(d.name);
    }
    function begin(kind:'rename'|'delete',name:string,destination=name){
        setMenu(null);if(disabled)return;
        void run(async()=>{
            const d=live.current.find(d=>d.name===name);
            if(d&&dirty(d)){setActive(name);throw Error('文件尚未保存。请先保存，再执行此操作。');}
            const revision=d?.revision??(await invoke<{revision:string}>('read_project_source',{path,name})).revision;
            setFilename(destination);setAction({kind,name,revision});
        });
    }
    const cancel=()=>{if(!lock.current){setAction(null);setError('');}};
    function submit(){
        if(!action||disabled)return;
        void run(async()=>{
            const {kind,name,revision}=action,dest=filename.trim();
            if(kind==='discard')forget(name);
            else if(kind==='create'){
                const rev=await invoke<string>('write_project_source',{path,name:dest,code:'',revision:null});
                update(all=>[...all,{name:dest,code:'',original:'',revision:rev}]);setActive(dest);
            }else{
                await invoke('change_project_source',{path,name,revision,newName:kind==='delete'?null:dest});
                if(kind==='delete')forget(name);
                else {update(all=>all.map(d=>d.name===name?{...d,name:dest}:d));if(active===name)setActive(dest);}
            }
            setAction(null);if(kind!=='discard')await refresh();
        });
    }
    const title=action?.kind==='create'?'新建源码文件':action?.kind==='rename'?'重命名或移动':action?.kind==='delete'?'删除文件':'放弃未保存的修改';
    function targetAt(e:ReactPointerEvent){
        const el=document.elementFromPoint(e.clientX,e.clientY)?.closest<HTMLElement>('[data-drop-dir]');
        return el&&host.current?.contains(el)?el:null;
    }
    function clearDrag(){
        if(dropTarget.current)delete dropTarget.current.dataset.dropOver;
        dropTarget.current=null;dragged.current=null;
    }
    return <aside ref={host} className="ck-project-dock" data-expanded={open} aria-label="工程文件"
        onPointerMove={e=>{
            const d=dragged.current;if(!d||d.id!==e.pointerId)return;
            if(!d.moving&&Math.hypot(d.x-e.clientX,d.y-e.clientY)<6)return;
            d.moving=true;const target=targetAt(e);
            if(dropTarget.current&&dropTarget.current!==target)delete dropTarget.current.dataset.dropOver;
            dropTarget.current=target;if(target)target.dataset.dropOver='true';
        }} onPointerUp={e=>{
            const d=dragged.current;if(!d||d.id!==e.pointerId)return;
            const dir=targetAt(e)?.dataset.dropDir;clearDrag();
            if(d.moving){swallowClick.current=true;if(!disabled&&!busy&&dir!==undefined&&dir+basename(d.name)!==d.name)begin('rename',d.name,dir+basename(d.name));}
        }} onPointerCancel={clearDrag} onLostPointerCapture={clearDrag}
        onClickCapture={e=>{if(swallowClick.current){swallowClick.current=false;e.preventDefault();e.stopPropagation();}}}>
        {!open?<button type="button" className="ck-files-rail" onClick={()=>{setExpanded(true);void refresh();}} title="展开工程文件" aria-expanded={false}>
            <PanelRightOpen size={16}/><span>工程文件</span>{!!names?.length&&<small>{names.length}</small>}</button>:<>
            <header><FolderOpen size={15}/><strong>工程文件</strong><small>{names?.length??''}</small>
                <button type="button" title="收起工程文件" aria-label="收起工程文件" onClick={()=>setExpanded(false)}><PanelRightClose size={15}/></button></header>
            <div className="ck-files-project" data-drop-dir=""><button type="button" className="ck-tree-main" title={`返回 ${entry}`} onClick={()=>{setActive(null);setMenu(null);}}><Code2 size={14}/><strong>{entry}</strong></button>
                {Array.isArray(names)&&<button title="新建源码文件" aria-label="新建源码文件" disabled={disabled||busy} onClick={()=>{setFilename('');setMenu(null);setError('');setAction({kind:'create',name:''});}}><FilePlus2 size={15}/></button>}
                <button title="刷新文件列表" aria-label="刷新文件列表" disabled={busy} onClick={()=>{setError('');void refresh();}}><RefreshCw size={13}/></button></div>
            <nav aria-label="工程源码文件"><Entries tree={tree} prefix="" active={active} docs={docs} busy={busy} disabled={disabled} menu={menu} select={select} setMenu={setMenu} action={begin}
                start={(e,name)=>{swallowClick.current=false;if(e.button!==0||e.pointerType!=='mouse')return;
                    dragged.current={name,x:e.clientX,y:e.clientY,id:e.pointerId,moving:false};e.currentTarget.setPointerCapture(e.pointerId);}}/>
                {names===null?<p>将 <b>{entry}</b> 放入同名文件夹后，可添加源码。</p>:names?.length===0?<p>暂无附带源码</p>:null}
                {!action&&error&&!doc&&<p role="alert">{error}</p>}</nav>
            <button type="button" className="ck-files-location" title={path} onClick={()=>void run(()=>invoke('show_in_folder',{path}))}><FolderSearch size={15}/>打开所在文件夹</button>
        </>}
        {stage&&doc&&createPortal(<section className="ck-file-workbench" aria-label="工程源码编辑器">
            <div className="ck-member-tabbar"><div ref={tabstrip} className="ck-member-tabs" aria-label="已打开的文件">
                <button type="button" className="ck-main-tab" onClick={()=>setActive(null)} title={`返回 ${entry}`}><Code2 size={14}/>{entry}</button>
                {docs.map(d=><div key={d.name} data-current={active===d.name} className="ck-member-tab">
                    <button type="button" title={d.name} aria-current={active===d.name?'page':undefined} onClick={()=>select(d.name)}><FileCode2 size={13}/>{basename(d.name)}{dirty(d)&&<i className="ck-source-dirty" aria-label="未保存"/>}</button>
                    <button disabled={busy} title={`关闭 ${d.name}`} aria-label={active===d.name?'关闭文件编辑器':`关闭 ${d.name}`} onClick={()=>closeFile(d)}><X size={12}/></button></div>)}
            </div><button className="ck-member-primary" type="button" title="保存当前文件" aria-label="保存当前文件" disabled={!dirty(doc)||disabled||busy} onClick={()=>void run(()=>persist(doc))}><Save size={15}/></button></div>
            <div className="ck-member-path" title={path}>{entry} <ChevronRight size={12}/>{doc.name}</div>
            {!action&&error&&<p role="alert">{error}</p>}
            <div className="ck-member-content"><Suspense fallback={null}><Editor key={doc.name} documentKey={path+':'+doc.name} code={doc.code} dark={dark} readOnly={disabled||busy}
                diagnostics={diagnostics} reveal={null} onChange={code=>update(all=>all.map(d=>d.name===doc.name?{...d,code}:d))}
                onSave={()=>{if(!disabled&&dirty(doc))void run(()=>persist(doc));}} onBuild={onBuild} onCursor={()=>{}} onRejectedEdit={setError}/></Suspense></div>
        </section>,stage)}
        <dialog ref={dialog} className="ck-member-window" data-create="true" aria-label={title} onCancel={e=>{e.preventDefault();cancel();}} onKeyDown={e=>e.stopPropagation()}>
            {action&&<><header><strong>{title}</strong><button aria-label="取消" onClick={cancel}><X size={16}/></button></header>
                <form onSubmit={e=>{e.preventDefault();submit();}}>
                    {action.kind==='create'||action.kind==='rename'?<label>工程内相对路径<input autoFocus required aria-label="文件路径" placeholder="src/Motor.cpp" value={filename} onChange={e=>setFilename(e.target.value)}/></label>
                    :<p>{action.kind==='delete'?'从磁盘删除':'放弃修改并关闭'}「{action.name}」？</p>}
                    {error&&<p role="alert">{error}</p>}
                    <div className="ck-action-buttons"><button type="button" disabled={busy} onClick={cancel}>取消</button><button className="ck-member-primary"
                        disabled={busy||disabled||((action.kind==='create'||action.kind==='rename')&&!filename.trim())}>{action.kind==='create'?'创建文件':action.kind==='rename'?'确定':action.kind==='delete'?'确认删除':'放弃修改'}</button></div>
                </form></>}
        </dialog>
    </aside>;
}
