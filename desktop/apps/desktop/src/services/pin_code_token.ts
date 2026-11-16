const DECIMAL_PIN_TOKEN = /^(?:0|[1-9][0-9]*)$/;
const IDENTIFIER_PIN_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_PIN_TOKEN_LENGTH = 128;

/** UI-only sentinel; it is never a valid board declaration or C++ pin token. */
export const UNDECLARED_PIN_CODE_TOKEN = '__CK_PIN_UNDECLARED__';

/**
 * A pin value is emitted into generated C/C++ as a single token. Accept only
 * an unambiguous non-negative decimal integer or one C/C++ identifier; never
 * accept expressions, punctuation, comments or whitespace-separated text.
 */
export const normalizePinCodeToken = (value: unknown): string => {
    let token = '';
    if (typeof value === 'string') {
        token = value.trim();
    } else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
        token = String(value);
    } else {
        return '';
    }
    if (!token
        || token === UNDECLARED_PIN_CODE_TOKEN
        || token.length > MAX_PIN_TOKEN_LENGTH) return '';
    return DECIMAL_PIN_TOKEN.test(token) || IDENTIFIER_PIN_TOKEN.test(token)
        ? token
        : '';
};

export const isPinCodeToken = (value: unknown): boolean => normalizePinCodeToken(value) !== '';
