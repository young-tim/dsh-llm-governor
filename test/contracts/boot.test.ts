/**
 * 最小化启动验证：证明 Context + LlmRuntime + FakeLlmAdapter 可以启动并工作。
 */
import { describe, it, expect } from 'vitest';
import { bootFake, modelInfo } from './harness.js';
import { successScript } from '../../src/dsh-adapter/fake-adapter.js';

describe('DSH boot smoke', () => {
  it('启动 Context + LlmRuntime + FakeLlmAdapter 并能列出 provider/model', async () => {
    const harness = await bootFake(
      ['fake-provider'],
      [modelInfo('fake-provider', 'fake-model', 'Fake Model')],
      successScript('hello', { inputTokens: 10, outputTokens: 5 }),
    );
    try {
      const providers = harness.ctx.llm.listProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0]!.id).toBe('fake-provider');

      const models = await harness.ctx.llm.listModels('fake-provider');
      expect(models).toHaveLength(1);
      expect(models[0]!.id).toBe('fake-model');
    } finally {
      await harness.dispose();
    }
  });

  it('能通过 ctx.llm.stream 获得完整 StreamChunk 流', async () => {
    const harness = await bootFake(
      ['fake-provider'],
      [modelInfo('fake-provider', 'fake-model')],
      successScript('hi', { inputTokens: 3, outputTokens: 2 }),
    );
    try {
      const stream = harness.ctx.llm.stream({
        provider: 'fake-provider',
        model: 'fake-model',
        messages: [],
      });
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      // 至少有 block-start, text-delta, block-end, usage, finish
      expect(chunks.length).toBeGreaterThanOrEqual(5);
      const finish = chunks.find((c) => c.type === 'finish');
      expect(finish).toBeDefined();
      const usage = chunks.find((c) => c.type === 'usage');
      expect(usage).toBeDefined();
    } finally {
      await harness.dispose();
    }
  });
});
