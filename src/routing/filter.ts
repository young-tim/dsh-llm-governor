/**
 * 公共候选过滤：所有策略共享的过滤顺序。
 * active provider → enabled → current model directory → provider available → access → capabilities/modalities → excluded → quota。
 */
import type { ModelSnapshot, CanonicalRoute } from '../model/canonical.js';
import { evaluateAccess } from '../access/evaluator.js';
import type { FilterInput, FilterResult, ExclusionReason } from './types.js';

/**
 * 执行公共候选过滤。
 * 过滤顺序：active provider → enabled → current model directory → provider available → access → capabilities → excluded → quota。
 * 每个排除项写稳定 reason code。
 */
export function filterCandidates(
  input: FilterInput,
  options: { readonly allowUnlistedModels?: boolean } = {},
): FilterResult {
  const candidates: ModelSnapshot[] = [];
  const excluded: Array<{ routeId: CanonicalRoute; reason: ExclusionReason }> = [];

  for (const snap of input.snapshots) {
    const routeId = snap.routeId;

    // 1. 活动 provider
    if (!input.activeProviders.has(snap.provider)) {
      excluded.push({ routeId, reason: 'not_active_provider' });
      continue;
    }

    // 2. enabled（治理开关与 provider 运行可用性保持独立语义）
    if (!snap.enabled) {
      excluded.push({ routeId, reason: 'disabled' });
      continue;
    }

    // 3. listModels/catalog 是 Governor 自动选择的资格边界，但不是 Provider
    //    请求白名单。显式 Manual 可通过 allowUnlistedModels 保留 pass-through。
    if (!options.allowUnlistedModels && !snap.inAdvisory) {
      excluded.push({ routeId, reason: 'model_not_listed' });
      continue;
    }

    // 4. Provider 已注册但当前不可调用（例如显式 credential ref 未配置）
    if (input.unavailableProviders.has(snap.provider)) {
      excluded.push({ routeId, reason: 'provider_unavailable' });
      continue;
    }

    // 5. access allowed
    const accessResult = evaluateAccess(routeId, input.userPolicy, input.globalDefault);
    if (!accessResult.allowed) {
      excluded.push({ routeId, reason: 'access_denied' });
      continue;
    }

    // 6. required capabilities
    if (input.requiredCapabilities.length > 0) {
      const hasAll = input.requiredCapabilities.every((cap) => snap.capabilities.includes(cap));
      if (!hasAll) {
        excluded.push({ routeId, reason: 'capability_not_supported' });
        continue;
      }
    }

    // 6b. required modalities（advisory 声明不支持时排除）
    if (input.requiredModalities.length > 0 && snap.inputModalities) {
      const hasAll = input.requiredModalities.every((mod) => snap.inputModalities!.includes(mod));
      if (!hasAll) {
        excluded.push({ routeId, reason: 'capability_not_supported' });
        continue;
      }
    }

    // 7. not excluded in this request
    if (input.excludedRoutes.has(routeId)) {
      excluded.push({ routeId, reason: 'excluded_in_request' });
      continue;
    }

    // 8. quota admits
    if (!input.quotaCheck(routeId)) {
      excluded.push({ routeId, reason: 'quota_exceeded' });
      continue;
    }

    candidates.push(snap);
  }

  return { candidates, excluded };
}
