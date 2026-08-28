use anyhow::{Result, anyhow};
use ck_core::sysroot::Sysroot;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};

pub struct ArduinoClient {
    sysroot: Arc<Sysroot>,
    config_path: Option<PathBuf>,
}

impl ArduinoClient {
    pub fn new(sysroot: Arc<Sysroot>) -> Self {
        Self {
            sysroot,
            config_path: None,
        }
    }

    pub async fn init(&mut self) -> Result<()> {
        // Sysroot::init owns the single Arduino CLI configuration used by the
        // desktop compiler, board resolver and library manager. Never download
        // a second hard-coded CLI or create a parallel state directory here.
        let config_path = self.sysroot.root_dir.join("arduino-cli.yaml");
        if !config_path.is_file() {
            return Err(anyhow!(
                "Arduino CLI configuration not found at {:?}",
                config_path
            ));
        }
        self.config_path = Some(config_path);

        let cli_path = self.get_cli_path();
        if !cli_path.is_file() {
            return Err(anyhow!("Bundled Arduino CLI not found at {:?}", cli_path));
        }

        Ok(())
    }

    fn get_cli_path(&self) -> PathBuf {
        let mut path = self.sysroot.root_dir.join("bin").join("arduino-cli");
        if cfg!(windows) {
            path.set_extension("exe");
        }
        path
    }

    pub async fn run_command(&self, args: Vec<&str>) -> Result<String> {
        let cli_path = self.get_cli_path();
        if !cli_path.exists() {
            return Err(anyhow!("Arduino CLI binary not found at {:?}", cli_path));
        }

        let config_path = self
            .config_path
            .as_ref()
            .ok_or(anyhow!("Config not initialized"))?;

        let mut cmd = tokio::process::Command::new(&cli_path);
        cmd.args(&["--config-file", config_path.to_str().unwrap()]);
        cmd.args(&args);

        // No stdout/stderr piping here for simplicity of return,
        // ideally we stream log::info!
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        log::info!("Running: {:?} {:?}", cli_path, args);

        let mut child = cmd.spawn()?;

        // Read output
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        let mut out_reader = BufReader::new(stdout).lines();
        let mut err_reader = BufReader::new(stderr).lines();

        let mut output_acc = String::new();

        tokio::spawn(async move {
            while let Ok(Some(line)) = err_reader.next_line().await {
                log::warn!("[CLI] {}", line);
            }
        });

        while let Ok(Some(line)) = out_reader.next_line().await {
            log::info!("[CLI] {}", line);
            output_acc.push_str(&line);
            output_acc.push('\n');
        }

        let status = child.wait().await?;
        if !status.success() {
            return Err(anyhow!("Command failed with status: {}", status));
        }

        Ok(output_acc)
    }
}

#[cfg(test)]
mod tests {
    use super::ArduinoClient;
    use ck_core::sysroot::Sysroot;
    use std::sync::Arc;

    #[tokio::test]
    async fn init_uses_the_single_sysroot_cli_and_configuration_without_downloading() {
        let temp = tempfile::tempdir().unwrap();
        let sysroot = Arc::new(
            Sysroot::init(Some(temp.path().join("root")), "arduino-client-test")
                .await
                .unwrap(),
        );
        let mut cli_path = sysroot.root_dir.join("bin").join("arduino-cli");
        if cfg!(windows) {
            cli_path.set_extension("exe");
        }
        tokio::fs::write(&cli_path, b"test cli").await.unwrap();

        let mut client = ArduinoClient::new(sysroot.clone());
        client.init().await.unwrap();
        assert_eq!(client.get_cli_path(), cli_path);
        assert_eq!(
            client.config_path.as_deref(),
            Some(sysroot.root_dir.join("arduino-cli.yaml").as_path())
        );
        assert!(!sysroot.root_dir.join("packages/arduino-cli").exists());
    }
}
