/**
 * 合同测试 harness：启动真实 Cordis Context + LlmRuntime + FakeLlmAdapter。
 * 只使用临时上下文，不触碰真实 DSH_HOME/Profile/Provider。
 */
import { Context } from '../../src/dsh-adapter/mod.js';
import { LlmRuntime } from '../../src/dsh-adapter/mod.js';
import type { LlmModelInfo } from '../../src/dsh-adapter/mod.js';
import { FakeLlmAdapter } from '../../src/dsh-adapter/fake-adapter.js';
import type { FakeStreamScript } from '../../src/dsh-adapter/fake-adapter.js';
import { applyGovernor } from '../../src/plugin/mod.js';
import type { GovernorPluginConfig } from '../../src/plugin/mod.js';
import { GovernorService } from '../../src/plugin/service.js';

/** 测试 harness 的句柄。 */
export interface FakeHarness {
  /** 已加载 LlmRuntime 的 Cordis 上下文。 */
  ctx: Context;
  /** fake 适配器实例，用于检查 calls 和修改脚本。 */
  adapter: FakeLlmAdapter;
  /** Governor 服务实例（如已加载）。 */
  governor?: GovernorService;
  /** 卸载全部资源。 */
  dispose: () => Promise<void>;
}

/**
 * 启动一个带有 fake adapter 的 Cordis 上下文，可选加载 Governor 插件。
 * @param providers - 注册的 provider 路由列表。
 * @param models - 建议模型目录。
 * @param script - 流脚本。
 * @param governorConfig - Governor 插件配置（提供则加载 Governor）。
 */
export async function bootFake(
  providers: string[],
  models: LlmModelInfo[],
  script: FakeStreamScript | ((options: never, callIndex: number) => FakeStreamScript),
  governorConfig?: GovernorPluginConfig,
): Promise<FakeHarness> {
  const ctx = new Context();
  const llmFiber = ctx.plugin(LlmRuntime);
  await llmFiber;
  const adapter = new FakeLlmAdapter(
    providers,
    models,
    script as FakeStreamScript | ((options: never, callIndex: number) => FakeStreamScript),
  );
  const disposeAdapter = ctx.llm.registerAdapter(providers, adapter);
  let govFiber: { dispose: () => Promise<void> } | undefined;
  let governor: GovernorService | undefined;
  if (governorConfig) {
    const { GovernorPlugin } = await import('../../src/plugin/mod.js');
    govFiber = ctx.plugin(GovernorPlugin as never, governorConfig as never) as unknown as {
      dispose: () => Promise<void>;
    };
    await (govFiber as never as PromiseLike<unknown>);
    governor = (ctx as unknown as { governor: GovernorService }).governor;
  }
  return {
    ctx,
    adapter,
    governor,
    dispose: async () => {
      disposeAdapter();
      if (govFiber) await govFiber.dispose();
      await llmFiber.dispose();
    },
  };
}

/** 创建常用模型的 helper。 */
export function modelInfo(provider: string, id: string, name?: string): LlmModelInfo {
  return { provider, id, name: name ?? id };
}
