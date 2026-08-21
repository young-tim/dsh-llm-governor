# DSH LLM Governor

`dsh-llm-governor` 是 DeepSeek Harness 的多模型治理插件。它在 DSH 现有模型调用链上
提供模型画像、用户访问控制、月度 Credits、Manual / Quality First / Credit First /
Auto Routing、失败重路由和 Usage 审计；它不代理模型请求，也不管理 Provider 凭证。
模型选择直接进入 Composer（含 Auto），治理配置进入 DSH 原生 Settings，决策记录在
同一 Session 的 Governor Trajectory 视图中展示；默认不启动独立管理服务。

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

## 账号边界与企业身份接入

Governor 的 `Users` 不是账号目录，而是以外部 `user_id` 为键的治理策略表：它保存
模型 allow list、月度 Credits、用量汇总和管理审计。Governor **不提供**注册、登录、
密码、MFA、组织/群组、会话撤销、SCIM 或 IdP 生命周期管理；在 Settings 中维护一条
User 策略也不会创建一个能登录 DSH 的账号。

当前行为需要特别注意：

- `identity.provider=local` 将整个实例视为一个固定用户，适合个人或单管理员部署。
- `header`、`jwt`、`custom` 模式只有在可信入站组件把身份绑定到具体 DSH Session 后
  才生效；没有绑定时模型请求 fail closed。
- 已认证但未预置策略的 `user_id` 会使用 `credits.default_monthly_credits` 和全局模型
  集合。需要“未开通用户默认禁止”时，应把 `default_monthly_credits` 设为 `0`，再为
  已批准用户显式配置额度。这只会通过额度检查阻止模型分发，不会阻止登录或读取
  其他 DSH 页面。
- 当前 Settings 只修改已有 User 策略，不承担自动开户/离职回收。企业部署应由 IdP、
  SCIM 同步任务或管理插件负责预配置和停用用户；当前版本没有动态创建 User 策略、
  SCIM 同步或立即撤销既有 Session 身份的完整 API。

截至 2026-08-21，本项目针对 DSH `0.1.0-rc.8` 验证；其
[官方配置目录](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.md)
没有统一账号目录或企业 SSO 插件。下表是参考架构，不是已经捆绑或完成兼容认证的
一键集成：

