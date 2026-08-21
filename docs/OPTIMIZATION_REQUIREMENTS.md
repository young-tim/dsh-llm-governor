# DSH LLM Governor 优化需求与验收标准

状态：Draft，2026-08-21。

关联文档：

- [需求基线](./REQUIREMENTS_BASELINE.md)
- [技术方案](./TECHNICAL_DESIGN.md)
- [实施与验收计划](./IMPLEMENTATION_PLAN.md)

## 1. 文档目的

本文整理 Governor 下一阶段的产品与工程优化需求，重点解决三个问题：

1. 模型决策需要进入 DSH 持久轨迹，用户可以在一次会话中追溯何时、为何选择或切换模型。
2. DSH 模型选择器需要提供明确的“自动选择”入口，而不是只能通过全局配置开启 Auto。
3. Governor 的配置、治理数据和用量界面需要融入 DSH 原生 Web 体验，避免默认维护一套独立页面和额外 HTTP 监听端口。

本文中的“决策依据”只指结构化、可审计的数据，例如分类结果、策略、候选、排除原因、质量和倍率；不记录模型或分类器的隐藏思维链，也不保存 Prompt 正文。

## 2. 当前状态与主要缺口

| 领域 | 当前状态 | 主要缺口 |
| --- | --- | --- |
| 路由结果 | Governor 改写 `provider/model`，DSH 在 `request/header` 中记录最终生效配置 | `request/header` 只在 initial/resume/change 时追加，不能表达每次 Governor 决策及其依据 |
| Decision Record | 完整记录可写入 SQLite，另有简化的进程内记录 | 没有写入 Session Event；查询 API 只读简化内存记录，重启后不可解释历史决策 |
| Auto Routing | 后端已支持 `routing.default=auto` 以及 Hint → Rule → LLM 分类 | 模型选择器没有“自动”选项；模式是全局配置，不是可见、可恢复的会话选择 |
| Web UI | 优先挂载 `/governor` 到 DSH Web Server；配置端口时可独立监听 | 使用独立 HTML/API，未注册 DSH 原生 Settings、Trajectory 与 Composer 扩展 |
| 配置版本 | Schema 定义了 revision | 服务运行时固定返回 `1`，管理写入没有形成真实可追溯版本 |
| 分类可观测性 | 分类结果有 `source=hint/rule/llm` | Decision 表没有保存 source；SQLite classifier cache 尚未接入运行时 |
| 生命周期 | 请求状态按 `(session, turn, step)` 放在内存 Map | 未在 step/turn/session 结束时清理，长时间运行可能积累状态 |

## 3. 产品与架构决策

### 3.1 轨迹记录采用“双写、单一决策对象”

一次路由计算只生成一个不可变的 `RoutingDecision`，随后写入：

1. DSH Session Event：负责会话内持久轨迹、恢复与轨迹 UI 展示。
2. Governor SQLite：负责跨会话查询、聚合、审计和管理接口。

两处记录必须使用同一个序列化对象，不能分别拼装两份语义可能漂移的数据。标识规则如下：

- Governor 在一次 DSH 逻辑模型请求首次进入路由时生成 UUIDv7 `requestId` 并放入 request state；同一调用的 middleware 重入、Fallback 和乱序回调复用该 ID，用户重复发送产生新的 ID。
- 首次 attempt 的 `fallbackIndex=0`，Fallback 在同一 `requestId` 下原子递增；`decisionId=<requestId>:<fallbackIndex>` 是两处存储的幂等键。
- LLM classifier 是父请求的辅助调用，只关联父 `requestId`，不占用 conversation 的 `fallbackIndex`。
- 使用 RFC 8785 JSON Canonicalization Scheme 规范化核心字段，再计算小写十六进制 SHA-256 `decisionHash`；同一 `decisionId` 收到不同 hash 必须返回 `DECISION_CONFLICT`，不得覆盖或静默忽略。

Session Event 与 SQLite 没有共同事务，因此这里的“双写”不承诺物理原子性。P0 使用固定提交协议：

1. SQLite 持久化 Decision，状态为 `audit_state=pending`。
2. 以相同 decisionId/hash 幂等 append Session Event，并等待 durable acknowledgement。
3. SQLite 以 decisionId/hash compare-and-set 为 `audit_state=committed` 并等待提交。
4. 只有 committed 才允许 Provider 分发。

任一步失败或超时则本次请求 fail closed。重启对账扫描 pending：Session Event 已存在且 hash 一致则补 commit；不存在且会话仍可写则补 append 后 commit；会话不可写或 hash 冲突则保留 pending、暴露健康告警，不自动分发。pending 只在诊断视图显示为“审计未完成”，不能展示成已经调用 Provider。

`RoutingDecision.outcome=selected|rejected` 只表示路由计算结果，不表示 Provider 已调用或成功。轨迹中的执行状态由同一 attempt 的 dispatch/Usage 生命周期证明；证据缺失时显示“未确认执行”，崩溃恢复时不得自动重放状态不明的 Provider 调用。

底层应保存每个模型调用 attempt 的决策。轨迹 UI 默认只展开以下重要节点，其余连续相同决策可折叠以降低噪声：

- 首次请求（initial）。
- 会话恢复后的首次请求（resume）。
- 路由模式、策略、配置版本、候选集或最终模型变化（由 causes/changedFields 表达）。
- Fallback 重选。
- 无候选、权限、额度、能力等导致的拒绝。

