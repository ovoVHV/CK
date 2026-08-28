import * as Blockly from 'blockly';
import * as En from 'blockly/msg/en';
import * as ZhHans from 'blockly/msg/zh-hans';
import 'blockly/blocks';
import { getPinsAsDropdown } from '../config/boards';
import { BOARD_PIN_DROPDOWN_REGISTRY } from '../services/board_pin_registry';
import { filterToolboxForCompatibility } from './block_compatibility';
import { compactExtensionToolboxXml } from '../services/extension_toolbox_compaction';

// Ensure messages are loaded (Chinese first, English fallback)
Blockly.setLocale({ ...(En as any), ...(ZhHans as any) });

// Procedure/Function wording: keep labels clear for students.
Object.assign((Blockly as any).Msg || {}, {
    PROCEDURES_DEFNORETURN_TITLE: '定义函数',
    PROCEDURES_DEFRETURN_TITLE: '定义函数',
    PROCEDURES_DEFNORETURN_PROCEDURE: 'myFunction',
    PROCEDURES_DEFRETURN_PROCEDURE: 'myFunction',
    PROCEDURES_DEFNORETURN_DO: '执行',
    PROCEDURES_DEFRETURN_RETURN: '返回',
    PROCEDURES_CALL_BEFORE_PARAMS: '参数',
    PROCEDURES_IFRETURN_WARNING: '“如果返回”只能在函数定义中使用',
});

// [Fix] Monkey-patch Gesture to prevent "already started" crashes on double-click
try {
    const GestureParams = Blockly.Gesture.prototype as any;
    if (GestureParams && GestureParams.handleBlockStart) {
        const originalHandleBlockStart = GestureParams.handleBlockStart;
        GestureParams.handleBlockStart = function (e: any, block: any) {
            // Prevent duplicate event processing
            if (this.mostRecentEvent_ === e) return;
            try {
                originalHandleBlockStart.call(this, e, block);
            } catch (err: any) {
                // If gesture is stuck, force kill it and retry
                if (err?.message?.includes("gesture") && err?.message?.includes("started")) {
                    console.warn("[Blockly Auto-Fix] Resetting stuck gesture...", err);
                    this.dispose();
                    try {
                        originalHandleBlockStart.call(this, e, block);
                    } catch (retryErr) { console.error("Retry failed", retryErr); }
                } else {
                    throw err;
                }
            }
        };
    }
} catch (e) { console.warn("Failed to patch Blockly Gesture", e); }

// Global state for dynamic blocks
let currentBoardFqbn = 'esp32:esp32:esp32c5';
const BOARD_PIN_DROPDOWNS = BOARD_PIN_DROPDOWN_REGISTRY;

export const setBlocklyBoard = (
    fqbn: string,
    boardPackageId: string = fqbn,
    isCustom = false,
) => {
    currentBoardFqbn = fqbn;
    BOARD_PIN_DROPDOWNS.activate({ fqbn, packageId: boardPackageId, isCustom });
    // We might need to refresh toolbox or workspace if open, 
    // but dropdowns update on click, so usually fine.
};

export const registerDetailedBoard = (
    fqbn: string,
    pins: any[],
    boardPackageId: string = fqbn,
    isCustom = false,
) => {
    BOARD_PIN_DROPDOWNS.register({ fqbn, packageId: boardPackageId, isCustom }, pins);
    console.log(`[Blockly] Registered pins for ${boardPackageId} (${fqbn}): ${pins?.length || 0} pins`);
};

const pinDropdownGenerator = function () {
    const options = BOARD_PIN_DROPDOWNS.resolve(getPinsAsDropdown(currentBoardFqbn));

    // Safety Filter (Fix appendChild error caused by null/undefined)
    return options.map((o: any): [string, string] => {
        let label = "Unknown";
        let value = "0";

        if (Array.isArray(o)) {
            // Standard Blockly Format [label, value]
            label = (o[0] !== undefined && o[0] !== null) ? String(o[0]) : "Unknown";
            value = (o[1] !== undefined && o[1] !== null) ? String(o[1]) : "0";
        } else if (typeof o === 'object' && o !== null) {
            // Handle Object Format {label: "PC13", value: "PC13"}
            label = String(o.label || o.name || "Unknown");
            value = String(o.value || o.id || "0");
        }

        return [label, value];
    });
};

const sanitizeVariableDisplayName = (name: string, fallback = 'variable'): string => {
    const raw = String(name || '').trim();
    const normalized = raw
        .replace(/\s+/g, '_')
        .replace(/[^\w\u4e00-\u9fa5]/g, '_')
        .replace(/^(\d)/, '_$1')
        .slice(0, 48);
    return normalized || fallback;
};

const getWorkspaceVariableNames = (workspace: any): string[] => {
    if (!workspace) return [];
    const names = new Set<string>();
    try {
        const vm = workspace.getVariableMap?.();
        const vars = vm?.getAllVariables?.() || [];
        for (const item of vars) {
            const name = sanitizeVariableDisplayName(item?.name, '');
            if (name) names.add(name);
        }
    } catch {
        // Ignore variable-map read failures.
    }
    return Array.from(names);
};

const resolveFieldWorkspace = (field: any): any => {
    const sourceBlock = field?.getSourceBlock?.();
    const ws = sourceBlock?.workspace;
    return ws?.targetWorkspace || ws;
};

const createVariableField = (defaultName: string) => {
    const fallback = sanitizeVariableDisplayName(defaultName, 'variable');
    const fixedSeeds = ['variable', 'buffer', 'item', 'index', 'value'];
    const field = new Blockly.FieldDropdown(function (this: any): [string, string][] {
        const ws = resolveFieldWorkspace(this);
        const names = getWorkspaceVariableNames(ws);
        for (const seed of fixedSeeds) {
            if (!names.includes(seed)) {
                names.push(seed);
            }
        }
        const current = sanitizeVariableDisplayName(String(this?.getValue?.() || ''), fallback);
        if (current && !names.includes(current)) {
            names.unshift(current);
        }
        if (fallback && !names.includes(fallback)) {
            names.unshift(fallback);
        }
        if (names.length === 0) {
            names.push('variable');
        }
        return names.map((name) => [name, name] as [string, string]);
    });
    try {
        field.setValue(fallback);
    } catch {
        // Ignore early value assignment failures on flyout shadows.
    }
    return field;
};

const ensureWorkspaceVariableByField = (block: any, fieldName: string, fallback: string) => {
    try {
        if (!block || block.isInFlyout || !block.workspace) return;
        const ws = block.workspace;
        const raw = block.getFieldValue(fieldName);
        const normalized = sanitizeVariableDisplayName(raw, fallback);
        if (normalized !== raw) {
            block.setFieldValue(normalized, fieldName);
        }

        const vm = ws.getVariableMap?.();
        const existed = vm?.getVariable?.(normalized, '');
        if (!existed) {
            if (typeof ws.createVariable === 'function') {
                ws.createVariable(normalized, '');
            } else if (typeof vm?.createVariable === 'function') {
                vm.createVariable(normalized, '');
            }
        }
    } catch {
        // Ignore sync failures, never block editing.
    }
};

// Pin Selector Block (Shadow)
Blockly.Blocks['board_pin_selector'] = {
    init: function () {
        this.appendDummyInput()
            .appendField(new Blockly.FieldDropdown(pinDropdownGenerator), "PIN");
        this.setOutput(true, null);
        this.setColour(230); // Blue (Contrast for shadow)
        this.setTooltip("Select a pin");
        this.setHelpUrl("");
    }
};

// Define Custom Blocks
// Pins
const IO_LEVEL_OPTIONS: [string, string][] = [
    ['高', 'HIGH'],
    ['低', 'LOW'],
];
const IO_PIN_MODE_OPTIONS: [string, string][] = [
    ['输出', 'OUTPUT'],
    ['输入', 'INPUT'],
    ['上拉输入', 'INPUT_PULLUP'],
];

const BUTTON_EVENT_OPTIONS: [string, string][] = [
    ['单击', 'SINGLE'],
    ['双击', 'DOUBLE'],
    ['长按', 'LONG'],
];

const INTERRUPT_MODE_OPTIONS: [string, string][] = [
    ['上升', 'RISING'],
    ['下降', 'FALLING'],
    ['变化', 'CHANGE'],
];

const SHIFT_ORDER_OPTIONS: [string, string][] = [
    ['高位先入', 'MSBFIRST'],
    ['低位先入', 'LSBFIRST'],
];

const SERIAL_BAUD_OPTIONS: [string, string][] = [
    ['115200', '115200'],
    ['300', '300'],
    ['1200', '1200'],
    ['2400', '2400'],
    ['4800', '4800'],
    ['9600', '9600'],
    ['19200', '19200'],
    ['38400', '38400'],
    ['57600', '57600'],
    ['74880', '74880'],
    ['230400', '230400'],
    ['460800', '460800'],
    ['500000', '500000'],
    ['921600', '921600'],
    ['1000000', '1000000'],
    ['2000000', '2000000'],
];
const SERIAL_NEWLINE_OPTIONS: [string, string][] = [
    ['\u6362\u884c', 'TRUE'],
    ['\u4e0d\u6362\u884c', 'FALSE'],
];
const SERIAL_BASE_OPTIONS: [string, string][] = [
    ['\u5341\u8fdb\u5236', 'DEC'],
    ['\u5341\u516d\u8fdb\u5236', 'HEX'],
    ['\u516b\u8fdb\u5236', 'OCT'],
    ['\u4e8c\u8fdb\u5236', 'BIN'],
];
const SERIAL_PORT_OPTIONS: [string, string][] = [
    ['Serial', 'Serial'],
    ['Serial1', 'Serial1'],
    ['Serial2', 'Serial2'],
];
const CONTROL_FLOW_ACTION_OPTIONS: [string, string][] = [
    ['\u8df3\u51fa\u5faa\u73af', 'BREAK'],
    ['\u8fdb\u5165\u4e0b\u6b21\u5faa\u73af', 'CONTINUE'],
    ['\u505c\u6b62\u5f53\u524d\u51fd\u6570', 'RETURN'],
];
const SYSTEM_TIME_UNIT_OPTIONS: [string, string][] = [
    ['\u6beb\u79d2', 'MS'],
    ['\u5fae\u79d2', 'US'],
    ['\u79d2', 'S'],
];
const DELAY_UNIT_OPTIONS: [string, string][] = [
    ['毫秒', 'MS'],
    ['微秒', 'US'],
];
const SIMPLE_TIMER_SLOT_OPTIONS: [string, string][] = [
    ['1', '1'],
    ['2', '2'],
    ['3', '3'],
    ['4', '4'],
    ['5', '5'],
    ['6', '6'],
    ['7', '7'],
    ['8', '8'],
    ['9', '9'],
    ['10', '10'],
    ['11', '11'],
    ['12', '12'],
    ['13', '13'],
];
const TIME_HUE = '#F59E0B';
const LOGIC_HUE = '#3B82F6';
const LOOP_HUE = '#22C55E';
const SERIAL_HUE = '#2563EB';
const MATH_HUE = '#65A30D';
const VARIABLE_HUE = '#C026D3';
const TEXT_HUE = '#14B8A6';
const ARRAY_HUE = '#7C3AED';
const FUNCTION_HUE = '#8B5CF6';
const FUNCTION_RETURN_TYPE_OPTIONS: [string, string][] = [
    ['整型 int', 'int'],
    ['长整型 long', 'long'],
    ['浮点 float', 'float'],
    ['双精度 double', 'double'],
    ['布尔 bool', 'bool'],
    ['字符串 String', 'String'],
    ['字符 char', 'char'],
    ['字节 byte', 'byte'],
    ['无符号整型 unsigned int', 'unsigned int'],
    ['无符号长整型 unsigned long', 'unsigned long'],
    ['int8_t', 'int8_t'],
    ['uint8_t', 'uint8_t'],
    ['int16_t', 'int16_t'],
    ['uint16_t', 'uint16_t'],
    ['int32_t', 'int32_t'],
    ['uint32_t', 'uint32_t'],
];
const MATH_MINMAX_OPTIONS: [string, string][] = [
    ['最小值', 'MIN'],
    ['最大值', 'MAX'],
];
const MATH_RADIX_OPTIONS: [string, string][] = [
    ['十进制', '10'],
    ['十六进制', '16'],
    ['八进制', '8'],
    ['二进制', '2'],
];
const MATH_BITWISE_OP_OPTIONS: [string, string][] = [
    ['<<', 'SHL'],
    ['>>', 'SHR'],
    ['&', 'AND'],
    ['|', 'OR'],
    ['^', 'XOR'],
];
const MATH_BYTE_PART_OPTIONS: [string, string][] = [
    ['高8位', 'HIGH'],
    ['低8位', 'LOW'],
];
const MATH_INCDEC_OPTIONS: [string, string][] = [
    ['后置++', 'POST_INC'],
    ['前置++', 'PRE_INC'],
    ['后置--', 'POST_DEC'],
    ['前置--', 'PRE_DEC'],
];
const MATH_COMPOUND_ASSIGN_OPTIONS: [string, string][] = [
    ['+=', '+='],
    ['-=', '-='],
    ['*=', '*='],
    ['/=', '/='],
    ['%=', '%='],
];
const VARIABLE_SCOPE_OPTIONS: [string, string][] = [
    ['全局变量', 'GLOBAL'],
    ['局部变量', 'LOCAL'],
];
const VARIABLE_TYPE_OPTIONS: [string, string][] = [
    ['整型 (int)', 'int'],
    ['长整型 (long)', 'long'],
    ['无符号整型 (unsigned int)', 'unsigned int'],
    ['无符号长整型 (unsigned long)', 'unsigned long'],
    ['浮点 (float)', 'float'],
    ['双精度 (double)', 'double'],
    ['布尔 (bool)', 'bool'],
    ['字符 (char)', 'char'],
    ['字符串 (String)', 'String'],
    ['8位整型 (int8_t)', 'int8_t'],
    ['8位无符号 (uint8_t)', 'uint8_t'],
    ['字节 (byte)', 'byte'],
    ['16位整型 (int16_t)', 'int16_t'],
    ['16位无符号 (uint16_t)', 'uint16_t'],
    ['32位整型 (int32_t)', 'int32_t'],
    ['32位无符号 (uint32_t)', 'uint32_t'],
];
const VARIABLE_QUALIFIER_OPTIONS: [string, string][] = [
    ['普通', 'NONE'],
    ['静态 static', 'STATIC'],
    ['常量 const', 'CONST'],
    ['易变 volatile', 'VOLATILE'],
    ['静态常量 static const', 'STATIC_CONST'],
    ['静态易变 static volatile', 'STATIC_VOLATILE'],
];
const TEXT_EDGE_MODE_OPTIONS: [string, string][] = [
    ['看开头', 'STARTS'],
    ['看结尾', 'ENDS'],
];
const TEXT_CASE_MODE_OPTIONS: [string, string][] = [
    ['变大写', 'UPPER'],
    ['变小写', 'LOWER'],
];
const TEXT_TRIM_MODE_OPTIONS: [string, string][] = [
    ['去掉两边空格', 'BOTH'],
    ['去掉左边空格', 'LEFT'],
    ['去掉右边空格', 'RIGHT'],
];
const ARRAY_SORT_ORDER_OPTIONS: [string, string][] = [
    ['升序', 'ASC'],
    ['降序', 'DESC'],
];
const ARRAY_ROTATE_DIR_OPTIONS: [string, string][] = [
    ['左移', 'LEFT'],
    ['右移', 'RIGHT'],
];

const LOGIC_CORE_BLOCK_TYPES = [
    'controls_if',
];

const LOOP_CORE_BLOCK_TYPES = [
    'controls_repeat_ext',
    'controls_whileUntil',
    'controls_for',
    'controls_flow_statements',
];

const LOGIC_EXPR_BLOCK_TYPES = [
    'logic_boolean',
    'logic_compare',
    'logic_operation',
    'logic_negate',
    'logic_ternary',
];

const MATH_CORE_BLOCK_TYPES = [
    'math_number',
    'math_arithmetic',
    'math_single',
    'math_trig',
    'math_constant',
    'math_number_property',
    'math_round',
    'math_modulo',
    'math_constrain',
    'math_random_int',
    'math_random_float',
    'math_atan2',
    'math_change',
];

const patchCoreColour = (types: string[], hue: string, flag: string) => {
    for (const type of types) {
        const block = (Blockly.Blocks as any)[type];
        if (!block || typeof block.init !== 'function' || (block as any)[flag]) continue;
        const originalInit = block.init;
        block.init = function (...args: any[]) {
            originalInit.apply(this, args);
            this.setColour(hue);
        };
        (block as any)[flag] = true;
    }
};

patchCoreColour(LOGIC_CORE_BLOCK_TYPES, LOGIC_HUE, '__ckLogicColorPatched');
patchCoreColour(LOOP_CORE_BLOCK_TYPES, LOOP_HUE, '__ckLoopColorPatched');
patchCoreColour(LOGIC_EXPR_BLOCK_TYPES, LOGIC_HUE, '__ckLogicExprColorPatched');
patchCoreColour(MATH_CORE_BLOCK_TYPES, MATH_HUE, '__ckMathColorPatched');

// Override Blockly built-in ternary block with a kid-friendly Chinese layout.
Blockly.Blocks['logic_ternary'] = {
    init: function () {
        this.appendValueInput('IF')
            .setCheck('Boolean')
            .appendField('\u5982\u679c');
        this.appendValueInput('THEN')
            .appendField('\u5219');
        this.appendValueInput('ELSE')
            .appendField('\u5426\u5219');
        this.setOutput(true, null);
        this.setColour(LOGIC_HUE);
        this.setTooltip('\u6761\u4ef6\u4e3a\u771f\u65f6\u53d6\u201c\u5219\u201d\uff0c\u5426\u5219\u53d6\u201c\u5426\u5219\u201d');
        this.setHelpUrl('');
    }
};

