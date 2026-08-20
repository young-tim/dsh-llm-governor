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
- [x] Task 7: 五项功能接线返工（第二轮验收退回意见修复）— 580 tests 全绿。
  - **Capability/模态检查接线**：pre-step 提取图片信号 → RequestState 存 requiredCapabilities=['vision']/requiredModalities=['image'] → buildFilterInput 传入公共过滤（此前始终空数组）。图片请求对无 vision 能力模型抛 CAPABILITY_NOT_SUPPORTED；advisory 声明不支持 image 模态的模型被排除。
  - **Header/JWT 真实入站绑定**：Schema 扩展完整参数（header: header_name/trusted_proxy（必填，信任边界显式）/proxy_header_name/display_name_header/email_header；jwt: issuer/audience/algorithms/key|key_file（必填，禁止无密钥部署）/subject_claim/header_name/scheme/clock_tolerance_ms）；mod.ts 从已验证配置构建 HeaderIdentityProvider/JwtIdentityProvider 实例注入 service；service.bindIdentityFromHeaders() 执行可信代理校验与 JWT 验签；webServer 暴露 POST /governor/api/bind（仅本地回环可信）供 companion ingress/反向代理在 session 创建时调用。
  - **Auto LLM Classifier 启用**：mod.ts 在 auto.llm_classifier.enabled 时创建基于 ctx.llm 的后端（temperature=0、maxTokens=64、10s 超时、严格 JSON 解析、非法输出降级 Quality First）+ InMemoryClassifierCache 注入 service；分类结果（task_type/complexity/confidence/source=llm）落库。
  - **部分输出保护接线**：observeStream 检测首个语义 chunk（text/reasoning/tool-call delta）→ onPartialOutput 回调（幂等）→ service.markPartialOutput()；流式产出文本后失败不再透明切换模型（此前需手动标记）。
  - **严格 Schema 接入插件入口**：mod.ts apply() 第一行 resolveConfig()（fail closed）；toRuntimeConfig() 以规范化值构建运行时配置（默认值单一来源）；Schema 新增 storage/ui 段解析；cordis.patch.yml 与测试配置补 schema_version。
  - 覆盖率 Lines 96.41%/Branches 87.24%；冻结合同零改动。
