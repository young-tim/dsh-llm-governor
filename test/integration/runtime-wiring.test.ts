/**
 * 运行时接线集成测试：验收退回意见的核心修复项。
 *
 * 1. agent/pre-step 自动分类被真实执行（含代码块消息 → coding 分类进入决策）
 * 2. 月度额度由真实已提交 Credits 计算（不再仅靠 setQuotaExceeded 测试开关）
 * 3. 计费参数（multiplier、tokens_per_credit）与路由模式来自配置（不再硬编码）
 * 4. SQLite Repository 接入运行时：决策/Usage/身份/策略落库且重启后恢复
 * 5. Capability/模态检查接线：图片输入拒绝无 vision 能力的模型（红→绿）
 * 6. Header/JWT 真实入站绑定：bindIdentityFromHeaders + 严格配置参数
 * 7. Auto 的 LLM Classifier 启用：ctx.llm 后端 + 缓存
 * 8. 部分输出保护接线：流式产出文本后失败不再透明切换模型
 * 9. 严格配置 Schema 在插件入口生效：非法配置拒绝加载
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
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
            capabilities: ['text', 'vision'],
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

describe('Capability/模态检查接线', () => {
  it('图片输入请求无 vision 能力的模型被拒绝（CAPABILITY_NOT_SUPPORTED）', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }) as never,
      {
        models: {
          // 未声明 vision 能力：图片请求必须被排除
          'fake-provider:model-a': {
            enabled: true,
            multiplier: 1,
            capabilities: ['text'],
            quality: { general: 90, vision: 90 },
          },
        },
        routing: { default: 'manual' as const },
        fallback: { enabled: true, max_attempts: 2 },
        identity: { provider: 'local', local_user_id: 'local' },
      },
    );
    try {
      const e = ev(h.ctx);
      // pre-step：图片输入
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
      // agent/request：唯一模型缺少 vision 能力 → 拒绝，不透传
      await expect(
        e.waterfall(
          'agent/request',
          { agent: fakeAgent('session-1'), turn: 1, step: 1, signal: new AbortController().signal },
          async () => ({ provider: 'fake-provider', model: 'model-a' }),
        ),
      ).rejects.toMatchObject({ code: 'CAPABILITY_NOT_SUPPORTED' });
    } finally {
      await h.dispose();
    }
  });

  it('advisory 声明不支持 image 模态的模型被模态检查排除', async () => {
    // advisory：model-a 只接受 text 输入（即使治理配置声明了 vision 能力）
    const advisory = [
      modelInfo('fake-provider', 'model-a'),
      { ...modelInfo('fake-provider', 'model-b'), inputModalities: ['text'] },
    ];
    const h = await bootFake(
      providers,
      advisory,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }) as never,
      {
        models: {
          'fake-provider:model-a': {
            enabled: true,
            multiplier: 1,
            capabilities: ['text'],
            quality: { general: 90 },
          },
          'fake-provider:model-b': {
            enabled: true,
            multiplier: 1,
            capabilities: ['text', 'vision'],
            quality: { general: 85, vision: 85 },
          },
        },
        routing: { default: 'manual' as const },
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
      await expect(
        e.waterfall(
          'agent/request',
          { agent: fakeAgent('session-1'), turn: 1, step: 1, signal: new AbortController().signal },
          async () => ({ provider: 'fake-provider', model: 'model-b' }),
        ),
      ).rejects.toMatchObject({ code: 'CAPABILITY_NOT_SUPPORTED' });
    } finally {
      await h.dispose();
    }
  });
});

describe('Header/JWT 真实入站绑定', () => {
  /** header 模式的合法配置（严格 Schema：header_name + trusted_proxy 必填）。 */
  function headerConfig() {
    return {
      models: {
        'fake-provider:model-a': { enabled: true, multiplier: 1, quality: { general: 90 } },
      },
      routing: { default: 'quality_first' as const },
      fallback: { enabled: true, max_attempts: 2 },
      identity: {
        provider: 'header' as const,
        header_name: 'X-Governor-User',
        trusted_proxy: 'test-ingress',
        proxy_header_name: 'X-Proxy-Id',
      },
      users: { alice: { allow: [], monthly_credits: 100 } },
    };
  }

  it('bindIdentityFromHeaders 验证可信代理并绑定，随后请求通过', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }) as never,
      headerConfig(),
    );
    try {
      // 可信代理标识匹配 → 绑定成功
      const identity = await h.governor!.bindIdentityFromHeaders('session-1', {
        'X-Governor-User': 'alice',
        'X-Proxy-Id': 'test-ingress',
      });
      expect(identity.userId).toBe('alice');
      expect(h.governor!.getIdentity('session-1')).toMatchObject({ userId: 'alice' });

      // 绑定后请求通过（此前无绑定会被 IDENTITY_REQUIRED 拒绝）
      const config = (await ev(h.ctx).waterfall(
        'agent/request',
        { agent: fakeAgent('session-1'), turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      )) as { model: string };
      expect(config.model).toBe('model-a');
    } finally {
      await h.dispose();
    }
  });

  it('伪造代理标识被拒绝（fail closed）', async () => {
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }) as never,
      headerConfig(),
    );
    try {
      // 代理标识不匹配 → 拒绝绑定
      await expect(
        h.governor!.bindIdentityFromHeaders('session-1', {
          'X-Governor-User': 'alice',
          'X-Proxy-Id': 'evil-proxy',
        }),
      ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
      // 未绑定 → 请求被拒
      await expect(
        ev(h.ctx).waterfall(
          'agent/request',
          { agent: fakeAgent('session-1'), turn: 1, step: 1, signal: new AbortController().signal },
          async () => ({ provider: 'fake-provider', model: 'model-a' }),
        ),
      ).rejects.toMatchObject({ code: 'IDENTITY_REQUIRED' });
    } finally {
      await h.dispose();
    }
  });

  it('JWT 模式：合法 HS256 token 绑定成功，篡改签名被拒绝', async () => {
    const secret = 'jwt-test-secret';
    const h = await bootFake(
      providers,
      models,
      successScript('hi', { inputTokens: 1, outputTokens: 1 }) as never,
      {
        models: {
          'fake-provider:model-a': { enabled: true, multiplier: 1, quality: { general: 90 } },
        },
        routing: { default: 'quality_first' as const },
        fallback: { enabled: true, max_attempts: 2 },
        identity: {
          provider: 'jwt' as const,
          jwt_issuer: 'test-iss',
          jwt_audience: 'test-aud',
          jwt_algorithms: ['HS256'],
          jwt_key: secret,
        },
        users: { bob: { allow: [], monthly_credits: 100 } },
      },
    );
    try {
      // 构造合法 JWT
      const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
      const headerB64 = enc({ alg: 'HS256', typ: 'JWT' });
      const payloadB64 = enc({ sub: 'bob', iss: 'test-iss', aud: 'test-aud' });
      const sigB64 = createHmac('sha256', secret)
        .update(`${headerB64}.${payloadB64}`)
        .digest()
        .toString('base64url');
      const token = `${headerB64}.${payloadB64}.${sigB64}`;

      const identity = await h.governor!.bindIdentityFromHeaders('session-1', {
        authorization: `Bearer ${token}`,
      });
      expect(identity.userId).toBe('bob');

      // 篡改签名的 token 被拒绝
      const forged = `${headerB64}.${payloadB64}.${'A'.repeat(sigB64.length)}`;
      await expect(
        h.governor!.bindIdentityFromHeaders('session-2', {
          authorization: `Bearer ${forged}`,
        }),
      ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
    } finally {
      await h.dispose();
    }
  });
});

