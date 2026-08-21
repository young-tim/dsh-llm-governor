# 上游接缝（Upstream Seams）需求与证据

状态：2026-08-21，基于 `@deepseek-ai/dsh@0.1.0-rc.8`（cordis 4.0.1）发布物实测。

本文记录 Governor 依赖但 rc.8 未提供（或不完整）的公开扩展接缝，附可复现证据。
对应合同测试位于 `test/contracts/`（`pnpm test:contracts` 全绿固化证据）。
按任务书约定：seam 缺失时只提交可复现证据并继续不受影响的部分，不做
node_modules 补丁、虚拟模型、UI overlay 或 DSH 私有 fork。

## SEAM-1 Session Event 的 `ignorable` 写入 API 缺失（P0 阻断项）

**需求**：GOV-TRACE-001 要求插件写入自有非 surface Session Event
（`governor/routing-decision`、`governor/selection-mode`），且旧读取器/插件卸载后
不破坏 Session 恢复（AC 6），同一 decisionId 幂等（AC 10）。

**现状**：
- `SessionEvent` envelope 定义了 `ignorable?: true` 字段
  （`dsh-session/lib/types/types.d.ts` L443）：未知类型事件必须带该标记，
  读取器才能安全跳过。
- 但 `Session.append(type, data, opts?)` 的实现只构造
  `type/seq/time/data/surfaceOp/sourceEventSeqs` 并立即 `deepFreeze`
  （`dsh-session/lib/types/index.js` append 实现），**没有任何参数能写入
  `ignorable`**。
- 持久化冷读回路径 `assertEventsSupported`
  （`dsh-session-persistence/lib/index.js` L1117-1122）对
  `KNOWN_SESSION_EVENT_TYPES` 之外且未标 `ignorable` 的事件抛
  `SessionFormatUnsupportedError`，拒绝解释整个 log。

**可复现证据**（`test/contracts/session-event-seams.test.ts`）：
1. `未标 ignorable 的 governor 事件持久化后冷读回被拒绝`：
   双 Context（模拟进程重启）+ JSONL 持久化往返，`load()` 拒绝并报
   "unknown to this harness and not marked ignorable"。
2. `Session.append 的返回事件 envelope 不含 ignorable 字段且被冻结`：
   API 面证据。
3. `带 ignorable 标记的事件（未来 seam 补齐后的目标形态）冷读回成功且事件保留`：
   手工向明文 JSONL 注入带 `ignorable: true` 的 governor 事件后冷读回成功，
   证明协议目标形态在上游读取路径已就绪，仅缺写入 API。

**请求**：为 `Session.append` 增加可选 envelope 选项（例如
`append(type, data, { ignorable: true })`），或提供等价的插件事件
envelope 扩展通道。

**影响与缓解**：seam 补齐前，Governor 不向可持久化会话写入 governor 事件
（否则破坏 DSH Session 恢复，违反"DSH 合同兼容"优先级）。双写协议中
Session Event 侧在测试环境以内存 Session 验证行为（append/幂等/ack/durable
语义均可用），持久化往返被阻断的部分记入 BLOCKED.md。

## SEAM-2 插件事件类型注册面缺失（P0 阻断项，与 SEAM-1 同源）

**需求**：同 SEAM-1；插件事件类型应可被 persistence 读取路径识别。

**现状**：`KNOWN_SESSION_EVENT_TYPES` 是仓库内生成物
（`dsh-session/lib/types/known-event-types.d.ts` L14-16 原文）：
"Downstream (out-of-repo) plugin events are outside this list by construction;
**a registration surface for them is deferred until such a consumer exists**."

**可复现证据**：同 SEAM-1 用例 1（`governor/routing-decision` 不在集合内被拒）。

**请求**：提供插件事件类型注册 API（例如
`registerKnownSessionEventType('governor/routing-decision')`），或将
`ignorable` 判定作为插件事件的默认策略。

## SEAM-3 方法级 Remote capability 声明缺失（P0 阻断项）

**需求**：GOV-SEC-001 要求每个 Remote 方法显式声明 `governor.read|manage|audit`
capability，且 Remote 使用 Host 解析的登录主体。

**现状**：
- `RemoteMethodMarker`（`dsh-typert-protocol/lib/types/index.d.ts` L47-53）
  只有 `method/exportName/invocation` 三个字段，`invocation` 仅声明调用模式
  （`direct` / `context` scoped），**没有 permission/capability 字段**。
