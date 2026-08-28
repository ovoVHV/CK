use anyhow::{Context, Result};
use serialport::SerialPort;
use std::io::Read;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::Duration;

const SERIAL_READ_BUFFER_SIZE: usize = 16 * 1024;
const SERIAL_PENDING_FLUSH_SIZE: usize = 32 * 1024;
const SERIAL_PENDING_FLUSH_INTERVAL: Duration = Duration::from_millis(32);

fn flush_pending_data<F>(pending_data: &mut Vec<u8>, on_receive: &F) -> bool
where
    F: Fn(Vec<u8>),
{
    if pending_data.is_empty() {
        return false;
    }

    // Transfer ownership of the batch instead of cloning it. Replenishing the
    // capacity here keeps the hot read path allocation behavior predictable.
    let next_capacity = pending_data.capacity().max(SERIAL_READ_BUFFER_SIZE);
    let ready = std::mem::replace(pending_data, Vec::with_capacity(next_capacity));
    on_receive(ready);
    true
}

fn run_serial_read_loop<R, F, D>(
    port_reader: &mut R,
    running: &Arc<AtomicBool>,
    on_receive: F,
    on_disconnect: D,
) where
    R: Read + ?Sized,
    F: Fn(Vec<u8>),
    D: Fn(String),
{
    let mut read_buffer = [0u8; SERIAL_READ_BUFFER_SIZE];
    let mut pending_data = Vec::with_capacity(SERIAL_READ_BUFFER_SIZE);
    let mut last_flush = std::time::Instant::now();
    let mut disconnect_reason = None;

    while running.load(Ordering::Acquire) {
        match port_reader.read(&mut read_buffer) {
            Ok(n) if n > 0 => {
                pending_data.extend_from_slice(&read_buffer[..n]);

                // Reduce IPC frequency to prevent system overload (especially
                // on Windows with high baud rates), while bounding each batch.
                if (pending_data.len() > SERIAL_PENDING_FLUSH_SIZE
                    || last_flush.elapsed() > SERIAL_PENDING_FLUSH_INTERVAL)
                    && flush_pending_data(&mut pending_data, &on_receive)
                {
                    last_flush = std::time::Instant::now();
                }

                // Continuous full-speed reading on some CP210x/CH340 drivers
                // can otherwise monopolize the reader thread.
                thread::sleep(Duration::from_micros(50));
            }
            Ok(_) => {
                thread::sleep(Duration::from_millis(1));
            }
            Err(ref error) if error.kind() == std::io::ErrorKind::TimedOut => {
                // A timeout marks an idle bus and is a low-latency flush point.
                if flush_pending_data(&mut pending_data, &on_receive) {
                    last_flush = std::time::Instant::now();
                }
            }
            Err(error) => {
                log::error!("Serial read error: {}", error);
                // swap() closes the race with a concurrent user-initiated stop:
                // only a still-running monitor publishes a disconnect event.
                if running.swap(false, Ordering::AcqRel) {
                    disconnect_reason = Some(error.to_string());
                }
                break;
            }
        }
    }

    // A user close, a fatal read error, or any other loop exit must publish the
    // final partial batch. Emit it before the disconnect notification so event
    // consumers cannot tear down while unread serial bytes are still pending.
    flush_pending_data(&mut pending_data, &on_receive);
    if let Some(reason) = disconnect_reason {
        on_disconnect(reason);
    }
}

pub struct SerialMonitor {
    // We keep the writer part protected by Mutex so we can write from main thread
    port_writer: Arc<Mutex<Box<dyn SerialPort>>>,
    // Flag to signal the read thread to stop
    running: Arc<AtomicBool>,
    // Handle to join the read thread (optional, mostly for clean shutdown)
    reader_thread: Option<thread::JoinHandle<()>>,
}

impl SerialMonitor {
    /// Opens a port and starts a background thread to read data.
    /// `on_receive` is called whenever data arrives.
    /// `on_disconnect` is called when the port disconnects or encounters a fatal error.
    pub fn new<F, D>(
        port_name: &str,
        baud_rate: u32,
        on_receive: F,
        on_disconnect: D,
    ) -> Result<Self>
    where
        F: Fn(Vec<u8>) + Send + 'static,
        D: Fn(String) + Send + 'static,
    {
        let mut port = serialport::new(port_name, baud_rate)
            .timeout(Duration::from_millis(10))
            .open()
            .with_context(|| format!("Failed to open serial port {}", port_name))?;

        // Initialize port state:
        // 1. Clear buffers to remove stale data
        // 2. Set DTR/RTS to avoid holding board in reset/bootloader mode (ESP32 specific)
        let _ = port.clear(serialport::ClearBuffer::All);
        let _ = port.write_data_terminal_ready(false);
        let _ = port.write_request_to_send(false);

        // Clone the port for reading (serialport crate supports try_clone)
        let mut port_reader = port.try_clone().context("Failed to clone serial port")?;
        let port_writer = Arc::new(Mutex::new(port));

        let running = Arc::new(AtomicBool::new(true));
        let running_clone = running.clone();

        let thread_handle = thread::spawn(move || {
            run_serial_read_loop(&mut *port_reader, &running_clone, on_receive, on_disconnect);
        });

        Ok(Self {
            port_writer,
            running,
            reader_thread: Some(thread_handle),
        })
    }

