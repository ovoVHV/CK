use anyhow::Result;
use ck_core::sysroot::{ESP32_CN_PACKAGE_INDEX_URL, ESP32_OFFICIAL_PACKAGE_INDEX_URL};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Default)]
pub struct ArduinoConfig {
    pub directories: Directories,
    pub board_manager: BoardManager,
    pub daemon: Daemon,
    pub logging: Logging,
    pub telemetry: Telemetry,
}

#[derive(Serialize, Deserialize, Default)]
pub struct Directories {
    pub data: PathBuf,
    pub downloads: PathBuf,
    pub user: PathBuf,
}

#[derive(Serialize, Deserialize)]
pub struct BoardManager {
    pub additional_urls: Vec<String>,
}

impl Default for BoardManager {
    fn default() -> Self {
        Self {
            // Keep both sources available. The official index provides the
            // regular 3.3.6 package; the CN index provides explicitly
            // suffixed versions such as 3.3.6-cn.
            additional_urls: vec![
                ESP32_OFFICIAL_PACKAGE_INDEX_URL.to_owned(),
                ESP32_CN_PACKAGE_INDEX_URL.to_owned(),
            ],
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
pub struct Daemon {
    pub port: String,
}

#[derive(Serialize, Deserialize, Default)]
pub struct Logging {
    pub file: String,
    pub format: String,
    pub level: String,
}

#[derive(Serialize, Deserialize, Default)]
pub struct Telemetry {
    pub enabled: bool,
}

pub async fn generate_config(sysroot_dir: PathBuf) -> Result<PathBuf> {
    let state_dir = sysroot_dir.join("state");
    let packages_dir = sysroot_dir.join("packages");
    let downloads_dir = sysroot_dir.join("cache");
    let user_dir = sysroot_dir.join("sketchbook"); // Default sketchbook location

    // Create sketchbook dir
    tokio::fs::create_dir_all(&user_dir).await?;

    let config = ArduinoConfig {
        directories: Directories {
            data: packages_dir,
            downloads: downloads_dir,
            user: user_dir,
        },
        board_manager: BoardManager::default(),
        daemon: Daemon {
            port: "50051".to_string(),
        },
        logging: Logging {
            file: "".to_string(), // handled by us
            format: "text".to_string(),
            level: "info".to_string(),
        },
        telemetry: Telemetry { enabled: false },
    };

    let config_yaml = serde_yaml::to_string(&config)?;
    let config_path = state_dir.join("arduino-cli.yaml");

    tokio::fs::write(&config_path, config_yaml).await?;

    Ok(config_path)
}

#[cfg(test)]
mod tests {
    use super::{BoardManager, ESP32_CN_PACKAGE_INDEX_URL, ESP32_OFFICIAL_PACKAGE_INDEX_URL};

    #[test]
    fn default_board_manager_keeps_official_and_cn_indexes() {
        let urls = BoardManager::default().additional_urls;
        assert_eq!(urls.len(), 2);
        assert!(
            urls.iter()
                .any(|url| url == ESP32_OFFICIAL_PACKAGE_INDEX_URL)
        );
        assert!(urls.iter().any(|url| url == ESP32_CN_PACKAGE_INDEX_URL));
    }
}
