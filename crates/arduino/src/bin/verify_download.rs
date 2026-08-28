use anyhow::Result;
use arduino::client::ArduinoClient;
use ck_core::sysroot::Sysroot;
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<()> {
    // Enable logging
    env_logger::builder()
        .filter_level(log::LevelFilter::Info)
        .init();

    log::info!("Starting verification script...");

    // 1. Init Sysroot
    let sysroot = Arc::new(Sysroot::init(None, "CK").await?);
    log::info!("Sysroot verified at {:?}", sysroot.root_dir);

    // 2. Init Client (This triggers download)
    let mut client = ArduinoClient::new(sysroot);
    log::info!("Initializing Arduino Client (Downloading if needed)...");

    match client.init().await {
        Ok(_) => log::info!("✅ Arduino CLI initialized successfully! Hash verification passed."),
        Err(e) => {
            log::error!("❌ Initialization failed: {:?}", e);
            std::process::exit(1);
        }
    }

    // 3. Run version check
    match client.run_command(vec!["version"]).await {
        Ok(output) => log::info!("✅ CLI Version output:\n{}", output),
        Err(e) => log::error!("❌ Failed to run version check: {:?}", e),
    }

    Ok(())
}
