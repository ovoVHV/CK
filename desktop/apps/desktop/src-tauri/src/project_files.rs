use std::{collections::BTreeMap, fs, io::Read, path::{Path, PathBuf}};
use sha2::{Digest,Sha256};
use serde::Serialize;

const LIMIT: usize = 1024 * 1024;
static WRITES:std::sync::Mutex<()>=std::sync::Mutex::new(());
fn plain(path: &Path) -> Result<fs::Metadata,String> {
    let m = fs::symlink_metadata(path).map_err(|e| format!("{}: {e}",path.display()))?;
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if m.file_attributes() & 0x400 != 0 {return Err(format!("工程文件不能是链接：{}",path.display()));}
    }
    if m.file_type().is_symlink(){return Err("工程文件不能是链接".into());}
    Ok(m)
}
pub(super) fn folder(path: &Path) -> Result<Option<&Path>,String> {
    if path.extension().and_then(|v|v.to_str()).is_none_or(|v|!v.eq_ignore_ascii_case("ck")) {return Ok(None);}
    let Some(root)=path.parent() else{return Ok(None)};
    if root.file_name()!=path.file_stem(){return Ok(None);}
    for part in path.ancestors().filter(|p|!p.as_os_str().is_empty()){plain(part)?;}
    if !path.is_file() {return Err("工程入口不存在".into());}
    for item in fs::read_dir(root).map_err(|e|e.to_string())? {
        let file=item.map_err(|e|e.to_string())?.path();
        if file!=path && file.extension().and_then(|v|v.to_str()).is_some_and(|v|v.eq_ignore_ascii_case("ck")||v.eq_ignore_ascii_case("maker")) {return Err("一个工程目录只能有一个 CK 工程入口".into());}
    }
    Ok(Some(root))
}
fn allowed(name:&str)->bool {
    let ext=name.rsplit_once('.').map(|(_,e)|e).unwrap_or("");
    ["h","hpp","hh","hxx","inc","ipp","tpp"].contains(&ext.to_ascii_lowercase().as_str())||["cpp","cc","cxx","c","S"].contains(&ext)
}
fn valid(name:&str)->Result<(),String>{
    let safe_part = |part: &str| {
        let stem=part.split('.').next().unwrap_or(part).to_ascii_uppercase();
        !part.is_empty() && part.len()<=128 && part!="." && part!=".." &&
            !part.ends_with(['.',' ']) && !part.chars().any(|c| c.is_control()||matches!(c,'<'|'>'|':'|'"'|'\\'|'|'|'?'|'*')) &&
            !matches!(stem.as_str(),"CON"|"PRN"|"AUX"|"NUL") &&
            !(stem.len()==4 && (stem.starts_with("COM")||stem.starts_with("LPT")) && matches!(stem.as_bytes()[3],b'1'..=b'9'))
    };
    if !allowed(name)||name.len()>240||name.eq_ignore_ascii_case("sketch.ino.cpp")||
        (name.contains('/')&&!name.starts_with("src/"))||name.split('/').any(|p|p.starts_with('.')||!safe_part(p)){
        return Err(format!("无效的工程源码文件名：{name}"));
    } Ok(())
}
fn bytes(p:&Path)->Result<Vec<u8>,String>{
    if !plain(p)?.is_file(){return Err("需要普通文件".into());}
    let mut b=Vec::new();fs::File::open(p).map_err(|e|e.to_string())?.take((LIMIT+1) as u64).read_to_end(&mut b).map_err(|e|e.to_string())?;
    if b.len()>LIMIT{return Err(format!("文件超过 1 MiB：{}",p.display()));}Ok(b)
}
pub(super) fn snapshot(path:Option<&str>)->Result<Option<BTreeMap<String,Vec<u8>>>,String>{
    let _guard=WRITES.lock().map_err(|_|"源码读取不可用")?;
    snapshot_locked(path)
}
fn snapshot_locked(path:Option<&str>)->Result<Option<BTreeMap<String,Vec<u8>>>,String>{
    let Some(path)=path else{return Ok(None)};
    let Some(root)=folder(Path::new(path))? else{return Ok(None)};
    let mut out=BTreeMap::new();let mut total=0;
    fn visit(root:&Path,dir:&Path,out:&mut BTreeMap<String,Vec<u8>>,total:&mut usize)->Result<(),String>{
        for entry in fs::read_dir(dir).map_err(|e|e.to_string())? {
            let p=entry.map_err(|e|e.to_string())?.path();
            let name=p.strip_prefix(root).unwrap().to_str().ok_or("文件名无法读取")?.replace('\\',"/");
            if name.split('/').any(|v|v.starts_with('.')){continue;}
            if name=="src"||dir!=root {
                if plain(&p)?.is_dir(){if name.len()>240{return Err("源码目录过深".into());}visit(root,&p,out,total)?;continue;}
            }
            if !allowed(&name){
                if p.extension().and_then(|e|e.to_str()).is_some_and(|e|["ino","pde","cpp","cc","cxx","c","s"].contains(&e.to_ascii_lowercase().as_str())) {return Err(format!("请将主程序保存在 .ck 中，附带源码使用 .cpp、.c 或 .S：{name}"));}
                continue;
            }
            valid(&name)?;let b=bytes(&p)?;*total+=b.len();
            if *total>4*LIMIT||out.len()>=256{return Err("工程附带源码限 256 个文件、合计 4 MiB".into());}
            out.insert(name,b);
        }Ok(())
    }
    visit(root,root,&mut out,&mut total)?;Ok(Some(out))
}
#[tauri::command]
pub(crate) fn list_project_sources(path:String)->Result<Option<Vec<String>>,String>{
    Ok(snapshot(Some(&path))?.map(|s|s.into_keys().collect()))
}
pub(super) fn source_identity(files: Option<&BTreeMap<String,Vec<u8>>>) -> String {
    let mut hash = Sha256::new();
    for (name, bytes) in files.into_iter().flatten() {
        hash.update((name.len() as u64).to_be_bytes()); hash.update(name.as_bytes());
        hash.update((bytes.len() as u64).to_be_bytes()); hash.update(bytes);
    }
    hex::encode(hash.finalize())
}
#[tauri::command]
pub(crate) fn project_source_identity(path:Option<String>)->Result<String,String>{
    Ok(source_identity(snapshot(path.as_deref())?.as_ref()))
}
fn member(path:&str,name:&str)->Result<PathBuf,String>{
    valid(name)?;let root=folder(Path::new(path))?.ok_or("需要独立文件夹工程")?;
    let mut p=root.to_owned();for part in name.split('/') {p.push(part);if fs::symlink_metadata(&p).is_ok(){plain(&p)?;}}
    Ok(p)
}
#[derive(Serialize)]
pub(crate) struct SourceFile {code:String,revision:String}
#[tauri::command]
pub(crate) fn read_project_source(path:String,name:String)->Result<SourceFile,String>{
    let b=bytes(&member(&path,&name)?)?;let revision=hex::encode(Sha256::digest(&b));
    Ok(SourceFile{code:String::from_utf8(b).map_err(|_|"此文件可参与编译，但编辑器只支持 UTF-8")?,revision})
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NewSource { path:String, code:String }

#[tauri::command]
pub(crate) fn create_ai_project_sources(path:String, files:Vec<NewSource>)->Result<(),String>{
    use std::{collections::HashSet, io::Write};
    let _guard=WRITES.lock().map_err(|_|"源码写入不可用")?;
    let existing=snapshot_locked(Some(&path))?.ok_or("请先另存为独立文件夹工程")?;
    if !(1..=8).contains(&files.len()) || existing.len()+files.len()>256 {return Err("一次可新建 1–8 个源码文件，工程总数限 256".into());}
    let mut seen=HashSet::new();
    let mut total:usize=existing.values().map(Vec::len).sum();
    let mut targets=Vec::new();
    for file in &files {
        if !file.path.starts_with("src/") || file.code.trim().is_empty() || file.code.contains('\0') || file.code.len()>64*1024 {
            return Err("只能在 src/ 中新建非空源码，每个文件最多 64 KiB".into());
        }
        let target=member(&path,&file.path)?;
        if !seen.insert(file.path.to_lowercase()) || target.try_exists().map_err(|e|e.to_string())? {
            return Err(format!("已有同名文件或路径重复：{}",file.path));
        }
        total+=file.code.len();targets.push(target);
    }
    if total>4*LIMIT {return Err("工程附带源码合计超过 4 MiB".into());}
    let mut dirs=Vec::new();let mut written=Vec::new();
    let result=(|| -> std::io::Result<()> {
        for (target,file) in targets.iter().zip(&files) {
            let missing:Vec<_>=target.parent().unwrap().ancestors().take_while(|p|!p.exists()).collect();
            for dir in missing.into_iter().rev(){fs::create_dir(dir)?;dirs.push(dir);}
            let mut f=fs::OpenOptions::new().create_new(true).write(true).open(target)?;
            written.push(target);f.write_all(file.code.as_bytes())?;f.flush()?;
        }
        Ok(())
    })();
    if let Err(e)=result{
        let mut leftovers=Vec::new();
        for p in written.into_iter().rev(){if fs::remove_file(p).is_err(){leftovers.push(p.display().to_string());}}
        for d in dirs.into_iter().rev(){let _=fs::remove_dir(d);}
        if !leftovers.is_empty(){return Err(format!("创建失败：{e}；请检查未能撤回的文件：{}",leftovers.join("、")));}
        return Err(format!("未创建本批源码：{e}"));
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn write_project_source(path:String,name:String,code:String,revision:Option<String>)->Result<String,String>{
    let _guard=WRITES.lock().map_err(|_|"源码写入不可用")?;
    let p=member(&path,&name)?;if code.len()>LIMIT||code.contains('\0'){return Err("无效源码或超过 1 MiB".into());}
    if let Some(expected)=revision{
        if hex::encode(Sha256::digest(bytes(&p)?))!=expected{return Err("文件已被外部修改，请重新打开核对".into());}
        super::project::atomic_write_project_file(&p,code.as_bytes())?;
    }else{
        use std::io::Write;
        fs::create_dir_all(p.parent().unwrap()).map_err(|e|e.to_string())?;
        fs::OpenOptions::new().write(true).create_new(true).open(p).and_then(|mut f|f.write_all(code.as_bytes())).map_err(|e|e.to_string())?;
    }
    Ok(hex::encode(Sha256::digest(code.as_bytes())))
}

#[cfg(windows)]
fn rename_new(from:&Path,to:&Path)->std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name="kernel32")]
    extern "system" { fn MoveFileExW(from:*const u16,to:*const u16,flags:u32)->i32; }
    let wide=|p:&Path|p.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
    // Without MOVEFILE_REPLACE_EXISTING a racing destination cannot be overwritten.
    if unsafe{MoveFileExW(wide(from).as_ptr(),wide(to).as_ptr(),0)}==0 {Err(std::io::Error::last_os_error())}else{Ok(())}
}
#[cfg(not(windows))]
fn rename_new(from:&Path,to:&Path)->std::io::Result<()> {
    fs::hard_link(from,to)?;
    fs::remove_file(from)
}
#[tauri::command]
pub(crate) fn change_project_source(path:String,name:String,revision:String,new_name:Option<String>)->Result<(),String>{
    let _guard=WRITES.lock().map_err(|_|"源码写入不可用")?;
    let from=member(&path,&name)?;
    if hex::encode(Sha256::digest(bytes(&from)?))!=revision{return Err("文件已被外部修改，请重新打开核对".into());}
    match new_name {
        Some(dest)=>{
            let to=member(&path,&dest)?;
            if name==dest{return Ok(());}
            fs::create_dir_all(to.parent().unwrap()).map_err(|e|e.to_string())?;
            rename_new(&from,&to).map_err(|e|format!("无法移动到 {dest}：{e}"))
        }
        None=>fs::remove_file(from).map_err(|e|format!("无法删除文件：{e}")),
    }
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn candidate_members_include_relative_names_and_exact_bytes(){
        let mut files=BTreeMap::from([("src/传感器.h".to_owned(),vec![1,2])]);
        let baseline=source_identity(Some(&files));
        files.insert("src/传感器.h".to_owned(),vec![1,3]);
        assert_ne!(baseline,source_identity(Some(&files)));
        files.clear();files.insert("src/旧名.h".to_owned(),vec![1,2]);
        assert_ne!(baseline,source_identity(Some(&files)));
        assert_eq!(source_identity(None),source_identity(Some(&BTreeMap::new())));
    }
    #[test]
    fn folder_lifecycle(){
        let t=tempfile::tempdir().unwrap();
        let root=t.path().join("小车");
        fs::create_dir(&root).unwrap();
        let path=root.join("小车.ck");fs::write(&path,r#"{"name":"小车","board":"arduino:avr:nano","xml":"","code":""}"#).unwrap();
        let key=path.to_str().unwrap().to_string();
        let name="src/传感器.h".to_string();
        let rev=write_project_source(key.clone(),name.clone(),"#define PIN 5".into(),None).unwrap();
        assert_eq!(read_project_source(key.clone(),name.clone()).unwrap().revision,rev);
        fs::write(root.join(&name),"external").unwrap();
        assert!(write_project_source(key.clone(),name.clone(),"stale".into(),Some(rev)).is_err());
        assert!(write_project_source(key.clone(),"src/../../escape.h".into(),"".into(),None).is_err());
        let unrelated=t.path().join("other.ck");fs::write(&unrelated,"{}").unwrap();
        assert!(snapshot(unrelated.to_str()).unwrap().is_none());
        let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let copy=runtime.block_on(crate::project::save_project_as(t.path().join("副本.ck").display().to_string(),"{}".into(),"".into(),"uno".into(),None,None,None,Some(key.clone()),None)).unwrap();
        assert_eq!(snapshot(Some(&copy.path)).unwrap().unwrap()[&name],b"external");
        let moved=runtime.block_on(crate::project::rename_project(copy.path,"新车".into())).unwrap();
        assert_eq!(snapshot(Some(&moved)).unwrap().unwrap()[&name],b"external");
        fs::write(root.join("other.ck"),"{}").unwrap();assert!(snapshot(Some(&key)).is_err());
    }
}
