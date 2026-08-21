/**
 * UI HTTP API 单元测试（GOV-SEC-001 收敛版）：覆盖所有 API 端点、
 * 方法级 capability 矩阵（匿名/read/manage/audit）、Bearer 认证、
 * CORS 收敛（默认无 CORS 头、显式 origin 不返回 *）与错误分支。
 *
 * 使用 Node 内置 http 服务器 + fetch 客户端，不依赖 Playwright。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createGovernorApiServer } from '../../src/ui/api.js';
import { bootFake, modelInfo } from '../contracts/harness.js';
import { successScript } from '../../src/dsh-adapter/fake-adapter.js';
import type { FakeHarness } from '../contracts/harness.js';
import type { Server } from 'node:http';
import type { UsageEvent } from '../../src/usage/types.js';

/** 全能力管理员 token（read+manage+audit）。 */
const ADMIN_TOKEN = 'admin-token-0123456789abcdef0123456789abcdef';
/** 只读 token（仅 governor.read）。 */
const READER_TOKEN = 'reader-token-0123456789abcdef0123456789abcd';
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
  server = createGovernorApiServer(harness.governor!, {
    actors: [
      { token: ADMIN_TOKEN, capabilities: ['governor.read', 'governor.manage', 'governor.audit'] },
      { token: READER_TOKEN, capabilities: ['governor.read'] },
    ],
  });
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

/**
 * 发送 HTTP 请求并返回 {status, body}。
 *
 * @param path - 请求路径。
 * @param init - method/body/headers/auth（'admin'|'reader'|'none'，默认 admin）。
 */
async function request(
  path: string,
  init?: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    auth?: 'admin' | 'reader' | 'none';
  },
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const method = init?.method ?? 'GET';
  const headers: Record<string, string> = { ...init?.headers };
  const auth = init?.auth ?? 'admin';
  // 显式传入的 Authorization header 优先（测试错误 token 场景）。
  if (headers['Authorization'] === undefined) {
    if (auth === 'admin') headers['Authorization'] = `Bearer ${ADMIN_TOKEN}`;
    else if (auth === 'reader') headers['Authorization'] = `Bearer ${READER_TOKEN}`;
  }
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

  it('GOV-SEC-001：默认不返回 CORS 头（不返回通配 *）', async () => {
    const res = await request('/api/models');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('GOV-SEC-001：匿名访问受保护资源 → 401 UNAUTHORIZED', async () => {
    const res = await request('/api/models', { auth: 'none' });
    expect(res.status).toBe(401);
    expect((res.body as { code: string }).code).toBe('UNAUTHORIZED');
  });

  it('GOV-SEC-001：只读 token 可读（200）', async () => {
    const res = await request('/api/models', { auth: 'reader' });
    expect(res.status).toBe(200);
  });
});

// ===== PATCH /api/models/:routeId =====

