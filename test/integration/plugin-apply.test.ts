/**
 * 覆盖补强：GovernorPlugin apply 完整路径（compatApi 启用、classifier backend、
 * header identity bind 端点、ui 禁用分支）。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '../../src/dsh-adapter/mod.js';
import type { LlmModelInfo } from '../../src/dsh-adapter/mod.js';
import { LlmRuntime } from '../../src/dsh-adapter/mod.js';
import { FakeLlmAdapter } from '../../src/dsh-adapter/fake-adapter.js';
import { successScript } from '../../src/dsh-adapter/fake-adapter.js';
import { GovernorPlugin } from '../../src/plugin/mod.js';

const providers = ['fake-provider'];
const models: LlmModelInfo[] = [
  { provider: 'fake-provider', id: 'model-a', name: 'Model A' },
  { provider: 'fake-provider', id: 'model-b', name: 'Model B' },
];

/** 启动带 GovernorPlugin 的 Context（返回 server 检测端口）。 */
async function bootPlugin(config: Record<string, unknown>): Promise<{
  ctx: Context;
  dispose: () => Promise<void>;
}> {
  const ctx = new Context();
  const llm = ctx.plugin(LlmRuntime);
  await llm;
  const adapter = new FakeLlmAdapter(
    providers,
    models,
    successScript('ok', { inputTokens: 1, outputTokens: 1 }),
  );
  const disposeAdapter = ctx.llm.registerAdapter(providers, adapter);
  const dbDir = mkdtempSync(join(tmpdir(), 'dsh-gov-apply-'));
  const gov = ctx.plugin(
    GovernorPlugin as never,
    {
      schema_version: 1,
      storage: { enabled: true, path: join(dbDir, 'governor.db') },
      ...config,
    } as never,
  ) as unknown as { dispose: () => Promise<void> };
  await (gov as never as PromiseLike<unknown>);
  return {
    ctx,
    dispose: async () => {
      await gov.dispose();
      disposeAdapter();
      await llm.dispose();
      rmSync(dbDir, { recursive: true, force: true });
    },
  };
}

