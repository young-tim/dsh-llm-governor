/**
 * 任务2 单元测试：GOV-CONFIG-001 统一配置权威与真实 Revision。
 * 覆盖 bootstrap=1、有效变更递增、no-op 不递增、expected-revision 冲突、
 * 审计条目生成、Decision 记录实际 revision。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '../../src/dsh-adapter/mod.js';
import { GovernorService } from '../../src/plugin/service.js';
import type { GovernorPluginConfig } from '../../src/plugin/service.js';
import { GovernorDatabase } from '../../src/storage/database.js';
import { GovernorRepository } from '../../src/storage/repository.js';

/** 构造带 SQLite 的 service（临时库）。 */
async function bootService(
  config: GovernorPluginConfig,
): Promise<{ service: GovernorService; repo: GovernorRepository; dispose: () => void }> {
  const ctx = new Context();
  const dbDir = mkdtempSync(join(tmpdir(), 'dsh-gov-config-'));
  const db = new GovernorDatabase(join(dbDir, 'governor.db'));
  const repo = new GovernorRepository(db);
  const service = new GovernorService(ctx, config, repo, {});
  return {
    service,
    repo,
    dispose: () => {
      db.close();
      rmSync(dbDir, { recursive: true, force: true });
    },
  };
}

function baseConfig(): GovernorPluginConfig {
  return {
    identity: { provider: 'local', local_user_id: 'local' },
    routing: { default: 'manual' },
    models: {
      'p:a': { quality: { general: 90 }, multiplier: 1 },
      'p:b': { quality: { general: 80 }, multiplier: 0.5 },
    },
  } as GovernorPluginConfig;
}

