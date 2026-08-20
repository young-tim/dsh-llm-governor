/**
 * UI HTTP API 单元测试：覆盖所有 API 端点与错误分支。
 *
 * 使用 Node 内置 http 服务器 + fetch 客户端，不依赖 Playwright。
 * 覆盖：GET / 重定向、静态页面、GET /api/models（含分页）、
 * PATCH /api/models/:routeId（含 403/400/404）、GET /api/users、
 * PATCH /api/users/:userId（含 403/400/404）、GET /api/usage（含过滤）、
 * GET /api/decisions/:requestId、未知路由 404。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createGovernorApiServer } from '../../src/ui/api.js';
import { bootFake, modelInfo } from '../contracts/harness.js';
import { successScript } from '../../src/dsh-adapter/fake-adapter.js';
import type { FakeHarness } from '../contracts/harness.js';
import type { Server } from 'node:http';
import type { UsageEvent } from '../../src/usage/types.js';

const ADMIN_TOKEN = 'test-admin-token';
const ROUTE_A = 'fake-provider:model-a';

let harness: FakeHarness;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  harness = await bootFake(
    ['fake-provider'],
    [
      modelInfo('fake-provider', 'model-a', 'Model A'),
      modelInfo('fake-provider', 'model-b', 'Model B'),
    ],
    successScript('hi', { inputTokens: 10, outputTokens: 5 }),
    {
      models: {
        'fake-provider:model-a': { enabled: true, multiplier: 1, quality: { general: 90 } },
        'fake-provider:model-b': { enabled: true, multiplier: 0.5, quality: { general: 80 } },
      },
      users: {
        local: { allow: [], monthly_credits: 100 },
        alice: { allow: [ROUTE_A], monthly_credits: 200 },
      },
      fallback: { enabled: true, max_attempts: 2 },
      identity: { provider: 'local' as const, local_user_id: 'local' },
    },
  );
  server = createGovernorApiServer(harness.governor!, { adminToken: ADMIN_TOKEN });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}, 30000);

afterAll(async () => {
  server?.close();
  await harness?.dispose().catch(() => {});
});

/** 发送 HTTP 请求并返回 {status, body}。 */
async function request(
  path: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const method = init?.method ?? 'GET';
  const headers: Record<string, string> = { ...init?.headers };
  let bodyText: string | undefined;
  if (init?.body !== undefined) {
    bodyText = JSON.stringify(init.body);
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: bodyText,
    redirect: 'manual', // 不自动跟随重定向，便于断言 302
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // 非 JSON 响应保留原始文本
  }
  return { status: res.status, body, headers: res.headers };
}

// ===== 根路径重定向 =====

describe('根路径', () => {
  it('GET / 重定向到 /pages/models.html（302）', async () => {
    const res = await request('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/pages/models.html');
  });
});

// ===== 静态页面 =====

