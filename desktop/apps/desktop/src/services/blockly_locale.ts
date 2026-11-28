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
    // Additional built-in block labels, dropdowns, and tooltips (blockly_setup.ts)
    '8位整型 (int8_t)': '8-bit int (int8_t)',
    '8位无符号 (uint8_t)': '8-bit uint (uint8_t)',
    '16位整型 (int16_t)': '16-bit int (int16_t)',
    '16位无符号 (uint16_t)': '16-bit uint (uint16_t)',
    '32位整型 (int32_t)': '32-bit int (int32_t)',
    '32位无符号 (uint32_t)': '32-bit uint (uint32_t)',
    '整型 (int)': 'int',
    '整型 int': 'int',
    '无符号整型 (unsigned int)': 'unsigned int',
    '无符号整型 unsigned int': 'unsigned int',
    '长整型 (long)': 'long',
    '长整型 long': 'long',
    '无符号长整型 (unsigned long)': 'unsigned long',
    '无符号长整型 unsigned long': 'unsigned long',
    '浮点 (float)': 'float',
    '浮点 float': 'float',
    '双精度 (double)': 'double',
    '双精度 double': 'double',
    '字符 (char)': 'char',
    '字符 char': 'char',
    '字符串 (String)': 'String',
    '字符串 String': 'String',
    '字节 (byte)': 'byte',
    '字节 byte': 'byte',
    '布尔 (bool)': 'bool',
    '布尔 bool': 'bool',
    '普通': 'Normal',
    '常量 const': 'const',
    '静态 static': 'static',
    '静态常量 static const': 'static const',
    '易变 volatile': 'volatile',
    '静态易变 static volatile': 'static volatile',
    '全局变量': 'Global variable',
    '局部变量': 'Local variable',
    '十进制': 'Decimal',
    '十六进制': 'Hexadecimal',
    '八进制': 'Octal',
    '二进制': 'Binary',
    '进制数': 'Base number',
    '前置++': 'Prefix ++',
    '前置--': 'Prefix --',
    '后置++': 'Postfix ++',
    '后置--': 'Postfix --',
    '最小值': 'Min',
    '最大值': 'Max',
    '映射': 'Map',
    '映射到': 'to range',
    '置位': 'Set bit',
    '清零': 'Clear bit',
    '高8位': 'High byte',
    '低8位': 'Low byte',
    '升序': 'Ascending',
    '降序': 'Descending',
    '排序': 'Sort',
    '左移': 'Shift left',
    '右移': 'Shift right',
    '复制数组': 'Copy array',
    '源长度': 'Source length',
    '目标长度': 'Target length',
    '查找二维数组': 'Search 2D array',
    '读取三维数组': 'Read 3D array',
    '写入三维数组': 'Write 3D array',
    '读取三维数组元素': 'Read 3D array item',
    '写入三维数组元素': 'Write 3D array item',
    '二维数组的一行初值': 'Initial row values for a 2D array',
    '与': 'AND',
    '非': 'NOT',
    '如果是': 'if',
    '则': 'then',
    '按照': 'switch',
    '就执行': 'do',
    '其他情况': 'default',
    '其他情况执行': 'default do',
    '添加分支': 'Add case',
    '当条件为真': 'while condition is true',
    '控制流': 'Control flow',
    '跳出循环': 'Break loop',
    '进入下次循环': 'Continue loop',
    'loop 循环': 'Loop',
    '设为': 'set to',
    '赋值为': 'set to',
    '到第': 'to position',
    '看开头': 'Starts with',
    '看结尾': 'Ends with',
    '变成ASCII数字': 'to ASCII number',
    'MsTimer2启动': 'MsTimer2 start',
    'MsTimer2停止': 'MsTimer2 stop',
    'MsTimer2每隔': 'MsTimer2 every',
    '系统运行时间': 'System uptime',
    '获取系统运行时间': 'Get system uptime',
    '微秒': 'us',
    '状态': 'State',
    '变化': 'Change',
    '电平触发': 'Level trigger',
    '多功能按键 管脚 #': 'Multi-button pin #',
    '数字输出 管脚 #': 'Digital output pin #',
    '脉冲长度 (微秒) 管脚 #': 'Pulse length (us) pin #',
    '脉冲长度长 (微秒) 管脚 #': 'Long pulse length (us) pin #',
    '超时 (微秒)': 'Timeout (us)',
    '舵机': 'Servo',
    '转动到': 'rotate to',
    '引脚': 'Pin',
    '时间': 'Time',
    '运算': 'Math',
    '逻辑': 'Logic',
    '密码': 'Password',
    '常用波特率': 'Common baud rate',
    '802.11 ax (WiFi 6 - C5专用)': '802.11 ax (Wi-Fi 6 - C5 only)',
    '扩展库': 'Extensions',
    '未选择': 'Not selected',
    // Block tooltips
    'pulseInLong 读取脉冲长度': 'Read pulse length with pulseInLong',
    'Serial.write 原始输出字节': 'Write raw byte with Serial.write',
    '从下拉列表选择并调用无返回值函数': 'Select and call a void function from the list',
    '从下拉列表选择有返回值函数并取得结果': 'Select and call a function that returns a value',
    '作为 loop() 主体的显式积木': 'Explicit block for the loop() body',
    '停止 MsTimer2 定时器': 'Stop the MsTimer2 timer',
    '启动 MsTimer2 定时器': 'Start the MsTimer2 timer',
    '配置 MsTimer2 周期回调': 'Configure MsTimer2 periodic callback',
    '停止当前函数': 'Stop the current function',
    '先执行再判断条件的循环': 'Run body first, then check condition (do-while)',
    '兼容旧版 controls_delay 积木': 'Legacy controls_delay block',
    '兼容旧版 serial_begin 积木': 'Legacy serial_begin block',
    '兼容旧版 serial_println 积木': 'Legacy serial_println block',
    '兼容旧版 variables_declare 积木': 'Legacy variables_declare block',
    '兼容旧版自增/自减积木': 'Legacy increment/decrement block',
    '删除指定下标元素，后续元素左移（长度变量会自动 -1）': 'Remove item at index and shift remaining items left (length decrements automatically)',
    '删除指定行（后续行上移，行数变量自动 -1）': 'Remove row at index and shift remaining rows up (row count decrements automatically)',
    '取消指定引脚的硬件中断': 'Detach hardware interrupt on the specified pin',
    '取消指定引脚的软件中断': 'Cancel software interrupt on the specified pin',
    '变量引用，可插入到表达式输入口': 'Variable reference for expression inputs',
    '可上下连接的三则语句块，形式：条件 ? 值1 : 值2': 'Inline ternary statement: condition ? value1 : value2',
    '在 setup() 中执行一次': 'Run once inside setup()',
    '在指定下标插入元素，后续元素右移（长度变量会自动 +1）': 'Insert item at index and shift remaining items right (length increments automatically)',
    '在指定行插入一行（可接入 {a,b,c} 行值；若接入单值则整行填充该值）': 'Insert a row at index (accepts {a,b,c} row or fills row with a single value)',
    '声明变量，支持局部/全局、static/const/volatile 修饰': 'Declare a variable with local/global scope and static/const/volatile qualifiers',
    '复制源数组到目标数组，目标长度自动更新（受目标容量限制）': 'Copy source array to target array and update target length within capacity',
    '复合赋值运算': 'Compound assignment operation',
    '定义无返回值函数。': 'Define a function with no return value.',
    '定义有返回值函数，可设置返回类型。': 'Define a function with a configurable return type.',
    '对指定变量执行自增或自减': 'Increment or decrement the selected variable',
    '将一个范围内的数值线性映射到另一个范围': 'Linearly map a value from one range to another',
    '将数组逻辑长度清零（不改变底层容量）': 'Reset logical array length to 0 without changing capacity',
    '将数组逻辑长度范围内的元素全部设为同一值': 'Fill all elements within the logical array length with one value',
    '延时（毫秒/微秒）': 'Delay (ms / us)',
    '把两段文字接成一段': 'Concatenate two text values',
    '把数字保留到指定小数位': 'Format a number to the specified decimal places',
    '把某一位清零': 'Clear a specific bit to 0',
    '把某一位设置为1': 'Set a specific bit to 1',
    '按字符位置获取子串（1起始）': 'Get substring by 1-based character position',
    '按指定类型返回值。': 'Return a value of the specified type.',
    '按键事件触发：单击/双击/长按': 'Button event trigger: single click / double click / long press',
    '数字电平常量': 'Digital level constant',
    '条件为真时取“则”，否则取“否则”': 'Return first value when true, otherwise second value',
    '条件成立时直接结束函数。': 'Exit the function immediately when condition is true.',
    '条件成立时返回一个值。': 'Return a value immediately when condition is true.',
    '根据值选择执行分支': 'Run a branch matching the selected value',
    '立即结束当前函数，不返回数值。': 'Exit the current function without returning a value.',
    '立即结束当前函数，并返回一个值。': 'Exit the current function and return a value.',
    '给变量赋值': 'Assign a value to a variable',
    '读取脉冲长度(带超时)': 'Read pulse length with timeout',
    '读取脉冲长度(微秒)': 'Read pulse length (us)',
    '调用无返回值函数': 'Call a void function',
    '调用有返回值函数': 'Call a function with return value',
    '停止软件 PWM 输出': 'Stop software PWM output',
    '模拟输出/PWM 写入 (0-255)': 'Analog / PWM write (0-255)',
    '设置数字输出电平': 'Set digital output level',
    '读取数字输入电平': 'Read digital input level',
    '读取模拟输入值': 'Read analog input value',
    '软件 PWM 输出 (0-255)': 'Software PWM output (0-255)',
    '返回 micros()': 'Return micros()',
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
