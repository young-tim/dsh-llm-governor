# DSH LLM Governor

`dsh-llm-governor` 是 DeepSeek Harness 的多模型治理插件。它在 DSH 现有模型调用链上
提供模型画像、用户访问控制、月度 Credits、Manual / Quality First / Credit First /
Auto Routing、失败重路由和 Usage 审计；它不代理模型请求，也不管理 Provider 凭证。

## 文档

- [需求基线](docs/REQUIREMENTS_BASELINE.md)
- [技术方案](docs/TECHNICAL_DESIGN.md)
- [实施与验收计划](docs/IMPLEMENTATION_PLAN.md)
- [依赖清单与兼容策略](docs/DEPENDENCIES.md)
- [示例配置](examples/governor.yml)

## 安装

### 本地验证（tarball）

```bash
pnpm install
pnpm build
pnpm pack --pack-destination <临时目录>
dsh plugin --profile <profile> add <临时目录>/dsh-llm-governor-<version>.tgz
```

真实安装链路（add → `--dump-config` → remove）已在临时 DSH_HOME 中通过真实 dsh
CLI 验证，见 `test/package/install-real.test.ts`。

### DSH 运行时与 Provider 凭证

Governor 只负责选路、额度、Fallback 和审计，模型调用及凭证读取仍由 DSH 负责：

```text
Governor → DSH ctx.llm → DSH Provider Adapter → DSH Credentials Service → Provider
```

- Governor 不读取、保存或要求 `DEEPSEEK_API_KEY`。
- DSH 必须能为最终选中的 Provider 取得对应凭证；可以使用 DSH Models/Credentials
  Service 中已保存的凭证，也可以使用该 Provider 支持的环境变量。
- 只有当路由选中 `deepseek-official`，且 DSH 中没有可用的已保存凭证时，
  `DEEPSEEK_API_KEY` 才可能成为 DSH Provider Adapter 的配置项。选择其他 Provider
  时，应配置该 Provider 自己所需的凭证。
- 临时 `DSH_HOME` 验收不会复制真实 Profile 的凭证。真实启动已经验证 Governor
  被 DSH 加载、严格配置生效、SQLite 数据库完成初始化，并进入 DSH Provider
  调用阶段；随后出现 `MISSING_CREDENTIAL` 表示测试环境缺少 DSH Provider 凭证，
  不表示 Governor 依赖 DeepSeek API Key，也不代表已完成真实付费模型调用。
- 无外部模型费用的端到端功能验收使用真实 Cordis/DSH `LlmRuntime` 配合
  `FakeLlmAdapter`，覆盖选路、流式输出、Fallback、Usage 和 Credits。

### 发布后（计划）

```bash
dsh plugin --profile headless add https://github.com/young-tim/dsh-llm-governor
dsh plugin --profile web add https://github.com/young-tim/dsh-llm-governor
```

## 开发与验收命令

```bash
pnpm install          # 安装依赖
pnpm build            # tsc 编译 + 复制 UI 页面到 dist/ui/pages
pnpm typecheck        # 类型检查
pnpm lint             # ESLint（--max-warnings 0）
pnpm format:check     # Prettier 检查
pnpm test             # 全量测试
pnpm test:contracts   # rc.8 合同测试
pnpm test:unit        # 单元测试
pnpm test:integration # 集成测试（Fallback / 加固 / 运行时接线）
pnpm test:ui          # Playwright UI 测试
pnpm test:eval        # Eval 数据集（Quality Retention / Credit Saving）
pnpm test:coverage    # 覆盖率
pnpm test:package     # tarball / 安装 smoke / 真实安装
```

## 技术基线

- TypeScript ESM
- Node.js `^22.19.0 || >=24.0.0`
- pnpm 11
- SQLite（WAL，整数定点 Credits）
- DSH 兼容版本范围以 [package.json](package.json) 的 `peerDependencies` 为准；
  兼容策略（npm `latest` 最低版本 + `next` 合同测试）见
  [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md)

## 目录

```text
src/
├── access/       # 访问控制与能力过滤
├── classifier/   # Hint/Rule/LLM 分类器与缓存
├── config/       # 严格 Schema 校验与规范化
├── credits/      # Credits 计算与月度额度
├── dsh-adapter/  # DSH 类型与事件隔离层（含 FakeLlmAdapter）
├── extensions/   # 扩展点注册表
├── fallback/     # 失败重试与重路由状态机
├── identity/     # Local/Header/JWT 身份绑定
├── model/        # Canonical 路由与模型目录合并
├── plugin/       # Cordis 插件入口与 GovernorService
├── routing/      # Manual/Quality First/Credit First 策略
├── storage/      # SQLite Repository（WAL、迁移、幂等）
├── ui/           # Models/Users/Usage 页面与 host API
└── usage/        # Usage 计量与聚合

test/
├── contracts/    # rc.8 合同测试
├── eval/         # 七类任务 Eval 数据集
├── integration/  # 运行时接线 / 加固 / Fallback
├── package/      # tarball、安装 smoke、真实安装
├── ui/           # Playwright 页面测试
└── unit/         # 领域单元测试
```

## 设计原则

1. Fail closed：身份、权限、额度或能力无法确认时不发起模型请求。
2. One recovery owner：Governor 启用时统一负责模型调用失败后的重试/重路由。
3. Explain every route：每次决策都记录结构化原因，不记录 Prompt 正文。
4. Attempt-level accounting：Fallback 的每次真实模型尝试都单独计量。
5. No provider proxy：真实模型调用仍由 DSH 的 `ctx.llm` 和 Provider Adapter 完成。
