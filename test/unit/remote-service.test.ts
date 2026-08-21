/** GOV-SEC-001：Typert Remote 主体来源、逐方法 capability 与越权拒绝。 */
import { describe, expect, it } from 'vitest';
import { remoteMethods, TypertLookupFailure } from '@deepseek-ai/dsh-typert-protocol';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway';
import { Context } from '../../src/dsh-adapter/mod.js';
import { GovernorService } from '../../src/plugin/service.js';
import {
  GOVERNOR_REMOTE_CAPABILITIES,
  GOVERNOR_REMOTE_MAX_BYTES,
  GOVERNOR_REMOTE_USAGE_MAX_DAYS,
  GovernorRemoteService,
} from '../../src/plugin/remote-service.js';
import {
  GOVERNOR_REMOTE_CONTRIBUTION,
  GOVERNOR_REMOTE_DESCRIPTORS,
} from '../../src/plugin/remote-contract.js';
import { TYPERT } from '../../src/plugin/typert-host.js';
import type {
  GovernorCapability,
  GovernorPrincipal,
} from '../../src/security/governor-capabilities.js';
import { GovernorDatabase } from '../../src/storage/database.js';
import { GovernorRepository } from '../../src/storage/repository.js';

function setup(capabilities?: readonly GovernorCapability[]) {
  const ctx = new Context();
  const governor = new GovernorService(ctx, {
    identity: { provider: 'local', local_user_id: 'owner' },
    routing: { default: 'manual' },
    models: { 'p:a': { enabled: true, multiplier: 1, quality: { general: 90 } } },
    users: { owner: { allow: ['p:a'], monthly_credits: 100 } },
  });
  const principal: GovernorPrincipal | undefined =
    capabilities === undefined
      ? undefined
      : { id: 'host-principal', capabilities: new Set(capabilities) };
  const remote = new GovernorRemoteService(ctx, governor, () => principal);
  return { remote, governor };
}

async function expectRemoteFailure(
  action: () => Promise<unknown>,
  code:
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'PAYLOAD_TOO_LARGE'
    | 'INVALID_REQUEST'
    | 'INVALID_MINIMUM_QUALITY'
    | 'INVALID_MONTHLY_CREDITS'
    | 'INVALID_USER_ALLOW',
) {
  try {
    await action();
    throw new Error('expected Remote failure');
  } catch (error) {
    expect(error).toBeInstanceOf(TypertLookupFailure);
    const remoteError = error as TypertLookupFailure<{ code: string }>;
    expect(remoteError.failure.code).toBe(code);
    expect(remoteError.message).toBe(code);
  }
}

