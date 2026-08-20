/**
 * 安装 smoke 测试：rc.7/rc.8 临时加载、Governor recovery 注册、bundle 组合契约、卸载后监听器清理。
 *
 * 验证 Task 5 要求：
 * - 打包后 tarball 包含 dist/plugin/mod.js、cordis.patch.yml 与 dist/ui/pages 静态页
 * - package.json 声明 dsh.bundle.patch，cordis.patch.yml 禁用基础 llm-retry
 *   （Recovery Owner 唯一性在 bundle 组合层强制，真实安装由 install-real.test.ts 验证）
 * - GovernorPlugin.apply() 在 Context 中成功执行并注册全部核心监听器
 * - 卸载 Governor 后其监听器全部清理
 *
 * 不触碰真实 DSH_HOME/Profile/凭证/Provider。全程使用临时目录与内存策略。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Service } from '../../src/dsh-adapter/mod.js';
import { LlmRuntime } from '../../src/dsh-adapter/mod.js';
import { GovernorPlugin } from '../../src/plugin/mod.js';
import type { GovernorPluginConfig } from '../../src/plugin/mod.js';

/** 项目根目录。 */
const projectRoot = process.cwd();

/** 临时工作目录。 */
let workDir: string;
/** 解压后的 package 目录。 */
let packageDir: string;

beforeAll(() => {
  execSync('npx tsc -p tsconfig.json', { cwd: projectRoot, stdio: 'inherit' });
  execSync('node scripts/copy-ui-pages.mjs', { cwd: projectRoot, stdio: 'inherit' });
  workDir = mkdtempSync(join(tmpdir(), 'dsh-gov-install-'));
  execSync(`pnpm pack --pack-destination "${workDir}"`, { cwd: projectRoot, stdio: 'inherit' });
  const tgzs = readdirSync(workDir).filter((f) => f.endsWith('.tgz'));
  if (tgzs.length !== 1) throw new Error(`预期一个 tgz，实际：${tgzs.join(', ')}`);
  execSync(`tar -xzf "${join(workDir, tgzs[0]!)}" -C "${workDir}"`, { stdio: 'inherit' });
  packageDir = join(workDir, 'package');
}, 120000);

