export interface BlockConfig {
    type: string;
    extraState?: any;
    fields?: Record<string, any>;
    values?: Record<string, any>;
    statements?: Record<string, any[]>;
}

export interface AbsParseResult {
    success: boolean;
    setup: BlockConfig[];
    loop: BlockConfig[];
    errors: string[];
}

interface BlockMeta {
    type?: string;
    hasStatementInput?: boolean;
    statementInputNames?: string[];
    valueInputNames?: string[];
    fieldNames?: string[];
    isValueBlock?: boolean;
}

const FALLBACK_BLOCKS: Record<string, BlockMeta> = {
    // C 控制结构
    'controls_if': { statementInputNames: ['DO0', 'ELSE'], valueInputNames: ['IF0'] },
    'controls_whileUntil': { statementInputNames: ['DO'], valueInputNames: ['BOOL'], fieldNames: ['MODE'] },
    'controls_for': { statementInputNames: ['DO'], valueInputNames: ['FROM', 'TO', 'BY'], fieldNames: ['VAR'] },
    'controls_repeat_ext': { statementInputNames: ['DO'], valueInputNames: ['TIMES'] },
    'controls_global_defs_custom': { statementInputNames: ['DO'] },
    'controls_setup_custom': { statementInputNames: ['DO'] },
    'controls_loop_custom': { statementInputNames: ['DO'] },
    'macro_define_custom': { fieldNames: ['NAME', 'VALUE'] },
    'code_include_custom': { fieldNames: ['STYLE', 'HEADER'] },
    'code_comment_custom': { fieldNames: ['TEXT'] },

    // 串口
    'serial_setup': { fieldNames: ['BAUDRATE'] },
    'serial_print': { fieldNames: ['NEWLINE'], valueInputNames: ['TEXT'] },

    // 变量
    'var_declare_custom': { fieldNames: ['SCOPE', 'QUAL', 'NAME', 'TYPE'], valueInputNames: ['VALUE'] },
    'var_set_custom': { valueInputNames: ['NAME', 'VALUE'] },
    'var_ref_custom': { fieldNames: ['NAME'], isValueBlock: true },

    // 数组
    'array_declare_1d_custom': { fieldNames: ['SCOPE', 'NAME', 'TYPE', 'LEN'], valueInputNames: ['VALUE0', 'VALUE1', 'VALUE2', 'VALUE3', 'VALUE4', 'VALUE5', 'VALUE6', 'VALUE7', 'VALUE8', 'VALUE9'] },
    'array_declare_1d_empty_custom': { fieldNames: ['SCOPE', 'NAME', 'TYPE'], valueInputNames: ['LEN'] },
    'array_set_1d_custom': { fieldNames: ['NAME'], valueInputNames: ['IDX', 'VALUE'] },
    'array_get_1d_custom': { fieldNames: ['NAME'], valueInputNames: ['IDX'], isValueBlock: true },

    // 数学
    'math_number': { fieldNames: ['NUM'], isValueBlock: true },
    'math_arithmetic': { fieldNames: ['OP'], valueInputNames: ['A', 'B'], isValueBlock: true },
    'math_incdec_custom': { fieldNames: ['OP'], valueInputNames: ['VAR'] },

    // 逻辑
    'logic_compare': { fieldNames: ['OP'], valueInputNames: ['A', 'B'], isValueBlock: true },
    'logic_operation': { fieldNames: ['OP'], valueInputNames: ['A', 'B'], isValueBlock: true },
    'logic_boolean': { fieldNames: ['BOOL'], isValueBlock: true },
    'logic_negate': { valueInputNames: ['BOOL'], isValueBlock: true },

    // 文本/数组其它
    'text': { fieldNames: ['TEXT'], isValueBlock: true },
    'text_join': { valueInputNames: ['ADD0', 'ADD1', 'ADD2', 'ADD3'], isValueBlock: true },
    'array_length_1d_custom': { fieldNames: ['NAME'], isValueBlock: true },
};

function getBlockMeta(type: string): BlockMeta {
    return Object.assign({ type }, FALLBACK_BLOCKS[type] || {});
}

