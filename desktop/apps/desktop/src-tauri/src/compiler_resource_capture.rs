//! Optional post-build observation. Outputs live only in a disposable directory.
//! No resolver, linker, library installation, package execution or build mutation.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

#[derive(Clone)]
pub(crate) struct Ticket {
    pub build: PathBuf,
    pub sysroot: PathBuf,
    pub code_sha256: String,
    pub context: Value,
    database_sha256: String,
    registered_sources: BTreeMap<String, String>,
}

static TICKETS: OnceLock<Mutex<HashMap<String, Ticket>>> = OnceLock::new();
pub(crate) fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn bounded_read(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > limit {
        return Err("recognition.file.limit".into());
    }
    fs::read(path).map_err(|e| e.to_string())
}
pub(crate) fn register(run: &str, build: &Path, sysroot: &Path, code: &str, context: &Value) {
    // An unavailable compilation database is not permission to rebuild the project.
    let Ok(database) = bounded_read(&build.join("compile_commands.json"), 8_000_000) else { return };
    let Ok(commands) = serde_json::from_slice::<Vec<CompileCommand>>(&database) else { return };
    if commands.len() > 256 { return; }
    let mut registered_sources = BTreeMap::new();
    for command in &commands {
        if add_source(&mut registered_sources, &command.file).is_err() { return; }
        if let Some(i) = command.arguments.iter().position(|a| a == "-o") {
            if let Some(file) = command.arguments.get(i + 1) {
                let object = Path::new(file);
                if let Ok(deps) = dependencies(&object.with_extension("d")) {
                    for dep in deps { if add_source(&mut registered_sources, &dep).is_err() { return; } }
                }
            }
        }
    }
    let Ok(mut tickets) = TICKETS.get_or_init(Default::default).lock() else { return };
    if tickets.len() >= 8 { tickets.clear(); }
    tickets.insert(run.to_owned(), Ticket {
        build: build.to_owned(), sysroot: sysroot.to_owned(), context: context.clone(),
        code_sha256: digest(code.as_bytes()), database_sha256: digest(&database),
        registered_sources,
    });
}
pub(crate) fn take(run: &str) -> Result<Ticket, String> {
    TICKETS.get_or_init(Default::default).lock().map_err(|_| "recognition.lock")?
        .remove(run).ok_or_else(|| "recognition.snapshot.unavailable".into())
}

