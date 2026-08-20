/**
 * Classifier 模块共享类型。
 *
 * 分类结果固定为 { taskType, complexity, confidence, source }，
 * 顺序与来源（hint / rule / llm）由编排器统一记录。
 *
 * 该模块为领域层，不导入任何 DSH 包；TaskType、Complexity 从根 index 复用。
 */
import type { TaskType, Complexity } from '../index.js';

/**
 * 分类结果。
 *
 * - taskType：任务类型，决定 Quality 维度排序键。
 * - complexity：复杂度，映射到 minimum_quality 阈值（low 75 / medium 85 / high 92）。
 * - confidence：0..1 的置信度，低于阈值时切 Quality First。
 * - source：分类来源，用于 Decision Record 与可观测性。
 */
export interface Classification {
  taskType: TaskType;
  complexity: Complexity;
  confidence: number;
  source: 'hint' | 'rule' | 'llm';
}

/**
 * 分类器输入。
 *
 * - messages：本步新消息（不携带历史），text 可空（如纯图片消息）。
 * - hasImage：是否存在图片输入。
 * - hasToolContext：是否处于 Tool 调用上下文（agent preset / tool step）。
 * - explicitHint：调用方显式 route hint，如 "coding"。
 */
export interface ClassifyInput {
  messages: ReadonlyArray<{ type: string; text?: string }>;
  hasImage?: boolean;
  hasToolContext?: boolean;
  explicitHint?: string;
}

/**
 * LLM 分类后端接口。
 *
 * 由 plugin 层注入，调用 ctx.llm.stream() 完成轻量模型分类。
 * 领域层不直连 Provider，也不感知具体 LLM 客户端。
 */
export interface LlmClassifierBackend {
  /** 对输入执行 LLM 分类，返回严格 JSON 解析后的结果。 */
  classify(input: ClassifyInput): Promise<Classification>;
}

/**
 * 分类结果缓存接口。
 *
 * 缓存键为：规范化输入哈希 + classifier route + Prompt 版本 + 配置 revision。
 * 由调用方（编排器）负责拼装键。
 */
export interface ClassifierCache {
  /** 取缓存；未命中返回 undefined。 */
  get(key: string): Classification | undefined;
  /** 写缓存。 */
  set(key: string, value: Classification): void;
}
