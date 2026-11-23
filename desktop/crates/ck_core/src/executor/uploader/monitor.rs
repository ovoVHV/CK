use anyhow::{Context, Result, anyhow};
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
    // This callback is intentionally a raw-byte transport. A serial read and
    // an IPC event are not text or line boundaries: one UTF-8 scalar may span
    // two reads/events, while one event may contain several CR/LF-delimited
    // records. Decoding here (especially with from_utf8_lossy) would turn a
    // split Chinese character into replacement characters and could make a
    // later parser invent labels from the remaining byte fragments.
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
                if (pending_data.len() >= SERIAL_PENDING_FLUSH_SIZE
                    || last_flush.elapsed() > SERIAL_PENDING_FLUSH_INTERVAL)
                    && flush_pending_data(&mut pending_data, &on_receive)
                {
                    last_flush = std::time::Instant::now();
                }

                // Do not sleep after a successful read. On Windows a nominal
                // microsecond sleep can be rounded to roughly a millisecond.
                // With USB-UART drivers that return 64-byte packets, that caps
                // the reader below 2,000,000 baud and lets the driver buffer
                // overflow, producing missing bytes that later look like
                // malformed fields or broken UTF-8. The blocking read timeout
                // already prevents this dedicated thread from busy-spinning.
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

fn stop_join_and_release<W>(
    running: &Arc<AtomicBool>,
    reader_thread: &mut Option<thread::JoinHandle<()>>,
    writer: &mut Option<W>,
) -> Result<()> {
    running.store(false, Ordering::Release);

    let join_result = reader_thread
        .take()
        .map(|handle| {
            handle
                .join()
                .map_err(|_| anyhow!("Serial monitor read thread panicked while closing"))
        })
        .unwrap_or(Ok(()));

    // Release the writer even if the reader panicked. A close failure must be
    // reported, but it must never leave CK holding the remaining OS handle.
    writer.take();
    join_result
}

pub struct SerialMonitor {
    // We keep the writer part protected by Mutex so we can write from main thread
    //
    // Keep this in an Option so an explicit close can drop the final writer
    // handle before the close command acknowledges completion. Relying only on
    // Drop made it impossible to report a reader-thread shutdown failure and
    // made the UI-visible "closed" state race the actual OS handle lifetime.
    port_writer: Option<Arc<Mutex<Box<dyn SerialPort>>>>,
    // Flag to signal the read thread to stop
    running: Arc<AtomicBool>,
    // Handle to join the read thread (optional, mostly for clean shutdown)
    reader_thread: Option<thread::JoinHandle<()>>,
}

impl SerialMonitor {
    /// Opens a port and starts a background thread to read data.
    /// `on_receive` receives ordered raw bytes. Its chunks do not imply UTF-8
    /// or line boundaries; text consumers must use a persistent streaming
    /// decoder across callbacks.
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
            port_writer: Some(port_writer),
            running,
            reader_thread: Some(thread_handle),
        })
    }

    pub fn is_connected(&self) -> bool { self.running.load(Ordering::Acquire) }

    pub fn send(&self, data: &[u8]) -> Result<()> {
        let port_writer = self
            .port_writer
            .as_ref()
            .context("Serial monitor is already closed")?;
        let mut port = port_writer
            .lock()
            .map_err(|_| anyhow!("Serial monitor writer lock is poisoned"))?;
        port.write_all(data)
            .context("Failed to write to serial port")?;
        port.flush()?;
        Ok(())
    }

    fn shutdown(&mut self) -> Result<()> {
        // The serial port uses a 10 ms read timeout, so the reader observes the
        // stop flag promptly. Joining is the synchronization point that proves
        // the cloned reader handle has been dropped and its final pending batch
        // has already been emitted.
        stop_join_and_release(
            &self.running,
            &mut self.reader_thread,
            &mut self.port_writer,
        )
    }

    /// Stop reading, wait for the reader thread, and release every serial-port
    /// handle before returning. Unlike the Drop fallback, this reports a
    /// shutdown failure to the caller instead of silently hiding the panel.
    pub fn close(mut self) -> Result<()> {
        self.shutdown()
    }
}

