use std::{fs::{self,File,OpenOptions},io::Read,path::{Path,PathBuf},os::windows::{fs::{MetadataExt,OpenOptionsExt},io::AsRawHandle},sync::{Arc,Mutex,atomic::{AtomicUsize,Ordering}},time::Instant};
use sha2::{Digest,Sha256};use serde_json::{Value,json};
use windows_sys::Win32::{Storage::FileSystem::*,Security::Cryptography::*};
fn hex(b:&[u8])->String {b.iter().map(|v|format!("{v:02x}")).collect()}
fn status(v:i32){assert!(v>=0,"CNG NTSTATUS {v:x}");}
struct Cng{alg:BCRYPT_ALG_HANDLE,hash:BCRYPT_HASH_HANDLE,_object:Vec<u8>}
impl Cng{fn new()->Self{unsafe{let mut alg=std::ptr::null_mut();let name:Vec<u16>="SHA256\0".encode_utf16().collect();status(BCryptOpenAlgorithmProvider(&mut alg,name.as_ptr(),std::ptr::null(),BCRYPT_HASH_REUSABLE_FLAG));let mut size=0u32;let mut out=0;let prop:Vec<u16>="ObjectLength\0".encode_utf16().collect();status(BCryptGetProperty(alg,prop.as_ptr(),&mut size as *mut _ as *mut u8,4,&mut out,0));let mut object=vec![0u8;size as usize];let mut hash=std::ptr::null_mut();status(BCryptCreateHash(alg,&mut hash,object.as_mut_ptr(),size,std::ptr::null(),0,BCRYPT_HASH_REUSABLE_FLAG));Self{alg,hash,_object:object}}}fn update(&self,b:&[u8]){unsafe{status(BCryptHashData(self.hash,b.as_ptr(),b.len() as u32,0));}}fn finish(&self)->Vec<u8>{let mut b=vec![0u8;32];unsafe{status(BCryptFinishHash(self.hash,b.as_mut_ptr(),32,0));}b}}
impl Drop for Cng{fn drop(&mut self){unsafe{BCryptDestroyHash(self.hash);BCryptCloseAlgorithmProvider(self.alg,0);}}}
#[derive(PartialEq,Eq,Debug)]struct Identity{size:i64,write:i64,change:i64,volume:u64,id:[u8;16],attrs:u32}
fn identity(f:&File)->Identity{unsafe{let h=f.as_raw_handle();let mut b:FILE_BASIC_INFO=std::mem::zeroed();let mut s:FILE_STANDARD_INFO=std::mem::zeroed();let mut i:FILE_ID_INFO=std::mem::zeroed();assert_ne!(GetFileInformationByHandleEx(h,FileBasicInfo,&mut b as *mut _ as *mut _,std::mem::size_of_val(&b) as u32),0);assert_ne!(GetFileInformationByHandleEx(h,FileStandardInfo,&mut s as *mut _ as *mut _,std::mem::size_of_val(&s) as u32),0);assert_ne!(GetFileInformationByHandleEx(h,FileIdInfo,&mut i as *mut _ as *mut _,std::mem::size_of_val(&i) as u32),0);assert_eq!(b.FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT,0,"Reparse handle");Identity{size:s.EndOfFile,write:b.LastWriteTime,change:b.ChangeTime,volume:i.VolumeSerialNumber,id:i.FileId.Identifier,attrs:b.FileAttributes}}}

// On Windows DirEntry metadata comes from directory enumeration. File content,
// reparse-handle checks, and before/after handle identity are still verified
// by each reader. Directories retain a fresh non-following metadata query.
fn walk(p:&Path,rows:&mut Vec<Value>,files:&mut Vec<(usize,PathBuf,u64)>){visit(p,fs::symlink_metadata(p).unwrap(),rows,files);}
fn visit(p:&Path,m:fs::Metadata,rows:&mut Vec<Value>,files:&mut Vec<(usize,PathBuf,u64)>){assert_eq!(m.file_attributes()&FILE_ATTRIBUTE_REPARSE_POINT,0,"Reparse input {}",p.display());if m.is_dir(){rows.push(json!([p,"directory"]));let mut entries:Vec<_>=fs::read_dir(p).unwrap().map(|x|x.unwrap()).collect();entries.sort_by_key(|x|x.file_name().to_string_lossy().encode_utf16().collect::<Vec<_>>());for e in entries{let m=e.metadata().unwrap();if m.is_dir(){walk(&e.path(),rows,files);}else{visit(&e.path(),m,rows,files);}}}else{assert!(m.is_file());let i=rows.len();rows.push(json!([p,"file",m.len(),null]));files.push((i,p.to_path_buf(),m.len()));}}

