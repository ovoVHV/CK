/** Runtime shape recorded by CK's declarative loader, never inferred from a block name. */
export interface AnalysisBlock {
    type: string;
    getFieldValue?: (name: string) => unknown;
    getInputTargetBlock?: (name: string) => AnalysisBlock | null;
}

type CompatLiteral = { kind: 'number' | 'dropdown'; field: string };
const convertedFields = new WeakMap<object, ReadonlySet<string>>();
const literalFields = new WeakMap<object, CompatLiteral>();

/** Bind after successful registration so restored and newly created instances agree. */
export function bindCompatAnalysis(
    definition: { init: (this: AnalysisBlock) => void },
    fields: readonly string[],
    literal?: CompatLiteral,
): void {
    const initialize = definition.init;
    const names = new Set(fields);
    definition.init = function () {
        initialize.call(this);
        convertedFields.set(this, names);
        if (literal) literalFields.set(this, { ...literal });
    };
}

export function isConvertedField(block: AnalysisBlock, name: string): boolean {
    return convertedFields.get(block)?.has(name) === true;
}

export function isDeclarativeAnalysisBlock(block: AnalysisBlock): boolean {
    return convertedFields.has(block) && !literalFields.has(block);
}

export function compatLiteralField(block: AnalysisBlock): CompatLiteral | undefined {
    return literalFields.get(block);
}

/** Only literal blocks; no generator calls, variable chasing or expression evaluation. */
export function staticInputValue(input: AnalysisBlock | null): unknown {
    if (!input) return undefined;
    const compat = compatLiteralField(input);
    if (compat) return input.getFieldValue?.(compat.field);
    switch (input.type) {
        case 'math_number': return input.getFieldValue?.('NUM');
        case 'text': return input.getFieldValue?.('TEXT');
        case 'board_pin_selector': return input.getFieldValue?.('PIN');
        case 'logic_boolean': {
            const value = input.getFieldValue?.('BOOL');
            return value === 'TRUE' ? true : value === 'FALSE' ? false : undefined;
        }
        default: return undefined;
    }
}
