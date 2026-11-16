import * as Blockly from 'blockly';
import * as En from 'blockly/msg/en';
import * as ZhHans from 'blockly/msg/zh-hans';
import {
    DEFAULT_BLOCK_LOCALE,
    DEFAULT_UI_LOCALE,
    readLocalePreferences,
    resolveBlockLocale,
    type BlockLocalePreference,
    type UiLocale,
} from '../i18n/preferences';

/**
 * Blockly's locale names are deliberately kept separate from the UI locale
 * names.  This lets the editor follow the UI today while leaving room for an
 * independently selected Blockly language later.
 */
export type BlocklyLocale = UiLocale;

type MessageModule = Record<string, unknown> & {
    default?: Record<string, unknown>;
};

const toMessageMap = (module: MessageModule): Record<string, string> => {
    const source = module.default && typeof module.default === 'object'
        ? { ...module.default, ...module }
        : module;
    const messages: Record<string, string> = {};
    for (const [key, value] of Object.entries(source)) {
        if (key === 'default' || typeof value !== 'string') continue;
        messages[key] = value;
    }
    return messages;
};

const OFFICIAL_MESSAGES: Record<BlocklyLocale, Record<string, string>> = {
    'en-US': toMessageMap(En as MessageModule),
    'zh-CN': toMessageMap(ZhHans as MessageModule),
};

/** CK keeps the procedure vocabulary stable and student-friendly. */
export const PROCEDURE_MESSAGES: Record<BlocklyLocale, Record<string, string>> = {
    'zh-CN': {
        PROCEDURES_DEFNORETURN_TITLE: '定义函数',
        PROCEDURES_DEFRETURN_TITLE: '定义函数',
        PROCEDURES_DEFNORETURN_PROCEDURE: 'myFunction',
        PROCEDURES_DEFRETURN_PROCEDURE: 'myFunction',
        PROCEDURES_DEFNORETURN_DO: '执行',
        PROCEDURES_DEFRETURN_DO: '执行',
        PROCEDURES_DEFRETURN_RETURN: '返回',
        PROCEDURES_CALL_BEFORE_PARAMS: '参数',
        PROCEDURES_IFRETURN_WARNING: '“如果返回”只能在函数定义中使用',
    },
    'en-US': {
        PROCEDURES_DEFNORETURN_TITLE: 'define function',
        PROCEDURES_DEFRETURN_TITLE: 'define function',
        PROCEDURES_DEFNORETURN_PROCEDURE: 'myFunction',
        PROCEDURES_DEFRETURN_PROCEDURE: 'myFunction',
        PROCEDURES_DEFNORETURN_DO: 'do',
        PROCEDURES_DEFRETURN_DO: 'do',
        PROCEDURES_DEFRETURN_RETURN: 'return',
        PROCEDURES_CALL_BEFORE_PARAMS: 'parameters',
        PROCEDURES_IFRETURN_WARNING: '“if return” can only be used inside a function definition',
    },
};

/** Stable toolbox category IDs and their presentation labels. */
export const BLOCKLY_CATEGORY_LABELS: Record<string, Record<BlocklyLocale, string>> = {
    pins: { 'zh-CN': '引脚', 'en-US': 'Pins' },
    time: { 'zh-CN': '时间', 'en-US': 'Time' },
    logic: { 'zh-CN': '逻辑', 'en-US': 'Logic' },
    loops: { 'zh-CN': '循环', 'en-US': 'Loops' },
    functions: { 'zh-CN': '函数', 'en-US': 'Functions' },
    serial: { 'zh-CN': '串口', 'en-US': 'Serial' },
    text: { 'zh-CN': '文本', 'en-US': 'Text' },
    arrays: { 'zh-CN': '数组', 'en-US': 'Arrays' },
    variables: { 'zh-CN': '变量', 'en-US': 'Variables' },
    math: { 'zh-CN': '运算', 'en-US': 'Math' },
    network: { 'zh-CN': '网络', 'en-US': 'Network' },
    extensions: { 'zh-CN': '扩展库', 'en-US': 'Extensions' },
};

