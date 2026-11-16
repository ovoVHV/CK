//! Complete, unmodified Arduino libraries inside a CK block package.
//! `libraries/<upstream folder>/` is a collection of library ROOTS, never a
//! recursive source include path and never an instruction to download code.
use std::{collections::BTreeSet, fs, path::{Path, PathBuf}};

fn regular_dir(path: &Path) -> Result<bool, String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("无法读取内置 Arduino 库 {}: {e}", path.display())),
    };
    #[cfg(windows)]
    { use std::os::windows::fs::MetadataExt; if meta.file_attributes() & 0x400 != 0 { return Err("内置 Arduino 库不允许链接或目录联接".into()); } }
    if meta.file_type().is_symlink() { return Err("内置 Arduino 库不允许符号链接".into()); }
    Ok(meta.is_dir())
}

pub fn is_block_package(root: &Path) -> bool {
    root.join("library.json").is_file() && root.join("ck-blocks.json").is_file()
}

pub fn roots(package: &Path) -> Result<Vec<PathBuf>, String> {
    if !is_block_package(package) { return Ok(Vec::new()); }
    let container = package.join("libraries");
    if !regular_dir(&container)? {
        if container.exists() { return Err("libraries 必须是文件夹，内部放完整 Arduino 库目录".into()); }
        return Ok(Vec::new());
    }
    let mut entries = fs::read_dir(&container).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|e|e.to_string())?;
    if entries.len() > 64 { return Err("一个图形化库包最多包含 64 个 Arduino 库目录".into()); }
    entries.sort_by_key(|e| e.file_name().to_string_lossy().to_ascii_lowercase());
    let mut result = Vec::new();
    let mut names = BTreeSet::new();
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') { continue; }
        let root = entry.path();
        if !regular_dir(&root)? {
            if root.extension().is_some_and(|e|e.eq_ignore_ascii_case("zip")) {
                return Err(format!("请将 {name} 解压成完整文件夹再放入 libraries，不需要拆分源文件"));
            }
            continue;
        }
        if !names.insert(name.to_ascii_lowercase()) { return Err(format!("内置 Arduino 库目录重名: {name}")); }
        // Modern Arduino roots carry their own properties. Legacy 1.0 roots
        // may instead expose headers directly; do not guess through extra ZIP
        // wrapper levels, examples or architecture implementation directories.
        let legacy_header = fs::read_dir(&root).map_err(|e|e.to_string())?
            .filter_map(Result::ok).any(|e| e.file_type().is_ok_and(|t|t.is_file())
                && e.path().extension().and_then(|s|s.to_str()).is_some_and(|s|matches!(s.to_ascii_lowercase().as_str(),"h"|"hpp"|"hh"|"hxx")));
        if !root.join("library.properties").is_file() && !legacy_header {
            return Err(format!("libraries/{name} 不是 Arduino 库根目录：应直接包含 library.properties，或旧格式的头文件；请去掉多余的外层目录"));
        }
        result.push(root);
    }
    Ok(result)
}

pub fn owner(root: &Path) -> Option<PathBuf> {
    if is_block_package(root) { return Some(root.to_path_buf()); }
    let container = root.parent()?;
    if !container.file_name()?.eq_ignore_ascii_case("libraries") { return None; }
    let package = container.parent()?;
    is_block_package(package).then(||package.to_path_buf())
}

#[cfg(test)] mod tests {
    use super::*;
    fn package(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ck-bundled-{tag}-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&p).unwrap();fs::write(p.join("library.json"),"{}").unwrap();fs::write(p.join("ck-blocks.json"),"{}").unwrap();p
    }
    fn native(p:&Path,name:&str) -> PathBuf { let r=p.join("libraries").join(name);fs::create_dir_all(r.join("src/avr")).unwrap();fs::write(r.join("library.properties"),"name=Servo\nversion=1.2.2\narchitectures=avr\n").unwrap();fs::write(r.join("src/avr/Servo.cpp"),"int original_source;\n").unwrap();r }
    #[test] fn complete_upstream_roots_are_preserved_and_siblings_available() { let p=package("full");let b=native(&p,"Servo-1.2.2");let a=native(&p,"Dependency");assert_eq!(roots(&p).unwrap(),vec![a,b.clone()]);assert_eq!(owner(&b),Some(p.clone()));assert_eq!(fs::read_to_string(b.join("src/avr/Servo.cpp")).unwrap(),"int original_source;\n");assert!(owner(&b.join("src")).is_none());fs::remove_dir_all(p).unwrap(); }
    #[test] fn legacy_root_and_header_only_library_are_supported() { let p=package("legacy");let r=p.join("libraries/Legacy");fs::create_dir_all(&r).unwrap();fs::write(r.join("Driver.h"),"#pragma once\n").unwrap();assert_eq!(roots(&p).unwrap(),vec![r]);fs::remove_dir_all(p).unwrap(); }
    #[test] fn extra_archive_level_is_rejected_without_rearranging_files() { let p=package("wrapper");let r=p.join("libraries/Outer/Servo");fs::create_dir_all(&r).unwrap();fs::write(r.join("library.properties"),"name=Servo").unwrap();assert!(roots(&p).unwrap_err().contains("多余"));assert!(r.exists());fs::remove_dir_all(p).unwrap(); }
    #[test] fn archive_is_not_silently_ignored() { let p=package("zip");fs::create_dir_all(p.join("libraries")).unwrap();fs::write(p.join("libraries/Servo.zip"),"zip").unwrap();assert!(roots(&p).unwrap_err().contains("解压"));fs::remove_dir_all(p).unwrap(); }
    #[test] fn plain_native_package_does_not_expose_random_subfolders() { let p=package("native");native(&p,"Nested");fs::remove_file(p.join("ck-blocks.json")).unwrap();assert!(roots(&p).unwrap().is_empty());fs::remove_dir_all(p).unwrap(); }
    #[test] fn directory_additions_and_removals_are_observed() { let p=package("refresh");assert!(roots(&p).unwrap().is_empty());let r=native(&p,"Servo");assert_eq!(roots(&p).unwrap(),vec![r.clone()]);fs::remove_dir_all(r).unwrap();assert!(roots(&p).unwrap().is_empty());fs::remove_dir_all(p).unwrap(); }
}
