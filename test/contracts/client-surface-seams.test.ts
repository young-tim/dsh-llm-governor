/**
 * DSH rc.8 client 侧接缝合同。
 *
 * 除发布物取证外，本文件使用 rc.8 真实 ClientModuleRegistry 扫描
 * Governor 的 `dsh.client` 声明、解析 `./client` 导出并物化 bundle 工厂，
 * 防止再把公开第三方客户端通道误判为 SEAM-5 阻断。
 * - 单占位 model selector：`conversation.input.model` 槽位在 SlotMap 中声明
 *   `kind: 'single'`（scope 'session'），官方 occupant 由
 *   dsh-client-ui-model-selection 唯一贡献；声明即占用（declaring is claiming）。
 * - 方法级 Remote capability：`@Remote()`/`bindTypertRemote`/`remoteMethods`
 *   存在，但 `RemoteMethodMarker` 只有 method/exportName/invocation 三个字段，
 *   没有 capability/permission 声明面——SEAM-3 缺失的运行时与发布物证据。
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { bindTypertRemote, remoteMethods } from '@deepseek-ai/dsh-typert-protocol';
import { ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules';
import { Context, Service } from '@deepseek-ai/cordis';
import * as React from 'react';
import * as CordisRuntime from '@deepseek-ai/cordis';
import * as SlotRuntime from '@deepseek-ai/dsh-client-ui-slots';
import {
  governorDecisionViewDefinition,
  governorTrajectoryDefinition,
} from '../../src/plugin/client-registration.js';

const require = createRequire(import.meta.url);

/** 解析已安装 @deepseek-ai 包的物理根目录。 */
function pkgRoot(name: string): string {
  return dirname(require.resolve(`${name}/package.json`));
}

/** 读取包内文件的文本。 */
function pkgFile(name: string, relative: string): string {
  return readFileSync(join(pkgRoot(name), relative), 'utf8');
}

