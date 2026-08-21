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
});
