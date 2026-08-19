# DSH LLM Governor 需求基线

状态：产品边界基线，2026-08-20。

## 1. 产品目标

Governor 只解决六类问题：

1. 模型管理：在 DSH 已配置模型上补充 Enabled、Multiplier、Capability、Quality。
2. 用户治理：获取稳定 `user_id`，控制模型白名单和月度 Credits。
3. Routing：支持 Manual、Quality First、Credit First、Auto。
4. Auto Routing：识别任务类型与复杂度，在达到质量门槛后优化 Credits。
5. Fallback：429、Timeout、5xx 或 Provider Unavailable 时排除失败路由并重新决策。
6. Usage：记录每次真实模型尝试的 Token、Credits、路由、时延、结果和 Fallback。

不开发账号系统、组织架构、SSO Server、复杂 RBAC、审批流、金额财务、模型
Proxy、Credential 管理或通用监控平台。

## 2. 固定任务与策略词表

任务类型：`general`、`coding`、`reasoning`、`writing`、`data_analysis`、
`vision`、`tool_use`。

复杂度：`low`、`medium`、`high`。

路由模式：`manual`、`quality_first`、`credit_first`、`auto`。

Quality 取值为闭区间 `0..100`。Multiplier 默认 `1x`。默认换算为
`1,000,000 Tokens = 1 Credit`。

## 3. 核心规则

- Disabled 模型永远不能成为候选。
- Manual 保留用户选择，但仍必须通过 Enabled、Access、Quota、Capability 检查。
- Quality First 先过滤再按任务 Quality 降序，平分时优先低 Multiplier。
- Credit First 不允许直接选择最便宜模型；先满足 `minimum_quality`，再按
  Multiplier 升序选择。无模型达标时返回 `NO_MODEL_MATCHED`，除非显式配置回退
  Quality First。
- Auto 按 Hint → Rule → LLM 的顺序分类；低于置信度阈值时切 Quality First。
- Auto 在质量门槛内选择低 Multiplier 模型，并保存结构化 Decision Record。
- Access 对 Manual、Auto 和 Fallback 一视同仁。
- 达到月度额度后，拒绝新的模型尝试；额度按配置时区的自然月统计。
- Fallback 每次重新运行当前策略，失败模型进入本逻辑请求的排除集合。
- 同一逻辑请求的多次尝试共享 `request_id`，每次实际模型调用分别产生 Usage。

## 4. Credits

概念公式：

```text
credits = total_tokens / tokens_per_credit * multiplier
```

其中 `total_tokens` 使用 DSH 的互斥 Token 字段：未缓存输入 + cache read +
cache write + 输出；`reasoningTokens` 已包含在输出内，不得重复累计。实现使用整数
定点数，不使用二进制浮点累计额度。

## 5. 管理界面

Web Profile 提供三个页面：

- Models：Enabled、Multiplier、Capability、Quality。
- Users：User、Allow Models、Monthly Credits、Used Credits。
- Usage：按 User、Model、Routing、时间筛选，展示 Token、Credits、Selected
  Model、Fallback、Latency。

用户来自 Identity Provider，不提供用户创建和删除。

## 6. 扩展接口

只承诺四个领域扩展点：

- `IdentityProvider`
- `TaskClassifier`
- `RoutingStrategy`
- `ModelQualityProvider`

DSH 适配层和 Web 身份入口属于基础设施契约，不扩张产品能力边界。

## 7. 总体验收

1. 读取 DSH 已配置模型并合并治理画像。
2. 配置 Quality、Capability、Multiplier 和 Enabled，Multiplier 默认 1x。
3. Local、Header、JWT 获取稳定 user_id；Custom Provider 可扩展。
4. 模型白名单覆盖 Manual、Auto、Fallback。
5. 月度 Credits 换算准确，额度耗尽后拒绝新的实际尝试。
6. Quality First 确定性选择质量最高的合格模型。
7. Credit First 只在质量达标集合内选择最低倍率模型。
8. Auto 完成 Task + Complexity 分类，低置信度保护生效。
9. 429、Timeout、5xx 自动排除失败路由并重新决策，且不无限重试。
10. 每次真实调用正确记录 User、Model、Token、Credits、Routing、Fallback。
11. 固定 Eval Dataset 上 `Quality Retention >= 95%`。
12. 同一数据集上 `Auto Credits < Quality First Credits`，建议节省至少 20%。

