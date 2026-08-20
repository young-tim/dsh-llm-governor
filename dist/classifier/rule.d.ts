/**
 * Rule 分类器：第二优先级，基于确定性正则规则识别输入特征。
 *
 * 规则优先级（先匹配先返回）：
 * 1. 代码块（fenced ``` 或 4 空格 / tab 缩进）→ coding, medium, 0.8
 * 2. 错误栈（Error: / at <frame>）→ coding, high, 0.75
 * 3. SQL（SELECT / INSERT / CREATE TABLE 等）→ data_analysis, medium, 0.75
 * 4. 表格（| --- | 分隔行）→ data_analysis, medium, 0.7
 * 5. 长文（拼接文本 > 2000 字符）→ writing, high, 0.6
 *
 * 复杂度辅助规则（按消息总长度推断，供调用方复用）：
 *   < 100 → low；100..500 → medium；> 500 → high。
 *
 * 规则匹配失败时返回 undefined，由编排器转入 LLM 阶段。
 */
import type { Complexity } from '../index.js';
import type { Classification, ClassifyInput } from './types.js';
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
export declare function complexityByLength(totalLength: number): Complexity;
/**
 * 按 Rule 规则分类。
 *
 * 规则按优先级顺序匹配，第一条命中即返回；全部不命中返回 undefined。
 * @param input - 分类输入。
 */
export declare function classifyByRule(input: ClassifyInput): Classification | undefined;
