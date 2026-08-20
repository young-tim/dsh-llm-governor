# ACCEPTANCE

## 验收命令摘要（全部通过）

| # | 命令 | 结果 |
|---|------|------|
| 1 | `pnpm format:check` | ✅ All files use Prettier code style |
| 2 | `pnpm lint` | ✅ 0 errors, 0 warnings（`--max-warnings 0`） |
| 3 | `pnpm typecheck` | ✅ tsc --noEmit 无错误 |
| 4 | `pnpm test` | ✅ 566 tests passed (27 files) |
| 5 | `pnpm test:contracts` | ✅ 42 tests (rc7+rc8 各 21) |
| 6 | `pnpm test:integration` | ✅ 24 tests (5 fallback + 13 hardening + 6 runtime-wiring) |
| 7 | `pnpm test:ui` | ✅ 6 tests (Playwright chromium) |
| 8 | `pnpm test:eval` | ✅ 1 test (70 examples) |
| 9 | `pnpm test:coverage` | ✅ Lines 96.95%, Statements 96.28%, Functions 97.41%, Branches 90.37% |
| 10 | `pnpm build` | ✅ tsc + 复制 UI 页面到 dist/ui/pages |
| 11 | `pnpm test:package` | ✅ 19 tests (7 tarball + 9 install smoke + 3 真实安装) |
| 12 | `pnpm pack --pack-destination <临时目录>` | ✅ Tarball: dsh-llm-governor-0.1.0.tgz（含 cordis.patch.yml 与 dist/ui/pages） |

## 真实安装链路（本次返工新增）

用真实 dsh CLI（rc.7）把 tgz 安装进临时 DSH_HOME 的 profile，全程不触碰真实 Profile：

| 步骤 | 证据 | 位置 |
|------|------|------|
| `dsh plugin --profile X add <tgz>` 后进入 `dsh.profile.bundles`（profile layer） | 不再出现 "declares no dsh.bundle" 警告 | `test/package/install-real.test.ts` |
| `dsh --profile X --dump-config` 包含 `id: dsh-llm-governor` host 行（带完整 config） | dump 由 dsh 自身组合器渲染 | `test/package/install-real.test.ts` |
| dump 中基础 `llm-retry` 行被 patch 为 `disabled: true` | 标注 `patched by dsh-llm-governor` | `test/package/install-real.test.ts` |
| `dsh plugin --profile X remove dsh-llm-governor` 后 Governor 行消失、llm-retry 恢复启用 | 卸载即恢复默认 retry | `test/package/install-real.test.ts` |

对应实现：`package.json` 声明 `dsh.bundle.patch`；`cordis.patch.yml` 插入 Governor 行并禁用
基础 llm-retry（Recovery Owner 唯一性在 bundle 组合层强制）。

## 运行时接线（本次返工新增）

| 退回意见 | 修复 | 证据 |
|----------|------|------|
| agent/pre-step 直接 next()，自动分类未执行 | pre-step 提取消息文本/图片/Tool 信号 → Hint/Rule 分类器 → 缓存到请求状态，auto 路由使用 | `test/integration/runtime-wiring.test.ts`（coding 分类落库断言） |
| 未绑定身份默认透传 | header/jwt 模式无绑定抛 `IDENTITY_REQUIRED`（fail closed）；local 模式自动绑定进程所有者 | `test/integration/hardening.test.ts > 安全边界` |
| 月度额度仅靠测试开关 | quota admission 按月窗（配置时区）读取已提交 Credits 与限额比较；`setQuotaExceeded` 仅作显式覆盖 | `test/integration/runtime-wiring.test.ts > 月度额度真实计算` |
| SQLite Repository 未接入运行时 | 插件启动即打开 `$DSH_HOME/dsh-llm-governor/governor.db`（WAL，迁移失败 fail closed）；决策/Usage/身份/策略全部落库；重启后恢复且 DB 为策略权威 | `test/integration/runtime-wiring.test.ts > SQLite 运行时持久化` |
| 计费参数与路由模式硬编码 | `tokensPerCredit`/`multiplierPpm`/`routingMode` 全部来自服务配置与模型目录 | `test/integration/runtime-wiring.test.ts > 计费参数与路由模式来自配置` |
| UI 未集成 DSH Client Remote | 插件把 `/governor` 前缀路由注册到 `ctx.webServer`（DSH Web 端口下的受信挂载）；无 webServer 时可独立监听 | `test/package/install.test.ts > 运行时 UI 挂载` |
| 构建不复制 HTML 到 dist/ui/pages | `pnpm build` 执行 `scripts/copy-ui-pages.mjs`；tarball 断言包含三页 | `test/package/install.test.ts` tarball 断言 |

## 验收测试失真修复（本次返工）

| 失真 | 修复 |
|------|------|
| 恢复负责人只断言 `>= 1` | 单独加载断言恰好 1 个 `agent/request-error` listener；组合层唯一性由 cordis.patch.yml 断言 + 真实 dump-config 证明 |
| 测试脚本 `--passWithNoTests` | 全部移除 |
| lint 允许 999 条警告 | `--max-warnings 0`，44 条警告全部清零 |

## Eval 指标

| 指标 | 结果 | 阈值 |
|------|------|------|
| Quality Retention | 95.78% | ≥95% ✅ |
| Auto Credits < Quality First Credits | 157.5 < 210 | ✅ |
| Credit Saving | 25.00% | ≥20% ✅ |

七类任务各 10 例（共 70 例）：general, coding, reasoning, writing, data_analysis, vision, tool_use。

## 覆盖率