| 场景 | 推荐组合 | 适用边界 |
| --- | --- | --- |
| 个人、本机使用 | Governor `local` identity | 单一 `user_id`，无需账号系统 |
| 单管理员远程访问 | 第三方 [`deepseek-harness-auth` v0.4.0](https://github.com/taichuy/deepseek-harness-auth/tree/v0.4.0) + Governor `local` | 给 DSH HTTP/WebSocket 增加密码门禁；当前内置 provider 是 password，不等同于企业多用户 SSO，也不会自动产生逐用户 Governor 主体。该第三方插件未由本项目做安全审计 |
| 小团队 | Nginx/Caddy + [`oauth2-proxy`](https://oauth2-proxy.github.io/oauth2-proxy/) + 企业 OIDC IdP + DSH identity bridge + Governor `header` | 接入成本较低；依赖受控网络和代理覆盖身份 Header |
| 企业生产（推荐） | Pomerium/企业 IAP + Entra ID、Okta、Keycloak、Authentik 等 IdP + DSH identity bridge + Governor `jwt`/`custom` | 使用签名 JWT 与 IdP 群组做身份、授权和审计映射；适合多用户额度治理 |

这里的 **DSH identity bridge** 是必要的 Host 侧伴生插件/入站适配器，而不是浏览器
脚本。**当前仓库没有提供这个 bridge**，所以下述小团队/企业方案仍需要实现和独立
安全验收。bridge 的最小职责是：

1. 在 Session 首次模型请求前，将已验证的稳定主体绑定到该 Session；
2. 为原生 Governor Remote 提供请求级 `governorPrincipal.current()`，并把 IdP 群组
   映射为 `governor.read`、`governor.manage`、`governor.audit`；
3. 对 HTTP、RPC、SSE 和 WebSocket 使用同一主体，禁止浏览器提交 actor/role；
4. 使用 IdP 不可变 subject/对象 ID 作为 `user_id`，email/name 只作展示属性。

开户、停用、额度同步和既有 Session 撤销属于 provisioning/revocation 集成，可以与
bridge 同包实现，也可以由独立管理插件负责；但当前 Governor API 尚未覆盖完整生命周期，
完成这些 API 和撤销测试前，不应宣称具备 SCIM 或即时离职回收能力。

如果没有这个 bridge，反向代理只能保护“谁可以访问 DSH”，无法安全回答“当前这次
Remote 调用是谁”。因此非 local 模式下 Governor 会让原生 Remote（包括 Settings
读写）返回 401，而不是信任浏览器自报身份。

### Header 与 JWT 两种接法

`header` 模式适合 `oauth2-proxy` 一类可信代理。代理必须删除外部请求中的同名 Header，
重新写入用户标识，并让 DSH 原始端口只对该代理可达。内置 Header provider 只比较
配置的代理标识 Header，不验证 TCP 来源 IP、mTLS 或 Unix socket；因此仅设置一个
可伪造的 `X-Proxy-Id` 不能替代网络隔离：

```yaml
identity:
  provider: header
  header_name: X-Auth-Request-User
  display_name_header: X-Auth-Request-Preferred-Username
  email_header: X-Auth-Request-Email
  trusted_proxy: oauth2-proxy
  proxy_header_name: X-DSH-Trusted-Proxy

credits:
  default_monthly_credits: 0 # 未预配置主体默认禁止模型分发
```

企业环境优先使用 `jwt` 或 `custom`。一种明确的数据流是：bridge 从已认证的入站请求
取得 Session ID，以及承载 Header 中完整、未经解析的 compact JWT/JWS 字符串（不是
JOSE header 段或已解码 claims），再交给 Governor 的 Session bind 入口；内置 `jwt`
provider 校验算法、签名、issuer、audience、`exp` 和 `nbf`。它适合固定 PEM 公钥。
`custom` 不是内置登录器，而是第三方 Host 插件注册的 IdentityProvider 扩展点；
需要 JWKS 自动轮换、群组/租户映射或即时吊销时，应在该扩展和 principal bridge 中
实现并测试，不要把未验签的 JWT claims Header 当作权威身份。Pomerium 的
[签名身份 JWT 说明](https://www.pomerium.com/docs/capabilities/getting-users-identity)和
oauth2-proxy 的[身份 Header 配置](https://oauth2-proxy.github.io/oauth2-proxy/configuration/overview/)
可作为部署参考。

当前 `/governor/api/bind` 只限制为 loopback 调用，尚无独立 bridge 凭证、入站连接与
Session 所属关系证明、跨用户重绑定限制或防重放/会话固定合同；“本机可达”不等于
“调用方可信”。因此它可用于受控 companion ingress，但不能单独作为企业 SSO 的完整
安全边界。生产 bridge 应通过 Host 请求上下文直接建立主体关联，或先补齐上述绑定
协议及越权测试；在此之前，`header`/`jwt` 应视为身份验证基础能力，而非开箱即用的
企业账号管控方案。

### 发布后（计划）

```bash
dsh plugin --profile headless add https://github.com/young-tim/dsh-llm-governor
dsh plugin --profile web add https://github.com/young-tim/dsh-llm-governor
```

## 开发与验收命令

```bash
pnpm install          # 安装依赖
pnpm build            # tsc 编译 + 构建 client bundle + 复制兼容 UI 页面
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
├── client/       # Composer Auto、原生 Settings 与 Trajectory 浏览器入口
├── config/       # 严格 Schema 校验与规范化
├── credits/      # Credits 计算与月度额度
├── dsh-adapter/  # DSH 类型与事件隔离层（含 FakeLlmAdapter）
├── extensions/   # 扩展点注册表
├── fallback/     # 失败重试与重路由状态机
├── identity/     # Local/Header/JWT 身份绑定与 custom provider 扩展点
├── model/        # Canonical 路由与模型目录合并
├── ops/          # 运营导出（CSV 注入防护/限额/假名）与路由指标
├── plugin/       # Cordis 插件入口、GovernorService 与双写审计管道
├── routing/      # Manual/Quality First/Credit First 策略与不可变 Decision
├── storage/      # SQLite Repository（WAL、迁移、幂等、审计状态）
├── ui/           # 显式兼容模式使用的页面与 Bearer host API
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
3. Explain every route：每次决策都记录结构化原因，不记录 Prompt 正文；
   决策先 `pending` → Session Event → `committed`，任何 Provider 调用前
   都存在已提交的不可变 Decision（decisionId + JCS hash 可追溯）。
4. Attempt-level accounting：Fallback 的每次真实模型尝试都单独计量
   （conversation/classifier 双类 Usage，classifier 关联父请求）。
5. No provider proxy：真实模型调用仍由 DSH 的 `ctx.llm` 和 Provider Adapter 完成。
6. Default no extra socket：默认零新增监听端口；兼容 API 仅在显式
   `compatApi.enabled=true` 时监听 loopback（Bearer 鉴权 + capability 矩阵）。
7. Native DSH surfaces：日常模型选择、治理设置和决策追溯复用 DSH 的 Composer、
   Settings 与 Conversation 扩展面；Host service 负责权威状态与权限，不另起默认服务。
