/**
 * Usage 模块入口：导出类型、流观察器和内存聚合器。
 *
 * 领域层模块：不导入任何 DSH 包。Stream observer 用 try/finally 包装
 * AsyncIterable，不提前消费；Aggregator 通过唯一键 (request_id,
 * fallback_index) 保证幂等。
 */
export type { UsageEvent, UsageStats, AttemptOrigin } from './types.js';
export type { StreamChunkLike, ObserveStreamOptions } from './observer.js';
export { observeStream } from './observer.js';
export { UsageAggregator } from './aggregator.js';
