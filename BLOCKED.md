# BLOCKED

## B-1 Session Event 持久化冷读回被 rc.8 seam 阻断（2026-08-21，任务1取证）

- 根因：`Session.append` 无法写入 envelope 级 `ignorable` 标记（SEAM-1），
  且插件事件类型不在 `KNOWN_SESSION_EVENT_TYPES`（SEAM-2）。未标 ignorable 的
  governor 事件持久化后冷读回抛 `SessionFormatUnsupportedError`，破坏 DSH
  Session 恢复。证据见 docs/UPSTREAM_SEAMS.md 与
  test/contracts/session-event-seams.test.ts。
- 影响：GOV-TRACE-001 AC 6（持久化/重启/恢复兼容）、AC 9（重启对账中
  Session Event 补齐侧）、AC 10（持久层幂等 append 的持久化往返部分）不能
  在真实持久化路径上闭环。
- 已修复（严格 fail-closed + 真实 DSH 接线）：
  - `NullSessionEventSink` 不再静默确认——`appendDecision`/`appendSelectionMode`
    抛 `AUDIT_PERSIST_FAILED`，不写轨迹就不标 committed。
  - `mod.ts apply` 通过 `ctx.get('sessions')` 注入 `SessionStoreSink`，接通
    真实 DSH Session 的实时双写（append + flush durable ack）。
  - `service.ts setSessionSelectionMode` 在内存状态更新前先追加持久
    `governor/selection-mode` 事件（durable ack 后才确认 UI）。
- 遗留（seam 本身）：冷读回（`sessionPersistence.load`）仍拒绝未标 ignorable
  的 governor 事件，需上游补齐 SEAM-1/2 后闭环。

## B-2 Remote capability 的主体传递被 rc.8 seam 阻断（2026-08-21，任务1取证）

- 根因：typert 协议无方法级 capability 声明、`InvocationDescriptor` 无调用
  主体（SEAM-3）。
- 影响：GOV-SEC-001 AC 1 中「DSH Remote 使用 Host 解析出的登录主体」无法
  在 rc.8 Remote 通道实现。
- 缓解：Host 端 capability 复核矩阵 + 兼容 API Bearer token 鉴权照常实现
  并测试；rc.8 Remote 通道上的能力检查以 Governor 自身的 actor 声明表实现。

## B-3 浏览器侧注册表运行时验证被 SEAM-5 阻断（2026-08-21，任务1取证）

- 根因：dsh-client-runtime client 入口为 `window.__ModuleLoader__` 浏览器
  bundle（SEAM-5）。
- 影响：Trajectory 卡片真实注册、单占位 selector 占用的运行时验证需要
  完整 DSH web-app 浏览器 harness（Playwright + web Profile），超出当前
  Node 合同测试能力。
- 已修复（src 层注册代码，类型取自 `@deepseek-ai/dsh-client-runtime/client`
  公开契约，tsc 编译期校验）：
  - `src/plugin/client-registration.ts` 定义 Trajectory 卡片的完整
    `ConversationNodeDefinition` 实现（match/start/update + `buildViewNode`
    渲染实现：GOV-TRACE-002 卡片摘要与详情抽屉视图模型、旧 schema 字段
    降级为「未知」、中英文标签资源）与 `governor-decision` target 的
    `ConversationViewDefinition`（per-session 增量构建器）。
  - Composer 单占位 selector（`conversation.input.model`）：`governorModelSeatSpec`
    注册 spec + `governorModelSeatInject` 注入面（选择 Auto 调用与 `/model auto`
    同一 Host 方法 `setSessionSelectionMode`，GOV-SELECT-001 AC 7），
    经 `registerClientSurface` 在 slots 注册面可用且浏览器组件就绪时注册。
  - Settings 分区声明（Routing/Models/Users 可回读 CRUD + Usage 只读）。
  - `mod.ts apply` 通过 `registerClientSurface(ctx, { service })` 接线；
    浏览器环境（注册面可用）执行注册并返回 disposer（HMR/卸载清理）；
    Node/Host 环境（SEAM-5）安全跳过。
  - 单元测试 `test/unit/client-registration.test.ts`（22 例）覆盖卡片
    状态/视图模型/视图构建器/selector 注入面/接线分支。
- 遗留：运行时行为验证（卡片挂载、selector 组件渲染与官方 occupant 替换的
  GOV-SELECT-001 AC 11 完整合同、Settings 渲染）需浏览器 E2E harness，
  随 GOV-UI-002/GOV-SELECT-001 交付时补齐。
