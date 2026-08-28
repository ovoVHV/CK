use chrono::{DateTime, Utc};
use log::{Level, Metadata, Record};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
pub struct LogEvent {
    pub level: String,
    pub message: String,
    pub timestamp: DateTime<Utc>,
    pub target: String,
}

pub struct FrontendLogger {
    app_handle: AppHandle,
}

impl FrontendLogger {
    pub fn new(app_handle: AppHandle) -> Self {
        Self { app_handle }
    }

    fn is_noise(record: &Record) -> bool {
        let msg = record.args().to_string();
        msg.contains("NewEvents emitted without explicit RedrawEventsCleared")
            || msg.contains("RedrawEventsCleared emitted without explicit MainEventsCleared")
    }
}

impl log::Log for FrontendLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= Level::Info // Adjust level as needed
    }

    fn log(&self, record: &Record) {
        if self.enabled(record.metadata()) {
            if Self::is_noise(record) {
                // Drop known event-loop ordering spam from tao/winit on Windows.
                // It is non-actionable for users and can cause heavy UI log traffic.
                return;
            }
            let event = LogEvent {
                level: record.level().to_string(),
                message: record.args().to_string(),
                timestamp: Utc::now(),
                target: record.target().to_string(),
            };

            // Emit to frontend
            // We ignore errors here because if the frontend is not ready/reload, it is fine.
            let _ = self.app_handle.emit("log://stream", event);

            // Also print to stdout for debugging
            println!("[{}] {}", record.level(), record.args());
        }
    }

    fn flush(&self) {}
}

pub fn init(app_handle: AppHandle) -> Result<(), log::SetLoggerError> {
    let logger = Box::new(FrontendLogger::new(app_handle));
    log::set_boxed_logger(logger).map(|()| log::set_max_level(log::LevelFilter::Info))
}
