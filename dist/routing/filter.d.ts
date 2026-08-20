import type { FilterInput, FilterResult } from './types.js';
/**
 * 执行公共候选过滤。
 * 过滤顺序：active provider → enabled → access → capabilities → excluded → quota。
 * 每个排除项写稳定 reason code。
 */
export declare function filterCandidates(input: FilterInput): FilterResult;
