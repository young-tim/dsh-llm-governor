/**
 * FakeLlmAdapter：测试用的确定性 fake DSH LLM 适配器。
 * 不调用真实 Provider HTTP API；流行为由测试脚本配置。
 */
import { LlmAdapter } from './mod.js';
import type { GenerateOptions, StreamChunk, TokenUsage, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, ResolvedRetryPolicy } from './mod.js';
/** 一次 fake 流调用的可配置脚本。 */
export interface FakeStreamScript {
    /** 要产出的文本块内容；为空则不产出文本块。 */
    text?: string;
    /** Token 用量；提供则在 finish 前产出 usage 块。 */
    usage?: TokenUsage;
    /** 完成原因，默认 'stop'。 */
    finish?: 'stop' | 'tool-calls' | 'max-tokens' | 'error' | 'aborted';
    /** finish 为 error/aborted 时的失败信息。 */
    failure?: {
        message: string;
        code: string;
        status?: number;
    };
}
/** 确定性 fake LLM 适配器，用于合同测试与集成测试。 */
export declare class FakeLlmAdapter extends LlmAdapter {
    /** 记录所有 stream 调用的 options，便于断言。 */
    readonly calls: GenerateOptions[];
    private readonly _providers;
    private readonly _models;
    private _script;
    private _retryPolicy;
    /**
     * @param providers - 此适配器服务的 provider 路由列表。
     * @param models - 每个 provider 的建议模型目录。
     * @param script - 流脚本：固定脚本或按调用序号返回脚本的函数。
     */
    constructor(providers: string[], models: LlmModelInfo[], script: FakeStreamScript | ((options: GenerateOptions, callIndex: number) => FakeStreamScript));
    /** 设置重试策略。 */
    setRetryPolicy(policy: ResolvedRetryPolicy | undefined): void;
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
/** 创建一个成功的 fake 流脚本。 */
export declare function successScript(text: string, usage: TokenUsage): FakeStreamScript;
/** 创建一个 429 错误的 fake 流脚本。 */
export declare function rateLimitScript(): FakeStreamScript;
/** 创建一个 5xx 错误的 fake 流脚本。 */
export declare function serverErrorScript(status?: number): FakeStreamScript;
/** 创建一个超时的 fake 流脚本。 */
export declare function timeoutScript(): FakeStreamScript;
/** 创建一个 401 鉴权错误的 fake 流脚本。 */
export declare function authErrorScript(): FakeStreamScript;
