use anyhow::Result;
use ck_core::registry::boards::parse_boards_txt;
use ck_core::sysroot::Sysroot;
use std::path::PathBuf;
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::builder()
        .filter_level(log::LevelFilter::Info)
        .init();

    // 1. Init Sysroot
    let sysroot = Arc::new(Sysroot::init(None, "CK").await?);
    // 2. Locate boards.txt
    // sysroot/packages/packages/esp32/hardware/esp32/3.3.1/boards.txt
    // Note: 'data' dir is sysroot/packages. arduino-cli adds 'packages' subdir.
    let possible_path = sysroot
        .root_dir
        .join("packages")
        .join("packages")
        .join("esp32")
        .join("hardware")
        .join("esp32")
        .join("3.3.1")
        .join("boards.txt");

    if !possible_path.exists() {
        log::error!(
            "❌ boards.txt not found at {:?}. Run install_esp32 first.",
            possible_path
        );
        return Ok(());
    }

    log::info!("Found boards.txt at {:?}", possible_path);

    // 3. Parse it
    let boards = parse_boards_txt(&possible_path).await?;
    log::info!("✅ Parsed {} boards from boards.txt", boards.len());

    // 4. Verify specific board properties (ESP32-C5)
    // ID might be "esp32c5" or similar. Iterate to find similarly named ones if exact ID unknown.
    let mut found = false;
    for (id, board) in &boards {
        if id.contains("esp32c5") || board.name.to_lowercase().contains("esp32-c5") {
            log::info!("Found Target Board: [{}] {}", id, board.name);
            // Verify some properties
            if let Some(mcu) = board.properties.get("build.mcu") {
                log::info!("  build.mcu = {}", mcu);
            }
            if let Some(variant) = board.properties.get("build.variant") {
                log::info!("  build.variant = {}", variant);
            }
            found = true;
        }
    }

    if !found {
        log::warn!(
            "⚠️ Warning: ESP32-C5 not explicitly found in boards.txt. Listing first 5 boards:"
        );
        for (i, (id, board)) in boards.iter().take(5).enumerate() {
            log::info!("  {}. [{}] {}", i + 1, id, board.name);
        }
    } else {
        log::info!("✅ ESP32-C5 board definition verified!");
    }

    Ok(())
}