// Statement-style ternary block (stackable, keeps original expression block intact).
Blockly.Blocks['logic_ternary_stmt_custom'] = {
    init: function () {
        this.appendValueInput('IF')
            .setCheck('Boolean')
            .appendField('\u6761\u4ef6');
        this.appendValueInput('THEN')
            .appendField('?');
        this.appendValueInput('ELSE')
            .appendField(':');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(LOGIC_HUE);
        this.setTooltip('\u53ef\u4e0a\u4e0b\u8fde\u63a5\u7684\u4e09\u5219\u8bed\u53e5\u5757\uff0c\u5f62\u5f0f\uff1a\u6761\u4ef6 ? \u503c1 : \u503c2');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

// Override logic compare/operators with code-style symbols for teaching.
Blockly.Blocks['logic_compare'] = {
    init: function () {
        this.appendValueInput('A');
        this.appendDummyInput().appendField(new Blockly.FieldDropdown([
            ['==', 'EQ'],
            ['!=', 'NEQ'],
            ['<', 'LT'],
            ['<=', 'LTE'],
            ['>', 'GT'],
            ['>=', 'GTE'],
        ]), 'OP');
        this.appendValueInput('B');
        this.setInputsInline(true);
        this.setOutput(true, 'Boolean');
        this.setColour(LOGIC_HUE);
        this.setTooltip('比较两个值');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['logic_operation'] = {
    init: function () {
        this.appendValueInput('A').setCheck('Boolean');
        this.appendDummyInput().appendField(new Blockly.FieldDropdown([
            ['与', 'AND'],
            ['或', 'OR'],
        ]), 'OP');
        this.appendValueInput('B').setCheck('Boolean');
        this.setInputsInline(true);
        this.setOutput(true, 'Boolean');
        this.setColour(LOGIC_HUE);
        this.setTooltip('布尔与/或运算');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['logic_negate'] = {
    init: function () {
        this.appendValueInput('BOOL')
            .setCheck('Boolean')
            .appendField('非');
        this.setOutput(true, 'Boolean');
        this.setColour(LOGIC_HUE);
        this.setTooltip('布尔取反');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['math_map_custom'] = {
    init: function () {
        this.appendValueInput('VALUE')
            .setCheck('Number')
            .appendField('映射');
        this.appendValueInput('FROM_LOW')
            .setCheck('Number')
            .appendField('从');
        this.appendValueInput('FROM_HIGH')
            .setCheck('Number')
            .appendField('到');
        this.appendValueInput('TO_LOW')
            .setCheck('Number')
            .appendField('映射到');
        this.appendValueInput('TO_HIGH')
            .setCheck('Number')
            .appendField('到');
        this.setInputsInline(true);
        this.setOutput(true, 'Number');
        this.setColour(MATH_HUE);
        this.setTooltip('将一个范围内的数值线性映射到另一个范围');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['math_minmax_custom'] = {
    init: function () {
        this.appendValueInput('A')
            .setCheck('Number');
        this.appendDummyInput()
            .appendField(new Blockly.FieldDropdown(MATH_MINMAX_OPTIONS), 'OP');
        this.appendValueInput('B')
            .setCheck('Number');
        this.setInputsInline(true);
        this.setOutput(true, 'Number');
        this.setColour(MATH_HUE);
        this.setTooltip('返回两个数中的最小值或最大值');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['math_base_parse_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('进制数')
            .appendField(new Blockly.FieldDropdown(MATH_RADIX_OPTIONS), 'BASE')
            .appendField(new Blockly.FieldTextInput('FF'), 'VALUE');
        this.setOutput(true, 'Number');
        this.setColour(MATH_HUE);
        this.setTooltip('把不同进制文本转换为数字');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['math_round_to_custom'] = {
    init: function () {
        this.appendValueInput('PLACES')
            .setCheck('Number')
            .appendField('保留');
        this.appendValueInput('NUM')
            .setCheck('Number')
            .appendField('位小数的');
        this.setInputsInline(true);
        this.setOutput(true, 'Number');
        this.setColour(MATH_HUE);
        this.setTooltip('把数字保留到指定小数位');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['math_incdec_custom'] = {
    init: function () {
        this.appendValueInput('VAR')
            .setCheck(null)
            .appendField('变量');
        this.appendDummyInput()
            .appendField('执行')
            .appendField(new Blockly.FieldDropdown(MATH_INCDEC_OPTIONS), 'OP');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(MATH_HUE);
        this.setTooltip('对指定变量执行自增或自减');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['math_compound_assign_custom'] = {
    init: function () {
        this.appendValueInput('VAR')
            .setCheck(null)
            .appendField('变量');
        this.appendDummyInput()
            .appendField('执行')
            .appendField(new Blockly.FieldDropdown(MATH_COMPOUND_ASSIGN_OPTIONS), 'OP');
        this.appendValueInput('VALUE')
            .setCheck('Number')
            .appendField('值');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(MATH_HUE);
        this.setTooltip('复合赋值运算');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['math_bitwise_not_custom'] = {
    init: function () {
        this.appendValueInput('NUM')
            .setCheck('Number')
            .appendField('~');
        this.setOutput(true, 'Number');
        this.setColour(MATH_HUE);
        this.setTooltip('按位取反');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['math_bitwise_op_custom'] = {
    init: function () {
        this.appendValueInput('A')
            .setCheck('Number');
        this.appendDummyInput()
            .appendField(new Blockly.FieldDropdown(MATH_BITWISE_OP_OPTIONS), 'OP');
        this.appendValueInput('B')
            .setCheck('Number');
        this.setInputsInline(true);
        this.setOutput(true, 'Number');
        this.setColour(MATH_HUE);
        this.setTooltip('位运算与移位');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['math_highlow_byte_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField(new Blockly.FieldDropdown(MATH_BYTE_PART_OPTIONS), 'PART');
        this.appendValueInput('NUM')
            .setCheck('Number');
        this.setInputsInline(true);
        this.setOutput(true, 'Number');
        this.setColour(MATH_HUE);
        this.setTooltip('提取高8位或低8位');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['math_combine_word_custom'] = {
    init: function () {
        this.appendValueInput('HIGH')
            .setCheck('Number')
            .appendField('组合16位 高位');
        this.appendValueInput('LOW')
            .setCheck('Number')
            .appendField('低位');
        this.setInputsInline(true);
        this.setOutput(true, 'Number');
        this.setColour(MATH_HUE);
        this.setTooltip('用高8位和低8位组合成16位数');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['math_bit_read_custom'] = {
    init: function () {
        this.appendValueInput('NUM')
            .setCheck('Number')
            .appendField('读取');
        this.appendValueInput('BIT')
            .setCheck('Number')
            .appendField('的第');
        this.appendDummyInput()
            .appendField('位');
        this.setInputsInline(true);
        this.setOutput(true, 'Number');
        this.setColour(MATH_HUE);
        this.setTooltip('读取某一位的值');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['math_bit_write_custom'] = {
    init: function () {
        this.appendValueInput('NUM')
            .setCheck('Number')
            .appendField('写入');
        this.appendValueInput('BIT')
            .setCheck('Number')
            .appendField('的第');
        this.appendValueInput('VALUE')
            .setCheck('Number')
            .appendField('位为');
        this.setInputsInline(true);
        this.setOutput(true, 'Number');
        this.setColour(MATH_HUE);
        this.setTooltip('设置某一位为 0 或 1');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['math_bit_set_custom'] = {
    init: function () {
        this.appendValueInput('NUM')
            .setCheck('Number')
            .appendField('置位');
        this.appendValueInput('BIT')
            .setCheck('Number')
            .appendField('的第');
        this.appendDummyInput()
            .appendField('位');
        this.setInputsInline(true);
        this.setOutput(true, 'Number');
        this.setColour(MATH_HUE);
        this.setTooltip('把某一位设置为1');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['math_bit_clear_custom'] = {
    init: function () {
        this.appendValueInput('NUM')
            .setCheck('Number')
            .appendField('清零');
        this.appendValueInput('BIT')
            .setCheck('Number')
            .appendField('的第');
        this.appendDummyInput()
            .appendField('位');
        this.setInputsInline(true);
        this.setOutput(true, 'Number');
        this.setColour(MATH_HUE);
        this.setTooltip('把某一位清零');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['var_declare_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('声明')
            .appendField(new Blockly.FieldDropdown(VARIABLE_SCOPE_OPTIONS), 'SCOPE')
            .appendField(new Blockly.FieldDropdown(VARIABLE_QUALIFIER_OPTIONS), 'QUAL')
            .appendField(new Blockly.FieldTextInput('variable'), 'NAME')
            .appendField('为')
            .appendField(new Blockly.FieldDropdown(VARIABLE_TYPE_OPTIONS), 'TYPE');
        this.appendValueInput('VALUE')
            .setCheck(null)
            .appendField('并赋值');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(VARIABLE_HUE);
        this.setTooltip('声明变量，支持局部/全局、static/const/volatile 修饰');
        this.setHelpUrl('');
        this.setOnChange(function (this: any, event: any) {
            if (!event || this.isInFlyout) return;
            const eventType = String(event.type || '');
            const blockChanged = event.blockId === this.id || (Array.isArray(event.ids) && event.ids.includes(this.id));
            if (!blockChanged) return;
            if (eventType === Blockly.Events.BLOCK_CREATE || eventType === Blockly.Events.BLOCK_CHANGE) {
                ensureWorkspaceVariableByField(this, 'NAME', 'variable');
            }
        });
    }
};

Blockly.Blocks['var_set_custom'] = {
    init: function () {
        this.appendValueInput('NAME')
            .setCheck(null)
            .appendField('赋值');
        this.appendDummyInput()
            .appendField('为');
        this.appendValueInput('VALUE')
            .setCheck(null);
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(VARIABLE_HUE);
        this.setTooltip('给变量赋值');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['var_ref_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField(createVariableField('variable'), 'NAME');
        this.setOutput(true, null);
        this.setColour(VARIABLE_HUE);
        this.setTooltip('变量引用，可插入到表达式输入口');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['var_cast_custom'] = {
    init: function () {
        this.appendValueInput('VALUE')
            .setCheck(null)
            .appendField('将');
        this.appendDummyInput()
            .appendField('强制转换为')
            .appendField(new Blockly.FieldDropdown(VARIABLE_TYPE_OPTIONS), 'TYPE');
        this.setInputsInline(true);
        this.setOutput(true, null);
        this.setColour(VARIABLE_HUE);
        this.setTooltip('类型强制转换');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['var_dynamic_alloc_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('动态申请')
            .appendField(new Blockly.FieldDropdown(VARIABLE_SCOPE_OPTIONS), 'SCOPE')
            .appendField(new Blockly.FieldTextInput('buffer'), 'NAME')
            .appendField('为')
            .appendField(new Blockly.FieldDropdown(VARIABLE_TYPE_OPTIONS), 'TYPE')
            .appendField('数组');
        this.appendValueInput('COUNT')
            .setCheck('Number')
            .appendField('数量');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(VARIABLE_HUE);
        this.setTooltip('使用 malloc 申请动态内存');
        this.setHelpUrl('');
        this.setOnChange(function (this: any, event: any) {
            if (!event || this.isInFlyout) return;
            const eventType = String(event.type || '');
            const blockChanged = event.blockId === this.id || (Array.isArray(event.ids) && event.ids.includes(this.id));
            if (!blockChanged) return;
            if (eventType === Blockly.Events.BLOCK_CREATE || eventType === Blockly.Events.BLOCK_CHANGE) {
                ensureWorkspaceVariableByField(this, 'NAME', 'buffer');
            }
        });
    }
};

Blockly.Blocks['var_dynamic_free_custom'] = {
    init: function () {
        this.appendValueInput('NAME')
            .setCheck(null)
            .appendField('释放动态内存');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(VARIABLE_HUE);
        this.setTooltip('释放 malloc 申请的内存');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['text_char_literal_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('\'')
            .appendField(new Blockly.FieldTextInput('A', (raw: string) => {
                const s = String(raw || '');
                return s.length > 0 ? s[0] : 'A';
            }), 'CHAR')
            .appendField('\'');
        this.setOutput(true, null);
        this.setColour(TEXT_HUE);
        this.setTooltip('字符常量');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['text_concat_custom'] = {
    init: function () {
        this.appendValueInput('A')
            .setCheck(null)
            .appendField('把');
        this.appendDummyInput()
            .appendField('和');
        this.appendValueInput('B')
            .setCheck(null)
            .appendField('拼在一起');
        this.appendDummyInput()
            .appendField('');
        this.setInputsInline(true);
        this.setOutput(true, 'String');
        this.setColour(TEXT_HUE);
        this.setTooltip('把两段文字接成一段');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['text_to_type_custom'] = {
    init: function () {
        this.appendValueInput('TEXT')
            .setCheck(null)
            .appendField('把文字');
        this.appendDummyInput()
            .appendField('变成')
            .appendField(new Blockly.FieldDropdown(VARIABLE_TYPE_OPTIONS), 'TYPE');
        this.setInputsInline(true);
        this.setOutput(true, null);
        this.setColour(TEXT_HUE);
        this.setTooltip('把文字变成数字、布尔等类型');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['value_to_text_custom'] = {
    init: function () {
        this.appendValueInput('VALUE')
            .setCheck(null)
            .appendField('把这个值');
        this.appendDummyInput()
            .appendField('变成文字');
        this.setInputsInline(true);
        this.setOutput(true, 'String');
        this.setColour(TEXT_HUE);
        this.setTooltip('把数字或其他值变成文字');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['text_starts_ends_custom'] = {
    init: function () {
        this.appendValueInput('TEXT')
            .setCheck(null)
            .appendField('文字');
        this.appendValueInput('PATTERN')
            .setCheck(null)
            .appendField('和');
        this.appendDummyInput()
            .appendField('对比')
            .appendField(new Blockly.FieldDropdown(TEXT_EDGE_MODE_OPTIONS), 'MODE');
        this.setInputsInline(true);
        this.setOutput(true, 'Boolean');
        this.setColour(TEXT_HUE);
        this.setTooltip('判断文字开头或结尾是不是一样');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['text_ascii_from_number_custom'] = {
    init: function () {
        this.appendValueInput('NUM')
            .setCheck('Number')
            .appendField('把数字');
        this.appendDummyInput()
            .appendField('变成字符(ASCII)');
        this.setInputsInline(true);
        this.setOutput(true, null);
        this.setColour(TEXT_HUE);
        this.setTooltip('ASCII数值转字符');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['text_ascii_to_number_custom'] = {
    init: function () {
        this.appendValueInput('CHAR')
            .setCheck(null)
            .appendField('把字符');
        this.appendDummyInput()
            .appendField('变成ASCII数字');
        this.setInputsInline(true);
        this.setOutput(true, 'Number');
        this.setColour(TEXT_HUE);
        this.setTooltip('字符转ASCII数值');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['text_substring_custom'] = {
    init: function () {
        this.appendValueInput('TEXT')
            .setCheck(null)
            .appendField('从文字');
        this.appendValueInput('START')
            .setCheck('Number')
            .appendField('里截取 第');
        this.appendValueInput('END')
            .setCheck('Number')
            .appendField('到第');
        this.appendDummyInput()
            .appendField('个字');
        this.setInputsInline(true);
        this.setOutput(true, 'String');
        this.setColour(TEXT_HUE);
        this.setTooltip('按字符位置获取子串（1起始）');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['text_case_convert_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField(new Blockly.FieldDropdown(TEXT_CASE_MODE_OPTIONS), 'MODE');
        this.appendValueInput('TEXT')
            .setCheck(null);
        this.setInputsInline(true);
        this.setOutput(true, 'String');
        this.setColour(TEXT_HUE);
        this.setTooltip('文本大小写转换');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['text_trim_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField(new Blockly.FieldDropdown(TEXT_TRIM_MODE_OPTIONS), 'MODE')
            .appendField('：');
        this.appendValueInput('TEXT')
            .setCheck(null);
        this.setInputsInline(true);
        this.setOutput(true, 'String');
        this.setColour(TEXT_HUE);
        this.setTooltip('删除文本空白');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['text_count_occurrence_custom'] = {
    init: function () {
        this.appendValueInput('NEEDLE')
            .setCheck(null)
            .appendField('数一数');
        this.appendValueInput('HAYSTACK')
            .setCheck(null)
            .appendField('在这段文字里');
        this.setInputsInline(true);
        this.setOutput(true, 'Number');
        this.setColour(TEXT_HUE);
        this.setTooltip('统计子串出现次数');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['text_replace_all_custom'] = {
    init: function () {
        this.appendValueInput('TEXT')
            .setCheck(null)
            .appendField('把');
        this.appendValueInput('FROM')
            .setCheck(null)
            .appendField('里的');
        this.appendValueInput('TO')
            .setCheck(null)
            .appendField('换成');
        this.setInputsInline(true);
        this.setOutput(true, 'String');
        this.setColour(TEXT_HUE);
        this.setTooltip('替换文本中的所有匹配项');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['text_reverse_custom'] = {
    init: function () {
        this.appendValueInput('TEXT')
            .setCheck(null)
            .appendField('倒转文本');
        this.setInputsInline(true);
        this.setOutput(true, 'String');
        this.setColour(TEXT_HUE);
        this.setTooltip('反转文本');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_values_container'] = {
    init: function () {
        this.appendDummyInput().appendField('初值项');
        this.appendStatementInput('STACK');
        this.setColour(ARRAY_HUE);
        this.contextMenu = false;
    }
};

Blockly.Blocks['array_values_item'] = {
    init: function () {
        this.appendDummyInput().appendField('值');
        this.setPreviousStatement(true);
        this.setNextStatement(true);
        this.setColour(ARRAY_HUE);
        this.contextMenu = false;
    }
};

Blockly.Blocks['array_rows_container'] = {
    init: function () {
        this.appendDummyInput().appendField('行项');
        this.appendStatementInput('STACK');
        this.setColour(ARRAY_HUE);
        this.contextMenu = false;
    }
};

Blockly.Blocks['array_rows_item'] = {
    init: function () {
        this.appendDummyInput().appendField('新增一行');
        this.setPreviousStatement(true);
        this.setNextStatement(true);
        this.setColour(ARRAY_HUE);
        this.contextMenu = false;
    }
};

Blockly.Blocks['array_dims_container'] = {
    init: function () {
        this.appendDummyInput().appendField('维度');
        this.appendStatementInput('STACK');
        this.setColour(ARRAY_HUE);
        this.contextMenu = false;
    }
};

Blockly.Blocks['array_dims_item'] = {
    init: function () {
        this.appendDummyInput().appendField('新增一维');
        this.setPreviousStatement(true);
        this.setNextStatement(true);
        this.setColour(ARRAY_HUE);
        this.contextMenu = false;
    }
};

Blockly.Blocks['array_indices_container'] = {
    init: function () {
        this.appendDummyInput().appendField('下标');
        this.appendStatementInput('STACK');
        this.setColour(ARRAY_HUE);
        this.contextMenu = false;
    }
};

Blockly.Blocks['array_indices_item'] = {
    init: function () {
        this.appendDummyInput().appendField('新增一维下标');
        this.setPreviousStatement(true);
        this.setNextStatement(true);
        this.setColour(ARRAY_HUE);
        this.contextMenu = false;
    }
};

Blockly.Blocks['array_declare_1d_custom'] = {
    init: function () {
        (this as any).itemCount_ = 3;
        this.appendDummyInput('HEAD')
            .appendField('创建一维数组并赋值')
            .appendField(new Blockly.FieldDropdown(VARIABLE_SCOPE_OPTIONS), 'SCOPE')
            .appendField(new Blockly.FieldTextInput('arr1'), 'NAME')
            .appendField('类型')
            .appendField(new Blockly.FieldDropdown(VARIABLE_TYPE_OPTIONS), 'TYPE');
        this.appendValueInput('LEN')
            .setCheck('Number')
            .appendField('长度');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('创建一维数组并赋值，可用齿轮增减初值项');
        this.setHelpUrl('');
        const B: any = Blockly as any;
        if (B?.icons?.MutatorIcon) {
            this.setMutator(new B.icons.MutatorIcon(['array_values_item'], this));
        } else if (B?.MutatorIcon) {
            this.setMutator(new B.MutatorIcon(['array_values_item'], this));
        } else if (B?.Mutator) {
            this.setMutator(new B.Mutator(['array_values_item']));
        }
        (this as any).updateShape_();
        if (!(this as any).isInFlyout) {
            (this as any).ensureValueShadows_();
            (this as any).syncLengthWithItems_();
        }
    },
    mutationToDom: function () {
        const container = Blockly.utils.xml.createElement('mutation');
        container.setAttribute('items', String((this as any).itemCount_ || 0));
        return container;
    },
    domToMutation: function (xmlElement: Element) {
        (this as any).itemCount_ = parseInt(xmlElement.getAttribute('items') || '0', 10);
        (this as any).updateShape_();
        if (!(this as any).isInFlyout) {
            (this as any).ensureValueShadows_();
            (this as any).syncLengthWithItems_();
        }
    },
    decompose: function (workspace: any) {
        const containerBlock = workspace.newBlock('array_values_container');
        containerBlock.initSvg();
        let connection = containerBlock.getInput('STACK').connection;
        for (let i = 0; i < ((this as any).itemCount_ || 0); i++) {
            const itemBlock = workspace.newBlock('array_values_item');
            itemBlock.initSvg();
            connection.connect(itemBlock.previousConnection);
            connection = itemBlock.nextConnection;
        }
        return containerBlock;
    },
    compose: function (containerBlock: any) {
        const oldShadowValues = (this as any).captureValueShadowLiterals_();
        const valueConnections: any[] = [];
        let clauseBlock = containerBlock.getInputTargetBlock('STACK');
        let itemCount = 0;
        while (clauseBlock) {
            if (clauseBlock.type === 'array_values_item') {
                valueConnections.push((clauseBlock as any).valueConnection_);
                itemCount++;
            }
            clauseBlock = clauseBlock.nextConnection && clauseBlock.nextConnection.targetBlock();
        }
        (this as any).itemCount_ = itemCount;
        (this as any).updateShape_();

        const reconnect = (targetConn: any, inputName: string) => {
            if (!targetConn) return;
            try {
                if (typeof targetConn.reconnect === 'function') {
                    targetConn.reconnect(this, inputName);
                    return;
                }
            } catch { }
            const input = this.getInput(inputName);
            if (input?.connection) {
                try { input.connection.connect(targetConn); } catch { }
            }
        };

        for (let i = 0; i < itemCount; i++) {
            reconnect(valueConnections[i], `VALUE${i}`);
        }
        (this as any).ensureValueShadows_(oldShadowValues);
        (this as any).syncLengthWithItems_();
    },
    saveConnections: function (containerBlock: any) {
        let clauseBlock = containerBlock.getInputTargetBlock('STACK');
        let i = 0;
        while (clauseBlock) {
            if (clauseBlock.type === 'array_values_item') {
                const valueInput = this.getInput(`VALUE${i}`);
                (clauseBlock as any).valueConnection_ = valueInput?.connection?.targetConnection || null;
                i++;
            }
            clauseBlock = clauseBlock.nextConnection && clauseBlock.nextConnection.targetBlock();
        }
    },
    isShadowBlock_: function (block: any) {
        if (!block) return false;
        if (typeof block.isShadow === 'function') return !!block.isShadow();
        return !!(block as any).isShadow_;
    },
    setNumberShadow_: function (inputName: string, value: string | number) {
        if ((this as any).isInFlyout) return;
        const input = this.getInput(inputName);
        if (!input?.connection || input.connection.targetBlock()) return;
        const ws = this.workspace;
        if (!ws || typeof ws.newBlock !== 'function') return;
        const shadow = ws.newBlock('math_number');
        if (typeof shadow.setShadow === 'function') shadow.setShadow(true);
        shadow.setFieldValue(String(value), 'NUM');
        if (typeof shadow.initSvg === 'function') shadow.initSvg();
        if (typeof shadow.render === 'function') shadow.render();
        try {
            input.connection.connect(shadow.outputConnection);
        } catch { }
    },
    captureValueShadowLiterals_: function () {
        const values: string[] = [];
        const count = Math.max(0, Number((this as any).itemCount_ || 0));
        for (let i = 0; i < count; i++) {
            const target = this.getInput(`VALUE${i}`)?.connection?.targetBlock();
            if (target && target.type === 'math_number') {
                values[i] = String(target.getFieldValue('NUM') || (i + 1));
            }
        }
        return values;
    },
    ensureValueShadows_: function (fallbackValues?: string[]) {
        if ((this as any).isInFlyout) return;
        const count = Math.max(0, Number((this as any).itemCount_ || 0));
        for (let i = 0; i < count; i++) {
            const input = this.getInput(`VALUE${i}`);
            if (!input?.connection) continue;
            if (input.connection.targetBlock()) continue;
            const fallback = fallbackValues?.[i] ?? String(i + 1);
            (this as any).setNumberShadow_(`VALUE${i}`, fallback);
        }
    },
    syncLengthWithItems_: function () {
        if ((this as any).isInFlyout) return;
        const desired = Math.max(1, Number((this as any).itemCount_ || 0));
        const lenInput = this.getInput('LEN');
        if (!lenInput?.connection) return;
        const lenTarget = lenInput.connection.targetBlock();
        if (!lenTarget) {
            (this as any).setNumberShadow_('LEN', desired);
            return;
        }
        if (lenTarget.type === 'math_number' && (this as any).isShadowBlock_(lenTarget)) {
            lenTarget.setFieldValue(String(desired), 'NUM');
        }
    },
    updateShape_: function () {
        let i = 0;
        while (this.getInput(`VALUE${i}`)) {
            this.removeInput(`VALUE${i}`);
            i++;
        }
        for (let idx = 0; idx < ((this as any).itemCount_ || 0); idx++) {
            this.appendValueInput(`VALUE${idx}`)
                .setCheck(null)
                .appendField(idx === 0 ? '初值' : '');
        }
    }
};

Blockly.Blocks['array_declare_1d_empty_custom'] = {
    init: function () {
        this.appendDummyInput('HEAD')
            .appendField('创建一维数组')
            .appendField(new Blockly.FieldDropdown(VARIABLE_SCOPE_OPTIONS), 'SCOPE')
            .appendField(new Blockly.FieldTextInput('arr1'), 'NAME')
            .appendField('类型')
            .appendField(new Blockly.FieldDropdown(VARIABLE_TYPE_OPTIONS), 'TYPE');
        this.appendValueInput('LEN')
            .setCheck('Number')
            .appendField('长度');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('只声明一维数组（不初始化具体值）');
        this.setHelpUrl('');
        if (!(this as any).isInFlyout) {
            (this as any).setNumberShadow_('LEN', 3);
        }
    },
    setNumberShadow_: function (inputName: string, value: string | number) {
        if ((this as any).isInFlyout) return;
        const input = this.getInput(inputName);
        if (!input?.connection || input.connection.targetBlock()) return;
        const ws = this.workspace;
        if (!ws || typeof ws.newBlock !== 'function') return;
        const shadow = ws.newBlock('math_number');
        if (typeof shadow.setShadow === 'function') shadow.setShadow(true);
        shadow.setFieldValue(String(value), 'NUM');
        if (typeof shadow.initSvg === 'function') shadow.initSvg();
        if (typeof shadow.render === 'function') shadow.render();
        try {
            input.connection.connect(shadow.outputConnection);
        } catch { }
    }
};

Blockly.Blocks['array_length_1d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('获取数组长度')
            .appendField(new Blockly.FieldTextInput('arr1'), 'NAME');
        this.setInputsInline(true);
        this.setOutput(true, 'Number');
        this.setColour(ARRAY_HUE);
        this.setTooltip('获取一维数组长度');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_declare_2d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('创建二维数组')
            .appendField(new Blockly.FieldDropdown(VARIABLE_SCOPE_OPTIONS), 'SCOPE')
            .appendField(new Blockly.FieldTextInput('arr2'), 'NAME')
            .appendField('类型')
            .appendField(new Blockly.FieldDropdown(VARIABLE_TYPE_OPTIONS), 'TYPE')
            .appendField('行')
            .appendField(new Blockly.FieldNumber(2, 1, 1024, 1), 'ROWS')
            .appendField('列')
            .appendField(new Blockly.FieldNumber(2, 1, 1024, 1), 'COLS');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('创建二维数组');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_row_literal_custom'] = {
    init: function () {
        (this as any).itemCount_ = 3;
        this.setInputsInline(true);
        this.setOutput(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('二维数组的一行初值');
        this.setHelpUrl('');
        const B: any = Blockly as any;
        if (B?.icons?.MutatorIcon) {
            this.setMutator(new B.icons.MutatorIcon(['array_values_item'], this));
        } else if (B?.MutatorIcon) {
            this.setMutator(new B.MutatorIcon(['array_values_item'], this));
        } else if (B?.Mutator) {
            this.setMutator(new B.Mutator(['array_values_item']));
        }
        (this as any).updateShape_();
        if (!(this as any).isInFlyout) {
            (this as any).ensureValueShadows_();
        }
    },
    mutationToDom: function () {
        const container = Blockly.utils.xml.createElement('mutation');
        container.setAttribute('items', String((this as any).itemCount_ || 0));
        return container;
    },
    domToMutation: function (xmlElement: Element) {
        (this as any).itemCount_ = parseInt(xmlElement.getAttribute('items') || '0', 10);
        (this as any).updateShape_();
        if (!(this as any).isInFlyout) {
            (this as any).ensureValueShadows_();
        }
    },
    decompose: function (workspace: any) {
        const containerBlock = workspace.newBlock('array_values_container');
        containerBlock.initSvg();
        let connection = containerBlock.getInput('STACK').connection;
        for (let i = 0; i < ((this as any).itemCount_ || 0); i++) {
            const itemBlock = workspace.newBlock('array_values_item');
            itemBlock.initSvg();
            connection.connect(itemBlock.previousConnection);
            connection = itemBlock.nextConnection;
        }
        return containerBlock;
    },
    compose: function (containerBlock: any) {
        const oldShadowValues = (this as any).captureValueShadowLiterals_();
        const valueConnections: any[] = [];
        let clauseBlock = containerBlock.getInputTargetBlock('STACK');
        let itemCount = 0;
        while (clauseBlock) {
            if (clauseBlock.type === 'array_values_item') {
                valueConnections.push((clauseBlock as any).valueConnection_);
                itemCount++;
            }
            clauseBlock = clauseBlock.nextConnection && clauseBlock.nextConnection.targetBlock();
        }
        (this as any).itemCount_ = itemCount;
        (this as any).updateShape_();

        const reconnect = (targetConn: any, inputName: string) => {
            if (!targetConn) return;
            try {
                if (typeof targetConn.reconnect === 'function') {
                    targetConn.reconnect(this, inputName);
                    return;
                }
            } catch { }
            const input = this.getInput(inputName);
            if (input?.connection) {
                try { input.connection.connect(targetConn); } catch { }
            }
        };

        for (let i = 0; i < itemCount; i++) {
            reconnect(valueConnections[i], `VALUE${i}`);
        }
        (this as any).ensureValueShadows_(oldShadowValues);
    },
    saveConnections: function (containerBlock: any) {
        let clauseBlock = containerBlock.getInputTargetBlock('STACK');
        let i = 0;
        while (clauseBlock) {
            if (clauseBlock.type === 'array_values_item') {
                const valueInput = this.getInput(`VALUE${i}`);
                (clauseBlock as any).valueConnection_ = valueInput?.connection?.targetConnection || null;
                i++;
            }
            clauseBlock = clauseBlock.nextConnection && clauseBlock.nextConnection.targetBlock();
        }
    },
    setItemCount_: function (count: number, seed?: number) {
        const next = Math.max(1, Number.isFinite(count) ? Math.floor(count) : 1);
        if ((this as any).itemCount_ !== next) {
            (this as any).itemCount_ = next;
            (this as any).updateShape_();
        }
        (this as any).ensureValueShadows_(seed);
    },
    isShadowBlock_: function (block: any) {
        if (!block) return false;
        if (typeof block.isShadow === 'function') return !!block.isShadow();
        return !!(block as any).isShadow_;
    },
    setNumberShadow_: function (inputName: string, value: string | number) {
        if ((this as any).isInFlyout) return;
        const input = this.getInput(inputName);
        if (!input?.connection || input.connection.targetBlock()) return;
        const ws = this.workspace;
        if (!ws || typeof ws.newBlock !== 'function') return;
        const shadow = ws.newBlock('math_number');
        if (typeof shadow.setShadow === 'function') shadow.setShadow(true);
        shadow.setFieldValue(String(value), 'NUM');
        if (typeof shadow.initSvg === 'function') shadow.initSvg();
        if (typeof shadow.render === 'function') shadow.render();
        try {
            input.connection.connect(shadow.outputConnection);
        } catch { }
    },
    captureValueShadowLiterals_: function () {
        const values: string[] = [];
        const count = Math.max(0, Number((this as any).itemCount_ || 0));
        for (let i = 0; i < count; i++) {
            const target = this.getInput(`VALUE${i}`)?.connection?.targetBlock();
            if (target && target.type === 'math_number') {
                values[i] = String(target.getFieldValue('NUM') || i);
            }
        }
        return values;
    },
    ensureValueShadows_: function (seedOrFallback?: number | string[]) {
        if ((this as any).isInFlyout) return;
        const count = Math.max(0, Number((this as any).itemCount_ || 0));
        const fallbackValues = Array.isArray(seedOrFallback) ? seedOrFallback : null;
        const base = Number.isFinite(seedOrFallback as any) ? Number(seedOrFallback) : 0;
        for (let i = 0; i < count; i++) {
            const input = this.getInput(`VALUE${i}`);
            if (!input?.connection || input.connection.targetBlock()) continue;
            const fallback = fallbackValues?.[i] ?? String(base + i);
            (this as any).setNumberShadow_(`VALUE${i}`, fallback);
        }
    },
    updateShape_: function () {
        let i = 0;
        while (this.getInput(`VALUE${i}`)) {
            this.removeInput(`VALUE${i}`);
            i++;
        }
        if (this.getInput('TAIL')) this.removeInput('TAIL');
        for (let idx = 0; idx < ((this as any).itemCount_ || 0); idx++) {
            this.appendValueInput(`VALUE${idx}`)
                .setCheck(null)
                .appendField(idx === 0 ? '{' : ',');
        }
        this.appendDummyInput('TAIL').appendField('}');
    }
};

Blockly.Blocks['array_declare_2d_init_custom'] = {
    init: function () {
        (this as any).itemCount_ = (this as any).isInFlyout ? 0 : 1;
        this.appendDummyInput('HEAD')
            .appendField('创建二维数组并赋值')
            .appendField(new Blockly.FieldDropdown(VARIABLE_SCOPE_OPTIONS), 'SCOPE')
            .appendField(new Blockly.FieldTextInput('arr2'), 'NAME')
            .appendField('类型')
            .appendField(new Blockly.FieldDropdown(VARIABLE_TYPE_OPTIONS), 'TYPE');
        this.appendValueInput('ROWS')
            .setCheck('Number')
            .appendField('行');
        this.appendValueInput('COLS')
            .setCheck('Number')
            .appendField('列');
        this.setInputsInline(false);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('创建二维数组并按行初始化（齿轮增减行项）');
        this.setHelpUrl('');
        const B: any = Blockly as any;
        if (B?.icons?.MutatorIcon) {
            this.setMutator(new B.icons.MutatorIcon(['array_rows_item'], this));
        } else if (B?.MutatorIcon) {
            this.setMutator(new B.MutatorIcon(['array_rows_item'], this));
        } else if (B?.Mutator) {
            this.setMutator(new B.Mutator(['array_rows_item']));
        }
        (this as any).updateShape_();
        if (!(this as any).isInFlyout) {
            (this as any).setNumberShadow_('COLS', 3);
            (this as any).ensureRowShadows_();
            (this as any).syncRowsWithItems_();
        }
    },
    mutationToDom: function () {
        const container = Blockly.utils.xml.createElement('mutation');
        container.setAttribute('rows', String((this as any).itemCount_ || 0));
        return container;
    },
    domToMutation: function (xmlElement: Element) {
        (this as any).itemCount_ = parseInt(xmlElement.getAttribute('rows') || '0', 10);
        (this as any).updateShape_();
        if (!(this as any).isInFlyout) {
            (this as any).setNumberShadow_('COLS', 3);
            (this as any).ensureRowShadows_();
            (this as any).syncRowsWithItems_();
        }
    },
    decompose: function (workspace: any) {
        const containerBlock = workspace.newBlock('array_rows_container');
        containerBlock.initSvg();
        let connection = containerBlock.getInput('STACK').connection;
        for (let i = 0; i < ((this as any).itemCount_ || 0); i++) {
            const itemBlock = workspace.newBlock('array_rows_item');
            itemBlock.initSvg();
            connection.connect(itemBlock.previousConnection);
            connection = itemBlock.nextConnection;
        }
        return containerBlock;
    },
    compose: function (containerBlock: any) {
        const rowConnections: any[] = [];
        let clauseBlock = containerBlock.getInputTargetBlock('STACK');
        let rowCount = 0;
        while (clauseBlock) {
            if (clauseBlock.type === 'array_rows_item') {
                rowConnections.push((clauseBlock as any).valueConnection_);
                rowCount++;
            }
            clauseBlock = clauseBlock.nextConnection && clauseBlock.nextConnection.targetBlock();
        }
        (this as any).itemCount_ = rowCount;
        (this as any).updateShape_();

        const reconnect = (targetConn: any, inputName: string) => {
            if (!targetConn) return;
            try {
                if (typeof targetConn.reconnect === 'function') {
                    targetConn.reconnect(this, inputName);
                    return;
                }
            } catch { }
            const input = this.getInput(inputName);
            if (input?.connection) {
                try { input.connection.connect(targetConn); } catch { }
            }
        };
        for (let i = 0; i < rowCount; i++) {
            reconnect(rowConnections[i], `ROW${i}`);
        }
        (this as any).setNumberShadow_('COLS', 3);
        (this as any).ensureRowShadows_();
        (this as any).syncRowsWithItems_();
    },
    saveConnections: function (containerBlock: any) {
        let clauseBlock = containerBlock.getInputTargetBlock('STACK');
        let i = 0;
        while (clauseBlock) {
            if (clauseBlock.type === 'array_rows_item') {
                const rowInput = this.getInput(`ROW${i}`);
                (clauseBlock as any).valueConnection_ = rowInput?.connection?.targetConnection || null;
                i++;
            }
            clauseBlock = clauseBlock.nextConnection && clauseBlock.nextConnection.targetBlock();
        }
    },
    isShadowBlock_: function (block: any) {
        if (!block) return false;
        if (typeof block.isShadow === 'function') return !!block.isShadow();
        return !!(block as any).isShadow_;
    },
    setNumberShadow_: function (inputName: string, value: string | number) {
        if ((this as any).isInFlyout) return;
        const input = this.getInput(inputName);
        if (!input?.connection || input.connection.targetBlock()) return;
        const ws = this.workspace;
        if (!ws || typeof ws.newBlock !== 'function') return;
        const shadow = ws.newBlock('math_number');
        if (typeof shadow.setShadow === 'function') shadow.setShadow(true);
        shadow.setFieldValue(String(value), 'NUM');
        if (typeof shadow.initSvg === 'function') shadow.initSvg();
        if (typeof shadow.render === 'function') shadow.render();
        try {
            input.connection.connect(shadow.outputConnection);
        } catch { }
    },
    inferCols_: function () {
        const colsInput = this.getInput('COLS');
        const colsTarget = colsInput?.connection?.targetBlock();
        if (colsTarget?.type === 'math_number') {
            const parsed = parseInt(colsTarget.getFieldValue('NUM') || '3', 10);
            if (Number.isFinite(parsed) && parsed > 0) return parsed;
        }
        return 3;
    },
    ensureRowShadows_: function () {
        if ((this as any).isInFlyout) return;
        const count = Math.max(0, Number((this as any).itemCount_ || 0));
        const colCount = Math.max(1, Number((this as any).inferCols_()));
        const ws = this.workspace;
        if (!ws || typeof ws.newBlock !== 'function') return;
        for (let i = 0; i < count; i++) {
            const input = this.getInput(`ROW${i}`);
            if (!input?.connection) continue;
            const target = input.connection.targetBlock();
            if (!target) {
                const rowShadow = ws.newBlock('array_row_literal_custom');
                if (typeof rowShadow.setShadow === 'function') rowShadow.setShadow(true);
                if (typeof (rowShadow as any).setItemCount_ === 'function') {
                    (rowShadow as any).setItemCount_(colCount, i);
                }
                if (typeof rowShadow.initSvg === 'function') rowShadow.initSvg();
                if (typeof rowShadow.render === 'function') rowShadow.render();
                try {
                    input.connection.connect(rowShadow.outputConnection);
                } catch { }
                continue;
            }
            if (target.type === 'array_row_literal_custom' && (this as any).isShadowBlock_(target)) {
                if (typeof (target as any).setItemCount_ === 'function') {
                    (target as any).setItemCount_(colCount, i);
                }
            }
        }
    },
    syncRowsWithItems_: function () {
        if ((this as any).isInFlyout) return;
        const desired = Math.max(1, Number((this as any).itemCount_ || 0));
        const rowsInput = this.getInput('ROWS');
        if (!rowsInput?.connection) return;
        const rowsTarget = rowsInput.connection.targetBlock();
        if (!rowsTarget) {
            (this as any).setNumberShadow_('ROWS', desired);
            return;
        }
        if (rowsTarget.type === 'math_number' && (this as any).isShadowBlock_(rowsTarget)) {
            rowsTarget.setFieldValue(String(desired), 'NUM');
        }
    },
    updateShape_: function () {
        let i = 0;
        while (this.getInput(`ROW${i}`)) {
            this.removeInput(`ROW${i}`);
            i++;
        }
        for (let idx = 0; idx < ((this as any).itemCount_ || 0); idx++) {
            this.appendValueInput(`ROW${idx}`)
                .setCheck(null)
                .appendField(idx === 0 ? '并赋值' : '');
        }
    }
};

Blockly.Blocks['array_declare_3d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('创建三维数组')
            .appendField(new Blockly.FieldDropdown(VARIABLE_SCOPE_OPTIONS), 'SCOPE')
            .appendField(new Blockly.FieldTextInput('arr3'), 'NAME')
            .appendField('类型')
            .appendField(new Blockly.FieldDropdown(VARIABLE_TYPE_OPTIONS), 'TYPE')
            .appendField('维1')
            .appendField(new Blockly.FieldNumber(2, 1, 128, 1), 'D1')
            .appendField('维2')
            .appendField(new Blockly.FieldNumber(2, 1, 128, 1), 'D2')
            .appendField('维3')
            .appendField(new Blockly.FieldNumber(2, 1, 128, 1), 'D3');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('创建三维数组');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_declare_nd_custom'] = {
    init: function () {
        (this as any).dimCount_ = 4;
        this.appendDummyInput('HEAD')
            .appendField('创建多维数组')
            .appendField(new Blockly.FieldDropdown(VARIABLE_SCOPE_OPTIONS), 'SCOPE')
            .appendField(new Blockly.FieldTextInput('arrN'), 'NAME')
            .appendField('类型')
            .appendField(new Blockly.FieldDropdown(VARIABLE_TYPE_OPTIONS), 'TYPE');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('创建任意维数组（齿轮增减维度）');
        this.setHelpUrl('');
        const B: any = Blockly as any;
        if (B?.icons?.MutatorIcon) {
            this.setMutator(new B.icons.MutatorIcon(['array_dims_item'], this));
        } else if (B?.MutatorIcon) {
            this.setMutator(new B.MutatorIcon(['array_dims_item'], this));
        } else if (B?.Mutator) {
            this.setMutator(new B.Mutator(['array_dims_item']));
        }
        (this as any).updateShape_();
    },
    mutationToDom: function () {
        const container = Blockly.utils.xml.createElement('mutation');
        container.setAttribute('dims', String((this as any).dimCount_ || 2));
        return container;
    },
    domToMutation: function (xmlElement: Element) {
        (this as any).dimCount_ = Math.max(2, parseInt(xmlElement.getAttribute('dims') || '2', 10));
        (this as any).updateShape_();
    },
    decompose: function (workspace: any) {
        const containerBlock = workspace.newBlock('array_dims_container');
        containerBlock.initSvg();
        let connection = containerBlock.getInput('STACK').connection;
        for (let i = 0; i < ((this as any).dimCount_ || 2); i++) {
            const itemBlock = workspace.newBlock('array_dims_item');
            itemBlock.initSvg();
            connection.connect(itemBlock.previousConnection);
            connection = itemBlock.nextConnection;
        }
        return containerBlock;
    },
    compose: function (containerBlock: any) {
        const oldCount = (this as any).dimCount_ || 2;
        const oldValues: number[] = [];
        for (let i = 0; i < oldCount; i++) {
            const v = parseInt(this.getFieldValue(`DIMVAL${i}`) || '2', 10);
            oldValues.push(Number.isFinite(v) && v > 0 ? v : 2);
        }
        let clauseBlock = containerBlock.getInputTargetBlock('STACK');
        let dimCount = 0;
        while (clauseBlock) {
            if (clauseBlock.type === 'array_dims_item') dimCount++;
            clauseBlock = clauseBlock.nextConnection && clauseBlock.nextConnection.targetBlock();
        }
        (this as any).dimCount_ = Math.max(2, dimCount);
        (this as any).updateShape_(oldValues);
    },
    updateShape_: function (oldValues?: number[]) {
        let i = 0;
        while (this.getInput(`DIM${i}`)) {
            this.removeInput(`DIM${i}`);
            i++;
        }
        for (let idx = 0; idx < ((this as any).dimCount_ || 2); idx++) {
            const fallback = oldValues && oldValues[idx] ? oldValues[idx] : 2;
            this.appendDummyInput(`DIM${idx}`)
                .appendField(`第${idx + 1}维长度`)
                .appendField(new Blockly.FieldNumber(fallback, 1, 1024, 1), `DIMVAL${idx}`);
        }
    }
};

Blockly.Blocks['array_get_1d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('读取数组')
            .appendField(new Blockly.FieldTextInput('arr1'), 'NAME');
        this.appendValueInput('IDX')
            .setCheck('Number')
            .appendField('下标');
        this.setInputsInline(true);
        this.setOutput(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('读取一维数组元素');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_set_1d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('写入数组')
            .appendField(new Blockly.FieldTextInput('arr1'), 'NAME');
        this.appendValueInput('IDX')
            .setCheck('Number')
            .appendField('下标');
        this.appendValueInput('VALUE')
            .setCheck(null)
            .appendField('值');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('写入一维数组元素');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_push_1d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('数组')
            .appendField(new Blockly.FieldTextInput('arr1'), 'NAME')
            .appendField('末尾添加');
        this.appendValueInput('VALUE')
            .setCheck(null)
            .appendField('值');
        this.appendDummyInput()
            .appendField('长度变量')
            .appendField(new Blockly.FieldTextInput('arr1_len'), 'LEN_VAR');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('向一维数组末尾添加元素（长度变量会自动 +1，超出容量时不添加）');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_insert_1d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('数组')
            .appendField(new Blockly.FieldTextInput('arr1'), 'NAME')
            .appendField('在下标');
        this.appendValueInput('IDX')
            .setCheck('Number');
        this.appendValueInput('VALUE')
            .setCheck(null)
            .appendField('插入值');
        this.appendDummyInput()
            .appendField('长度变量')
            .appendField(new Blockly.FieldTextInput('arr1_len'), 'LEN_VAR');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('在指定下标插入元素，后续元素右移（长度变量会自动 +1）');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_remove_1d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('数组')
            .appendField(new Blockly.FieldTextInput('arr1'), 'NAME')
            .appendField('删除下标');
        this.appendValueInput('IDX')
            .setCheck('Number');
        this.appendDummyInput()
            .appendField('长度变量')
            .appendField(new Blockly.FieldTextInput('arr1_len'), 'LEN_VAR');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('删除指定下标元素，后续元素左移（长度变量会自动 -1）');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_clear_1d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('清空数组')
            .appendField(new Blockly.FieldTextInput('arr1'), 'NAME')
            .appendField('长度变量')
            .appendField(new Blockly.FieldTextInput('arr1_len'), 'LEN_VAR');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('将数组逻辑长度清零（不改变底层容量）');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_find_1d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('在数组')
            .appendField(new Blockly.FieldTextInput('arr1'), 'NAME')
            .appendField('中查找');
        this.appendValueInput('VALUE')
            .setCheck(null)
            .appendField('值');
        this.appendDummyInput()
            .appendField('长度变量')
            .appendField(new Blockly.FieldTextInput('arr1_len'), 'LEN_VAR');
        this.setInputsInline(true);
        this.setOutput(true, 'Number');
        this.setColour(ARRAY_HUE);
        this.setTooltip('返回值所在下标，找不到返回 -1');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_contains_1d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('数组')
            .appendField(new Blockly.FieldTextInput('arr1'), 'NAME')
            .appendField('包含');
        this.appendValueInput('VALUE')
            .setCheck(null)
            .appendField('值');
        this.appendDummyInput()
            .appendField('长度变量')
            .appendField(new Blockly.FieldTextInput('arr1_len'), 'LEN_VAR');
        this.setInputsInline(true);
        this.setOutput(true, ['Boolean', 'Number']);
        this.setColour(ARRAY_HUE);
        this.setTooltip('判断数组中是否包含该值');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_sort_1d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('数组')
            .appendField(new Blockly.FieldTextInput('arr1'), 'NAME')
            .appendField(new Blockly.FieldDropdown(ARRAY_SORT_ORDER_OPTIONS), 'ORDER')
            .appendField('排序');
        this.appendDummyInput()
            .appendField('长度变量')
            .appendField(new Blockly.FieldTextInput('arr1_len'), 'LEN_VAR');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('按当前长度对一维数组排序');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_reverse_1d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('反转数组')
            .appendField(new Blockly.FieldTextInput('arr1'), 'NAME');
        this.appendDummyInput()
            .appendField('长度变量')
            .appendField(new Blockly.FieldTextInput('arr1_len'), 'LEN_VAR');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('按当前长度反转一维数组');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_fill_1d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('数组')
            .appendField(new Blockly.FieldTextInput('arr1'), 'NAME')
            .appendField('全部填充为');
        this.appendValueInput('VALUE')
            .setCheck(null);
        this.appendDummyInput()
            .appendField('长度变量')
            .appendField(new Blockly.FieldTextInput('arr1_len'), 'LEN_VAR');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('将数组逻辑长度范围内的元素全部设为同一值');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_copy_1d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('复制数组')
            .appendField(new Blockly.FieldTextInput('arr1'), 'SRC_NAME')
            .appendField('到')
            .appendField(new Blockly.FieldTextInput('copyList'), 'DST_NAME');
        this.appendDummyInput()
            .appendField('源长度')
            .appendField(new Blockly.FieldTextInput('arr1_len'), 'SRC_LEN_VAR')
            .appendField('目标长度')
            .appendField(new Blockly.FieldTextInput('copyList_len'), 'DST_LEN_VAR');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('复制源数组到目标数组，目标长度自动更新（受目标容量限制）');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_rotate_1d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('数组')
            .appendField(new Blockly.FieldTextInput('arr1'), 'NAME')
            .appendField('循环')
            .appendField(new Blockly.FieldDropdown(ARRAY_ROTATE_DIR_OPTIONS), 'DIR');
        this.appendValueInput('STEP')
            .setCheck('Number')
            .appendField('步数');
        this.appendDummyInput()
            .appendField('长度变量')
            .appendField(new Blockly.FieldTextInput('arr1_len'), 'LEN_VAR');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('按当前长度循环左移/右移指定步数');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_get_2d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('读取二维数组')
            .appendField(new Blockly.FieldTextInput('arr2'), 'NAME');
        this.appendValueInput('I')
            .setCheck('Number')
            .appendField('行');
        this.appendValueInput('J')
            .setCheck('Number')
            .appendField('列');
        this.setInputsInline(true);
        this.setOutput(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('读取二维数组元素');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_set_2d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('写入二维数组')
            .appendField(new Blockly.FieldTextInput('arr2'), 'NAME');
        this.appendValueInput('I')
            .setCheck('Number')
            .appendField('行');
        this.appendValueInput('J')
            .setCheck('Number')
            .appendField('列');
        this.appendValueInput('VALUE')
            .setCheck(null)
            .appendField('值');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('写入二维数组元素');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_push_row_2d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('二维数组')
            .appendField(new Blockly.FieldTextInput('arr2'), 'NAME')
            .appendField('末尾添加一行');
        this.appendValueInput('VALUE')
            .setCheck(null)
            .appendField('行值');
        this.appendDummyInput()
            .appendField('行数变量')
            .appendField(new Blockly.FieldTextInput('arr2_rows'), 'ROWS_VAR');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('向二维数组末尾添加一行（可接入 {a,b,c} 行值；若接入单值则整行填充该值）');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_insert_row_2d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('二维数组')
            .appendField(new Blockly.FieldTextInput('arr2'), 'NAME')
            .appendField('在行');
        this.appendValueInput('ROW_IDX')
            .setCheck('Number')
            .appendField('下标');
        this.appendValueInput('VALUE')
            .setCheck(null)
            .appendField('插入行值');
        this.appendDummyInput()
            .appendField('行数变量')
            .appendField(new Blockly.FieldTextInput('arr2_rows'), 'ROWS_VAR');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('在指定行插入一行（可接入 {a,b,c} 行值；若接入单值则整行填充该值）');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_remove_row_2d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('二维数组')
            .appendField(new Blockly.FieldTextInput('arr2'), 'NAME')
            .appendField('删除行下标');
        this.appendValueInput('ROW_IDX')
            .setCheck('Number');
        this.appendDummyInput()
            .appendField('行数变量')
            .appendField(new Blockly.FieldTextInput('arr2_rows'), 'ROWS_VAR');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('删除指定行（后续行上移，行数变量自动 -1）');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_contains_2d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('二维数组')
            .appendField(new Blockly.FieldTextInput('arr2'), 'NAME')
            .appendField('包含值');
        this.appendValueInput('VALUE')
            .setCheck(null);
        this.appendDummyInput()
            .appendField('行数变量')
            .appendField(new Blockly.FieldTextInput('arr2_rows'), 'ROWS_VAR');
        this.setInputsInline(true);
        this.setOutput(true, ['Boolean', 'Number']);
        this.setColour(ARRAY_HUE);
        this.setTooltip('判断二维数组是否包含指定值');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_find_2d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('查找二维数组')
            .appendField(new Blockly.FieldTextInput('arr2'), 'NAME')
            .appendField('值');
        this.appendValueInput('VALUE')
            .setCheck(null);
        this.appendDummyInput()
            .appendField('行数变量')
            .appendField(new Blockly.FieldTextInput('arr2_rows'), 'ROWS_VAR')
            .appendField('返回线性下标');
        this.setInputsInline(true);
        this.setOutput(true, 'Number');
        this.setColour(ARRAY_HUE);
        this.setTooltip('返回首个匹配元素的线性下标（row * 列数 + col），找不到返回 -1');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_get_3d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('读取三维数组')
            .appendField(new Blockly.FieldTextInput('arr3'), 'NAME');
        this.appendValueInput('I')
            .setCheck('Number')
            .appendField('维1');
        this.appendValueInput('J')
            .setCheck('Number')
            .appendField('维2');
        this.appendValueInput('K')
            .setCheck('Number')
            .appendField('维3');
        this.setInputsInline(true);
        this.setOutput(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('读取三维数组元素');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_set_3d_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('写入三维数组')
            .appendField(new Blockly.FieldTextInput('arr3'), 'NAME');
        this.appendValueInput('I')
            .setCheck('Number')
            .appendField('维1');
        this.appendValueInput('J')
            .setCheck('Number')
            .appendField('维2');
        this.appendValueInput('K')
            .setCheck('Number')
            .appendField('维3');
        this.appendValueInput('VALUE')
            .setCheck(null)
            .appendField('值');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('写入三维数组元素');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['array_get_nd_custom'] = {
    init: function () {
        (this as any).indexCount_ = 4;
        this.appendDummyInput('HEAD')
            .appendField('读取多维数组')
            .appendField(new Blockly.FieldTextInput('arrN'), 'NAME');
        this.setInputsInline(true);
        this.setOutput(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('读取多维数组元素（齿轮增减下标）');
        this.setHelpUrl('');
        const B: any = Blockly as any;
        if (B?.icons?.MutatorIcon) {
            this.setMutator(new B.icons.MutatorIcon(['array_indices_item'], this));
        } else if (B?.MutatorIcon) {
            this.setMutator(new B.MutatorIcon(['array_indices_item'], this));
        } else if (B?.Mutator) {
            this.setMutator(new B.Mutator(['array_indices_item']));
        }
        (this as any).updateShape_();
    },
    mutationToDom: function () {
        const container = Blockly.utils.xml.createElement('mutation');
        container.setAttribute('indices', String((this as any).indexCount_ || 2));
        return container;
    },
    domToMutation: function (xmlElement: Element) {
        (this as any).indexCount_ = Math.max(2, parseInt(xmlElement.getAttribute('indices') || '2', 10));
        (this as any).updateShape_();
    },
    decompose: function (workspace: any) {
        const containerBlock = workspace.newBlock('array_indices_container');
        containerBlock.initSvg();
        let connection = containerBlock.getInput('STACK').connection;
        for (let i = 0; i < ((this as any).indexCount_ || 2); i++) {
            const itemBlock = workspace.newBlock('array_indices_item');
            itemBlock.initSvg();
            connection.connect(itemBlock.previousConnection);
            connection = itemBlock.nextConnection;
        }
        return containerBlock;
    },
    compose: function (containerBlock: any) {
        const indexConnections: any[] = [];
        let clauseBlock = containerBlock.getInputTargetBlock('STACK');
        let indexCount = 0;
        while (clauseBlock) {
            if (clauseBlock.type === 'array_indices_item') {
                indexConnections.push((clauseBlock as any).valueConnection_);
                indexCount++;
            }
            clauseBlock = clauseBlock.nextConnection && clauseBlock.nextConnection.targetBlock();
        }
        (this as any).indexCount_ = Math.max(2, indexCount);
        (this as any).updateShape_();

        const reconnect = (targetConn: any, inputName: string) => {
            if (!targetConn) return;
            try {
                if (typeof targetConn.reconnect === 'function') {
                    targetConn.reconnect(this, inputName);
                    return;
                }
            } catch { }
            const input = this.getInput(inputName);
            if (input?.connection) {
                try { input.connection.connect(targetConn); } catch { }
            }
        };

        for (let i = 0; i < ((this as any).indexCount_ || 0); i++) {
            reconnect(indexConnections[i], `IDX${i}`);
        }
    },
    saveConnections: function (containerBlock: any) {
        let clauseBlock = containerBlock.getInputTargetBlock('STACK');
        let i = 0;
        while (clauseBlock) {
            if (clauseBlock.type === 'array_indices_item') {
                const idxInput = this.getInput(`IDX${i}`);
                (clauseBlock as any).valueConnection_ = idxInput?.connection?.targetConnection || null;
                i++;
            }
            clauseBlock = clauseBlock.nextConnection && clauseBlock.nextConnection.targetBlock();
        }
    },
    updateShape_: function () {
        let i = 0;
        while (this.getInput(`IDX${i}`)) {
            this.removeInput(`IDX${i}`);
            i++;
        }
        for (let idx = 0; idx < ((this as any).indexCount_ || 2); idx++) {
            this.appendValueInput(`IDX${idx}`)
                .setCheck('Number')
                .appendField(`第${idx + 1}维下标`);
        }
    }
};

Blockly.Blocks['array_set_nd_custom'] = {
    init: function () {
        (this as any).indexCount_ = 4;
        this.appendDummyInput('HEAD')
            .appendField('写入多维数组')
            .appendField(new Blockly.FieldTextInput('arrN'), 'NAME');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(ARRAY_HUE);
        this.setTooltip('写入多维数组元素（齿轮增减下标）');
        this.setHelpUrl('');
        const B: any = Blockly as any;
        if (B?.icons?.MutatorIcon) {
            this.setMutator(new B.icons.MutatorIcon(['array_indices_item'], this));
        } else if (B?.MutatorIcon) {
            this.setMutator(new B.MutatorIcon(['array_indices_item'], this));
        } else if (B?.Mutator) {
            this.setMutator(new B.Mutator(['array_indices_item']));
        }
        (this as any).updateShape_();
    },
    mutationToDom: function () {
        const container = Blockly.utils.xml.createElement('mutation');
        container.setAttribute('indices', String((this as any).indexCount_ || 2));
        return container;
    },
    domToMutation: function (xmlElement: Element) {
        (this as any).indexCount_ = Math.max(2, parseInt(xmlElement.getAttribute('indices') || '2', 10));
        (this as any).updateShape_();
    },
    decompose: function (workspace: any) {
        const containerBlock = workspace.newBlock('array_indices_container');
        containerBlock.initSvg();
        let connection = containerBlock.getInput('STACK').connection;
        for (let i = 0; i < ((this as any).indexCount_ || 2); i++) {
            const itemBlock = workspace.newBlock('array_indices_item');
            itemBlock.initSvg();
            connection.connect(itemBlock.previousConnection);
            connection = itemBlock.nextConnection;
        }
        return containerBlock;
    },
    compose: function (containerBlock: any) {
        const indexConnections: any[] = [];
        const valueConnection = this.getInput('VALUE')?.connection?.targetConnection || null;
        let clauseBlock = containerBlock.getInputTargetBlock('STACK');
        let indexCount = 0;
        while (clauseBlock) {
            if (clauseBlock.type === 'array_indices_item') {
                indexConnections.push((clauseBlock as any).valueConnection_);
                indexCount++;
            }
            clauseBlock = clauseBlock.nextConnection && clauseBlock.nextConnection.targetBlock();
        }
        (this as any).indexCount_ = Math.max(2, indexCount);
        (this as any).updateShape_();

        const reconnect = (targetConn: any, inputName: string) => {
            if (!targetConn) return;
            try {
                if (typeof targetConn.reconnect === 'function') {
                    targetConn.reconnect(this, inputName);
                    return;
                }
            } catch { }
            const input = this.getInput(inputName);
            if (input?.connection) {
                try { input.connection.connect(targetConn); } catch { }
            }
        };

        for (let i = 0; i < ((this as any).indexCount_ || 0); i++) {
            reconnect(indexConnections[i], `IDX${i}`);
        }
        reconnect(valueConnection, 'VALUE');
    },
    saveConnections: function (containerBlock: any) {
        let clauseBlock = containerBlock.getInputTargetBlock('STACK');
        let i = 0;
        while (clauseBlock) {
            if (clauseBlock.type === 'array_indices_item') {
                const idxInput = this.getInput(`IDX${i}`);
                (clauseBlock as any).valueConnection_ = idxInput?.connection?.targetConnection || null;
                i++;
            }
            clauseBlock = clauseBlock.nextConnection && clauseBlock.nextConnection.targetBlock();
        }
    },
    updateShape_: function () {
        let i = 0;
        while (this.getInput(`IDX${i}`)) {
            this.removeInput(`IDX${i}`);
            i++;
        }
        if (this.getInput('VALUE')) this.removeInput('VALUE');
        for (let idx = 0; idx < ((this as any).indexCount_ || 2); idx++) {
            this.appendValueInput(`IDX${idx}`)
                .setCheck('Number')
                .appendField(`第${idx + 1}维下标`);
        }
        this.appendValueInput('VALUE')
            .setCheck(null)
            .appendField('值');
    }
};

Blockly.Blocks['set_pin_mode'] = {
    init: function () {
        this.appendValueInput("PIN")
            .setCheck(null)
            .appendField("管脚模式");
        this.appendDummyInput()
            .appendField("设置为")
            .appendField(new Blockly.FieldDropdown([["输出", "OUTPUT"], ["输入", "INPUT"], ["上拉输入", "INPUT_PULLUP"]]), "MODE");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(180); // Teal-like hardware tone
        this.setTooltip("设置引脚输入输出模式");
        this.setHelpUrl("");
    }
};

Blockly.Blocks['write_digital'] = {
    init: function () {
        this.appendValueInput('PIN')
            .setCheck(['Number', 'String'])
            .appendField('\u6570\u5b57\u8f93\u51fa');
        this.appendValueInput('LEVEL')
            .setCheck(['Number', 'String'])
            .appendField('\u7535\u5e73');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(180); // Teal-like hardware tone
        this.setTooltip('');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

// IO level output block (for compatibility with classic hardware toolbox)
Blockly.Blocks['io_level'] = {
    init: function () {
        this.appendDummyInput()
            .appendField(new Blockly.FieldDropdown(IO_LEVEL_OPTIONS), 'LEVEL');
        // Keep this block in oval reporter shape (avoid hex boolean shape).
        // Use wildcard output to maximize compatibility with third-party shadow connections.
        this.setOutput(true, null);
        const roundShapeKey = String.fromCharCode(
            79, 85, 84, 80, 85, 84, 95, 83, 72, 65, 80, 69, 95, 82, 79, 85, 78, 68,
        );
        const roundShape = (Blockly as any)[roundShapeKey];
        if (typeof (this as any).setOutputShape === 'function' && roundShape !== undefined) {
            (this as any).setOutputShape(roundShape);
        }
        this.setColour(180);
        this.setTooltip('数字电平常量');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['io_digital_write'] = {
    init: function () {
        this.appendValueInput('PIN')
            .setCheck(['Number', 'String'])
            .appendField('\u6570\u5b57\u8f93\u51fa \u7ba1\u811a #');
        this.appendValueInput('LEVEL')
            .setCheck(['Number', 'String'])
            .appendField('\u8bbe\u4e3a');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(180);
        this.setTooltip('\u8bbe\u7f6e\u6570\u5b57\u8f93\u51fa\u7535\u5e73');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

Blockly.Blocks['io_digital_read'] = {
    init: function () {
        this.appendValueInput('PIN')
            .setCheck(['Number', 'String'])
            .appendField('数字输入 管脚 #');
        this.setOutput(true, ['Boolean', 'Number']);
        this.setColour(180);
        this.setTooltip('读取数字输入电平');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

Blockly.Blocks['io_analog_write'] = {
    init: function () {
        this.appendValueInput('PIN')
            .setCheck(['Number', 'String'])
            .appendField('模拟输出 管脚 #');
        this.appendValueInput('VALUE')
            .setCheck('Number')
            .appendField('赋值为');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(180);
        this.setTooltip('模拟输出/PWM 写入 (0-255)');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

Blockly.Blocks['io_analog_read'] = {
    init: function () {
        this.appendValueInput('PIN')
            .setCheck(['Number', 'String'])
            .appendField('模拟输入 管脚 #');
        this.setOutput(true, 'Number');
        this.setColour(180);
        this.setTooltip('读取模拟输入值');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

Blockly.Blocks['io_soft_pwm_write'] = {
    init: function () {
        this.appendValueInput('PIN')
            .setCheck(['Number', 'String'])
            .appendField('软件模拟输出 管脚 #');
        this.appendValueInput('VALUE')
            .setCheck('Number')
            .appendField('赋值为');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(180);
        this.setTooltip('软件 PWM 输出 (0-255)');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

Blockly.Blocks['io_soft_pwm_stop'] = {
    init: function () {
        this.appendValueInput('PIN')
            .setCheck(['Number', 'String'])
            .appendField('取消软件模拟输出 管脚 #');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(180);
        this.setTooltip('停止软件 PWM 输出');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

Blockly.Blocks['io_multi_button_event'] = {
    init: function () {
        this.appendValueInput('PIN')
            .setCheck(['Number', 'String'])
            .appendField('\u591a\u529f\u80fd\u6309\u952e \u7ba1\u811a #');
        this.appendDummyInput()
            .appendField(new Blockly.FieldDropdown(BUTTON_EVENT_OPTIONS), 'EVENT')
            .appendField('\u7535\u5e73\u89e6\u53d1');
        this.appendValueInput('LEVEL')
            .setCheck(['Number', 'String']);
        this.appendStatementInput('DO')
            .setCheck(null)
            .appendField('\u6267\u884c');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(180);
        this.setTooltip('\u6309\u952e\u4e8b\u4ef6\u89e6\u53d1\uff1a\u5355\u51fb/\u53cc\u51fb/\u957f\u6309');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

Blockly.Blocks['io_hardware_interrupt_event'] = {
    init: function () {
        this.appendValueInput('PIN')
            .setCheck(['Number', 'String'])
            .appendField('硬件中断 管脚 #');
        this.appendDummyInput()
            .appendField('模式')
            .appendField(new Blockly.FieldDropdown(INTERRUPT_MODE_OPTIONS), 'MODE');
        this.appendStatementInput('DO')
            .setCheck(null)
            .appendField('执行');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(180);
        this.setTooltip('硬件中断触发执行');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

Blockly.Blocks['io_hardware_interrupt_detach'] = {
    init: function () {
        this.appendValueInput('PIN')
            .setCheck(['Number', 'String'])
            .appendField('取消硬件中断 管脚 #');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(180);
        this.setTooltip('取消指定引脚的硬件中断');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

Blockly.Blocks['io_software_interrupt_event'] = {
    init: function () {
        this.appendValueInput('PIN')
            .setCheck(['Number', 'String'])
            .appendField('软件中断 管脚 #');
        this.appendDummyInput()
            .appendField('模式')
            .appendField(new Blockly.FieldDropdown(INTERRUPT_MODE_OPTIONS), 'MODE');
        this.appendStatementInput('DO')
            .setCheck(null)
            .appendField('执行');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(180);
        this.setTooltip('通过轮询模拟中断触发');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

Blockly.Blocks['io_software_interrupt_cancel'] = {
    init: function () {
        this.appendValueInput('PIN')
            .setCheck(['Number', 'String'])
            .appendField('取消软件中断 管脚 #');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(180);
        this.setTooltip('取消指定引脚的软件中断');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

Blockly.Blocks['io_pulse_in'] = {
    init: function () {
        this.appendValueInput('PIN')
            .setCheck(['Number', 'String'])
            .appendField('\u8109\u51b2\u957f\u5ea6 (\u5fae\u79d2) \u7ba1\u811a #');
        this.appendValueInput('STATE')
            .setCheck(['Number', 'String'])
            .appendField('\u72b6\u6001');
        this.setOutput(true, 'Number');
        this.setColour(180);
        this.setTooltip('\u8bfb\u53d6\u8109\u51b2\u957f\u5ea6(\u5fae\u79d2)');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

Blockly.Blocks['io_pulse_in_timeout'] = {
    init: function () {
        this.appendValueInput('PIN')
            .setCheck(['Number', 'String'])
            .appendField('\u8109\u51b2\u957f\u5ea6 (\u5fae\u79d2) \u7ba1\u811a #');
        this.appendValueInput('STATE')
            .setCheck(['Number', 'String'])
            .appendField('\u72b6\u6001');
        this.appendValueInput('TIMEOUT')
            .setCheck('Number')
            .appendField('\u8d85\u65f6 (\u5fae\u79d2)');
        this.setOutput(true, 'Number');
        this.setColour(180);
        this.setTooltip('\u8bfb\u53d6\u8109\u51b2\u957f\u5ea6(\u5e26\u8d85\u65f6)');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

Blockly.Blocks['io_pulse_in_long'] = {
    init: function () {
        this.appendValueInput('PIN')
            .setCheck(['Number', 'String'])
            .appendField('\u8109\u51b2\u957f\u5ea6\u957f (\u5fae\u79d2) \u7ba1\u811a #');
        this.appendValueInput('STATE')
            .setCheck(['Number', 'String'])
            .appendField('\u72b6\u6001');
        this.appendValueInput('TIMEOUT')
            .setCheck('Number')
            .appendField('\u8d85\u65f6 (\u5fae\u79d2)');
        this.setOutput(true, 'Number');
        this.setColour(180);
        this.setTooltip('pulseInLong \u8bfb\u53d6\u8109\u51b2\u957f\u5ea6');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

Blockly.Blocks['io_shift_out'] = {
    init: function () {
        this.appendValueInput('DATA_PIN')
            .setCheck(['Number', 'String'])
            .appendField('ShiftOut 数据管脚 #');
        this.appendValueInput('CLOCK_PIN')
            .setCheck(['Number', 'String'])
            .appendField('时钟管脚 #');
        this.appendDummyInput()
            .appendField('顺序')
            .appendField(new Blockly.FieldDropdown(SHIFT_ORDER_OPTIONS), 'ORDER');
        this.appendValueInput('VALUE')
            .setCheck('Number')
            .appendField('数值');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(180);
        this.setTooltip('通过 ShiftOut 发送 8 位数据');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

Blockly.Blocks['io_shift_in'] = {
    init: function () {
        this.appendValueInput('DATA_PIN')
            .setCheck(['Number', 'String'])
            .appendField('ShiftIn 数据管脚 #');
        this.appendValueInput('CLOCK_PIN')
            .setCheck(['Number', 'String'])
            .appendField('时钟管脚 #');
        this.appendDummyInput()
            .appendField('顺序')
            .appendField(new Blockly.FieldDropdown(SHIFT_ORDER_OPTIONS), 'ORDER');
        this.setOutput(true, 'Number');
        this.setColour(180);
        this.setTooltip('通过 ShiftIn 读取 8 位数据');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

Blockly.Blocks['io_interrupts_disable'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('关闭中断');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(LOGIC_HUE);
        this.setTooltip('全局关闭中断');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['io_interrupts_enable'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('开启中断');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(LOGIC_HUE);
        this.setTooltip('全局开启中断');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['io_micros_now'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('当前微秒');
        this.setOutput(true, 'Number');
        this.setColour(TIME_HUE);
        this.setTooltip('返回 micros()');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['io_delay_us'] = {
    init: function () {
        this.appendValueInput('US')
            .setCheck('Number')
            .appendField('延时 微秒');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(TIME_HUE);
        this.setTooltip('delayMicroseconds');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

Blockly.Blocks['control_delay'] = {
    init: function () {
        this.appendValueInput('TIME')
            .setCheck('Number')
            .appendField('延时');
        this.appendDummyInput()
            .appendField(new Blockly.FieldDropdown(DELAY_UNIT_OPTIONS), 'UNIT');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(TIME_HUE);
        this.setTooltip('延时（毫秒/微秒）');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

Blockly.Blocks['control_system_runtime'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('\u7cfb\u7edf\u8fd0\u884c\u65f6\u95f4')
            .appendField(new Blockly.FieldDropdown(SYSTEM_TIME_UNIT_OPTIONS), 'UNIT');
        this.setOutput(true, 'Number');
        this.setColour(TIME_HUE);
        this.setTooltip('\u83b7\u53d6\u7cfb\u7edf\u8fd0\u884c\u65f6\u95f4');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['control_mstimer2_every'] = {
    init: function () {
        this.appendValueInput('INTERVAL')
            .setCheck('Number')
            .appendField('MsTimer2\u6bcf\u9694');
        this.appendDummyInput()
            .appendField('ms');
        this.appendStatementInput('DO')
            .setCheck(null)
            .appendField('\u6267\u884c');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(TIME_HUE);
        this.setTooltip('\u914d\u7f6e MsTimer2 \u5468\u671f\u56de\u8c03');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

Blockly.Blocks['control_mstimer2_start'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('MsTimer2\u542f\u52a8');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(TIME_HUE);
        this.setTooltip('\u542f\u52a8 MsTimer2 \u5b9a\u65f6\u5668');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['control_mstimer2_stop'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('MsTimer2\u505c\u6b62');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(TIME_HUE);
        this.setTooltip('\u505c\u6b62 MsTimer2 \u5b9a\u65f6\u5668');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['control_simple_timer_interval'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('简单定时器')
            .appendField(new Blockly.FieldDropdown(SIMPLE_TIMER_SLOT_OPTIONS), 'SLOT')
            .appendField('间隔');
        this.appendValueInput('INTERVAL')
            .setCheck('Number');
        this.appendDummyInput()
            .appendField('毫秒');
        this.appendStatementInput('DO')
            .setCheck(null)
            .appendField('执行');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(TIME_HUE);
        this.setTooltip('SimpleTimer 周期回调');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['write_servo'] = {
    init: function () {
        this.appendValueInput("PIN")
            .setCheck(null)
            .appendField("舵机");
        this.appendDummyInput()
            .appendField("转动到")
            .appendField(new Blockly.FieldNumber(90, 0, 180), "ANGLE")
            .appendField("度");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(190); // Cyan (Actuators)
        this.setTooltip("");
        this.setHelpUrl("");
    }
};

Blockly.Blocks['serial_baudrate_selector'] = {
    init: function () {
        this.appendDummyInput()
            .appendField(new Blockly.FieldDropdown(SERIAL_BAUD_OPTIONS), 'BAUD');
        this.setOutput(true, 'Number');
        this.setColour(SERIAL_HUE);
        this.setTooltip('常用波特率');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['serial_setup'] = {
    init: function () {
        this.appendValueInput('BAUD')
            .setCheck('Number')
            .appendField('设置串口波特率');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(SERIAL_HUE);
        this.setTooltip('设置 Serial.begin 波特率');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

Blockly.Blocks['serial_setup_with_pins'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('初始化')
            .appendField(new Blockly.FieldDropdown(SERIAL_PORT_OPTIONS), 'PORT');
        this.appendValueInput('BAUD')
            .setCheck('Number')
            .appendField('波特率');
        this.appendValueInput('RX')
            .setCheck('Number')
            .appendField('RX#');
        this.appendValueInput('TX')
            .setCheck('Number')
            .appendField('TX#');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(SERIAL_HUE);
        this.setTooltip('按引脚初始化硬件串口 (ESP32/多串口板可用)');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

Blockly.Blocks['serial_write_raw'] = {
    init: function () {
        this.appendValueInput('DATA')
            .setCheck(['Number', 'String'])
            .appendField('串口 原始输出');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(SERIAL_HUE);
        this.setTooltip('Serial.write 原始输出字节');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

Blockly.Blocks['serial_print'] = {
    init: function () {
        this.appendValueInput('MSG')
            .setCheck(null)
            .appendField('串口打印');
        this.appendDummyInput()
            .appendField(new Blockly.FieldDropdown(SERIAL_NEWLINE_OPTIONS), 'NEWLINE');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(SERIAL_HUE);
        this.setTooltip('串口打印文本');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

Blockly.Blocks['serial_print_number'] = {
    init: function () {
        this.appendValueInput('NUM')
            .setCheck('Number')
            .appendField('串口打印');
        this.appendDummyInput()
            .appendField(new Blockly.FieldDropdown(SERIAL_NEWLINE_OPTIONS), 'NEWLINE')
            .appendField('数字')
            .appendField(new Blockly.FieldDropdown(SERIAL_BASE_OPTIONS), 'BASE');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(SERIAL_HUE);
        this.setTooltip('按进制打印数字');
        this.setHelpUrl('');
        this.setInputsInline(true);
    }
};

Blockly.Blocks['serial_available'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('串口 有数据可读?');
        this.setOutput(true, 'Boolean');
        this.setColour(SERIAL_HUE);
        this.setTooltip('检查串口是否有可读数据');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['serial_read_string'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('串口 读取字符串');
        this.setOutput(true, 'String');
        this.setColour(SERIAL_HUE);
        this.setTooltip('读取串口字符串');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['serial_read_string_until'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('串口 读取字符串直到')
            .appendField(new Blockly.FieldTextInput('a'), 'DELIM');
        this.setOutput(true, 'String');
        this.setColour(SERIAL_HUE);
        this.setTooltip('读取直到指定终止字符');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['serial_read_byte'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('串口 read');
        this.setOutput(true, 'Number');
        this.setColour(SERIAL_HUE);
        this.setTooltip('读取一个字节 (-1 表示无数据)');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['serial_flush_input'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('串口 清空缓冲区数据');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(SERIAL_HUE);
        this.setTooltip('清空串口输入缓冲');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['serial_read_if_available'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('当串口收到数据时');
        this.appendStatementInput('DO')
            .setCheck(null)
            .appendField('执行');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(SERIAL_HUE);
        this.setTooltip('收到串口数据时执行代码块');
        this.setHelpUrl('');
    }
};
Blockly.Blocks['delay_ms'] = {
    init: function () {
        this.appendDummyInput()
            .appendField("延时")
            .appendField(new Blockly.FieldNumber(1000), "MS")
            .appendField("毫秒");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(TIME_HUE);
        this.setTooltip("");
        this.setHelpUrl("");
    }
};

Blockly.Blocks['controls_setup_custom'] = {
    init: function () {
        this.appendStatementInput('DO')
            .setCheck(null)
            .appendField('\u521d\u59cb\u5316');
        this.setColour(LOOP_HUE);
        this.setTooltip('\u5728 setup() \u4e2d\u6267\u884c\u4e00\u6b21');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['controls_loop_custom'] = {
    init: function () {
        this.appendStatementInput('DO')
            .setCheck(null)
            .appendField('loop \u5faa\u73af');
        this.setColour(LOOP_HUE);
        this.setTooltip('\u4f5c\u4e3a loop() \u4e3b\u4f53\u7684\u663e\u5f0f\u79ef\u6728');
        this.setHelpUrl('');
    }
};

// Legacy compatibility blocks for older extension XML payloads.
if (!(Blockly as any).Blocks?.['controls_delay']) {
    Blockly.Blocks['controls_delay'] = {
        init: function () {
            this.appendValueInput('DELAY_TIME')
                .setCheck('Number')
                .appendField('延时');
            this.appendDummyInput()
                .appendField(new Blockly.FieldDropdown([
                    ['毫秒', 'delay'],
                    ['微秒', 'delayMicroseconds'],
                ]), 'UNIT');
            this.setPreviousStatement(true, null);
            this.setNextStatement(true, null);
            this.setColour(TIME_HUE);
            this.setTooltip('兼容旧版 controls_delay 积木');
            this.setHelpUrl('');
            this.setInputsInline(true);
        }
    };
}

if (!(Blockly as any).Blocks?.['variables_declare']) {
    Blockly.Blocks['variables_declare'] = {
        init: function () {
            this.appendDummyInput()
                .appendField('声明')
                .appendField(new Blockly.FieldDropdown([
                    ['全局变量', 'global_variate'],
                    ['局部变量', 'local_variate'],
                ]), 'variables_type')
                .appendField(new Blockly.FieldTextInput('item'), 'VAR')
                .appendField('为')
                .appendField(new Blockly.FieldDropdown(VARIABLE_TYPE_OPTIONS), 'TYPE');
            this.appendValueInput('VALUE')
                .setCheck(null)
                .appendField('并赋值');
            this.setInputsInline(true);
            this.setPreviousStatement(true, null);
            this.setNextStatement(true, null);
            this.setColour(VARIABLE_HUE);
            this.setTooltip('兼容旧版 variables_declare 积木');
            this.setHelpUrl('');
            this.setOnChange(function (this: any, event: any) {
                if (!event || this.isInFlyout) return;
                const eventType = String(event.type || '');
                const blockChanged = event.blockId === this.id || (Array.isArray(event.ids) && event.ids.includes(this.id));
                if (!blockChanged) return;
                if (eventType === Blockly.Events.BLOCK_CREATE || eventType === Blockly.Events.BLOCK_CHANGE) {
                    ensureWorkspaceVariableByField(this, 'VAR', 'item');
                }
            });
        }
    };
}

if (!(Blockly as any).Blocks?.['math_auto_add_or_minus']) {
    Blockly.Blocks['math_auto_add_or_minus'] = {
        init: function () {
            this.appendDummyInput()
                .appendField('变量')
                .appendField(new Blockly.FieldDropdown([
                    ['++', '++'],
                    ['--', '--'],
                ]), 'math_auto_add_minus_type');
            this.appendValueInput('math_auto_add_minus_output')
                .setCheck(null);
            this.setInputsInline(true);
            this.setPreviousStatement(true, null);
            this.setNextStatement(true, null);
            this.setColour(MATH_HUE);
            this.setTooltip('兼容旧版自增/自减积木');
            this.setHelpUrl('');
        }
    };
}

if (!(Blockly as any).Blocks?.['serial_begin']) {
    Blockly.Blocks['serial_begin'] = {
        init: function () {
            this.appendDummyInput()
                .appendField('初始化串口')
                .appendField(new Blockly.FieldDropdown([['Serial', 'Serial']]), 'serial_select');
            this.appendValueInput('CONTENT')
                .setCheck('Number')
                .appendField('波特率');
            this.setPreviousStatement(true, null);
            this.setNextStatement(true, null);
            this.setColour(SERIAL_HUE);
            this.setTooltip('兼容旧版 serial_begin 积木');
            this.setHelpUrl('');
            this.setInputsInline(true);
        }
    };
}

if (!(Blockly as any).Blocks?.['serial_println']) {
    Blockly.Blocks['serial_println'] = {
        init: function () {
            this.appendDummyInput()
                .appendField('串口打印')
                .appendField(new Blockly.FieldDropdown([['Serial', 'Serial']]), 'serial_select');
            this.appendValueInput('CONTENT')
                .setCheck(null)
                .appendField('内容');
            this.appendDummyInput()
                .appendField(new Blockly.FieldDropdown([
                    ['println', 'println'],
                    ['print', 'print'],
                ]), 'new_line');
            this.setPreviousStatement(true, null);
            this.setNextStatement(true, null);
            this.setColour(SERIAL_HUE);
            this.setTooltip('兼容旧版 serial_println 积木');
            this.setHelpUrl('');
            this.setInputsInline(true);
        }
    };
}

// Backward compatibility aliases for older projects.
const registerLegacyBlockAlias = (legacyType: string, currentType: string) => {
    try {
        if ((Blockly as any).Blocks?.[legacyType]) return;
        const current = (Blockly as any).Blocks?.[currentType];
        if (!current || typeof current.init !== 'function') return;
        (Blockly as any).Blocks[legacyType] = {
            init: function () {
                current.init.call(this);
            }
        };
    } catch {
        // Keep startup resilient; compatibility registration is best-effort.
    }
};

registerLegacyBlockAlias('arduino_setup', 'controls_setup_custom');
registerLegacyBlockAlias('arduino_loop', 'controls_loop_custom');
registerLegacyBlockAlias('base_setup', 'controls_setup_custom');
registerLegacyBlockAlias('base_loop', 'controls_loop_custom');
registerLegacyBlockAlias('text_char', 'text_char_literal_custom');

Blockly.Blocks['controls_do_while_custom'] = {
    init: function () {
        this.appendStatementInput('DO')
            .setCheck(null)
            .appendField('\u6267\u884c');
        this.appendValueInput('COND')
            .setCheck('Boolean')
            .appendField('\u5f53\u6761\u4ef6\u4e3a\u771f');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(LOOP_HUE);
        this.setTooltip('\u5148\u6267\u884c\u518d\u5224\u65ad\u6761\u4ef6\u7684\u5faa\u73af');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['controls_flow_action_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('\u63a7\u5236\u6d41')
            .appendField(new Blockly.FieldDropdown(CONTROL_FLOW_ACTION_OPTIONS), 'ACTION');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(LOOP_HUE);
        this.setTooltip('break / continue / return');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['controls_label_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('标签')
            .appendField(new Blockly.FieldTextInput('label1'), 'LABEL');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(LOOP_HUE);
        this.setTooltip('定义 goto 跳转标签');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['controls_goto_custom'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('goto')
            .appendField(new Blockly.FieldTextInput('label1'), 'LABEL');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(LOOP_HUE);
        this.setTooltip('跳转到指定标签');
        this.setHelpUrl('');
    }
};

const patchProcedureBlocks = () => {
    try {
        const defReturn: any = Blockly.Blocks['procedures_defreturn'];
        if (defReturn && !defReturn.__ckReturnTypePatched) {
            const oldInit = defReturn.init;
            defReturn.init = function (...args: any[]) {
                if (typeof oldInit === 'function') oldInit.apply(this, args);
                const returnInput = this.getInput('RETURN');
                if (returnInput && !this.getField('RET_TYPE')) {
                    returnInput
                        .appendField('类型')
                        .appendField(new Blockly.FieldDropdown(FUNCTION_RETURN_TYPE_OPTIONS), 'RET_TYPE');
                }
                this.setTooltip('定义有返回值函数，可设置返回类型。');
                this.setHelpUrl('');
                try { this.setCommentText(null); } catch { }
            };
            defReturn.__ckReturnTypePatched = true;
        }

        const defNoReturn: any = Blockly.Blocks['procedures_defnoreturn'];
        if (defNoReturn && !defNoReturn.__ckTooltipPatched) {
            const oldInit = defNoReturn.init;
            defNoReturn.init = function (...args: any[]) {
                if (typeof oldInit === 'function') oldInit.apply(this, args);
                this.setTooltip('定义无返回值函数。');
                this.setHelpUrl('');
                try { this.setCommentText(null); } catch { }
            };
            defNoReturn.__ckTooltipPatched = true;
        }

        const callReturn: any = Blockly.Blocks['procedures_callreturn'];
        if (callReturn && !callReturn.__ckReturnCheckPatchedV2) {
            const oldInit = callReturn.init;
            callReturn.init = function (...args: any[]) {
                if (typeof oldInit === 'function') oldInit.apply(this, args);
                if (!String(this.getFieldValue('NAME') || '').trim()) {
                    try { this.setFieldValue('myValue', 'NAME'); } catch { }
                }
                try {
                    const top: any = this.getInput('TOPROW');
                    if (top && !this.getField('CK_CALL_PREFIX')) {
                        if (typeof top.insertFieldAt === 'function') {
                            top.insertFieldAt(0, '调用函数', 'CK_CALL_PREFIX');
                        } else {
                            top.appendField('调用函数', 'CK_CALL_PREFIX');
                        }
                    }
                } catch { }
                this.setHelpUrl('');
                this.setTooltip('调用有返回值函数');
                this.setOnChange(() => {
                    if (!this.workspace || this.isInFlyout) return;
                    const procName = String(this.getFieldValue('NAME') || '').trim();
                    if (!procName) return;
                    const defs = (this.workspace.getBlocksByType?.('procedures_defreturn', false) || []) as any[];
                    const matched = defs.find((b) => String(b.getFieldValue?.('NAME') || '').trim() === procName);
                    const retType = String(matched?.getFieldValue?.('RET_TYPE') || 'int');
                    let check: string | null = 'Number';
                    if (retType === 'bool') check = 'Boolean';
                    if (retType === 'String' || retType === 'char') check = 'String';
                    if (this.outputConnection) this.outputConnection.setCheck(check);
                });
            };
            callReturn.__ckReturnCheckPatchedV2 = true;
        }

        const callNoReturn: any = Blockly.Blocks['procedures_callnoreturn'];
        if (callNoReturn && !callNoReturn.__ckCallNoReturnPatchedV2) {
            const oldInit = callNoReturn.init;
            callNoReturn.init = function (...args: any[]) {
                if (typeof oldInit === 'function') oldInit.apply(this, args);
                if (!String(this.getFieldValue('NAME') || '').trim()) {
                    try { this.setFieldValue('myFunction', 'NAME'); } catch { }
                }
                try {
                    const top: any = this.getInput('TOPROW');
                    if (top && !this.getField('CK_CALL_PREFIX')) {
                        if (typeof top.insertFieldAt === 'function') {
                            top.insertFieldAt(0, '调用函数', 'CK_CALL_PREFIX');
                        } else {
                            top.appendField('调用函数', 'CK_CALL_PREFIX');
                        }
                    }
                } catch { }
                this.setHelpUrl('');
                this.setTooltip('调用无返回值函数');
            };
            callNoReturn.__ckCallNoReturnPatchedV2 = true;
        }

        const ifReturn: any = Blockly.Blocks['procedures_ifreturn'];
        if (ifReturn && !ifReturn.__ckIfReturnHelpPatched) {
            const oldInit = ifReturn.init;
            ifReturn.init = function (...args: any[]) {
                if (typeof oldInit === 'function') oldInit.apply(this, args);
                this.setHelpUrl('');
            };
            ifReturn.__ckIfReturnHelpPatched = true;
        }
    } catch (e) {
        console.warn('[Blockly] Failed to patch procedure blocks', e);
    }
};

patchProcedureBlocks();

const getProcedureNameOptions = (sourceBlock: any, wantReturn: boolean): [string, string][] => {
    const wsCandidate = sourceBlock?.workspace;
    const ws = (wsCandidate?.targetWorkspace || wsCandidate || null) as any;
    if (!ws || typeof ws.getBlocksByType !== 'function') {
        return wantReturn ? [['myValue', 'myValue']] : [['myFunction', 'myFunction']];
    }

    const type = wantReturn ? 'procedures_defreturn' : 'procedures_defnoreturn';
    const defs = (ws.getBlocksByType(type, false) || []) as any[];
    const seen = new Set<string>();
    const options: [string, string][] = [];

    for (const b of defs) {
        const name = String(b?.getFieldValue?.('NAME') || '').trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        options.push([name, name]);
    }

    if (options.length === 0) {
        return wantReturn ? [['myValue', 'myValue']] : [['myFunction', 'myFunction']];
    }
    return options;
};

const procedureNameDropdownGenerator = (wantReturn: boolean) => function (this: any): [string, string][] {
    const sourceBlock = this?.getSourceBlock?.() || this?.sourceBlock_ || null;
    return getProcedureNameOptions(sourceBlock, wantReturn);
};

const inferProcedureReturnCheckByName = (sourceBlock: any, procName: string): string | null => {
    const ws = sourceBlock?.workspace as any;
    if (!ws || typeof ws.getBlocksByType !== 'function') return 'Number';
    const defs = (ws.getBlocksByType('procedures_defreturn', false) || []) as any[];
    const matched = defs.find((b) => String(b?.getFieldValue?.('NAME') || '').trim() === procName);
    const retType = String(matched?.getFieldValue?.('RET_TYPE') || 'int');
    if (retType === 'bool') return 'Boolean';
    if (retType === 'String' || retType === 'char') return 'String';
    return 'Number';
};

Blockly.Blocks['procedures_callnoreturn_picker'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('调用函数')
            .appendField(new Blockly.FieldDropdown(procedureNameDropdownGenerator(false)), 'NAME');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle('procedure_blocks');
        this.setTooltip('从下拉列表选择并调用无返回值函数');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['procedures_callreturn_picker'] = {
    init: function () {
        this.appendDummyInput()
            .appendField('调用函数')
            .appendField(new Blockly.FieldDropdown(procedureNameDropdownGenerator(true)), 'NAME');
        this.setOutput(true, null);
        this.setStyle('procedure_blocks');
        this.setTooltip('从下拉列表选择有返回值函数并取得结果');
        this.setHelpUrl('');
        this.setOnChange(() => {
            if (!this.workspace || this.isInFlyout) return;
            const procName = String(this.getFieldValue('NAME') || '').trim();
            if (!procName) return;
            const check = inferProcedureReturnCheckByName(this, procName);
            if (this.outputConnection) this.outputConnection.setCheck(check);
        });
    }
};

Blockly.Blocks['procedures_return_void_custom'] = {
    init: function () {
        this.appendDummyInput().appendField('返回');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle('procedure_blocks');
        this.setTooltip('立即结束当前函数，不返回数值。');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['procedures_return_value_custom'] = {
    init: function () {
        this.appendValueInput('VALUE')
            .setCheck(null)
            .appendField('返回');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle('procedure_blocks');
        this.setTooltip('立即结束当前函数，并返回一个值。');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['procedures_return_typed_custom'] = {
    init: function () {
        this.appendValueInput('VALUE')
            .setCheck(null)
            .appendField('返回')
            .appendField(new Blockly.FieldDropdown(FUNCTION_RETURN_TYPE_OPTIONS), 'TYPE');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle('procedure_blocks');
        this.setTooltip('按指定类型返回值。');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['procedures_ifreturn_value_custom'] = {
    init: function () {
        this.appendValueInput('COND')
            .setCheck('Boolean')
            .appendField('如果');
        this.appendValueInput('VALUE')
            .setCheck(null)
            .appendField('返回');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setInputsInline(true);
        this.setStyle('procedure_blocks');
        this.setTooltip('条件成立时返回一个值。');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['procedures_ifreturn_void_custom'] = {
    init: function () {
        this.appendValueInput('COND')
            .setCheck('Boolean')
            .appendField('如果');
        this.appendDummyInput().appendField('返回');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setInputsInline(true);
        this.setStyle('procedure_blocks');
        this.setTooltip('条件成立时直接结束函数。');
        this.setHelpUrl('');
    }
};

Blockly.Blocks['controls_switch_container'] = {
    init: function () {
        this.appendDummyInput().appendField('\u6dfb\u52a0\u5206\u652f');
        this.appendStatementInput('STACK');
        this.setColour(LOGIC_HUE);
        this.contextMenu = false;
    }
};

Blockly.Blocks['controls_switch_case_item'] = {
    init: function () {
        this.appendDummyInput().appendField('\u5982\u679c\u662f');
        this.setPreviousStatement(true);
        this.setNextStatement(true);
        this.setColour(LOGIC_HUE);
        this.contextMenu = false;
    }
};

Blockly.Blocks['controls_switch_default_item'] = {
    init: function () {
        this.appendDummyInput().appendField('\u5176\u4ed6\u60c5\u51b5');
        this.setPreviousStatement(true);
        this.setNextStatement(true);
        this.setColour(LOGIC_HUE);
        this.contextMenu = false;
    }
};

Blockly.Blocks['controls_switch_custom'] = {
    init: function () {
        (this as any).caseCount_ = 1;
        (this as any).hasDefault_ = true;
        this.appendValueInput('COND')
            .setCheck(null)
            .appendField('\u6309\u7167');
        (this as any).updateShape_();
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(LOGIC_HUE);
        this.setTooltip('\u6839\u636e\u503c\u9009\u62e9\u6267\u884c\u5206\u652f');
        this.setHelpUrl('');
        const flyoutItems = ['controls_switch_case_item', 'controls_switch_default_item'];
        const B: any = Blockly as any;
        if (B?.icons?.MutatorIcon) {
            this.setMutator(new B.icons.MutatorIcon(flyoutItems, this));
        } else if (B?.MutatorIcon) {
            this.setMutator(new B.MutatorIcon(flyoutItems, this));
        } else if (B?.Mutator) {
            this.setMutator(new B.Mutator(flyoutItems));
        }
    },
    mutationToDom: function () {
        const container = Blockly.utils.xml.createElement('mutation');
        container.setAttribute('cases', String((this as any).caseCount_ || 0));
        container.setAttribute('default', (this as any).hasDefault_ ? '1' : '0');
        return container;
    },
    domToMutation: function (xmlElement: Element) {
        (this as any).caseCount_ = parseInt(xmlElement.getAttribute('cases') || '1', 10);
        (this as any).hasDefault_ = xmlElement.getAttribute('default') !== '0';
        (this as any).updateShape_();
    },
    decompose: function (workspace: any) {
        const containerBlock = workspace.newBlock('controls_switch_container');
        containerBlock.initSvg();
        let connection = containerBlock.getInput('STACK').connection;

        for (let i = 0; i < ((this as any).caseCount_ || 0); i++) {
            const caseBlock = workspace.newBlock('controls_switch_case_item');
            caseBlock.initSvg();
            connection.connect(caseBlock.previousConnection);
            connection = caseBlock.nextConnection;
        }
        if ((this as any).hasDefault_) {
            const defaultBlock = workspace.newBlock('controls_switch_default_item');
            defaultBlock.initSvg();
            connection.connect(defaultBlock.previousConnection);
        }
        return containerBlock;
    },
    compose: function (containerBlock: any) {
        const caseValueConnections: any[] = [];
        const caseDoConnections: any[] = [];
        let defaultConnection: any = null;
        let clauseBlock = containerBlock.getInputTargetBlock('STACK');
        let caseCount = 0;
        let hasDefault = false;

        while (clauseBlock) {
            if (clauseBlock.type === 'controls_switch_case_item') {
                caseValueConnections.push((clauseBlock as any).valueConnection_);
                caseDoConnections.push((clauseBlock as any).statementConnection_);
                caseCount++;
            } else if (clauseBlock.type === 'controls_switch_default_item') {
                hasDefault = true;
                defaultConnection = (clauseBlock as any).statementConnection_;
            }
            clauseBlock = clauseBlock.nextConnection && clauseBlock.nextConnection.targetBlock();
        }

        (this as any).caseCount_ = caseCount;
        (this as any).hasDefault_ = hasDefault;
        (this as any).updateShape_();

        const reconnect = (targetConn: any, inputName: string) => {
            if (!targetConn) return;
            try {
                if (typeof targetConn.reconnect === 'function') {
                    targetConn.reconnect(this, inputName);
                    return;
                }
            } catch { }
            const input = this.getInput(inputName);
            if (input?.connection) {
                try { input.connection.connect(targetConn); } catch { }
            }
        };

        for (let i = 0; i < caseCount; i++) {
            reconnect(caseValueConnections[i], `CASE_VAL${i}`);
            reconnect(caseDoConnections[i], `CASE_DO${i}`);
        }
        if (hasDefault) {
            reconnect(defaultConnection, 'DEFAULT');
        }
    },
    saveConnections: function (containerBlock: any) {
        let clauseBlock = containerBlock.getInputTargetBlock('STACK');
        let i = 0;
        while (clauseBlock) {
            if (clauseBlock.type === 'controls_switch_case_item') {
                const valueInput = this.getInput(`CASE_VAL${i}`);
                const doInput = this.getInput(`CASE_DO${i}`);
                (clauseBlock as any).valueConnection_ = valueInput?.connection?.targetConnection || null;
                (clauseBlock as any).statementConnection_ = doInput?.connection?.targetConnection || null;
                i++;
            } else if (clauseBlock.type === 'controls_switch_default_item') {
                const defaultInput = this.getInput('DEFAULT');
                (clauseBlock as any).statementConnection_ = defaultInput?.connection?.targetConnection || null;
            }
            clauseBlock = clauseBlock.nextConnection && clauseBlock.nextConnection.targetBlock();
        }
    },
    updateShape_: function () {
        let i = 0;
        while (this.getInput(`CASE_VAL${i}`)) {
            if (this.getInput(`CASE_DO${i}`)) this.removeInput(`CASE_DO${i}`);
            this.removeInput(`CASE_VAL${i}`);
            i++;
        }
        if (this.getInput('DEFAULT')) {
            this.removeInput('DEFAULT');
        }
        for (let idx = 0; idx < ((this as any).caseCount_ || 0); idx++) {
            this.appendValueInput(`CASE_VAL${idx}`)
                .setCheck(null)
                .appendField('\u5982\u679c\u662f');
            this.appendStatementInput(`CASE_DO${idx}`)
                .setCheck(null)
                .appendField('\u5c31\u6267\u884c');
        }
        if ((this as any).hasDefault_) {
            this.appendStatementInput('DEFAULT')
                .setCheck(null)
                .appendField('\u5176\u4ed6\u60c5\u51b5\u6267\u884c');
        }
    }
};



Blockly.Blocks['wifi_connect'] = {
    init: function () {
        this.appendDummyInput()
            .appendField("连接WiFi")
            .appendField("SSID")
            .appendField(new Blockly.FieldTextInput("MyWiFi"), "SSID")
            .appendField("密码")
            .appendField(new Blockly.FieldTextInput("12345678"), "PASSWORD");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(230); // Blue-ish
        this.setTooltip("Connect to Wi-Fi network");
        this.setHelpUrl("");
    }
};

Blockly.Blocks['wifi_wait_until_ready'] = {
    init: function () {
        this.appendDummyInput()
            .appendField("等待直到WiFi连接成功");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(230);
        this.setTooltip("Block execution until Connected");
        this.setHelpUrl("");
    }
};

Blockly.Blocks['wifi_local_ip'] = {
    init: function () {
        this.appendDummyInput()
            .appendField("获取本机IP地址");
        this.setOutput(true, "String");
        this.setColour(230);
        this.setTooltip("Returns local IP address as String");
        this.setHelpUrl("");
    }
};

Blockly.Blocks['wifi_set_protocol'] = {
    init: function () {
        this.appendDummyInput()
            .appendField("设置WiFi协议")
            .appendField(new Blockly.FieldDropdown([
                ["自动 (默认)", "AUTO"],
                ["802.11 b/g/n (WiFi 4)", "WIFI_PROTOCOL_11B|WIFI_PROTOCOL_11G|WIFI_PROTOCOL_11N"],
                ["802.11 ax (WiFi 6 - C5专用)", "WIFI_PROTOCOL_11B|WIFI_PROTOCOL_11G|WIFI_PROTOCOL_11N|WIFI_PROTOCOL_11AX"],
                ["仅 802.11 ax", "WIFI_PROTOCOL_11AX"]
            ]), "PROTOCOL");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(230);
        this.setTooltip("Set Wi-Fi Protocol (ESP32-C5/C6 only for AX)");
        this.setHelpUrl("");
    }
};

Blockly.Blocks['wifi_get_rssi'] = {
    init: function () {
        this.appendDummyInput()
            .appendField("获取WiFi信号强度 (RSSI)");
        this.setOutput(true, "Number");
        this.setColour(230);
        this.setTooltip("Returns signal strength in dBm");
        this.setHelpUrl("");
    }
};

Blockly.Blocks['wifi_get_channel'] = {
    init: function () {
        this.appendDummyInput()
            .appendField("获取WiFi信道");
        this.setOutput(true, "Number");
        this.setColour(230);
        this.setTooltip("Returns current Wi-Fi channel");
        this.setHelpUrl("");
    }
};


// Define Toolbox
// Dynamic Toolbox Generation
export const getToolbox = (boardFqbn?: string, extensionXml: string = '', coreVersion: string = '') => {
    // Helper to generate dynamic network blocks
    let networkBlocks = '';
    const fqbn = String(boardFqbn || '').toLowerCase();
    const isESP32Family = fqbn.includes('esp32');
    // ESP32 family boards that do not provide Wi-Fi in common setups.
    const esp32NoWifiKeys = ['esp32h2', 'esp32p4'];
    const supportsEsp32Wifi = isESP32Family && !esp32NoWifiKeys.some((k) => fqbn.includes(k));
    const supportsEsp8266Wifi = fqbn.startsWith('esp8266:esp8266:');
    const isC5 = fqbn.includes('esp32c5');
    const isC6 = fqbn.includes('esp32c6');
    const isWiFi6 = isC5 || isC6;

    if (supportsEsp32Wifi || supportsEsp8266Wifi) {
        networkBlocks += `
        <block type="wifi_connect"></block>
        <block type="wifi_wait_until_ready"></block>
        <block type="serial_print">
            <value name="MSG">
                <shadow type="wifi_local_ip"></shadow>
            </value>
        </block>
        <block type="serial_print">
            <value name="MSG">
                <shadow type="wifi_get_rssi"></shadow>
            </value>
        </block>
        <block type="serial_print">
            <value name="MSG">
                <shadow type="wifi_get_channel"></shadow>
            </value>
        </block>`;

        if (isWiFi6) {
            networkBlocks += `
            <block type="wifi_set_protocol"></block>`;
        }
    }

    const networkCategory = networkBlocks ? `<category name="网络" colour="230">${networkBlocks}</category>` : '';

    const toolboxXml = `
<xml xmlns="https://developers.google.com/blockly/xml">
    <category name="引脚" colour="180">
        <block type="io_level"></block>
        <block type="set_pin_mode">
            <value name="PIN">
                <shadow type="board_pin_selector"></shadow>
            </value>
        </block>
        <block type="write_digital">
            <value name="PIN">
                <shadow type="board_pin_selector"></shadow>
            </value>
            <value name="LEVEL">
                <shadow type="io_level"></shadow>
            </value>
        </block>
        <block type="io_analog_write">
            <value name="PIN">
                <shadow type="board_pin_selector"></shadow>
            </value>
            <value name="VALUE">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
        </block>
        <block type="io_shift_out">
            <value name="DATA_PIN">
                <shadow type="board_pin_selector"></shadow>
            </value>
            <value name="CLOCK_PIN">
                <shadow type="board_pin_selector"></shadow>
            </value>
            <value name="VALUE">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
        </block>
        <block type="io_digital_read">
            <value name="PIN">
                <shadow type="board_pin_selector"></shadow>
            </value>
        </block>
        <block type="io_analog_read">
            <value name="PIN">
                <shadow type="board_pin_selector"></shadow>
            </value>
        </block>
        <block type="io_pulse_in">
            <value name="PIN">
                <shadow type="board_pin_selector"></shadow>
            </value>
            <value name="STATE">
                <shadow type="io_level"></shadow>
            </value>
        </block>
        <block type="io_pulse_in_timeout">
            <value name="PIN">
                <shadow type="board_pin_selector"></shadow>
            </value>
            <value name="STATE">
                <shadow type="io_level"></shadow>
            </value>
            <value name="TIMEOUT">
                <shadow type="math_number">
                    <field name="NUM">1000000</field>
                </shadow>
            </value>
        </block>
        <block type="io_pulse_in_long">
            <value name="PIN">
                <shadow type="board_pin_selector"></shadow>
            </value>
            <value name="STATE">
                <shadow type="io_level"></shadow>
            </value>
            <value name="TIMEOUT">
                <shadow type="math_number">
                    <field name="NUM">1000000</field>
                </shadow>
            </value>
        </block>
        <block type="io_shift_in">
            <value name="DATA_PIN">
                <shadow type="board_pin_selector"></shadow>
            </value>
            <value name="CLOCK_PIN">
                <shadow type="board_pin_selector"></shadow>
            </value>
        </block>
        <block type="io_multi_button_event">
            <value name="PIN">
                <shadow type="board_pin_selector"></shadow>
            </value>
            <value name="LEVEL">
                <shadow type="io_level"></shadow>
            </value>
        </block>
        <block type="io_hardware_interrupt_event">
            <value name="PIN">
                <shadow type="board_pin_selector"></shadow>
            </value>
        </block>
        <block type="io_hardware_interrupt_detach">
            <value name="PIN">
                <shadow type="board_pin_selector"></shadow>
            </value>
        </block>
        <block type="io_software_interrupt_event">
            <value name="PIN">
                <shadow type="board_pin_selector"></shadow>
            </value>
        </block>
        <block type="io_software_interrupt_cancel">
            <value name="PIN">
                <shadow type="board_pin_selector"></shadow>
            </value>
        </block>
    </category>


    <category name="\u65f6\u95f4" colour="${TIME_HUE}">
        <block type="control_delay">
            <field name="UNIT">MS</field>
            <value name="TIME">
                <shadow type="math_number">
                    <field name="NUM">1000</field>
                </shadow>
            </value>
        </block>
        <block type="control_system_runtime"></block>
        <block type="io_micros_now"></block>
        <block type="control_simple_timer_interval">
            <field name="SLOT">1</field>
            <value name="INTERVAL">
                <shadow type="math_number">
                    <field name="NUM">1000</field>
                </shadow>
            </value>
        </block>
        <block type="control_mstimer2_every">
            <value name="INTERVAL">
                <shadow type="math_number">
                    <field name="NUM">500</field>
                </shadow>
            </value>
        </block>
        <block type="control_mstimer2_start"></block>
        <block type="control_mstimer2_stop"></block>
    </category>

    <category name="\u903b\u8f91" colour="${LOGIC_HUE}">
        <block type="controls_if"></block>
        <block type="controls_switch_custom">
            <value name="COND">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
        </block>
        <block type="logic_compare"></block>
        <block type="logic_operation"></block>
        <block type="logic_negate"></block>
        <block type="logic_boolean"></block>
        <block type="logic_ternary"></block>
        <block type="logic_ternary_stmt_custom">
            <value name="IF">
                <shadow type="logic_boolean">
                    <field name="BOOL">TRUE</field>
                </shadow>
            </value>
            <value name="THEN">
                <shadow type="math_number">
                    <field name="NUM">1</field>
                </shadow>
            </value>
            <value name="ELSE">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
        </block>
        <block type="io_interrupts_disable"></block>
        <block type="io_interrupts_enable"></block>
    </category>

    <category name="\u5faa\u73af" colour="${LOOP_HUE}">
        <block type="controls_setup_custom"></block>
        <block type="controls_loop_custom"></block>
        <block type="controls_repeat_ext">
            <value name="TIMES">
                <shadow type="math_number">
                    <field name="NUM">10</field>
                </shadow>
            </value>
        </block>
        <block type="controls_whileUntil">
            <value name="BOOL">
                <shadow type="logic_boolean">
                    <field name="BOOL">TRUE</field>
                </shadow>
            </value>
        </block>
        <block type="controls_do_while_custom">
            <value name="COND">
                <shadow type="logic_boolean">
                    <field name="BOOL">TRUE</field>
                </shadow>
            </value>
        </block>
        <block type="controls_for">
            <value name="FROM">
                <shadow type="math_number">
                    <field name="NUM">1</field>
                </shadow>
            </value>
            <value name="TO">
                <shadow type="math_number">
                    <field name="NUM">10</field>
                </shadow>
            </value>
            <value name="BY">
                <shadow type="math_number">
                    <field name="NUM">1</field>
                </shadow>
            </value>
        </block>
        <block type="controls_label_custom"></block>
        <block type="controls_goto_custom"></block>
        <block type="controls_flow_action_custom"></block>
    </category>

    <category name="函数" colour="${FUNCTION_HUE}" custom="CK_FUNCTIONS"></category>

    <category name="串口" colour="${SERIAL_HUE}">
        <block type="serial_setup">
            <value name="BAUD">
                <shadow type="serial_baudrate_selector">
                    <field name="BAUD">115200</field>
                </shadow>
            </value>
        </block>
        <block type="serial_print">
            <value name="MSG">
                <shadow type="text">
                    <field name="TEXT">Hello World</field>
                </shadow>
            </value>
        </block>
        <block type="serial_print_number">
            <value name="NUM">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
        </block>
        <block type="serial_write_raw">
            <value name="DATA">
                <shadow type="math_number">
                    <field name="NUM">65</field>
                </shadow>
            </value>
        </block>
        <block type="serial_available"></block>
        <block type="serial_read_byte"></block>
        <block type="serial_read_string"></block>
        <block type="serial_read_string_until"></block>
        <block type="serial_read_if_available"></block>
        <block type="serial_flush_input"></block>
        <block type="serial_setup_with_pins">
            <value name="BAUD">
                <shadow type="serial_baudrate_selector">
                    <field name="BAUD">115200</field>
                </shadow>
            </value>
            <value name="RX">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
            <value name="TX">
                <shadow type="math_number">
                    <field name="NUM">1</field>
                </shadow>
            </value>
        </block>
    </category>

    <category name="文本" colour="${TEXT_HUE}">
        <block type="text_char_literal_custom">
            <field name="CHAR">M</field>
        </block>
        <block type="text">
            <field name="TEXT">maker</field>
        </block>
        <block type="value_to_text_custom">
            <value name="VALUE">
                <shadow type="math_number">
                    <field name="NUM">123</field>
                </shadow>
            </value>
        </block>
        <block type="text_concat_custom">
            <value name="A">
                <shadow type="text">
                    <field name="TEXT">sunny</field>
                </shadow>
            </value>
            <value name="B">
                <shadow type="text">
                    <field name="TEXT">day</field>
                </shadow>
            </value>
        </block>
        <block type="text_to_type_custom">
            <field name="TYPE">int</field>
            <value name="TEXT">
                <shadow type="text">
                    <field name="TEXT">256</field>
                </shadow>
            </value>
        </block>
        <block type="text_starts_ends_custom">
            <field name="MODE">STARTS</field>
            <value name="TEXT">
                <shadow type="text">
                    <field name="TEXT">blockcraft</field>
                </shadow>
            </value>
            <value name="PATTERN">
                <shadow type="text">
                    <field name="TEXT">block</field>
                </shadow>
            </value>
        </block>
        <block type="text_ascii_from_number_custom">
            <value name="NUM">
                <shadow type="math_number">
                    <field name="NUM">77</field>
                </shadow>
            </value>
        </block>
        <block type="text_ascii_to_number_custom">
            <value name="CHAR">
                <shadow type="text_char_literal_custom">
                    <field name="CHAR">M</field>
                </shadow>
            </value>
        </block>
        <block type="text_substring_custom">
            <value name="TEXT">
                <shadow type="text">
                    <field name="TEXT">CodingRocks</field>
                </shadow>
            </value>
            <value name="START">
                <shadow type="math_number">
                    <field name="NUM">1</field>
                </shadow>
            </value>
            <value name="END">
                <shadow type="math_number">
                    <field name="NUM">5</field>
                </shadow>
            </value>
        </block>
        <block type="text_case_convert_custom">
            <field name="MODE">UPPER</field>
            <value name="TEXT">
                <shadow type="text">
                    <field name="TEXT">mixCase</field>
                </shadow>
            </value>
        </block>
        <block type="text_trim_custom">
            <field name="MODE">BOTH</field>
            <value name="TEXT">
                <shadow type="text">
                    <field name="TEXT">  sample  </field>
                </shadow>
            </value>
        </block>
        <block type="text_count_occurrence_custom">
            <value name="NEEDLE">
                <shadow type="text">
                    <field name="TEXT">go</field>
                </shadow>
            </value>
            <value name="HAYSTACK">
                <shadow type="text">
                    <field name="TEXT">go go stop go</field>
                </shadow>
            </value>
        </block>
        <block type="text_replace_all_custom">
            <value name="TEXT">
                <shadow type="text">
                    <field name="TEXT">blue fish blue sky</field>
                </shadow>
            </value>
            <value name="FROM">
                <shadow type="text">
                    <field name="TEXT">blue</field>
                </shadow>
            </value>
            <value name="TO">
                <shadow type="text">
                    <field name="TEXT">green</field>
                </shadow>
            </value>
        </block>
        <block type="text_reverse_custom">
            <value name="TEXT">
                <shadow type="text">
                    <field name="TEXT">planet</field>
                </shadow>
            </value>
        </block>
    </category>

    <category name="数组" colour="${ARRAY_HUE}">
        <label text="一维数组"></label>
        <block type="array_declare_1d_empty_custom">
            <field name="SCOPE">GLOBAL</field>
            <field name="NAME">arr1</field>
            <field name="TYPE">int</field>
            <value name="LEN">
                <shadow type="math_number">
                    <field name="NUM">3</field>
                </shadow>
            </value>
        </block>
        <block type="array_declare_1d_custom">
            <field name="SCOPE">GLOBAL</field>
            <field name="NAME">arr1</field>
            <field name="TYPE">int</field>
            <value name="LEN">
                <shadow type="math_number">
                    <field name="NUM">3</field>
                </shadow>
            </value>
            <value name="VALUE0">
                <shadow type="math_number">
                    <field name="NUM">1</field>
                </shadow>
            </value>
            <value name="VALUE1">
                <shadow type="math_number">
                    <field name="NUM">2</field>
                </shadow>
            </value>
            <value name="VALUE2">
                <shadow type="math_number">
                    <field name="NUM">3</field>
                </shadow>
            </value>
        </block>
        <block type="array_set_1d_custom">
            <field name="NAME">arr1</field>
            <value name="IDX">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
            <value name="VALUE">
                <shadow type="math_number">
                    <field name="NUM">99</field>
                </shadow>
            </value>
        </block>
        <block type="array_get_1d_custom">
            <field name="NAME">arr1</field>
            <value name="IDX">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
        </block>
        <block type="array_length_1d_custom">
            <field name="NAME">arr1</field>
        </block>
        <sep gap="10"></sep>
        <label text="增删改查"></label>
        <block type="array_push_1d_custom">
            <field name="NAME">arr1</field>
            <field name="LEN_VAR">arr1_len</field>
            <value name="VALUE">
                <shadow type="math_number">
                    <field name="NUM">10</field>
                </shadow>
            </value>
        </block>
        <block type="array_insert_1d_custom">
            <field name="NAME">arr1</field>
            <field name="LEN_VAR">arr1_len</field>
            <value name="IDX">
                <shadow type="math_number">
                    <field name="NUM">1</field>
                </shadow>
            </value>
            <value name="VALUE">
                <shadow type="math_number">
                    <field name="NUM">88</field>
                </shadow>
            </value>
        </block>
        <block type="array_remove_1d_custom">
            <field name="NAME">arr1</field>
            <field name="LEN_VAR">arr1_len</field>
            <value name="IDX">
                <shadow type="math_number">
                    <field name="NUM">1</field>
                </shadow>
            </value>
        </block>
        <block type="array_clear_1d_custom">
            <field name="NAME">arr1</field>
            <field name="LEN_VAR">arr1_len</field>
        </block>
        <block type="array_find_1d_custom">
            <field name="NAME">arr1</field>
            <field name="LEN_VAR">arr1_len</field>
            <value name="VALUE">
                <shadow type="math_number">
                    <field name="NUM">2</field>
                </shadow>
            </value>
        </block>
        <block type="array_contains_1d_custom">
            <field name="NAME">arr1</field>
            <field name="LEN_VAR">arr1_len</field>
            <value name="VALUE">
                <shadow type="math_number">
                    <field name="NUM">2</field>
                </shadow>
            </value>
        </block>
        <sep gap="10"></sep>
        <label text="数组操作"></label>
        <block type="array_sort_1d_custom">
            <field name="NAME">arr1</field>
            <field name="ORDER">ASC</field>
            <field name="LEN_VAR">arr1_len</field>
        </block>
        <block type="array_reverse_1d_custom">
            <field name="NAME">arr1</field>
            <field name="LEN_VAR">arr1_len</field>
        </block>
        <block type="array_fill_1d_custom">
            <field name="NAME">arr1</field>
            <field name="LEN_VAR">arr1_len</field>
            <value name="VALUE">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
        </block>
        <block type="array_copy_1d_custom">
            <field name="SRC_NAME">arr1</field>
            <field name="DST_NAME">copyList</field>
            <field name="SRC_LEN_VAR">arr1_len</field>
            <field name="DST_LEN_VAR">copyList_len</field>
        </block>
        <block type="array_rotate_1d_custom">
            <field name="NAME">arr1</field>
            <field name="DIR">LEFT</field>
            <field name="LEN_VAR">arr1_len</field>
            <value name="STEP">
                <shadow type="math_number">
                    <field name="NUM">1</field>
                </shadow>
            </value>
        </block>

        <sep gap="14"></sep>
        <label text="二维数组"></label>
        <block type="array_declare_2d_custom">
            <field name="SCOPE">GLOBAL</field>
            <field name="NAME">arr2</field>
            <field name="TYPE">int</field>
            <field name="ROWS">2</field>
            <field name="COLS">3</field>
        </block>
        <block type="array_declare_2d_init_custom">
            <field name="SCOPE">GLOBAL</field>
            <field name="NAME">arr2</field>
            <field name="TYPE">int</field>
            <value name="ROWS">
                <shadow type="math_number">
                    <field name="NUM">2</field>
                </shadow>
            </value>
            <value name="COLS">
                <shadow type="math_number">
                    <field name="NUM">3</field>
                </shadow>
            </value>
        </block>
        <block type="array_set_2d_custom">
            <field name="NAME">arr2</field>
            <value name="I">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
            <value name="J">
                <shadow type="math_number">
                    <field name="NUM">1</field>
                </shadow>
            </value>
            <value name="VALUE">
                <shadow type="math_number">
                    <field name="NUM">7</field>
                </shadow>
            </value>
        </block>
        <block type="array_get_2d_custom">
            <field name="NAME">arr2</field>
            <value name="I">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
            <value name="J">
                <shadow type="math_number">
                    <field name="NUM">1</field>
                </shadow>
            </value>
        </block>
        <sep gap="10"></sep>
        <label text="二维增删改查"></label>
        <block type="array_row_literal_custom"></block>
        <block type="array_push_row_2d_custom">
            <field name="NAME">arr2</field>
            <field name="ROWS_VAR">arr2_rows</field>
            <value name="VALUE">
                <shadow type="array_row_literal_custom"></shadow>
            </value>
        </block>
        <block type="array_insert_row_2d_custom">
            <field name="NAME">arr2</field>
            <field name="ROWS_VAR">arr2_rows</field>
            <value name="ROW_IDX">
                <shadow type="math_number">
                    <field name="NUM">1</field>
                </shadow>
            </value>
            <value name="VALUE">
                <shadow type="array_row_literal_custom"></shadow>
            </value>
        </block>
        <block type="array_remove_row_2d_custom">
            <field name="NAME">arr2</field>
            <field name="ROWS_VAR">arr2_rows</field>
            <value name="ROW_IDX">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
        </block>
        <block type="array_contains_2d_custom">
            <field name="NAME">arr2</field>
            <field name="ROWS_VAR">arr2_rows</field>
            <value name="VALUE">
                <shadow type="math_number">
                    <field name="NUM">7</field>
                </shadow>
            </value>
        </block>
        <block type="array_find_2d_custom">
            <field name="NAME">arr2</field>
            <field name="ROWS_VAR">arr2_rows</field>
            <value name="VALUE">
                <shadow type="math_number">
                    <field name="NUM">7</field>
                </shadow>
            </value>
        </block>

        <sep gap="14"></sep>
        <label text="三维与多维"></label>
        <block type="array_declare_3d_custom">
            <field name="SCOPE">GLOBAL</field>
            <field name="NAME">arr3</field>
            <field name="TYPE">int</field>
            <field name="D1">2</field>
            <field name="D2">2</field>
            <field name="D3">2</field>
        </block>
        <block type="array_get_3d_custom">
            <field name="NAME">arr3</field>
            <value name="I">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
            <value name="J">
                <shadow type="math_number">
                    <field name="NUM">1</field>
                </shadow>
            </value>
            <value name="K">
                <shadow type="math_number">
                    <field name="NUM">1</field>
                </shadow>
            </value>
        </block>
        <block type="array_set_3d_custom">
            <field name="NAME">arr3</field>
            <value name="I">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
            <value name="J">
                <shadow type="math_number">
                    <field name="NUM">1</field>
                </shadow>
            </value>
            <value name="K">
                <shadow type="math_number">
                    <field name="NUM">1</field>
                </shadow>
            </value>
            <value name="VALUE">
                <shadow type="math_number">
                    <field name="NUM">5</field>
                </shadow>
            </value>
        </block>
        <sep gap="12"></sep>
        <block type="array_declare_nd_custom">
            <field name="SCOPE">GLOBAL</field>
            <field name="NAME">arrN</field>
            <field name="TYPE">int</field>
        </block>
        <block type="array_get_nd_custom">
            <field name="NAME">arrN</field>
            <value name="IDX0">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
            <value name="IDX1">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
            <value name="IDX2">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
            <value name="IDX3">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
        </block>
        <block type="array_set_nd_custom">
            <field name="NAME">arrN</field>
            <value name="IDX0">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
            <value name="IDX1">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
            <value name="IDX2">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
            <value name="IDX3">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
            <value name="VALUE">
                <shadow type="math_number">
                    <field name="NUM">1</field>
                </shadow>
            </value>
        </block>
    </category>

    <category name="变量" colour="${VARIABLE_HUE}">
        <block type="var_declare_custom">
            <field name="SCOPE">GLOBAL</field>
            <field name="QUAL">NONE</field>
            <field name="NAME">variable</field>
            <field name="TYPE">int</field>
        </block>
        <block type="var_set_custom">
            <value name="NAME">
                <shadow type="var_ref_custom">
                    <field name="NAME">variable</field>
                </shadow>
            </value>
            <value name="VALUE">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
        </block>
        <block type="var_ref_custom">
            <field name="NAME">variable</field>
        </block>
        <block type="var_cast_custom">
            <field name="TYPE">int8_t</field>
            <value name="VALUE">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
        </block>
        <sep gap="12"></sep>
        <block type="var_dynamic_alloc_custom">
            <field name="SCOPE">GLOBAL</field>
            <field name="NAME">buffer</field>
            <field name="TYPE">int</field>
            <value name="COUNT">
                <shadow type="math_number">
                    <field name="NUM">8</field>
                </shadow>
            </value>
        </block>
        <block type="var_dynamic_free_custom">
            <value name="NAME">
                <shadow type="var_ref_custom">
                    <field name="NAME">buffer</field>
                </shadow>
            </value>
        </block>
    </category>

    

    <category name="运算" colour="${MATH_HUE}">
        <block type="math_number">
            <field name="NUM">0</field>
        </block>
        <block type="math_constant">
            <field name="CONSTANT">PI</field>
        </block>
        <block type="math_arithmetic">
            <field name="OP">ADD</field>
            <value name="A">
                <shadow type="math_number">
                    <field name="NUM">1</field>
                </shadow>
            </value>
            <value name="B">
                <shadow type="math_number">
                    <field name="NUM">2</field>
                </shadow>
            </value>
        </block>
        <block type="math_compound_assign_custom">
            <value name="VAR">
                <shadow type="var_ref_custom">
                    <field name="NAME">item</field>
                </shadow>
            </value>
            <value name="VALUE">
                <shadow type="math_number">
                    <field name="NUM">1</field>
                </shadow>
            </value>
        </block>
        <block type="math_incdec_custom">
            <value name="VAR">
                <shadow type="var_ref_custom">
                    <field name="NAME">item</field>
                </shadow>
            </value>
        </block>
        <block type="math_modulo">
            <value name="DIVIDEND">
                <shadow type="math_number">
                    <field name="NUM">10</field>
                </shadow>
            </value>
            <value name="DIVISOR">
                <shadow type="math_number">
                    <field name="NUM">3</field>
                </shadow>
            </value>
        </block>

        <sep gap="12"></sep>

        <block type="math_constrain">
            <value name="VALUE">
                <shadow type="math_number">
                    <field name="NUM">300</field>
                </shadow>
            </value>
            <value name="LOW">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
            <value name="HIGH">
                <shadow type="math_number">
                    <field name="NUM">255</field>
                </shadow>
            </value>
        </block>
        <block type="math_map_custom">
            <value name="VALUE">
                <shadow type="math_number">
                    <field name="NUM">512</field>
                </shadow>
            </value>
            <value name="FROM_LOW">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
            <value name="FROM_HIGH">
                <shadow type="math_number">
                    <field name="NUM">1023</field>
                </shadow>
            </value>
            <value name="TO_LOW">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
            <value name="TO_HIGH">
                <shadow type="math_number">
                    <field name="NUM">255</field>
                </shadow>
            </value>
        </block>
        <block type="math_random_int">
            <value name="FROM">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
            <value name="TO">
                <shadow type="math_number">
                    <field name="NUM">100</field>
                </shadow>
            </value>
        </block>
        <block type="math_random_float"></block>

        <sep gap="12"></sep>

        <block type="math_round">
            <field name="OP">ROUND</field>
            <value name="NUM">
                <shadow type="math_number">
                    <field name="NUM">3.14</field>
                </shadow>
            </value>
        </block>
        <block type="math_round_to_custom">
            <value name="PLACES">
                <shadow type="math_number">
                    <field name="NUM">2</field>
                </shadow>
            </value>
            <value name="NUM">
                <shadow type="math_number">
                    <field name="NUM">123.456</field>
                </shadow>
            </value>
        </block>
        <block type="math_minmax_custom">
            <field name="OP">MIN</field>
            <value name="A">
                <shadow type="math_number">
                    <field name="NUM">5</field>
                </shadow>
            </value>
            <value name="B">
                <shadow type="math_number">
                    <field name="NUM">9</field>
                </shadow>
            </value>
        </block>
        <block type="math_single">
            <field name="OP">ROOT</field>
            <value name="NUM">
                <shadow type="math_number">
                    <field name="NUM">9</field>
                </shadow>
            </value>
        </block>
        <block type="math_trig">
            <field name="OP">SIN</field>
            <value name="NUM">
                <shadow type="math_number">
                    <field name="NUM">30</field>
                </shadow>
            </value>
        </block>
        <block type="math_atan2">
            <value name="X">
                <shadow type="math_number">
                    <field name="NUM">1</field>
                </shadow>
            </value>
            <value name="Y">
                <shadow type="math_number">
                    <field name="NUM">1</field>
                </shadow>
            </value>
        </block>
        <block type="math_number_property">
            <field name="PROPERTY">EVEN</field>
            <value name="NUMBER_TO_CHECK">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
        </block>
        <block type="math_base_parse_custom"></block>

        <sep gap="12"></sep>

        <block type="math_bitwise_op_custom">
            <field name="OP">SHL</field>
            <value name="A">
                <shadow type="math_number">
                    <field name="NUM">8</field>
                </shadow>
            </value>
            <value name="B">
                <shadow type="math_number">
                    <field name="NUM">2</field>
                </shadow>
            </value>
        </block>
        <block type="math_bitwise_not_custom">
            <value name="NUM">
                <shadow type="math_number">
                    <field name="NUM">5</field>
                </shadow>
            </value>
        </block>
        <block type="math_highlow_byte_custom">
            <field name="PART">HIGH</field>
            <value name="NUM">
                <shadow type="math_number">
                    <field name="NUM">1234</field>
                </shadow>
            </value>
        </block>
        <block type="math_combine_word_custom">
            <value name="HIGH">
                <shadow type="math_number">
                    <field name="NUM">4</field>
                </shadow>
            </value>
            <value name="LOW">
                <shadow type="math_number">
                    <field name="NUM">210</field>
                </shadow>
            </value>
        </block>
        <block type="math_bit_read_custom">
            <value name="NUM">
                <shadow type="math_number">
                    <field name="NUM">13</field>
                </shadow>
            </value>
            <value name="BIT">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
        </block>
        <block type="math_bit_write_custom">
            <value name="NUM">
                <shadow type="math_number">
                    <field name="NUM">13</field>
                </shadow>
            </value>
            <value name="BIT">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
            <value name="VALUE">
                <shadow type="math_number">
                    <field name="NUM">1</field>
                </shadow>
            </value>
        </block>
        <block type="math_bit_set_custom">
            <value name="NUM">
                <shadow type="math_number">
                    <field name="NUM">13</field>
                </shadow>
            </value>
            <value name="BIT">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
        </block>
        <block type="math_bit_clear_custom">
            <value name="NUM">
                <shadow type="math_number">
                    <field name="NUM">13</field>
                </shadow>
            </value>
            <value name="BIT">
                <shadow type="math_number">
                    <field name="NUM">0</field>
                </shadow>
            </value>
        </block>
    </category>

    ${networkCategory}
    ${compactExtensionToolboxXml(extensionXml)}
</xml>
    `;
    return filterToolboxForCompatibility(toolboxXml, fqbn, coreVersion).xml;
};

// Backwards compatibility for initial load 
export const TOOLBOX = getToolbox('esp32:esp32:esp32c5');

// Theme for matching the UI
// Theme for matching the UI
export const THEME_LIGHT = Blockly.Theme.defineTheme('modern_teal_light', {
    'name': 'modern_teal_light',
    'base': Blockly.Themes.Classic,
    'blockStyles': {
        'hat_blocks': { 'colourPrimary': '#D97706' }, // Amber-600
        'logic_blocks': { 'colourPrimary': '#F7931A' }, // Orange (Control unified)
        'loop_blocks': { 'colourPrimary': '#F7931A' }, // Orange (Control unified)
        'math_blocks': { 'colourPrimary': MATH_HUE },
        'text_blocks': { 'colourPrimary': '#0D9488' }, // Teal-600
        'procedure_blocks': { 'colourPrimary': FUNCTION_HUE }, // Function purple
        'list_blocks': { 'colourPrimary': ARRAY_HUE }, // Arrays
        'variable_blocks': { 'colourPrimary': VARIABLE_HUE },
    },
    'componentStyles': {
        'workspaceBackgroundColour': '#FBFCFE',
        'toolboxBackgroundColour': '#F7F9FC',
        'toolboxForegroundColour': '#475569', // Slate-600
        'flyoutBackgroundColour': '#F2F5F8',
        'flyoutOpacity': 1,
        'scrollbarColour': '#CBD5E1', // Slate-300
        'scrollbarOpacity': 0.6,
        'insertionMarkerColour': '#0D9488', // Teal-600
        'insertionMarkerOpacity': 0.3,
        'cursorColour': '#0D9488', // Teal-600
    },
    'fontStyle': {
        'family': '"Inter", "Segoe UI", "Roboto", Helvetica, Arial, sans-serif',
        'weight': 'bold',
        'size': 12
    }
});

export const THEME_DARK = Blockly.Theme.defineTheme('modern_teal_dark', {
    'name': 'modern_teal_dark',
    'base': Blockly.Themes.Classic,
    'blockStyles': {
        'hat_blocks': { 'colourPrimary': '#D97706' }, // Amber-600
        'logic_blocks': { 'colourPrimary': '#F7931A' }, // Orange (Control unified)
        'loop_blocks': { 'colourPrimary': '#F7931A' }, // Orange (Control unified)
        'math_blocks': { 'colourPrimary': MATH_HUE },
        'text_blocks': { 'colourPrimary': '#14B8A6' }, // Teal-500
        'procedure_blocks': { 'colourPrimary': '#A78BFA' }, // Function purple (dark theme)
        'list_blocks': { 'colourPrimary': ARRAY_HUE }, // Arrays
        'variable_blocks': { 'colourPrimary': VARIABLE_HUE },
    },
    'componentStyles': {
        'workspaceBackgroundColour': '#0F172A', // Slate-900 (Dark Background)
        'toolboxBackgroundColour': '#1E293B', // Slate-800
        'toolboxForegroundColour': '#E2E8F0', // Slate-200
        'flyoutBackgroundColour': '#1E293B', // Slate-800
        'flyoutOpacity': 0.95,
        'scrollbarColour': '#475569', // Slate-600
        'scrollbarOpacity': 0.6,
        'insertionMarkerColour': '#14B8A6', // Teal-500
        'insertionMarkerOpacity': 0.3,
        'cursorColour': '#14B8A6', // Teal-500
    },
    'fontStyle': {
        'family': '"Inter", "Segoe UI", "Roboto", Helvetica, Arial, sans-serif',
        'weight': 'bold',
        'size': 12
    }
});

export const THEME = THEME_LIGHT;
