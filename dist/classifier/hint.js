/** 合法 TaskType 字符串集合，用于校验 explicitHint。 */
const VALID_TASK_TYPES = new Set([
    'general',
    'coding',
    'reasoning',
    'writing',
    'data_analysis',
    'vision',
    'tool_use',
]);
/**
 * 按 Hint 信号分类。
 * @param input - 分类输入。
 * @returns 命中时返回 Classification；无法确定时返回 undefined。
 */
export function classifyByHint(input) {
    // 1. 调用方显式 hint：必须是合法 TaskType 字符串
    if (input.explicitHint !== undefined) {
        const hint = input.explicitHint;
        if (VALID_TASK_TYPES.has(hint)) {
            return {
                taskType: hint,
                complexity: 'medium',
                confidence: 1.0,
                source: 'hint',
            };
        }
    }
    // 2. 图片输入 → vision
    if (input.hasImage === true) {
        return {
            taskType: 'vision',
            complexity: 'medium',
            confidence: 1.0,
            source: 'hint',
        };
    }
    // 3. Tool 上下文 → tool_use
    if (input.hasToolContext === true) {
        return {
            taskType: 'tool_use',
            complexity: 'medium',
            confidence: 1.0,
            source: 'hint',
        };
    }
    return undefined;
}
