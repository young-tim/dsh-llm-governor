# 依赖清单

## 运行时 peerDependencies

| 包 | 版本范围 | 用途 |
|---|---|---|
| `@deepseek-ai/cordis` | `>=4.0.1 <5` | 插件框架：Context、Service、Events |
| `@deepseek-ai/dsh-agent` | `>=0.1.0-rc.7 <0.2.0-0` | Agent 事件：pre-step、request、request-error |
| `@deepseek-ai/dsh-llm` | `>=0.1.0-rc.7 <0.2.0-0` | LLM 服务：LlmRuntime、LlmAdapter、StreamChunk |
| `@deepseek-ai/dsh-session` | `>=0.1.0-rc.7 <0.2.0-0` | 会话事件：SessionEventMap、Session |

Governor 不引入模型 Proxy 或凭证存储，不直接调用 Provider HTTP API。

## devDependencies（测试与构建）

| 包 | 版本 | 用途 |
|---|---|---|
| `@deepseek-ai/cordis` | `4.0.1` | 合同测试运行时 |
| `@deepseek-ai/dsh-agent` | `0.1.0-rc.7` | rc.7 合同测试 |
| `@deepseek-ai/dsh-llm` | `0.1.0-rc.7` | rc.7 合同测试（FakeLlmAdapter 继承 LlmAdapter） |
| `@deepseek-ai/dsh-session` | `0.1.0-rc.7` | rc.7 合同测试 |
| `dsh-llm-rc8` | `npm:@deepseek-ai/dsh-llm@0.1.0-rc.8` | rc.8 合同测试别名 |
| `dsh-agent-rc8` | `npm:@deepseek-ai/dsh-agent@0.1.0-rc.8` | rc.8 合同测试别名 |
| `dsh-session-rc8` | `npm:@deepseek-ai/dsh-session@0.1.0-rc.8` | rc.8 合同测试别名 |
| `@types/node` | `^24.3.0` | Node 类型 |
| `typescript` | `^5.9.2` | TypeScript 编译 |
| `vitest` | `^4.0.0` | 测试框架 |
| `playwright` | `^1.62.0` | UI 浏览器测试（chromium headless） |

## 兼容策略

- 最低支持 npm latest DSH rc.7，CI 同时验证 rc.8（next）合同。
- DSH 类型、事件、目录与 stream glue 全部隔离到 `src/dsh-adapter/` 与 `src/plugin/`；领域层不 import DSH。
- rc.8 通过 pnpm 别名安装，vitest projects 通过 resolve.alias 在 rc8 工程中将 `@deepseek-ai/dsh-*` 映射到别名包。