| 场景 | 写入时机与记录 |
| --- | --- |
| 新会话首次调用 | 本 attempt 写 `initial` Decision |
| 用户继续回复/Tool loop | 每个实际模型 attempt 都写 `step` Decision，即使 route 未变化 |
| resume 后首次调用 | 本 attempt 的 causes 包含 `resume` |
| 用户切换 Auto/Manual/具体模型 | 切换成功时立即写 selection-mode event；下一 attempt 的 causes 包含 `selection_mode_change` |
| 管理员修改策略、倍率、Quality、白名单 | 提交时立即写管理审计；每个受影响会话的下一 attempt 包含 `config_change` 和新旧 revision |
| 候选、策略或最终 route 变化 | Decision 的 `changedFields` 精确指出变化字段 |
| Fallback 或拒绝 | 每次独立写 Decision，不参与 UI 折叠 |

仅依赖 `request/header` 不够，因为相同模型可能由不同策略或不同候选集得到，也可能发生一次未改变 header 的重新决策。

### 3.2 Auto 是“选择模式”，不是虚拟模型

面向用户的模型选择只有两种语义：

- 选择具体模型：进入 Manual 模式。
- 选择“自动（Governor）”：进入 Auto 模式，由 Governor 在每个 step 决策实际模型。

`quality_first` 和 `credit_first` 是 Auto/Fallback 内部可配置策略，不作为普通用户模型列表中的伪模型展示。不得注册 `governor:auto` 之类没有真实 Adapter 的虚拟 `provider:model` 路由。

Auto 模式应是可持久恢复的会话控制状态，而不是从 Decision Event 反推。会话保存版本化的 `governor.session.v1={mode,lastManualRoute,selectionRevision,lastDecisionConfigRevision}`；首次创建无显式选择时使用全局默认，之后以会话状态为准。切回具体模型时，调用 DSH 既有模型选择能力并切换到 Manual；再次选择 Auto 时保留最后一次 Manual 模型，便于以后切回，但它不约束 Auto 的实际结果。

模式切换在 Host 持久化确认后生效并追加 `governor/selection-mode` 信息事件；保存期间 UI 禁止重复提交和发起新 step，失败则回滚显示。已经开始路由的 attempt 固定使用开始时的模式快照，切换只影响下一个 attempt。

### 3.3 配置入口、运营视图和 Host Service 分层

Governor 仍需要 Host Service，因为路由发生在 Host 进程，SQLite 也不能由浏览器直接访问。需要移除的是“默认独立 HTTP 服务和独立页面”，不是 `ctx.governor` 服务本身。

推荐的信息架构：

| 位置 | 内容 | 原因 |
| --- | --- | --- |
| Composer 模型选择器 | 自动（Governor）、具体模型 | 用户在发起会话时选择路由模式 |
| Trajectory | 路由决策卡片、Fallback、拒绝及详情 | 与实际 step 和模型输出在同一时间线上追溯 |
| DSH Settings → Governor | Routing、Auto、Fallback、Quota、存储与保留策略 | 这是原生管理入口，实际读写仍经 Host Service |
| DSH Settings → Governor → Models | Enabled、Multiplier、Capability、Quality | 这些是模型治理画像，不是 Provider 凭据配置 |
| DSH Settings → Governor → Users | Allow Models、Monthly Credits、Used Credits（只读派生） | 前两项是治理策略，已用量来自 Usage，不允许当配置改写 |
| Governor Usage 子页 | 用量、成功率、时延、Fallback、数据质量 | 属于运营视图；MVP 可放在 Governor Settings 分区内，后续有原生 dashboard slot 时再迁移 |

不建议直接把全部 Governor 字段混进 DSH 现有 Models Provider 编辑卡片。现有页面主要管理 Provider、凭据和模型目录，而 Governor 管理策略画像，来源和权限不同。当前 DSH 提供独立的 `settings.section` 扩展入口，因此首选新增原生 “Governor” 分区；如果以后 DSH 为 Models 页面提供稳定的行级扩展位，再考虑把倍率和 Enabled 摘要内嵌到模型行。

Web Profile 使用显式 `compatApi.enabled=false` 表示不启动兼容 API，不能用某个特殊端口值暗示禁用，因为 `port=0` 在部分网络库中表示随机端口。Headless/调试场景如确有需要，可显式开启只监听 IPv4/IPv6 loopback 的兼容 API，并明确标记为可选能力。

### 3.4 配置权威、快照与 Revision

为避免 DSH Settings、YAML 和 SQLite 形成三个相互覆盖的权威源，统一采用以下规则：

1. Governor SQLite Repository 是 Routing、Auto、Fallback、Models、Users 等运行时治理策略的唯一权威存储。
2. DSH Settings 是原生 UI 容器，通过受信 Remote 调用 `ctx.governor`，不保存第二份独立的治理策略。
3. YAML 只在 Repository 尚未初始化时执行一次 bootstrap，并保存导入来源和时间；后续重启不得覆盖管理写入。进程接线、数据库路径、兼容 API 开关等启动参数仍由静态配置管理，但不进入路由策略 snapshot。
4. SQLite 中保存全局、单调递增的 `configRevision`，初始 bootstrap 提交为 `1`。每次有效的策略事务将数据与新 revision 一起提交；no-op、Usage、已用额度结算和运行时事件不递增配置 revision。
5. 每个 attempt 在开始时读取一个不可变 `GovernorSnapshot`，包含 selection mode、策略、模型目录、用户准入、额度视图和 revision；分类、候选排序与 Decision 必须使用同一 snapshot。中途配置变化只影响下一个 attempt。

Settings 写入不得先修改 DSH 配置文件再补写 SQLite。多标签页或多 Host 写入使用 expected revision，由 SQLite 事务串行化；旧 revision 返回 `REVISION_CONFLICT`。