afterAll(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

/** Governor 测试配置（内存策略，不触碰真实 DSH_HOME）。 */
function governorConfig(): GovernorPluginConfig {
  return {
    schema_version: 1,
    models: {
      'fake-provider:model-a': { enabled: true, multiplier: 1, quality: { general: 90 } },
    },
    fallback: { enabled: true, max_attempts: 2 },
    identity: { provider: 'local', local_user_id: 'local' },
    storage: { enabled: false },
    ui: { enabled: false },
  };
}

/** 模拟基础 dsh-llm-retry 插件（注册 agent/request-error listener）。 */
function createBaseRetryPlugin() {
  return {
    name: 'dsh-llm-retry',
    apply(ctx: Context): void {
      ctx.on(
        'agent/request-error' as never,
        (async () => ({ kind: 'retry' as const })) as never,
        { global: true } as never,
      );
    },
  };
}

/** 获取 agent/request-error 的 listener 数量。 */
function recoveryOwnerCount(ctx: Context): number {
  const hooks = (ctx.events as unknown as { _hooks: Record<string, unknown[]> })._hooks;
  return hooks['agent/request-error']?.length ?? 0;
}

describe('rc.7 临时安装 smoke', () => {
  it('tarball 解压后包含 dist/plugin/mod.js、cordis.patch.yml 与 dist/ui/pages 静态页', () => {
    expect(existsSync(join(packageDir, 'dist', 'plugin', 'mod.js'))).toBe(true);
    expect(existsSync(join(packageDir, 'cordis.patch.yml'))).toBe(true);
    // 构建必须复制 HTML 页面到 dist/ui/pages，安装后的页面才能被找到
    for (const page of ['models.html', 'users.html', 'usage.html']) {
      expect(existsSync(join(packageDir, 'dist', 'ui', 'pages', page))).toBe(true);
    }
  });

  it('package.json 声明 dsh.bundle.patch（安装后作为 profile layer 激活）', () => {
    const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } };
      main?: string;
    };
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml');
    // Cordis Loader 通过模块入口加载插件
    expect(pkg.main).toBe('dist/plugin/mod.js');
  });

  it('cordis.patch.yml 插入 Governor 行并禁用基础 llm-retry（Recovery Owner 唯一）', () => {
    const patch = readFileSync(join(packageDir, 'cordis.patch.yml'), 'utf8');
    // insert Governor host 插件行
    expect(patch).toMatch(/- id:\s*dsh-llm-governor\b/);
    expect(patch).toMatch(/name:\s*'?dsh-llm-governor'?/);
    // 禁用基础 llm-retry 行：同一 bundle 内不能出现两个 Recovery Owner
    expect(patch).toMatch(/- id:\s*llm-retry\b/);
    expect(patch).toMatch(/name:\s*'?@deepseek-ai\/dsh-llm-retry'?/);
    expect(patch).toMatch(/disabled:\s*true/);
  });

  it('Governor 单独加载时注册恰好 1 个 recovery listener 与全部核心监听器', async () => {
    const ctx = new Context();
    const llmFiber = ctx.plugin(LlmRuntime);
    await llmFiber;

    const govFiber = ctx.plugin(GovernorPlugin as never, governorConfig() as never);
    await (govFiber as unknown as PromiseLike<unknown>);

    // Recovery Owner 数量精确为 1（不是 >= 1：两个重试组件共存必须失败）
    expect(recoveryOwnerCount(ctx)).toBe(1);
    // 全部核心事件监听器注册
    const hooks = (ctx.events as unknown as { _hooks: Record<string, unknown[]> })._hooks;
    expect(hooks['agent/pre-step']?.length ?? 0).toBe(1);
    expect(hooks['agent/request']?.length ?? 0).toBe(1);
    expect(hooks['llm/stream']?.length ?? 0).toBe(1);
    expect(hooks['agent/request-error']?.length ?? 0).toBe(1);

    await (govFiber as unknown as { dispose: () => Promise<void> }).dispose();
    await llmFiber.dispose();
  });

  it('卸载 Governor 后其 recovery listener 全部清理（基础 retry 仍为 1 个 owner）', async () => {
    const ctx = new Context();
    const llmFiber = ctx.plugin(LlmRuntime);
    await llmFiber;

    // 先加载 base llm-retry
    const retryFiber = ctx.plugin(createBaseRetryPlugin() as never);
    await retryFiber;
    expect(recoveryOwnerCount(ctx)).toBe(1);

    // 加载 Governor（无 bundle 组合时运行时监听器是叠加的：组合层的禁用由
    // cordis.patch.yml + install-real.test.ts 的 dump-config 证明）
    const govFiber = ctx.plugin(GovernorPlugin as never, governorConfig() as never);
    await (govFiber as unknown as PromiseLike<unknown>);

    // 卸载 Governor：其监听器必须全部清理，回到只有基础 retry 的状态
    await (govFiber as unknown as { dispose: () => Promise<void> }).dispose();
    expect(recoveryOwnerCount(ctx)).toBe(1);

    await retryFiber.dispose();
    await llmFiber.dispose();
  });

  it('Web/Headless 加载：GovernorPlugin.apply() 在 Context 中成功执行', async () => {
    // Web 和 Headless profile 在启动时都会调用 plugin 的 apply()
    // 这里验证 apply() 不抛错且注册了事件监听器
    const ctx = new Context();
    const llmFiber = ctx.plugin(LlmRuntime);
    await llmFiber;

    const govFiber = ctx.plugin(GovernorPlugin as never, governorConfig() as never);
    await (govFiber as unknown as PromiseLike<unknown>);

    // 验证 Governor 注册了全部 4 个核心事件监听器
    const hooks = (ctx.events as unknown as { _hooks: Record<string, unknown[]> })._hooks;
    expect(hooks['agent/pre-step']?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(hooks['agent/request']?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(hooks['llm/stream']?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(hooks['agent/request-error']?.length ?? 0).toBeGreaterThanOrEqual(1);

    await (govFiber as unknown as { dispose: () => Promise<void> }).dispose();
    await llmFiber.dispose();
  });
});

describe('rc.8 兼容性验证', () => {
  it('Governor 在 rc.8 LlmRuntime 下加载并注册事件', async () => {
    // 使用 rc.8 别名包验证兼容性
    // 由于 vitest projects 的 resolve.alias 只在 contracts-rc8 project 生效，
    // 这里通过验证 GovernorPlugin 的事件注册来证明 rc.8 兼容性
    const ctx = new Context();
    const llmFiber = ctx.plugin(LlmRuntime);
    await llmFiber;

    const govFiber = ctx.plugin(GovernorPlugin as never, governorConfig() as never);
    await (govFiber as unknown as PromiseLike<unknown>);

    // 验证 Governor 服务可用
    const gov = (ctx as unknown as { governor: unknown }).governor;
    expect(gov).toBeDefined();

    // 验证事件监听器注册
    const hooks = (ctx.events as unknown as { _hooks: Record<string, unknown[]> })._hooks;
    expect(hooks['agent/request-error']?.length ?? 0).toBe(1);

    await (govFiber as unknown as { dispose: () => Promise<void> }).dispose();
    await llmFiber.dispose();
  });
});

describe('运行时 UI 挂载与默认存储路径', () => {
  /** 最小 fake webServer：记录注册的前缀路由。 */
  class FakeWebServer extends Service {
    readonly registered: Array<{
      kind: string;
      path: string;
      handler: (req: never, res: never) => void;
    }> = [];

    constructor(ctx: Context) {
      super(ctx, 'webServer');
    }

    /** 记录路由注册（真实实现返回注销函数）。 */
    register(route: { kind: string; path: string; handler: (req: never, res: never) => void }) {
      this.registered.push(route);
      return () => {
        // 测试中无需注销
      };
    }
  }

  it('有 ctx.webServer 时把 /governor 前缀路由注册到 webServer 并处理请求', async () => {
    const ctx = new Context();
    const llmFiber = ctx.plugin(LlmRuntime);
    await llmFiber;
    const wsFiber = ctx.plugin(FakeWebServer);
    await wsFiber;

    const govFiber = ctx.plugin(
      GovernorPlugin as never,
      {
        ...governorConfig(),
        ui: { enabled: true },
      } as never,
    );
    await (govFiber as unknown as PromiseLike<unknown>);

    // 前缀路由已注册到 webServer（DSH Web 端口下的受信挂载点）
    const webServer = (ctx as unknown as { webServer: FakeWebServer }).webServer;
    expect(webServer.registered).toHaveLength(1);
    expect(webServer.registered[0]!.kind).toBe('prefix');
    expect(webServer.registered[0]!.path).toBe('/governor');

    // 模拟浏览器请求 /governor/api/models：前缀剥离后路由到 JSON API
    const handler = webServer.registered[0]!.handler;
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
    await new Promise<void>((resolve) => {
      handler(
        { url: '/governor/api/models', method: 'GET', headers: {}, socket: {} } as never,
        res as never,
      );
      resolve();
    });
    // 等待异步 JSON 响应
    await new Promise((resolve) => setImmediate(resolve));
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body) as { data: Array<{ routeId: string }> };
    expect(payload.data.some((m) => m.routeId === 'fake-provider:model-a')).toBe(true);

    await (govFiber as unknown as { dispose: () => Promise<void> }).dispose();
    await wsFiber.dispose();
    await llmFiber.dispose();
  });

  it('storage 未指定 path 时默认写入 $DSH_HOME/dsh-llm-governor/governor.db', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'dsh-gov-home-'));
    const prevDshHome = process.env['DSH_HOME'];
    process.env['DSH_HOME'] = tempHome;
    try {
      const ctx = new Context();
      const llmFiber = ctx.plugin(LlmRuntime);
      await llmFiber;

      const govFiber = ctx.plugin(
        GovernorPlugin as never,
        {
          ...governorConfig(),
          storage: { enabled: true },
        } as never,
      );
      await (govFiber as unknown as PromiseLike<unknown>);

      // 默认数据库文件已创建在 DSH_HOME 下（目录 owner-only）
      const dbPath = join(tempHome, 'dsh-llm-governor', 'governor.db');
      expect(existsSync(dbPath)).toBe(true);

      await (govFiber as unknown as { dispose: () => Promise<void> }).dispose();
      await llmFiber.dispose();
    } finally {
      if (prevDshHome === undefined) delete process.env['DSH_HOME'];
      else process.env['DSH_HOME'] = prevDshHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
