/**
 * Hint 分类器：第一优先级，基于上下文确定性信号直接给出分类。
 *
 * 信号优先级（先匹配先返回）：
 * 1. explicitHint：调用方显式给出合法的 TaskType 字符串，confidence=1.0
 * 2. hasImage：图片输入 → vision，confidence=1.0
 * 3. hasToolContext：Tool 上下文 → tool_use，confidence=1.0
 *
 * 无法确定时返回 undefined，由编排器转入 Rule 阶段。
 *
 * Hint 阶段没有消息长度信息，complexity 默认为 medium。
 */
import type { TaskType } from '../index.js';
import type { Classification, ClassifyInput } from './types.js';

/** 合法 TaskType 字符串集合，用于校验 explicitHint。 */
const VALID_TASK_TYPES: ReadonlySet<string> = new Set([
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
export function classifyByHint(input: ClassifyInput): Classification | undefined {
  // 1. 调用方显式 hint：必须是合法 TaskType 字符串
  if (input.explicitHint !== undefined) {
    const hint = input.explicitHint;
    if (VALID_TASK_TYPES.has(hint)) {
      return {
        taskType: hint as TaskType,
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
