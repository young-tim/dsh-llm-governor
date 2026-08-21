/**
 * 任务1 合同测试：DSH rc.8 client 侧接缝（六项契约第 4、5、6 项）。
 *
 * 证明/证伪（全部从 node_modules 发布物取证，不修改上游包）：
 * - Trajectory definition：`ctx.conversationEvents` / `ctx.conversationViews`
 *   注册表存在于 dsh-client-runtime 的 client 契约（ConversationNodeDefinition /
 *   ConversationViewDefinition）；但 client 入口是浏览器 bundle
 *   （`window.__ModuleLoader__`），Node 合同测试无法实例化（见
 *   docs/UPSTREAM_SEAMS.md SEAM-5），运行时行为验证需浏览器 E2E。
 * - 单占位 model selector：`conversation.input.model` 槽位在 SlotMap 中声明
 *   `kind: 'single'`（scope 'session'），官方 occupant 由
 *   dsh-client-ui-model-selection 唯一贡献；声明即占用（declaring is claiming）。
 * - 方法级 Remote capability：`@Remote()`/`bindTypertRemote`/`remoteMethods`
 *   存在，但 `RemoteMethodMarker` 只有 method/exportName/invocation 三个字段，
 *   没有 capability/permission 声明面——SEAM-3 缺失的运行时与发布物证据。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { bindTypertRemote, remoteMethods } from '@deepseek-ai/dsh-typert-protocol';
import { Context, Service } from '@deepseek-ai/cordis';

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
    expect(dts).toContain('conversationEvents: import(\'./conversation/event-registry.ts\').ConversationEventRegistry');
    expect(dts).toContain('conversationViews: import(\'./conversation/view-registry.ts\').ConversationViewRegistry');
    // 注册表 API：register(definition)（唯一命名 + 幂等 disposer）与 registerFallback。
    const registry = pkgFile('@deepseek-ai/dsh-client-runtime', 'lib/types/client/conversation/event-registry.d.ts');
    expect(registry).toContain('register(definition: ConversationNodeDefinition): () => void');
    expect(registry).toContain('registerFallback(definition: ConversationNodeDefinition): () => void');
  });

  it('ConversationNodeDefinition 契约以 match(event) 匹配 SessionEvent（Governor 轨迹卡片的挂载面）', () => {
    const contract = pkgFile('@deepseek-ai/dsh-client-runtime', 'lib/types/client/contract/conversation.d.ts');
    expect(contract).toContain('match(event: SessionEvent): ConversationMatchResult | null');
    expect(contract).toContain('start(context: ConversationNodeContext<State>, match: ConversationMatch');
    expect(contract).toContain('buildViewNode?');
    // 视图构建注册表：按 target 注册 per-session builder。
    const view = pkgFile('@deepseek-ai/dsh-client-runtime', 'lib/types/client/conversation/view-registry.d.ts');
    expect(view).toContain('register(definition: ConversationViewDefinition): () => void');
  });

  it('client 入口是浏览器 bundle：window.__ModuleLoader__ 阻止 Node 实例化（SEAM-5 证据）', () => {
    const clientJs = pkgFile('@deepseek-ai/dsh-client-runtime', 'lib/client.js');
    expect(clientJs.startsWith('window.__ModuleLoader__.load(')).toBe(true);
  });
});

describe('rc.8 单占位 model selector seam（发布物取证）', () => {
  it('conversation.input.model 槽位声明 kind single / scope session（唯一占位）', () => {
    const slots = pkgFile('@deepseek-ai/dsh-client-ui-conversation', 'lib/types/client/contract/slots.d.ts');
    const match = slots.match(/'conversation\.input\.model':\s*\{[\s\S]*?kind: 'single';[\s\S]*?scope: 'session';/);
    expect(match).not.toBeNull();
  });

  it('官方 occupant 由 dsh-client-ui-model-selection 唯一贡献（this package only contributes the single occupant）', () => {
    const occupant = pkgFile('@deepseek-ai/dsh-client-ui-model-selection', 'lib/types/client/slots.d.ts');
    expect(occupant).toContain("only contributes the single occupant");
    // occupant 的注入面提供 select()（持久模型选择走 Host）与 directory（共享目录）。
    expect(occupant).toContain('select: (selection: ModelSelection) => Promise<boolean>');
    expect(occupant).toContain('directory: SnapshotStore<ModelDirectoryState>');
  });

  it('SlotMap 采用 declaration merging（插件声明即占用），children 表声明槽位契约', () => {
    const slots = pkgFile('@deepseek-ai/dsh-client-ui-conversation', 'lib/types/client/contract/slots.d.ts');
    expect(slots).toContain('interface SlotMap');
    // 单占位语义在类型文档中固定为「一个 occupant 占据整席」。
    expect(slots).toMatch(/one occupant, so taking it means rendering the\s+\*\s*whole model affordance yourself/);
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
    for (const k of ['bindTypertRemote', 'remoteMethods', 'Remote', 'RemoteScope', 'TypertRemoteService']) {
      expect(exports).toContain(k);
    }
  });
});
