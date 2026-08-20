/**
 * FakeLlmAdapter：测试用的确定性 fake DSH LLM 适配器。
 * 不调用真实 Provider HTTP API；流行为由测试脚本配置。
 */
import { LlmAdapter } from './mod.js';
import type {
  GenerateOptions,
  StreamChunk,
  TokenUsage,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
} from './mod.js';

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

/** 将脚本转为 StreamChunk 异步迭代器。 */
async function* scriptToChunks(script: FakeStreamScript): AsyncIterable<StreamChunk> {
  if (script.text !== undefined && script.text.length > 0) {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: script.text };
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: script.text },
    };
  }
  if (script.usage) {
    yield { type: 'usage', usage: script.usage };
  }
  const finish = script.finish ?? 'stop';
  if (finish === 'error' || finish === 'aborted') {
    const failure: { message: string; code: string; status?: number } = {
      message: script.failure?.message ?? 'fake error',
      code: script.failure?.code ?? 'FAKE_ERROR',
    };
    if (script.failure?.status !== undefined) {
      failure.status = script.failure.status;
    }
    yield {
      type: 'finish',
      reason: { kind: finish, failure },
    };
  } else {
    yield { type: 'finish', reason: { kind: finish } };
  }
}

/** 确定性 fake LLM 适配器，用于合同测试与集成测试。 */
export class FakeLlmAdapter extends LlmAdapter {
  /** 记录所有 stream 调用的 options，便于断言。 */
  readonly calls: GenerateOptions[] = [];
  private readonly _providers: string[];
  private readonly _models: Map<string, LlmModelInfo[]>;
  private _script:
    FakeStreamScript | ((options: GenerateOptions, callIndex: number) => FakeStreamScript);
  private _retryPolicy: ResolvedRetryPolicy | undefined;

  /**
   * @param providers - 此适配器服务的 provider 路由列表。
   * @param models - 每个 provider 的建议模型目录。
   * @param script - 流脚本：固定脚本或按调用序号返回脚本的函数。
   */
  constructor(
    providers: string[],
    models: LlmModelInfo[],
    script: FakeStreamScript | ((options: GenerateOptions, callIndex: number) => FakeStreamScript),
  ) {
    super();
    this._providers = providers;
    const map = new Map<string, LlmModelInfo[]>();
    for (const m of models) {
      let list = map.get(m.provider);
      if (!list) {
        list = [];
        map.set(m.provider, list);
      }
      list.push(m);
    }
    this._models = map;
    this._script = script;
  }

  /** 设置重试策略。 */
  setRetryPolicy(policy: ResolvedRetryPolicy | undefined): void {
    this._retryPolicy = policy;
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider };
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return this._retryPolicy;
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this._models.get(provider) ?? [];
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const list = this._models.get(provider) ?? [];
    const found = list.find((m) => m.id === model);
    if (!found) {
      return {
        provider,
        id: model,
        name: model,
        context: { contextWindow: 128_000 },
      };
    }
    return { ...found, context: { contextWindow: 128_000 } };
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const callIndex = this.calls.length;
    this.calls.push(options);
    const script =
      typeof this._script === 'function' ? this._script(options, callIndex) : this._script;
    yield* scriptToChunks(script);
  }
}

/** 创建一个成功的 fake 流脚本。 */
export function successScript(text: string, usage: TokenUsage): FakeStreamScript {
  return { text, usage, finish: 'stop' };
}

/** 创建一个 429 错误的 fake 流脚本。 */
export function rateLimitScript(): FakeStreamScript {
  return {
    finish: 'error',
    failure: { message: 'rate limited', code: 'RATE_LIMIT', status: 429 },
  };
}

/** 创建一个 5xx 错误的 fake 流脚本。 */
export function serverErrorScript(status = 503): FakeStreamScript {
  return {
    finish: 'error',
    failure: { message: 'server error', code: 'SERVER_ERROR', status },
  };
}

/** 创建一个超时的 fake 流脚本。 */
export function timeoutScript(): FakeStreamScript {
  return {
    finish: 'error',
    failure: { message: 'request timed out', code: 'TIMEOUT' },
  };
}

/** 创建一个 401 鉴权错误的 fake 流脚本。 */
export function authErrorScript(): FakeStreamScript {
  return {
    finish: 'error',
    failure: { message: 'unauthorized', code: 'AUTH', status: 401 },
  };
}
