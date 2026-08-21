/** Host provider/settings/credential 同源 join 的 Governor 可用性接线。 */
import { describe, expect, it } from 'vitest';
import { Context, LlmRuntime, Service } from '../../src/dsh-adapter/mod.js';
import { FakeLlmAdapter, successScript } from '../../src/dsh-adapter/fake-adapter.js';
import { GovernorPlugin } from '../../src/plugin/mod.js';
import type { GovernorService } from '../../src/plugin/service.js';

class FakeSettings extends Service {
  private profile: Record<string, unknown> = { apiKeyEnv: 'FAKE_API_KEY' };

  constructor(ctx: Context) {
    super(ctx, 'settings');
  }

  get(namespace: string): unknown {
    if (namespace !== 'llm-fake') return undefined;
    return { providers: { 'fake-provider': this.profile } };
  }

  setProfile(profile: Record<string, unknown>): void {
    this.profile = profile;
  }
}

class FakeCredentials extends Service {
  private configured = false;

  constructor(ctx: Context) {
    super(ctx, 'credentials');
  }

  async describe(_ref: string): Promise<{ configured: boolean }> {
    return { configured: this.configured };
  }

  setConfigured(configured: boolean): void {
    this.configured = configured;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('provider availability did not refresh');
}

describe('Governor provider availability wiring', () => {
  it('没有 Settings/Credentials 时保留活动 adapter，而不是全量 availability_check_failed', async () => {
    const ctx = new Context();
    const llmFiber = ctx.plugin(LlmRuntime);
    await llmFiber;
    const adapter = new FakeLlmAdapter(
      ['standalone-provider'],
      [{ provider: 'standalone-provider', id: 'model-a', name: 'Model A' }],
      successScript('ok', { inputTokens: 1, outputTokens: 1 }),
    );
    const disposeAdapter = ctx.llm.registerAdapter(['standalone-provider'], adapter);
    const disposeDirectory = ctx.llm.registerConfigurableProviders([
      {
        provider: 'standalone-provider',
        displayName: 'Standalone Provider',
        settingsNs: 'llm-standalone',
        settingsPath: ['providers', 'standalone-provider'],
      },
    ]);
    const governorFiber = ctx.plugin(
      GovernorPlugin as never,
      {
        schema_version: 1,
        identity: { provider: 'local', local_user_id: 'local' },
        routing: { default: 'manual' },
        models: {
          'standalone-provider:model-a': {
            enabled: true,
            multiplier: 1,
            quality: { general: 90 },
          },
        },
        storage: { enabled: false },
        ui: { enabled: false },
      } as never,
    ) as unknown as PromiseLike<unknown> & { dispose(): Promise<void> };
    await governorFiber;

    try {
      const governor = (ctx as unknown as { governor: GovernorService }).governor;
      expect(await governor.listModels()).toEqual([
        expect.objectContaining({
          routeId: 'standalone-provider:model-a',
          enabled: true,
          available: true,
        }),
      ]);
    } finally {
      await governorFiber.dispose();
      disposeDirectory();
      disposeAdapter();
      await llmFiber.dispose();
    }
  });

  it('catalog 不等于可调用，且 credential/settings/adapter 三类事件都重新 join', async () => {
    const ctx = new Context();
    const llmFiber = ctx.plugin(LlmRuntime);
    await llmFiber;
    const settingsFiber = ctx.plugin(FakeSettings);
    const credentialsFiber = ctx.plugin(FakeCredentials);
    await settingsFiber;
    await credentialsFiber;

    const adapter = new FakeLlmAdapter(
      ['fake-provider'],
      [{ provider: 'fake-provider', id: 'model-a', name: 'Model A' }],
      successScript('ok', { inputTokens: 1, outputTokens: 1 }),
    );
    const disposeAdapter = ctx.llm.registerAdapter(['fake-provider'], adapter);
    const disposeDirectory = ctx.llm.registerConfigurableProviders([
      {
        provider: 'fake-provider',
        displayName: 'Fake Provider',
        settingsNs: 'llm-fake',
        settingsPath: ['providers', 'fake-provider'],
      },
    ]);
    const scopeEvidence = {
      mainContextDenied: false,
      nestedSettingsVisible: false,
      nestedCredentialsVisible: false,
    };
    const scopeProbeFiber = ctx.plugin({
      name: 'governor-availability-scope-probe',
      inject: ['llm'],
      apply(mainCtx: Context) {
        try {
          void (mainCtx as unknown as { settings: FakeSettings }).settings;
        } catch {
          scopeEvidence.mainContextDenied = true;
        }
        mainCtx.inject(['settings', 'credentials'] as never, (scopedCtx) => {
          scopeEvidence.nestedSettingsVisible =
            (scopedCtx as unknown as { settings: FakeSettings }).settings instanceof FakeSettings;
          scopeEvidence.nestedCredentialsVisible =
            (scopedCtx as unknown as { credentials: FakeCredentials }).credentials instanceof
            FakeCredentials;
        });
      },
    });
    await scopeProbeFiber;
    await waitFor(
      () =>
        scopeEvidence.mainContextDenied &&
        scopeEvidence.nestedSettingsVisible &&
        scopeEvidence.nestedCredentialsVisible,
    );
    expect(scopeEvidence).toEqual({
      mainContextDenied: true,
      nestedSettingsVisible: true,
      nestedCredentialsVisible: true,
    });
    const governorFiber = ctx.plugin(
      GovernorPlugin as never,
      {
        schema_version: 1,
        identity: { provider: 'local', local_user_id: 'local' },
        routing: { default: 'manual' },
        models: {
          'fake-provider:model-a': {
            enabled: true,
            multiplier: 1,
            quality: { general: 90 },
          },
        },
        storage: { enabled: false },
        ui: { enabled: false },
      } as never,
    ) as unknown as PromiseLike<unknown> & { dispose(): Promise<void> };
    await governorFiber;

    const governor = (ctx as unknown as { governor: GovernorService }).governor;
    const settings = (ctx as unknown as { settings: FakeSettings }).settings;
    const credentials = (ctx as unknown as { credentials: FakeCredentials }).credentials;
    const emit = (event: string, ...args: unknown[]) => {
      (
        ctx.events as unknown as {
          emit(self: object, event: string, ...args: unknown[]): void;
        }
      ).emit(ctx, event, ...args);
    };
    const available = async () => (await governor.listModels())[0]?.available;

    try {
      // Adapter 已活动且 catalog 有模型，但显式 credential ref 未配置。
      await waitFor(async () => (await available()) === false);
      expect(await available()).toBe(false);
      expect((await governor.listModels())[0]).toMatchObject({
        enabled: true,
        available: false,
        unavailableReason: 'credential_missing',
      });
      await expect(
        governor.selectModel('missing-key', 1, 1, {
          provider: 'fake-provider',
          model: 'model-a',
        }),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });

      credentials.setConfigured(true);
      emit('credentials/updated', 'FAKE_API_KEY');
      await waitFor(async () => (await available()) === true);

      // profile 不命名 credential ref 时保留 provider 自身身份链语义。
      credentials.setConfigured(false);
      settings.setProfile({});
      emit('settings/updated', 'llm-fake', {}, {}, 'update');
      await waitFor(async () => (await available()) === true);

      // adapters-updated 也使用同一 join，不会只凭 catalog 把显式缺 key 的 route 加回。
      settings.setProfile({ apiKeyEnv: 'FAKE_API_KEY' });
      emit('llm/adapters-updated');
      await waitFor(async () => (await available()) === false);
      expect((await governor.listModels())[0]?.unavailableReason).toBe('credential_missing');

      // optional seam 离线后 nested scope 会卸载；不得把最后一次 unavailable
      // 永久冻结。活动 adapter 回退为 provider-owned auth 的兼容候选。
      await credentialsFiber.dispose();
      await waitFor(async () => (await available()) === true);
      expect((await governor.listModels())[0]).toMatchObject({
        enabled: true,
        available: true,
      });
    } finally {
      await governorFiber.dispose();
      await scopeProbeFiber.dispose();
      disposeDirectory();
      disposeAdapter();
      await credentialsFiber.dispose();
      await settingsFiber.dispose();
      await llmFiber.dispose();
    }
  });
});
