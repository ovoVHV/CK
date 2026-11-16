import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./serial_data_parser.ts', import.meta.url);
const identitySourcePath = new URL('../services/serial_field_identity.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const identitySource = await readFile(identitySourcePath, 'utf8');
const identityTranspiled = ts.transpileModule(identitySource, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'serial_field_identity.ts',
    reportDiagnostics: true,
});
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'serial_data_parser.ts',
    reportDiagnostics: true,
});

const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'serial_data_parser.ts should transpile without syntax errors');
assert.deepEqual(
    (identityTranspiled.diagnostics || []).filter(
        diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
    ),
    [],
    'serial_field_identity.ts should transpile without syntax errors',
);

const identityModuleUrl = `data:text/javascript;base64,${Buffer.from(identityTranspiled.outputText).toString('base64')}`;
const parserOutput = transpiled.outputText.replaceAll('../services/serial_field_identity', identityModuleUrl);

const parserModule = await import(
    `data:text/javascript;base64,${Buffer.from(parserOutput).toString('base64')}`
);

const {
    SerialLineStreamDecoder,
    SerialFieldStabilityTracker,
    createGeneratedSerialField,
    createSerialParserState,
    createSourceSerialField,
    getSerialFieldDisplayLabel,
    normalizeSerialRecordIdentity,
    parseStructuredSerialLine,
} = parserModule;

const expectedRecord = (format, entries) => ({
    values: Object.fromEntries(entries.map(([field, value]) => [field.fieldId, value])),
    fields: Object.fromEntries(entries.map(([field]) => [field.fieldId, field])),
    format,
});

const encoder = new TextEncoder();

const fragmentBytes = (text, pattern) => {
    const bytes = encoder.encode(text);
    const chunks = [];
    let offset = 0;
    let patternIndex = 0;
    while (offset < bytes.length) {
        const end = Math.min(bytes.length, offset + pattern[patternIndex % pattern.length]);
        chunks.push(Array.from(bytes.slice(offset, end)));
        offset = end;
        patternIndex += 1;
    }
    return chunks;
};

const parseFragments = (text, pattern) => {
    const stream = new SerialLineStreamDecoder();
    const state = createSerialParserState();
    const records = [];
    const lines = [];
    for (const chunk of fragmentBytes(text, pattern)) {
        const batch = stream.push(chunk);
        lines.push(...batch.lines);
        for (const line of batch.lines) {
            const record = parseStructuredSerialLine(line, state);
            if (record) records.push(record);
        }
    }
    return { lines, records, pending: stream.getPendingCharacterCount() };
};

const baudCases = [
    [115_200, [1, 2, 7, 3, 11]],
    [460_800, [13, 1, 5, 29, 2]],
    [921_600, [31, 2, 3, 47, 1]],
    [2_000_000, [64, 1, 127, 5, 3]],
];

for (const [baudRate, pattern] of baudCases) {
    test(`${baudRate} baud simulation preserves framing, UTF-8 and telemetry fields`, () => {
        const source = [
            '42\n',
            '1 2\r\n',
            '温度 23.5\n',
            '湿度=64\r',
            'x,y\n',
            '1,2\n',
        ].join('').repeat(128);
        const { records, pending } = parseFragments(source, pattern);

        assert.equal(pending, 0);
        assert.equal(records.length, 5 * 128);
        assert.deepEqual(records.slice(0, 5), [
            expectedRecord('numbers', [[createGeneratedSerialField(1), 42]]),
            expectedRecord('numbers', [
                [createGeneratedSerialField(1), 1],
                [createGeneratedSerialField(2), 2],
            ]),
            expectedRecord('key-value', [[createSourceSerialField('温度'), 23.5]]),
            expectedRecord('key-value', [[createSourceSerialField('湿度'), 64]]),
            expectedRecord('csv', [
                [createSourceSerialField('x'), 1],
                [createSourceSerialField('y'), 2],
            ]),
        ]);
        assert.deepEqual(records.slice(-5), records.slice(0, 5));
    });
}

