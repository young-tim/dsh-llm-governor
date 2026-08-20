import type { Classification, ClassifyInput } from './types.js';
/**
 * 按 Hint 信号分类。
 * @param input - 分类输入。
 * @returns 命中时返回 Classification；无法确定时返回 undefined。
 */
export declare function classifyByHint(input: ClassifyInput): Classification | undefined;
