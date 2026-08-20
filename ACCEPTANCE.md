# ACCEPTANCE

## 验收命令摘要（全部通过）

| # | 命令 | 结果 |
|---|------|------|
| 1 | `pnpm format:check` | ✅ All files use Prettier code style |
| 2 | `pnpm lint` | ✅ 0 errors (44 warnings, ≤999 allowed) |
| 3 | `pnpm typecheck` | ✅ tsc --noEmit 无错误 |
| 4 | `pnpm test` | ✅ 552 tests passed (25 files) |
| 5 | `pnpm test:contracts` | ✅ 42 tests (rc7+rc8 各 21) |
| 6 | `pnpm test:integration` | ✅ 17 tests (5 fallback + 12 hardening) |
| 7 | `pnpm test:ui` | ✅ 6 tests (Playwright chromium) |
| 8 | `pnpm test:eval` | ✅ 1 test (70 examples) |
| 9 | `pnpm test:coverage` | ✅ Lines 97.12%, Statements 97.12%, Functions 98.31%, Branches 91.23% |
| 10 | `pnpm build` | ✅ tsc -p tsconfig.json 无错误 |
| 11 | `pnpm test:package` | ✅ 12 tests (7 tarball + 5 install smoke) |
| 12 | `pnpm pack --pack-destination /tmp/gov-final4` | ✅ Tarball: dsh-llm-governor-0.1.0.tgz |

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
| Lines | 97.12% | ≥90% ✅ |
| Statements | 97.12% | ≥90% ✅ |
| Functions | 98.31% | ≥90% ✅ |
| Branches | 91.23% | ≥85% ✅ |
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

- **红**：`setQuotaExceeded('user-1', true)` → 请求被拒绝（NO_MODEL_MATCHED）
- **绿**：`setQuotaExceeded('user-1', false)` → 请求被允许（model-a）
- 位置：`test/integration/fallback.test.ts > Credits 额度耗尽红→绿`

### 3. Fallback 上限红→绿

- **红**：`max_attempts=1` → 429 后不重试（undefined）
- **绿**：`max_attempts=2` → 429 后重试（{kind:'retry'}）
- 位置：`test/integration/fallback.test.ts > Fallback 上限红→绿`

## 加固测试覆盖（安全/恢复/并发/月末/数据库损坏/重放）

| 类别 | 测试 | 位置 |
|------|------|------|
| 安全 | 无身份 session、空 user_id 拒绝、JWT alg=none 禁止 | `test/integration/hardening.test.ts > 安全边界` |
| 恢复 | 迁移失败 fail closed、重启后数据持久化 | `test/integration/hardening.test.ts > 数据库损坏与恢复` |
| 并发 | 同一用户并发请求不互相干扰 | `test/integration/hardening.test.ts > 并发请求` |
| 月末 | monthWindow/monthKey/checkQuota/月末跨界 | `test/integration/hardening.test.ts > 月末额度窗口` |
| 数据库损坏 | 迁移失败时 fail closed | `test/integration/hardening.test.ts > 数据库损坏与恢复` |
| 重放 | usage/decision 幂等（重复 request_id+fallback_index） | `test/integration/hardening.test.ts > 事件重放幂等` |

## 安装 smoke 测试（rc.7/rc.8 临时安装）

| 测试 | 位置 |
|------|------|
| tarball 解压后包含 dist/plugin/mod.js | `test/package/install.test.ts > rc.7 临时安装 smoke` |
| Governor 加载后独占 recovery（base llm-retry 被禁用） | `test/package/install.test.ts > rc.7 临时安装 smoke` |
| 卸载 Governor 后基础 retry 恢复 | `test/package/install.test.ts > rc.7 临时安装 smoke` |
| Web/Headless 加载：GovernorPlugin.apply() 成功执行 | `test/package/install.test.ts > rc.7 临时安装 smoke` |
| rc.8 兼容性：Governor 在 rc.8 LlmRuntime 下加载 | `test/package/install.test.ts > rc.8 兼容性验证` |

## 未触碰约束

- ✅ 未创建远程仓库、未推送、未发布 npm
- ✅ 未调用真实付费模型（全部使用 FakeLlmAdapter）
- ✅ 未操作真实 DSH_HOME/Profile/凭证
- ✅ 包测试只使用临时目录
- ✅ rc.7/rc.8 合同测试各覆盖全部契约
- ✅ 不直连 SQLite（UI 只通过 GovernorService API）
- ✅ 普通用户不能获得管理写权限（PATCH 无 admin token → 403）

## 测试统计

- 总测试数：552
- 合同测试：42（rc7 + rc8 各 21）
- 单元测试：474
- 集成测试：17（5 fallback + 12 hardening）
- UI 测试：6（Playwright chromium）
- Eval 测试：1（70 examples）
- 打包测试：12（7 tarball + 5 install smoke）