fn main(){let args:Vec<_>=std::env::args().collect();let config:Value=serde_json::from_slice(&fs::read(&args[1]).unwrap()).unwrap();let mode=config["mode"].as_str().unwrap_or("rust").to_owned();let workers=config["workers"].as_u64().unwrap_or(1) as usize;assert!((1..=8).contains(&workers));let buffer=config["bufferBytes"].as_u64().unwrap_or(1048576) as usize;let start=Instant::now();let roots:Vec<PathBuf>=config["roots"].as_array().unwrap().iter().map(|v|PathBuf::from(v.as_str().unwrap())).collect();let mut rows=Vec::new();let mut files=Vec::new();for p in &roots{for a in p.ancestors(){assert_eq!(fs::symlink_metadata(a).unwrap().file_attributes()&FILE_ATTRIBUTE_REPARSE_POINT,0,"Reparse ancestor");}walk(p,&mut rows,&mut files);}let enumeration=start.elapsed().as_secs_f64()*1000.0;
 if config["sizeGrouped"].as_bool().unwrap_or(false){files.sort_by_key(|x|std::cmp::Reverse(x.2));}

 let open_workers=config["openWorkers"].as_u64().unwrap_or(0) as usize;assert!(open_workers<=16);
 let total_bytes:u64=files.iter().map(|x|x.2).sum();let count=files.len();let files=Arc::new(files);let cursor=Arc::new(AtomicUsize::new(0));
 // Only handle acquisition is decoupled. Content reading and SHA-256 remain
 // bounded by workers; no data/identity is reused from a previous request.
 let (sender,receiver)=std::sync::mpsc::sync_channel::<Opened>(workers*2);
 let receiver=Arc::new(Mutex::new(receiver));let mut openers=Vec::new();
 for _ in 0..open_workers{let files=files.clone();let cursor=cursor.clone();let sender=sender.clone();openers.push(std::thread::spawn(move||{
  loop{let n=cursor.fetch_add(1,Ordering::Relaxed);if n>=files.len(){break;}let (row,p,_)=&files[n];
   let opened=open_file(*row,p);if sender.send(opened).is_err(){break;}
  }
 }));}drop(sender);
 let mut joins=Vec::new();for _ in 0..workers{let files=files.clone();let cursor=cursor.clone();let receiver=receiver.clone();let mode=mode.clone();joins.push(std::thread::spawn(move||{
  let mut buf=vec![0u8;buffer];let cng=if mode=="cng"{Some(Cng::new())}else{None};let mut measures=[0f64;5];let mut slow_opens:Vec<(f64,String)>=Vec::new();let mut results=Vec::new();
  loop{
   let opened=if open_workers>0{let next=receiver.lock().unwrap().recv();match next{Ok(v)=>v,Err(_)=>break}}
    else{let n=cursor.fetch_add(1,Ordering::Relaxed);if n>=files.len(){break;}let (row,p,_)=&files[n];open_file(*row,p)};
   let Opened{row,path:p,mut file,before,open_ms,identity_ms}=opened;
   measures[0]+=open_ms;measures[1]+=identity_ms;
   if open_ms>=10.0{slow_opens.push((open_ms,p.to_string_lossy().into_owned()));slow_opens.sort_by(|a,b|b.0.total_cmp(&a.0));slow_opens.truncate(10);}
   let mut hash=Sha256::new();let mut size=0;loop{let t=Instant::now();let n=file.read(&mut buf).unwrap();measures[2]+=t.elapsed().as_secs_f64()*1000.0;if n==0{break;}size+=n as i64;let t=Instant::now();if let Some(ref c)=cng{c.update(&buf[..n]);}else{hash.update(&buf[..n]);}measures[3]+=t.elapsed().as_secs_f64()*1000.0;}
   let digest=if let Some(ref c)=cng{c.finish()}else{hash.finalize().to_vec()};let t=Instant::now();assert_eq!(before,identity(&file),"Input changed while queued or reading {}",p.display());assert_eq!(size,before.size);measures[1]+=t.elapsed().as_secs_f64()*1000.0;
   let t=Instant::now();drop(file);measures[4]+=t.elapsed().as_secs_f64()*1000.0;results.push((row,size,hex(&digest)));
  }(measures,slow_opens,results)
 }));}drop(receiver);
 // Reader panic drops its receiver reference; if all readers fail, blocked
 // senders wake with an error. Never publish a partial proof on any failure.
 let mut metrics=[0f64;5];let mut slow_opens=Vec::new();let mut completed=0;let mut failed=false;
 for j in joins{match j.join(){Ok((v,slow,results))=>{for i in 0..5{metrics[i]+=v[i];}slow_opens.extend(slow);for (i,size,digest) in results{rows[i][2]=json!(size);rows[i][3]=json!(digest);completed+=1;}},Err(_)=>failed=true}}
 for j in openers{if j.join().is_err(){failed=true;}}
 assert!(!failed,"Asset worker failed");assert_eq!(completed,count,"Incomplete asset proof");
 slow_opens.sort_by(|a,b|b.0.total_cmp(&a.0));slow_opens.truncate(10);let elapsed=start.elapsed().as_secs_f64()*1000.0;
 let result=json!({"roots":roots,"rows":rows,"files":count,"bytes":total_bytes,"elapsedMs":elapsed,"mode":mode,"workers":workers,"openWorkers":open_workers,"maxOpenHandles":if open_workers>0{open_workers+workers*3}else{workers},"bufferBytes":buffer,"shaCpuFeature":std::is_x86_feature_detected!("sha"),"metrics":{"enumerationMs":enumeration,"openSumMs":metrics[0],"metadataSumMs":metrics[1],"readSumMs":metrics[2],"hashSumMs":metrics[3],"closeSumMs":metrics[4],"slowOpenSamples":slow_opens.into_iter().map(|(ms,file)|json!({"file":file,"openMs":ms})).collect::<Vec<_>>()},"coldCacheProven":false});
 let output=args.get(2).expect("output JSON path");fs::write(output,serde_json::to_vec(&result).unwrap()).unwrap();
}
struct Opened{row:usize,path:PathBuf,file:File,before:Identity,open_ms:f64,identity_ms:f64}
fn open_file(row:usize,p:&Path)->Opened{
 let t=Instant::now();let file=OpenOptions::new().read(true).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_SEQUENTIAL_SCAN).open(p).unwrap();let open_ms=t.elapsed().as_secs_f64()*1000.0;
 let t=Instant::now();let before=identity(&file);let identity_ms=t.elapsed().as_secs_f64()*1000.0;
 Opened{row,path:p.to_path_buf(),file,before,open_ms,identity_ms}
}