### 3.5 身份、Fork 与恢复边界

- restore 在第一个 `agent/pre-step` 之前加载会话 selection state；旧会话没有该字段时采用当次全局默认，并在首次写入时升级。
- fork 继承 `mode` 与 `lastManualRoute`，但在子会话首个请求重新执行权限、额度和可用性校验。复制展示的父轨迹保留原 `requestId/sessionId`，不复制 SQLite Decision 行；子会话的新 attempt 必须生成新 `requestId`。
- Decision View 按全局 `requestId` 查询 attempt 集合，按 `(fallbackIndex, createdAt)` 排序；单个 attempt 以 `(requestId,fallbackIndex)` 定位。访问继承轨迹仍需通过 Host 做会话权限校验。
- 已经双写但 dispatch 状态不明的 attempt 标记为 `indeterminate`，恢复时禁止自动重放；只有 Provider 明确支持且收到相同幂等键时，未来版本才可选择重放。

## 4. 优化功能清单

### 4.1 P0：发布前必须完成

#### GOV-TRACE-001 持久化路由决策 Session Event

新增插件自有的非 surface Session Event，例如 `governor/routing-decision`。事件至少包含：

- `schemaVersion`
- `decisionId`、`decisionHash`、`requestId`
- `sessionId`（SQLite 使用；Session Event 取宿主会话上下文，不重复暴露）
- `turn`、`step`、`fallbackIndex`
- `trigger`：`initial`、`resume`、`step`、`selection_mode_change`、`config_change`、`fallback`
- `causes[]` 与 `changedFields[]`，用于保留同一 attempt 同时发生的多种变化
- 用户选择模式：`manual` 或 `auto`
- 实际执行策略：`manual`、`quality_first` 或 `credit_first`
- 分类：`taskType`、`complexity`、`confidence`、`source`
- `minimumQuality`
- 候选：`routeId`、当前任务质量、`multiplierPpm`
- 排除项：`routeId`、稳定 reason code
- 路由结果：`selected` 或 `rejected`；不得把它解释为 dispatch 成功
- `configRevision`
- 安全错误摘要和时间

事件必须是纯信息记录，不参与 Prompt 或会话消息重建。P0 固定限制为：候选最多保存 64 项、排除项最多保存 128 项、单个事件 UTF-8 序列化后最多 64 KiB；按排序顺序截断，并记录 `totalCount`、`truncated=true` 和 SHA-256 摘要。

`causes` 保存全部原因；兼容字段 `trigger` 按 `fallback > selection_mode_change > config_change > resume > initial > step` 取最高优先级。`changedFields` 只允许 `selection_mode|strategy|classification|minimum_quality|selected_route|config_revision|candidate_set`。双写一致性比较的核心字段为：schema/identity、turn/step/attempt、trigger/causes/changes、selection mode、strategy、classifier、minimum quality、候选、排除、路由结果、revision 和安全错误码；存储行号、写入时间及 UI 派生字段不参与比较。

验收标准：

1. 给定一次成功的 Auto 或 Manual 请求，Session log 在模型分发前出现一条 decision event，所选 route 与 request-scoped dispatch context 的 canonical route 一致；若该 attempt 追加了 `request/header`，再逐字段比对 header。
2. initial、resume、selection mode 变化、配置/策略/候选/route 变化、普通回复 step、Fallback 和拒绝场景均有合同测试。
3. 相同 route 的重复决策仍有底层 attempt 记录，轨迹 UI 可以折叠但不能丢失原始事件。
4. Fallback 的所有事件共享 `requestId`，`fallbackIndex` 从 0 连续递增。
5. 无候选或准入失败时也记录 `rejected` 与稳定错误码，且不会产生 Provider 调用。
6. 插件卸载或旧版读取器处理这些纯信息事件时，不破坏 Session 恢复；需用 rc.8 持久化、关闭、重启、恢复合同测试证明兼容方式。
7. Session Event 与 SQLite 都获得 durable acknowledgement 才可放行 Provider；任一写入失败或超时均返回 `AUDIT_PERSIST_FAILED`，fake Provider 调用数为 0。
8. 事件不包含 Prompt、消息正文、Tool 参数、JWT、Header、API Key 或 Provider 响应正文。
9. 在 SQLite 写入前后、Session append 前后和第二次 durable acknowledgement 前后 kill 进程；重启后没有 Provider 重放，孤儿副本可被幂等补齐或明确标为 `audit_incomplete`。
10. 同一 `decisionId` 重试不会产生第二个逻辑事件；hash 不同返回 `DECISION_CONFLICT`。如果 rc.8 不支持 Session Event 幂等 append，P0 必须先获得上游 seam，不能用 UI 去重冒充持久层幂等。

#### GOV-TRACE-002 原生轨迹决策卡片

为 DSH Trajectory 注册 Governor 事件定义。卡片摘要显示：

- “自动选择”或“手动选择”。
- 已选择模型与 Provider；只有存在 dispatch/Usage 证据时才显示“已使用”。
- 实际策略、任务类型、复杂度与置信度。
- 倍率、所选模型质量和 Fallback 序号。
- 选择变化或拒绝的原因。

详情抽屉显示候选排序和排除原因，不默认展开全部 JSON。完整 Decision View 的 P0 范围固定为：请求摘要、所有 Fallback attempts、每次候选/排除、配置 revision、dispatch/Usage 关联和安全错误；编辑策略、回放和跨请求对比不在 P0。

验收标准：

