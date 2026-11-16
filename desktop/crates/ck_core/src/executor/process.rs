use anyhow::{Context, Result, bail};
use std::path::Path;
use std::process::Stdio;
use tokio::process::Command;

#[derive(Debug)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}

/// Executes a single command line string.
/// The command string is assumed to be pre-split or we split it here?
/// Actually, `Resolver` already splits it into a Vec<String>.
/// So we should accept `&[String]`.
pub async fn execute_command(args: &[String], cwd: Option<&Path>) -> Result<CommandOutput> {
    if args.is_empty() {
        bail!("Command is empty");
    }

    let program = &args[0];
    let arguments = &args[1..];

    let mut cmd = Command::new(program);
    cmd.args(arguments);

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    // Configure stdio to capture output
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // Kill child on drop to prevent zombies if future is dropped
    cmd.kill_on_drop(true);

    // TODO: Ideally we want to stream output to the UI,
    // but for the basic "Executor" v1 we can collect it.
    // Capturing is easier for error reporting.

    let output = cmd
        .output()
        .await
        .with_context(|| format!("Failed to execute command: {}", program))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(CommandOutput {
        stdout,
        stderr,
        success: output.status.success(),
    })
}