/** Stable Block Dock source IDs and their localized presentation labels. */
export const BLOCKLY_SOURCE_LABELS: Record<string, Record<BlocklyLocale, string>> = {
    all: { 'zh-CN': '全部积木', 'en-US': 'All blocks' },
    logic: { 'zh-CN': '逻辑', 'en-US': 'Logic' },
    recent: { 'zh-CN': '最近', 'en-US': 'Recent' },
    pin: { 'zh-CN': '已固定', 'en-US': 'Pinned' },
};

/**
 * A small presentation catalog for CK's imperative block definitions.  Block
 * type IDs, field values and generator contracts remain untouched.  The map is
 * intentionally data-only so Block Dock, previews and the workspace can share
 * exactly the same labels.
 */
export const BLOCKLY_BLOCK_LABELS: Record<string, Record<BlocklyLocale, string>> = {
    board_pin_selector: { 'zh-CN': '选择引脚', 'en-US': 'Select a pin' },
    io_level: { 'zh-CN': '电平', 'en-US': 'Level' },
    set_pin_mode: { 'zh-CN': '管脚模式', 'en-US': 'Pin mode' },
    io_digital_read: { 'zh-CN': '读取数字引脚', 'en-US': 'Read digital pin' },
    io_digital_write: { 'zh-CN': '设置数字引脚', 'en-US': 'Set digital pin' },
    io_analog_read: { 'zh-CN': '读取模拟引脚', 'en-US': 'Read analog pin' },
    io_analog_write: { 'zh-CN': '设置模拟引脚', 'en-US': 'Set analog pin' },
    control_delay: { 'zh-CN': '延时', 'en-US': 'Delay' },
    controls_delay: { 'zh-CN': '延时', 'en-US': 'Delay' },
    controls_setup_custom: { 'zh-CN': '初始化', 'en-US': 'Setup' },
    controls_loop_custom: { 'zh-CN': '循环', 'en-US': 'Loop' },
    controls_switch_custom: { 'zh-CN': '条件分支', 'en-US': 'Switch' },
    controls_do_while_custom: { 'zh-CN': '当条件成立时重复', 'en-US': 'Repeat while' },
    logic_ternary_stmt_custom: { 'zh-CN': '条件表达式', 'en-US': 'Conditional expression' },
    serial_setup: { 'zh-CN': '设置串口', 'en-US': 'Set up serial' },
    serial_setup_with_pins: { 'zh-CN': '设置串口引脚', 'en-US': 'Set serial pins' },
    serial_begin: { 'zh-CN': '设置串口波特率', 'en-US': 'Set serial baud rate' },
    serial_print: { 'zh-CN': '串口打印', 'en-US': 'Print to serial' },
    serial_println: { 'zh-CN': '串口打印并换行', 'en-US': 'Print to serial with newline' },
    serial_print_number: { 'zh-CN': '串口打印数字', 'en-US': 'Print number to serial' },
    serial_available: { 'zh-CN': '串口有数据', 'en-US': 'Serial data available' },
    serial_read_byte: { 'zh-CN': '读取串口字节', 'en-US': 'Read serial byte' },
    serial_read_string: { 'zh-CN': '读取串口文本', 'en-US': 'Read serial text' },
    serial_read_string_until: { 'zh-CN': '读取串口文本直到', 'en-US': 'Read serial text until' },
    var_declare_custom: { 'zh-CN': '声明变量', 'en-US': 'Declare variable' },
    var_set_custom: { 'zh-CN': '赋值', 'en-US': 'Set variable' },
    var_ref_custom: { 'zh-CN': '读取变量', 'en-US': 'Get variable' },
    var_cast_custom: { 'zh-CN': '转换变量类型', 'en-US': 'Cast variable type' },
    variables_declare: { 'zh-CN': '声明变量', 'en-US': 'Declare variable' },
    math_auto_add_or_minus: { 'zh-CN': '自动加减', 'en-US': 'Auto increment/decrement' },
    math_compound_assign_custom: { 'zh-CN': '复合赋值', 'en-US': 'Compound assignment' },
    math_incdec_custom: { 'zh-CN': '自增/自减', 'en-US': 'Increment/decrement' },
    math_minmax_custom: { 'zh-CN': '最小值/最大值', 'en-US': 'Minimum/maximum' },
    text_concat_custom: { 'zh-CN': '连接文本', 'en-US': 'Join text' },
    text_substring_custom: { 'zh-CN': '截取文本', 'en-US': 'Get substring' },
    text_replace_all_custom: { 'zh-CN': '替换文本', 'en-US': 'Replace text' },
    text_reverse_custom: { 'zh-CN': '反转文本', 'en-US': 'Reverse text' },
    text_trim_custom: { 'zh-CN': '去除空白', 'en-US': 'Trim text' },
    value_to_text_custom: { 'zh-CN': '转换为文本', 'en-US': 'Convert to text' },
    array_declare_1d_custom: { 'zh-CN': '创建一维数组', 'en-US': 'Create 1D array' },
    array_declare_1d_empty_custom: { 'zh-CN': '创建空一维数组', 'en-US': 'Create empty 1D array' },
    array_declare_2d_custom: { 'zh-CN': '创建二维数组', 'en-US': 'Create 2D array' },
    array_get_1d_custom: { 'zh-CN': '读取数组', 'en-US': 'Read array item' },
    array_set_1d_custom: { 'zh-CN': '写入数组', 'en-US': 'Write array item' },
    array_length_1d_custom: { 'zh-CN': '获取数组长度', 'en-US': 'Get array length' },
    array_push_1d_custom: { 'zh-CN': '数组末尾添加', 'en-US': 'Append to array' },
    array_remove_1d_custom: { 'zh-CN': '删除数组元素', 'en-US': 'Remove array item' },
    wifi_connect: { 'zh-CN': '连接 Wi-Fi', 'en-US': 'Connect to Wi-Fi' },
    wifi_local_ip: { 'zh-CN': '获取本机 IP', 'en-US': 'Get local IP' },
    wifi_get_rssi: { 'zh-CN': '获取 Wi-Fi 信号', 'en-US': 'Get Wi-Fi signal' },
};

