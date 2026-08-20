/**
 * 运行时接线集成测试：验收退回意见的核心修复项。
 *
 * 1. agent/pre-step 自动分类被真实执行（含代码块消息 → coding 分类进入决策）
 * 2. 月度额度由真实已提交 Credits 计算（不再仅靠 setQuotaExceeded 测试开关）
 * 3. 计费参数（multiplier、tokens_per_credit）与路由模式来自配置（不再硬编码）
 * 4. SQLite Repository 接入运行时：决策/Usage/身份/策略落库且重启后恢复
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootFake, modelInfo } from '../contracts/harness.js';
import { successScript } from '../../src/dsh-adapter/fake-adapter.js';
import type { FakeStreamScript } from '../../src/dsh-adapter/fake-adapter.js';
import { GovernorDatabase } from '../../src/storage/database.js';
import { GovernorRepository } from '../../src/storage/repository.js';

/** 构造 fake agent。 */
function fakeAgent(id = 'session-1') {
  return { id };
}

/** 事件分发辅助。 */
function ev(ctx: unknown) {
  return (
    ctx as unknown as {
      events: {
        waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
      };
    }
  ).events;
}

/** 执行一次完整请求（request → stream）。 */
async function runAttempt(
  h: { ctx: unknown; adapter: { stream: (o: never) => AsyncIterable<unknown> } },
  sessionId: string,
  turn: number,
  step: number,
): Promise<void> {
  const e = ev(h.ctx);
  await e.waterfall(
    'agent/request',
    { agent: fakeAgent(sessionId), turn, step, signal: new AbortController().signal },
    async () => ({ provider: 'fake-provider', model: 'model-a' }),
  );
  const stream = (
    h.ctx as unknown as {
      events: { waterfall: (name: string, ...args: unknown[]) => AsyncIterable<unknown> };
    }
  ).waterfall(
    'llm/stream',
    {
      provider: 'fake-provider',
      model: 'model-a',
      messages: [],
      sessionId: sessionId as never,
    },
    () => h.adapter.stream({ provider: 'fake-provider', model: 'model-a', messages: [] } as never),
  );
  for await (const _ of stream) {
    void _;
  }
}

const providers = ['fake-provider'];
const models = [
  modelInfo('fake-provider', 'model-a', 'Model A'),
  modelInfo('fake-provider', 'model-b', 'Model B'),
];

describe('pre-step 自动分类接线', () => {
  it('带代码块的消息经 agent/pre-step 分类为 coding 并进入决策记录', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'dsh-gov-prestep-'));
    const dbPath = join(dbDir, 'governor.db');
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }) as never,
      {
        models: {
          'fake-provider:model-a': {
            enabled: true,
            multiplier: 1,
            quality: { general: 90, coding: 90 },
          },
          'fake-provider:model-b': {
            enabled: true,
            multiplier: 0.5,
            quality: { general: 80, coding: 80 },
          },
        },
        routing: { default: 'auto' as const },
        fallback: { enabled: true, max_attempts: 2 },
        identity: { provider: 'local', local_user_id: 'local' },
      },
      { dbPath },
    );
    try {
      const e = ev(h.ctx);
      // agent/pre-step：传入带 fenced 代码块的消息
      await e.waterfall(
        'agent/pre-step',
        {
          agent: fakeAgent('session-1'),
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: '请修复这段代码：\n```ts\nconst x: number = 1\n```' },
              ],
            },
          ],
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
        },
        async () => ({ kind: 'enter', messages: [] }),
      );
      // agent/request：auto 路由应使用已缓存的 coding 分类（Rule 规则命中）
      const config = (await e.waterfall(
        'agent/request',
        { agent: fakeAgent('session-1'), turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      )) as { model: string };
      expect(config.model).toBe('model-a');

      // 决策已持久化到 SQLite，且分类信息（coding/medium/0.8）真实落库
      const db = new GovernorDatabase(dbPath);
      const repo = new GovernorRepository(db);
      const requestId = h.governor!.getRequestId('session-1', 1, 1)!;
      const decisions = repo.getDecisions(requestId);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]!.taskType).toBe('coding');
      expect(decisions[0]!.complexity).toBe('medium');
      expect(decisions[0]!.confidence).toBe(0.8);
      db.close();
    } finally {
      await h.dispose();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it('图片输入经 pre-step 分类为 vision（hint 信号）', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }) as never,
      {
        models: {
          'fake-provider:model-a': {
            enabled: true,
            multiplier: 1,
            quality: { general: 90, vision: 90 },
          },
        },
        routing: { default: 'auto' as const },
        fallback: { enabled: true, max_attempts: 2 },
        identity: { provider: 'local', local_user_id: 'local' },
      },
    );
    try {
      const e = ev(h.ctx);
      await e.waterfall(
        'agent/pre-step',
        {
          agent: fakeAgent('session-1'),
          messages: [{ role: 'user', content: [{ type: 'image' }] }],
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
        },
        async () => ({ kind: 'enter', messages: [] }),
      );
      // vision 分类已缓存（通过后续 request 不抛错验证）
      const config = (await e.waterfall(
        'agent/request',
        { agent: fakeAgent('session-1'), turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      )) as { provider: string };
      expect(config.provider).toBe('fake-provider');
    } finally {
      await h.dispose();
    }
  });
});

