/**
 * DSH 适配层入口：集中 re-export DSH 类型与运行时类，领域层只从这里引用 DSH。
 * DSH 专属代码只能进入 src/dsh-adapter/ 与 src/plugin/。
 */

// Cordis 框架
export { Context, Service } from '@deepseek-ai/cordis';
export type { Fiber, Plugin } from '@deepseek-ai/cordis';

// DSH LLM 服务
export { LlmRuntime, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
export type {
  LlmCallConfig,
  LlmCallConfigAdapterDefaults,
  GenerateOptions,
  StreamChunk,
  TokenUsage,
  LlmFailure,
  FinishReason,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  LlmConfigurableProvider,
  ContentBlock,
  ContentBlockType,
  ContentBlockMap,
  Message,
  TextBlock,
  ReasoningBlock,
  ImageBlock,
  ToolCallBlock,
  ToolResultBlock,
  ToolSchema,
  AssistantProvenance,
  ReplayEnvelope,
} from '@deepseek-ai/dsh-llm';
export type {
  ResolvedRetryPolicy,
  ResolvedNormalRetryPolicy,
  ResolvedAlwaysRetryPolicy,
  RetryPolicyConfig,
} from '@deepseek-ai/dsh-llm';
export { callConfigEquals, deepFreeze } from '@deepseek-ai/dsh-llm';

// DSH Agent 事件类型
export type {
  Agent,
  AgentOptions,
  AgentStatus,
  PreStepDecision,
  RequestErrorAction,
  SessionStartSource,
  CancelOptions,
} from '@deepseek-ai/dsh-agent';
export type { InboxTarget } from '@deepseek-ai/dsh-agent';

// DSH Session 类型
export type {
  Session,
  SessionId,
  SessionEvent,
  SessionEventMap,
  SessionEventType,
  SessionHeader,
  EpochHeader,
  RequestContext,
  TurnEndReason,
  AgentCancelCause,
} from '@deepseek-ai/dsh-session';
export { SessionId as makeSessionId } from '@deepseek-ai/dsh-session';

// DSH LLM brand 类型
export type { CallId, ProviderRequestId, ReasoningEffortId, MessageId } from '@deepseek-ai/dsh-llm';