/** Common labels used by imperative CK block definitions and dropdowns. */
const TEXT_TRANSLATIONS: Record<string, string> = {
    '初始化': 'Setup',
    '管脚模式': 'Pin mode',
    '设置串口波特率': 'Set serial baud rate',
    '设置串口': 'Set up serial',
    '设置串口引脚': 'Set serial pins',
    '设置': 'Set',
    '读取': 'Read',
    '获取': 'Get',
    '写入': 'Write',
    '创建': 'Create',
    '删除': 'Delete',
    '清空': 'Clear',
    '添加': 'Add',
    '移除': 'Remove',
    '转换': 'Convert',
    '设置为': 'set to',
    '串口打印': 'Print to serial',
    '串口打印并换行': 'Print to serial with newline',
    '串口打印数字': 'Print number to serial',
    '读取串口字节': 'Read serial byte',
    '读取串口文本': 'Read serial text',
    '读取数字引脚': 'Read digital pin',
    '设置数字引脚': 'Set digital pin',
    '读取模拟引脚': 'Read analog pin',
    '设置模拟引脚': 'Set analog pin',
    '数字输出': 'Digital output',
    '延时': 'Delay',
    '等待': 'Wait',
    '循环': 'Loop',
    '重复执行': 'Repeat',
    '重复': 'Repeat',
    '如果': 'if',
    '否则': 'else',
    '那么': 'then',
    '条件': 'Condition',
    '执行': 'do',
    '函数': 'Function',
    '调用': 'Call',
    '返回': 'return',
    '参数': 'parameters',
    '变量': 'Variable',
    '赋值': 'Set variable',
    '读取变量': 'Get variable',
    '声明变量': 'Declare variable',
    '文本': 'Text',
    '连接文本': 'Join text',
    '截取文本': 'Get substring',
    '替换文本': 'Replace text',
    '反转文本': 'Reverse text',
    '数组': 'Array',
    '一维数组': '1D array',
    '二维数组': '2D array',
    '获取数组长度': 'Get array length',
    '读取数组': 'Read array item',
    '写入数组': 'Write array item',
    '高': 'High',
    '低': 'Low',
    '输出': 'Output',
    '输入': 'Input',
    '上拉输入': 'Pull-up input',
    '单击': 'Single click',
    '双击': 'Double click',
    '上升': 'Rising',
    '下降': 'Falling',
    '电平': 'Level',
    '电平变化': 'Level change',
    '不换行': 'No newline',
    '换行': 'Newline',
    '毫秒': 'ms',
    '秒': 's',
    '真': 'true',
    '假': 'false',
    '是': 'yes',
    '否': 'no',
    '打开': 'Open',
    '关闭': 'Close',
    '开始': 'Start',
    '停止': 'Stop',
    '模式': 'Mode',
    '类型': 'Type',
    '长度': 'Length',
    '长度变量': 'Length variable',
    '行': 'Row',
    '列': 'Column',
    '行数变量': 'Row count variable',
    '行项': 'Row item',
    '行值': 'Row value',
    '值': 'Value',
    '数值': 'Value',
    '数量': 'Count',
    '下标': 'Index',
    '步数': 'Steps',
    '维度': 'Dimensions',
    '维1': 'Dimension 1',
    '维2': 'Dimension 2',
    '维3': 'Dimension 3',
    '初值': 'Initial value',
    '初值项': 'Initial value item',
    '顺序': 'Order',
    '内容': 'Content',
    '波特率': 'Baud rate',
    '间隔': 'Interval',
    '度': 'degrees',
    '标签': 'Label',
    '数组末尾添加': 'Append to array',
    '末尾添加一行': 'Append a row',
    '新增一行': 'Add a row',
    '新增一维': 'Add a dimension',
    '新增一维下标': 'Add a dimension index',
    '插入值': 'Insert value',
    '插入行值': 'Insert row value',
    '返回线性下标': 'Return linear index',
    '在数组': 'In array',
    '在下标': 'At index',
    '在行': 'In row',
    '中查找': 'Find in',
    '包含': 'Contains',
    '包含值': 'Contains value',
    '和': 'and',
    '或': 'or',
    '从': 'from',
    '到': 'to',
    '为': 'as',
    '将': 'Set',
    '把': 'Set',
    '换成': 'replace with',
    '变成': 'convert to',
    '保留': 'Keep',
    '删除文本空白': 'Remove text whitespace',
    '数字': 'number',
    '文字': 'text',
    '字符常量': 'Character constant',
    '自动 (默认)': 'Auto (default)',
    '仅 802.11 ax': '802.11 ax only',
    '简单定时器': 'Simple timer',
    '当前微秒': 'Current microseconds',
    '延时 微秒': 'Delay microseconds',
    '组合16位 高位': 'Combine 16-bit high part',
    '低位': 'Low part',
    '低位先入': 'Low bit first',
    '高位先入': 'High bit first',
    '的第': 'at index',
    '位': 'bit',
    '位为': 'bit to',
    '位小数的': 'decimal places of',
    '个字': 'characters',
    '里截取 第': 'take from position',
    '把文字': 'Set text',
    '把数字': 'Set number',
    '把字符': 'Set character',
    '把这个值': 'Set this value',
    '对比': 'Compare',
    '拼在一起': 'join together',
    '变成文字': 'convert to text',
    '从文字': 'From text',
    '数一数': 'Count',
    '在这段文字里': 'in this text',
    '里的': 'in',
    '调用函数': 'Call function',
    '跳转到指定标签': 'Jump to label',
    '定义 goto 跳转标签': 'Define a goto label',
    '声明': 'Declare',
    '并赋值': 'and assign',
    '范围': 'range',
    '串口': 'Serial',
    '串口打印文本': 'Print text to serial',
    '串口 原始输出': 'Serial raw output',
    '串口 清空缓冲区数据': 'Clear serial buffer',
    '串口 有数据可读?': 'Serial data available?',
    '串口 读取字符串': 'Read string from serial',
    '串口 读取字符串直到': 'Read string from serial until',
    '初始化串口': 'Initialize serial',
    '数字输入 管脚 #': 'Digital input pin #',
    '模拟输入 管脚 #': 'Analog input pin #',
    '模拟输出 管脚 #': 'Analog output pin #',
    '软件模拟输出 管脚 #': 'Software analog output pin #',
    '取消软件模拟输出 管脚 #': 'Stop software analog output pin #',
    '硬件中断 管脚 #': 'Hardware interrupt pin #',
    '取消硬件中断 管脚 #': 'Cancel hardware interrupt pin #',
    '软件中断 管脚 #': 'Software interrupt pin #',
    '取消软件中断 管脚 #': 'Cancel software interrupt pin #',
    'ShiftOut 数据管脚 #': 'ShiftOut data pin #',
    'ShiftIn 数据管脚 #': 'ShiftIn data pin #',
    '时钟管脚 #': 'Clock pin #',
    '增删改查': 'Create / read / update / delete',
    '数组操作': 'Array operations',
    '二维增删改查': '2D array CRUD',
    '三维与多维': '3D and multidimensional',
    '数字输入': 'Digital input',
    '模拟输入': 'Analog input',
    '模拟输出': 'Analog output',
    '软件模拟输出': 'Software analog output',
    '软件 PWM 输出': 'Software PWM output',
    '硬件中断': 'Hardware interrupt',
    '软件中断': 'Software interrupt',
    '取消硬件中断': 'Cancel hardware interrupt',
    '取消软件中断': 'Cancel software interrupt',
    '开启中断': 'Enable interrupts',
    '关闭中断': 'Disable interrupts',
    '全局开启中断': 'Enable interrupts globally',
    '全局关闭中断': 'Disable interrupts globally',
    '设置引脚输入输出模式': 'Set pin input/output mode',
    '设置WiFi协议': 'Set Wi-Fi protocol',
    '连接WiFi': 'Connect to Wi-Fi',
    '等待直到WiFi连接成功': 'Wait until Wi-Fi connects',
    '获取本机IP地址': 'Get local IP address',
    '获取WiFi信道': 'Get Wi-Fi channel',
    '获取WiFi信号强度 (RSSI)': 'Get Wi-Fi signal strength (RSSI)',
    '设置 Serial.begin 波特率': 'Set Serial.begin baud rate',
    '检查串口是否有可读数据': 'Check whether serial data is available',
    '串口有数据可读?': 'Serial data available?',
    '清空串口输入缓冲': 'Clear serial input buffer',
    '串口原始输出': 'Raw serial output',
    '串口 read': 'Serial read',
    '收到串口数据时执行代码块': 'Run when serial data arrives',
    '读取串口字符串': 'Read serial string',
    '读取一个字节 (-1 表示无数据)': 'Read one byte (-1 means no data)',
    '读取直到指定终止字符': 'Read until the terminator',
    '按引脚初始化硬件串口 (ESP32/多串口板可用)': 'Initialize a hardware serial port (ESP32/multi-serial boards)',
    '创建一维数组': 'Create 1D array',
    '创建一维数组并赋值': 'Create and assign a 1D array',
    '创建一维数组并赋值，可用齿轮增减初值项': 'Create and assign a 1D array with adjustable initial values',
    '只声明一维数组（不初始化具体值）': 'Declare a 1D array without initializing values',
    '创建二维数组': 'Create 2D array',
    '创建二维数组并赋值': 'Create and assign a 2D array',
    '创建二维数组并按行初始化（齿轮增减行项）': 'Create and initialize a 2D array by row',
    '创建三维数组': 'Create 3D array',
    '创建多维数组': 'Create multidimensional array',
    '创建任意维数组（齿轮增减维度）': 'Create an array with any number of dimensions',
    '读取一维数组元素': 'Read a 1D array item',
    '写入一维数组元素': 'Write a 1D array item',
    '获取一维数组长度': 'Get 1D array length',
    '读取二维数组': 'Read 2D array',
    '写入二维数组': 'Write 2D array',
    '读取二维数组元素': 'Read a 2D array item',
    '写入二维数组元素': 'Write a 2D array item',
    '读取多维数组': 'Read multidimensional array',
    '写入多维数组': 'Write multidimensional array',
    '读取多维数组元素（齿轮增减下标）': 'Read a multidimensional array item',
    '写入多维数组元素（齿轮增减下标）': 'Write a multidimensional array item',
    '末尾添加': 'Append at end',
    '向一维数组末尾添加元素（长度变量会自动 +1，超出容量时不添加）': 'Append an item to a 1D array',
    '向二维数组末尾添加一行（可接入 {a,b,c} 行值；若接入单值则整行填充该值）': 'Append a row to a 2D array',
    '删除数组元素': 'Remove an array item',
    '删除下标': 'Remove index',
    '删除行下标': 'Remove row index',
    '清空数组': 'Clear array',
    '全部填充为': 'Fill all with',
    '反转数组': 'Reverse array',
    '按当前长度对一维数组排序': 'Sort a 1D array by current length',
    '按当前长度反转一维数组': 'Reverse a 1D array by current length',
    '按当前长度循环左移/右移指定步数': 'Rotate a 1D array by a number of steps',
    '判断数组中是否包含该值': 'Check whether the array contains the value',
    '判断二维数组是否包含指定值': 'Check whether the 2D array contains the value',
    '返回两个数中的最小值或最大值': 'Return the minimum or maximum of two numbers',
    '返回值所在下标，找不到返回 -1': 'Return the value index, or -1 if not found',
    '返回首个匹配元素的线性下标（row * 列数 + col），找不到返回 -1': 'Return the first matching linear index, or -1 if not found',
    '按进制打印数字': 'Print a number in the selected base',
    '把不同进制文本转换为数字': 'Convert text in a base to a number',
    '把数字或其他值变成文字': 'Convert a number or value to text',
    '把文字变成数字、布尔等类型': 'Convert text to a number, Boolean, or other type',
    '判断文字开头或结尾是不是一样': 'Check whether text starts or ends with the same pattern',
    '统计子串出现次数': 'Count substring occurrences',
    '替换文本中的所有匹配项': 'Replace all matching text',
    '去掉两边空格': 'Trim both sides',
    '去掉左边空格': 'Trim the left side',
    '去掉右边空格': 'Trim the right side',
    '文本大小写转换': 'Convert text case',
    '变大写': 'Uppercase',
    '变小写': 'Lowercase',
    '倒转文本': 'Reverse text',
    '变成字符(ASCII)': 'Convert to a character (ASCII)',
    '字符转ASCII数值': 'Convert a character to an ASCII number',
    'ASCII数值转字符': 'Convert an ASCII number to a character',
    '类型强制转换': 'Type cast',
    '强制转换为': 'Cast to',
    '使用 malloc 申请动态内存': 'Allocate dynamic memory with malloc',
    '释放 malloc 申请的内存': 'Free memory allocated by malloc',
    '释放动态内存': 'Free dynamic memory',
    '动态申请': 'Dynamic allocation',
    '比较两个值': 'Compare two values',
    '布尔取反': 'Invert Boolean',
    '布尔与/或运算': 'Boolean AND/OR',
    '位运算与移位': 'Bitwise operations and shifts',
    '按位取反': 'Bitwise NOT',
    '设置某一位为 0 或 1': 'Set a bit to 0 or 1',
    '读取某一位的值': 'Read a bit value',
    '提取高8位或低8位': 'Extract the high or low 8 bits',
    '用高8位和低8位组合成16位数': 'Combine high and low 8 bits into a 16-bit number',
    '长按': 'Long press',
    '当串口收到数据时': 'When serial data arrives',
    '硬件中断触发执行': 'Run on a hardware interrupt',
    '通过轮询模拟中断触发': 'Trigger a simulated interrupt by polling',
    '通过 ShiftIn 读取 8 位数据': 'Read 8-bit data with ShiftIn',
    '通过 ShiftOut 发送 8 位数据': 'Send 8-bit data with ShiftOut',
    'SimpleTimer 周期回调': 'SimpleTimer periodic callback',
};

