/**
 * 任务2 单元测试：决策核心（GOV-TRACE-001/GOV-DECISION-001 公共基础）。
 * 覆盖 UUIDv7、JCS 规范化、decisionHash 稳定性与冲突、截断、trigger 归并、
 * changedFields 枚举校验与事件大小上限。
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalizeJson,
  computeDecisionHash,
  deriveTrigger,
  sealDecision,
  truncateList,
  uuidv7,
  assertChangedFields,
  assertEventSize,
  DECISION_LIMITS,
  CHANGED_FIELDS,
} from '../../src/routing/decision.js';
import type { SealDecisionInput } from '../../src/routing/decision.js';

/** 构造最小决策输入。 */
function baseInput(overrides: Partial<SealDecisionInput> = {}): SealDecisionInput {
  return {
    requestId: 'req-1',
    turn: 1,
    step: 1,
    fallbackIndex: 0,
    causes: ['initial'],
    changedFields: [],
    selectionMode: 'auto',
    effectiveStrategy: 'credit_first',
    candidates: [{ routeId: 'p:m', quality: 90, multiplierPpm: 1_000_000 }],
    excluded: [],
    outcome: 'selected',
    selectedRoute: 'p:m',
    configRevision: 1,
    ...overrides,
  };
}

describe('GOV-DECISION uuidv7', () => {
  it('生成合法 UUIDv7（版本 7 + RFC 4122 variant + 时间戳前缀）', () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // 时间戳前 48 bit 与当前时间一致（毫秒级）
    const ts = parseInt(id.slice(0, 13).replace('-', ''), 16);
    expect(Math.abs(Date.now() - ts)).toBeLessThan(5000);
  });

  it('同请求 ID 唯一性', () => {
    const ids = new Set(Array.from({ length: 100 }, () => uuidv7()));
    expect(ids.size).toBe(100);
  });
});

describe('GOV-DECISION JCS 规范化', () => {
  it('object key 按字典序排序，嵌套递归', () => {
    expect(canonicalizeJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('数组顺序保留；undefined 字段跳过', () => {
    expect(canonicalizeJson({ a: [3, 1, 2], b: undefined })).toBe('{"a":[3,1,2]}');
  });

  it('不同 key 顺序的等价对象产生相同规范化输出', () => {
    expect(canonicalizeJson({ x: 1, y: 's' })).toBe(canonicalizeJson({ y: 's', x: 1 }));
  });
});

describe('GOV-DECISION decisionHash', () => {
  it('同核心字段 → 稳定 hash；key 顺序无关', () => {
    const h1 = computeDecisionHash({
      schemaVersion: 1,
      decisionId: 'r:0',
      requestId: 'r',
      turn: 1,
      step: 1,
      fallbackIndex: 0,
      trigger: 'step',
      causes: ['step'],
      changedFields: [],
      selectionMode: 'auto',
      effectiveStrategy: 'credit_first',
      candidates: [{ routeId: 'p:m', quality: 90, multiplierPpm: 1 }],
      excluded: [],
      outcome: 'selected',
      configRevision: 1,
    });
    const h2 = computeDecisionHash({
      configRevision: 1,
      outcome: 'selected',
      excluded: [],
      candidates: [{ multiplierPpm: 1, quality: 90, routeId: 'p:m' }],
      effectiveStrategy: 'credit_first',
      selectionMode: 'auto',
      changedFields: [],
      causes: ['step'],
      trigger: 'step',
      fallbackIndex: 0,
      step: 1,
      turn: 1,
      requestId: 'r',
      decisionId: 'r:0',
      schemaVersion: 1,
    });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('任一核心字段变化 → hash 变化', () => {
    const base = {
      schemaVersion: 1,
      decisionId: 'r:0',
      requestId: 'r',
      turn: 1,
      step: 1,
      fallbackIndex: 0,
      trigger: 'step',
      causes: ['step'],
      changedFields: [],
      selectionMode: 'auto',
      effectiveStrategy: 'credit_first',
      candidates: [{ routeId: 'p:m', quality: 90, multiplierPpm: 1 }],
      excluded: [],
      outcome: 'selected',
      configRevision: 1,
    };
    const h1 = computeDecisionHash(base);
    expect(computeDecisionHash({ ...base, selectedRoute: 'p:other' })).not.toBe(h1);
    expect(computeDecisionHash({ ...base, configRevision: 2 })).not.toBe(h1);
    expect(
      computeDecisionHash({ ...base, outcome: 'rejected', errorCode: 'NO_MODEL_MATCHED' }),
    ).not.toBe(h1);
  });
});

describe('GOV-TRACE 截断（固定限制）', () => {
  it('候选最多 64 项，记录 totalCount/truncated/digest', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ routeId: `p:m${i}` }));
    const result = truncateList(items, DECISION_LIMITS.maxCandidates);
    expect(result.items).toHaveLength(64);
    expect(result.totalCount).toBe(100);
    expect(result.truncated).toBe(true);
    expect(result.truncatedDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('未超限时不截断', () => {
    const result = truncateList([1, 2, 3], 64);
    expect(result).toEqual({ items: [1, 2, 3], totalCount: 3, truncated: false });
  });

  it('sealDecision 对超限候选/排除自动截断', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      routeId: `p:m${i}`,
      quality: 80,
      multiplierPpm: 1,
    }));
    const sealed = sealDecision(baseInput({ candidates: many }));
    expect(sealed.candidates).toHaveLength(DECISION_LIMITS.maxCandidates);
    expect(sealed.candidateTruncation.totalCount).toBe(80);
    expect(sealed.candidateTruncation.truncated).toBe(true);
  });
});

describe('GOV-TRACE trigger 归并与 changedFields 校验', () => {
  it('trigger 按 fallback > selection_mode_change > config_change > resume > initial > step 取最高', () => {
    expect(deriveTrigger(['step', 'resume'])).toBe('resume');
    expect(deriveTrigger(['initial', 'resume'])).toBe('resume');
    expect(deriveTrigger(['resume', 'config_change'])).toBe('config_change');
    expect(deriveTrigger(['config_change', 'selection_mode_change'])).toBe('selection_mode_change');
    expect(deriveTrigger(['selection_mode_change', 'fallback'])).toBe('fallback');
    expect(deriveTrigger(['step'])).toBe('step');
    expect(deriveTrigger([])).toBe('step');
  });

  it('changedFields 只允许固定枚举，未知字段抛错', () => {
    expect(() => assertChangedFields(['selection_mode', 'strategy'])).not.toThrow();
    expect(() => assertChangedFields(['bogus_field'])).toThrowError(/DECISION_SCHEMA/);
    expect(CHANGED_FIELDS).toContain('selected_route');
  });

  it('事件 UTF-8 序列化超过 64 KiB 抛错', () => {
    const huge = { data: 'x'.repeat(70 * 1024) };
    expect(() => assertEventSize(huge)).toThrowError(/exceeds/);
    expect(() => assertEventSize({ ok: true })).not.toThrow();
  });
});

describe('GOV-DECISION sealDecision 不可变性', () => {
  it('返回对象 deepFreeze，decisionId=<requestId>:<fallbackIndex>', () => {
    const sealed = sealDecision(baseInput());
    expect(sealed.decisionId).toBe('req-1:0');
    expect(Object.isFrozen(sealed)).toBe(true);
    expect(Object.isFrozen(sealed.candidates)).toBe(true);
    expect(() => {
      (sealed as unknown as { outcome: string }).outcome = 'rejected';
    }).toThrowError(TypeError);
  });
});
