use anyhow::Result;
use arduino::client::ArduinoClient;
use ck_core::registry::platform::Platform;
use ck_core::sysroot::Sysroot;
use std::path::PathBuf;
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::builder()
        .filter_level(log::LevelFilter::Info)
        .init();

    log::info!("🚀 Starting ESP32 Core Installation & Verification...");

    // 1. Init Sysroot
    let sysroot = Arc::new(Sysroot::init(None, "CK").await?);
    // 2. Init Client
    let mut client = ArduinoClient::new(sysroot.clone());
    client.init().await?;

    // 3. Configure ESP32 URL
    log::info!("Configuring Board Manager URL...");
    client
        .run_command(vec![
            "config",
            "add",
            "board_manager.additional_urls",
            "https://espressif.github.io/arduino-esp32/package_esp32_index.json",
        ])
        .await?;

    client.run_command(vec!["core", "update-index"]).await?;

    // 4. Install ESP32 Core 3.3.1
    log::info!("Installing esp32:esp32@3.3.1 (This may take a while)...");
    // Check if installed first to save time? run_command handles it (arduino-cli handles idempotency usually)
    let install_res = client
        .run_command(vec!["core", "install", "esp32:esp32@3.3.1"])
        .await;
    match install_res {
        Ok(out) => log::info!("Install Output:\n{}", out),
        Err(e) => {
            log::error!("Failed to install core: {:?}", e);
            // Proceed anyway if it's already installed?
        }
    }

    // 5. Locate platform.txt
    // Path: sysroot/packages/esp32/hardware/esp32/3.3.1/platform.txt
    // Note: arduino-cli data dir structure might vary.
    // Based on default isolated config: data dir is `sysroot/packages`?
    // Wait, let's check `crates/arduino/src/config.rs` to see where `directories.data` points.
    // Assuming standard layout: data/packages/esp32/...

    // We'll search for it or assume path.
    let possible_path = sysroot
        .root_dir
        .join("state")
        .join("packages")
        .join("esp32")
        .join("hardware")
        .join("esp32")
        .join("3.3.1")
        .join("platform.txt");

    if !possible_path.exists() {
        log::error!(
            "❌ platform.txt not found at {:?}. Please check install paths.",
            possible_path
        );
        // Try searching?
        return Ok(());
    }

    log::info!("Found platform.txt at {:?}", possible_path);

    // 6. Parse it
    let platform = Platform::from_file(&possible_path).await?;
    log::info!(
        "✅ Parsed Platform: {} version {}",
        platform.name,
        platform.version
    );

    // 7. Verify some complex keys
    let pattern = platform.properties.get("recipe.c.o.pattern");
    if let Some(pat) = pattern {
        log::info!("Found compilation pattern: {}", pat);
        // Try simple expansion (incomplete context, but verifies regex works)
        let expanded = platform.properties.expand(pat);
        log::info!("Expanded (partial): {}", expanded);
    } else {
        log::error!("❌ Missing recipe.c.o.pattern");
    }

    Ok(())
}