1. 卡片挂载到对应 `(turn,step)` 的请求节点；拒绝时即使没有 header/output，也显示在该 step 下。
2. initial/resume/selection mode change/config change 使用文案资源中的中英文标签，不把内部枚举直接当 UI 文案。
3. 只有相邻且同一 turn 内 `selectionMode + effectiveStrategy + selectedRoute + configRevision + outcome` 全部相同的普通 step 才可折叠，并显示折叠数量；Fallback、拒绝和任何 `changedFields` 非空的事件永不折叠。
4. 点击 requestId 可打开 Decision View；刷新页面和恢复历史会话后仍可查看。Repository 详情仍在保留期内时展示完整视图，过期后按第 5 条降级。
5. 字段缺失或来自旧 schema 时，对应值显示“未知”；候选详情已超过 Repository 保留期时显示 `details_expired`，摘要仍由 Session Event 正常展示。
6. 键盘可完成展开、关闭和 attempt 切换，关闭后焦点回到触发卡片；axe 严重/高等级错误为 0，并通过明暗主题与 375 px 窄屏截图基线。

#### GOV-DECISION-001 统一 Decision 数据模型与查询

移除简化的 `DecisionRecordMem` 作为对外权威。内存与 SQLite 使用同一公开 Decision 类型，`explainDecision()` 优先查询 Repository，并支持按 session、turn、step、requestId 查询。

SQLite 决策表补充：

- `session_id`、`turn`、`step`
- `decision_id`、`decision_hash`
- `trigger`、`causes_json`、`changed_fields_json`
- `selection_mode`
- `effective_strategy`
- `classifier_source`
- `outcome`、`error_code`、`audit_state`

验收标准：

1. 进程重启后仍能通过 requestId 查询该请求的完整 attempt 集合，包括候选、排除原因、分类来源和结果；指定 fallbackIndex 时只返回一个 attempt。
2. 同一 decision 在 Session Event、SQLite 和 API 中的核心字段逐项一致。
3. 列表查询默认 50 条、最大 200 条、最大时间范围 31 天，按 `(createdAt DESC, decisionId DESC)` 稳定排序并使用 cursor 分页；按明确 requestId 精确查询不受 31 天限制。
4. 旧数据库通过显式 migration 升级；旧记录缺失的新字段显示为 `unknown`，不伪造值。
5. 相同 decisionId/hash 的重复写入不产生第二条记录；相同 ID 但 hash 不同返回 `DECISION_CONFLICT` 并写安全审计。

#### GOV-SELECT-001 模型选择器新增“自动（Governor）”

在 Composer 模型选择体验中新增置顶选项“自动（Governor）”。该选项改变会话的 Governor selection mode，不伪造成 Provider 模型。

验收标准：

1. 用户选择 Auto 或具体模型时，Host 先持久化 `governor.session.v1` 并追加 selection-mode event，再确认 UI 状态；确认后立即发送的下一个 step 必须使用新模式，保存失败则 UI 回滚且不允许抢跑请求。
2. Auto 已产生决策后，触发器可显示“自动 · 最近使用 `<model>`”，但用户选择状态仍为 Auto。
3. 用户选择具体模型后切换为 Manual，并由 DSH 既有 `session.selectModel` 持久化具体 route。
4. 会话刷新、进程重启和 resume 后恢复相同 selection mode；fork 按 3.5 的规则继承模式。多标签页同时切换时只有 expected revision 匹配的一方成功，另一方收到 `SELECTION_REVISION_CONFLICT` 并重新加载。
5. Auto 模式对每个 step 重新决策，不因上一步显示的最近模型而锁定 route。
6. Auto 无可用候选时阻止请求并返回 `NO_MODEL_MATCHED`，不静默回到当前手动模型；最后一次 Manual route 被删除、禁用或失去权限时仍可保持 Auto，切回 Manual 时要求重新选择。
7. `/model auto`、`/model <route>` 和 Composer 入口使用同一 Host 方法与持久化合同。
8. addressed subagent 继续遵守 DSH 原有模型选择限制；其实际 Governor 决策仍进入子会话轨迹。
9. Auto 的实际 route 只写入 request-scoped dispatch context，不调用持久化具体模型的 API，因而不会把 UI 模式或 `lastManualRoute` 改成最近的自动结果；权限、凭据和 subagent 限制在最终 dispatch 前再次校验。
10. rc.8 Spike 必须同时证明“会话控制状态扩展、request-scoped route override、单占位 selector”三项契约。缺少任一契约时 P0 阻断并先提交上游 seam，不以虚拟模型、私有字段或 UI overlay 规避。
11. 若 Governor bundle 替换官方 model-selection occupant，必须复刻搜索、限制、命令和持久化合同，并通过两种加载顺序、官方插件升级、HMR 和卸载后恢复官方 occupant 的组合测试。

#### GOV-UI-001 接入 DSH 原生 Settings，默认取消独立 Web 监听

新增 Governor Client 插件，使用 DSH `settings.section` 注册原生 Governor 分区，并通过受信 Remote 调用 Host Service。

验收标准：