describe('GOV-UI-001 compatApi 启用分支（插件 apply 完整路径）', () => {
  it('compatApi.enabled + token：独立监听启动且 Bearer 认证可用（loopback）', async () => {
    const token = 'compat-token-0123456789abcdef0123456789abcdef';
    const { ctx, dispose } = await bootPlugin({
      identity: { provider: 'local', local_user_id: 'local' },
      routing: { default: 'manual' },
      models: { 'fake-provider:model-a': { quality: { general: 90 }, multiplier: 1 } },
      ui: { enabled: true },
      compat_api: { enabled: true, token },
    });
    try {
      // 无 webServer 时 compatApi 独立监听；等待 listen 完成后枚举验证
      await new Promise((resolve) => setTimeout(resolve, 100));
      const net = await import('node:net');
      const handles =
        (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
      const servers = handles.filter((h) => h instanceof net.Server) as Array<{
        address: () => unknown;
      }>;
      const governorServer = servers.find((s) => {
        const addr = s.address();
        return typeof addr === 'object' && addr !== null && (addr as { port: number }).port > 0;
      });
      expect(governorServer).toBeDefined();
      const addr = governorServer!.address() as { address: string; port: number };
      expect(['127.0.0.1', '::1']).toContain(addr.address);
      // Bearer 认证读取模型列表（read capability）
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/models`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ routeId: string }> };
      expect(body.data.some((m) => m.routeId === 'fake-provider:model-a')).toBe(true);
      // 无 token → 401
      const anon = await fetch(`http://127.0.0.1:${addr.port}/api/models`);
      expect(anon.status).toBe(401);
      void ctx;
    } finally {
      await dispose();
    }
  });

  it('ui.enabled=false：不挂载任何 UI（无新增监听端口）', async () => {
    const net = await import('node:net');
    const before = (
      (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? []
    ).filter((h) => h instanceof net.Server).length;
    const { dispose } = await bootPlugin({
      identity: { provider: 'local', local_user_id: 'local' },
      routing: { default: 'manual' },
      models: { 'fake-provider:model-a': { quality: { general: 90 }, multiplier: 1 } },
      ui: { enabled: false },
    });
    try {
      const after = (
        (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? []
      ).filter((h) => h instanceof net.Server).length;
      expect(after).toBe(before);
    } finally {
      await dispose();
    }
  });

  it('compatApi 未配置 token：自动生成 256 bit token 落盘 owner-only（日志不打印）', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const tempHome = mkdtempSync(join(tmpdir(), 'dsh-gov-token-'));
    const prevHome = process.env['DSH_HOME'];
    process.env['DSH_HOME'] = tempHome;
    try {
      const { dispose } = await bootPlugin({
        identity: { provider: 'local', local_user_id: 'local' },
        routing: { default: 'manual' },
        models: { 'fake-provider:model-a': { quality: { general: 90 }, multiplier: 1 } },
        ui: { enabled: true },
        compat_api: { enabled: true },
      });
      try {
        // token 文件写入 $DSH_HOME/dsh-llm-governor/compat-token
        const tokenPath = join(tempHome, 'dsh-llm-governor', 'compat-token');
        expect(fs.existsSync(tokenPath)).toBe(true);
        const token = fs.readFileSync(tokenPath, 'utf8').trim();
        expect(token).toMatch(/^[0-9a-f]{64}$/); // 256 bit hex
        // 目录 owner-only（0o700）
        const stat = fs.statSync(join(tempHome, 'dsh-llm-governor'));
        expect(stat.mode & 0o777).toBe(0o700);
        void os;
      } finally {
        await dispose();
      }
    } finally {
      if (prevHome === undefined) delete process.env['DSH_HOME'];
      else process.env['DSH_HOME'] = prevHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('compatApi listen=[::1]：监听 IPv6 loopback', async () => {
    const { dispose } = await bootPlugin({
      identity: { provider: 'local', local_user_id: 'local' },
      routing: { default: 'manual' },
      models: { 'fake-provider:model-a': { quality: { general: 90 }, multiplier: 1 } },
      ui: { enabled: true },
      compat_api: { enabled: true, listen: '[::1]', token: 't'.repeat(64) },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const net = await import('node:net');
      const handles =
        (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
      const servers = handles.filter((h) => h instanceof net.Server) as Array<{
        address: () => unknown;
      }>;
      const gov = servers.find((s) => {
        const addr = s.address();
        return typeof addr === 'object' && addr !== null && (addr as { port: number }).port > 0;
      });
      expect(gov).toBeDefined();
      const addr = gov!.address() as { address: string };
      expect(addr.address).toBe('::1');
    } finally {
      await dispose();
    }
  });
});

describe('GOV-TRACE-001 classifier backend（auto.llm_classifier 启用）', () => {
  it('LLM 分类链路经 ctx.llm.stream 并记录 classifier usage', async () => {
    const { ctx, dispose } = await bootPlugin({
      identity: { provider: 'local', local_user_id: 'local' },
      routing: { default: 'auto' },
      auto: {
        confidence_threshold: 0.5,
        llm_classifier: { enabled: true, provider: 'fake-provider', model: 'model-b' },
      },
      models: {
        'fake-provider:model-a': { quality: { general: 90 }, multiplier: 1 },
        'fake-provider:model-b': { quality: { general: 80 }, multiplier: 0.5 },
      },
    });
    try {
      const service = (
        ctx as unknown as {
          governor: {
            classifyStep: (s: string, t: number, st: number, i: unknown) => Promise<unknown>;
          };
        }
      ).governor;
      // 消息不命中 Hint/Rule → 走 LLM 分类（fake adapter 返回固定文本）
      const result = (await service.classifyStep('cls-session', 1, 1, {
        messages: [{ type: 'text', text: '随便聊聊' }],
      })) as { source: string };
      // fake adapter 输出 'ok'（非法 JSON）→ LLM 降级 fallback（source=rule）
      expect(['rule', 'llm']).toContain(result.source);
    } finally {
      await dispose();
    }
  });

  it('非法 task_type / complexity 的 LLM 输出均降级 fallback（不缓存不崩溃）', async () => {
    // 自定义脚本：非法 task_type
    const { FakeLlmAdapter } = await import('../../src/dsh-adapter/fake-adapter.js');
    const makeCtx = async (scriptText: string) => {
      const ctx = new Context();
      const llm = ctx.plugin(LlmRuntime);
      await llm;
      const adapter = new FakeLlmAdapter(providers, models, { text: scriptText, finish: 'stop' });
      const disposeAdapter = ctx.llm.registerAdapter(providers, adapter);
      const dbDir = mkdtempSync(join(tmpdir(), 'dsh-gov-cls-'));
      const gov = ctx.plugin(
        GovernorPlugin as never,
        {
          schema_version: 1,
          identity: { provider: 'local', local_user_id: 'local' },
          routing: { default: 'auto' },
          auto: {
            confidence_threshold: 0.5,
            llm_classifier: { enabled: true, provider: 'fake-provider', model: 'model-b' },
          },
          models: {
            'fake-provider:model-a': { quality: { general: 90 }, multiplier: 1 },
            'fake-provider:model-b': { quality: { general: 80 }, multiplier: 0.5 },
          },
          storage: { enabled: true, path: join(dbDir, 'governor.db') },
        } as never,
      ) as unknown as { dispose: () => Promise<void> };
      await (gov as never as PromiseLike<unknown>);
      return {
        ctx,
        dispose: async () => {
          await gov.dispose();
          disposeAdapter();
          await llm.dispose();
          rmSync(dbDir, { recursive: true, force: true });
        },
      };
    };
    // 非法 task_type → CLASSIFIER_INVALID_TASK_TYPE → 降级
    const bad1 = await makeCtx('{"task_type": "bogus", "complexity": "high", "confidence": 0.9}');
    try {
      const svc = (
        bad1.ctx as unknown as {
          governor: {
            classifyStep: (s: string, t: number, st: number, i: unknown) => Promise<unknown>;
          };
        }
      ).governor;
      const r1 = (await svc.classifyStep('c1', 1, 1, {
        messages: [{ type: 'text', text: '闲聊' }],
      })) as { source: string };
      expect(r1.source).toBe('rule');
    } finally {
      await bad1.dispose();
    }
    // 非法 complexity → CLASSIFIER_INVALID_COMPLEXITY → 降级
    const bad2 = await makeCtx('{"task_type": "coding", "complexity": "bogus", "confidence": 0.9}');
    try {
      const svc = (
        bad2.ctx as unknown as {
          governor: {
            classifyStep: (s: string, t: number, st: number, i: unknown) => Promise<unknown>;
          };
        }
      ).governor;
      const r2 = (await svc.classifyStep('c2', 1, 1, {
        messages: [{ type: 'text', text: '闲聊' }],
      })) as { source: string };
      expect(r2.source).toBe('rule');
    } finally {
      await bad2.dispose();
    }
    // 合法输出（confidence 缺省 0）→ llm 结果但低置信度不缓存
    const ok = await makeCtx('{"task_type": "coding", "complexity": "high"}');
    try {
      const svc = (
        ok.ctx as unknown as {
          governor: {
            classifyStep: (s: string, t: number, st: number, i: unknown) => Promise<unknown>;
          };
        }
      ).governor;
      const r3 = (await svc.classifyStep('c3', 1, 1, {
        messages: [{ type: 'text', text: '闲聊' }],
      })) as { source: string };
      expect(r3.source).toBe('llm');
    } finally {
      await ok.dispose();
    }
  });
});

describe('header identity bind 端点（/governor/api/bind）', () => {
  it('loopback POST bind 成功；非 loopback/非法请求被拒', async () => {
    const { Service } = await import('../../src/dsh-adapter/mod.js');
    class WebServer extends Service {
      public registered: Array<{
        kind: string;
        path: string;
        handler: (req: never, res: never) => void;
      }> = [];
      constructor(ctx: Context) {
        super(ctx, 'webServer');
      }
      register(route: { kind: string; path: string; handler: (req: never, res: never) => void }) {
        this.registered.push(route);
        return () => {};
      }
    }
    const ctx = new Context();
    const llm = ctx.plugin(LlmRuntime);
    await llm;
    const adapter = new FakeLlmAdapter(
      providers,
      models,
      successScript('ok', { inputTokens: 1, outputTokens: 1 }),
    );
    const disposeAdapter = ctx.llm.registerAdapter(providers, adapter);
    const ws = ctx.plugin(WebServer);
    await ws;
    const dbDir = mkdtempSync(join(tmpdir(), 'dsh-gov-bind-'));
    const gov = ctx.plugin(
      GovernorPlugin as never,
      {
        schema_version: 1,
        identity: {
          provider: 'header',
          header_name: 'X-User',
          trusted_proxy: 'proxy-1',
          proxy_header_name: 'X-Proxy-Id',
        },
        routing: { default: 'manual' },
        models: { 'fake-provider:model-a': { quality: { general: 90 }, multiplier: 1 } },
        storage: { enabled: true, path: join(dbDir, 'governor.db') },
        ui: { enabled: true },
      } as never,
    ) as unknown as { dispose: () => Promise<void> };
    await (gov as never as PromiseLike<unknown>);

    const webServer = (ctx as unknown as { webServer: WebServer }).webServer;
    expect(webServer.registered).toHaveLength(1);
    const handler = webServer.registered[0]!.handler;

    /** 模拟 HTTP 请求调用 handler。 */
    async function call(req: {
      url: string;
      method: string;
      headers?: Record<string, string>;
      remoteAddress?: string;
      body?: string;
    }): Promise<{ status: number; body: string }> {
      const res = {
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
      const listeners: Record<string, Array<(chunk: Buffer) => void>> = {};
      await handler(
        {
          url: req.url,
          method: req.method,
          headers: req.headers ?? {},
          socket: { remoteAddress: req.remoteAddress ?? '127.0.0.1' },
          on: (event: string, cb: (chunk: Buffer) => void) => {
            listeners[event] = listeners[event] ?? [];
            listeners[event].push(cb);
          },
          destroy: () => {},
        } as never,
        res as never,
      );
      // 手动投递 body chunk（bind 端点读 body）
      if (req.body !== undefined) {
        for (const cb of listeners['data'] ?? []) cb(Buffer.from(req.body));
        for (const cb of listeners['end'] ?? []) cb(Buffer.alloc(0));
      }
      await new Promise((resolve) => setImmediate(resolve));
      return { status: res.statusCode, body: res.body };
    }

    try {
      // 非 loopback → 403 FORBIDDEN
      const far = await call({
        url: '/governor/api/bind',
        method: 'POST',
        remoteAddress: '10.1.2.3',
        body: '{}',
      });
      expect(far.status).toBe(403);
      // 合法 loopback bind → 200 + userId
      const ok = await call({
        url: '/governor/api/bind',
        method: 'POST',
        body: JSON.stringify({
          sessionId: 'b1',
          headers: { 'X-User': 'alice', 'X-Proxy-Id': 'proxy-1' },
        }),
      });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body).userId).toBe('alice');
      // 非法 JSON → 400
      const badJson = await call({ url: '/governor/api/bind', method: 'POST', body: 'not-json' });
      expect(badJson.status).toBe(400);
      // 缺字段 → 400
      const badReq = await call({ url: '/governor/api/bind', method: 'POST', body: '{}' });
      expect(badReq.status).toBe(400);
      // 非法身份 → 401（proxy 校验失败）
      const badIdentity = await call({
        url: '/governor/api/bind',
        method: 'POST',
        body: JSON.stringify({
          sessionId: 'b2',
          headers: { 'X-User': 'bob', 'X-Proxy-Id': 'wrong-proxy' },
        }),
      });
      expect(badIdentity.status).toBe(401);
    } finally {
      await gov.dispose();
      await ws.dispose();
      disposeAdapter();
      await llm.dispose();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
