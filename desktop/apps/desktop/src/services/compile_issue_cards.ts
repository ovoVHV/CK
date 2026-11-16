export type CompileIssueSeverity = 'error' | 'warning' | 'notice';
export type CompileIssueCertainty = 'certain' | 'likely';

export type CompileIssueAction =
    | {
        kind: 'library_search';
        label: string;
        query: string;
    }
    | {
        kind: 'rescan_ports';
        label: string;
        port?: string;
    }
    | {
        kind: 'show_boot_help';
        label: string;
        boardFamily: 'esp32' | 'esp8266';
    }
    | {
        kind: 'show_resources';
        label: string;
    }
    | {
        kind: 'open_board_config';
        label: string;
    };

export type CompileIssueId =
    | 'missing-header'
    | 'compiler-diagnostic'
    | 'serial-port-unavailable'
    | 'esp-upload-connect-failed'
    | 'physical-flash-mismatch'
    | 'firmware-too-large'
    | 'board-config-changed';

/** Stable presentation lookup identity; never use translated copy as logic. */
export type CompileIssueExplanationCode =
    | 'compile.missing_header'
    | 'compile.diagnostic.undeclared_symbol'
    | 'compile.diagnostic.unknown_type'
    | 'compile.diagnostic.missing_member'
    | 'compile.diagnostic.redefinition'
    | 'compile.diagnostic.conflicting_declaration'
    | 'compile.diagnostic.no_matching_function'
    | 'compile.diagnostic.argument_count'
    | 'compile.diagnostic.invalid_conversion'
    | 'compile.diagnostic.expected_semicolon'
    | 'compile.diagnostic.incomplete_syntax'
    | 'compile.diagnostic.stray_character'
    | 'compile.diagnostic.generic'
    | 'compile.capacity.iram'
    | 'compile.capacity.dram'
    | 'compile.capacity.ram'
    | 'compile.capacity.flash'
    | 'compile.capacity.target_region'
    | 'build.environment_changed'
    | 'upload.serial_port_unavailable'
    | 'upload.esp_handshake_failed'
    | 'upload.physical_flash_mismatch';

export type CompileIssueExplanationParams = Record<
    string,
    string | number | boolean | null
>;

export interface CompileIssueBlockContext {
    blockId: string;
    blockType: string;
    label: string;
    section: 'setup' | 'loop' | 'definition' | 'expression' | 'unknown';
    sourceLine: number;
    flowLocation: string;
    confidence: 'exact' | 'high';
}

export interface CompileIssueCard {
    id: CompileIssueId;
    severity: CompileIssueSeverity;
    certainty: CompileIssueCertainty;
    title: string;
    summary: string;
    /** Stable key and interpolation data for the CK-authored explanation. */
    explanationCode: CompileIssueExplanationCode;
    explanationParams: CompileIssueExplanationParams;
    /** Verbatim compiler/uploader diagnostic. It is evidence, never locale text. */
    rawDiagnostic: string;
    /** @deprecated Compatibility alias for consumers predating rawDiagnostic. */
    evidence: string;
    sourceLine: number | null;
    sourceFile?: string;
    sourceColumn?: number | null;
    blockContext?: CompileIssueBlockContext;
    details: string[];
    suggestion?: string;
    action?: CompileIssueAction;
}

export interface AnalyzeCompileIssuesInput {
    log: string;
    operation?: 'compile' | 'upload';
    fqbn?: string;
    activePort?: string | null;
    environmentChanges?: string[];
}

const compactEvidence = (value: string): string => {
    const compact = value.replace(/\s+/g, ' ').trim();
    return compact.length > 320 ? `${compact.slice(0, 317)}...` : compact;
};

const rawLineAt = (text: string, index: number): string => {
    const start = Math.max(0, text.lastIndexOf('\n', Math.max(0, index - 1)) + 1);
    const next = text.indexOf('\n', index);
    const end = next < 0 ? text.length : next;
    return text.slice(start, end).replace(/\r$/, '');
};

const diagnosticIdentity = (
    rawDiagnostic: string,
    explanationCode: CompileIssueExplanationCode,
    explanationParams: CompileIssueExplanationParams = {},
) => ({
    explanationCode,
    explanationParams,
    rawDiagnostic,
    // Keep the legacy field during Phase 2A so UI/plugin callers do not break.
    evidence: rawDiagnostic,
});

