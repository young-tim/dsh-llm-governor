/** Fenced 代码块标记（``` 或 ~~~）。 */
const CODE_FENCE = /(?:^|\n)\s*(?:```|~~~)/;
/** 缩进代码块：行首 4 个空格或 1 个 tab。 */
const INDENTED_CODE = /(?:^|\n)(?: {4}|\t)\S/;
/** 错误栈：Error: message 或 at frame 行。 */
const ERROR_STACK = /(?:^|\n)\s*(?:Error|TypeError|ReferenceError|SyntaxError|RangeError|RuntimeError):\s|\n\s+at\s+/;
/** SQL DML/DDL 关键字（单词边界，大小写不敏感）。 */
const SQL_KEYWORDS = /\b(?:SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE\s+TABLE)\b/i;
/** Markdown 表格分隔行：| --- | 形式。 */
const TABLE_SEPARATOR = /\|\s*:?-{3,}:?\s*\|/;
/** 长文阈值（拼接文本字符数）。 */
const LONG_TEXT_THRESHOLD = 2000;
/**
 * 拼接所有消息文本，使用换行分隔。
 * @param input - 分类输入。
 * @returns 拼接后的纯文本（缺省 text 视为空字符串）。
 */
function joinMessageText(input) {
    return input.messages.map((m) => m.text ?? '').join('\n');
}
/**
 * 按消息总长度推断复杂度。
 *
 * 阈值（来自技术方案 §10.5）：
 * - < 100 字符 → low
 * - 100..500 字符 → medium
 * - > 500 字符 → high
 *
 * @param totalLength - 拼接后的消息总字符数。
 * @returns 复杂度等级。
 */
export function complexityByLength(totalLength) {
    if (totalLength < 100)
        return 'low';
    if (totalLength <= 500)
        return 'medium';
    return 'high';
}
/**
 * 按 Rule 规则分类。
 *
 * 规则按优先级顺序匹配，第一条命中即返回；全部不命中返回 undefined。
 * @param input - 分类输入。
 */
export function classifyByRule(input) {
    const text = joinMessageText(input);
    // 1. 代码块 → coding, medium, 0.8
    if (CODE_FENCE.test(text) || INDENTED_CODE.test(text)) {
        return {
            taskType: 'coding',
            complexity: 'medium',
            confidence: 0.8,
            source: 'rule',
        };
    }
    // 2. 错误栈 → coding, high, 0.75
    if (ERROR_STACK.test(text)) {
        return {
            taskType: 'coding',
            complexity: 'high',
            confidence: 0.75,
            source: 'rule',
        };
    }
    // 3. SQL → data_analysis, medium, 0.75
    if (SQL_KEYWORDS.test(text)) {
        return {
            taskType: 'data_analysis',
            complexity: 'medium',
            confidence: 0.75,
            source: 'rule',
        };
    }
    // 4. 表格 → data_analysis, medium, 0.7
    if (TABLE_SEPARATOR.test(text)) {
        return {
            taskType: 'data_analysis',
            complexity: 'medium',
            confidence: 0.7,
            source: 'rule',
        };
    }
    // 5. 长文 → writing, high, 0.6
    if (text.length > LONG_TEXT_THRESHOLD) {
        return {
            taskType: 'writing',
            complexity: 'high',
            confidence: 0.6,
            source: 'rule',
        };
    }
    return undefined;
}
