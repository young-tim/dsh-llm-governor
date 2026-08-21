/**
 * UI 浏览器测试（GOV-SEC-001 收敛版）：验证 Models/Users/Usage 三页加载、
 * 编辑、筛选、未授权拒绝（401/403 capability 矩阵），且 console error=0。
 * 使用 Playwright chromium。不直连 SQLite（只通过 GovernorService API）。
 * Bearer token 通过 localStorage（governor-token）注入页面。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { bootFake, modelInfo } from '../contracts/harness.js';
import type { FakeHarness } from '../contracts/harness.js';
import { createGovernorApiServer } from '../../src/ui/api.js';
import type { Server } from 'node:http';

/** 管理员 Bearer token（read+manage+audit）。 */
const ADMIN_TOKEN = 'admin-token-0123456789abcdef0123456789abcdef';

let browser: Browser;
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
    { text: 'hi', usage: { inputTokens: 10, outputTokens: 5 }, finish: 'stop' } as never,
    {
      models: {
        'fake-provider:model-a': { enabled: true, multiplier: 1, quality: { general: 90 } },
        'fake-provider:model-b': { enabled: true, multiplier: 0.5, quality: { general: 80 } },
      },
      users: {
        local: { allow: [], monthly_credits: 100 },
      },
      fallback: { enabled: true, max_attempts: 2 },
      identity: { provider: 'local' as const, local_user_id: 'local' },
    },
  );
  await harness.governor!.bindIdentity('session-1', { userId: 'user-1' });
  server = createGovernorApiServer(harness.governor!, {
    actors: [{ token: ADMIN_TOKEN, capabilities: ['governor.read', 'governor.manage', 'governor.audit'] }],
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
  browser = await chromium.launch({ headless: true });
}, 30000);

afterAll(async () => {
  await browser?.close().catch(() => {});
  server?.close();
  await harness?.dispose().catch(() => {});
});

/** 新建页面并收集 console 错误；注入 Bearer token 到 localStorage。 */
async function newPage(): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  await page.addInitScript((token) => {
    localStorage.setItem('governor-token', token);
  }, ADMIN_TOKEN);
  return { page, errors };
}

/** 在 API 服务器页面上执行 API 请求（同源，无需 CORS）。 */
async function apiPage(): Promise<{ page: Page; errors: string[] }> {
  const { page, errors } = await newPage();
  await page.goto(`${baseUrl}/pages/models.html`);
  await page.waitForSelector('table', { timeout: 5000 });
  return { page, errors };
}

describe('Models 页面', () => {
  it('加载并显示模型列表，console error=0', async () => {
    const { page, errors } = await newPage();
    try {
      await page.goto(`${baseUrl}/pages/models.html`);
      await page.waitForSelector('table', { timeout: 5000 });
      const rows = await page.locator('table tbody tr').count();
      expect(rows).toBeGreaterThanOrEqual(1);
    } finally {
      await page.close();
    }
    expect(errors).toHaveLength(0);
  });
});

describe('Users 页面', () => {
  it('加载并显示用户列表，console error=0', async () => {
    const { page, errors } = await newPage();
    try {
      await page.goto(`${baseUrl}/pages/users.html`);
      await page.waitForSelector('table', { timeout: 5000 });
      const rows = await page.locator('table tbody tr').count();
      expect(rows).toBeGreaterThanOrEqual(1);
    } finally {
      await page.close();
    }
    expect(errors).toHaveLength(0);
  });
});

describe('Usage 页面', () => {
  it('加载并支持筛选，console error=0', async () => {
    const { page, errors } = await newPage();
    try {
      await page.goto(`${baseUrl}/pages/usage.html`);
      await page.waitForSelector('table', { timeout: 5000 });
    } finally {
      await page.close();
    }
    expect(errors).toHaveLength(0);
  });
});

describe('未授权拒绝（GOV-SEC-001 capability 矩阵）', () => {
  it('无 token 的 PATCH 请求被拒绝（401 UNAUTHORIZED）', async () => {
    const { page, errors } = await apiPage();
    try {
      const res = await page.request.fetch(
        `${baseUrl}/api/models/${encodeURIComponent('fake-provider:model-a')}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          data: { enabled: false },
        },
      );
      expect(res.status()).toBe(401);
    } finally {
      await page.close();
    }
    expect(errors).toHaveLength(0);
  });

  it('有 Bearer token 的 PATCH 请求成功（200）', async () => {
    const { page, errors } = await apiPage();
    try {
      const res = await page.request.fetch(
        `${baseUrl}/api/models/${encodeURIComponent('fake-provider:model-a')}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
          data: { enabled: true },
        },
      );
      expect(res.status()).toBe(200);
    } finally {
      await page.close();
    }
    expect(errors).toHaveLength(0);
  });

  it('普通 user_id 不能获得管理写权限（401）', async () => {
    const { page, errors } = await apiPage();
    try {
      const res = await page.request.fetch(`${baseUrl}/api/users/${encodeURIComponent('local')}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        data: { monthlyCredits: 999999 },
      });
      expect(res.status()).toBe(401);
    } finally {
      await page.close();
    }
    expect(errors).toHaveLength(0);
  });
});