describe('Auto 的 LLM Classifier 接线', () => {
  it('Hint/Rule 未命中时经 ctx.llm 分类（source=llm 落库）', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'dsh-gov-llmcls-'));
    const dbPath = join(dbDir, 'governor.db');
    // 脚本：model-b（分类器路由）返回 JSON 文本；model-a 正常成功
    const script = (options: { model: string }): FakeStreamScript =>
      options.model === 'model-b'
        ? {
            text: '{"task_type":"reasoning","complexity":"high","confidence":0.95}',
            finish: 'stop',
          }
        : successScript('hi', { inputTokens: 1, outputTokens: 1 });
    const h = await bootFake(
      providers,
      models,
      script as never,
      {
        models: {
          'fake-provider:model-a': {
            enabled: true,
            multiplier: 1,
            quality: { general: 90, reasoning: 95 },
          },
          'fake-provider:model-b': {
            enabled: true,
            multiplier: 0.1,
            quality: { general: 60 },
          },
        },
        routing: { default: 'auto' as const },
        fallback: { enabled: true, max_attempts: 2 },
        identity: { provider: 'local', local_user_id: 'local' },
        auto: {
          llm_classifier: {
            enabled: true,
            provider: 'fake-provider',
            model: 'model-b',
          },
        },
      },
      { dbPath },
    );
    try {
      const e = ev(h.ctx);
      // pre-step：普通文本（不命中 Hint/Rule 任何规则）
      await e.waterfall(
        'agent/pre-step',
        {
          agent: fakeAgent('session-1'),
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Plan a trip to Mars' }] }],
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
        },
        async () => ({ kind: 'enter', messages: [] }),
      );
      // agent/request：分类应来自 LLM（reasoning/high/0.95）
      const config = (await e.waterfall(
        'agent/request',
        { agent: fakeAgent('session-1'), turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      )) as { model: string };
      expect(config.model).toBe('model-a');

      // 决策落库：task_type=reasoning、complexity=high、confidence=0.95（LLM 来源）
      const db = new GovernorDatabase(dbPath);
      const repo = new GovernorRepository(db);
      const requestId = h.governor!.getRequestId('session-1', 1, 1)!;
      const decisions = repo.getDecisions(requestId);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]!.taskType).toBe('reasoning');
      expect(decisions[0]!.complexity).toBe('high');
      expect(decisions[0]!.confidence).toBe(0.95);
      db.close();
    } finally {
      await h.dispose();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});

