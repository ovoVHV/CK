//! Run against a private fixture to measure the complete host identity path.
use ck_core::builder::demo::ToolchainIdentityLease;
use std::{path::PathBuf, time::Instant};
struct Logger;
impl log::Log for Logger {
    fn enabled(&self, m: &log::Metadata) -> bool { m.target() == "ck_identity_timing" }
    fn log(&self, r: &log::Record) { if self.enabled(r.metadata()) { eprintln!("{}", r.args()); } }
    fn flush(&self) {}
}
fn main() -> anyhow::Result<()> {
    static LOGGER: Logger = Logger;
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Debug);
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(args.len() == 3, "Usage: identity_profile PRIVATE_SYSROOT FQBN");
    let root = PathBuf::from(&args[1]);
    for label in ["first", "same-process"] {
        let started = Instant::now();
        let lease = ToolchainIdentityLease::begin(&root, &args[2])?;
        println!("{}", serde_json::json!({"label":label,"ms":started.elapsed().as_secs_f64()*1000.0,"key":lease.toolchain_key(),"source":format!("{:?}",lease.resolution_source())}));
    }
    Ok(())
}