#[derive(Deserialize)]
struct CompileCommand { file: PathBuf, arguments: Vec<String>, directory: Option<PathBuf> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Unit {
    file: String, kind: String, library_root: Option<String>, library_version: Option<String>,
    gimple: String, gimple_sha256: String, preprocessed: String,
    preprocessed_sha256: String,
    command_sha256: String, dependencies: Vec<String>,
    defined_symbols: Vec<String>, referenced_symbols: Vec<String>,
}
struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        // Only the UUID directory created by this call is ever removed.
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn canonical(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path).map(|p| {
        let text = p.to_string_lossy();
        text.strip_prefix(r"\\?\").map(PathBuf::from).unwrap_or(p)
    }).map_err(|e| e.to_string())
}
fn string(path: &Path) -> String { path.to_string_lossy().into_owned() }

/// Strict allowlist: the database cannot introduce shell commands, response files,
/// compiler plugins, alternate programs or writes to the completed build.
fn replay_arguments(command: &CompileCommand, root: &Path, out: &Path) -> Result<(PathBuf, Vec<String>, PathBuf), String> {
    if command.arguments.len() < 4 || command.arguments.len() > 512 {
        return Err("recognition.command.invalid".into());
    }
    let mut compiler = PathBuf::from(&command.arguments[0]);
    if !compiler.exists() { compiler.set_extension("exe"); }
    let compiler = canonical(&compiler)?;
    let tools = canonical(&root.join("packages"))?;
    let executable = compiler.file_name().and_then(|v| v.to_str()).unwrap_or("");
    if !compiler.starts_with(tools) || !["avr-g++", "avr-g++.exe", "avr-gcc", "avr-gcc.exe"].contains(&executable) {
        return Err("recognition.compiler.unsupported".into());
    }
    let source = canonical(&command.file)?;
    let mut args = Vec::new();
    let mut object = None;
    let mut source_seen = false;
    let mut i = 1;
    while i < command.arguments.len() {
        let a = &command.arguments[i];
        if a == "-o" {
            if object.is_some() { return Err("recognition.output.ambiguous".into()); }
            i += 1;
            object = command.arguments.get(i).map(PathBuf::from);
            args.extend(["-o".into(), string(&out.join("observation.o"))]);
        } else if a == "-w" {
            // Only the observer enables diagnostics: -w would suppress the
            // time-macro safety error even after -Werror=date-time.
        } else if a == "-I" || a == "-isystem" {
            i += 1;
            let value = command.arguments.get(i).ok_or("recognition.include.invalid")?;
            args.extend([a.clone(), value.clone()]);
        } else if a.starts_with("-I") || a.starts_with("-D") || a.starts_with("-U")
            || a.starts_with("-mmcu=") || a.starts_with("-std=")
            || ["-c", "-g", "-Os", "-O0", "-O1", "-O2", "-O3", "-Wall", "-Wextra", "-w",
                "-ffunction-sections", "-fdata-sections", "-fno-exceptions", "-fno-threadsafe-statics",
                "-fpermissive", "-flto", "-fno-fat-lto-objects", "-MMD", "-Wno-error=narrowing"].contains(&a.as_str()) {
            args.push(a.clone());
        } else if canonical(Path::new(a)).ok().as_ref() == Some(&source) && !source_seen {
            source_seen = true; args.push(a.clone());
        } else {
            return Err("recognition.command.unsupported-argument".into());
        }
        i += 1;
    }
    if !source_seen || !args.iter().any(|a| a == "-c") {
        return Err("recognition.command.not-compile".into());
    }
    let object = object.ok_or("recognition.output.missing")?;
    // A replay must not silently reinterpret time-dependent source macros.
    args.extend(["-MD".into(), "-fdump-tree-gimple-lineno".into(), "-save-temps=obj".into(),
        "-Wdate-time".into(), "-Werror=date-time".into()]);
    Ok((compiler, args, object))
}

fn run(exe: &Path, args: &[String], cwd: &Path, deadline: Instant, label: &Path) -> Result<String, String> {
    let stdout = label.with_extension("stdout");
    let stderr = label.with_extension("stderr");
    let mut command = Command::new(exe);
    command.args(args).current_dir(cwd).stdin(Stdio::null())
        .stdout(fs::File::create(&stdout).map_err(|e| e.to_string())?)
        .stderr(fs::File::create(&stderr).map_err(|e| e.to_string())?);
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if !status.success() { return Err("recognition.compiler-observation.failed".into()); }
            break;
        }
        if Instant::now() >= deadline || fs::metadata(&stdout).map(|m| m.len() > 4_000_000).unwrap_or(false)
            || fs::metadata(&stderr).map(|m| m.len() > 4_000_000).unwrap_or(false) {
            let _ = child.kill(); let _ = child.wait();
            return Err("recognition.capture.limit".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    String::from_utf8(bounded_read(&stdout, 4_000_000)?).map_err(|e| e.to_string())
}
fn dependencies(file: &Path) -> Result<Vec<PathBuf>, String> {
    let text = String::from_utf8(bounded_read(file, 2_000_000)?).map_err(|e| e.to_string())?
        .replace("\\\r\n", " ").replace("\\\n", " ");
    let (_, body) = text.split_once(": ").ok_or("recognition.dependencies.invalid")?;
    let mut paths = Vec::new();
    let mut token = String::new();
    let mut chars = body.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' && chars.peek() == Some(&' ') { token.push(chars.next().unwrap()); }
        else if c.is_whitespace() {
            if !token.is_empty() { paths.push(PathBuf::from(std::mem::take(&mut token))); }
        } else { token.push(c); }
    }
    if !token.is_empty() { paths.push(PathBuf::from(token)); }
    Ok(paths)
}
fn add_source(sources: &mut BTreeMap<String, String>, file: &Path) -> Result<(), String> {
    if sources.len() >= 4096 { return Err("recognition.sources.limit".into()); }
    let key = string(&canonical(file)?);
    let sha = digest(&bounded_read(file, 64_000_000)?);
    if let Some(previous) = sources.insert(key, sha.clone()) {
        if previous != sha { return Err("recognition.source.changed".into()); }
    }
    Ok(())
}
fn library(file: &Path) -> Option<(PathBuf, String)> {
    for parent in file.ancestors().skip(1).take(6) {
        let properties = parent.join("library.properties");
        if properties.is_file() {
            let text = fs::read_to_string(properties).ok()?;
            let version = text.lines().find_map(|line| line.strip_prefix("version=")).unwrap_or("").trim();
            return Some((parent.to_owned(), version.to_owned()));
        }
    }
    None
}

pub(crate) fn capture(ticket: Ticket) -> Result<Value, String> {
    let database_path = ticket.build.join("compile_commands.json");
    let raw = bounded_read(&database_path, 8_000_000)?;
    if digest(&raw) != ticket.database_sha256 { return Err("recognition.commands.stale".into()); }
    for (file, expected) in &ticket.registered_sources {
        if digest(&bounded_read(Path::new(file), 64_000_000)?) != *expected {
            return Err("recognition.registered-source.stale".into());
        }
    }
    let commands: Vec<CompileCommand> = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    if commands.is_empty() || commands.len() > 256 { return Err("recognition.units.limit".into()); }
    let scratch = Scratch(std::env::temp_dir().join(format!("ck-resource-observation-{}", uuid::Uuid::new_v4())));
    fs::create_dir(&scratch.0).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut sources = ticket.registered_sources.clone();
    let mut units = Vec::new();
    let mut symbols = Vec::new();
    let mut gaps = Vec::new();
    let mut dump_bytes = 0usize;
    let build = canonical(&ticket.build)?;
    for (index, command) in commands.iter().enumerate() {
        if Instant::now() >= deadline { gaps.push("recognition.capture.limit"); break; }
        let out = scratch.0.join(index.to_string());
        fs::create_dir(&out).map_err(|e| e.to_string())?;
        let (compiler, args, object) = match replay_arguments(command, &ticket.sysroot, &out) {
            Ok(value) => value,
            Err(_) => { gaps.push("recognition.command.unsupported"); continue; }
        };
        // Never let nm read an arbitrary path supplied by a modified database.
        if !canonical(&object).map(|p| p.starts_with(&build)).unwrap_or(false) {
            gaps.push("recognition.object.unavailable"); continue;
        }
        add_source(&mut sources, &command.file)?;
        add_source(&mut sources, &compiler)?;
        add_source(&mut sources, &object)?;
        if let Ok(deps) = dependencies(&object.with_extension("d")) {
            for dep in deps { add_source(&mut sources, &dep)?; }
        }
        let nm = compiler.with_file_name(if cfg!(windows) { "avr-gcc-nm.exe" } else { "avr-gcc-nm" });
        add_source(&mut sources, &nm)?;
        let text = run(&nm, &["-C".into(), string(&object)], &out, deadline, &out.join("nm"))?;
        let mut defined = Vec::new();
        let mut referenced = Vec::new();
        for line in text.lines() {
            let line = line.trim();
            if let Some(name) = line.strip_prefix("U ") { referenced.push(name.trim().to_owned()); continue; }
            if let Some((_, name)) = line.split_once(" T ").or_else(|| line.split_once(" t ")).or_else(|| line.split_once(" W ")) {
                defined.push(name.to_owned());
            }
        }
        symbols.push(json!({"file": string(&command.file), "definedSymbols": defined, "referencedSymbols": referenced}));
        let is_sketch = canonical(&command.file)?.starts_with(build.join("sketch"));
        let selected = library(&command.file);
        if (!is_sketch && selected.is_none()) || command.file.extension().and_then(|x| x.to_str()) != Some("cpp") {
            continue;
        }
        if units.len() >= 32 { gaps.push("recognition.units.limit"); continue; }
        if let Some((root, _)) = &selected { add_source(&mut sources, &root.join("library.properties"))?; }
        let cwd = command.directory.as_deref().filter(|p| p.is_dir()).unwrap_or(&ticket.build);
        if run(&compiler, &args, cwd, deadline, &out.join("compile")).is_err() {
            gaps.push("recognition.unit.unavailable"); continue;
        }
        let files: Vec<PathBuf> = fs::read_dir(&out).map_err(|e| e.to_string())?.filter_map(Result::ok).map(|e| e.path()).collect();
        let dumps: Vec<_> = files.iter().filter(|p| p.extension().and_then(|x| x.to_str()) == Some("gimple")).collect();
        if dumps.len() != 1 { gaps.push("recognition.gimple.unavailable"); continue; }
        let gimple = String::from_utf8(bounded_read(dumps[0], 2_000_000)?).map_err(|e| e.to_string())?;
        let preprocessed = String::from_utf8(bounded_read(&out.join("observation.ii"), 4_000_000)?).map_err(|e| e.to_string())?;
        dump_bytes += gimple.len() + preprocessed.len();
        if dump_bytes > 8_000_000 { gaps.push("recognition.capture.limit"); break; }
        let deps = dependencies(&out.join("observation.d"))?;
        for dep in &deps { add_source(&mut sources, dep)?; }
        units.push(Unit {
            file: string(&command.file), kind: if is_sketch { "sketch".into() } else { "library".into() },
            library_root: selected.as_ref().map(|(root, _)| string(root)),
            library_version: selected.map(|(_, version)| version), dependencies: deps.iter().map(|p| string(p)).collect(),
            gimple_sha256: digest(gimple.as_bytes()), gimple,
            preprocessed_sha256: digest(preprocessed.as_bytes()), preprocessed,
            command_sha256: digest(serde_json::to_string(&command.arguments).unwrap().as_bytes()),
            defined_symbols: defined, referenced_symbols: referenced,
        });
    }
    // Close TOCTOU windows: no evidence from changed inputs or a newer build.
    for (file, before) in &sources {
        if digest(&bounded_read(Path::new(file), 64_000_000)?) != *before { return Err("recognition.source.changed".into()); }
    }
    if digest(&bounded_read(&database_path, 8_000_000)?) != ticket.database_sha256 { return Err("recognition.commands.stale".into()); }
    Ok(json!({
        "context": ticket.context, "codeSha256": ticket.code_sha256,
        "compileCommandsSha256": ticket.database_sha256,
        "sources": sources.into_iter().map(|(path, sha256)| json!({"path":path,"sha256":sha256})).collect::<Vec<_>>(),
        "compiledFiles": commands.iter().map(|c| string(&c.file)).collect::<Vec<_>>(),
        "units": units, "symbols": symbols, "gaps": gaps,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_plugin_response_file_and_output_override() {
        let temp = tempfile::tempdir().unwrap();
        let compiler = temp.path().join("packages/test/tools/avr-g++");
        fs::create_dir_all(compiler.parent().unwrap()).unwrap();
        fs::write(&compiler, "").unwrap();
        let source = temp.path().join("x.cpp"); fs::write(&source, "").unwrap();
        for bad in ["@args", "-fplugin=bad.dll", "-Bother", "-MFoutside", "-save-temps", "-include", "-specs=bad"] {
            let command = CompileCommand { file: source.clone(), directory: None,
                arguments: vec![string(&compiler), "-c".into(), string(&source), "-o".into(), "x.o".into(), bad.into()] };
            assert!(replay_arguments(&command, temp.path(), temp.path()).is_err(), "{bad}");
        }
    }
    #[test]
    fn redirects_only_observation_outputs() {
        let temp = tempfile::tempdir().unwrap();
        let compiler = temp.path().join("packages/test/tools/avr-g++");
        fs::create_dir_all(compiler.parent().unwrap()).unwrap();
        fs::write(&compiler, "").unwrap();
        let source = temp.path().join("x.cpp"); fs::write(&source, "").unwrap();
        let original = temp.path().join("original.o");
        let scratch = temp.path().join("isolated");
        let command = CompileCommand { file: source.clone(), directory: None,
            arguments: vec![string(&compiler), "-c".into(), "-w".into(), "-mmcu=atmega328p".into(), "-DF_CPU=16000000L".into(),
                string(&source), "-o".into(), string(&original)] };
        let (_, args, object) = replay_arguments(&command, temp.path(), &scratch).unwrap();
        assert_eq!(object, original);
        assert!(!args.contains(&string(&original)));
        assert!(args.contains(&string(&scratch.join("observation.o"))));
        assert!(args.contains(&"-mmcu=atmega328p".to_string()));
        assert!(args.contains(&"-DF_CPU=16000000L".to_string()));
        assert!(args.contains(&"-Werror=date-time".to_string()));
        assert!(!args.contains(&"-w".to_string()));
    }
    #[test]
    fn changed_source_after_success_cannot_reuse_ticket() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("x.cpp"); fs::write(&source, "old").unwrap();
        fs::write(temp.path().join("compile_commands.json"), serde_json::to_vec(&json!([
            {"file": string(&source), "arguments": ["not-executed"]}
        ])).unwrap()).unwrap();
        register("stale-source-test", temp.path(), temp.path(), "old", &json!({}));
        let ticket = take("stale-source-test").unwrap();
        fs::write(&source, "new").unwrap();
        assert_eq!(capture(ticket).unwrap_err(), "recognition.registered-source.stale");
        assert!(take("stale-source-test").is_err(), "tickets are one-shot");
    }
    #[test]
    #[ignore = "installed toolchain gate, requires explicit request JSON"]
    fn installed_capture_gate() {
        let path = std::env::var("CK_RESOURCE_CAPTURE_REQUEST").unwrap();
        let input: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        let build = PathBuf::from(input["build"].as_str().unwrap());
        register("installed-test", &build, Path::new(input["sysroot"].as_str().unwrap()),
            input["code"].as_str().unwrap(), &input["context"]);
        let ticket = take("installed-test").unwrap();
        let value = capture(ticket).unwrap();
        fs::write(input["output"].as_str().unwrap(), serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    }
}
