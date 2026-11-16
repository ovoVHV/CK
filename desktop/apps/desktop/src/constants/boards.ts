
export interface BoardDefinition {
    id: string;      // FQBN
    name: string;    // Display Name
    icon: string;    // Image path (relative to public/) or emoji fallback
    group: 'ESP32' | 'AVR' | 'Other';
    description: string; // Brief description
}

export const BOARDS: BoardDefinition[] = [
    // ESP32 Series
    { id: 'esp32:esp32:esp32c5', name: 'ESP32-C5 (WiFi 6/5GHz)', icon: '/boards/esp32_c5.jpg', group: 'ESP32', description: '高性能 RISC-V SoC，支持 AI 加速。' },
    { id: 'esp32:esp32:esp32c6', name: 'ESP32-C6 (WiFi 6)', icon: '/boards/esp32_c6.png', group: 'ESP32', description: '超低功耗 WiFi 6 SoC。' },
    { id: 'esp32:esp32:esp32c3', name: 'ESP32-C3', icon: '/boards/esp32_c3.png', group: 'ESP32', description: '高性价比 RISC-V 芯片。' },
    { id: 'esp32:esp32:esp32s3', name: 'ESP32-S3', icon: '/boards/esp32_s3.png', group: 'ESP32', description: 'AI 与 IoT 强劲动力。' },
    { id: 'esp32:esp32:esp32s2', name: 'ESP32-S2', icon: '/boards/esp32_s2.png', group: 'ESP32', description: '标准安全 IoT 芯片。' },
    { id: 'esp32:esp32:esp32', name: 'ESP32 Dev Module', icon: '/boards/esp32.jpg', group: 'ESP32', description: '通用 Wi-Fi + 蓝牙 SoC。' },

    // AVR Series
    { id: 'arduino:avr:uno', name: 'Arduino Uno', icon: '/boards/arduino_uno.webp', group: 'AVR', description: '经典入门开发板。' },
    { id: 'arduino:avr:nano', name: 'Arduino Nano', icon: '/boards/arduino_nano.webp', group: 'AVR', description: '面包板友好的经典款。' },
    { id: 'arduino:avr:mega', name: 'Arduino Mega 2560', icon: '/boards/arduino_mega.webp', group: 'AVR', description: '更多引脚，更大内存。' },
    { id: 'arduino:avr:diecimila', name: 'Arduino Duemilanove', icon: '/boards/arduino_duemilanove.jpg', group: 'AVR', description: '复古经典款。' },
];

export const getBoardName = (fqbn: string) => BOARDS.find(b => b.id === fqbn)?.name || fqbn;
export const getBoardIcon = (fqbn: string) => BOARDS.find(b => b.id === fqbn)?.icon || '📦';
export const getBoardGroup = (fqbn: string) => BOARDS.find(b => b.id === fqbn)?.group || 'Other';
