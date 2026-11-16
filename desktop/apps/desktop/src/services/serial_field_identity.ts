export type SerialPresentationLocale = 'zh-CN' | 'en-US';

export type SerialFieldId = string;

export type SerialFieldDescriptor = {
    fieldId: SerialFieldId;
    kind: 'generated';
    ordinal: number;
} | {
    fieldId: SerialFieldId;
    kind: 'source';
    sourceLabel: string;
};

export type SerialFieldDescriptorMap = Record<SerialFieldId, SerialFieldDescriptor>;

export interface SerialIdentityRecord<TFormat = string> {
    values: Record<SerialFieldId, number>;
    fields?: SerialFieldDescriptorMap;
    format: TFormat;
}

const GENERATED_FIELD_ID_PREFIX = 'serial.generated.';
const SOURCE_FIELD_ID_PREFIX = 'serial.source.';
const GENERATED_FIELD_ID = /^serial\.generated\.([1-9]\d*)$/u;
const SOURCE_FIELD_ID = /^serial\.source\.([0-9a-f]+(?:-[0-9a-f]+)*)$/u;
const LEGACY_GENERATED_FIELD_LABEL = /^数据 ([1-9]\d*)$/u;

const encodeSourceLabel = (label: string): string => Array.from(label)
    .map((character) => character.codePointAt(0)!.toString(16))
    .join('-');

const decodeSourceLabel = (encoded: string): string | null => {
    if (!/^[0-9a-f]+(?:-[0-9a-f]+)*$/u.test(encoded)) return null;
    try {
        return encoded
            .split('-')
            .map((codePoint) => String.fromCodePoint(Number.parseInt(codePoint, 16)))
            .join('');
    } catch {
        return null;
    }
};

export const createGeneratedSerialField = (ordinal: number): SerialFieldDescriptor => {
    if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
        throw new RangeError('Generated serial field ordinal must be a positive integer');
    }
    return {
        fieldId: `${GENERATED_FIELD_ID_PREFIX}${ordinal}`,
        kind: 'generated',
        ordinal,
    };
};

export const createSourceSerialField = (sourceLabel: string): SerialFieldDescriptor => {
    const normalized = sourceLabel.trim().slice(0, 48);
    if (!normalized) throw new RangeError('Source serial field label must not be empty');
    return {
        fieldId: `${SOURCE_FIELD_ID_PREFIX}${encodeSourceLabel(normalized)}`,
        kind: 'source',
        sourceLabel: normalized,
    };
};

/** Resolve a stable descriptor or upgrade a legacy label-keyed field. */
export const describeSerialField = (fieldIdOrLegacyLabel: string): SerialFieldDescriptor => {
    const generated = fieldIdOrLegacyLabel.match(GENERATED_FIELD_ID);
    if (generated) return createGeneratedSerialField(Number(generated[1]));

    const legacyGenerated = fieldIdOrLegacyLabel.match(LEGACY_GENERATED_FIELD_LABEL);
    if (legacyGenerated) return createGeneratedSerialField(Number(legacyGenerated[1]));

    const source = fieldIdOrLegacyLabel.match(SOURCE_FIELD_ID);
    if (source) {
        const sourceLabel = decodeSourceLabel(source[1]);
        if (sourceLabel) return { fieldId: fieldIdOrLegacyLabel, kind: 'source', sourceLabel };
    }

    return createSourceSerialField(fieldIdOrLegacyLabel);
};

export const isStableSerialFieldId = (fieldId: string): boolean => (
    GENERATED_FIELD_ID.test(fieldId) || SOURCE_FIELD_ID.test(fieldId)
);

export const isGeneratedSerialFieldId = (fieldId: string): boolean => GENERATED_FIELD_ID.test(fieldId);

export const resolveSerialPresentationLocale = (locale: string | null | undefined): SerialPresentationLocale => (
    locale?.toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN'
);

export const getSerialFieldDisplayLabel = (
    descriptor: SerialFieldDescriptor,
    locale: SerialPresentationLocale,
): string => {
    if (descriptor.kind === 'source') return descriptor.sourceLabel;
    return locale === 'en-US' ? `Data ${descriptor.ordinal}` : `数据 ${descriptor.ordinal}`;
};

/** Upgrade an old label-keyed record without mutating the caller's data. */
export const normalizeSerialRecordIdentity = <TFormat>(
    record: SerialIdentityRecord<TFormat>,
): Required<SerialIdentityRecord<TFormat>> => {
    const values: Record<SerialFieldId, number> = {};
    const fields: SerialFieldDescriptorMap = {};

    for (const [legacyKey, value] of Object.entries(record.values)) {
        const supplied = record.fields?.[legacyKey];
        const descriptor = supplied || describeSerialField(legacyKey);
        let nextDescriptor = descriptor;
        let duplicate = 2;
        while (Object.prototype.hasOwnProperty.call(values, nextDescriptor.fieldId)) {
            const displayLabel = nextDescriptor.kind === 'source'
                ? nextDescriptor.sourceLabel
                : `Data ${nextDescriptor.ordinal}`;
            nextDescriptor = createSourceSerialField(`${displayLabel} ${duplicate++}`);
        }
        values[nextDescriptor.fieldId] = value;
        fields[nextDescriptor.fieldId] = nextDescriptor;
    }

    return { values, fields, format: record.format };
};
