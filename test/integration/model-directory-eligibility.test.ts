/** 当前 Host 模型目录只约束 Governor 自动候选，不改变显式 Manual pass-through。 */
import { describe, expect, it } from 'vitest';
import { bootFake, modelInfo } from '../contracts/harness.js';
import { successScript } from '../../src/dsh-adapter/fake-adapter.js';

describe('Governor current model directory eligibility', () => {
  it('Auto 排除 catalog 中已移除的 Pro，但 Settings 保留 policy 且 Manual 可直通', async () => {
    const provider = 'deepseek-official';
    const flash = 'DeepSeek-V4-flash';
    const pro = 'DeepSeek-V4-pro';
    const h = await bootFake(
      [provider],
      [modelInfo(provider, flash, flash)],
      successScript('ok', { inputTokens: 1, outputTokens: 1 }),
      {
        routing: { default: 'auto' },
        identity: { provider: 'local', local_user_id: 'local' },
        models: {
          [`${provider}:${flash}`]: {
            enabled: true,
            multiplier: 1,
            quality: { general: 90 },
          },
          [`${provider}:${pro}`]: {
            enabled: true,
            multiplier: 0.1,
            quality: { general: 99 },
          },
        },
      },
    );

    try {
      const rows = await h.governor!.listModels();
      expect(rows.find((row) => row.model === flash)).toMatchObject({ available: true });
      expect(rows.find((row) => row.model === pro)).toMatchObject({
        enabled: true,
        available: false,
        unavailableReason: 'model_not_listed',
      });

      const auto = await h.governor!.selectModel('auto-session', 1, 1, {
        provider,
        model: pro,
      });
      expect(auto.config).toMatchObject({ provider, model: flash });
      const autoRequestId = h.governor!.getRequestId('auto-session', 1, 1)!;
      await expect(h.governor!.explainDecision(autoRequestId)).resolves.toEqual([
        expect.objectContaining({
          selectedRoute: `${provider}:${flash}`,
          excluded: expect.arrayContaining([
            { routeId: `${provider}:${pro}`, reason: 'model_not_listed' },
          ]),
        }),
      ]);

      await h.governor!.setSessionSelectionMode('manual-session', 'manual', {
        lastManualRoute: `${provider}:${pro}`,
      });
      const manual = await h.governor!.selectModel('manual-session', 1, 1, {
        provider,
        model: pro,
      });
      expect(manual.config).toMatchObject({ provider, model: pro });
    } finally {
      await h.dispose();
    }
  });
});