describe('Governor Typert Remote capability boundary', () => {
  it('匿名主体 fail closed，不允许读取', async () => {
    const { remote } = setup();
    await expectRemoteFailure(() => remote.listModels(), 'UNAUTHORIZED');
  });

  it('Host principal resolver 内部失败时只返回安全通用错误，不泄漏异常消息', async () => {
    const { governor } = setup(['governor.read']);
    const remote = new GovernorRemoteService(new Context(), governor, () => {
      throw new Error('database-password-and-path');
    });
    try {
      await remote.listModels();
      throw new Error('expected Remote failure');
    } catch (error) {
      expect(error).toBeInstanceOf(TypertLookupFailure);
      expect(
        (error as TypertLookupFailure<{ code: string; message: string }>).failure,
      ).toMatchObject({
        code: 'INTERNAL_ERROR',
        message: 'Governor operation failed',
      });
      expect(JSON.stringify(error)).not.toContain('database-password-and-path');
    }
  });

  it('read 主体可读，但直接调用 manage 方法仍由 Host 拒绝', async () => {
    const { remote, governor } = setup(['governor.read']);
    expect(await remote.listModels()).toHaveLength(1);
    await expectRemoteFailure(() => remote.updateModel('p:a', { multiplier: 2 }), 'FORBIDDEN');
    expect((await governor.listModels())[0]?.multiplierPpm).toBe(1_000_000);
  });

  it('模型和用户首屏读取携带同一个真实 configRevision，可直接用于 CAS 保存', async () => {
    const { remote, governor } = setup(['governor.read']);
    governor.recordUsage({
      id: 'usage-1',
      requestId: 'request-1',
      sessionId: 'session-1',
      turn: 1,
      step: 1,
      userId: 'owner',
      provider: 'p',
      model: 'a',
      routingMode: 'manual',
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      creditNanos: 1_250_000_000n,
      success: true,
      latencyMs: 1,
      fallbackIndex: 0,
      attemptOrigin: 'provider',
      usageMissing: false,
      createdAt: new Date().toISOString(),
    });
    const models = await remote.listModels();
    const users = await remote.listUsers();
    expect(models[0]?.configRevision).toBe(governor.configRevision);
    expect(users[0]?.configRevision).toBe(governor.configRevision);
    expect(users[0]).toMatchObject({ usedCredits: 1.25, usedCreditNanos: '1250000000' });
  });

  it('User Remote 支持 allow 回写，并以稳定错误码拒绝非法额度与 route', async () => {
    const { remote } = setup(['governor.manage']);
    await expectRemoteFailure(
      () => remote.updateUser('owner', { monthlyCredits: -1 }),
      'INVALID_MONTHLY_CREDITS',
    );
    await expectRemoteFailure(
      () => remote.updateUser('owner', { monthlyCredits: 1.5 }),
      'INVALID_MONTHLY_CREDITS',
    );
    await expectRemoteFailure(
      () => remote.updateUser('owner', { allow: ['invalid'] }),
      'INVALID_USER_ALLOW',
    );
    await expect(
      remote.updateUser('owner', { allow: ['p:a'], monthlyCredits: 20 }),
    ).resolves.toMatchObject({
      allow: ['p:a'],
      monthlyCredits: 20,
      usedCreditNanos: '0',
    });
  });

  it('manage 不隐含 read/audit；逐项能力不可横向越权', async () => {
    const { remote } = setup(['governor.manage']);
    expect((await remote.updateModel('p:a', { multiplier: 2 })).multiplierPpm).toBe(2_000_000);
    await expectRemoteFailure(() => remote.listModels(), 'FORBIDDEN');
    await expectRemoteFailure(() => remote.listAuditEntries(50), 'FORBIDDEN');
  });

  it('audit 主体只能读取完整审计，不能读取配置或写策略', async () => {
    const { remote } = setup(['governor.audit']);
    expect(await remote.listAuditEntries(50)).toEqual([]);
    await expectRemoteFailure(() => remote.listModels(), 'FORBIDDEN');
    await expectRemoteFailure(() => remote.updateUser('owner', { monthlyCredits: 1 }), 'FORBIDDEN');
  });

  it('组合能力按方法生效，管理审计 actor 取 Host principal', async () => {
    const db = new GovernorDatabase(':memory:');
    try {
      const ctx = new Context();
      const repository = new GovernorRepository(db);
      const governor = new GovernorService(
        ctx,
        {
          identity: { provider: 'local', local_user_id: 'owner' },
          models: { 'p:a': { enabled: true, multiplier: 1 } },
        },
        repository,
      );
      const remote = new GovernorRemoteService(ctx, governor, () => ({
        id: 'host-principal',
        capabilities: new Set(['governor.manage', 'governor.audit']),
      }));
      await remote.updateModel('p:a', { enabled: false });
      const audit = await remote.listAuditEntries(50);
      expect(audit[0]).toMatchObject({
        actor: 'host-principal',
        action: 'updateModel',
        result: 'success',
      });
    } finally {
      db.close();
    }
  });

  it('Remote 方法签名与严格 descriptor 均不含 actor/user/role/capabilities', () => {
    const { remote } = setup(['governor.read']);
    // userId 可作为 Users/Usage 的资源筛选条件，但不能作为调用主体声明。
    const forbiddenNames = new Set(['actor', 'actorId', 'principal', 'role', 'capabilities']);
    expect(remoteMethods(remote)).toHaveLength(Object.keys(GOVERNOR_REMOTE_CAPABILITIES).length);
    for (const descriptor of GOVERNOR_REMOTE_DESCRIPTORS) {
      expect(descriptor.parameters.some((parameter) => forbiddenNames.has(parameter.wire))).toBe(
        false,
      );
    }
  });

  it('每个导出方法都有冻结的 capability 声明和严格 Client contribution', () => {
    expect(Object.isFrozen(GOVERNOR_REMOTE_CAPABILITIES)).toBe(true);
    expect(GOVERNOR_REMOTE_CONTRIBUTION.descriptors).toBe(GOVERNOR_REMOTE_DESCRIPTORS);
    expect(GOVERNOR_REMOTE_DESCRIPTORS.map((item) => item.method).sort()).toEqual(
      Object.keys(GOVERNOR_REMOTE_CAPABILITIES).sort(),
    );
    for (const descriptor of GOVERNOR_REMOTE_DESCRIPTORS) {
      expect(descriptor.result.mode).toBe('strict');
      expect('_zod' in descriptor.result.schema).toBe(true);
      expect(descriptor.parameters.every((parameter) => parameter.codec.mode === 'strict')).toBe(
        true,
      );
    }
    const listUsers = GOVERNOR_REMOTE_DESCRIPTORS.find((item) => item.method === 'listUsers')!;
    expect(() =>
      listUsers.result.schema.parse([{ userId: 'u', allow: [], monthlyCredits: 1 }]),
    ).toThrow();
    expect(() =>
      listUsers.result.schema.parse([
        {
          userId: 'u',
          allow: [],
          monthlyCredits: 1,
          usedCredits: 0,
          usedCreditNanos: '0',
          configRevision: 1,
          browserInjected: true,
        },
      ]),
    ).toThrow();
  });

  it('真实 TypertRegistry 注册严格 Host face，并由 Gateway 调用 live service', async () => {
    const ctx = new Context();
    const registryFiber = ctx.plugin(TypertRegistry);
    await registryFiber;
    const disposeContribution = ctx.typert.register(TYPERT);
    const governor = new GovernorService(ctx, {
      identity: { provider: 'local', local_user_id: 'owner' },
      models: { 'p:a': { enabled: true, multiplier: 1 } },
      users: { owner: { allow: ['p:a'], monthly_credits: 100 } },
    });
    new GovernorRemoteService(ctx, governor, () => ({
      id: 'owner',
      capabilities: new Set(['governor.read', 'governor.manage']),
    }));
    const gatewayFiber = ctx.plugin(TypertGatewayService);
    await gatewayFiber;
    try {
      expect(ctx.typert.local.get('governor/listModels')).toBeDefined();
      const value = await ctx.typertGateway.invoke({
        namespace: 'governor',
        method: 'listModels',
        args: {},
      });
      expect(value).toMatchObject([{ routeId: 'p:a', multiplierPpm: 1_000_000 }]);
      const users = await ctx.typertGateway.invoke({
        namespace: 'governor',
        method: 'listUsers',
        args: {},
      });
      expect(users).toMatchObject([
        {
          userId: 'owner',
          allow: ['p:a'],
          usedCredits: 0,
          usedCreditNanos: '0',
          configRevision: 1,
        },
      ]);
      const dispatchRpc = Reflect.get(ctx.typertGateway, 'dispatchRpc') as (
        endpoint: string,
        payload: unknown,
        signal?: AbortSignal,
      ) => Promise<unknown>;
      await expect(
        dispatchRpc.call(
          ctx.typertGateway,
          'governor/updateModel',
          {
            args: {
              routeId: 'p:a',
              patch: {
                capabilities: ['coding'],
                quality: { general: 91, coding: 95 },
              },
              options: { expectedRevision: 1 },
            },
          },
          undefined,
        ),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          capabilities: ['coding'],
          quality: { general: 91, coding: 95 },
          configRevision: 1,
        },
      });
      await expect(
        dispatchRpc.call(
          ctx.typertGateway,
          'governor/updateModel',
          {
            args: {
              routeId: 'p:a',
              patch: { multiplier: 2 },
              options: { expectedRevision: 999 },
            },
          },
          undefined,
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'REVISION_CONFLICT' },
      });
      const invalidMinimumQuality = await dispatchRpc.call(
        ctx.typertGateway,
        'governor/updateRouting',
        {
          args: {
            patch: { creditFirst: { minimumQuality: 101 } },
          },
        },
        undefined,
      );
      expect(invalidMinimumQuality).toMatchObject({
        ok: false,
        error: {
          code: 'INVALID_MINIMUM_QUALITY',
          message: 'INVALID_MINIMUM_QUALITY',
        },
      });
      expect(JSON.stringify(invalidMinimumQuality)).not.toContain(
        'Typert lookup policy rejected the requested identity',
      );
    } finally {
      await disposeContribution();
      await gatewayFiber.dispose();
      await registryFiber.dispose();
    }
  });

  it('Remote 单请求业务参数超过 256 KiB 时拒绝', async () => {
    const { remote } = setup(['governor.read']);
    const oversized = 'x'.repeat(GOVERNOR_REMOTE_MAX_BYTES + 1);
    await expectRemoteFailure(() => remote.queryUsage({ userId: oversized }), 'PAYLOAD_TOO_LARGE');
  });

  it('Usage 默认只查最近 31 天且最多 200 条，并保留精确 creditNanos 字符串', async () => {
    const { remote, governor } = setup(['governor.read']);
    const now = Date.now();
    const base = {
      sessionId: 's',
      turn: 1,
      step: 1,
      userId: 'owner',
      provider: 'p',
      model: 'a',
      routingMode: 'auto' as const,
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      creditNanos: 1_234_567_890n,
      success: true,
      latencyMs: 1,
      fallbackIndex: 0,
      attemptOrigin: 'provider' as const,
      usageMissing: false,
    };
    governor.recordUsage({
      ...base,
      id: 'recent:0',
      requestId: 'recent',
      createdAt: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    governor.recordUsage({
      ...base,
      id: 'old:0',
      requestId: 'old',
      createdAt: new Date(now - 32 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const usage = await remote.queryUsage({});
    expect(usage.map((event) => event.requestId)).toEqual(['recent']);
    expect(usage[0]?.creditNanos).toBe('1234567890');
    await expectRemoteFailure(() => remote.queryUsage({ limit: 201 }), 'INVALID_REQUEST');
    await expectRemoteFailure(
      () =>
        remote.queryUsage({
          from: new Date(now - (GOVERNOR_REMOTE_USAGE_MAX_DAYS + 1) * 86_400_000).toISOString(),
          to: new Date(now).toISOString(),
        }),
      'INVALID_REQUEST',
    );
  });

  it('Routing read/write 也经过 read/manage 分离并复核边界值', async () => {
    const read = setup(['governor.read']).remote;
    expect((await read.getRouting()).default).toBe('manual');
    await expectRemoteFailure(() => read.updateRouting({ default: 'auto' }), 'FORBIDDEN');

    const manage = setup(['governor.manage']).remote;
    expect((await manage.updateRouting({ default: 'auto' })).default).toBe('auto');
    await expectRemoteFailure(
      () => manage.updateRouting({ creditFirst: { minimumQuality: 101 } }),
      'INVALID_MINIMUM_QUALITY',
    );
    try {
      await manage.updateRouting({ creditFirst: { minimumQuality: 101 } });
      throw new Error('expected Remote failure');
    } catch (error) {
      expect(error).toBeInstanceOf(TypertLookupFailure);
      expect((error as Error).message).toBe('INVALID_MINIMUM_QUALITY');
      expect(String(error)).toBe('Error: INVALID_MINIMUM_QUALITY');
    }
  });
});
