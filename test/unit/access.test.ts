/**
 * Access 模块单元测试：覆盖 evaluateAccess 和 filterByAccess。
 */
import { describe, it, expect } from 'vitest';
import { evaluateAccess, filterByAccess } from '../../src/access/index.js';
import type { UserAccessPolicy } from '../../src/access/index.js';

describe('evaluateAccess', () => {
  const globalDefault = new Set(['openai:gpt-4', 'anthropic:claude-3']);

  it('空 allow list（undefined userPolicy）使用全局默认（命中）', () => {
    const result = evaluateAccess('openai:gpt-4', undefined, globalDefault);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('ok');
  });

  it('空 allow list（空数组）使用全局默认（命中）', () => {
    const userPolicy: UserAccessPolicy = { userId: 'u1', allow: [] };
    const result = evaluateAccess('anthropic:claude-3', userPolicy, globalDefault);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('ok');
  });

  it('不在全局默认中返回 not_in_global_default', () => {
    const result = evaluateAccess('unknown:model', undefined, globalDefault);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not_in_global_default');
  });

  it('空 allow list + 不在全局默认中也返回 not_in_global_default', () => {
    const userPolicy: UserAccessPolicy = { userId: 'u1', allow: [] };
    const result = evaluateAccess('unknown:model', userPolicy, globalDefault);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not_in_global_default');
  });

  it('非空 allow list 只允许显式 route（命中 allow）', () => {
    const userPolicy: UserAccessPolicy = {
      userId: 'u1',
      allow: ['openai:gpt-4'],
    };
    const result = evaluateAccess('openai:gpt-4', userPolicy, globalDefault);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('ok');
  });

  it('非空 allow list 不在 allow 中返回 not_in_allow_list', () => {
    const userPolicy: UserAccessPolicy = {
      userId: 'u1',
      allow: ['anthropic:claude-3'],
    };
    const result = evaluateAccess('openai:gpt-4', userPolicy, globalDefault);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not_in_allow_list');
  });

  it('非空 allow list 优先于全局默认（即便在全局默认中也按 allow 判定）', () => {
    // openai:gpt-4 在全局默认中，但 allow list 只允许 anthropic:claude-3
    const userPolicy: UserAccessPolicy = {
      userId: 'u1',
      allow: ['anthropic:claude-3'],
    };
    const result = evaluateAccess('openai:gpt-4', userPolicy, globalDefault);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not_in_allow_list');
  });

  it('非空 allow list 中不在全局默认的 route 仍可命中', () => {
    const userPolicy: UserAccessPolicy = {
      userId: 'u1',
      allow: ['custom:model'],
    };
    const result = evaluateAccess('custom:model', userPolicy, globalDefault);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('ok');
  });
});

describe('filterByAccess', () => {
  const globalDefault = new Set(['openai:gpt-4', 'anthropic:claude-3']);

  it('批量过滤：使用全局默认保留命中的 route', () => {
    const candidates = ['openai:gpt-4', 'unknown:model', 'anthropic:claude-3'];
    const result = filterByAccess(candidates, undefined, globalDefault);
    expect(result).toEqual(['openai:gpt-4', 'anthropic:claude-3']);
  });

  it('批量过滤：使用非空 allow list 只保留显式允许的 route', () => {
    const candidates = ['openai:gpt-4', 'unknown:model', 'anthropic:claude-3'];
    const userPolicy: UserAccessPolicy = {
      userId: 'u1',
      allow: ['openai:gpt-4'],
    };
    const result = filterByAccess(candidates, userPolicy, globalDefault);
    expect(result).toEqual(['openai:gpt-4']);
  });

  it('空候选返回空数组', () => {
    expect(filterByAccess([], undefined, globalDefault)).toEqual([]);
  });

  it('全部被拒绝时返回空数组', () => {
    const candidates = ['unknown:1', 'unknown:2'];
    expect(filterByAccess(candidates, undefined, globalDefault)).toEqual([]);
  });

  it('保留候选顺序', () => {
    const candidates = ['anthropic:claude-3', 'openai:gpt-4'];
    const result = filterByAccess(candidates, undefined, globalDefault);
    expect(result).toEqual(['anthropic:claude-3', 'openai:gpt-4']);
  });
});
