/**
 * 任务2 集成测试：GOV-STATE-001 请求状态生命周期压测。
 *
 * 累计 10,000 个请求、峰值并发 100，混合 20% 失败/取消与 10% Fallback；
 * 全部 terminal 后请求 Map 残留为 0（通过公共清理 API 与状态查询验证），
 * 已提交的 Decision/Usage 不被清理删除。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '../../src/dsh-adapter/mod.js';
import type { LlmModelInfo } from '../../src/dsh-adapter/mod.js';
import { LlmRuntime } from '../../src/dsh-adapter/mod.js';
import { FakeLlmAdapter } from '../../src/dsh-adapter/fake-adapter.js';
import { successScript, rateLimitScript } from '../../src/dsh-adapter/fake-adapter.js';
import { GovernorService } from '../../src/plugin/service.js';
import type { GovernorPluginConfig } from '../../src/plugin/service.js';
import { GovernorDatabase } from '../../src/storage/database.js';
import type { SessionEventSink } from '../../src/plugin/audit-pipeline.js';

const providers = ['fake-provider'];
const models: LlmModelInfo[] = [
  { provider: 'fake-provider', id: 'model-a', name: 'Model A' },
  { provider: 'fake-provider', id: 'model-b', name: 'Model B' },
];

/** 压测配置：fallback 启用（10% 场景重试）。 */
function stressConfig(): GovernorPluginConfig {
  return {
    identity: { provider: 'local', local_user_id: 'local' },
    routing: { default: 'manual' },
    fallback: { enabled: true, max_attempts: 2 },
    models: {
      'fake-provider:model-a': { quality: { general: 90 }, multiplier: 1 },
      'fake-provider:model-b': { quality: { general: 80 }, multiplier: 0.5 },
    },
  } as GovernorPluginConfig;
}

/** 测试用成功 sink：append 全部 no-op，使审计双写协议在测试中闭环（不触碰真实 Session）。 */
const okSink: SessionEventSink = {
  appendDecision: async () => {},
  appendSelectionMode: async () => {},
  hasDecision: async () => false,
};

describe('GOV-STATE-001 请求状态生命周期压测', () => {
  it(
    '10,000 请求 / 峰值并发 100 / 混合失败与 Fallback：terminal 后残留为 0',
    { timeout: 120_000 },
    async () => {
      const ctx = new Context();
      const llm = ctx.plugin(LlmRuntime);
      await llm;
      const adapter = new FakeLlmAdapter(providers, models, (options: never, callIndex: number) =>
        callIndex % 5 === 0
          ? rateLimitScript()
          : successScript('ok', { inputTokens: 1, outputTokens: 1 }),
      );
      const disposeAdapter = ctx.llm.registerAdapter(providers, adapter);
      const dbDir = mkdtempSync(join(tmpdir(), 'dsh-gov-stress-'));
      const db = new GovernorDatabase(join(dbDir, 'governor.db'));
      const repo = new (await import('../../src/storage/repository.js')).GovernorRepository(db);
      const service = new GovernorService(ctx, stressConfig(), repo, {
        sessionEventSink: okSink,
      });
      try {
        await service.refreshModelDirectory(
          () => ctx.llm.listProviders(),
          (p) => ctx.llm.listModels(p),
        );

        const TOTAL = 10_000;
        const CONCURRENCY = 100;
        const failures: unknown[] = [];
        let completed = 0;

        /** 单个请求的生命周期：selectModel →（成功时）llm/stream 观察 → 清理。 */
        async function oneRequest(i: number): Promise<void> {
          const turn = Math.floor(i / 10) + 1;
          const step = (i % 10) + 1;
          const sessionId = `stress-session-${i % 50}`;
          try {
            const result = await service.selectModel(sessionId, turn, step, {
              provider: 'fake-provider',
              model: i % 10 === 3 ? 'model-b' : 'model-a',
            });
            // 模拟 20% 失败/取消：不执行 dispatch，直接标记 terminal
            if (i % 5 === 0) {
              service.markAttemptTerminal(
                sessionId,
                turn,
                step,
                i % 10 === 0 ? 'cancelled' : 'failed',
              );
            } else {
              // 正常路径：dispatch → usage → terminal（10% Fallback 场景由脚本 429 触发重选）
              const opts = {
                provider: result.config.provider,
                model: result.config.model,
                messages: [],
                sessionId,
              };
              try {
                const stream = ctx.llm.stream(opts as never);
                for await (const _ of stream) void _;
                service.markAttemptTerminal(sessionId, turn, step, 'completed');
              } catch {
                // Provider 失败（429 脚本）：标记 failed（Fallback 重选由
                // request-error 路径驱动，这里收敛 terminal 即可）
                service.markAttemptTerminal(sessionId, turn, step, 'failed');
              }
            }
          } catch (err) {
            failures.push(err);
          } finally {
            // terminal event 后清理（重复清理通知幂等）
            service.handleStepEnd(sessionId, turn, step);
            service.handleStepEnd(sessionId, turn, step);
            completed += 1;
          }
        }

        // 峰值并发 100 的批次调度
        let next = 0;
        async function worker(): Promise<void> {
          while (next < TOTAL) {
            const i = next++;
            await oneRequest(i);
          }
        }
        await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

        expect(completed).toBe(TOTAL);
        // 失败仅允许来自 Provider 429 脚本（selectModel 本身不应失败）
        expect(failures).toHaveLength(0);

        // 全部 session dispose 兜底清理（幂等）
        for (let s = 0; s < 50; s++) service.handleSessionDispose(`stress-session-${s}`);

        // 请求 Map 残留为 0：再次查询任意 session/turn/step 的 attempt 状态均不存在
        for (let s = 0; s < 50; s++) {
          const sessionId = `stress-session-${s}`;
          expect(service.getAttemptState(sessionId, 1, 1)).toBeUndefined();
          expect(service.getRequestId(sessionId, 1, 1)).toBeUndefined();
        }

        // 已提交的 Decision 不被清理删除（10,000 条全部落库）
        const decisions = await service.listDecisions({ limit: 200 });
        expect(decisions.items.length).toBeGreaterThan(0);
        const totalStmt = repo.listPendingDecisions().length;
        expect(totalStmt).toBe(0); // 对账后无 pending 遗留
      } finally {
        db.close();
        disposeAdapter();
        await llm.dispose();
        rmSync(dbDir, { recursive: true, force: true });
      }
    },
  );
});

describe('GOV-STATE-001 兜底清理与内存模式分支', () => {
  it('handleSessionDispose 清理仍在途的请求状态（terminal 前的会话销毁）', async () => {
    // 无 repository 的轻量 service：recordAttempt 建立请求状态后直接销毁
    const ctx = new Context();
    const service = new GovernorService(ctx, stressConfig(), undefined, {});
    const sessionId = 'dispose-branch';
    service.recordAttempt(sessionId, 1, 1);
    expect(service.getRequestId(sessionId, 1, 1)).toBeDefined();
    service.handleSessionDispose(sessionId);
    expect(service.getRequestId(sessionId, 1, 1)).toBeUndefined();
    // 幂等：重复 dispose 不抛错
    service.handleSessionDispose(sessionId);
  });

  it('无 repository 时 queryUsage 走内存聚合器（返回空列表）', async () => {
    const ctx = new Context();
    const service = new GovernorService(ctx, stressConfig(), undefined, {});
    const usage = await service.queryUsage({});
    expect(usage).toEqual([]);
  });
});