interface AbsRawNode {
    type: string;
    args: string[];
    namedInputs: Record<string, AbsRawNode[]>;
    children: AbsRawNode[];
    indent: number;
}

export class AbsParser {
    private lines: string[] = [];
    private currentLine = 0;
    private errors: string[] = [];
    private indentSize = 4;

    parse(code: string): AbsParseResult {
        this.lines = this.mergeMultilineParentheses(code).split('\n');
        this.currentLine = 0;
        this.errors = [];
        this.detectIndentSize();

        const rootNodes: AbsRawNode[] = [];

        while (this.currentLine < this.lines.length) {
            const line = this.lines[this.currentLine];
            if (!line.trim() || line.trim().startsWith('#')) {
                this.currentLine++;
                continue;
            }
            const node = this.parseBlock(0);
            if (node) rootNodes.push(node);
        }

        const setupBlocks: BlockConfig[] = [];
        const loopBlocks: BlockConfig[] = [];

        for (const node of rootNodes) {
            if (node.type === 'controls_setup_custom') {
                const blk = this.nodeToBlockConfig(node);
                if (blk.statements && blk.statements['DO']) {
                    setupBlocks.push(...blk.statements['DO']);
                } else {
                    // If it doesn't have a DO statement, perhaps the children are just its children
                    setupBlocks.push(...node.children.map(c => this.nodeToBlockConfig(c)));
                }
            } else if (node.type === 'controls_loop_custom') {
                const blk = this.nodeToBlockConfig(node);
                if (blk.statements && blk.statements['DO']) {
                    loopBlocks.push(...blk.statements['DO']);
                } else {
                    loopBlocks.push(...node.children.map(c => this.nodeToBlockConfig(c)));
                }
            } else {
                // Assume anything not explicitly setup/loop goes into setup
                setupBlocks.push(this.nodeToBlockConfig(node));
            }
        }

        return {
            success: this.errors.length === 0,
            setup: setupBlocks,
            loop: loopBlocks,
            errors: this.errors
        };
    }

    private mergeMultilineParentheses(code: string): string {
        const lines = code.split('\n');
        const result: string[] = [];
        let pendingLine = '';
        let parenDepth = 0;

        for (const line of lines) {
            const trimmed = line.trim();
            if (parenDepth === 0 && (!trimmed || trimmed.startsWith('#'))) {
                result.push(line);
                continue;
            }

            if (parenDepth === 0) {
                const openCount = (line.match(/\(/g) || []).length;
                const closeCount = (line.match(/\)/g) || []).length;
                parenDepth = openCount - closeCount;

                if (parenDepth > 0) {
                    pendingLine = line;
                } else {
                    result.push(line);
                }
            } else {
                const openCount = (trimmed.match(/\(/g) || []).length;
                const closeCount = (trimmed.match(/\)/g) || []).length;
                parenDepth += openCount - closeCount;
                pendingLine += ' ' + trimmed;

                if (parenDepth <= 0) {
                    result.push(pendingLine);
                    pendingLine = '';
                    parenDepth = 0;
                }
            }
        }
        if (pendingLine) result.push(pendingLine);
        return result.join('\n');
    }

    private detectIndentSize(): void {
        for (const line of this.lines) {
            if (line.length > 0 && line.startsWith(' ')) {
                const spaces = line.match(/^( +)/);
                if (spaces) {
                    this.indentSize = spaces[1].length;
                    break;
                }
            } else if (line.startsWith('\t')) {
                this.indentSize = 1;
                break;
            }
        }
    }

    private getIndentLevel(line: string): number {
        if (!line) return 0;
        const match = line.match(/^([ \t]*)/);
        if (!match) return 0;
        const indent = match[1];
        if (indent.includes('\t')) return indent.length;
        return Math.floor(indent.length / this.indentSize);
    }

