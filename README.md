# DSH LLM Governor

`dsh-llm-governor` 是 DeepSeek Harness 的多模型治理插件方案。它在 DSH
现有模型调用链上提供模型画像、用户访问控制、月度 Credits、Manual / Quality
First / Credit First / Auto Routing、失败重路由和 Usage 审计；它不代理模型请求，
也不管理 Provider 凭证。

## 当前状态

仓库已完成技术设计与工程骨架，尚未实现可安装插件。实现不得早于 DSH 契约 Spike
通过，尤其是 `agent/request`、`agent/request-error`、`llm/stream`、身份绑定和 Web
Client Remote 五个集成点。

## 文档

- [需求基线](docs/REQUIREMENTS_BASELINE.md)
- [技术方案](docs/TECHNICAL_DESIGN.md)
- [实施与验收计划](docs/IMPLEMENTATION_PLAN.md)
- [示例配置](examples/governor.yml)

## 计划中的安装方式

实现完成并发布后，目标安装方式为：

```bash
dsh plugin --profile headless add github:<owner>/dsh-llm-governor
dsh plugin --profile web add github:<owner>/dsh-llm-governor
```

当前仓库没有远程地址，也没有发布 npm 包。不要把设计骨架安装到真实 DSH Profile。

## 技术基线

- TypeScript ESM
- Node.js `^22.19.0 || >=24.0.0`
- pnpm 11
- DSH npm `latest`: `0.1.0-rc.7`
- DSH 主干 / npm `next`: `0.1.0-rc.8`
- SQLite（WAL，整数定点 Credits）

DSH 仍处于 developer preview。首个实现版本以 rc.7 为最低兼容版本，同时在 CI
中增加 rc.8 合同测试；所有上游 API 只能通过 `src/dsh-adapter/` 使用。

## 目录

```text
src/
├── access/
├── classifier/
├── config/
├── credits/
├── dsh-adapter/
├── fallback/
├── identity/
├── model/
├── plugin/
├── routing/
├── storage/
├── ui/
└── usage/
```

## 设计原则

1. Fail closed：身份、权限、额度或能力无法确认时不发起模型请求。
2. One recovery owner：Governor 启用时统一负责模型调用失败后的重试/重路由。
3. Explain every route：每次决策都记录结构化原因，不记录 Prompt 正文。
4. Attempt-level accounting：Fallback 的每次真实模型尝试都单独计量。
5. No provider proxy：真实模型调用仍由 DSH 的 `ctx.llm` 和 Provider Adapter 完成。