    pub fn send(&self, data: &[u8]) -> Result<()> {
        let mut port = self.port_writer.lock().unwrap();
        port.write_all(data)
            .context("Failed to write to serial port")?;
        port.flush()?;
        Ok(())
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::run_serial_read_loop;
    use std::collections::VecDeque;
    use std::io::{self, Read};
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };

    enum ReadStep {
        Data(Vec<u8>),
        Error(io::ErrorKind),
    }

    struct ScriptedReader {
        steps: VecDeque<ReadStep>,
        running: Arc<AtomicBool>,
        stop_after_data: bool,
    }

    impl ScriptedReader {
        fn new(running: Arc<AtomicBool>, steps: impl IntoIterator<Item = ReadStep>) -> Self {
            Self {
                steps: steps.into_iter().collect(),
                running,
                stop_after_data: false,
            }
        }
    }

    impl Read for ScriptedReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            match self.steps.pop_front().expect("scripted reader exhausted") {
                ReadStep::Data(data) => {
                    let len = data.len().min(buffer.len());
                    buffer[..len].copy_from_slice(&data[..len]);
                    if self.stop_after_data {
                        self.running.store(false, Ordering::Release);
                    }
                    Ok(len)
                }
                ReadStep::Error(kind) => Err(io::Error::new(kind, "scripted read error")),
            }
        }
    }

    #[test]
    fn flushes_partial_tail_before_reporting_disconnect() {
        let running = Arc::new(AtomicBool::new(true));
        let mut reader = ScriptedReader::new(
            running.clone(),
            [
                ReadStep::Data(b"partial-tail".to_vec()),
                ReadStep::Error(io::ErrorKind::BrokenPipe),
            ],
        );
        let events = Arc::new(Mutex::new(Vec::<String>::new()));

        run_serial_read_loop(
            &mut reader,
            &running,
            {
                let events = events.clone();
                move |data| {
                    events
                        .lock()
                        .unwrap()
                        .push(format!("data:{}", String::from_utf8_lossy(&data)))
                }
            },
            {
                let events = events.clone();
                move |_| events.lock().unwrap().push("disconnect".into())
            },
        );

        assert_eq!(*events.lock().unwrap(), ["data:partial-tail", "disconnect"],);
        assert!(!running.load(Ordering::Acquire));
    }

    #[test]
    fn flushes_partial_tail_on_user_stop_without_disconnect_event() {
        let running = Arc::new(AtomicBool::new(true));
        let mut reader = ScriptedReader::new(
            running.clone(),
            [ReadStep::Data(b"last-user-bytes".to_vec())],
        );
        reader.stop_after_data = true;
        let received = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let disconnects = Arc::new(Mutex::new(0usize));

        run_serial_read_loop(
            &mut reader,
            &running,
            {
                let received = received.clone();
                move |data| received.lock().unwrap().push(data)
            },
            {
                let disconnects = disconnects.clone();
                move |_| *disconnects.lock().unwrap() += 1
            },
        );

        assert_eq!(*received.lock().unwrap(), [b"last-user-bytes".to_vec()]);
        assert_eq!(*disconnects.lock().unwrap(), 0);
    }

    #[test]
    fn timeout_flush_is_not_repeated_during_final_cleanup() {
        let running = Arc::new(AtomicBool::new(true));
        let mut reader = ScriptedReader::new(
            running.clone(),
            [
                ReadStep::Data(b"one-batch".to_vec()),
                ReadStep::Error(io::ErrorKind::TimedOut),
                ReadStep::Error(io::ErrorKind::ConnectionReset),
            ],
        );
        let received = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));

        run_serial_read_loop(
            &mut reader,
            &running,
            {
                let received = received.clone();
                move |data| received.lock().unwrap().push(data)
            },
            |_| {},
        );

        assert_eq!(*received.lock().unwrap(), [b"one-batch".to_vec()]);
    }
}

impl Drop for SerialMonitor {
    fn drop(&mut self) {
        // Signal stop
        self.stop();

        // Wait for thread to finish to ensure port is released
        if let Some(handle) = self.reader_thread.take() {
            let _ = handle.join();
        }
    }
}