- `bindTypertRemote` 返回 frozen `{service, serviceKey, namespace}`，无权限语义。
- Gateway 错误码全集（`dsh-api-gateway`）不含权限类错误；
  `InvocationDescriptor` 不携带调用主体。

**可复现证据**（`test/contracts/client-surface-seams.test.ts`）：
1. `RemoteMethodMarker 契约只有 method/exportName/invocation，无
   capability/permission 字段`（发布物取证）。
2. `bindTypertRemote 返回的 binding 只有 service/serviceKey/namespace，且被冻结`
   （运行时复现）。
3. `typert-protocol 的导出面没有 capability 声明/校验 API`（运行时复现）。

**请求**：在 typert 协议的方法标记或 Gateway 调用边界加入 capability 声明与
主体传递（例如 `@Remote({ capability: 'governor.manage' })` 与
`InvocationDescriptor.principal`）。

**影响与缓解**：Governor 在 Host 端实现自身的 capability 复核矩阵
（GOV-SEC-001 的"Host 端复核"部分）与兼容 API 的 Bearer token 鉴权；
但"DSH Remote 使用 Host 解析的登录主体、不接受浏览器自报"在 rc.8 上无法
完整实现，相关 AC 记入 BLOCKED.md。

## SEAM-4 TC39 装饰器在部分构建/测试管道不可用（环境限制，非上游缺失）

**现状**：`@Remote()` 装饰器（方法级 Remote 注册的唯一公开通道）使用
TC39 装饰器语义（`context.addInitializer`）。tsc（本项目 build）可正确转换；
但 Node 24 原生不支持装饰器语法，且 vitest 4.1.11 + vite 8.2.1 的 oxc
转换管道在 esnext/es2022 target 下均不降级装饰器（实测 `SyntaxError`；
`vite` 的 `esbuild`/`oxc` 配置项均无法使其转换）。

**可复现证据**：实验记录（2026-08-21）：在 vitest 合同测试中使用 `@Remote()`
语法导致 `SyntaxError: Invalid or unexpected token`；esbuild CLI 需显式
`--target=es2022` 才转换，而 vitest 的 vite 8 管道走 oxc 且忽略该 target。

**影响与缓解**：运行时合同测试以无装饰器服务证明 marker 机制
（`remoteMethods` 仅暴露装饰器初始化的标记）；src 侧 Remote 服务实现若需
`@Remote()` 装饰器，须确保只在 tsc 构建路径加载，或等待 vitest/oxc 支持。
Governor 的 capability 复核不依赖装饰器（方法内检查）。

## SEAM-5 client 侧注册表为浏览器 bundle，Node 合同测试无法实例化（环境限制）

**现状**：Trajectory definition（`ctx.conversationEvents` /
`ctx.conversationViews`）与单占位 selector（`ctx.slots`，SlotMap
`conversation.input.model` `kind:'single'`）的运行时实现位于
`dsh-client-runtime/lib/client.js`，文件首行为
`window.__ModuleLoader__.load({...})`——浏览器专用模块格式，Node 无法加载。

**可复现证据**（`test/contracts/client-surface-seams.test.ts`）：
`client 入口是浏览器 bundle：window.__ModuleLoader__ 阻止 Node 实例化`。

**影响与缓解**：合同测试以发布物取证（d.ts 契约 + 注册 API 签名 + 槽位
`kind:'single'` 声明 + 官方 occupant 包）证明接缝存在；真实注册行为
（Trajectory 卡片挂载、selector 占用）需要浏览器 E2E（DSH web Profile +
Playwright）验证，超出本次 Node 合同测试范围，随 GOV-UI-002/GOV-SELECT-001
的浏览器侧交付补齐（依赖完整 DSH web-app 测试 harness，记入 BLOCKED.md）。

## 已确认可用、无需上游变更的接缝

| 接缝 | 证据 |
| --- | --- |
| `agent/request` waterfall 的 request-scoped route override（替换返回值即 dispatch config，不改持久模型） | `test/contracts/request-scoped-route.test.ts` |
| `Session.append` 对 declaration-merged 插件事件的运行时接受（内存/fork/seed 路径） | `test/contracts/session-event-seams.test.ts` |
| `session/flush` durable acknowledgement（`SessionStore.flush` 返回 participation） | 同上 |
| Governor 持久层幂等 append（扫描 log + append + DECISION_CONFLICT 冲突拒绝） | 同上 |
| 会话控制状态以事件持久化、fork/seed 恢复后重建（`governor.session.v1` 语义） | 同上 |