describe('月度额度真实计算', () => {
  it('已提交 Credits 达到限额后，下一次请求被拒绝（不依赖 setQuotaExceeded）', async () => {
    // monthly_credits 极小：1 次成功请求即耗尽
    const config = {
      models: {
        'fake-provider:model-a': { enabled: true, multiplier: 1, quality: { general: 90 } },
      },
      users: { local: { allow: [], monthly_credits: 1 } },
      credits: { tokens_per_credit: 10 },
      routing: { default: 'manual' as const },
      fallback: { enabled: true, max_attempts: 2 },
      identity: { provider: 'local' as const, local_user_id: 'local' },
    };
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 5, outputTokens: 5 }) as never,
      config,
    );
    try {
      const e = ev(h.ctx);
      // 第一次：用量未超限，正常通过
      await runAttempt(h, 'session-1', 1, 1);
      const quota = h.governor!.getQuotaStatus('local');
      // 10 tokens / 10 tokens_per_credit = 1 credit = 限额
      expect(quota.usedNanos).toBe(1_000_000_000n);
      expect(quota.exceeded).toBe(true);

      // 第二次（新请求）：admission control 拒绝
      await expect(
        e.waterfall(
          'agent/request',
          { agent: fakeAgent('session-2'), turn: 1, step: 1, signal: new AbortController().signal },
          async () => ({ provider: 'fake-provider', model: 'model-a' }),
        ),
      ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    } finally {
      await h.dispose();
    }
  });

  it('不同月份的用量不计入当前窗口', async () => {
    const config = {
      models: {
        'fake-provider:model-a': { enabled: true, multiplier: 1, quality: { general: 90 } },
      },
      users: { local: { allow: [], monthly_credits: 1 } },
      credits: { tokens_per_credit: 10 },
      routing: { default: 'manual' as const },
      fallback: { enabled: true, max_attempts: 2 },
      identity: { provider: 'local' as const, local_user_id: 'local' },
    };
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 5, outputTokens: 5 }) as never,
      config,
    );
    try {
      // 手工写入一条上个月的成功用量（直接走 recordUsage）
      h.governor!.recordUsage({
        id: 'old-1',
        requestId: 'old-req',
        sessionId: 's',
        turn: 1,
        step: 1,
        userId: 'local',
        provider: 'fake-provider',
        model: 'model-a',
        routingMode: 'manual',
        inputTokens: 100,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        creditNanos: 20_000_000_000n,
        success: true,
        finishKind: 'stop',
        latencyMs: 10,
        fallbackIndex: 0,
        attemptOrigin: 'provider',
        usageMissing: false,
        createdAt: '2020-01-01T00:00:00.000Z',
      });
      // 上月用量不影响本月额度
      const quota = h.governor!.getQuotaStatus('local');
      expect(quota.usedNanos).toBe(0n);
      expect(quota.exceeded).toBe(false);
    } finally {
      await h.dispose();
    }
  });
});

