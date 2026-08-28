export interface BlockCompatibilityContext {
    fqbn: string;
    coreId: string;
    coreVersion: string;
}

export interface BlockCompatibilityDecision {
    type: string;
    compatible: boolean;
    rule: 'portable-arduino-api' | 'wifi' | 'wifi6' | 'serial-pins' | 'core-version';
    reason: string;
}

const versionParts = (version: string): number[] => String(version || '')
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));

export const versionAtLeast = (actual: string, minimum: string): boolean => {
    if (!String(actual || '').trim()) return false;
    const left = versionParts(actual);
    const right = versionParts(minimum);
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        const a = left[index] || 0;
        const b = right[index] || 0;
        if (a !== b) return a > b;
    }
    return true;
};

export const compatibilityContext = (fqbn: string, coreVersion = ''): BlockCompatibilityContext => {
    const normalized = String(fqbn || '').trim().toLowerCase();
    const parts = normalized.split(':');
    return {
        fqbn: normalized,
        coreId: parts.length >= 2 ? `${parts[0]}:${parts[1]}` : '',
        coreVersion: String(coreVersion || '').trim(),
    };
};

const WIFI_BLOCKS = new Set([
    'wifi_connect',
    'wifi_wait_until_ready',
    'wifi_local_ip',
    'wifi_get_rssi',
    'wifi_get_channel',
]);

const supportsWifi = (context: BlockCompatibilityContext): boolean => {
    if (context.coreId === 'esp8266:esp8266') {
        return !context.coreVersion || versionAtLeast(context.coreVersion, '2.4.0');
    }
    if (context.coreId !== 'esp32:esp32') return false;
    if (context.fqbn.includes('esp32h2') || context.fqbn.includes('esp32p4')) return false;
    return !context.coreVersion || versionAtLeast(context.coreVersion, '1.0.0');
};

export const getBlockCompatibility = (
    type: string,
    context: BlockCompatibilityContext,
): BlockCompatibilityDecision => {
    if (WIFI_BLOCKS.has(type)) {
        const compatible = supportsWifi(context);
        return {
            type,
            compatible,
            rule: 'wifi',
            reason: compatible ? '当前核心提供受支持的 Wi-Fi API' : '当前板卡或核心版本不提供兼容的 Wi-Fi API',
        };
    }

    if (type === 'wifi_set_protocol') {
        const isC5 = context.fqbn.includes('esp32c5');
        const isC6 = context.fqbn.includes('esp32c6');
        const minimum = isC5 ? '3.3.0' : '3.0.0';
        const compatible = context.coreId === 'esp32:esp32'
            && (isC5 || isC6)
            && (!context.coreVersion || versionAtLeast(context.coreVersion, minimum));
        return {
            type,
            compatible,
            rule: 'wifi6',
            reason: compatible ? `当前 ESP32 核心满足 ${minimum}+` : 'Wi-Fi 6 协议积木仅用于受支持核心版本的 ESP32-C5/C6',
        };
    }

    if (type === 'serial_setup_with_pins') {
        const compatible = context.coreId === 'esp32:esp32'
            && (!context.coreVersion || versionAtLeast(context.coreVersion, '1.0.0'));
        return {
            type,
            compatible,
            rule: 'serial-pins',
            reason: compatible ? 'ESP32 核心支持自定义 UART RX/TX 引脚' : '当前核心的 HardwareSerial.begin 不支持这组引脚参数',
        };
    }

    if (type === 'io_pulse_in_long' && context.coreId === 'arduino:avr') {
        const compatible = !context.coreVersion || versionAtLeast(context.coreVersion, '1.6.12');
        return {
            type,
            compatible,
            rule: 'core-version',
            reason: compatible ? 'Arduino AVR 核心提供 pulseInLong' : 'Arduino AVR 核心版本过旧，缺少 pulseInLong',
        };
    }

    return {
        type,
        compatible: true,
        rule: 'portable-arduino-api',
        reason: '使用当前支持矩阵内的标准 Arduino/C++ API',
    };
};

export const filterToolboxForCompatibility = (
    toolboxXml: string,
    fqbn: string,
    coreVersion = '',
): { xml: string; decisions: BlockCompatibilityDecision[] } => {
    if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') {
        return { xml: toolboxXml, decisions: [] };
    }

    const documentNode = new DOMParser().parseFromString(toolboxXml, 'text/xml');
    if (documentNode.querySelector('parsererror')) {
        return { xml: toolboxXml, decisions: [] };
    }

    const context = compatibilityContext(fqbn, coreVersion);
    const decisionByType = new Map<string, BlockCompatibilityDecision>();
    const elements = Array.from(documentNode.querySelectorAll('block[type], shadow[type]'));
    for (const element of elements) {
        const type = element.getAttribute('type') || '';
        if (!type) continue;
        const decision = decisionByType.get(type) || getBlockCompatibility(type, context);
        decisionByType.set(type, decision);
        if (!decision.compatible) element.remove();
    }

    return {
        xml: new XMLSerializer().serializeToString(documentNode),
        decisions: Array.from(decisionByType.values()),
    };
};
