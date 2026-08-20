/**
 * Eval 测试：对固定数据集运行 Quality First 和 Auto 路由策略，
 * 验证 Auto 路由的质量保持率（≥ 95%）与 Credit 节省率（≥ 20%）。
 *
 * 三档模型：
 * - model-premium: quality 最高, multiplier=2 → 总是选 premium（Quality First）
 * - model-standard: quality 中等, multiplier=1 → 中复杂度任务达标且更便宜
 * - model-lite: quality 较低但低复杂度任务达标, multiplier=0.25 → 低复杂度选 lite
 *
 * 设计要点：
 * - Quality First 总是选 premium（该 task_type 质量最高）
 * - Auto 按 classifier 分类结果映射复杂度到 minimum_quality，再执行 Credit First
 * - 低/中复杂度选 cheaper 模型（lite 或 standard），高复杂度选 premium
 * - 每个 example 模拟 1000 input tokens + 500 output tokens = 1500 tokens
 * - credits = tokens * multiplier / tokens_per_credit
 */
import { describe, it, expect } from 'vitest';
import type { TaskType } from '../../src/index.js';
import { routeQualityFirst, routeAuto } from '../../src/routing/index.js';
import type { FilterInput } from '../../src/routing/index.js';
import type { ModelSnapshot } from '../../src/model/canonical.js';
import { createClassifier } from '../../src/classifier/index.js';
import type {
  ClassifyInput,
  LlmClassifierBackend,
  Classification,
} from '../../src/classifier/index.js';
import { computeCreditNanos, nanosToCredits } from '../../src/credits/index.js';
import { EVAL_DATASET } from './dataset.js';

// ===== 常量 =====

/** 每个样例模拟的 input tokens。 */
const INPUT_TOKENS = 1000;
/** 每个样例模拟的 output tokens。 */
const OUTPUT_TOKENS = 500;
/** tokens_per_credit 换算基数。 */
const TOKENS_PER_CREDIT = 1000;
/** Auto 路由置信度阈值：低于此值时切 Quality First。 */
const CONFIDENCE_THRESHOLD = 0.5;

// ===== 模型与过滤输入 =====

/**
 * 构造 ModelSnapshot。
 * @param routeId - `provider:model` 格式的 canonical route。
 * @param multiplierPpm - 倍率（ppm），1x = 1_000_000。
 * @param quality - 各 task_type 的质量分。
 * @returns 模型快照。
 */
function makeSnapshot(
  routeId: string,
  multiplierPpm: number,
  quality: Readonly<Record<TaskType, number>>,
): ModelSnapshot {
  const idx = routeId.indexOf(':');
  const provider = routeId.slice(0, idx);
  const model = routeId.slice(idx + 1);
  return {
    routeId,
    provider,
    model,
    enabled: true,
    multiplierPpm,
    capabilities: [],
    quality,
    name: model,
    inAdvisory: true,
  };
}

/** 三档模型快照：premium / standard / lite。 */
const SNAPSHOTS: readonly ModelSnapshot[] = [
  makeSnapshot('gov:model-premium', 2_000_000, {
    general: 95,
    coding: 96,
    reasoning: 97,
    writing: 93,
    data_analysis: 94,
    vision: 95,
    tool_use: 96,
  }),
  makeSnapshot('gov:model-standard', 1_000_000, {
    general: 90,
    coding: 88,
    reasoning: 85,
    writing: 90,
    data_analysis: 87,
    vision: 80,
    tool_use: 85,
  }),
  makeSnapshot('gov:model-lite', 250_000, {
    general: 85,
    coding: 75,
    reasoning: 70,
    writing: 82,
    data_analysis: 75,
    vision: 60,
    tool_use: 70,
  }),
];

/**
 * 构造 FilterInput：全部模型通过过滤（provider 活动、enabled、access 允许、quota 放行）。
 * @param snapshots - 候选模型快照。
 * @returns 过滤输入。
 */
function makeFilterInput(snapshots: readonly ModelSnapshot[]): FilterInput {
  return {
    snapshots,
    activeProviders: new Set(snapshots.map((s) => s.provider)),
    globalDefault: new Set(snapshots.map((s) => s.routeId)),
    userPolicy: undefined,
    excludedRoutes: new Set(),
    requiredCapabilities: [],
    requiredModalities: [],
    quotaCheck: () => true,
  };
}

/**
 * 计算指定 multiplier 下的 Credit 消耗。
 * @param multiplierPpm - 倍率（ppm）。
 * @returns Credit 数量（number）。
 */
function computeCredits(multiplierPpm: number): number {
  const nanos = computeCreditNanos(
    { inputTokens: INPUT_TOKENS, outputTokens: OUTPUT_TOKENS },
    multiplierPpm,
    TOKENS_PER_CREDIT,
  );
  return nanosToCredits(nanos);
}

// ===== Fake LLM 分类后端 =====

/** 为每个样例构建 LLM 分类查找表（仅 Hint/Rule 未命中时调用）。 */
const llmLookup = new Map<string, Classification>();
for (const ex of EVAL_DATASET) {
  llmLookup.set(ex.input, {
    taskType: ex.expectedTaskType,
    complexity: ex.expectedComplexity,
    confidence: 0.9,
    source: 'llm',
  });
}

