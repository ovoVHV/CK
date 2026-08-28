import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./compile_issue_cards.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'compile_issue_cards.ts',
    reportDiagnostics: true,
});

const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'compile_issue_cards.ts should transpile without syntax errors');

const { analyzeCompileIssues } = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

test('turns a missing header into a prefilled library-search action', () => {
    const issues = analyzeCompileIssues({
        log: 'C:/Temp/sketch/sketch.ino:42:10: fatal error: Adafruit_BME280.h: No such file or directory',
        operation: 'compile',
        fqbn: 'arduino:avr:nano',
    });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].id, 'missing-header');
    assert.equal(issues[0].certainty, 'certain');
    assert.equal(issues[0].sourceLine, 42);
    assert.deepEqual(issues[0].action, {
        kind: 'library_search',
        label: '搜索 Adafruit_BME280.h',
        query: 'Adafruit_BME280.h',
    });
});

test('supports clang-style quoted header errors', () => {
    const issues = analyzeCompileIssues({
        log: "sketch.ino:7:9: fatal error: 'PrivateSensor.h' file not found",
    });
    assert.equal(issues[0].id, 'missing-header');
    assert.equal(issues[0].action.query, 'PrivateSensor.h');
});

test('reports an inaccessible COM port without also suggesting ESP BOOT mode', () => {
    const issues = analyzeCompileIssues({
        log: 'avrdude: ser_open(): can\'t open device "\\\\.\\COM5": Access is denied.',
        operation: 'upload',
        fqbn: 'esp32:esp32:esp32s3',
        activePort: 'COM5',
    });

    assert.deepEqual(issues.map(issue => issue.id), ['serial-port-unavailable']);
    assert.equal(issues[0].action.kind, 'rescan_ports');
    assert.equal(issues[0].action.port, 'COM5');
});

test('recognizes Chinese serial context without relying on ASCII word boundaries', () => {
    const issues = analyzeCompileIssues({
        log: '上传失败：串口设备拒绝访问，请关闭占用程序。',
        operation: 'upload',
    });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].id, 'serial-port-unavailable');
    assert.equal(issues[0].action.kind, 'rescan_ports');
});

test('reports deterministic ESP handshake failures with board-specific help', () => {
    const issues = analyzeCompileIssues({
        log: 'A fatal error occurred: Failed to connect to ESP32-S3: No serial data received.',
        operation: 'upload',
        fqbn: 'esp32:esp32:esp32s3',
        activePort: 'COM7',
    });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].id, 'esp-upload-connect-failed');
    assert.deepEqual(issues[0].action, {
        kind: 'show_boot_help',
        label: '查看 BOOT 操作步骤',
        boardFamily: 'esp32',
    });
});

test('turns a physical Flash mismatch into a pre-write board configuration action', () => {
    const [issue] = analyzeCompileIssues({
        operation: 'upload',
        fqbn: 'esp32:esp32:esp32s3:FlashSize=32M',
        log: 'Physical Flash mismatch: configured/resolved 32MB (32MB) exceeds detected 16MB; upload blocked before writing Flash',
    });

    assert.equal(issue.id, 'physical-flash-mismatch');
    assert.equal(issue.certainty, 'certain');
    assert.equal(issue.title, 'Flash 配置大于开发板实测容量');
    assert.deepEqual(issue.details, ['32MB', '16MB']);
    assert.equal(issue.action.kind, 'open_board_config');
});

test('recognizes linker overflow but ignores normal size summaries', () => {
    const overflow = analyzeCompileIssues({
        log: "region `iram0_0_seg' overflowed by 1248 bytes\ncollect2: error: ld returned 1 exit status",
    });
    assert.equal(overflow[0].id, 'firmware-too-large');
    assert.match(overflow[0].title, /IRAM/);
    assert.match(overflow[0].summary, /不等同于 Flash 分区过小/);
    assert.equal(overflow[0].action.kind, 'show_resources');
    assert.equal(overflow[0].action.label, '查看最近成功资源基线');

    const flashOverflow = analyzeCompileIssues({
        log: 'Sketch too big; see https://support.arduino.cc/',
    });
    assert.match(flashOverflow[0].title, /Flash 分区/);
    assert.match(flashOverflow[0].summary, /最近一次成功编译的基线/);

    const regionCases = [
        ["region `dram0_0_seg' overflowed by 512 bytes", /DRAM/],
        ["section '.data' will not fit in region 'RAM'", /RAM/],
        ["section '.bss' overflowed by 64 bytes", /RAM/],
    ];
    for (const [log, expectedTitle] of regionCases) {
        const issue = analyzeCompileIssues({ log })[0];
        assert.ok(issue, `expected a capacity issue for: ${log}`);
        assert.match(issue.title, expectedTitle);
        assert.doesNotMatch(issue.title, /Flash/);
    }

    const normal = analyzeCompileIssues({
        log: 'Sketch uses 969252 bytes (73%) of program storage space. Maximum is 1310720 bytes.',
    });
    assert.deepEqual(normal, []);
});