1. Web Profile 的 DSH Settings 导航中出现 Governor。P0 最低范围是 Routing/Models/Users 的可回读 CRUD、expected-revision 冲突处理，以及 Usage 最近 31 天只读列表；高级筛选、批量编辑和可视化留到 P1。
2. 默认 `compatApi.enabled=false`，进程 socket 列表证明没有 Governor 新增监听；所有浏览器请求复用 DSH Web/Remote 通道。
3. Headless Profile 不加载 Client 插件，但 `ctx.governor` 的版本化查询/管理方法和 SQLite 能力保持可用；独立 CLI 不属于 P0 承诺。
4. 兼容 API 仅在显式开启时监听 `127.0.0.1` 或 `[::1]`，不得监听任一非 loopback 地址；启动日志打印实际地址并提示兼容接口已启用，但不打印 token。
5. 原生 Settings 写入使用 DSH 的本地可信权限与 revision 冲突保护，不再依赖浏览器手工传 `X-Governor-Admin`。
6. 不再返回通配 `Access-Control-Allow-Origin: *`；兼容 API 使用明确 origin/loopback 策略。
7. bundle 连续执行 10 次 HMR，以及安装、卸载和重装后，不残留或重复注册 Settings slot、Trajectory 定义、Remote 方法、路由或监听端口；在途写入要么完成一次，要么返回 `PLUGIN_RELOADING`，不得重复提交。

#### GOV-CONFIG-001 统一配置权威与真实 Revision

DSH Settings 负责原生展示，Routing、Auto、Fallback、模型画像和用户策略统一由 Governor Repository 保存，所有管理读写经过 `ctx.governor` 事务接口并遵循 3.4 的权威规则。

验收标准：

1. Repository bootstrap 后 `configRevision=1`；每次有效配置或治理策略变更与新 revision 在同一 SQLite 事务提交，无变化写入、Usage 和额度结算不递增。
2. Decision Record 保存实际用于该决策的 revision，不再固定为 `1`。
3. 并发标签页使用 expected revision；冲突返回稳定错误并保留用户未提交表单。
4. 空库只 bootstrap 一次并保存来源 hash；已有库和迁移后的库重启 10 次均不会用旧 YAML 或 DSH UI 缓存覆盖 Repository。
5. 非法更新完整回滚，旧 snapshot 继续服务；不会出现 UI 显示成功但路由仍使用旧值。
6. 每个 session 在配置变化后的首个新 attempt 将 `config_change` 加入 causes，并记录 `previousDecisionRevision/currentRevision`；多次变化合并为当前有效 revision，后续未变化 attempt 不重复标记。
7. 两个 Host 进程和两个标签页并发写同一 expected revision 时恰好一个成功；另一个返回 `REVISION_CONFLICT`。在事务提交前后 kill 进程，重启后数据与 revision 必须同时为旧值或同时为新值。
8. 分类执行中更新配置时，当前 attempt 的分类、候选和 Decision 全部使用旧 snapshot，下一个 attempt 全部使用新 snapshot，不允许混合字段。

#### GOV-STATE-001 请求状态生命周期与恢复

补齐 `session/event` 和 session lifecycle 接线，清理请求级 Map，并保证终止状态可诊断。

验收标准：

1. `step/end` 后清理已完成 request state，`turn/end` 和 session dispose 兜底清理关联状态。
2. 失败、取消、插件异常和正常结束均不会遗留 `_requestStates`、`_currentTurnStep` 或部分输出标记。
3. 测试夹具累计完成 10,000 个请求、峰值并发 100，并混合 20% 失败/取消和 10% Fallback；所有 terminal event 与持久化队列排空后 5 秒内，请求 Map 残留为 0，监听器数量回到基线。
4. 清理不删除 SQLite 或 Session log 中已经提交的 Decision/Usage。
5. 重复或乱序的清理通知是幂等的；cleanup 与 Decision/Usage 落库、Fallback 回调、HMR 同时发生时不丢已确认记录，也不重新分发 Provider。

#### GOV-STORAGE-001 P0 数据库迁移与故障安全

验收标准：

1. 空库、当前版本库、每个仍支持的旧 schema fixture 均可升级；migration 在 Host 暴露路由能力之前完成，版本逐级前进且重复启动幂等。
2. migration 中途 kill、SQL 错误、磁盘满、只读文件和 `SQLITE_BUSY` 超时后，旧库保持可恢复，Host 标记 `STORAGE_UNAVAILABLE` 并阻止 Provider 分发和管理写入。
3. 对会删除或重建数据的 migration，先创建可校验备份；健康页只给出不泄露文件系统路径的备份 ID 和 Host 侧恢复操作，恢复演练能回到升级前 schema 和行数。
4. migration 后按主键、外键、唯一键、decisionHash 和 configRevision 校验，不允许用默认值伪造旧记录缺失的业务字段。
5. 数据库恢复可写后必须显式重跑健康检查才解除 fail closed，不能仅因下一次 SQL 偶然成功而自动放行。

#### GOV-SEC-001 管理面安全收敛

Host 注册三项最小 capability：`governor.read` 可读配置/用量，`governor.manage` 可修改策略，`governor.audit` 可读完整审计；每个 Remote 方法显式声明并在 Host 端复核，不依赖菜单或按钮隐藏。

验收标准：

1. DSH Remote 使用 Host 解析出的登录主体和 capability，不接受浏览器自报 user/role；逐方法权限矩阵合同测试覆盖匿名、read、manage、audit 和组合权限。
2. 所有管理写入与 selection-mode 写入生成审计记录，包含 actor、target、changed-field names、old/new revision、result 和安全错误码；审计写失败则配置事务回滚。
3. 默认 Remote 与兼容 API 的请求体上限为 256 KiB；列表遵循 50/200 页大小和 31 天时间范围；P2 导出上限为 10,000 行或 10 MiB，以先到者为准。
4. 兼容 API 使用至少 256 bit 随机 Bearer token，不使用 Cookie；只接受 loopback peer，拒绝代理头改写的来源，CORS 只允许显式配置的 DSH origin 且不返回 `*`。
5. Prompt、消息/响应正文、Tool 参数、JWT、Authorization/Cookie、API Key、Provider Header、数据库路径和 SQL 错误属于禁止字段；对 Session Event、SQLite、API、缓存、审计、应用日志、错误响应、导出和 UI DOM 运行统一泄密扫描，命中任一即失败。
6. 非法权限返回 `FORBIDDEN`，认证失败返回 `UNAUTHORIZED`，Revision 冲突返回 `REVISION_CONFLICT`；错误响应只包含 code、requestId 和安全摘要。

