/**
 * 合同测试 harness：启动真实 Cordis Context + LlmRuntime + FakeLlmAdapter。
 * 加载 JsonlPersistence + SessionStore 以提供真实 Session Event 双写环境
 * （flush 返回 true = durable ack），使审计管线在测试中完整闭环。
 * 只使用临时上下文，不触碰真实 DSH_HOME/Profile/Provider。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '../../src/dsh-adapter/mod.js';
import { LlmRuntime } from '../../src/dsh-adapter/mod.js';
import type { LlmModelInfo } from '../../src/dsh-adapter/mod.js';
import { FakeLlmAdapter } from '../../src/dsh-adapter/fake-adapter.js';
import type { FakeStreamScript } from '../../src/dsh-adapter/fake-adapter.js';
import { GovernorPlugin } from '../../src/plugin/mod.js';
import type { GovernorPluginConfig } from '../../src/plugin/service.js';
import { GovernorService } from '../../src/plugin/service.js';
import SessionStore from '@deepseek-ai/dsh-session';
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';

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
 * @param opts.dbPath - SQLite 路径；默认每次创建临时文件（运行时持久化接线）。
 * @param opts.adapter - 自定义 fake 适配器（如挂起流）；默认构造 FakeLlmAdapter。
 */
export async function bootFake(
  providers: string[],
  models: LlmModelInfo[],
  script: FakeStreamScript | ((options: never, callIndex: number) => FakeStreamScript),
  governorConfig?: GovernorPluginConfig,
  opts?: { dbPath?: string; adapter?: FakeLlmAdapter },
): Promise<FakeHarness> {
  const ctx = new Context();
  const llmFiber = ctx.plugin(LlmRuntime);
  await llmFiber;
  const adapter =
    opts?.adapter ??
    new FakeLlmAdapter(
      providers,
      models,
      script as FakeStreamScript | ((options: never, callIndex: number) => FakeStreamScript),
    );
  const disposeAdapter = ctx.llm.registerAdapter(providers, adapter);
  let govFiber: { dispose: () => Promise<void> } | undefined;
  let governor: GovernorService | undefined;
  let dbDir: string | undefined;
  let storeFiber: { dispose: () => Promise<void> } | undefined;
  let jsonlFiber: { dispose: () => Promise<void> } | undefined;
  if (governorConfig) {
    // 默认使用临时 SQLite 文件，证明运行时持久化接线且不触碰真实 DSH_HOME。
    // schema_version 由 harness 统一补齐（严格 Schema 校验在插件入口执行）。
    dbDir = mkdtempSync(join(tmpdir(), 'dsh-gov-harness-'));
    const dbPath = opts?.dbPath ?? join(dbDir, 'governor.db');

    // 加载 JsonlPersistence + SessionStore（在 Governor 之前），使 ctx.sessions 可用
    // 且 flush 返回 true（durable ack），审计双写协议在测试中完整闭环。
    jsonlFiber = ctx.plugin(JsonlPersistence, {
      root: join(dbDir, 'sessions'),
      compression: 'none',
    }) as unknown as { dispose: () => Promise<void> };
    await jsonlFiber;
    storeFiber = ctx.plugin(SessionStore) as unknown as { dispose: () => Promise<void> };
    await storeFiber;

    // 测试便利：patch ctx.sessions.get 使其在 session 不存在时自动创建。
    // 真实 DSH 环境中 session 由 host 在 agent 事件前创建；测试直接调用
    // selectModel 时 session 可能尚未创建，auto-create 简化测试编写。
    const sessions = (
      ctx as unknown as {
        sessions: { get(id: string): unknown; create(id: string, opts?: unknown): unknown };
      }
    ).sessions;
    const originalGet = sessions.get.bind(sessions);
    sessions.get = (id: string) => {
      const existing = originalGet(id);
      if (existing !== undefined) return existing;
      return sessions.create(id, { meta: { cwd: dbDir } });
    };

    govFiber = ctx.plugin(
      GovernorPlugin as never,
      {
        schema_version: 1,
        ...governorConfig,
        storage: { enabled: true, path: dbPath },
      } as never,
    ) as unknown as {
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
      if (storeFiber) await storeFiber.dispose();
      if (jsonlFiber) await jsonlFiber.dispose();
      await llmFiber.dispose();
      if (dbDir !== undefined) rmSync(dbDir, { recursive: true, force: true });
    },
  };
}

/** 创建常用模型的 helper。 */
export function modelInfo(provider: string, id: string, name?: string): LlmModelInfo {
  return { provider, id, name: name ?? id };
}
