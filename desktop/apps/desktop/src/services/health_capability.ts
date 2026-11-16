import { BOARDS } from '../config/boards';
import { projectHealthCapabilities } from './project_health_capabilities';

export type HealthCapability = 'unsupported' | 'partial' | 'available';
export type HealthEvidence = 'none' | 'code-path-verified' | 'hardware-verified';

/** Presentation of coverage and historical validation, not a build gate. */
export function describeHealthCapability(input: {
    fqbn: string;
    coreVersion?: string;
    configuredFlashBytes?: number | null;
    customBoard?: boolean;
    trustedPins?: boolean;
}) {
    const base = input.fqbn.trim().split(':').slice(0, 3).join(':');
    const pins = input.trustedPins ?? (!input.customBoard && BOARDS.some(board => board.fqbn === base && board.pins.length > 0));
    const esp32 = projectHealthCapabilities(input.fqbn).deviceHealth;
    const flash16 = input.configuredFlashBytes != null
        ? input.configuredFlashBytes === 16777216
        : /(?:[:,])FlashSize=16M(?:,|$)/.test(input.fqbn);
    const verified = !input.customBoard && base === 'esp32:esp32:esp32c6'
        && input.coreVersion === '3.3.6' && flash16;
    return {
        engineering: 'available' as HealthCapability,
        pin: (pins ? 'available' : 'unsupported') as HealthCapability,
        device: (esp32 ? 'available' : 'unsupported') as HealthCapability,
        evidence: (verified ? 'hardware-verified' : esp32 ? 'code-path-verified' : 'none') as HealthEvidence,
    };
}