describe('rc.8 Trajectory definition seam（发布物取证）', () => {
  it('dsh-client-runtime 的 client 契约声明 conversationEvents/conversationViews 注册表', () => {
    const dts = pkgFile('@deepseek-ai/dsh-client-runtime', 'lib/types/client/index.d.ts');
    expect(dts).toContain(
      "conversationEvents: import('./conversation/event-registry.ts').ConversationEventRegistry",
    );
    expect(dts).toContain(
      "conversationViews: import('./conversation/view-registry.ts').ConversationViewRegistry",
    );
    // 注册表 API：register(definition)（唯一命名 + 幂等 disposer）与 registerFallback。
    const registry = pkgFile(
      '@deepseek-ai/dsh-client-runtime',
      'lib/types/client/conversation/event-registry.d.ts',
    );
    expect(registry).toContain('register(definition: ConversationNodeDefinition): () => void');
    expect(registry).toContain(
      'registerFallback(definition: ConversationNodeDefinition): () => void',
    );
  });

  it('ConversationNodeDefinition 契约以 match(event) 匹配 SessionEvent（Governor 轨迹卡片的挂载面）', () => {
    const contract = pkgFile(
      '@deepseek-ai/dsh-client-runtime',
      'lib/types/client/contract/conversation.d.ts',
    );
    expect(contract).toContain('match(event: SessionEvent): ConversationMatchResult | null');
    expect(contract).toContain(
      'start(context: ConversationNodeContext<State>, match: ConversationMatch',
    );
    expect(contract).toContain('buildViewNode?');
    // 视图构建注册表：按 target 注册 per-session builder。
    const view = pkgFile(
      '@deepseek-ai/dsh-client-runtime',
      'lib/types/client/conversation/view-registry.d.ts',
    );
    expect(view).toContain('register(definition: ConversationViewDefinition): () => void');
  });

  it('client 入口使用 rc.8 window.__ModuleLoader__ bundle 协议', () => {
    const clientJs = pkgFile('@deepseek-ai/dsh-client-runtime', 'lib/client.js');
    expect(clientJs.startsWith('window.__ModuleLoader__.load(')).toBe(true);
  });

  it('rc.8 真实 ConversationNodeAssembler 可 flush request/context 载体与损坏旧事件', () => {
    const source = pkgFile('@deepseek-ai/dsh-client-runtime', 'lib/client.js');
    let registration:
      { id: string; factory: (require: (specifier: string) => unknown) => unknown } | undefined;
    runInNewContext(source, {
      window: {
        __ModuleLoader__: { load: (value: typeof registration) => (registration = value) },
      },
      queueMicrotask,
      setTimeout,
      clearTimeout,
      AbortController,
      URL,
      TextEncoder,
      TextDecoder,
      structuredClone,
      console,
    });
    const runtime = registration!.factory((specifier) => {
      if (specifier === '@deepseek-ai/cordis') return CordisRuntime;
      if (specifier === '@deepseek-ai/dsh-client-ui-slots') return SlotRuntime;
      throw new Error(`unexpected runtime external: ${specifier}`);
    }) as {
      ConversationNodeAssembler: new (
        events: { entries(): readonly unknown[]; fallbackEntry(): undefined },
        views: { entries(): readonly unknown[] },
      ) => {
        replaceWindow(entries: readonly unknown[], hasMore: boolean): unknown;
        flush(): boolean;
        snapshot(target: string): unknown;
      };
    };
    const assembler = new runtime.ConversationNodeAssembler(
      { entries: () => [governorTrajectoryDefinition], fallbackEntry: () => undefined },
      { entries: () => [governorDecisionViewDefinition] },
    );
    const decision = {
      schemaVersion: 1,
      decisionId: 'req-assembler:0',
      requestId: 'req-assembler',
      turn: 2,
      step: 1,
      fallbackIndex: 0,
      selectionMode: 'auto',
      effectiveStrategy: 'quality_first',
      outcome: 'selected',
      selectedRoute: 'p:a',
      candidates: [{ routeId: 'p:a', quality: 90, multiplierPpm: 1_000_000 }],
    };
    assembler.replaceWindow(
      [
        {
          event: {
            type: 'request/context',
            seq: 42,
            data: { provider: 'p', model: 'a', governorDecision: decision },
          },
        },
        {
          event: {
            type: 'governor/routing-decision',
            seq: 43,
            data: { schemaVersion: 1, requestId: 'damaged' },
          },
        },
        {
          event: {
            type: 'request/context',
            seq: 44,
            data: {
              provider: 'p',
              model: 'a',
              governorDecision: {
                ...decision,
                decisionId: 'req-assembler:1',
                fallbackIndex: 1,
                outcome: 'rejected',
                selectedRoute: undefined,
                candidates: [],
                errorCode: 'NO_MODEL_MATCHED',
              },
            },
          },
        },
      ],
      false,
    );
    expect(assembler.flush()).toBe(true);
    const snapshot = assembler.snapshot('governor-decision') as {
      nodes: Array<{ key: string; id: string; data: unknown }>;
    };
    expect(snapshot.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: '25:governor-routing-decisionreq-assembler:0',
          id: 'req-assembler:0',
        }),
        expect.objectContaining({
          key: '25:governor-routing-decisionseq-43',
          id: 'seq-43',
        }),
        expect.objectContaining({
          key: '25:governor-routing-decisionreq-assembler:1',
          id: 'req-assembler:1',
          data: expect.objectContaining({
            summary: expect.objectContaining({ outcome: 'rejected' }),
          }),
        }),
      ]),
    );
  });

  it('ClientModuleRegistry 扫描 Governor + 3 个官方客户端，并物化真实 bundle', async () => {
    const governorRoot = pkgRoot('dsh-llm-governor');
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'governor-client-scan-'));
    const fixtureModules = join(fixtureRoot, 'node_modules');
    const fixturePackage = join(fixtureModules, 'dsh-llm-governor');
    mkdirSync(join(fixturePackage, 'dist'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'test'), { recursive: true });
    writeFileSync(
      join(fixturePackage, 'package.json'),
      readFileSync(join(governorRoot, 'package.json')),
    );
    symlinkSync(
      join(governorRoot, 'node_modules', '@deepseek-ai'),
      join(fixtureModules, '@deepseek-ai'),
    );
    const fixtureClient = join(fixturePackage, 'dist', 'client.js');
    execFileSync(process.execPath, ['scripts/build-client.mjs'], {
      cwd: governorRoot,
      env: { ...process.env, DSH_GOVERNOR_CLIENT_OUTFILE: fixtureClient },
      stdio: 'pipe',
    });

    const liveNames = [
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-model-selection',
      'dsh-llm-governor',
    ];
    const loader = {
      entries: () =>
        liveNames.map((name) => ({
          options: { name },
          fiber: {},
          disabled: false,
        })),
    };
    const routes: Array<{ kind: string; path: string; handler: unknown }> = [];
    const webServer = {
      register: (route: { kind: string; path: string; handler: unknown }) => {
        routes.push(route);
        return () => {};
      },
      tapIndex: () => () => {},
    };
    const root = new Context().extend({ baseUrl: join(fixtureRoot, 'test', 'scan.js') });
    root.provide('loader', loader);
    root.provide('webServer', webServer);
    const fiber = root.plugin(ClientModuleRegistry);
    await fiber;
    try {
      const registry = root.get('clientModules') as ClientModuleRegistry;
      const graph = registry.graph();
      expect(graph.entries.map((entry) => entry.id)).toEqual(expect.arrayContaining(liveNames));
      const governor = graph.entries.find((entry) => entry.id === 'dsh-llm-governor');
      expect(governor).toMatchObject({
        id: 'dsh-llm-governor',
        inject: expect.arrayContaining([
          '@deepseek-ai/dsh-client-ui-conversation',
          '@deepseek-ai/dsh-client-ui-model-selection',
          '@deepseek-ai/dsh-client-ui-settings',
        ]),
      });
      expect(registry.clientPath('dsh-llm-governor')).toBe(realpathSync(fixtureClient));
      expect(routes).toHaveLength(1);

      const source = readFileSync(registry.clientPath('dsh-llm-governor')!, 'utf8');
      let registration:
        { id: string; factory: (require: (specifier: string) => unknown) => unknown } | undefined;
      runInNewContext(source, {
        window: {
          __ModuleLoader__: {
            load: (value: typeof registration) => {
              registration = value;
            },
          },
        },
      });
      expect(registration?.id).toBe('dsh-llm-governor');
      const exports = registration!.factory((specifier) => {
        if (specifier === 'react') return React;
        throw new Error(`unexpected client external: ${specifier}`);
      }) as Record<string, unknown>;
      expect(exports['inject']).toEqual(
        expect.arrayContaining(['conversationEvents', 'conversationViews', 'slots', 'remote']),
      );
      // Governor owns this namespace and mounts it during apply; making it a
      // static dependency would deadlock activation.
      expect(exports['inject']).not.toContain('remote.governor');
      expect(exports['apply']).toEqual(expect.any(Function));
    } finally {
      await fiber.dispose();
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

describe('rc.8 单占位 model selector seam（发布物取证）', () => {
  it('conversation.input.model 槽位声明 kind single / scope session（唯一占位）', () => {
    const slots = pkgFile(
      '@deepseek-ai/dsh-client-ui-conversation',
      'lib/types/client/contract/slots.d.ts',
    );
    const match = slots.match(
      /'conversation\.input\.model':\s*\{[\s\S]*?kind: 'single';[\s\S]*?scope: 'session';/,
    );
    expect(match).not.toBeNull();
  });

  it('官方 occupant 由 dsh-client-ui-model-selection 唯一贡献（this package only contributes the single occupant）', () => {
    const occupant = pkgFile(
      '@deepseek-ai/dsh-client-ui-model-selection',
      'lib/types/client/slots.d.ts',
    );
    expect(occupant).toContain('only contributes the single occupant');
    // occupant 的注入面提供 select()（持久模型选择走 Host）与 directory（共享目录）。
    expect(occupant).toContain('select: (selection: ModelSelection) => Promise<boolean>');
    expect(occupant).toContain('directory: SnapshotStore<ModelDirectoryState>');
  });

  it('SlotMap 采用 declaration merging（插件声明即占用），children 表声明槽位契约', () => {
    const slots = pkgFile(
      '@deepseek-ai/dsh-client-ui-conversation',
      'lib/types/client/contract/slots.d.ts',
    );
    expect(slots).toContain('interface SlotMap');
    // 单占位语义在类型文档中固定为「一个 occupant 占据整席」。
    expect(slots).toMatch(
      /one occupant, so taking it means rendering the\s+\*\s*whole model affordance yourself/,
    );
  });
});

describe('rc.8 方法级 Remote capability seam（含 SEAM-3 缺失证据）', () => {
  it('RemoteMethodMarker 契约只有 method/exportName/invocation，无 capability/permission 字段', () => {
    const dts = pkgFile('@deepseek-ai/dsh-typert-protocol', 'lib/types/index.d.ts');
    const marker = dts.match(/export interface RemoteMethodMarker \{[\s\S]*?\}/);
    expect(marker).not.toBeNull();
    expect(marker![0]).not.toContain('capability');
    expect(marker![0]).not.toContain('permission');
    // invocation 只声明调用模式（direct/context scoped），不含权限。
    expect(dts).toContain("readonly kind: 'direct';");
    expect(dts).toContain("readonly kind: 'context';");
  });

  it('bindTypertRemote 返回的 binding 只有 service/serviceKey/namespace，且被冻结', async () => {
    const ctx = new Context();
    const marker: string[] = [];
    class ProbeService extends Service {
      constructor(ctx: Context) {
        super(ctx, 'seamProbe');
        marker.push('ctor');
      }
      async method(): Promise<void> {}
    }
    const fiber = ctx.plugin(ProbeService);
    await fiber;
    const svc = (ctx as unknown as Record<string, ProbeService>)['seamProbe'];
    expect(marker).toEqual(['ctor']);
    const binding = bindTypertRemote(svc, 'seamProbe', { namespace: 'governor' });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.keys(binding).sort()).toEqual(['namespace', 'service', 'serviceKey']);
    // binding 无权限语义：Host 无法从 binding 声明方法级 capability。
    expect('capability' in binding).toBe(false);
    await fiber.dispose();
  });

  it('remoteMethods 仅暴露装饰器初始化的标记；无装饰器注册路径时方法不可被发现', async () => {
    const ctx = new Context();
    class ProbeService extends Service {
      constructor(ctx: Context) {
        super(ctx, 'seamProbe2');
      }
      async listModels(): Promise<unknown[]> {
        return [];
      }
    }
    const fiber = ctx.plugin(ProbeService);
    await fiber;
    const svc = (ctx as unknown as Record<string, ProbeService>)['seamProbe2'];
    // @Remote() 装饰器是唯一的 marker 写入通道（WeakMap + addInitializer）。
    // vitest/oxc 管道不转换 TC39 装饰器语法（SEAM-4 测试环境限制），因此运行时
    // 合同测试只能以无装饰器服务证明「无标记即不可见」的机制存在。
    expect(remoteMethods(svc)).toEqual([]);
    await fiber.dispose();
  });

  it('typert-protocol 的导出面没有 capability 声明/校验 API（运行时复现）', async () => {
    const mod = (await import('@deepseek-ai/dsh-typert-protocol')) as Record<string, unknown>;
    const exports = Object.keys(mod);
    // capability 相关注册/检查/声明面完全缺失。
    expect(exports.filter((k) => /capabilit|permission|authoriz/i.test(k))).toEqual([]);
    // 现有 API 面仅覆盖绑定与标记读取。
    for (const k of [
      'bindTypertRemote',
      'remoteMethods',
      'Remote',
      'RemoteScope',
      'TypertRemoteService',
    ]) {
      expect(exports).toContain(k);
    }
  });
});
