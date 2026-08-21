/**
 * 覆盖补强：无 repository 的内存运行分支（listDecisions/explainDecision 空结果）、
 * turn 清理实际命中分支。
 */
import { describe, expect, it } from 'vitest';
import { Context } from '../../src/dsh-adapter/mod.js';
import { GovernorService } from '../../src/plugin/service.js';
import type { GovernorPluginConfig } from '../../src/plugin/service.js';

/** 无 repository（storage.enabled=false）的内存 service。 */
function memoryService(): GovernorService {
  const ctx = new Context();
  return new GovernorService(
    ctx,
    {
      identity: { provider: 'local', local_user_id: 'local' },
      routing: { default: 'manual' },
      models: { 'p:a': { quality: { general: 90 }, multiplier: 1 } },
    } as GovernorPluginConfig,
    undefined,
    {},
  );
}

describe('内存运行分支（无 repository）', () => {
  it('listDecisions/explainDecision/listAuditEntries/listPendingAuditCount 返回空结果', async () => {
    const service = memoryService();
    expect(await service.listDecisions()).toEqual({ items: [] });
    expect(await service.listDecisions({ sessionId: 's' })).toEqual({ items: [] });
    expect(await service.explainDecision('req')).toEqual([]);
    expect(await service.listAuditEntries()).toEqual([]);
    expect(await service.listPendingAuditCount()).toBe(0);
    // configRevision 无仓库时固定 1
    expect(service.configRevision).toBe(1);
  });

  it('内存模式 selectModel 正常工作（决策不入库）', async () => {
    const service = memoryService();
    const result = await service.selectModel('mem-1', 1, 1, { provider: 'p', model: 'a' });
    expect(result.config.model).toBe('a');
    expect(result.decision.requestId).toBeDefined();
    expect(await service.listDecisions()).toEqual({ items: [] });
  });

  it('turn/end 清理实际命中（多个 step 状态被前缀清理）', async () => {
    const service = memoryService();
    await service.selectModel('t1', 1, 1, { provider: 'p', model: 'a' });
    await service.selectModel('t1', 1, 2, { provider: 'p', model: 'a' });
    await service.selectModel('t1', 2, 1, { provider: 'p', model: 'a' });
    // turn 1 的两个 step 都存在状态
    expect(service.getRequestId('t1', 1, 1)).toBeDefined();
    expect(service.getRequestId('t1', 1, 2)).toBeDefined();
    // turn/end 只清理 turn 1（turn 2 不受影响）
    service.handleTurnEnd('t1', 1);
    expect(service.getRequestId('t1', 1, 1)).toBeUndefined();
    expect(service.getRequestId('t1', 1, 2)).toBeUndefined();
    expect(service.getRequestId('t1', 2, 1)).toBeDefined();
    // step/end 单点清理
    service.handleStepEnd('t1', 2, 1);
    expect(service.getRequestId('t1', 2, 1)).toBeUndefined();
  });
});