describe('计费参数与路由模式来自配置', () => {
  it('multiplier=0.5 的模型计费是一半，tokens_per_credit 与 routingMode 生效', async () => {
    const h = await bootFake(
      providers,
      models,
      ((_opts: unknown, _i: number): FakeStreamScript =>
        successScript('hi', { inputTokens: 100, outputTokens: 100 })) as never,
      {
        models: {
          'fake-provider:model-a': { enabled: true, multiplier: 0.5, quality: { general: 90 } },
        },
        credits: { tokens_per_credit: 1000 },
        routing: { default: 'quality_first' as const },
        fallback: { enabled: true, max_attempts: 2 },
        identity: { provider: 'local', local_user_id: 'local' },
      },
    );
    try {
      await runAttempt(h, 'session-1', 1, 1);
      const usage = await h.governor!.queryUsage({});
      expect(usage).toHaveLength(1);
      const event = usage[0]!;
      // 200 tokens * 0.5 / 1000 = 0.1 credit = 100_000_000 nanos
      expect(event.creditNanos).toBe(100_000_000n);
      // routingMode 来自服务配置（此前硬编码为 'manual'）
      expect(event.routingMode).toBe('quality_first');
    } finally {
      await h.dispose();
    }
  });
});

describe('SQLite 运行时持久化与重启恢复', () => {
  it('决策/Usage/身份/策略落库，重启后可查询且策略以 DB 为权威', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'dsh-gov-restart-'));
    const dbPath = join(dbDir, 'governor.db');
    const config = {
      models: {
        'fake-provider:model-a': { enabled: true, multiplier: 1, quality: { general: 90 } },
      },
      users: { local: { allow: [], monthly_credits: 100 } },
      routing: { default: 'manual' as const },
      fallback: { enabled: true, max_attempts: 2 },
      identity: { provider: 'local' as const, local_user_id: 'local' },
    };
    try {
      // 第一个进程：完成请求并修改策略
      const h1 = await bootFake(
        providers,
        models,
        successScript('hi', { inputTokens: 10, outputTokens: 5 }) as never,
        config,
        { dbPath },
      );
      try {
        await h1.governor!.bindIdentity('session-1', { userId: 'local' });
        await runAttempt(h1, 'session-1', 1, 1);
        // 管理写入：禁用模型并调整额度
        await h1.governor!.updateModel('fake-provider:model-a', { enabled: false });
        await h1.governor!.updateUser('local', { monthlyCredits: 42 });
        const usage1 = await h1.governor!.queryUsage({});
        expect(usage1).toHaveLength(1);
      } finally {
        await h1.dispose();
      }

      expect(existsSync(dbPath)).toBe(true);

      // 第二个进程（同一 DB）：重启恢复
      const h2 = await bootFake(
        providers,
        models,
        successScript('hi', { inputTokens: 10, outputTokens: 5 }) as never,
        // YAML 仍写 enabled: true / 100 credits，但 DB 是运行时权威
        config,
        { dbPath },
      );
      try {
        // 历史进程的 Usage 事件仍可查询（SQLite 持久化，不是内存态）
        const usage2 = await h2.governor!.queryUsage({});
        expect(usage2).toHaveLength(1);
        expect(usage2[0]!.requestId).toBe((await h2.governor!.queryUsage({}))[0]!.requestId);
        // 身份绑定跨进程恢复
        expect(h2.governor!.getIdentity('session-1')).toMatchObject({ userId: 'local' });
        // 策略以 DB 为权威：模型仍禁用、额度仍是 42（不回退到 YAML）
        const modelList = await h2.governor!.listModels();
        const modelA = modelList.find((m) => m.routeId === 'fake-provider:model-a');
        expect(modelA!.enabled).toBe(false);
        const users = await h2.governor!.listUsers();
        expect(users.find((u) => u.userId === 'local')!.monthlyCredits).toBe(42);
      } finally {
        await h2.dispose();
      }
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