const initialLocalePreferences = readLocalePreferences();
let activeBlocklyLocale: BlocklyLocale = resolveBlockLocale(
    initialLocalePreferences.blockLocale,
    initialLocalePreferences.uiLocale,
);
let presentationPatchesInstalled = false;

export const normalizeBlocklyLocale = (locale: unknown): BlocklyLocale => {
    if (typeof locale !== 'string') return DEFAULT_UI_LOCALE;
    const value = locale.trim().toLowerCase().replace('_', '-');
    return value === 'en' || value.startsWith('en-') ? 'en-US' : 'zh-CN';
};

export const getBlocklyLocale = (): BlocklyLocale => activeBlocklyLocale;

export const getEffectiveBlocklyLocale = (
    preference: BlockLocalePreference = DEFAULT_BLOCK_LOCALE,
    uiLocale: UiLocale = DEFAULT_UI_LOCALE,
): BlocklyLocale => resolveBlockLocale(preference, uiLocale);

/** Return a copy so callers cannot mutate the imported Blockly message table. */
export const getOfficialBlocklyMessages = (
    locale: BlocklyLocale,
): Record<string, string> => ({ ...OFFICIAL_MESSAGES[normalizeBlocklyLocale(locale)] });

/**
 * Apply one complete Blockly message table. Blockly's API merges messages into
 * its singleton, so we always supply the full official table and CK overrides.
 */
