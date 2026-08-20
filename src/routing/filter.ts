/**
 * 公共候选过滤：所有策略共享的过滤顺序。
 * active provider → enabled → access → capabilities/modalities → excluded → quota。
 */
import type { ModelSnapshot, CanonicalRoute } from '../model/canonical.js';
import { evaluateAccess } from '../access/evaluator.js';
import type { FilterInput, FilterResult, ExclusionReason } from './types.js';

/**
 * 执行公共候选过滤。
 * 过滤顺序：active provider → enabled → access → capabilities → excluded → quota。
 * 每个排除项写稳定 reason code。
 */
export function filterCandidates(input: FilterInput): FilterResult {
  const candidates: ModelSnapshot[] = [];
  const excluded: Array<{ routeId: CanonicalRoute; reason: ExclusionReason }> = [];

  for (const snap of input.snapshots) {
    const routeId = snap.routeId;

    // 1. 活动 provider
    if (!input.activeProviders.has(snap.provider)) {
      excluded.push({ routeId, reason: 'not_active_provider' });
      continue;
    }

    // 2. enabled
    if (!snap.enabled) {
      excluded.push({ routeId, reason: 'disabled' });
      continue;
    }

    // 3. access allowed
    const accessResult = evaluateAccess(routeId, input.userPolicy, input.globalDefault);
    if (!accessResult.allowed) {
      excluded.push({ routeId, reason: 'access_denied' });
      continue;
    }

    // 4. required capabilities
    if (input.requiredCapabilities.length > 0) {
      const hasAll = input.requiredCapabilities.every((cap) => snap.capabilities.includes(cap));
      if (!hasAll) {
        excluded.push({ routeId, reason: 'capability_not_supported' });
        continue;
      }
    }

    // 4b. required modalities（advisory 声明不支持时排除）
    if (input.requiredModalities.length > 0 && snap.inputModalities) {
      const hasAll = input.requiredModalities.every((mod) => snap.inputModalities!.includes(mod));
      if (!hasAll) {
        excluded.push({ routeId, reason: 'capability_not_supported' });
        continue;
      }
    }

    // 5. not excluded in this request
    if (input.excludedRoutes.has(routeId)) {
      excluded.push({ routeId, reason: 'excluded_in_request' });
      continue;
    }

    // 6. quota admits
    if (!input.quotaCheck(routeId)) {
      excluded.push({ routeId, reason: 'quota_exceeded' });
      continue;
    }

    candidates.push(snap);
  }

  return { candidates, excluded };
}
