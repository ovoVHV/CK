import type { BoardPinCapability, BoardPinDropdownOption } from './board_pin_registry';

export type BoardPinTemplateProvider = (
    capability: BoardPinCapability,
) => BoardPinDropdownOption[];

const TEMPLATE_CAPABILITY: Readonly<Record<string, BoardPinCapability>> = Object.freeze({
    '${board.digitalPins}': 'digital',
    '${board.analogPins}': 'analog',
    '${board.pwmPins}': 'pwm',
});

/**
 * Convert exact `options` placeholders to Blockly menu-generator functions.
 * The provider is invoked when the dropdown is opened, so switching between
 * two packages (even with the same FQBN) never leaves stale pin options behind.
 */
export const bindDynamicBoardPinTemplates = (
    value: unknown,
    provider: BoardPinTemplateProvider,
): unknown => {
    if (Array.isArray(value)) {
        return value.map(item => bindDynamicBoardPinTemplates(item, provider));
    }
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
        const capability = key === 'options' && typeof entry === 'string'
            ? TEMPLATE_CAPABILITY[entry]
            : undefined;
        if (capability) {
            return [key, () => provider(capability).map(option => [option[0], option[1]])];
        }
        return [key, bindDynamicBoardPinTemplates(entry, provider)];
    }));
};