    private parseBlock(expectedIndent: number): AbsRawNode | null {
        if (this.currentLine >= this.lines.length) return null;

        const line = this.lines[this.currentLine];
        const trimmed = line.trim();
        const actualIndent = this.getIndentLevel(line);

        if (!trimmed || trimmed.startsWith('#')) {
            this.currentLine++;
            return this.parseBlock(expectedIndent);
        }

        if (actualIndent < expectedIndent) return null;

        if (trimmed.startsWith('@')) {
            // Should not happen at top level of a block without a parent
            this.errors.push(`Line ${this.currentLine + 1}: Unexpected named input ${trimmed}`);
            this.currentLine++;
            return this.parseBlock(expectedIndent);
        }

        let type = '';
        let argsString = '';

        // 特殊兼容: i++ / i-- / ++i / --i
        const incDecMatch = trimmed.match(/^([$@a-zA-Z_0-9]+)(\+\+|--)|(\+\+|--)([$@a-zA-Z_0-9]+)$/);
        if (incDecMatch) {
            const isPostfix = !!incDecMatch[2];
            const op = incDecMatch[2] || incDecMatch[3];
            const varName = incDecMatch[1] || incDecMatch[4];
            const cleanVarName = varName.startsWith('$') ? varName.substring(1) : varName;

            type = 'math_incdec_custom';
            argsString = `"${op === '++' ? '++' : '--'}", $${cleanVarName}`;
        } else {
            const match = trimmed.match(/^([\w_]+)(?:\((.*)\))?$/);
            if (match) {
                type = match[1];
                argsString = match[2] || '';
            } else {
                this.errors.push(`Line ${this.currentLine + 1}: Invalid block format: ${trimmed}`);
                this.currentLine++;
                return null;
            }
        }

        let args = this.parseArguments(argsString);
        const sugar = this.applySyntaxSugar(type, args);
        type = sugar.type;
        args = sugar.args;

        const node: AbsRawNode = {
            type,
            args,
            namedInputs: {},
            children: [],
            indent: actualIndent
        };

        this.currentLine++;

        const childIndent = expectedIndent + 1;
        let currentInputName: string | null = null;

        while (this.currentLine < this.lines.length) {
            const nextLine = this.lines[this.currentLine];
            const nextTrimmed = nextLine.trim();
            const nextIndent = this.getIndentLevel(nextLine);

            if (!nextTrimmed || nextTrimmed.startsWith('#')) {
                this.currentLine++;
                continue;
            }

            if (nextIndent <= actualIndent) break;

            if (nextTrimmed.startsWith('@') && nextTrimmed.includes(':')) {
                const inputMatch = nextTrimmed.match(/@(\w+):\s*(.*)?/);
                if (inputMatch) {
                    currentInputName = inputMatch[1].toUpperCase();
                    if (inputMatch[2] && inputMatch[2].trim()) {
                        const inlineNode = this.parseInlineValue(inputMatch[2].trim());
                        if (inlineNode) {
                            if (!node.namedInputs[currentInputName]) node.namedInputs[currentInputName] = [];
                            node.namedInputs[currentInputName].push(inlineNode);
                        }
                        currentInputName = null;
                    }
                    this.currentLine++;
                    continue;
                }
            }

            const childNode = this.parseBlock(childIndent);
            if (childNode) {
                if (currentInputName) {
                    if (!node.namedInputs[currentInputName]) node.namedInputs[currentInputName] = [];
                    node.namedInputs[currentInputName].push(childNode);
                } else {
                    node.children.push(childNode);
                }
            }
        }

        return node;
    }

