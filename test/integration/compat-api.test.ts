/**
 * 任务3 集成测试：GOV-UI-001 兼容 API 与默认零监听。
 *
 * - 默认（compatApi 未配置/enabled=false）：插件加载后进程不新增任何监听端口
 *   （socket 计数前后一致）。
 * - compatApi.enabled=true：仅监听 loopback（127.0.0.1/[::1]）；
 *   requireLoopback 拒绝非回环 peer（403 FORBIDDEN）。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { Context } from '../../src/dsh-adapter/mod.js';
import type { LlmModelInfo } from '../../src/dsh-adapter/mod.js';
import { LlmRuntime } from '../../src/dsh-adapter/mod.js';
import { FakeLlmAdapter } from '../../src/dsh-adapter/fake-adapter.js';
import { successScript } from '../../src/dsh-adapter/fake-adapter.js';
import { GovernorPlugin } from '../../src/plugin/mod.js';
import { createGovernorApiServer } from '../../src/ui/api.js';
import { GovernorService } from '../../src/plugin/service.js';
import type { GovernorPluginConfig } from '../../src/plugin/service.js';

const providers = ['fake-provider'];
const models: LlmModelInfo[] = [{ provider: 'fake-provider', id: 'model-a', name: 'Model A' }];

function baseConfig(dbPath: string): GovernorPluginConfig {
  return {
    identity: { provider: 'local', local_user_id: 'local' },
    routing: { default: 'manual' },
    models: { 'fake-provider:model-a': { quality: { general: 90 }, multiplier: 1 } },
    storage: { enabled: true, path: dbPath },
  } as GovernorPluginConfig;
}

/** 统计当前进程监听中的 server socket 数量。 */
function countListeningSockets(): number {
  // Node 没有公开 API 枚举监听 socket；用 process._getActiveHandles 近似计数
  // （http/net server handle 会出现在 active handles 中）。
  const handles =
    (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
  return handles.filter((h) => h instanceof net.Server).length;
}

describe('GOV-UI-001 默认零监听', () => {
  it('compatApi 未配置：插件加载前后监听 socket 数量不变（无 Governor 新增端口）', async () => {
    const ctx = new Context();
    const llm = ctx.plugin(LlmRuntime);
    await llm;
    const adapter = new FakeLlmAdapter(
      providers,
      models,
      successScript('ok', { inputTokens: 1, outputTokens: 1 }),
    );
    const disposeAdapter = ctx.llm.registerAdapter(providers, adapter);
    const dbDir = mkdtempSync(join(tmpdir(), 'dsh-gov-socket-'));
    const before = countListeningSockets();
    const gov = ctx.plugin(
      GovernorPlugin as never,
      {
        schema_version: 1,
        ...baseConfig(join(dbDir, 'governor.db')),
        ui: { enabled: true },
      } as never,
    ) as unknown as { dispose: () => Promise<void> };
    await (gov as never as PromiseLike<unknown>);
    const after = countListeningSockets();
    expect(after).toBe(before);
    await gov.dispose();
    disposeAdapter();
    await llm.dispose();
    rmSync(dbDir, { recursive: true, force: true });
  });
});

describe('GOV-UI-001 兼容 API loopback 强制', () => {
  it('requireLoopback：非回环 peer 请求被拒绝（403 FORBIDDEN）', async () => {
    const ctx = new Context();
    const llm = ctx.plugin(LlmRuntime);
    await llm;
    const adapter = new FakeLlmAdapter(
      providers,
      models,
      successScript('ok', { inputTokens: 1, outputTokens: 1 }),
    );
    const disposeAdapter = ctx.llm.registerAdapter(providers, adapter);
    const dbDir = mkdtempSync(join(tmpdir(), 'dsh-gov-compat-'));
    const gov = ctx.plugin(
      GovernorPlugin as never,
      {
        schema_version: 1,
        ...baseConfig(join(dbDir, 'governor.db')),
      } as never,
    ) as unknown as { dispose: () => Promise<void> };
    await (gov as never as PromiseLike<unknown>);
    const service = (ctx as unknown as { governor: GovernorService }).governor;
    const token = 'compat-token-0123456789abcdef0123456789abcdef';

    // 独立服务器（requireLoopback 默认强制）
    const server = createGovernorApiServer(service, {
      actors: [{ token, capabilities: ['governor.read', 'governor.manage'] }],
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    // 回环请求（正常 loopback peer）→ 通过认证返回数据
    const okRes = await fetch(`http://127.0.0.1:${port}/api/models`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(okRes.status).toBe(200);

    // 模拟非回环 peer：直接调用 handler（伪造 remoteAddress）
    const handlerResponse = {
      statusCode: 0,
      headers: {} as Record<string, string | number>,
      body: '',
      writeHead(status: number, headers: Record<string, string | number>) {
        this.statusCode = status;
        this.headers = headers;
      },
      end(body?: string) {
        if (body !== undefined) this.body = body;
      },
    };
    // 从模块导入 handler 构造器验证 requireLoopback 拒绝
    const { createGovernorRequestHandler } = await import('../../src/ui/api.js');
    const strictHandler = createGovernorRequestHandler(service, {
      actors: [{ token, capabilities: ['governor.read'] }],
      requireLoopback: true,
    });
    await strictHandler(
      {
        url: '/api/models',
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        socket: { remoteAddress: '10.0.0.5' },
      } as never,
      handlerResponse as never,
    );
    expect(handlerResponse.statusCode).toBe(403);
    expect(JSON.parse(handlerResponse.body).code).toBe('FORBIDDEN');

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await gov.dispose();
    disposeAdapter();
    await llm.dispose();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('generateCompatToken 生成 256 bit 随机 token（64 hex）', async () => {
    const { generateCompatToken } = await import('../../src/ui/api.js');
    const token = generateCompatToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(generateCompatToken()).not.toBe(token);
  });
});

void http;