export const applyBlocklyLocale = (locale: BlocklyLocale): BlocklyLocale => {
    const normalized = normalizeBlocklyLocale(locale);
    Blockly.setLocale({
        ...getOfficialBlocklyMessages(normalized),
        ...PROCEDURE_MESSAGES[normalized],
    });
    activeBlocklyLocale = normalized;
    return normalized;
};

export const getBlocklyCategoryLabel = (
    categoryId: string,
    locale: BlocklyLocale = activeBlocklyLocale,
): string => BLOCKLY_CATEGORY_LABELS[categoryId]?.[normalizeBlocklyLocale(locale)]
    ?? categoryId;

export const getBlocklySourceLabel = (
    sourceId: string,
    locale: BlocklyLocale = activeBlocklyLocale,
): string => BLOCKLY_SOURCE_LABELS[sourceId]?.[normalizeBlocklyLocale(locale)]
    ?? sourceId;

export const getBlocklyBlockLabel = (
    blockType: string,
    locale: BlocklyLocale = activeBlocklyLocale,
): string => BLOCKLY_BLOCK_LABELS[blockType]?.[normalizeBlocklyLocale(locale)]
    ?? blockType;

/**
 * Translate labels/tooltips authored as plain strings in CK block definitions.
 * This function never receives or mutates a field value, dropdown value, block
 * type, variable ID, or serialized workspace datum. Unknown text is preserved
 * rather than guessed, which is safer for extension/user content.
 */
