use crate::executor::process::{CommandOutput, execute_command};
use anyhow::{Result, bail};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Semaphore;

pub struct ProcessManager {
    concurrency: usize,
}

impl ProcessManager {
    pub fn new(concurrency: Option<usize>) -> Self {
        let concurrency = concurrency.unwrap_or_else(|| num_cpus::get());
        Self { concurrency }
    }

    /// Executes a list of commands in parallel, respecting the concurrency limit.
    /// Returns outputs in order, or the first error.
    pub async fn run_parallel(
        &self,
        commands: Vec<(Vec<String>, Option<PathBuf>)>,
    ) -> Result<Vec<CommandOutput>> {
        let semaphore = Arc::new(Semaphore::new(self.concurrency));
        let mut handlers = Vec::new();

        for (args, cwd) in commands {
            let sem_clone = semaphore.clone();

            let handler = tokio::spawn(async move {
                // Acquire permit
                let _permit = sem_clone.acquire().await.unwrap();

                // Run
                execute_command(&args, cwd.as_deref()).await
            });
            handlers.push(handler);
        }

        let mut results = Vec::new();
        for handler in handlers {
            let res = handler.await?; // JoinError
            match res {
                Ok(output) => {
                    if !output.success {
                        // For now, if one fails, we consider the whole batch failed?
                        // Or we return the failure output.
                        // Let's return failure output but formatted as Error?
                        // Actually, let's just return the output. The caller decides what to do.
                        // But wait, make usually stops on first error.
                        bail!(
                            "Command failed:\nstdout: {}\nstderr: {}",
                            output.stdout,
                            output.stderr
                        );
                    }
                    results.push(output);
                }
                Err(e) => return Err(e),
            }
        }

        Ok(results)
    }
}
