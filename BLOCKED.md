# BLOCKED

## B-1 Session Event 持久化双写被 rc.8 seam 阻断（2026-08-21，任务1取证）

- 根因：`Session.append` 无法写入 envelope 级 `ignorable` 标记（SEAM-1），
  且插件事件类型不在 `KNOWN_SESSION_EVENT_TYPES`（SEAM-2）。未标 ignorable 的
  governor 事件持久化后冷读回抛 `SessionFormatUnsupportedError`，破坏 DSH
  Session 恢复。证据见 docs/UPSTREAM_SEAMS.md 与
  test/contracts/session-event-seams.test.ts。
- 影响：GOV-TRACE-001 AC 6（持久化/重启/恢复兼容）、AC 9（重启对账中
  Session Event 补齐侧）、AC 10（持久层幂等 append 的持久化往返部分）不能
  在真实持久化路径上闭环。
- 缓解：双写协议的行为（append/幂等/durable ack/DECISION_CONFLICT/对账逻辑）
  已在内存 Session 与 SQLite 侧实现并测试；seam 补齐后接通持久化写入。
  Governor 当前不对可持久化会话写 governor 事件（fail safe，不破坏 DSH）。

## B-2 Remote capability 的主体传递被 rc.8 seam 阻断（2026-08-21，任务1取证）

- 根因：typert 协议无方法级 capability 声明、`InvocationDescriptor` 无调用
  主体（SEAM-3）。
- 影响：GOV-SEC-001 AC 1 中「DSH Remote 使用 Host 解析出的登录主体」无法
  在 rc.8 Remote 通道实现。
- 缓解：Host 端 capability 复核矩阵 + 兼容 API Bearer token 鉴权照常实现
  并测试；rc.8 Remote 通道上的能力检查以 Governor 自身的 actor 声明表实现。

## B-3 浏览器侧注册表无法 Node 实例化（2026-08-21，任务1取证）

- 根因：dsh-client-runtime client 入口为 `window.__ModuleLoader__` 浏览器
  bundle（SEAM-5）。
- 影响：Trajectory 卡片真实注册、单占位 selector 占用的运行时验证需要
  完整 DSH web-app 浏览器 harness（Playwright + web Profile），超出当前
  Node 合同测试能力。
- 缓解：合同测试以发布物取证（d.ts 契约 + 槽位声明 + occupant 包）；
  浏览器 E2E 随 GOV-UI-002/GOV-SELECT-001 交付时补齐（若届时仍无法搭建
  DSH web harness，将以 src 层注册代码 + 单元测试交付并如实记录）。