describe('部分输出保护接线（流驱动，不手动标记）', () => {
  it('流式产出文本后失败：request-error 不再透明切换模型', async () => {
    // 脚本：产出部分文本后 5xx 失败
    const partialFailScript: FakeStreamScript = {
      text: 'partial answer',
      finish: 'error',
      failure: { message: '5xx', code: 'SERVER_ERROR', status: 503 },
    };
    const h = await bootFake(providers, models, partialFailScript as never, {
      models: {
        'fake-provider:model-a': { enabled: true, multiplier: 1, quality: { general: 90 } },
        'fake-provider:model-b': { enabled: true, multiplier: 0.5, quality: { general: 80 } },
      },
      routing: { default: 'quality_first' as const },
      fallback: { enabled: true, max_attempts: 2 },
      identity: { provider: 'local', local_user_id: 'local' },
    });
    try {
      const e = ev(h.ctx);
      await e.waterfall(
        'agent/request',
        { agent: fakeAgent('session-1'), turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ provider: 'fake-provider', model: 'model-a' }),
      );
      // 消费流：文本 delta 交付后失败（不手动调 markPartialOutput）
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
          sessionId: 'session-1' as never,
        },
        () =>
          h.adapter.stream({ provider: 'fake-provider', model: 'model-a', messages: [] } as never),
      );
      for await (const _ of stream) {
        void _;
      }

      // request-error：5xx 本可重试，但部分输出已交付 → 不切换（undefined）
      const action = await e.waterfall(
        'agent/request-error',
        {
          agent: fakeAgent('session-1'),
          turn: 1,
          step: 1,
          provider: 'fake-provider',
          failure: { message: '5xx', code: 'SERVER_ERROR', status: 503 },
          retryPolicy: undefined,
          signal: new AbortController().signal,
        },
        async () => undefined,
      );
      expect(action).toBeUndefined();
    } finally {
      await h.dispose();
    }
  });

  it('未交付任何语义内容即失败：仍可正常 Fallback', async () => {
    // 脚本：无文本、直接失败（服务端错误）
    const failOnlyScript: FakeStreamScript = {
      finish: 'error',
      failure: { message: '5xx', code: 'SERVER_ERROR', status: 503 },
    };
    const h = await bootFake(providers, models, failOnlyScript as never, {
      models: {
        'fake-provider:model-a': { enabled: true, multiplier: 1, quality: { general: 90 } },
        'fake-provider:model-b': { enabled: true, multiplier: 0.5, quality: { general: 80 } },
      },
      routing: { default: 'quality_first' as const },
      fallback: { enabled: true, max_attempts: 2 },
      identity: { provider: 'local', local_user_id: 'local' },
    });
    try {
      const e = ev(h.ctx);
      await e.waterfall(
        'agent/request',
        { agent: fakeAgent('session-1'), turn: 1, step: 1, signal: new AbortController().signal },
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
          sessionId: 'session-1' as never,
        },
        () =>
          h.adapter.stream({ provider: 'fake-provider', model: 'model-a', messages: [] } as never),
      );
      for await (const _ of stream) {
        void _;
      }

      // 无语义内容交付 → 5xx 可正常触发 Fallback retry
      const action = await e.waterfall(
        'agent/request-error',
        {
          agent: fakeAgent('session-1'),
          turn: 1,
          step: 1,
          provider: 'fake-provider',
          failure: { message: '5xx', code: 'SERVER_ERROR', status: 503 },
          retryPolicy: undefined,
          signal: new AbortController().signal,
        },
        async () => undefined,
      );
      expect(action).toEqual({ kind: 'retry' });
    } finally {
      await h.dispose();
    }
  });
});