describe('PATCH /api/models/:routeId', () => {
  it('匿名 → 401 UNAUTHORIZED', async () => {
    const res = await request(`/api/models/${encodeURIComponent(ROUTE_A)}`, {
      method: 'PATCH',
      body: { enabled: false },
      auth: 'none',
    });
    expect(res.status).toBe(401);
    expect((res.body as { code: string }).code).toBe('UNAUTHORIZED');
  });

  it('GOV-SEC-001：只读 token 写入 → 403 FORBIDDEN', async () => {
    const res = await request(`/api/models/${encodeURIComponent(ROUTE_A)}`, {
      method: 'PATCH',
      body: { enabled: false },
      auth: 'reader',
    });
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('FORBIDDEN');
  });

  it('错误 token → 401', async () => {
    const res = await request(`/api/models/${encodeURIComponent(ROUTE_A)}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer wrong-token' },
      body: { enabled: false },
    });
    expect(res.status).toBe(401);
  });

  it('manage token + 合法 patch → 200', async () => {
    const res = await request(`/api/models/${encodeURIComponent(ROUTE_A)}`, {
      method: 'PATCH',
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
        Authorization: `Bearer ${ADMIN_TOKEN}`,
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
    });
    expect(res.status).toBe(200);
  });

  it('不存在的 routeId → 404 MODEL_NOT_FOUND', async () => {
    const res = await request('/api/models/fake-provider:no-such-model', {
      method: 'PATCH',
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
  it('GOV-SEC-001：匿名 → 401 UNAUTHORIZED', async () => {
    const res = await request('/api/users/local', {
      method: 'PATCH',
      body: { monthlyCredits: 999 },
      auth: 'none',
    });
    expect(res.status).toBe(401);
    expect((res.body as { code: string }).code).toBe('UNAUTHORIZED');
  });

  it('GOV-SEC-001：只读 token 写入 → 403 FORBIDDEN', async () => {
    const res = await request('/api/users/local', {
      method: 'PATCH',
      body: { monthlyCredits: 999 },
      auth: 'reader',
    });
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('FORBIDDEN');
  });

  it('manage token + 合法 patch → 200', async () => {
    const res = await request('/api/users/local', {
      method: 'PATCH',
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
        Authorization: `Bearer ${ADMIN_TOKEN}`,
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
    });
    expect(res.status).toBe(200);
    const body = res.body as { userId: string; monthlyCredits: number };
    expect(body.userId).toBe('alice');
  });

  it('不存在的 userId → 404 USER_NOT_FOUND', async () => {
    const res = await request('/api/users/nobody', {
      method: 'PATCH',
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
    const oldEvent: UsageEvent = {
      ...event1,
      id: 'ev-old',
      requestId: 'req-usage-old',
      userId: 'old-user',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    harness.governor!.recordUsage(event1);
    harness.governor!.recordUsage(event2);
    harness.governor!.recordUsage(oldEvent);
  });

  it('返回全部 usage 事件', async () => {
    const res = await request('/api/usage');
    expect(res.status).toBe(200);
    const body = res.body as { data: Array<{ requestId: string }>; total: number };
    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.data.some((e) => e.requestId === 'req-usage-1')).toBe(true);
    expect(body.data.some((e) => e.requestId === 'req-usage-old')).toBe(false);
  });

  it('Host 拒绝超过 31 天或超过 200 行的无界查询', async () => {
    const wide = await request(
      `/api/usage?from=${encodeURIComponent('2026-01-01T00:00:00.000Z')}&to=${encodeURIComponent('2026-08-20T00:00:00.000Z')}`,
    );
    expect(wide.status).toBe(400);
    expect((wide.body as { code: string }).code).toBe('INVALID_REQUEST');
    const excessiveLimit = await request('/api/usage?limit=201');
    expect(excessiveLimit.status).toBe(400);
    expect((excessiveLimit.body as { code: string }).code).toBe('INVALID_REQUEST');
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
    const found = decisions.items.find((d) => d.selectedRoute === 'fake-provider:model-a');
    requestId = found!.requestId;
  });

  it('返回指定 requestId 的决策记录', async () => {
    const res = await request(`/api/decisions/${encodeURIComponent(requestId)}`);
    expect(res.status).toBe(200);
    const body = res.body as { data: Array<{ requestId: string; selectedRoute: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.requestId).toBe(requestId);
    expect(body.data[0]!.selectedRoute).toBe('fake-provider:model-a');
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

// ===== GOV-SEC-001 capability 矩阵（匿名 / read / manage / audit 及组合） =====

describe('GOV-SEC-001 capability 矩阵', () => {
  it('audit 端点：read-only token → 403 FORBIDDEN；audit token → 200', async () => {
    const reader = await request('/api/audit', { auth: 'reader' });
    expect(reader.status).toBe(403);
    expect((reader.body as { code: string }).code).toBe('FORBIDDEN');
    const admin = await request('/api/audit');
    expect(admin.status).toBe(200);
    const body = admin.body as { data: Array<{ action: string }> };
    // 管理写入产生了审计条目（updateModel/updateUser）
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('audit 端点：匿名 → 401 UNAUTHORIZED', async () => {
    const res = await request('/api/audit', { auth: 'none' });
    expect(res.status).toBe(401);
    expect((res.body as { code: string }).code).toBe('UNAUTHORIZED');
  });

  it('health 端点：read token 返回存储/对账健康摘要', async () => {
    const res = await request('/api/health', { auth: 'reader' });
    expect(res.status).toBe(200);
    const body = res.body as { storage: string; pendingDecisions: number; configRevision: number };
    expect(body.storage).toBe('available');
    expect(body.pendingDecisions).toBe(0);
    expect(body.configRevision).toBeGreaterThanOrEqual(1);
  });

  it('错误响应只包含 code/requestId（安全摘要，无内部细节）', async () => {
    const res = await request('/api/models', { auth: 'none' });
    const body = res.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['code', 'requestId']);
  });

  it('请求体超过 256 KiB → 413 PAYLOAD_TOO_LARGE', async () => {
    const big = { multiplier: 1, filler: 'x'.repeat(300 * 1024) };
    const res = await fetch(`${baseUrl}/api/models/${encodeURIComponent(ROUTE_A)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify(big),
    });
    expect(res.status).toBe(413);
  });

  it('OPTIONS 预检：默认无 CORS 头（204）', async () => {
    const res = await fetch(`${baseUrl}/api/models`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('usage 过滤参数传递（provider+userId 组合）', async () => {
    const res = await request('/api/usage?userId=user-1&provider=fake-provider');
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('REVISION_CONFLICT 映射为 409', async () => {
    // 用过期 expectedRevision 触发冲突
    const res = await request(`/api/models/${encodeURIComponent(ROUTE_A)}?expectedRevision=99999`, {
      method: 'PATCH',
      body: { multiplier: 2 },
    });
    expect(res.status).toBe(409);
    expect((res.body as { code: string }).code).toBe('REVISION_CONFLICT');
  });

  it('INVALID_MULTIPLIER 映射为 400（Host 拒绝超界值）', async () => {
    const res = await request(`/api/models/${encodeURIComponent(ROUTE_A)}`, {
      method: 'PATCH',
      body: { multiplier: -1 },
    });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('INVALID_MULTIPLIER');
  });

  it('audit limit 参数钳制（>200 → 200）', async () => {
    const res = await request('/api/audit?limit=99999');
    expect(res.status).toBe(200);
  });

  it('decisions 端点：匿名 401 / 只读 token 200', async () => {
    const anon = await request('/api/decisions/some-req', { auth: 'none' });
    expect(anon.status).toBe(401);
    const reader = await request('/api/decisions/some-req', { auth: 'reader' });
    expect(reader.status).toBe(200);
    const body = reader.body as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('health 端点：匿名 401；usage 端点：匿名 401 / reader 200', async () => {
    const healthAnon = await request('/api/health', { auth: 'none' });
    expect(healthAnon.status).toBe(401);
    const usageAnon = await request('/api/usage', { auth: 'none' });
    expect(usageAnon.status).toBe(401);
    const usageReader = await request('/api/usage', { auth: 'reader' });
    expect(usageReader.status).toBe(200);
  });

  it('users 端点：匿名 401；models 分页 limit 超上限钳制 200', async () => {
    const usersAnon = await request('/api/users', { auth: 'none' });
    expect(usersAnon.status).toBe(401);
    const res = await request('/api/models?limit=99999');
    expect(res.status).toBe(200);
    const body = res.body as { limit: number };
    expect(body.limit).toBe(200);
  });
});

describe('GOV-SEC-001 显式 allowedOrigin（CORS 收敛）', () => {
  it('配置 allowedOrigin 时返回该 origin（不返回 *）；OPTIONS 返回预检头', async () => {
    const { createGovernorApiServer } = await import('../../src/ui/api.js');
    const origin = 'https://dsh-web.example.com';
    const server2 = createGovernorApiServer(harness.governor!, {
      actors: [{ token: ADMIN_TOKEN, capabilities: ['governor.read'] }],
      allowedOrigin: origin,
    });
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', () => resolve()));
    const addr = server2.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/models`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, Origin: origin },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect(res.headers.get('Access-Control-Allow-Origin')).not.toBe('*');
      const preflight = await fetch(`http://127.0.0.1:${port}/api/models`, { method: 'OPTIONS' });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });
});