describe('GOV-CONFIG-001 配置权威与 Revision', () => {
  it('bootstrap 后 configRevision=1，且来源只记录一次', async () => {
    const h = await bootService(baseConfig());
    try {
      expect(h.service.configRevision).toBe(1);
      expect(h.repo.getBootstrapSource()).toMatch(/^yaml-bootstrap:/);
    } finally {
      h.dispose();
    }
  });

  it('有效模型变更递增 revision 并写审计条目；no-op 不递增', async () => {
    const h = await bootService(baseConfig());
    try {
      // 先注册 advisory 目录使 p:a 可见
      await h.service.refreshModelDirectory(
        () => [{ id: 'p' }],
        () => [
          { provider: 'p', id: 'a' },
          { provider: 'p', id: 'b' },
        ],
      );
      const before = h.service.configRevision;
      // 有效变更：multiplier 变化
      const updated = await h.service.updateModel('p:a', { multiplier: 2 });
      expect(updated.configRevision).toBe(before + 1);
      expect(h.service.configRevision).toBe(before + 1);
      // no-op：相同值写入不递增
      const noop = await h.service.updateModel('p:a', { multiplier: 2 });
      expect(noop.configRevision).toBe(before + 1);
      // 审计条目记录 actor/target/changed-fields/old-new revision
      const audit = await h.service.listAuditEntries(10);
      expect(audit.length).toBe(1);
      expect(audit[0]!.action).toBe('updateModel');
      expect(audit[0]!.target).toBe('p:a');
      expect(audit[0]!.changedFields).toEqual(['multiplier']);
      expect(audit[0]!.oldRevision).toBe(before);
      expect(audit[0]!.newRevision).toBe(before + 1);
    } finally {
      h.dispose();
    }
  });

  it('expected revision 不匹配抛 REVISION_CONFLICT，匹配时成功', async () => {
    const h = await bootService(baseConfig());
    try {
      await h.service.refreshModelDirectory(
        () => [{ id: 'p' }],
        () => [{ provider: 'p', id: 'a' }],
      );
      const current = h.service.configRevision;
      await expect(
        h.service.updateModel('p:a', { multiplier: 3 }, { expectedRevision: current + 5 }),
      ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
      await expect(
        h.service.updateModel('p:a', { multiplier: 3 }, { expectedRevision: current }),
      ).resolves.toMatchObject({ multiplierPpm: 3_000_000 });
    } finally {
      h.dispose();
    }
  });

  it('用户策略变更递增 revision 并写审计；no-op 不递增', async () => {
    const h = await bootService({ ...baseConfig(), users: { u1: { monthly_credits: 10 } } });
    try {
      const before = h.service.configRevision;
      await h.service.updateUser('u1', { monthlyCredits: 20 });
      expect(h.service.configRevision).toBe(before + 1);
      await h.service.updateUser('u1', { monthlyCredits: 20 });
      expect(h.service.configRevision).toBe(before + 1);
      const audit = await h.service.listAuditEntries(10);
      expect(audit[0]!.action).toBe('updateUser');
    } finally {
      h.dispose();
    }
  });

  it('用户额度与 allow 同事务更新，拒绝非法额度且重启回读一致', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'dsh-gov-user-policy-'));
    const dbPath = join(dbDir, 'governor.db');
    const config: GovernorPluginConfig = {
      ...baseConfig(),
      users: { u1: { monthly_credits: 10, allow: ['p:a'] } },
    };
    const db1 = new GovernorDatabase(dbPath);
    try {
      const repo1 = new GovernorRepository(db1);
      const service1 = new GovernorService(new Context(), config, repo1, {});
      const before = service1.configRevision;
      await expect(service1.updateUser('u1', { monthlyCredits: -1 })).rejects.toThrow(
        'INVALID_MONTHLY_CREDITS',
      );
      await expect(service1.updateUser('u1', { monthlyCredits: 1.5 })).rejects.toThrow(
        'INVALID_MONTHLY_CREDITS',
      );
      await expect(service1.updateUser('u1', { allow: ['not-a-route'] })).rejects.toThrow(
        'INVALID_USER_ALLOW',
      );
      expect(service1.configRevision).toBe(before);

      const updated = await service1.updateUser('u1', {
        monthlyCredits: 23,
        allow: ['p:b', 'p:a', 'p:b'],
      });
      expect(updated).toMatchObject({
        monthlyCredits: 23,
        allow: ['p:a', 'p:b'],
        configRevision: before + 1,
      });
      expect(repo1.listUserAllow('u1')).toEqual(['p:a', 'p:b']);
      expect((await service1.listAuditEntries(10))[0]?.changedFields).toEqual([
        'monthlyCredits',
        'allow',
      ]);
    } finally {
      db1.close();
    }

    const db2 = new GovernorDatabase(dbPath);
    try {
      const service2 = new GovernorService(new Context(), config, new GovernorRepository(db2), {});
      expect((await service2.listUsers()).find((user) => user.userId === 'u1')).toMatchObject({
        monthlyCredits: 23,
        allow: ['p:a', 'p:b'],
        usedCredits: 0,
        usedCreditNanos: '0',
      });
    } finally {
      db2.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it('单事务：updateModel 审计写失败时数据与 revision 整体回滚，内存不提交', async () => {
    const h = await bootService(baseConfig());
    try {
      await h.service.refreshModelDirectory(
        () => [{ id: 'p' }],
        () => [
          { provider: 'p', id: 'a' },
          { provider: 'p', id: 'b' },
        ],
      );
      const before = h.service.configRevision;
      // 注入审计写失败：事务内第三个写入抛错
      const original = h.repo.insertAuditEntry.bind(h.repo);
      h.repo.insertAuditEntry = () => {
        throw new Error('audit write failed');
      };
      await expect(h.service.updateModel('p:a', { multiplier: 2 })).rejects.toThrow(
        'audit write failed',
      );
      h.repo.insertAuditEntry = original;
      // SQLite：revision 未递增；模型策略行保持旧值（upsert 与 setConfigRevision 一并回滚）
      expect(h.repo.getConfigRevision()).toBe(before);
      const row = h.repo.listModelPolicies().find((r) => r.routeId === 'p:a');
      expect(row!.multiplierPpm).toBe(1_000_000);
      // 内存：目录快照未被提交（multiplierPpm 仍为初始 1_000_000）
      const snapshot = (await h.service.listModels()).find((m) => m.routeId === 'p:a');
      expect(snapshot!.multiplierPpm).toBe(1_000_000);
      // 恢复后重试同一写入：changedFields 仍包含 multiplier（内存未抢跑），revision 正常递增
      const retried = await h.service.updateModel('p:a', { multiplier: 2 });
      expect(retried.configRevision).toBe(before + 1);
      expect(retried.multiplierPpm).toBe(2_000_000);
      const audit = await h.service.listAuditEntries(10);
      expect(audit).toHaveLength(1);
      expect(audit[0]!.changedFields).toEqual(['multiplier']);
    } finally {
      h.dispose();
    }
  });

  it('单事务：updateUser 审计写失败时额度与 revision 整体回滚，内存不提交', async () => {
    const h = await bootService({ ...baseConfig(), users: { u1: { monthly_credits: 10 } } });
    try {
      const before = h.service.configRevision;
      const original = h.repo.insertAuditEntry.bind(h.repo);
      h.repo.insertAuditEntry = () => {
        throw new Error('audit write failed');
      };
      await expect(h.service.updateUser('u1', { monthlyCredits: 99 })).rejects.toThrow(
        'audit write failed',
      );
      h.repo.insertAuditEntry = original;
      // SQLite：revision 未递增；内存：monthlyCredits 未提交（仍为 10 → 视图保持旧值）
      expect(h.repo.getConfigRevision()).toBe(before);
      const users = await h.service.listUsers();
      expect(users.find((u) => u.userId === 'u1')!.monthlyCredits).toBe(10);
      // 恢复后重试成功
      await h.service.updateUser('u1', { monthlyCredits: 99 });
      expect(h.service.configRevision).toBe(before + 1);
      expect((await h.service.listUsers()).find((u) => u.userId === 'u1')!.monthlyCredits).toBe(99);
    } finally {
      h.dispose();
    }
  });
});