test('does not treat a read, UTF-8 prefix, or half packet as a complete line', () => {
    const stream = new SerialLineStreamDecoder();
    const bytes = encoder.encode('温度=24\n下一行=25\n');
    const first = stream.push(Array.from(bytes.slice(0, 1)));
    const second = stream.push(Array.from(bytes.slice(1, 5)));
    const third = stream.push(Array.from(bytes.slice(5)));

    assert.deepEqual(first.lines, []);
    assert.deepEqual(second.lines, []);
    assert.deepEqual(third.lines, ['温度=24', '下一行=25']);
    assert.doesNotMatch(first.decodedText + second.decodedText + third.decodedText, /�/);
});

test('keeps CRLF split across events as one delimiter and preserves multi-line packet order', () => {
    const stream = new SerialLineStreamDecoder();
    assert.deepEqual(stream.push(Array.from(encoder.encode('a=1\r'))).lines, ['a=1']);
    assert.deepEqual(
        stream.push(Array.from(encoder.encode('\nb=2\nc=3\r\nd=4\n'))).lines,
        ['b=2', 'c=3', 'd=4'],
    );
});

test('resynchronizes at the next delimiter instead of parsing a session that begins mid-line', () => {
    const stream = new SerialLineStreamDecoder();
    const state = createSerialParserState();
    stream.resynchronizeAtNextDelimiter();

    const first = stream.push(Array.from(encoder.encode('idu:59\r')));
    const second = stream.push(Array.from(encoder.encode('\nshidu:60\n')));

    assert.deepEqual(first.lines, []);
    assert.equal(first.discardedOversizeLines, 0);
    assert.deepEqual(second.lines, ['shidu:60']);
    assert.deepEqual(
        parseStructuredSerialLine(second.lines[0], state),
        expectedRecord('key-value', [[createSourceSerialField('shidu'), 60]]),
    );
});

test('resynchronization discards an old UTF-8 prefix and recovers on the following full line', () => {
    const stream = new SerialLineStreamDecoder();
    const bytes = encoder.encode('温度=24\n湿度=60\n');
    stream.push(Array.from(bytes.slice(0, 1)));
    stream.resynchronizeAtNextDelimiter();

    const recovered = stream.push(Array.from(bytes.slice(1)));
    assert.deepEqual(recovered.lines, ['湿度=60']);
    assert.equal(recovered.discardedOversizeLines, 0);
});

test('continuous no-newline overflow is discarded as one record, never parsed from its tail', () => {
    const stream = new SerialLineStreamDecoder(64);
    const state = createSerialParserState();

    const fragments = fragmentBytes(`bad-prefix=${'9'.repeat(300)}`, [1, 3, 2, 5]);
    for (const fragment of fragments) {
        assert.deepEqual(stream.push(fragment).lines, []);
    }
    const boundary = stream.push(Array.from(encoder.encode('\n')));
    assert.equal(boundary.discardedOversizeLines, 1);
    assert.deepEqual(boundary.lines, []);

    const recovered = stream.push(Array.from(encoder.encode('ok=7\n')));
    assert.deepEqual(recovered.lines, ['ok=7']);
    assert.deepEqual(
        parseStructuredSerialLine(recovered.lines[0], state),
        expectedRecord('key-value', [[createSourceSerialField('ok'), 7]]),
    );
});

test('Chinese labels printed immediately before a value remain one deterministic field', () => {
    const state = createSerialParserState();
    assert.deepEqual(
        parseStructuredSerialLine('温度24.5', state),
        expectedRecord('key-value', [[createSourceSerialField('温度'), 24.5]]),
    );
    assert.equal(parseStructuredSerialLine('error404', state), null);
});

test('key=value parsing refuses to mine a valid-looking field from a damaged log line', () => {
    const state = createSerialParserState();
    assert.equal(parseStructuredSerialLine('damaged-prefix shidu:42', state), null);
    assert.equal(parseStructuredSerialLine('shidu:42 trailing-garbage', state), null);
    assert.deepEqual(
        parseStructuredSerialLine('shidu:42, humidity=51', state),
        expectedRecord('key-value', [
            [createSourceSerialField('shidu'), 42],
            [createSourceSerialField('humidity'), 51],
        ]),
    );
});