test('shows concrete environment changes without claiming they caused the failure', () => {
    const issues = analyzeCompileIssues({
        log: 'exit status 1',
        environmentChanges: [
            '板卡或编译选项已变化',
            '核心版本由 2.0.17 变为 3.3.0',
            '板卡或编译选项已变化',
        ],
    });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].id, 'board-config-changed');
    assert.equal(issues[0].severity, 'notice');
    assert.deepEqual(issues[0].details, [
        '板卡或编译选项已变化',
        '核心版本由 2.0.17 变为 3.3.0',
    ]);
});

test('explains a common missing-semicolon diagnostic in Chinese while preserving source evidence', () => {
    const unknown = analyzeCompileIssues({
        log: "sketch.ino:9:2: error: expected ';' before '}' token",
    });
    assert.equal(unknown.length, 1);
    assert.equal(unknown[0].id, 'compiler-diagnostic');
    assert.equal(unknown[0].title, '前一段生成代码不完整');
    assert.match(unknown[0].summary, /期待分号/);
    assert.match(unknown[0].suggestion, /定位积木/);
    assert.equal(unknown[0].sourceFile, 'sketch.ino');
    assert.equal(unknown[0].sourceLine, 9);
    assert.equal(unknown[0].sourceColumn, 2);
    assert.equal(unknown[0].action, undefined);
});

test('extracts the user-reported AVR variable assignment diagnostic from a dynamic CK sketch path', () => {
    const path = 'C:\\Users\\builder\\AppData\\Local\\Temp\\CK_Builds\\sketch_arduino_avr_mega_rel\\sketch_arduino_avr_mega_rel.ino';
    const [issue] = analyzeCompileIssues({
        log: [
            `${path}: In function 'void loop()':`,
            `${path}:9:3: error: 'variable' was not declared in this scope`,
            '  variable = 0; /* @ck-source-begin:v1:abcdef */',
            '  ^~~~~~~~',
        ].join('\n'),
    });

    assert.equal(issue.id, 'compiler-diagnostic');
    assert.equal(issue.sourceFile, path);
    assert.equal(issue.sourceLine, 9);
    assert.equal(issue.sourceColumn, 3);
    assert.equal(issue.title, '名称 variable 尚未声明');
    assert.match(issue.summary, /找不到它的创建或声明/);
    assert.match(issue.suggestion, /变量积木/);
    assert.match(issue.evidence, /was not declared in this scope/);
});

test('explains a missing class member as a likely library or Core API mismatch', () => {
    const [issue] = analyzeCompileIssues({
        log: "sketch.ino:5:8: error: 'class WiFiClass' has no member named 'mode'",
    });
    assert.equal(issue.title, '当前库没有 mode 功能');
    assert.match(issue.summary, /同名库|API/);
    assert.match(issue.suggestion, /Multiple libraries were found/);
});

test('unknown located diagnostics receive an honest Chinese fallback instead of raw English summary', () => {
    const [issue] = analyzeCompileIssues({
        log: 'sketch.ino:7:4: error: vendor-specific opaque diagnostic 73',
    });
    assert.equal(issue.title, '源码编译错误');
    assert.match(issue.summary, /暂未把该英文诊断归入已知类型/);
    assert.match(issue.evidence, /vendor-specific opaque diagnostic 73/);
});

test('keeps several distinct located compiler errors but deduplicates repeated wrapper output', () => {
    const first = "sketch.ino:9:3: error: 'variable' was not declared in this scope";
    const second = "sketch.ino:12:5: error: expected ';' before '}' token";
    const issues = analyzeCompileIssues({ log: [first, first, second].join('\n') });
    assert.equal(issues.length, 2);
    assert.deepEqual(issues.map(issue => issue.sourceLine), [9, 12]);
});

test('does not invent a card without compiler location evidence or for unrelated access denial', () => {
    assert.deepEqual(analyzeCompileIssues({ log: 'exit status 1' }), []);

    const unrelated = analyzeCompileIssues({
        log: 'Failed to read C:/private/config.json: Access is denied',
        operation: 'upload',
    });
    assert.deepEqual(unrelated, []);
});
