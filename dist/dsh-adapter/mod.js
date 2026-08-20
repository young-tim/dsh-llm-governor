/**
 * DSH 适配层入口：集中 re-export DSH 类型与运行时类，领域层只从这里引用 DSH。
 * DSH 专属代码只能进入 src/dsh-adapter/ 与 src/plugin/。
 */
// Cordis 框架
export { Context, Service } from '@deepseek-ai/cordis';
// DSH LLM 服务
export { LlmRuntime, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
export { callConfigEquals, deepFreeze } from '@deepseek-ai/dsh-llm';
export { SessionId as makeSessionId } from '@deepseek-ai/dsh-session';