for (const [baudRate, pattern] of baudCases) {
    test(`${baudRate} baud stability gate rejects one-off label fragments and confirms real fields`, () => {
        const source = [
            '度:1\n',
            'idu:2\n',
            'hidu:3\n',
            'du:4\n',
            'sdu:5\n',
            'shidu:60\n',
            'shidu:61\n',
            'shidu:62\n',
            '温度24\n',
            '温度25\n',
            '温度26\n',
            'x,y\n',
            '1,2\n',
            '3,4\n',
            '5,6\n',
        ].join('');
        const { records, pending } = parseFragments(source, pattern);
        const tracker = new SerialFieldStabilityTracker();
        const confirmed = new Set();
        const newlyConfirmedInOrder = [];

        for (const record of records) {
            const update = tracker.observe(record);
            for (const fieldId of update.confirmedFieldIds) confirmed.add(fieldId);
            newlyConfirmedInOrder.push(...update.newlyConfirmedFieldIds);
        }

        assert.equal(pending, 0);
        assert.deepEqual(newlyConfirmedInOrder, ['shidu', '温度', 'x', 'y'].map(
            label => createSourceSerialField(label).fieldId,
        ));
        assert.deepEqual(Array.from(confirmed), ['shidu', '温度', 'x', 'y'].map(
            label => createSourceSerialField(label).fieldId,
        ));
        for (const fragment of ['度', 'idu', 'hidu', 'du', 'sdu']) {
            assert.equal(tracker.isConfirmed(fragment), false);
        }
    });
}

test('generated numeric fields are deterministic and do not wait for label confirmation', () => {
    const tracker = new SerialFieldStabilityTracker();
    const first = createGeneratedSerialField(1);
    const second = createGeneratedSerialField(2);
    const update = tracker.observe({
        values: { [first.fieldId]: 7, [second.fieldId]: 8 },
        fields: { [first.fieldId]: first, [second.fieldId]: second },
        format: 'numbers',
    });
    assert.deepEqual(update.newlyConfirmedFieldIds, [first.fieldId, second.fieldId]);
    assert.deepEqual(update.confirmedFieldIds, [first.fieldId, second.fieldId]);
});

test('locale changes only presentation labels and never generated field identity', () => {
    const state = createSerialParserState();
    const record = parseStructuredSerialLine('7 8', state);
    assert.ok(record);
    const before = structuredClone(record);
    const ids = Object.keys(record.values);

    assert.deepEqual(ids, ['serial.generated.1', 'serial.generated.2']);
    assert.ok(ids.every(fieldId => /^[\x00-\x7F]+$/.test(fieldId)));
    assert.deepEqual(
        ids.map(fieldId => getSerialFieldDisplayLabel(record.fields[fieldId], 'zh-CN')),
        ['数据 1', '数据 2'],
    );
    assert.deepEqual(
        ids.map(fieldId => getSerialFieldDisplayLabel(record.fields[fieldId], 'en-US')),
        ['Data 1', 'Data 2'],
    );
    assert.deepEqual(record, before, 'resolving another locale must not rewrite retained records');
});

test('legacy label-keyed records migrate to stable identity without mutating old data', () => {
    const legacy = { values: { '数据 1': 7, 温度: 24 }, format: 'numbers' };
    const before = structuredClone(legacy);
    const normalized = normalizeSerialRecordIdentity(legacy);

    assert.equal(normalized.values['serial.generated.1'], 7);
    assert.equal(normalized.values[createSourceSerialField('温度').fieldId], 24);
    assert.deepEqual(legacy, before);
});

test('field stability resynchronization forgets partial candidates but preserves proven channels', () => {
    const tracker = new SerialFieldStabilityTracker(3, 16);
    tracker.observe({ values: { shidu: 1 }, format: 'key-value' });
    tracker.observe({ values: { shidu: 2 }, format: 'key-value' });
    tracker.observe({ values: { shidu: 3 }, format: 'key-value' });
    tracker.observe({ values: { idu: 4 }, format: 'key-value' });

    tracker.resynchronize();
    assert.equal(tracker.isConfirmed('shidu'), true);
    tracker.observe({ values: { idu: 5 }, format: 'key-value' });
    tracker.observe({ values: { idu: 6 }, format: 'key-value' });
    assert.equal(tracker.isConfirmed('idu'), false);
});
