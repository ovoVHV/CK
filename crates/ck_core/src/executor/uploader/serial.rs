use anyhow::{Context, Result};
use serialport::{SerialPort, SerialPortType};
use std::thread;
use std::time::Duration;

#[derive(Debug, serde::Serialize)]
pub struct SerialPortInfo {
    pub port_name: String,
    pub description: String,
}

/// Lists available serial ports.
pub fn list_ports() -> Result<Vec<SerialPortInfo>> {
    let ports = serialport::available_ports().context("Failed to list serial ports")?;

    let mut infos = Vec::new();
    for p in ports {
        let description = match p.port_type {
            SerialPortType::UsbPort(info) => {
                format!("USB Serial (VID:{:04x} PID:{:04x})", info.vid, info.pid)
            }
            SerialPortType::PciPort => "PCI Serial".to_string(),
            SerialPortType::BluetoothPort => "Bluetooth Serial".to_string(),
            SerialPortType::Unknown => "Unknown Serial".to_string(),
        };

        infos.push(SerialPortInfo {
            port_name: p.port_name,
            description,
        });
    }

    Ok(infos)
}

/// Performs the ESP32 automatic bootloader reset sequence.
/// Verify this sequence:
/// 1. DTR = 0, RTS = 0
/// 2. DTR = 0, RTS = 1 (EN = 0, IO0 = 1) -> Reset
/// 3. DTR = 1, RTS = 1 (EN = 1, IO0 = 1) -> Release Reset
/// Wait...
/// Standard ESP32 Auto-reset (esptool strategy):
/// DTR controls IO0 (BOOT), RTS controls EN (RESET).
/// Logic:
/// 1. RTS = 1 (EN=0, Chip in Reset), DTR = 1 (IO0=0, Boot mode)
/// 2. RTS = 0 (EN=1, Chip Release Reset), DTR = 1 (IO0=0, Boot mode) -> Enters Bootloader
///
/// Note: on some USB-to-TTL, DTR/RTS are inverted or have auto-transistor logic (NodeMCU style).
/// Detailed NodeMCU reset:
/// DTR & RTS are used to control EN and IO0.
/// IO0 = DTR && !RTS
/// EN = !DTR && RTS
///
/// We usually don't need to do this manually if we just spawn `esptool.py` because `esptool` handles it!
/// BUT, if we want to confirm connection or do something custom, we might need it.
/// For this Phase, user asked to "Implement Upload System".
/// Since `upload.pattern` usually calls `esptool`, we fundamentally just need to INVOKE esptool command.
/// Implementing manual reset here is a backup or for "Serial Monitor" auto-reset.
///
/// Let's keep it simple: `esptool` does the reset.
/// We just need to ensure the port is not open by us when `esptool` runs.
pub fn touch_port(port_name: &str, baud_rate: u32) -> Result<()> {
    // Just try to open and close to verify it exists and is accessible
    let _ = serialport::new(port_name, baud_rate)
        .timeout(Duration::from_millis(100))
        .open()
        .context(format!("Failed to open port {}", port_name))?;
    Ok(())
}