describe('严格配置 Schema 在插件入口生效', () => {
  it('未知字段导致插件加载失败（fail closed）', async () => {
    await expect(
      bootFake(
        providers,
        models,
        successScript('hi', { inputTokens: 1, outputTokens: 1 }) as never,
        {
          models: {
            'fake-provider:model-a': { enabled: true, multiplier: 1, quality: { general: 90 } },
          },
          routing: { default: 'quality_first' as const },
          fallback: { enabled: true, max_attempts: 2 },
          identity: { provider: 'local', local_user_id: 'local' },
          // 未知字段：严格 Schema 必须拒绝（实际启动配置不可绕过校验）
          unknown_field: true,
        } as never,
      ),
    ).rejects.toThrow(/unknown field "unknown_field"/);
  });

  it('header 模式缺 trusted_proxy 导致插件加载失败（信任边界必须显式）', async () => {
    await expect(
      bootFake(
        providers,
        models,
        successScript('hi', { inputTokens: 1, outputTokens: 1 }) as never,
        {
          models: {
            'fake-provider:model-a': { enabled: true, multiplier: 1, quality: { general: 90 } },
          },
          routing: { default: 'quality_first' as const },
          fallback: { enabled: true, max_attempts: 2 },
          identity: { provider: 'header' as const, header_name: 'X-User' },
        } as never,
      ),
    ).rejects.toThrow(/trusted_proxy is required/);
  });

  it('范围越界（max_attempts=0）导致插件加载失败', async () => {
    await expect(
      bootFake(
        providers,
        models,
        successScript('hi', { inputTokens: 1, outputTokens: 1 }) as never,
        {
          models: {
            'fake-provider:model-a': { enabled: true, multiplier: 1, quality: { general: 90 } },
          },
          routing: { default: 'quality_first' as const },
          fallback: { enabled: true, max_attempts: 0 },
          identity: { provider: 'local', local_user_id: 'local' },
        } as never,
      ),
    ).rejects.toThrow(/positive integer/);
  });
});