/** Fake LLM 后端：按输入文本返回预期分类。 */
const fakeLlmBackend: LlmClassifierBackend = {
  async classify(input: ClassifyInput): Promise<Classification> {
    const text = input.messages.map((m) => m.text ?? '').join('\n');
    const result = llmLookup.get(text);
    if (result === undefined) {
      throw new Error(`LLM backend: unknown input: ${text.slice(0, 100)}`);
    }
    return result;
  },
};

// ===== 测试 =====

describe('Eval: Quality First vs Auto 路由', () => {
  it('Quality Retention >= 95% 且 Credit Saving >= 20%', async () => {
    const filterInput = makeFilterInput(SNAPSHOTS);
    const classifier = createClassifier({
      confidenceThreshold: CONFIDENCE_THRESHOLD,
      llmBackend: fakeLlmBackend,
    });

    let qfTotalCredits = 0;
    let autoTotalCredits = 0;
    let retentionSum = 0;

    /** 按任务类型累计指标，用于输出明细。 */
    const taskTypeMetrics = new Map<
      TaskType,
      { count: number; qfCredits: number; autoCredits: number; retentionSum: number }
    >();

    for (const ex of EVAL_DATASET) {
      // 构造分类输入（vision 样例携带 hasImage）
      const classifyInput: ClassifyInput = {
        messages: [{ type: 'user', text: ex.input }],
        ...(ex.hasImage ? { hasImage: true } : {}),
      };

      // 执行分类（Hint → Rule → LLM）
      const classification = await classifier.classify(classifyInput);

      // 健全性检查：分类结果是否匹配预期
      if (
        classification.taskType !== ex.expectedTaskType ||
        classification.complexity !== ex.expectedComplexity
      ) {
        console.warn(
          `[mismatch] expected=${ex.expectedTaskType}/${ex.expectedComplexity}, ` +
            `actual=${classification.taskType}/${classification.complexity}, ` +
            `input="${ex.input.slice(0, 80)}..."`,
        );
      }

      // Quality First 路由：按 task_type quality 降序选最优
      const qfResult = routeQualityFirst(filterInput, classification.taskType);
      const qfQuality = qfResult.selected.quality[classification.taskType]!;
      const qfCredits = computeCredits(qfResult.selected.multiplierPpm);
      qfTotalCredits += qfCredits;

      // Auto 路由：按分类结果映射复杂度到 minimum_quality，再 Credit First
      const autoResult = routeAuto(filterInput, classification, CONFIDENCE_THRESHOLD);
      const autoQuality = autoResult.selected.quality[classification.taskType]!;
      const autoCredits = computeCredits(autoResult.selected.multiplierPpm);
      autoTotalCredits += autoCredits;

      // 累计质量保持率
      retentionSum += autoQuality / qfQuality;

      // 按任务类型累计
      let metrics = taskTypeMetrics.get(classification.taskType);
      if (metrics === undefined) {
        metrics = { count: 0, qfCredits: 0, autoCredits: 0, retentionSum: 0 };
        taskTypeMetrics.set(classification.taskType, metrics);
      }
      metrics.count++;
      metrics.qfCredits += qfCredits;
      metrics.autoCredits += autoCredits;
      metrics.retentionSum += autoQuality / qfQuality;
    }

    // 计算汇总指标
    const qualityRetention = retentionSum / EVAL_DATASET.length;
    const creditSaving = (qfTotalCredits - autoTotalCredits) / qfTotalCredits;

    // 输出汇总

    console.log('\n===== Eval 结果汇总 =====');

    console.log(`样例总数: ${EVAL_DATASET.length}`);

    console.log(`Quality Retention: ${(qualityRetention * 100).toFixed(2)}%`);

    console.log(`Credit Saving: ${(creditSaving * 100).toFixed(2)}%`);

    console.log(`QF Total Credits: ${qfTotalCredits}`);

    console.log(`Auto Total Credits: ${autoTotalCredits}`);

    // 输出各任务类型明细

    console.log('\n----- 各任务类型明细 -----');
    for (const [taskType, m] of taskTypeMetrics) {
      const retention = (m.retentionSum / m.count) * 100;
      const saving = ((m.qfCredits - m.autoCredits) / m.qfCredits) * 100;

      console.log(
        `${taskType.padEnd(15)} count=${String(m.count).padStart(2)}, ` +
          `retention=${retention.toFixed(2)}%, ` +
          `qf=${m.qfCredits.toFixed(2)}, auto=${m.autoCredits.toFixed(2)}, ` +
          `saving=${saving.toFixed(2)}%`,
      );
    }

    // ===== 验收 =====
    // 1. Quality Retention ≥ 95%
    expect(qualityRetention).toBeGreaterThanOrEqual(0.95);
    // 2. Auto Credits < Quality First Credits
    expect(autoTotalCredits).toBeLessThan(qfTotalCredits);
    // 3. Credit Saving ≥ 20%
    expect(creditSaving).toBeGreaterThanOrEqual(0.2);
  });
});