| 指标 | 覆盖率 | 门槛 |
|------|--------|------|
| Lines | 96.95% | ≥90% ✅ |
| Statements | 96.28% | ≥90% ✅ |
| Functions | 97.41% | ≥90% ✅ |
| Branches | 90.37% | ≥85% ✅ |
| skip/todo | 0 | =0 ✅ |

## 冻结合同零改动

| 文件 | hash-object (4b0bbb8) | hash-object (当前) | 匹配 |
|------|----------------------|---------------------|------|
| docs/REQUIREMENTS_BASELINE.md | 5a623e6bb7950f1fa0ce4be0bcae551b8d45e6b0 | 5a623e6bb7950f1fa0ce4be0bcae551b8d45e6b0 | ✅ |
| docs/TECHNICAL_DESIGN.md | e43c8cb1a4fe00d97686f0b6a0cef6b5593b8e04 | e43c8cb1a4fe00d97686f0b6a0cef6b5593b8e04 | ✅ |
| docs/IMPLEMENTATION_PLAN.md | 51b97f8244d67e5aab6d50c3e9de62729032a45c | 51b97f8244d67e5aab6d50c3e9de62729032a45c | ✅ |

## 三次反向验证（红→绿证据）

### 1. 双 Recovery Owner 红→绿

- **红**：注册第二个 `agent/request-error` listener（模拟 dsh-llm-retry），检测到 2 个 recovery owner
- **绿**：移除第二 listener，恢复 1 个 recovery owner
- 位置：`test/contracts/contracts.test.ts > recovery owner uniqueness > 故意制造双 Recovery Owner 后可检测，移除后恢复（红→绿证据）`

### 2. Credits 额度耗尽红→绿

- **红**：真实用量耗尽月度额度 → 请求被拒绝（QUOTA_EXCEEDED，不依赖测试开关）
- **绿**：新月份/恢复额度 → 请求被允许
- 位置：`test/integration/runtime-wiring.test.ts > 月度额度真实计算`

### 3. Fallback 上限红→绿

- **红**：`max_attempts=1` → 429 后不重试（undefined）
- **绿**：`max_attempts=2` → 429 后重试（{kind:'retry'}）
- 位置：`test/integration/fallback.test.ts > Fallback 上限红→绿`

## 加固测试覆盖（安全/恢复/并发/月末/数据库损坏/重放）

| 类别 | 测试 | 位置 |
|------|------|------|
| 安全 | header 无绑定 fail closed、local 自动绑定、空 user_id 拒绝、JWT alg=none 禁止 | `test/integration/hardening.test.ts > 安全边界` |
| 恢复 | 迁移失败 fail closed、重启后数据持久化 | `test/integration/hardening.test.ts > 数据库损坏与恢复` |
| 并发 | 同一用户并发请求不互相干扰 | `test/integration/hardening.test.ts > 并发请求` |
| 月末 | monthWindow/monthKey/checkQuota/月末跨界 | `test/integration/hardening.test.ts > 月末额度窗口` |
| 数据库损坏 | 迁移失败时 fail closed | `test/integration/hardening.test.ts > 数据库损坏与恢复` |
| 重放 | usage/decision 幂等（重复 request_id+fallback_index） | `test/integration/hardening.test.ts > 事件重放幂等` |

## 安装 smoke 测试（rc.7/rc.8 临时加载 + 真实安装）

| 测试 | 位置 |
|------|------|
| tarball 包含 dist/plugin/mod.js、cordis.patch.yml、dist/ui/pages 三页 | `test/package/install.test.ts > rc.7 临时安装 smoke` |
| package.json 声明 dsh.bundle.patch 且 main 指向插件入口 | `test/package/install.test.ts > rc.7 临时安装 smoke` |
| cordis.patch.yml 插入 Governor 行并禁用 llm-retry | `test/package/install.test.ts > rc.7 临时安装 smoke` |
| Governor 单独加载恰好 1 个 recovery listener | `test/package/install.test.ts > rc.7 临时安装 smoke` |
| 卸载 Governor 后监听器全部清理 | `test/package/install.test.ts > rc.7 临时安装 smoke` |
| Web/Headless 加载：GovernorPlugin.apply() 成功执行 | `test/package/install.test.ts > rc.7 临时安装 smoke` |
| rc.8 兼容性：Governor 在 rc.8 LlmRuntime 下加载 | `test/package/install.test.ts > rc.8 兼容性验证` |
| webServer 挂载 /governor 前缀路由并处理请求 | `test/package/install.test.ts > 运行时 UI 挂载与默认存储路径` |
| 默认存储路径 $DSH_HOME/dsh-llm-governor/governor.db | `test/package/install.test.ts > 运行时 UI 挂载与默认存储路径` |
| 真实 dsh plugin add / dump-config / remove（临时 DSH_HOME） | `test/package/install-real.test.ts` |

## 未触碰约束

- ✅ 未创建远程仓库、未推送、未发布 npm
- ✅ 未调用真实付费模型（全部使用 FakeLlmAdapter）
- ✅ 未操作真实 DSH_HOME/Profile/凭证（真实安装测试使用临时 DSH_HOME）
- ✅ 包测试只使用临时目录
- ✅ rc.7/rc.8 合同测试各覆盖全部契约
- ✅ 不直连 SQLite（UI 只通过 GovernorService API）
- ✅ 普通用户不能获得管理写权限（PATCH 无 admin token → 403）

## 测试统计

- 总测试数：566
- 合同测试：42（rc7 + rc8 各 21）
- 单元测试：474
- 集成测试：24（5 fallback + 13 hardening + 6 runtime-wiring）
- UI 测试：6（Playwright chromium）
- Eval 测试：1（70 examples）
- 打包测试：19（7 tarball + 9 install smoke + 3 真实安装）
