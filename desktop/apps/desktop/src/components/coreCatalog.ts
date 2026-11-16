export interface CoreDefinition {
    name: string;
    id: string;
    recommendedVersion: string;
    accelerationVersions?: string[];
    index_url: string;
    mirrorIndexUrl?: string;
    descriptionKey: string;
}

export const AVAILABLE_CORES: CoreDefinition[] = [
    { name: 'Arduino AVR', id: 'arduino:avr', recommendedVersion: '1.8.6', accelerationVersions: ['1.8.6', '1.8.7', '1.8.8'],
      index_url: 'https://downloads.arduino.cc/packages/package_index.json', descriptionKey: 'core.description.avr' },
    { name: 'ESP32 (Espressif)', id: 'esp32:esp32', recommendedVersion: '3.3.6-cn', accelerationVersions: ['3.3.6-cn', '3.3.6'],
      index_url: 'https://espressif.github.io/arduino-esp32/package_esp32_index.json',
      mirrorIndexUrl: 'https://jihulab.com/esp-mirror/espressif/arduino-esp32/-/raw/gh-pages/package_esp32_index_cn.json', descriptionKey: 'core.description.esp32' },
    { name: 'STM32 (STMicroelectronics)', id: 'STMicroelectronics:stm32', recommendedVersion: '2.12.0',
      index_url: 'https://github.com/stm32duino/BoardManagerFiles/raw/main/package_stmicroelectronics_index.json', descriptionKey: 'core.description.stm32' },
    { name: 'RP2040 (Raspberry Pi)', id: 'rp2040:rp2040', recommendedVersion: '3.7.2',
      index_url: 'https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json', descriptionKey: 'core.description.rp2040' },
];

export interface CoreVersions {
    core_id: string;
    index_url: string;
    versions: string[];
    latest: string | null;
    checked_at: number;
}
export interface CatalogState { data?: CoreVersions; loading?: boolean; error?: string }
export type CatalogStates = Record<string, CatalogState>;
export const sourceKey = (coreId: string, url: string) => JSON.stringify([coreId, url]);
export const catalogSources = (core: CoreDefinition, customUrl?: string): string[] =>
    customUrl?.trim() ? [customUrl.trim()] : [core.index_url, ...(core.mirrorIndexUrl ? [core.mirrorIndexUrl] : [])];

export function catalogFor(core: CoreDefinition, states: CatalogStates, customUrl?: string) {
    const sources = catalogSources(core, customUrl);
    const entries: { version: string; indexUrl: string }[] = [];
    const seen = new Set<string>();
    let latest: string | undefined;
    for (const url of sources) {
        const data = states[sourceKey(core.id, url)]?.data;
        if (!data || data.core_id !== core.id || data.index_url !== url) continue;
        latest ||= data.latest || undefined;
        for (const version of data.versions) {
            if (seen.has(version)) continue;
            entries.push({ version, indexUrl: url });
            seen.add(version);
        }
    }
    // Sources already sort by SemVer. Keep official entries before mirror variants.
    const recommended = entries.find(e => e.version === core.recommendedVersion)?.version;
    const accelerated = entries.find(e => core.accelerationVersions?.includes(e.version))?.version;
    const defaultVersion = recommended || accelerated || (core.accelerationVersions ? '' : latest) || '';
    return { entries, latest, sources, defaultVersion };
}

export function selectedVersion(selected: string | undefined, catalog: ReturnType<typeof catalogFor>): string {
    if (selected === 'custom' || catalog.entries.some(e => e.version === selected)) return selected!;
    return catalog.defaultVersion;
}

export function installChoice(core: CoreDefinition, catalog: ReturnType<typeof catalogFor>, selected: string, manual: string, customUrl?: string) {
    const version = selected === 'custom' ? manual.trim() : selected;
    if (!version) throw new Error('Select a version or enter one manually');
    const entry = catalog.entries.find(e => e.version === version);
    if (selected !== 'custom' && !entry) throw new Error('Selected version is no longer present in this source');
    const indexUrl = customUrl?.trim() || entry?.indexUrl ||
        (version.endsWith('-cn') && core.mirrorIndexUrl ? core.mirrorIndexUrl : core.index_url);
    return { version, indexUrl };
}