#[cfg(test)]
mod tests {
    use super::{run_serial_read_loop, stop_join_and_release};
    use std::collections::VecDeque;
    use std::io::{self, Read};
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };
    use std::time::Duration;

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

    #[test]
    fn preserves_every_byte_across_supported_high_baud_chunk_patterns() {
        let cases = [
            (115_200u32, [1usize, 2, 7, 3, 11]),
            (460_800u32, [13usize, 1, 5, 29, 2]),
            (921_600u32, [31usize, 2, 3, 47, 1]),
            (2_000_000u32, [64usize, 1, 127, 5, 3]),
        ];
        let source = [
            "42\n",
            "1 2\r\n",
            "温度 23.5\n",
            "湿度=64\r",
            "x,y\n1,2\n",
            "continuous-tail-without-newline",
        ]
        .concat()
        // Exceed the 32 KiB event-batch threshold so the assertion covers
        // ordering across multiple backend-to-Tauri batches as well.
        .repeat(512)
        .into_bytes();

        for (baud_rate, pattern) in cases {
            let running = Arc::new(AtomicBool::new(true));
            let mut steps = Vec::new();
            let mut offset = 0usize;
            let mut pattern_index = 0usize;
            while offset < source.len() {
                let end = (offset + pattern[pattern_index % pattern.len()]).min(source.len());
                steps.push(ReadStep::Data(source[offset..end].to_vec()));
                offset = end;
                pattern_index += 1;
            }
            steps.push(ReadStep::Error(io::ErrorKind::TimedOut));
            steps.push(ReadStep::Error(io::ErrorKind::ConnectionReset));

            let mut reader = ScriptedReader::new(running.clone(), steps);
            let received = Arc::new(Mutex::new(Vec::<u8>::new()));
            run_serial_read_loop(
                &mut reader,
                &running,
                {
                    let received = received.clone();
                    move |data| received.lock().unwrap().extend_from_slice(&data)
                },
                |_| {},
            );

            assert_eq!(
                *received.lock().unwrap(),
                source,
                "serial bytes changed while simulating {baud_rate} baud",
            );
        }
    }

    fn collect_raw_event_batches(source: &[u8], pattern: &[usize]) -> Vec<Vec<u8>> {
        assert!(!pattern.is_empty());
        let running = Arc::new(AtomicBool::new(true));
        let mut steps = Vec::new();
        let mut offset = 0usize;
        let mut pattern_index = 0usize;
        while offset < source.len() {
            let end = (offset + pattern[pattern_index % pattern.len()]).min(source.len());
            steps.push(ReadStep::Data(source[offset..end].to_vec()));
            offset = end;
            pattern_index += 1;
        }
        steps.push(ReadStep::Error(io::ErrorKind::TimedOut));
        steps.push(ReadStep::Error(io::ErrorKind::ConnectionReset));

        let mut reader = ScriptedReader::new(running.clone(), steps);
        let batches = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        run_serial_read_loop(
            &mut reader,
            &running,
            {
                let batches = batches.clone();
                move |data| batches.lock().unwrap().push(data)
            },
            |_| {},
        );

        Arc::try_unwrap(batches).unwrap().into_inner().unwrap()
    }

    #[test]
    fn utf8_split_across_reads_and_events_remains_exact_raw_bytes() {
        // One- and two-byte reads deliberately cut through each three-byte
        // Chinese UTF-8 scalar. Repetition crosses the 32 KiB IPC batch limit,
        // so the same invariant is checked across multiple emitted events.
        let expected_text = "温度=23.5\r\n湿度=64\r\n".repeat(2_048);
        let batches = collect_raw_event_batches(expected_text.as_bytes(), &[1, 2, 1, 3, 2]);

        assert!(batches.len() >= 2, "fixture must cross an event boundary");
        let received = batches.concat();
        assert_eq!(received, expected_text.as_bytes());
        assert_eq!(
            String::from_utf8(received).unwrap(),
            expected_text,
            "backend transport must not insert UTF-8 replacement characters",
        );
    }

    #[test]
    fn half_packets_coalesced_lines_and_unterminated_tail_are_not_reframed() {
        let mut expected = "温".as_bytes().to_vec();
        expected.extend_from_slice("度=21\n湿度=55\r\na,b\n1,2\n".as_bytes());
        // A long fragment without any newline must still be flushed by byte/
        // time thresholds. The backend must not discard it, invent a line, or
        // keep only its tail.
        expected.extend((0..90_000).map(|index| b'a' + (index % 26) as u8));

        let batches = collect_raw_event_batches(&expected, &[1, 1, 7, 64, 511, 4_093]);

        assert!(
            batches.len() >= 3,
            "long unterminated input must be bounded"
        );
        assert_eq!(batches.concat(), expected);
    }

    struct DropProbe(Arc<AtomicBool>);

    impl Drop for DropProbe {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }

    #[test]
    fn explicit_close_waits_for_reader_and_releases_writer_before_returning() {
        let running = Arc::new(AtomicBool::new(true));
        let reader_released = Arc::new(AtomicBool::new(false));
        let writer_released = Arc::new(AtomicBool::new(false));

        let thread_running = running.clone();
        let reader_probe = DropProbe(reader_released.clone());
        let mut reader_thread = Some(std::thread::spawn(move || {
            let _reader_probe = reader_probe;
            while thread_running.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(1));
            }
        }));
        let mut writer = Some(DropProbe(writer_released.clone()));

        stop_join_and_release(&running, &mut reader_thread, &mut writer).unwrap();

        assert!(!running.load(Ordering::Acquire));
        assert!(reader_thread.is_none());
        assert!(writer.is_none());
        assert!(reader_released.load(Ordering::Acquire));
        assert!(writer_released.load(Ordering::Acquire));
    }

    #[test]
    fn explicit_close_reports_reader_panic_but_still_releases_writer() {
        let running = Arc::new(AtomicBool::new(true));
        let writer_released = Arc::new(AtomicBool::new(false));
        let mut reader_thread = Some(std::thread::spawn(|| panic!("simulated reader panic")));
        let mut writer = Some(DropProbe(writer_released.clone()));

        let error = stop_join_and_release(&running, &mut reader_thread, &mut writer)
            .expect_err("reader panic must be visible to the close caller");

        assert!(error.to_string().contains("read thread panicked"));
        assert!(writer.is_none());
        assert!(writer_released.load(Ordering::Acquire));
    }
}

impl Drop for SerialMonitor {
    fn drop(&mut self) {
        // Application shutdown still needs a best-effort fallback, but normal
        // user-initiated close goes through `close()` so failures are surfaced.
        if let Err(error) = self.shutdown() {
            log::error!("Failed to close serial monitor cleanly: {error:#}");
        }
    }
}
