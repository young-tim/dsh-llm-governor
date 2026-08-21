/** GovernorPlugin 的真实 Remote 接线与非 local 模式 fail-closed。 */
import { describe, expect, it } from 'vitest';
import { TypertLookupFailure } from '@deepseek-ai/dsh-typert-protocol';
import { bootFake, modelInfo } from '../contracts/harness.js';
import { successScript } from '../../src/dsh-adapter/fake-adapter.js';
import type { GovernorRemoteService } from '../../src/plugin/remote-service.js';
import type { GovernorPluginConfig } from '../../src/plugin/service.js';

function remoteOf(ctx: object): GovernorRemoteService {
  return (ctx as { get(name: string): unknown }).get('governorRemote') as GovernorRemoteService;
}

describe('GovernorPlugin Typert Remote wiring', () => {
  it('local 模式由 Host 注入进程所有者，全能力方法可用', async () => {
    const harness = await bootFake(
      ['p'],
      [modelInfo('p', 'a')],
      successScript('ok', { inputTokens: 1, outputTokens: 1 }),
      {
        identity: { provider: 'local', local_user_id: 'owner' },
        models: { 'p:a': { enabled: true, multiplier: 1 } },
      },
    );
    try {
      const remote = remoteOf(harness.ctx);
      expect(remote.typertRemote).toMatchObject({
        serviceKey: 'governorRemote',
        namespace: 'governor',
      });
      expect(await remote.describeAccess()).toEqual({
        actorId: 'owner',
        capabilities: ['governor.audit', 'governor.manage', 'governor.read'],
      });
    } finally {
      await harness.dispose();
    }
  });

  it('header 模式没有请求级 Host principal provider 时拒绝，额外浏览器参数不能自报主体', async () => {
    const config = {
      identity: {
        provider: 'header',
        header_name: 'x-governor-user',
        trusted_proxy: 'companion-ingress',
      },
      models: { 'p:a': { enabled: true, multiplier: 1 } },
    } as unknown as GovernorPluginConfig;
    const harness = await bootFake(
      ['p'],
      [modelInfo('p', 'a')],
      successScript('ok', { inputTokens: 1, outputTokens: 1 }),
      config,
    );
    try {
      const remote = remoteOf(harness.ctx);
      // JS 调用者即使附加自报 role/capabilities，方法也没有相应参数且仍由 Host 拒绝。
      const forgedCall = remote.listModels.bind(remote, {
        actor: 'attacker',
        role: 'admin',
        capabilities: ['governor.read'],
      } as never);
      await expect(forgedCall()).rejects.toMatchObject({
        failure: { code: 'UNAUTHORIZED' },
      } satisfies Partial<TypertLookupFailure>);
    } finally {
      await harness.dispose();
    }
  });
});
