# PROGRESS

## 现状核对 (2026-08-20)

- HEAD=`4b0bbb88eac1f529dfe7e0f2748a4e6f2996bc0a`，28 tracked files，clean。
- 1 TS 源文件 (src/index.ts)，0 测试，三份规格共 707 行，Node 24.12.0，pnpm 11.9.0。
- `pnpm install --frozen-lockfile --ignore-scripts` / `typecheck` / `build` 成功；
  `test` 退出 0 但输出 "No test files found"（空检查）。

## 冻结合同 hash-object (相对 4b0bbb8)

- docs/REQUIREMENTS_BASELINE.md: `5a623e6bb7950f1fa0ce4be0bcae551b8d45e6b0`
- docs/TECHNICAL_DESIGN.md: `e43c8cb1a4fe00d97686f0b6a0cef6b5593b8e04`
- docs/IMPLEMENTATION_PLAN.md: `51b97f8244d67e5aab6d50c3e9de62729032a45c`

## 目标 / 实现顺序 / 最大风险 (≤10 行)

- 目标：将设计仓库变为可安装的 DSH 多模型治理插件，需求基线全功能可用、可审计、可打包，由自动化验收证明。
- 顺序：Task0 核对 → Task1 DSH 合同测试(rc.7/rc.8) → Task2 领域核心+SQLite → Task3 Auto/Fallback/Usage → Task4 Web UI → Task5 Eval/加固/打包。
- 每阶段结束必须通过其测试命令；冲突时让步顺序：安全与计量正确 > 功能完整 > DSH 兼容 > UI 体验 > 速度。
- 最大风险：DSH RC API 漂移破坏插件加载与路由；缓解=adapter 隔离+rc.7/rc.8 合同矩阵+pack smoke。
- 次大风险：DSH 无稳定身份入站 Hook，需 companion ingress adapter，不从 agent/request 猜 Header。
- 第三风险：双 Recovery Owner 导致重复调用/费用失控；Governor 独占 recovery，故障计数测试证明。

## 任务进度

- [x] Task 0: 现状核对 — 全部数字吻合，无 BLOCKED。
- [x] Task 1: DSH 合同测试 — 42 tests 全绿（rc7+rc8 各 21）；覆盖 model directory、pre-step、request 改写、stream 无损观察、request-error 重路由(429/Timeout/5xx/401/max_attempts)、双 Recovery Owner 红→绿、Web 身份绑定、Client Remote；冻结合同零改动。
- [x] Task 2: 领域核心与存储 — 166 tests 全绿；config(strict/默认/ppm/nanos)、credits(BigInt/ceil/月度quota/admission)、identity(local/header/jwt/custom/fail closed)、model(canonical/merge/ambiguous)、access(allow list/global default)、routing(4策略/tie-break/属性测试乱序不变/fail closed)、storage(WAL/迁移/CRUD/幂等/事务)；冻结合同零改动。
- [x] Task 3: Auto/Fallback/Usage — 5 integration tests 全绿；A失败→B成功(1 request_id/2 decisions/2 usage)、401不切换、partial output不切换、Credits红→绿、fallback上限红→绿；classifier(hint/rule/llm/缓存)、fallback(错误分类/排除集/attempt上限/部分输出保护)、usage(stream观察/幂等/聚合统计)；冻结合同零改动。
- [x] Task 4: 产品界面 — 6 UI tests 全绿（Playwright chromium）；Models/Users/Usage 三页加载+console error=0、未授权PATCH 403、admin token 200、普通user_id 拒绝写；不直连SQLite（只通过GovernorService API）；Headless 保持完整治理能力。
- [x] Task 5: Eval/加固/打包 — 全部 12 个验收命令通过；552 tests 全绿；Eval QR=95.78%/CS=25%；覆盖率 Lines 97.12%/Branches 91.23%；skip/todo=0；冻结合同零改动；三次红→绿验证；加固测试(安全/恢复/并发/月末/数据库损坏/重放)；安装smoke(rc.7/rc.8临时安装/Governor独占recovery/卸载后基础retry恢复/Web/Headless加载)；pack tarball 成功；无 BLOCKED。
- [x] Task 6: 真实安装返工（验收退回意见修复）— 566 tests 全绿。
  - **有效 dsh.bundle**：package.json 声明 `dsh.bundle.patch` + main/exports 插件入口；cordis.patch.yml 由"Design scaffold only"改为真实内容（插入 Governor host 行、禁用基础 llm-retry）。
  - **真实安装测试**：`test/package/install-real.test.ts` 用真实 dsh CLI（rc.7）把 tgz 装进临时 DSH_HOME 的 profile：`dsh plugin add` 后进入 `dsh.profile.bundles`（无 "declares no dsh.bundle" 警告）；`--dump-config` 渲染 Governor 行且 llm-retry disabled；`dsh plugin remove` 后恢复。
  - **运行时接线**：pre-step 自动分类（Hint/Rule→请求状态，auto 路由使用）；身份 fail closed（header/jwt 无绑定抛 IDENTITY_REQUIRED，local 自动绑定）；月度额度按月窗真实计算（不再仅靠 setQuotaExceeded）；SQLite 接入运行时（默认 $DSH_HOME/dsh-llm-governor/governor.db，决策/Usage/身份/策略落库，重启恢复，DB 为策略权威）；计费参数（tokensPerCredit/multiplierPpm/routingMode）来自配置。
  - **UI**：插件把 /governor 前缀路由注册到 ctx.webServer（DSH Web 端口下的受信挂载），页面计算 API base 自适配前缀；`pnpm build` 复制 HTML 到 dist/ui/pages（scripts/copy-ui-pages.mjs）。
  - **测试失真修复**：recovery owner 精确断言（=1 而非 >=1，组合层唯一性由 patch+dump-config 证明）；移除全部 --passWithNoTests；lint --max-warnings 0 且 44 条警告清零。
  - 覆盖率 Lines 96.95%/Branches 90.37%；冻结合同零改动。