    private parseArguments(argsString: string): string[] {
        const args: string[] = [];
        let current = '';
        let depth = 0;
        let inString = false;
        let stringChar = '';

        for (let i = 0; i < argsString.length; i++) {
            const char = argsString[i];
            if ((char === '"' || char === "'") && (i === 0 || argsString[i - 1] !== '\\')) {
                if (!inString) {
                    inString = true;
                    stringChar = char;
                } else if (char === stringChar) {
                    inString = false;
                }
                current += char;
                continue;
            }
            if (inString) {
                current += char;
                continue;
            }
            if (char === '(' || char === '[' || char === '{') {
                depth++;
                current += char;
            } else if (char === ')' || char === ']' || char === '}') {
                depth--;
                current += char;
            } else if (char === ',' && depth === 0) {
                args.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        if (current.trim()) args.push(current.trim());
        return args;
    }

    private parseInlineValue(expr: string): AbsRawNode | null {
        expr = expr.trim();
        if (!expr) return null;

        // Is it a var sugar like $var?
        if (expr.startsWith('$')) {
            return { type: 'var_ref_custom', args: [expr.substring(1)], namedInputs: {}, children: [], indent: 0 };
        }

        // Is it a number?
        if (/^-?\d+(\.\d+)?$/.test(expr)) {
            return { type: 'math_number', args: [expr], namedInputs: {}, children: [], indent: 0 };
        }

        // Is it a string text("...")?
        if (expr.startsWith('"') || expr.startsWith("'")) {
            const str = expr.substring(1, expr.length - 1);
            return { type: 'text', args: [str], namedInputs: {}, children: [], indent: 0 };
        }

        const incDecMatch = expr.match(/^([$@a-zA-Z_0-9]+)(\+\+|--)|(\+\+|--)([$@a-zA-Z_0-9]+)$/);
        if (incDecMatch) {
            const isPostfix = !!incDecMatch[2];
            const op = incDecMatch[2] || incDecMatch[3];
            const varName = incDecMatch[1] || incDecMatch[4];
            const cleanVarName = varName.startsWith('$') ? varName.substring(1) : varName;

            return {
                type: 'math_incdec_custom',
                args: [`"${op === '++' ? '++' : '--'}"`, `$${cleanVarName}`],
                namedInputs: {},
                children: [],
                indent: 0
            };
        }

        const match = expr.match(/^([\w_]+)(?:\((.*)\))?$/);
        if (!match) return null;

        let type = match[1];
        let args = this.parseArguments(match[2] || '');
        const sugar = this.applySyntaxSugar(type, args);

        return {
            type: sugar.type,
            args: sugar.args,
            namedInputs: {},
            children: [],
            indent: 0
        };
    }

    private applySyntaxSugar(type: string, args: string[]): { type: string, args: string[] } {
        // --- 核心声明语法糖 ---
        if (type === 'declare_var') {
            // declare_var("name", value)
            const name = args[0] || '"unknown"';
            const val = args[1] || '0';
            return { type: 'var_declare_custom', args: ['"GLOBAL"', '"NORMAL"', name, '"int"', val] };
        }
        if (type === 'declare_arr') {
            // declare_arr("name", len, val1, val2, ...)
            const name = args[0] || '"arr"';
            const len = args[1] || '10';
            const newArgs = ['"GLOBAL"', name, '"int"', len];
            for (let i = 2; i < args.length; i++) newArgs.push(args[i]);
            while (newArgs.length < 4 + 10) newArgs.push('0');
            return { type: 'array_declare_1d_custom', args: newArgs };
        }
        if (type === 'set_var') {
            // set_var("name", value) -> var_set_custom
            return { type: 'var_set_custom', args: [args[0], args[1]] };
        }

        // --- 简易运算和逻辑语法糖 ---
        if (type === 'add') return { type: 'math_arithmetic', args: ['"ADD"', ...args] };
        if (type === 'sub') return { type: 'math_arithmetic', args: ['"MINUS"', ...args] };
        if (type === 'mul') return { type: 'math_arithmetic', args: ['"MULTIPLY"', ...args] };
        if (type === 'div') return { type: 'math_arithmetic', args: ['"DIVIDE"', ...args] };
        if (type === 'mod') return { type: 'math_arithmetic', args: ['"MODULO"', ...args] };

        if (type === 'eq') return { type: 'logic_compare', args: ['"EQ"', ...args] };
        if (type === 'neq') return { type: 'logic_compare', args: ['"NEQ"', ...args] };
        if (type === 'lt') return { type: 'logic_compare', args: ['"LT"', ...args] };
        if (type === 'lte') return { type: 'logic_compare', args: ['"LTE"', ...args] };
        if (type === 'gt') return { type: 'logic_compare', args: ['"GT"', ...args] };
        if (type === 'gte') return { type: 'logic_compare', args: ['"GTE"', ...args] };

        if (type === 'logic_and') return { type: 'logic_operation', args: ['"AND"', ...args] };
        if (type === 'logic_or') return { type: 'logic_operation', args: ['"OR"', ...args] };

        // --- 串口打印 ---
        if (type === 'serial_println') {
            return { type: 'serial_print', args: ['"TRUE"', ...args] };
        }
        if (type === 'serial_print') {
            if (args.length > 0 && args[0] !== '"TRUE"' && args[0] !== '"FALSE"') {
                return { type: 'serial_print', args: ['"FALSE"', ...args] };
            }
        }
        if (type === 'array_declare_1d_custom') {
            const newArgs = [...args];
            while (newArgs.length < 14) {
                newArgs.push('0');
            }
            return { type, args: newArgs };
        }
        return { type, args };
    }

    private nodeToBlockConfig(raw: AbsRawNode): BlockConfig {
        const meta = getBlockMeta(raw.type);
        const config: BlockConfig = { type: raw.type };

        if (raw.type === 'array_declare_1d_custom' || raw.type === 'array_row_literal_custom') {
            const definedFieldsCount = meta.fieldNames ? meta.fieldNames.length : 0;
            const valuesCount = raw.args.length - definedFieldsCount;
            config.extraState = { items: Math.max(0, valuesCount) };
        }

        const fields: Record<string, any> = {};
        const values: Record<string, any> = {};
        const statements: Record<string, any[]> = {};

        let argIndex = 0;

        // Allocate field arguments
        if (meta.fieldNames) {
            for (const fName of meta.fieldNames) {
                if (argIndex < raw.args.length) {
                    const argStr = raw.args[argIndex++];
                    // Strip quotes if any
                    fields[fName] = /^['"].*['"]$/.test(argStr) ? argStr.substring(1, argStr.length - 1) : argStr;
                    // Variable sugar cleanup
                    if (typeof fields[fName] === 'string' && fields[fName].startsWith('$')) {
                        fields[fName] = fields[fName].substring(1);
                    }
                }
            }
        }

        // Allocate value arguments
        if (meta.valueInputNames) {
            for (const vName of meta.valueInputNames) {
                if (argIndex < raw.args.length) {
                    const argStr = raw.args[argIndex++];
                    const inlineNode = this.parseInlineValue(argStr);
                    if (inlineNode) {
                        values[vName] = this.nodeToBlockConfig(inlineNode);
                    } else {
                        // Fallback to text/number automatic creation handled by buildProgram
                        values[vName] = /^['"].*['"]$/.test(argStr) ? argStr.substring(1, argStr.length - 1) : argStr;
                    }
                }
            }
        }

        // Process named inputs
        for (const [name, nodes] of Object.entries(raw.namedInputs)) {
            if (meta.statementInputNames?.includes(name)) {
                statements[name] = nodes.map(n => this.nodeToBlockConfig(n));
            } else if (meta.valueInputNames?.includes(name) || true) {
                // Treat as value if named input but not statement
                if (nodes.length > 0) {
                    values[name] = this.nodeToBlockConfig(nodes[0]);
                }
            }
        }

        // Process children naturally connected
        if (raw.children.length > 0) {
            if (meta.hasStatementInput || (meta.statementInputNames && meta.statementInputNames.length > 0)) {
                const sName = meta.statementInputNames && meta.statementInputNames.length > 0 ? meta.statementInputNames[0] : 'DO';
                if (!statements[sName]) statements[sName] = [];
                statements[sName].push(...raw.children.map(n => this.nodeToBlockConfig(n)));
            } else if (raw.type === 'controls_if' || raw.type === 'controls_whileUntil' || raw.type === 'controls_for') {
                if (!statements['DO']) statements['DO'] = [];
                statements['DO'].push(...raw.children.map(n => this.nodeToBlockConfig(n)));
            } else {
                // It has children but no clear statement input: maybe they are meant to be next connections?
                // Next connections are handled by the fact that sibling AbsRawNodes are inside the parent's children/statements
                // Wait, if it has children and no statement input, this is a syntax error in ABS, but we can put them somewhere.
                if (!statements['DO']) statements['DO'] = [];
                statements['DO'].push(...raw.children.map(n => this.nodeToBlockConfig(n)));
            }
        }

        if (Object.keys(fields).length > 0) config.fields = fields;
        if (Object.keys(values).length > 0) config.values = values;
        if (Object.keys(statements).length > 0) config.statements = statements;

        return config;
    }
}