export const translateBlocklyText = (
    text: unknown,
    locale: BlocklyLocale = activeBlocklyLocale,
): string => {
    const source = String(text ?? '');
    const normalized = normalizeBlocklyLocale(locale);
    if (normalized === 'zh-CN' || !source) return source;

    const exact = TEXT_TRANSLATIONS[source];
    if (exact) return exact;

    const dimensionMatch = source.match(/^第(\d+)维(长度|下标)$/u);
    if (dimensionMatch) {
        return `Dimension ${dimensionMatch[1]} ${dimensionMatch[2] === '长度' ? 'length' : 'index'}`;
    }

    // Longest-first replacement avoids turning a phrase into a partially
    // translated phrase before its more specific entry can match.
    return Object.keys(TEXT_TRANSLATIONS)
        .sort((a, b) => b.length - a.length)
        .reduce((result, key) => result.split(key).join(TEXT_TRANSLATIONS[key]), source);
};

export const translateBlocklyTooltip = translateBlocklyText;

/**
 * Install the presentation-only hooks used by CK's imperative block
 * definitions. Only plain label/tooltip strings are touched; Blockly Field
 * instances (including dropdown and text-input values) pass through unchanged.
 * The patch is idempotent and safe to call before or after block definitions
 * are registered.
 */
export const installBlocklyLocalePresentationPatches = (): void => {
    if (presentationPatchesInstalled) return;

    const inputPrototype = (Blockly.Input as any)?.prototype;
    const appendField = inputPrototype?.appendField;
    if (typeof appendField === 'function') {
        inputPrototype.appendField = function (field: unknown, optName?: string) {
            const localizedField = typeof field === 'string'
                ? translateBlocklyText(field)
                : field;
            return appendField.call(this, localizedField, optName);
        };
    }

    const blockPrototype = (Blockly.Block as any)?.prototype;
    const setTooltip = blockPrototype?.setTooltip;
    if (typeof setTooltip === 'function') {
        blockPrototype.setTooltip = function (tooltip: unknown) {
            // Tooltip callbacks may carry context-specific/raw text. Keep
            // callback identity and arguments intact; only translate the
            // returned presentation string.
            if (typeof tooltip === 'function') {
                const wrapped = (...args: unknown[]) => translateBlocklyTooltip(
                    tooltip.apply(this, args),
                );
                return setTooltip.call(this, wrapped);
            }
            return setTooltip.call(
                this,
                typeof tooltip === 'string' ? translateBlocklyTooltip(tooltip) : tooltip,
            );
        };
    }

    const dropdownPrototype = (Blockly.FieldDropdown as any)?.prototype;
    const setOptions = dropdownPrototype?.setOptions;
    if (typeof setOptions === 'function') {
        dropdownPrototype.setOptions = function (options: unknown) {
            const localizeOptions = (items: unknown): unknown => {
                if (!Array.isArray(items)) return items;
                return items.map((item: unknown) => {
                    if (!Array.isArray(item) || typeof item[0] !== 'string') return item;
                    // Dynamic/user-owned dropdowns (for example variable
                    // names) use the same value for the visible label and
                    // the persisted value. Do not run those through the
                    // presentation catalog.
                    if (item[0] === item[1]) return item;
                    // Keep the second tuple element untouched: it is the
                    // language-neutral value persisted in the workspace.
                    return [translateBlocklyText(item[0]), item[1]];
                });
            };
            const localizedOptions = typeof options === 'function'
                ? (...args: unknown[]) => localizeOptions(options.apply(this, args))
                : localizeOptions(options);
            return setOptions.call(this, localizedOptions);
        };
    }

    presentationPatchesInstalled = true;
};

/** Exposed for tests and for catalog consumers that need the stable key set. */
export const getBlocklyCatalogEntry = (
    blockType: string,
    locale: BlocklyLocale = activeBlocklyLocale,
): { type: string; label: string } => ({
    type: blockType,
    label: getBlocklyBlockLabel(blockType, locale),
});

// Keep the initial global Blockly message state aligned with the current UI
// default. Workspace code may call applyBlocklyLocale again after preferences
// have been loaded; this is idempotent and does not touch workspace data.
installBlocklyLocalePresentationPatches();
applyBlocklyLocale(activeBlocklyLocale);
