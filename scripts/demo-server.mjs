#!/usr/bin/env node
/**
 * 本地 Demo 服务器：用 FakeLlmAdapter 启动完整治理运行时 + Governor Web UI。
 *
 * 用途：无 Provider 凭证、无外部费用地交互式查看插件效果。
 * - 启动真实 Cordis Context + LlmRuntime + GovernorPlugin（SQLite 落临时文件）
 * - 自动发起几次 fake 模型调用，产生 Usage / Credits / 决策数据
 * - 启动 Governor HTTP API 服务器，浏览器访问三个页面（Models/Users/Usage）
 *
 * 用法：
 *   pnpm build
 *   node scripts/demo-server.mjs            # 默认端口 3757
 *   PORT=4000 node scripts/demo-server.mjs  # 自定义端口
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, LlmRuntime } from '../dist/dsh-adapter/mod.js';
import { FakeLlmAdapter, successScript } from '../dist/dsh-adapter/fake-adapter.js';
import { GovernorPlugin } from '../dist/plugin/mod.js';
import { createGovernorApiServer } from '../dist/ui/api.js';

/** 监听端口（可通过 PORT 环境变量覆盖，与 examples/governor.yml 示例一致）。 */
const port = Number(process.env.PORT ?? 3757);
/** Demo 管理员令牌：在页面管理操作输入框中填写可获得写权限。 */
const adminToken = 'demo-admin-token';
/** 临时 SQLite 目录（退出时清理，不触碰真实 DSH_HOME）。 */
const dbDir = mkdtempSync(join(tmpdir(), 'dsh-gov-demo-'));
const dbPath = join(dbDir, 'governor.db');

/** 注册的 fake provider 与模型目录。 */
const providers = ['fake-provider'];
const models = [
  { provider: 'fake-provider', id: 'model-a', name: 'Model A（高质量）' },
  { provider: 'fake-provider', id: 'model-b', name: 'Model B（低成本）' },
];

/** Governor 插件配置（与 test/ui/pages.test.ts 已验证的最小可用配置一致）。 */
const governorConfig = {
  schema_version: 1,
  models: {
    'fake-provider:model-a': {
      enabled: true,
      multiplier: 1,
      quality: { general: 90, coding: 96 },
    },
    'fake-provider:model-b': {
      enabled: true,
      multiplier: 0.5,
      quality: { general: 80, coding: 84 },
    },
  },
  users: {
    local: { allow: [], monthly_credits: 100 },
  },
  fallback: { enabled: true, max_attempts: 2 },
  identity: { provider: 'local', local_user_id: 'local' },
  storage: { enabled: true, path: dbPath },
};

/**
 * 执行一次完整请求（agent/request 决策 → llm/stream 消费），产生 Usage 数据。
 * @param {Context} ctx - Cordis 上下文。
 * @param {FakeLlmAdapter} adapter - fake 适配器。
 * @param {string} sessionId - 会话 ID。
 * @param {number} turn - 轮次。
 * @param {number} step - 步骤。
 */
async function runAttempt(ctx, adapter, sessionId, turn, step) {
  await ctx.events.waterfall(
    'agent/request',
    { agent: { id: sessionId }, turn, step, signal: new AbortController().signal },
    async () => ({ provider: 'fake-provider', model: 'model-a' }),
  );
  const stream = ctx.events.waterfall(
    'llm/stream',
    {
      provider: 'fake-provider',
      model: 'model-a',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'demo request' }] }],
      sessionId,
    },
    () =>
      adapter.stream({
        provider: 'fake-provider',
        model: 'model-a',
        messages: [],
      }),
  );
  for await (const _chunk of stream) {
    void _chunk;
  }
}

/** 主流程：启动运行时 → 产生示例数据 → 启动 Web 服务器。 */
async function main() {
  const ctx = new Context();
  const llmFiber = ctx.plugin(LlmRuntime);
  await llmFiber;
  const adapter = new FakeLlmAdapter(providers, models, (options, callIndex) =>
    successScript(`demo reply #${callIndex + 1} from ${options?.model ?? 'model-a'}`, {
      inputTokens: 120 + callIndex * 10,
      outputTokens: 45 + callIndex * 5,
    }),
  );
  ctx.llm.registerAdapter(providers, adapter);

  const govFiber = ctx.plugin(GovernorPlugin, governorConfig);
  await govFiber;
  const governor = ctx.governor;

  // 绑定 demo 会话身份（local 模式），使后续调用通过身份检查
  await governor.bindIdentity('demo-session', { userId: 'local' });

  // 自动产生几条 Usage 记录，让 Usage/Credits 页面启动即有数据
  for (let turn = 1; turn <= 3; turn++) {
    await runAttempt(ctx, adapter, 'demo-session', turn, 1);
  }

  const server = createGovernorApiServer(governor, { adminToken });
  server.listen(port, '127.0.0.1', () => {
    console.log('Governor Demo 已启动（FakeLlmAdapter，无真实模型调用）：');
    console.log('');
    console.log(`  Models 页: http://127.0.0.1:${port}/pages/models.html`);
    console.log(`  Users  页: http://127.0.0.1:${port}/pages/users.html`);
    console.log(`  Usage  页: http://127.0.0.1:${port}/pages/usage.html`);
    console.log('');
    console.log(`  管理员令牌（页面写操作时填写）: ${adminToken}`);
    console.log(`  SQLite（临时，退出即删）: ${dbPath}`);
    console.log('');
    console.log('按 Ctrl+C 退出。');
  });

  /** 退出时清理资源：服务器、插件 fiber、临时数据库。 */
  async function shutdown() {
    server.close();
    try {
      await govFiber.dispose();
      await llmFiber.dispose();
    } catch {
      // 忽略退出阶段的清理异常
    }
    rmSync(dbDir, { recursive: true, force: true });
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Demo 启动失败：', err);
  rmSync(dbDir, { recursive: true, force: true });
  process.exit(1);
});