#### GOV-ATTEMPT-001 Dispatch、Usage 与 Decision 关联

为避免把“选中”误报为“用过”，每个 `(requestId,fallbackIndex)` 维护独立的 attempt 生命周期：`not_dispatched|dispatch_started|completed|failed|cancelled|indeterminate`。状态变化与 Usage 关联同一键，不能回写篡改不可变 RoutingDecision。

验收标准：

1. Provider 调用前状态为 `not_dispatched`；调用边界前记录 `dispatch_started`。正常结束、错误和取消分别收敛到 terminal 状态，重复回调不产生第二次分发或重复 Usage。
2. 决策已提交但未发生 dispatch 时，UI 显示“已选择，未执行”；`dispatch_started` 后进程崩溃且无法确认结果时显示 `indeterminate`，恢复时不自动重试。
3. Usage 带相同 requestId/fallbackIndex、canonical route 和 provider request ID（若有）；真实零 usage 与 Provider 未报告的 `usage_missing` 明确区分。
4. 拒绝请求的 fake Provider、request header、assistant chunk 和 conversation usage 计数均为 0。
5. 若本 attempt 已产生首个用户可见 assistant delta 或任一 Tool Call，后续错误默认禁止 Fallback；取消永不重试。无输出的 retryable 错误才可按版本化错误码表进入下一 fallbackIndex。

#### GOV-RECOVERY-001 唯一 Recovery Owner

Governor 启用内建 Fallback 时是唯一 Recovery Owner；bundle 必须禁用官方 `dsh-llm-retry` occupant。检测到另一个活跃 owner 时拒绝启用 Fallback 并返回 `RECOVERY_OWNER_CONFLICT`，不得靠加载顺序抢占。

验收标准：

1. 组合测试覆盖 Governor 单独安装、retry 单独安装、两种安装顺序、重启、连续 10 次 HMR、卸载任一方及重装；任意稳定时刻最多一个 owner。
2. Governor 卸载后恢复官方 owner；在途 attempt 由开始时的 owner 收尾，新 attempt 才使用接管后的 owner，不发生双重重试。
3. `maxAttempts` 包含首次调用且最小 1；每次 Fallback 原子增加 fallbackIndex，并排除本请求已尝试 route。
4. retryable 错误码、超时、退避、部分输出、Tool Call、取消、额度结算和无 Usage 行为写入版本化 Recovery 合同；未知错误默认不可重试。

### 4.2 P1：核心体验完善

#### GOV-USAGE-001 用量与决策全链路关联

Usage 记录补充 `usageKind=conversation|classifier`，分类器调用关联父 request，并在 UI 中区分用户回答成本和路由分类成本。

验收标准：

1. LLM classifier 的 Token、倍率、Credits、时延和成功状态单独记录为 classifier usage。
2. Credits 严格使用技术方案 9.1 的 BigInt/ppm/credit-nanos 公式和向上取整；reasoningTokens 不重复相加。默认额度策略下 classifier Credits 计入调用用户，且不会重复计入 conversation attempt。
3. Usage 行可以跳转到对应轨迹 step 和 Decision View；Decision View 可以反查全部 attempts。
4. Provider 未报告 usage 时显示 `usage_missing` 数据质量提示，不把 0 伪装成免费调用。
5. Requests 以 requestId 去重，Attempts 以 decisionId 去重；统计页面同时显示两个分母。月度窗口使用配置的 IANA 时区，边界、并发超额语义与技术方案 9.2 一致。

#### GOV-UI-002 Governor 原生管理体验

Governor Settings 分区采用一致的原生表单与表格交互：

- Routing：默认 Manual/Auto、分类器、置信度和质量阈值。
- Models：Enabled、Multiplier、Capability、各任务 Quality。
- Users：白名单、月额度、已用与剩余；已用和剩余只读。
- Fallback：开关、总 attempts、策略和部分输出保护。
- Data：保留期、存储状态、usage_missing 比例。

验收标准：

1. 模型列表以 canonical route 唯一标识，支持 Provider、能力、Enabled 和文本筛选。
2. 表单范围和步长来自 Host 的版本化 schema：Quality 为 `[0,100]`，Multiplier 以非负 ppm 存储，Quota 以 credit-nanos 存储；超界值在 Host 拒绝，保存后按定点值回读完全一致。
3. 危险配置（部分输出后 Fallback、禁用最后一个可用模型）有明确风险提示，但最终准入仍以后端校验为准。
4. 只读用户不能看到可操作的保存按钮；越权 Remote 调用仍由 Host 拒绝。
5. 外部策略/模型目录更新通过事件推送；测试在 Host 提交确认后的一个事件循环内收到新 revision，不依赖轮询。

#### GOV-CLASSIFIER-001 分类器缓存与降级补全

验收标准：

