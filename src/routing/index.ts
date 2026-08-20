/**
 * Routing 模块导出。
 */
export type {
  RoutingErrorCode,
  ExclusionReason,
  FilterResult,
  FilterInput,
  DecisionCandidate,
  DecisionRecord,
  RoutingResult,
} from './types.js';
export { RoutingError } from './types.js';
export { filterCandidates } from './filter.js';
export { routeManual, routeQualityFirst, routeCreditFirst, routeAuto } from './strategies.js';
export type { AutoClassification } from './strategies.js';
