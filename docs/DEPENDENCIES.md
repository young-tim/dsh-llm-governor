# 依赖清单

## 运行时 peerDependencies

| 包 | 版本范围 | 用途 |
|---|---|---|
| `@deepseek-ai/cordis` | `>=4.0.1 <5` | 插件框架：Context、Service、Events |
| `@deepseek-ai/dsh-agent` | `>=0.1.0-rc.8 <0.2.0-0` | Agent 事件：pre-step、request、request-error |
| `@deepseek-ai/dsh-llm` | `>=0.1.0-rc.8 <0.2.0-0` | LLM 服务：LlmRuntime、LlmAdapter、StreamChunk |
| `@deepseek-ai/dsh-session` | `>=0.1.0-rc.8 <0.2.0-0` | 会话事件：SessionEventMap、Session |

Governor 不引入模型 Proxy 或凭证存储，不直接调用 Provider HTTP API。

## devDependencies（测试与构建）

| 包 | 版本 | 用途 |
|---|---|---|
| `@deepseek-ai/cordis` | `4.0.1` | 合同测试运行时 |
| `@deepseek-ai/dsh` | `0.1.0-rc.8` | CLI、真实安装与 Web smoke |
| `@deepseek-ai/dsh-agent` | `0.1.0-rc.8` | Agent 合同测试 |
| `@deepseek-ai/dsh-llm` | `0.1.0-rc.8` | LLM 合同测试（FakeLlmAdapter 继承 LlmAdapter） |
| `@deepseek-ai/dsh-session` | `0.1.0-rc.8` | Session 合同测试 |
| `@types/node` | `^24.3.0` | Node 类型 |
| `typescript` | `^5.9.2` | TypeScript 编译 |
| `vitest` | `^4.0.0` | 测试框架 |
| `playwright` | `^1.62.0` | UI 浏览器测试（chromium headless） |

## 兼容策略

- 仓库直接依赖、CLI 和合同测试统一使用 DSH rc.8；lockfile 保证同一个 DSH 包只解析
  一个版本，不使用版本别名构造双版本矩阵。
- DSH 类型、事件、目录与 stream glue 全部隔离到 `src/dsh-adapter/` 与 `src/plugin/`；领域层不 import DSH。
- rc.8 上游自身仍依赖少量 rc.7 基础包（当前包括 invariants、scope、timeout）；这些包
  各自只有一个解析版本，不属于同包多版本混装。
- 如需验证未来 DSH 版本，使用隔离的 CI workspace，不向主仓库加入版本别名。