1. P0 Decision 已保存 `source=hint|rule|llm`；本项把 SQLite classifier cache 接入运行时，缓存键为 `HMAC-SHA256(canonicalInput) + classifierRoute + promptVersion + configRevision + tenantScope`。
2. canonicalInput 规则和 HMAC key 轮换写入版本化合同；缓存不保存 Prompt 正文，管理员只能看到哈希、分类结果、版本和时间。
3. 默认 TTL 为 7 天；同一缓存键并发请求 single-flight，只产生一次 classifier 调用。失败、超时、非法 JSON 和低置信度结果不缓存。
4. LLM 分类超过 snapshot 配置的 timeout、返回非法 JSON 或低于 snapshot 的 confidence threshold 时，在 Decision 中记录稳定降级码和最终策略。
5. 重复输入命中缓存时不产生新的 classifier usage，但仍产生本次路由 Decision；revision、Prompt 版本、route、tenant 或 HMAC key 任一变化都会 miss。

### 4.3 P2：运营与维护增强

#### GOV-OPS-001 决策对比与回放说明

提供只读的“按当时快照解释”能力：展示当时的候选、配置 revision 和排序结果。首期不对历史 Prompt 重新分类，也不声称可以在缺少历史快照时完整重放。

验收标准：

1. Decision View 可以比较 Fallback 前后候选和排除原因。
2. 配置已变化时明确显示“历史快照”，不拿当前倍率或 Quality 替换旧值。
3. 缺少旧 schema 字段时标记不可重放原因，不推测数据。

#### GOV-OPS-002 数据保留、导出与健康状态

验收标准：

1. Decision、Usage、分类缓存和审计分别配置保留期，删除任务每批最多 1,000 行、每批提交后让出事件循环，并可从中断 cursor 续跑。
2. Session Event 摘要可以长于 Repository 详情保留期；详情删除后轨迹显示 `details_expired`，不再承诺打开候选详情。删除与查询/导出并发时，以查询开始时的 SQLite snapshot 为准。
3. 支持 CSV/JSON 导出，遵循 10,000 行/10 MiB 上限，默认以稳定假名展示 user；CSV 中以 `= + - @` 开头的单元格必须转义，且不包含禁止字段。
4. Settings 展示 SQLite 可写性、最后迁移版本、usage_missing 比例、最近失败码和待清理行数。
5. 存储损坏、迁移失败或磁盘不可写继续遵守 P0 `GOV-STORAGE-001`，健康页只提供诊断与恢复说明，不能绕过 fail closed。

#### GOV-OPS-003 路由效果指标

验收标准：

1. 对保留了完整 snapshot 且无 `usage_missing` 的 Auto requests，按同一候选快照计算 Quality First route；`Estimated Credit Saving = 1 - Σ实际全部 attempts 与 classifier creditNanos / Σ以观察到的总 tokens × Quality First multiplier 得到的反事实 creditNanos`。
2. `Configured Quality Retention = ΣAuto 最终 route 的配置 Quality / ΣQuality First route 的配置 Quality`；该指标必须标为“配置分值估算”，不能表述为真实回答质量或因果收益。
3. `Request Success Rate = 至少一个 attempt completed 的 request 数 / request 总数`；页面同时显示 Requests、Attempts、Fallback 数量、classifier 成本、时间范围和过滤条件。
4. 有效样本少于 100 个或 `usage_missing > 5%` 时显示“不足以判断”并隐藏节省/保留百分比；若未来做真实 A/B，必须另立实验合同，不能与上述反事实估算混用。

## 5. 关键事件顺序

一次正常 Auto attempt 的期望顺序：

```text
step/start
  -> load one immutable GovernorSnapshot
  -> agent/pre-step: classify against that snapshot
  -> agent/request: build one immutable RoutingDecision
  -> persist/ack routing_decisions(audit_state=pending)
  -> append/ack governor/routing-decision
  -> compare-and-set/ack audit_state=committed; otherwise fail closed and reconcile pending
  -> DSH append request/header when required
  -> record dispatch_started
  -> DSH provider dispatch with request-scoped route
  -> assistant chunks/message
  -> persist usage_event + terminal attempt state
step/end
  -> cleanup request state
```

一次被拒绝的请求在 Decision 双写完成后结束，不产生 `request/header`、dispatch、assistant chunk 或 conversation Usage。一次 Fallback 在同一 step 中产生下一个连续 `fallbackIndex` 的 Decision 和 Usage attempt。

## 6. 测试与发布门槛

### 6.1 Unit

- Decision schema/hash、截断、幂等键、reason-code registry 和安全字段白名单。
- Auto/Manual 会话模式折叠与恢复。
- snapshot/config revision 原子递增和冲突。
- attempt 状态机、Fallback index 原子分配、状态清理和重复清理。

### 6.2 Contract

- rc.8 自定义 Session Event 的持久化、旧读取器兼容、restore 和 fork。
- request-scoped dispatch context 与 Governor selected route 一致；有新 header 时再校验 header。
- DSH `settings.section`、Trajectory definition、会话控制状态、request-scoped override 和单占位 model selector 的组合约束。
- Remote capability、错误码、分页、限制和兼容 API 网络边界。

### 6.3 Integration

- initial、resume、相同模型重复 Auto、模型变化、配置变化、Fallback、拒绝。
- Session Event、SQLite、API、dispatch、Usage 五方 requestId/attempt 关联。
- 每个双写 crash point、SQLite busy/full/read-only、Session append 失败的故障注入和启动对账。
- 两 Host/两标签页切换模式与配置、分类中途变更、同 step 并发请求和乱序回调。
- 进程重启后的 selection mode、Decision View 与历史轨迹。
- Web Profile 无额外监听端口；显式兼容模式只监听 loopback。
- fork 的父历史引用、子请求新 ID、父详情过期后的降级。
- Provider dispatch 后、Usage 前崩溃为 indeterminate 且不自动重放。
- Fallback 的 partial chunk、Tool Call、cancel、timeout、无 Usage 与唯一 Recovery Owner 组合矩阵。
- HMR、安装和卸载不残留 slot、Remote、监听器或 Recovery Owner。

