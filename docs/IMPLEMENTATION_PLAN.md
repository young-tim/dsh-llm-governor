# DSH LLM Governor 实施与验收计划

## 1. 交付策略

分六个可独立验收的阶段推进。每个阶段结束时必须通过其测试，不把兼容性风险推到
最后。

## 2. Phase 0：DSH 契约 Spike

目标：用最少代码证明 Governor 能正确嵌入当前 DSH，而不开始业务实现。

必须证明：

- `ctx.llm.listProviders()` 与 `listModels(provider)` 能得到活动路由和建议模型目录。
- `agent/pre-step` 能读取本步新消息，并为同 turn 的后续 tool step 复用分类。
- `agent/request` 能替换 provider/model，替换结果进入 `request/header`。
- `llm/stream` 包装器能观察 usage、finish、首个语义 chunk 和时延，不消费或乱序流。
- `agent/request-error` 返回 retry 后，同 turn/step 会再次经过 `agent/request`。
- Governor 与官方 `dsh-llm-retry` 只有一个 Recovery Owner；最终 bundle 组合可被
  `dsh --profile <profile> --dump-config` 证明。
- Header/JWT 身份能在 Web 入站边界绑定到 session；如果 rc.7 没有稳定 Hook，验证
  companion ingress adapter，而不是从 `agent/request` 猜 HTTP Header。
- Web Client 能通过受信 Remote 调用 host service，并注册 Models / Users / Usage
  页面。

退出条件：全程只用 fake adapter、临时 DSH_HOME、临时 SQLite，无网络模型调用。

## 3. Phase 1：纯领域核心

实现 config、model、access、credits、routing 纯函数：

- 严格 Schema、默认值、未知字段拒绝、倍率定点转换。
- Canonical route id、模型目录合并和显式碰撞处理。
- Access / Capability / Enabled / availability 候选过滤。
- Manual、Quality First、Credit First 的稳定排序和错误码。
- 月份边界与 Credits nano 计算。

退出条件：属性测试覆盖排序稳定性；任意候选输入顺序不改变结果。

## 4. Phase 2：Auto 与 Decision Record

实现 Hint、Rule、LLM 分类器、缓存和低置信度保护：

- Rule classifier 不调用模型。
- LLM classifier 只能通过 `ctx.llm`，temperature=0，严格解析固定 JSON。
- 分类缓存键包含规范化输入哈希、分类器路由、Prompt 版本和配置 revision。
- 分类失败、超时、非法 JSON 或低置信度均切 Quality First。
- 每次决策生成结构化 candidates / excluded / selected，不保存 Prompt 正文。

退出条件：七类任务 fixture 稳定，重复输入命中缓存，Decision Record 可解释。

## 5. Phase 3：Fallback、Usage 与 SQLite

实现 attempt 状态机、流观察、失败重路由和幂等落库：

- 同一 `(session, turn, step)` 首次决策创建 request_id。
- 每次失败加入 excluded route；下一次 request 重新运行原策略。
- `max_attempts` 包含首次调用，取消、鉴权错误、非法请求不 Fallback。
- 默认禁止首个语义 chunk 后透明 Fallback，避免重复输出和 Tool 副作用。
- Usage 唯一键防止事件重放造成双计费。
- WAL、事务、迁移、索引、备份与损坏失败策略完成。

退出条件：A 失败 B 成功生成两个 Usage、两个 Decision attempt、一个 request_id。

## 6. Phase 4：Identity、Quota 与 Web UI

- Local / Header / JWT / Custom IdentityProvider。
- JWT 强制签名、算法、issuer、audience、exp/nbf 校验；禁止只 decode 不 verify。
- Header 模式只信任明确代理来源，并要求代理删除外部同名 Header。
- Models / Users / Usage 三页和 host API。
- DSH 进程所有者是 MVP 管理员；不把普通 user_id 当管理员。

退出条件：未绑定身份、伪造 Header、无效 JWT、越权模型和额度耗尽均 fail closed。

## 7. Phase 5：Eval、打包与发布证据

- 固定七类任务 Eval Dataset。
- 对同一数据集运行 Quality First 与 Auto。
- 输出 Quality Retention 与 Credit Saving，样本量和分母透明。
- 临时 Profile 安装 tarball，验证 headless 和 web 的加载、卸载与恢复默认 retry。
- 生成兼容矩阵：npm latest rc.7 与 next rc.8。

发布门槛：

```text
Quality Retention >= 95%
Auto Credits < Quality First Credits
目标 Credit Saving >= 20%
```

## 8. 测试矩阵

### Unit

- 配置边界、倍率定点换算、月份边界、Access、Capability。
- 四种路由策略、所有 tie-break、低置信度、无候选。
- 429 / Timeout / 5xx / 401 / abort / partial output 的恢复判定。

### Contract

- rc.7 和 rc.8 的 LlmCallConfig、Session Event、StreamChunk fixture。
- 模型目录为空、模型不在建议目录但 Provider 接受的 advisory 行为。
- DSH 上游增加未知事件或 finish reason 时失败可诊断。

### Integration

- fake provider 成功、429、Timeout、5xx、部分输出、usage 缺失、abort。
- 同用户并发请求、月末跨界、Fallback 逼近额度。
- SQLite 重启恢复、事件重放、重复 request-error、迁移失败。
- Header/JWT 信任边界、Web Remote 未授权写入。

### Package

- `pnpm pack` 后安装到临时 DSH_HOME。
- `--dump-config` 证明 Governor 加载且只有一个 Recovery Owner。
- 卸载后基础 `llm-retry` 恢复。
- 不读取或修改真实 Profile、真实凭证、真实 Provider。

## 9. 完成定义

完成意味着：干净 checkout 能安装依赖、构建、运行全部 fake-adapter 测试、打包到
临时 DSH Profile；四种策略、身份、Access、Quota、Fallback 和 Usage 均通过需求
基线；Web 三页能操作同一 host service；Eval 指标达标；无 skip/todo、无真实模型
费用、无明文凭证或 Prompt 落库。