const sourceLineFromEvidence = (evidence: string): number | null => {
    const match = evidence.match(/(?:\.ino|\.cpp|\.c|\.cc|\.cxx|\.h|\.hpp)[^:\r\n]*:(\d+):(?:\d+:)?/i)
        || evidence.match(/\bline\s+(\d+)\b/i);
    if (!match) return null;
    const line = Number(match[1]);
    return Number.isSafeInteger(line) && line > 0 ? line : null;
};

const basename = (value: string): string => {
    const normalized = value.trim().replace(/^['"<]+|['">]+$/g, '');
    const parts = normalized.split(/[\\/]/);
    return parts[parts.length - 1] || normalized;
};

const findMissingHeader = (log: string): CompileIssueCard | null => {
    const patterns = [
        /fatal\s+error:\s*['"<]?([^'">:\r\n]+\.h)['">]?\s*:\s*(?:no such file or directory|file not found)/i,
        /fatal\s+error:\s*['"<]([^'">\r\n]+\.h)['">]\s*(?:file not found)/i,
    ];
    for (const pattern of patterns) {
        const match = pattern.exec(log);
        if (!match) continue;
        const header = basename(match[1]);
        const rawDiagnostic = rawLineAt(log, match.index);
        return {
            id: 'missing-header',
            severity: 'error',
            certainty: 'certain',
            title: `缺少头文件 ${header}`,
            summary: '编译器确认当前环境找不到这个头文件。可以搜索提供该头文件的 Arduino 库；如果它本应由板卡核心提供，也应检查所选板卡与核心版本。',
            ...diagnosticIdentity(rawDiagnostic, 'compile.missing_header', { header }),
            sourceLine: sourceLineFromEvidence(rawDiagnostic),
            details: [header],
            action: {
                kind: 'library_search',
                label: `搜索 ${header}`,
                query: header,
            },
        };
    }
    return null;
};

interface ParsedCompilerDiagnostic {
    rawDiagnostic: string;
    file: string;
    line: number;
    column: number | null;
    message: string;
}

interface CompilerDiagnosticExplanation {
    code: CompileIssueExplanationCode;
    params: CompileIssueExplanationParams;
    title: string;
    summary: string;
    suggestion: string;
}

const explainCompilerDiagnostic = (message: string): CompilerDiagnosticExplanation => {
    const text = compactEvidence(message);
    let match = text.match(/^['‘`](.+?)['’`] was not declared in this scope/i);
    if (match) {
        const symbol = match[1];
        return {
            code: 'compile.diagnostic.undeclared_symbol',
            params: { symbol },
            title: `名称 ${symbol} 尚未声明`,
            summary: `程序在这里使用了 ${symbol}，但编译器在当前作用域中找不到它的创建或声明。`,
            suggestion: '检查是否先创建了对应变量、函数或对象，并确认名称拼写一致；点击“定位积木”检查该位置附近的变量积木。',
        };
    }

    match = text.match(/^['‘`](.+?)['’`] does not name a type/i);
    if (match) {
        return {
            code: 'compile.diagnostic.unknown_type',
            params: { typeName: match[1] },
            title: `类型 ${match[1]} 无法识别`,
            summary: `编译器不知道 ${match[1]} 是什么类型，通常是缺少声明、头文件未生效或库版本不匹配。`,
            suggestion: '检查相关初始化积木和库依赖是否存在，并确认当前板卡 Core 支持这个类型。',
        };
    }

    match = text.match(/['‘`]class\s+(.+?)['’`] has no member named ['‘`](.+?)['’`]/i);
    if (match) {
        return {
            code: 'compile.diagnostic.missing_member',
            params: { typeName: match[1], member: match[2] },
            title: `当前库没有 ${match[2]} 功能`,
            summary: `${match[1]} 类型中不存在 ${match[2]}。这通常表示同名库被错误选中，或积木使用的 API 与当前库/Core 版本不兼容。`,
            suggestion: '查看完整日志中的 “Multiple libraries were found / Used” 路径，确认使用的是当前板卡 Core 对应的库；再核对库版本。',
        };
    }

    match = text.match(/redefinition of (?:['‘`])?(.+?)(?:['’`])?(?:\s|$)/i);
    if (match) {
        return {
            code: 'compile.diagnostic.redefinition',
            params: { symbol: match[1] },
            title: `重复定义 ${match[1]}`,
            summary: `同一个名称 ${match[1]} 被定义了不止一次。`,
            suggestion: '检查是否重复放置了初始化积木、创建对象积木或同名变量积木，只保留一处定义。',
        };
    }

    if (/conflicting declaration/i.test(text)) {
        return {
            code: 'compile.diagnostic.conflicting_declaration',
            params: {},
            title: '同名声明互相冲突',
            summary: '同一个名称被用不同类型或不同形式声明，编译器无法确定应使用哪一个。',
            suggestion: '检查重复变量、对象或函数积木，统一名称与类型。',
        };
    }

    if (/no matching function for call to/i.test(text)) {
        return {
            code: 'compile.diagnostic.no_matching_function',
            params: {},
            title: '函数参数与库接口不匹配',
            summary: '当前调用提供的参数数量或类型，与这个函数在当前库版本中的定义不一致。',
            suggestion: '检查该积木每个输入值的类型与数量，并核对当前安装库版本的用法。',
        };
    }

    if (/too (?:few|many) arguments to function/i.test(text)) {
        return {
            code: 'compile.diagnostic.argument_count',
            params: {},
            title: '函数参数数量不正确',
            summary: '当前调用传入的参数数量与函数定义要求不一致。',
            suggestion: '检查对应积木是否缺少输入，或当前库版本是否改变了函数参数。',
        };
    }

    if (/invalid conversion from|cannot convert/i.test(text)) {
        return {
            code: 'compile.diagnostic.invalid_conversion',
            params: {},
            title: '数据类型不匹配',
            summary: '当前值的类型不能安全转换成目标参数或变量所要求的类型。',
            suggestion: '检查积木输入槽连接的值类型，例如不要把文本直接接到只接受数字的输入。',
        };
    }

    if (/expected ['‘`]?;['’`]? before/i.test(text)) {
        return {
            code: 'compile.diagnostic.expected_semicolon',
            params: {},
            title: '前一段生成代码不完整',
            summary: '编译器在这里期待分号，真正的问题通常位于这一行或它前面的语句。',
            suggestion: '点击“定位积木”，检查附近文本、表达式和自定义代码积木是否缺少内容或连接不完整。',
        };
    }

    if (/expected .+ before/i.test(text)) {
        return {
            code: 'compile.diagnostic.incomplete_syntax',
            params: {},
            title: '表达式或语句结构不完整',
            summary: '编译器在当前位置期待另一个符号或表达式，当前生成代码的结构没有闭合。',
            suggestion: '检查定位积木附近是否有空输入、自定义文本代码或未完整连接的表达式。',
        };
    }

    if (/stray .+ in program/i.test(text)) {
        return {
            code: 'compile.diagnostic.stray_character',
            params: {},
            title: '代码中出现无法识别的字符',
            summary: '生成源码中包含编译器不能接受的字符，常见于全角符号、错误引号或直接粘贴的特殊字符。',
            suggestion: '检查文本和自定义代码积木，改用英文半角标点并删除不可见字符。',
        };
    }

    return {
        code: 'compile.diagnostic.generic',
        params: {},
        title: '源码编译错误',
        summary: '编译器已经确认这个源码位置存在错误，但 CK 暂未把该英文诊断归入已知类型；原始信息保留在下方。',
        suggestion: '先点击“定位积木”检查该位置的输入、变量和连接；若位置属于库文件，请核对库版本与当前板卡 Core。',
    };
};

const findCompilerDiagnostics = (log: string): CompileIssueCard[] => {
    const lines = String(log || '').split(/\r?\n/);
    const issues: CompileIssueCard[] = [];
    const seen = new Set<string>();
    for (const rawLine of lines) {
        // Require a compiler-owned source location. Bare strings such as
        // "exit status 1" are not enough evidence for an explanatory card.
        const match = rawLine.match(
            /^\s*(.+?\.(?:ino(?:\.cpp)?|c|cc|cpp|cxx|h|hpp)):(\d+)(?::(\d+))?:\s*(?:fatal\s+error|error)\s*:\s*(.+?)\s*$/i,
        );
        if (!match) continue;
        const line = Number(match[2]);
        const column = match[3] ? Number(match[3]) : null;
        if (!Number.isSafeInteger(line) || line < 1) continue;
        if (column != null && (!Number.isSafeInteger(column) || column < 1)) continue;

        const parsed: ParsedCompilerDiagnostic = {
            rawDiagnostic: rawLine,
            file: match[1].trim(),
            line,
            column,
            message: compactEvidence(match[4]),
        };
        const identity = `${parsed.file}\u0000${parsed.line}\u0000${parsed.column ?? ''}\u0000${parsed.message}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        const explanation = explainCompilerDiagnostic(parsed.message);
        issues.push({
            id: 'compiler-diagnostic',
            severity: 'error',
            certainty: 'certain',
            title: explanation.title,
            summary: explanation.summary,
            ...diagnosticIdentity(
                parsed.rawDiagnostic,
                explanation.code,
                explanation.params,
            ),
            sourceLine: parsed.line,
            sourceFile: parsed.file,
            sourceColumn: parsed.column,
            details: [
                parsed.file,
                `第 ${parsed.line} 行${parsed.column == null ? '' : `，第 ${parsed.column} 列`}`,
            ],
            suggestion: explanation.suggestion,
        });
        if (issues.length >= 6) break;
    }
    return issues;
};

const looksLikeSerialContext = (line: string, activePort?: string | null): boolean => {
    if (/\bCOM\d+\b|\\\\\.\\COM\d+|\/dev\/(?:tty|cu\.)/i.test(line)) return true;
    // JavaScript's \b only understands ASCII word characters, so it cannot
    // reliably put a word boundary around Chinese text such as “串口设备”.
    if (/串口/.test(line)) return true;
    if (/\b(?:serial|port|ser_open|avrdude|esptool)\b/i.test(line)) return true;
    return Boolean(activePort && line.toLowerCase().includes(activePort.toLowerCase()));
};

const findSerialPortIssue = (
    log: string,
    activePort?: string | null,
): CompileIssueCard | null => {
    const lines = log.split(/\r?\n/);
    const strongPattern = /(?:could not open port|can't open device|cannot open (?:serial )?port|no device found on|port .+ not found|monitor not open|未选择串口|串口不存在)/i;
    const osErrorPattern = /(?:access is denied|permission denied|resource busy|device or resource busy|系统找不到指定的文件|拒绝访问|资源正忙)/i;

    const line = lines.find((candidate) => strongPattern.test(candidate)
        || (osErrorPattern.test(candidate) && looksLikeSerialContext(candidate, activePort)));
    if (!line) return null;

    const rawDiagnostic = line;
    const portMatch = rawDiagnostic.match(/\bCOM\d+\b|\/dev\/(?:tty|cu\.)[^\s'";]+/i);
    const port = portMatch?.[0] || activePort || undefined;
    return {
        id: 'serial-port-unavailable',
        severity: 'error',
        certainty: 'certain',
        title: port ? `无法使用串口 ${port}` : '无法使用当前串口',
        summary: '上传工具没有成功打开目标串口。先重新扫描端口，并确认串口监视器或其他软件没有占用它。',
        ...diagnosticIdentity(rawDiagnostic, 'upload.serial_port_unavailable', {
            port: port || null,
        }),
        sourceLine: null,
        details: port ? [port] : [],
        action: {
            kind: 'rescan_ports',
            label: '重新扫描串口',
            port,
        },
    };
};

const boardFamilyFromLog = (
    fqbn: string,
    log: string,
): 'esp32' | 'esp8266' | null => {
    if (/^esp8266:esp8266:/i.test(fqbn) || /\besp8266\b/i.test(log)) return 'esp8266';
    if (/^esp32:esp32:/i.test(fqbn) || /\besp32(?:-[a-z0-9]+)?\b/i.test(log)) return 'esp32';
    return null;
};

const findEspUploadIssue = (log: string, fqbn: string): CompileIssueCard | null => {
    const family = boardFamilyFromLog(fqbn, log);
    if (!family) return null;
    const patterns = [
        /failed to connect to esp(?:32|8266)[^\r\n]*/i,
        /a fatal error occurred:\s*failed to connect[^\r\n]*/i,
        /no serial data received[^\r\n]*/i,
        /wrong boot mode detected[^\r\n]*/i,
        /timed out waiting for packet header[^\r\n]*/i,
    ];
    for (const pattern of patterns) {
        const match = pattern.exec(log);
        if (!match) continue;
        const rawDiagnostic = rawLineAt(log, match.index);
        return {
            id: 'esp-upload-connect-failed',
            severity: 'error',
            certainty: 'certain',
            title: `${family.toUpperCase()} 未进入可上传状态`,
            summary: '串口已交给上传工具，但芯片没有完成握手。应展示与当前芯片匹配的 BOOT/RESET 操作步骤，而不是让用户盲目重试。',
            ...diagnosticIdentity(rawDiagnostic, 'upload.esp_handshake_failed', {
                boardFamily: family,
            }),
            sourceLine: null,
            details: [family],
            action: {
                kind: 'show_boot_help',
                label: '查看 BOOT 操作步骤',
                boardFamily: family,
            },
        };
    }
    return null;
};

const findPhysicalFlashMismatch = (log: string): CompileIssueCard | null => {
    const match = /Physical Flash mismatch:\s*configured\/resolved\s+([^\s(]+)\s+\(([^)]+)\)\s+exceeds detected\s+([^;\r\n]+);\s*upload blocked before writing Flash/i.exec(log);
    if (!match) return null;
    const rawDiagnostic = rawLineAt(log, match.index);
    const configured = match[2].trim();
    const detected = match[3].trim();
    return {
        id: 'physical-flash-mismatch',
        severity: 'error',
        certainty: 'certain',
        title: 'Flash 配置大于开发板实测容量',
        summary: `构建配置为 ${configured}，只读探测到实体 Flash 为 ${detected}。CK 已在写入前阻止上传；请在板卡设置中选择匹配的 FlashSize 与分区方案。`,
        ...diagnosticIdentity(rawDiagnostic, 'upload.physical_flash_mismatch', {
            configured,
            detected,
        }),
        sourceLine: null,
        details: [configured, detected],
        action: {
            kind: 'open_board_config',
            label: '调整板卡设置',
        },
    };
};

const findFirmwareSizeIssue = (log: string): CompileIssueCard | null => {
    const patterns = [
        /sketch too big[^\r\n]*/i,
        /text section exceeds available space[^\r\n]*/i,
        /section [`'."]?\.text[^\r\n]*(?:will not fit|overflowed)[^\r\n]*/i,
        /section [`'."]?\.(?:iram|dram|data|bss)[^\r\n]*(?:will not fit|overflowed)[^\r\n]*/i,
        /region [`'"][^`'"]+[`'"][^\r\n]*overflowed by[^\r\n]*/i,
        /program storage space[^\r\n]*(?:exceed|overflow|too (?:large|big))[^\r\n]*/i,
    ];
    for (const pattern of patterns) {
        const match = pattern.exec(log);
        if (!match) continue;
        const rawDiagnostic = rawLineAt(log, match.index);
        const lowerEvidence = rawDiagnostic.toLowerCase();
        const capacity = /iram/.test(lowerEvidence)
            ? {
                code: 'compile.capacity.iram' as const,
                title: '程序超过当前 IRAM 容量',
                summary: '链接器确认指令 RAM（IRAM）容量不足，这不等同于 Flash 分区过小。资源占用面板只能展示最近一次成功编译的 Flash/RAM 基线，请结合错误中的超出字节数检查放入 IRAM 的代码。',
            }
            : /dram/.test(lowerEvidence)
                ? {
                    code: 'compile.capacity.dram' as const,
                    title: '程序超过当前 DRAM 容量',
                    summary: '链接器确认数据 RAM（DRAM）容量不足，这不等同于 Flash 分区过小。资源占用面板只能展示最近一次成功编译的 Flash/RAM 基线，请结合错误中的超出字节数检查全局数据和静态缓冲区。',
                }
                : /(?:^|[^a-z])(?:data|bss)(?:[^a-z]|$)/.test(lowerEvidence)
                    ? {
                        code: 'compile.capacity.ram' as const,
                        title: '程序超过当前 RAM 容量',
                        summary: '链接器确认静态数据区域（data/bss）容量不足，这不等同于 Flash 分区过小。资源占用面板只能展示最近一次成功编译的 Flash/RAM 基线，请结合错误中的超出字节数检查全局变量和静态缓冲区。',
                    }
                    : /(?:sketch too big|text section exceeds|program storage space|\.text\b|flash|irom)/.test(lowerEvidence)
                        ? {
                            code: 'compile.capacity.flash' as const,
                            title: '程序超过当前 Flash 分区容量',
                            summary: '链接器确认程序无法放入当前 Flash 分区。资源占用面板只能展示最近一次成功编译的基线，请结合错误中的超出字节数检查本次代码、依赖增长和当前分区配置。',
                        }
                        : {
                            code: 'compile.capacity.target_region' as const,
                            title: '构建产物超过目标区域容量',
                            summary: '链接器确认某个目标内存区域容量不足。资源占用面板只能展示最近一次成功编译的 Flash/RAM 基线，请结合原始错误中的区域名称和超出字节数继续排查。',
                        };
        return {
            id: 'firmware-too-large',
            severity: 'error',
            certainty: 'certain',
            title: capacity.title,
            summary: capacity.summary,
            ...diagnosticIdentity(rawDiagnostic, capacity.code),
            sourceLine: null,
            details: [],
            action: {
                kind: 'show_resources',
                label: '查看最近成功资源基线',
            },
        };
    }
    return null;
};

const createEnvironmentIssue = (changes: string[]): CompileIssueCard | null => {
    const details = Array.from(new Set(changes.map((item) => item.trim()).filter(Boolean)));
    if (details.length === 0) return null;
    return {
        id: 'board-config-changed',
        severity: 'notice',
        certainty: 'certain',
        title: '板卡或编译配置与上次成功构建不同',
        summary: '配置变化会让旧缓存安全失效，但不代表它一定是本次错误原因。请先核对具体变化，不要直接建议清空全部缓存。',
        ...diagnosticIdentity(
            details.join('；'),
            'build.environment_changed',
            { changeCount: details.length },
        ),
        sourceLine: null,
        details,
        action: {
            kind: 'open_board_config',
            label: '查看板卡设置',
        },
    };
};

/**
 * Convert known Arduino compile/upload signatures into deterministic UI cards.
 *
 * Deliberately returns no generic guess when no strong signature matches. The
 * raw log and existing source-map highlighting remain the fallback in that
 * case, which keeps the feature's false-positive rate bounded.
 */
export const analyzeCompileIssues = ({
    log,
    operation = 'compile',
    fqbn = '',
    activePort = null,
    environmentChanges = [],
}: AnalyzeCompileIssuesInput): CompileIssueCard[] => {
    const text = String(log || '');
    const issues: CompileIssueCard[] = [];
    const add = (issue: CompileIssueCard | null) => {
        if (!issue) return;
        const identity = [
            issue.id,
            issue.sourceFile || '',
            issue.sourceLine ?? '',
            issue.sourceColumn ?? '',
            issue.explanationCode,
            JSON.stringify(issue.explanationParams),
            issue.rawDiagnostic,
        ].join('\u0000');
        if (!issues.some(existing => [
            existing.id,
            existing.sourceFile || '',
            existing.sourceLine ?? '',
            existing.sourceColumn ?? '',
            existing.explanationCode,
            JSON.stringify(existing.explanationParams),
            existing.rawDiagnostic,
        ].join('\u0000') === identity)) issues.push(issue);
    };

    const missingHeader = findMissingHeader(text);
    const firmwareSize = findFirmwareSizeIssue(text);
    add(missingHeader);
    add(firmwareSize);
    // Known deterministic signatures already provide a more useful reason.
    // Otherwise preserve the compiler's own source line/message without
    // guessing a category or an owning block.
    if (!missingHeader && !firmwareSize) findCompilerDiagnostics(text).forEach(add);

    if (operation === 'upload') {
        add(findPhysicalFlashMismatch(text));
        const serialIssue = findSerialPortIssue(text, activePort);
        add(serialIssue);
        // If the OS could not open the port, BOOT instructions cannot help yet.
        if (!serialIssue) add(findEspUploadIssue(text, fqbn));
    }

    add(createEnvironmentIssue(environmentChanges));
    return issues;
};