### 6.4 UI

- Composer 选择 Auto → 发消息 → 轨迹出现 Auto 决策卡 → 卡片展开候选依据。
- 切换具体模型后变为 Manual，再切回 Auto，刷新后状态正确。
- Settings 修改倍率/Quality 后产生新 revision，下一决策卡显示新 revision。
- 中英文、键盘、屏幕阅读器、明暗主题与窄屏。

### 6.5 发布阻断条件

任一 P0 验收，或其指定的 Unit/Contract/Integration/UI 门禁失败，均不得发布。以下情况是必须显式覆盖的阻断项：

- Provider 已调用但没有可关联的 Decision Record。
- 任一必需双写失败后仍调用 Provider，或孤儿记录无法对账/标记。
- 轨迹 selected route 与实际 dispatch context、存在的 `request/header` 或 Usage route 不一致。
- 拒绝请求仍产生 header、dispatch、assistant chunk 或 conversation Usage。
- 重启后历史决策无法查询或 Auto 模式丢失。
- fork/restore/旧读取器不兼容，或同一 decisionId 出现冲突内容/不连续 fallbackIndex。
- migration 失败后仍放行请求，配置 data/revision 不一致，或并发写静默覆盖。
- Web Profile 默认创建额外监听端口。
- 兼容 API 监听非 loopback、返回通配 CORS，或管理写入可绕过 Host 鉴权。
- 任一持久化、API、缓存、审计、日志、错误、导出或 UI 渠道出现禁止字段。
- Governor 与官方 `dsh-llm-retry` 同时成为 Recovery Owner。
- HMR/卸载残留注册项，或状态生命周期压测超过 GOV-STATE-001 阈值。

## 7. 规范常量与错误码附录

### 7.1 固定限制

| 项目 | 默认/上限 |
| --- | --- |
| Decision 候选 / 排除项 | 64 / 128 |
| 单个 Decision Event | 64 KiB UTF-8 JSON |
| 列表默认 / 最大页大小 | 50 / 200 |
| 非精确列表最大时间范围 | 31 天 |
| Remote/兼容 API 请求体 | 256 KiB |
| CSV/JSON 导出 | 10,000 行或 10 MiB |
| Classifier cache TTL | 7 天 |

数值可以在后续 schemaVersion 中变更，但实现、Host schema、UI 提示和测试 fixture 必须读取同一版本化常量，不能各自硬编码。

### 7.2 P0 稳定码

- Routing：沿用 `MODEL_NOT_FOUND`、`AMBIGUOUS_MODEL_ROUTE`、`MODEL_DISABLED`、`MODEL_ACCESS_DENIED`、`CAPABILITY_NOT_SUPPORTED`、`QUOTA_EXCEEDED`、`NO_MODEL_MATCHED`、`FALLBACK_EXHAUSTED`、`PARTIAL_OUTPUT_NOT_RETRYABLE`、`IDENTITY_REQUIRED`。
- Audit/State：新增 `AUDIT_PERSIST_FAILED`、`DECISION_CONFLICT`、`STORAGE_UNAVAILABLE`、`PLUGIN_RELOADING`。
- Revision/Auth：新增 `REVISION_CONFLICT`、`SELECTION_REVISION_CONFLICT`、`UNAUTHORIZED`、`FORBIDDEN`。
- Recovery：新增 `RECOVERY_OWNER_CONFLICT`；未知 Provider 错误不得映射为 retryable。
- Exclusion reason：沿用 `disabled`、`not_active_provider`、`access_denied`、`capability_not_supported`、`excluded_in_request`、`quality_missing`、`quota_exceeded`，并新增 `below_minimum_quality`，不得再把“有质量分但低于门槛”记成 `quality_missing`。

同一 schemaVersion 内稳定码只增不改；UI 用 i18n 资源映射文案，日志/API/Session Event 保存代码而非文案。未知新码必须原样保留并显示通用说明。

## 8. 建议实施顺序

1. 先做 rc.8 Spike，同时证明 Session Event 幂等持久化、会话控制状态、request-scoped route override、Trajectory definition、单占位 selector 和方法级 Remote capability 六项契约；任一缺失即记录上游 seam 需求并阻断 P0，不做私有绕行。
2. 确立 SQLite 配置权威，统一 Decision/Snapshot 类型、数据库 migration、查询、真实 revision 和稳定错误码。
3. 完成双写/对账、attempt 生命周期、状态清理、安全、Recovery Owner 与全部故障注入。
4. 完成 Auto 会话模式、Composer/命令入口和 Trajectory/Decision View。
5. 建设 DSH 原生 Governor Settings 分区，迁移 Models/Users/Usage，默认关闭兼容 API。
6. 再完成 classifier cache、管理体验、数据保留、运营指标等 P1/P2，并执行全链路发布门禁。

## 9. 明确不做

- 不记录隐藏思维链或 Prompt 正文。
- 不把 Auto 实现成虚拟 Provider/Model Adapter。
- 不让浏览器直接访问 SQLite。
- 不新增 Provider Proxy、凭据管理、组织系统、通用 RBAC 或金额财务。
- 不维护只供 Governor 使用的 DSH 私有 fork；若 rc.8 缺少必要公开扩展契约，先用可复现 Spike 提交上游 seam，P0 在 seam 可用前保持阻断。
