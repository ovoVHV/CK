/** Feature availability mirrors the implemented backend, never hardware verification. */
export const projectHealthCapabilities = (fqbn: string) => {
    const [vendor, architecture, board] = String(fqbn || '').trim().split(':');
    const valid = Boolean(vendor && architecture && board);
    const esp32 = valid && vendor.toLowerCase() === 'esp32' && architecture.toLowerCase() === 'esp32';
    // upload_artifact_manifest.rs supports ESP32 flash sets and AVR application HEX.
    const verifiedUploadArtifacts = esp32 || (valid && architecture.toLowerCase() === 'avr');
    return {
        deviceHealth: esp32,
        lastWorkingVersion: verifiedUploadArtifacts,
        dependencyLock: verifiedUploadArtifacts,
    };
};
