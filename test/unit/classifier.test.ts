/**
 * Classifier 模块单元测试：覆盖 cache、hint、rule 三个子模块。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryClassifierCache } from '../../src/classifier/cache.js';
import { classifyByHint } from '../../src/classifier/hint.js';
import { classifyByRule, complexityByLength } from '../../src/classifier/rule.js';
import type { ClassifyInput } from '../../src/classifier/types.js';

// ===== InMemoryClassifierCache =====

describe('InMemoryClassifierCache', () => {
  it('set + get 命中', () => {
    const cache = new InMemoryClassifierCache();
    cache.set('key-1', {
      taskType: 'coding',
      complexity: 'medium',
      confidence: 0.8,
      source: 'rule',
    });
    const result = cache.get('key-1');
    expect(result).toBeDefined();
    expect(result!.taskType).toBe('coding');
    expect(result!.source).toBe('rule');
  });

  it('未命中的 key 返回 undefined', () => {
    const cache = new InMemoryClassifierCache();
    expect(cache.get('nonexistent')).toBeUndefined();
  });

  it('覆盖写入后 get 返回最新值', () => {
    const cache = new InMemoryClassifierCache();
    cache.set('key-1', {
      taskType: 'general',
      complexity: 'low',
      confidence: 0.5,
      source: 'rule',
    });
    cache.set('key-1', {
      taskType: 'coding',
      complexity: 'high',
      confidence: 0.9,
      source: 'llm',
    });
    const result = cache.get('key-1');
    expect(result!.taskType).toBe('coding');
    expect(result!.source).toBe('llm');
  });

  it('带 TTL 的缓存：未过期可命中', () => {
    const cache = new InMemoryClassifierCache({ ttlMs: 10_000 });
    cache.set('key-1', {
      taskType: 'general',
      complexity: 'low',
      confidence: 0.5,
      source: 'rule',
    });
    expect(cache.get('key-1')).toBeDefined();
  });

  it('带 TTL 的缓存：过期后未命中', () => {
    vi.useFakeTimers();
    try {
      const cache = new InMemoryClassifierCache({ ttlMs: 1000 });
      cache.set('key-1', {
        taskType: 'general',
        complexity: 'low',
        confidence: 0.5,
        source: 'rule',
      });
      // 未过期
      expect(cache.get('key-1')).toBeDefined();
      // 前进 1001ms → 过期
      vi.advanceTimersByTime(1001);
      expect(cache.get('key-1')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('TTL=0 视为永不过期', () => {
    vi.useFakeTimers();
    try {
      const cache = new InMemoryClassifierCache({ ttlMs: 0 });
      cache.set('key-1', {
        taskType: 'general',
        complexity: 'low',
        confidence: 0.5,
        source: 'rule',
      });
      vi.advanceTimersByTime(1_000_000);
      expect(cache.get('key-1')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('TTL=负数视为永不过期', () => {
    const cache = new InMemoryClassifierCache({ ttlMs: -1 });
    cache.set('key-1', {
      taskType: 'general',
      complexity: 'low',
      confidence: 0.5,
      source: 'rule',
    });
    expect(cache.get('key-1')).toBeDefined();
  });

  it('不传 TTL 永不过期', () => {
    vi.useFakeTimers();
    try {
      const cache = new InMemoryClassifierCache();
      cache.set('key-1', {
        taskType: 'general',
        complexity: 'low',
        confidence: 0.5,
        source: 'rule',
      });
      vi.advanceTimersByTime(1_000_000);
      expect(cache.get('key-1')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ===== classifyByHint =====

describe('classifyByHint', () => {
  it('explicitHint 为合法 TaskType 时返回 hint 分类', () => {
    const input: ClassifyInput = {
      messages: [],
      explicitHint: 'coding',
    };
    const result = classifyByHint(input);
    expect(result).toEqual({
      taskType: 'coding',
      complexity: 'medium',
      confidence: 1.0,
      source: 'hint',
    });
  });

  it('explicitHint 为其他合法 TaskType（reasoning）', () => {
    const result = classifyByHint({ messages: [], explicitHint: 'reasoning' });
    expect(result!.taskType).toBe('reasoning');
    expect(result!.confidence).toBe(1.0);
  });

  it('explicitHint 为所有合法 TaskType', () => {
    for (const t of [
      'general',
      'coding',
      'reasoning',
      'writing',
      'data_analysis',
      'vision',
      'tool_use',
    ]) {
      const result = classifyByHint({ messages: [], explicitHint: t });
      expect(result).toBeDefined();
      expect(result!.taskType).toBe(t);
    }
  });

  it('explicitHint 为非法字符串时返回 undefined（不命中）', () => {
    const result = classifyByHint({ messages: [], explicitHint: 'bogus' });
    expect(result).toBeUndefined();
  });

  it('hasImage=true → vision 分类', () => {
    const result = classifyByHint({ messages: [], hasImage: true });
    expect(result).toEqual({
      taskType: 'vision',
      complexity: 'medium',
      confidence: 1.0,
      source: 'hint',
    });
  });

  it('hasToolContext=true → tool_use 分类', () => {
    const result = classifyByHint({ messages: [], hasToolContext: true });
    expect(result).toEqual({
      taskType: 'tool_use',
      complexity: 'medium',
      confidence: 1.0,
      source: 'hint',
    });
  });

  it('explicitHint 优先于 hasImage', () => {
    const result = classifyByHint({ messages: [], explicitHint: 'coding', hasImage: true });
    expect(result!.taskType).toBe('coding');
  });

  it('hasImage 优先于 hasToolContext', () => {
    const result = classifyByHint({ messages: [], hasImage: true, hasToolContext: true });
    expect(result!.taskType).toBe('vision');
  });

  it('无任何信号时返回 undefined', () => {
    const result = classifyByHint({ messages: [] });
    expect(result).toBeUndefined();
  });

  it('hasImage=false 不触发 vision 分类', () => {
    const result = classifyByHint({ messages: [], hasImage: false });
    expect(result).toBeUndefined();
  });

  it('hasToolContext=false 不触发 tool_use 分类', () => {
    const result = classifyByHint({ messages: [], hasToolContext: false });
    expect(result).toBeUndefined();
  });
});

// ===== complexityByLength =====

describe('complexityByLength', () => {
  it('0 字符 → low', () => {
    expect(complexityByLength(0)).toBe('low');
  });

  it('99 字符 → low', () => {
    expect(complexityByLength(99)).toBe('low');
  });

  it('100 字符 → medium', () => {
    expect(complexityByLength(100)).toBe('medium');
  });

  it('500 字符 → medium', () => {
    expect(complexityByLength(500)).toBe('medium');
  });

  it('501 字符 → high', () => {
    expect(complexityByLength(501)).toBe('high');
  });

  it('10000 字符 → high', () => {
    expect(complexityByLength(10000)).toBe('high');
  });
});

// ===== classifyByRule =====

describe('classifyByRule', () => {
  it('fenced 代码块 → coding, medium, 0.8', () => {
    const input: ClassifyInput = {
      messages: [{ type: 'text', text: 'Here is code:\n```js\nconsole.log(1)\n```' }],
    };
    const result = classifyByRule(input);
    expect(result).toEqual({
      taskType: 'coding',
      complexity: 'medium',
      confidence: 0.8,
      source: 'rule',
    });
  });

  it('~~~ fenced 代码块 → coding', () => {
    const result = classifyByRule({
      messages: [{ type: 'text', text: '~~~python\nprint(1)\n~~~' }],
    });
    expect(result!.taskType).toBe('coding');
  });

  it('缩进代码块（4 空格）→ coding', () => {
    const result = classifyByRule({
      messages: [{ type: 'text', text: 'text\n    code here' }],
    });
    expect(result!.taskType).toBe('coding');
  });

  it('缩进代码块（tab）→ coding', () => {
    const result = classifyByRule({
      messages: [{ type: 'text', text: 'text\n\tcode here' }],
    });
    expect(result!.taskType).toBe('coding');
  });

  it('错误栈（Error:）→ coding, high, 0.75', () => {
    const result = classifyByRule({
      messages: [{ type: 'text', text: 'Something failed\nError: boom' }],
    });
    expect(result).toEqual({
      taskType: 'coding',
      complexity: 'high',
      confidence: 0.75,
      source: 'rule',
    });
  });

  it('错误栈（at frame）→ coding, high', () => {
    const result = classifyByRule({
      messages: [{ type: 'text', text: 'trace:\n  at foo (bar.js:1:1)' }],
    });
    expect(result!.taskType).toBe('coding');
    expect(result!.complexity).toBe('high');
  });

  it('TypeError → coding, high', () => {
    const result = classifyByRule({
      messages: [{ type: 'text', text: 'TypeError: cannot read' }],
    });
    expect(result!.taskType).toBe('coding');
  });

  it('SQL SELECT → data_analysis, medium, 0.75', () => {
    const result = classifyByRule({
      messages: [{ type: 'text', text: 'SELECT * FROM users' }],
    });
    expect(result).toEqual({
      taskType: 'data_analysis',
      complexity: 'medium',
      confidence: 0.75,
      source: 'rule',
    });
  });

  it('SQL INSERT INTO → data_analysis', () => {
    const result = classifyByRule({
      messages: [{ type: 'text', text: 'INSERT INTO users VALUES (1)' }],
    });
    expect(result!.taskType).toBe('data_analysis');
  });

  it('SQL CREATE TABLE → data_analysis', () => {
    const result = classifyByRule({
      messages: [{ type: 'text', text: 'CREATE TABLE foo (id INT)' }],
    });
    expect(result!.taskType).toBe('data_analysis');
  });

  it('Markdown 表格 → data_analysis, medium, 0.7', () => {
    const result = classifyByRule({
      messages: [{ type: 'text', text: '| col1 | col2 |\n| --- | --- |\n| a | b |' }],
    });
    expect(result).toEqual({
      taskType: 'data_analysis',
      complexity: 'medium',
      confidence: 0.7,
      source: 'rule',
    });
  });

  it('长文（>2000 字符）→ writing, high, 0.6', () => {
    const longText = 'a'.repeat(2001);
    const result = classifyByRule({
      messages: [{ type: 'text', text: longText }],
    });
    expect(result).toEqual({
      taskType: 'writing',
      complexity: 'high',
      confidence: 0.6,
      source: 'rule',
    });
  });

  it('恰好 2000 字符不触发长文规则', () => {
    const text = 'a'.repeat(2000);
    const result = classifyByRule({
      messages: [{ type: 'text', text }],
    });
    expect(result).toBeUndefined();
  });

  it('无任何特征时不命中 → undefined', () => {
    const result = classifyByRule({
      messages: [{ type: 'text', text: 'hello world' }],
    });
    expect(result).toBeUndefined();
  });

  it('空消息列表不命中', () => {
    const result = classifyByRule({ messages: [] });
    expect(result).toBeUndefined();
  });

  it('消息缺省 text 视为空字符串', () => {
    const result = classifyByRule({
      messages: [{ type: 'image' }],
    });
    expect(result).toBeUndefined();
  });

  it('代码块优先于错误栈', () => {
    const result = classifyByRule({
      messages: [{ type: 'text', text: '```\nError: boom\n```' }],
    });
    expect(result!.taskType).toBe('coding');
    expect(result!.complexity).toBe('medium');
    expect(result!.confidence).toBe(0.8);
  });

  it('多条消息拼接后匹配', () => {
    const result = classifyByRule({
      messages: [
        { type: 'text', text: 'I have a question' },
        { type: 'text', text: '\n```python\nprint(1)\n```' },
      ],
    });
    expect(result!.taskType).toBe('coding');
  });
});
