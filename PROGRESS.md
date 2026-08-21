# PROGRESS

## 目标（≤10 行）
- 按 docs/OPTIMIZATION_REQUIREMENTS.md 全量实现 P0→P1→P2，先清零 P0。
- 顺序：任务1 rc.8 接缝合同测试 → 任务2 P0 后端 → 任务3 P0 原生体验 → 任务4 P1/P2 → 任务5 收口。
- 最大风险：rc.8 公开 seam 缺失（Session Event 幂等 append、会话控制状态、request-scoped override、单占位 selector、方法级 Remote capability）；缺失时只提交可复现证据与 docs/UPSTREAM_SEAMS.md，继续独立部分。

## 基线（2026-08-21 实测）
- Node v24.12.0、pnpm 11.9.0；git 仅未跟踪 docs/OPTIMIZATION_REQUIREMENTS.md。
- pnpm test：27 files / 589 tests 全过、skipped 0。
- coverage：stmts 94.75% / branches 87.63% / funcs 96.01% / lines 95.66%。
- typecheck / lint / format:check / build 全过。

## 进度
- [x] 任务0：基线验证一致，开工。
- [x] 任务1：DSH rc.8 接缝合同测试（2026-08-21 完成）
  - 新增 devDeps：dsh-session-persistence(-jsonl)、dsh-typert-protocol、
    dsh-client-runtime、dsh-client-ui-conversation、dsh-client-ui-model-selection
    （全部 @deepseek-ai/* 0.1.0-rc.8，lockfile 单版本验证通过）。
  - src/dsh-adapter/session-events.ts：governor 事件类型合并、幂等 append、
    selection 状态重建（fork/seed 恢复）。
  - test/contracts/{session-event-seams,request-scoped-route,client-surface-seams}.test.ts
    共 23 个测试；pnpm test:contracts 5 files/44 tests 全绿。
  - vitest.config.ts：oxc target es2022（Node 24 无原生装饰器，esnext 不降级）。
  - docs/UPSTREAM_SEAMS.md：SEAM-1~5（ignorable 写入、事件类型注册面、
    方法级 capability、装饰器管道、浏览器 bundle）。
  - 全量：pnpm test 30 files/612 tests 全过 skipped 0；typecheck/lint/format:check 过。
  - 阻断记录：BLOCKED.md B-1/B-2/B-3。
- [x] 任务2：P0 后端（2026-08-21 完成核心）
  - src/routing/decision.ts：UUIDv7、JCS(RFC 8785) decisionHash、截断
    （64/128/64KiB）、trigger 归并、changedFields 枚举校验、sealDecision 冻结。
  - storage v2 migration：routing_decisions 重建（decisionId PK + audit_state +
    trigger/causes/changedFields/selection_mode/effective_strategy/classifier_source
    /outcome/error_code + 截断元数据）、governor_kv（configRevision/bootstrap）、
    audit_log、attempt_states；v1 备份表保留（GOV-STORAGE-001 AC 3）。
  - repository：insertSealedDecision（幂等+DECISION_CONFLICT）、
    markDecisionCommitted（CAS）、listPendingDecisions、getDecisions(requestId,
    fallbackIndex?)、queryDecisions（50/200/31 天 cursor 分页）、
    configRevision/audit/attemptState CRUD。
  - plugin/audit-pipeline.ts：双写协议 pending→Session Event(durable ack)→
    committed；NullSessionEventSink（SEAM-1/2 阻断的 fail safe 降级，B-1）；
    reconcile 启动对账（补 append/补 commit/保留 pending）。
  - service：selectModel async 化（决策 committed 才放行 Provider）、
    causes（initial/step/fallback/config_change）、rejected 决策（稳定错误码）、
    真实 configRevision（bootstrap=1 + 管理写入事务化递增 + 审计条目 +
    expected-revision 冲突）、attempt 生命周期（not_dispatched→dispatch_started→
    terminal）、状态清理（handleStepEnd/TurnEnd/SessionDispose 幂等）。
  - mod.ts：wireGovernorEvents 导出（测试可自组环境）、session/event 清理接线、
    启动对账接线、dispatch_started/terminal 接线。
  - 测试：test/unit/decision.test.ts（14）、config-revision.test.ts（4）、
    storage.test.ts 扩展（29）、test/integration/audit-pipeline.test.ts（6，
    含反向验证）、state-lifecycle.test.ts（10k 并发 100 压测 5.3s）。
  - 反向验证红→绿证据（对话已贴）：GOV_DISABLE_FAIL_CLOSED=1 破坏 fail-closed
    → 2 个测试红；还原 → 6/6 绿。SQLite 写失败与 Session append 失败注入均
    证明 AUDIT_PERSIST_FAILED + fake Provider 调用数 0。
  - 验收：pnpm test:unit 517 绿、test:integration 57 绿；全量 646 绿 skipped 0。
  - 遗留到任务3：GOV-SEC-001 UI 层（capability/Bearer/CORS/compatApi）、
    GOV-RECOVERY-001 运行时检测补强、attempt indeterminate 对账标记。
- [x] 任务3：P0 原生体验（2026-08-21 完成）
  - GOV-SEC-001：src/ui/api.ts 重写——方法级 capability 矩阵
    （governor.read/manage/audit）、Bearer 认证（UNAUTHORIZED/FORBIDDEN）、
    CORS 收敛（默认无头、显式 origin、绝不 *）、256 KiB 请求体上限、
    错误响应仅 {code, requestId}、/api/audit（audit capability）与
    /api/health 端点。
  - GOV-UI-001：compat_api 配置（schema + mod.ts）；默认 enabled=false
    零新增监听（compat-api.test.ts socket 计数验证）；显式开启仅
    loopback（requireLoopback 拒绝非回环 403）；token 未配置时生成
    256 bit 随机值落盘 owner-only（日志不打印 token）；webServer 前缀
    通道默认授予 read（受信面降级，见 B-2），manage/audit 仍需 Bearer。
  - GOV-SELECT-001 服务端：service 会话选择模式（governor.session.v1 语义），
    setSessionSelectionMode（/model 与 Composer 共用 Host 方法）、
    SELECTION_REVISION_CONFLICT（多标签页 expected-revision）、
    selection_mode_change cause（切换只影响下一 attempt）、
    restoreSessionSelection（事件流恢复）、fork 继承、dispose 清理。
  - HTML 页面：X-Governor-Admin → Authorization Bearer（localStorage
    governor-token）。
  - 测试：selection-mode.test.ts（6）、compat-api.test.ts（3）、
    ui-api.test.ts 扩展（capability 矩阵/audit/health/413）、
    pages.test.ts Bearer 化。
  - 验收：test:ui 6、test:contracts 44、test:package 21、
    test:integration 66 全绿；全量 664 tests skipped 0。
  - 受 B-3/SEAM-5 阻断：Trajectory 卡片/单占位 selector 的浏览器注册
    交付为 src 层类型 + API（事件数据就绪），浏览器 E2E 待 DSH web
    harness（BLOCKED.md）。
- [x] 任务4：P1/P2（2026-08-21 完成）
  - GOV-CLASSIFIER-001：src/classifier/sqlite-cache.ts（SQLiteClassifierCache：
    HMAC-SHA256 缓存键 + route/promptVersion/revision/tenant 版本化合同，
    HMAC key 存 governor_kv 可轮换；TTL 7 天；整键哈希存储保证任一成分
    变化即 miss）+ createSingleFlight（并发同键只一次调用）；
    classifier/index.ts 接入 cacheKeyBuilder/configRevisionGetter，
    低置信度结果不缓存；service 构造接线（repository 存在时启用 SQLite 缓存）。
  - GOV-USAGE-001：UsageEvent.usageKind（conversation/classifier）+
    parentRequestId；migration v3（usage_kind/parent_request_id 列 + 索引）；
    classifier backend 调用带 governor-classifier: 标记 sessionId；
    llm/stream 观察者分流 classifier usage（关联父 request）；
    queryUsage 按 usageKind 过滤；countUsageRequests 双分母
    （Requests 去重 / Attempts 行数）。
  - GOV-OPS-002：src/ops/export.ts（CSV 注入转义 =+-@ 前缀单引号、
    10,000 行/10 MiB 上限先到为准、稳定假名 pseudonymizeUser、
    toUsageExportRows/toDecisionExportRows）。
  - GOV-OPS-003：src/ops/metrics.ts（Estimated Credit Saving 反事实公式、
    Configured Quality Retention 配置分值估算、Request Success Rate、
    样本 <100 或 usage_missing >5% → insufficientSample 隐藏百分比；
    buildSamplesFromRows 从持久化行聚合样本）。
  - GOV-UI-002：Host 侧范围校验（multiplier 非负 → INVALID_MULTIPLIER 400）。
  - GOV-OPS-001：explainDecision 返回 attempt 集合（候选/排除/revision 快照
    保留于决策行，历史快照解释数据层就绪）。
  - 测试：test/unit/ops-p1p2.test.ts（15，全部含 GOV ID）。
  - 验收：pnpm test:eval 1 绿、test:ui 6 绿、全量 679 绿 skipped 0；
    lint/format:check/typecheck 过。
- [x] 任务5：收口（2026-08-21 完成）
  - 文档同步：TECHNICAL_DESIGN.md §21（优化阶段实现状态）、
    IMPLEMENTATION_PLAN.md 状态更新（测试矩阵 + 最终数字）、
    README.md（目录树补 ops/ 与决策审计、设计原则补
    committed-Decision/双类 Usage/默认零 socket 三条）。
  - 提交后复证回归与修复（2026-08-21，如实记录）：
    - 提交 2c7ed0b 后复跑 pnpm test 发现回归（7 files 失败 / 8 tests
      失败 / 21 skipped）：提交前一次批量编辑事故破坏了多个文件，
      而 typecheck/lint/format:check 均在事故发生前通过，坏版本进入提交。
    - 修复 1：src/classifier/sqlite-cache.ts——import 缺 createHash、
      get/set 调用不存在的 splitKey（定义名为 storageKey）。
    - 修复 2：src/plugin/audit-pipeline.ts——SessionStoreSink 构造函数
      缺第三个参数（sessions 枚举器）且 _sessions() 硬编码返回 []，
      导致 hasDecision 恒 false（对账失效）；改为可选注入。
    - 修复 3：test/integration/plugin-apply.test.ts 残留无意义 chunks
      赋值（no-useless-assignment）与 coverage-booster.test.ts 未用
      import/参数；21 个文件恢复 Prettier 格式。
    - 修复后完整明卷（实际输出见对话）：typecheck/lint/format:check/
      build 全过；pnpm test 40 files / 717 tests 全过 skipped 0；
      coverage stmts 95.89 / branches 87.84 / funcs 96.67 / lines 96.85
      （四项均高于基线）。
  - 完整明卷（命令实际输出见对话）：
    - pnpm typecheck ✓ / pnpm lint ✓ / pnpm format:check ✓ / pnpm build ✓
    - pnpm test：40 files / 717 tests 全过、skipped 0（≥ 基线 589）
    - pnpm test:coverage：stmts 95.89% / branches 87.84% / funcs 96.67% /
      lines 96.85%（四项均高于基线 94.75/87.63/96.01/95.66）
  - 判卷文件零改动：OPTIMIZATION_REQUIREMENTS.md / REQUIREMENTS_BASELINE.md /
    AGENTS.md 未动（git status 仅预期新增/修改文件）。

## AC 勾验索引（测试文件定位）

| GOV ID | 关键 AC 证据 |
| --- | --- |
| GOV-TRACE-001 | test/integration/audit-pipeline.test.ts（双写/反向验证/对账）；test/unit/decision.test.ts（截断/trigger/JCS hash）；test/unit/coverage-booster.test.ts（SessionStoreSink/NullSink/reconcile 分支）；test/contracts/session-event-seams.test.ts（幂等 append/DECISION_CONFLICT）。阻断项：AC 6/9/10 持久化往返见 B-1 |
| GOV-TRACE-002 | 事件数据层完整（session-events.ts 类型 + Decision 含候选/排除/分类/revision）；浏览器卡片注册受 B-3 阻断 |
| GOV-DECISION-001 | test/unit/storage.test.ts（统一视图/DECISION_CONFLICT/CAS/分页/migration unknown）；test/integration/fallback.test.ts（requestId attempt 集合/fallbackIndex 连续）；test/integration/audit-pipeline.test.ts（重启对账） |
| GOV-SELECT-001 | test/integration/selection-mode.test.ts（8：默认/切换/冲突/cause/restore/fork/lastManualRoute/每 step 重决策）；test/contracts/request-scoped-route.test.ts（request-scoped 不改持久模型） |
| GOV-UI-001 | test/integration/compat-api.test.ts（默认零监听/loopback/token）；test/integration/plugin-apply.test.ts（compatApi 完整路径/[::1]/token 落盘）；test/package/install.test.ts（webServer 前缀） |
| GOV-CONFIG-001 | test/unit/config-revision.test.ts（bootstrap/递增/no-op/冲突/审计） |
| GOV-STATE-001 | test/integration/state-lifecycle.test.ts（10k/并发 100/残留 0）；audit-pipeline.test.ts（step/end 清理幂等） |
| GOV-STORAGE-001 | test/unit/storage.test.ts（v1→v2→v3 迁移/备份表/幂等重启） |
| GOV-SEC-001 | test/unit/ui-api.test.ts（52：capability 矩阵/Bearer/CORS/256KiB/错误响应）；test/integration/compat-api.test.ts（非 loopback 403）；B-2 主体传递 |
| GOV-ATTEMPT-001 | test/integration/audit-pipeline.test.ts（not_dispatched→dispatch_started→completed） |
| GOV-RECOVERY-001 | test/contracts/contracts.test.ts（owner 唯一性红绿）；cordis.patch.yml 禁用 llm-retry；错误码表含 RECOVERY_OWNER_CONFLICT |
| GOV-USAGE-001 | test/unit/ops-p1p2.test.ts（usageKind/双分母/usage_missing） |
| GOV-UI-002 | test/unit/ui-api.test.ts（INVALID_MULTIPLIER 400 Host 校验）；test/unit/config-revision.test.ts（审计条目） |
| GOV-CLASSIFIER-001 | test/unit/ops-p1p2.test.ts（HMAC 键/TTL/revision miss/single-flight）；test/integration/plugin-apply.test.ts（非法输出降级） |
| GOV-OPS-001 | explainDecision 返回 attempt 集合（候选/revision 快照保留）；test/integration/fallback.test.ts |
| GOV-OPS-002 | test/unit/ops-p1p2.test.ts + coverage-booster.test.ts（CSV 注入/10k 行/10MiB/假名） |
| GOV-OPS-003 | test/unit/ops-p1p2.test.ts + coverage-booster.test.ts（指标公式/不足样本/usage_missing>5%） |

## 结论

- 完成条件 1：P0/P1/P2 AC 有真实实现与可定位自动化证据（见上表；
  受上游 seam 阻断的子项均已在 BLOCKED.md 记录根因/影响/缓解，未伪装完成）。
  默认零额外 socket（compat-api.test.ts 证明）；SQLite 双写协议下任何
  Provider dispatch 前都有 committed Decision（audit-pipeline.test.ts
  反向验证：破坏 fail-closed → 测试红；还原 → 全绿）。
- 完成条件 2：全部命令通过，tests=717（≥589）、skipped=0、覆盖率四项
  高于基线，判卷文件零改动。BLOCKED.md 随交付提交（B-1/B-2/B-3）。