describe('静态页面', () => {
  it('GET /pages/models.html 返回 HTML（200）', async () => {
    const res = await request('/pages/models.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(typeof res.body).toBe('string');
    expect(res.body as string).toContain('<');
  });

  it('GET /pages/users.html 返回 HTML（200）', async () => {
    const res = await request('/pages/users.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
  });

  it('GET /pages/usage.html 返回 HTML（200）', async () => {
    const res = await request('/pages/usage.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
  });

  it('GET /pages/nonexistent.html 不在白名单 → 404', async () => {
    const res = await request('/pages/nonexistent.html');
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe('NOT_FOUND');
  });
});

// ===== GET /api/models =====

describe('GET /api/models', () => {
  it('返回所有模型', async () => {
    const res = await request('/api/models');
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[]; total: number; limit: number; offset: number };
    expect(body.total).toBe(2);
    expect(body.data).toHaveLength(2);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it('支持 limit 分页', async () => {
    const res = await request('/api/models?limit=1');
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[]; total: number; limit: number; offset: number };
    expect(body.data).toHaveLength(1);
    expect(body.total).toBe(2);
    expect(body.limit).toBe(1);
  });

  it('支持 offset 分页', async () => {
    const res = await request('/api/models?offset=1');
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[]; total: number; limit: number; offset: number };
    expect(body.data).toHaveLength(1);
    expect(body.offset).toBe(1);
  });

  it('limit=0 视为无效，默认 50', async () => {
    const res = await request('/api/models?limit=0');
    expect(res.status).toBe(200);
    const body = res.body as { limit: number };
    expect(body.limit).toBe(50);
  });

  it('limit=abc（非数字）默认 50', async () => {
    const res = await request('/api/models?limit=abc');
    expect(res.status).toBe(200);
    const body = res.body as { limit: number };
    expect(body.limit).toBe(50);
  });

  it('offset=-1（负数）默认 0', async () => {
    const res = await request('/api/models?offset=-1');
    expect(res.status).toBe(200);
    const body = res.body as { offset: number };
    expect(body.offset).toBe(0);
  });

  it('响应包含 CORS 头', async () => {
    const res = await request('/api/models');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('PATCH');
  });
});

// ===== PATCH /api/models/:routeId =====

describe('PATCH /api/models/:routeId', () => {
  it('无 admin token → 403 FORBIDDEN', async () => {
    const res = await request(`/api/models/${encodeURIComponent(ROUTE_A)}`, {
      method: 'PATCH',
      body: { enabled: false },
    });
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('FORBIDDEN');
  });

  it('错误的 admin token → 403', async () => {
    const res = await request(`/api/models/${encodeURIComponent(ROUTE_A)}`, {
      method: 'PATCH',
      headers: { 'X-Governor-Admin': 'wrong-token' },
      body: { enabled: false },
    });
    expect(res.status).toBe(403);
  });

  it('正确 admin token + 合法 patch → 200', async () => {
    const res = await request(`/api/models/${encodeURIComponent(ROUTE_A)}`, {
      method: 'PATCH',
      headers: { 'X-Governor-Admin': ADMIN_TOKEN },
      body: { enabled: true, multiplier: 1.5 },
    });
    expect(res.status).toBe(200);
    const body = res.body as { routeId: string; enabled: boolean; multiplierPpm: number };
    expect(body.routeId).toBe(ROUTE_A);
    expect(body.enabled).toBe(true);
    expect(body.multiplierPpm).toBe(1_500_000);
  });

  it('无效 JSON body → 400 INVALID_JSON', async () => {
    // 直接发送非 JSON 文本
    const res = await fetch(`${baseUrl}/api/models/${encodeURIComponent(ROUTE_A)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Governor-Admin': ADMIN_TOKEN,
      },
      body: 'not-valid-json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_JSON');
  });

  it('空 body → 视为 {} → 200（空 patch）', async () => {
    const res = await request(`/api/models/${encodeURIComponent(ROUTE_A)}`, {
      method: 'PATCH',
      headers: { 'X-Governor-Admin': ADMIN_TOKEN },
    });
    expect(res.status).toBe(200);
  });

  it('不存在的 routeId → 404 MODEL_NOT_FOUND', async () => {
    const res = await request('/api/models/fake-provider:no-such-model', {
      method: 'PATCH',
      headers: { 'X-Governor-Admin': ADMIN_TOKEN },
      body: { enabled: false },
    });
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe('MODEL_NOT_FOUND');
  });
});

// ===== GET /api/users =====

describe('GET /api/users', () => {
  it('返回所有用户', async () => {
    const res = await request('/api/users');
    expect(res.status).toBe(200);
    const body = res.body as { data: Array<{ userId: string }>; total: number };
    expect(body.total).toBe(2);
    expect(body.data.map((u) => u.userId).sort()).toEqual(['alice', 'local']);
  });
});

// ===== PATCH /api/users/:userId =====

describe('PATCH /api/users/:userId', () => {
  it('无 admin token → 403 FORBIDDEN', async () => {
    const res = await request('/api/users/local', {
      method: 'PATCH',
      body: { monthlyCredits: 999 },
    });
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('FORBIDDEN');
  });

  it('正确 admin token + 合法 patch → 200', async () => {
    const res = await request('/api/users/local', {
      method: 'PATCH',
      headers: { 'X-Governor-Admin': ADMIN_TOKEN },
      body: { monthlyCredits: 555 },
    });
    expect(res.status).toBe(200);
    const body = res.body as { userId: string; monthlyCredits: number };
    expect(body.userId).toBe('local');
    expect(body.monthlyCredits).toBe(555);
  });

  it('无效 JSON body → 400 INVALID_JSON', async () => {
    const res = await fetch(`${baseUrl}/api/users/local`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Governor-Admin': ADMIN_TOKEN,
      },
      body: '{invalid',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_JSON');
  });

  it('空 body → 视为 {} → 200（空 patch）', async () => {
    const res = await request('/api/users/alice', {
      method: 'PATCH',
      headers: { 'X-Governor-Admin': ADMIN_TOKEN },
    });
    expect(res.status).toBe(200);
    const body = res.body as { userId: string; monthlyCredits: number };
    expect(body.userId).toBe('alice');
  });

  it('不存在的 userId → 404 USER_NOT_FOUND', async () => {
    const res = await request('/api/users/nobody', {
      method: 'PATCH',
      headers: { 'X-Governor-Admin': ADMIN_TOKEN },
      body: { monthlyCredits: 1 },
    });
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe('USER_NOT_FOUND');
  });
});

// ===== GET /api/usage =====

describe('GET /api/usage', () => {
  // 在所有测试前注入一些 usage 事件
  beforeAll(async () => {
    // 注入两条 usage 事件
    const event1: UsageEvent = {
      id: 'ev-1',
      requestId: 'req-usage-1',
      sessionId: 'session-1',
      turn: 1,
      step: 1,
      userId: 'user-1',
      provider: 'fake-provider',
      model: 'model-a',
      routingMode: 'manual',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      creditNanos: 1_500_000n,
      success: true,
      latencyMs: 200,
      fallbackIndex: 0,
      attemptOrigin: 'provider',
      usageMissing: false,
      createdAt: '2026-08-20T00:00:00.000Z',
    };
    const event2: UsageEvent = {
      ...event1,
      id: 'ev-2',
      requestId: 'req-usage-2',
      userId: 'user-2',
      provider: 'other-provider',
      model: 'model-x',
      creditNanos: 3_000_000n,
      inputTokens: 200,
      outputTokens: 100,
    };
    harness.governor!.recordUsage(event1);
    harness.governor!.recordUsage(event2);
  });

  it('返回全部 usage 事件', async () => {
    const res = await request('/api/usage');
    expect(res.status).toBe(200);
    const body = res.body as { data: Array<{ requestId: string }>; total: number };
    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.data.some((e) => e.requestId === 'req-usage-1')).toBe(true);
  });

  it('按 userId 过滤', async () => {
    const res = await request('/api/usage?userId=user-1');
    expect(res.status).toBe(200);
    const body = res.body as { data: Array<{ requestId: string; userId?: string }>; total: number };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.data.every((e) => e.requestId === 'req-usage-1')).toBe(true);
  });

  it('按 provider 过滤', async () => {
    const res = await request('/api/usage?provider=other-provider');
    expect(res.status).toBe(200);
    const body = res.body as { data: Array<{ provider: string }>; total: number };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.data.every((e) => e.provider === 'other-provider')).toBe(true);
  });

  it('同时按 userId 和 provider 过滤（AND）', async () => {
    const res = await request('/api/usage?userId=user-1&provider=fake-provider');
    expect(res.status).toBe(200);
    const body = res.body as { data: Array<{ requestId: string }>; total: number };
    expect(body.data.every((e) => e.requestId === 'req-usage-1')).toBe(true);
  });

  it('过滤无匹配时返回空数组', async () => {
    const res = await request('/api/usage?userId=nonexistent');
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[]; total: number };
    expect(body.data).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it('creditNanos 转换为人类可读 credits', async () => {
    const res = await request('/api/usage?userId=user-1');
    expect(res.status).toBe(200);
    const body = res.body as { data: Array<{ credits: number }> };
    // 1_500_000 nanos / 1_000_000_000 = 0.0015 credits
    expect(body.data[0]!.credits).toBeCloseTo(0.0015, 8);
  });
});

// ===== GET /api/decisions/:requestId =====

describe('GET /api/decisions/:requestId', () => {
  let requestId: string;

  beforeAll(async () => {
    // 触发一次 agent/request 以生成 decision 记录
    const e = harness.ctx.events as unknown as {
      waterfall: (name: string, ...args: unknown[]) => Promise<unknown>;
    };
    await e.waterfall(
      'agent/request',
      {
        agent: { id: 'session-decision' },
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      },
      async () => ({ provider: 'fake-provider', model: 'model-a' }),
    );
    const decisions = await harness.governor!.listDecisions();
    const found = decisions.find((d) => d.selectedModel === 'model-a');
    requestId = found!.requestId;
  });

  it('返回指定 requestId 的决策记录', async () => {
    const res = await request(`/api/decisions/${encodeURIComponent(requestId)}`);
    expect(res.status).toBe(200);
    const body = res.body as { data: Array<{ requestId: string; selectedModel: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.requestId).toBe(requestId);
    expect(body.data[0]!.selectedModel).toBe('model-a');
  });

  it('不存在的 requestId 返回空数组', async () => {
    const res = await request('/api/decisions/nonexistent-request');
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[] };
    expect(body.data).toHaveLength(0);
  });
});

// ===== 未知路由 =====

describe('未知路由', () => {
  it('未知 API 路由 → 404 NOT_FOUND', async () => {
    const res = await request('/api/unknown-endpoint');
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe('NOT_FOUND');
  });

  it('非 API、非页面路由 → 404 NOT_FOUND', async () => {
    const res = await request('/some/random/path');
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe('NOT_FOUND');
  });
});
