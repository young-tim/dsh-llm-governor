/**
 * 真实安装测试：把打包出的 tgz 安装进临时 DSH profile，
 * 用仓库唯一的真实 dsh CLI（rc.8）的 plugin 管理与 --dump-config 证明：
 *
 * 1. `dsh plugin --profile <name> add <tgz>` 后，package 声明的 dsh.bundle
 *    使其进入 dsh.profile.bundles（profile layer，不是普通依赖），
 *    且不再出现 "declares no dsh.bundle" 警告。
 * 2. `dsh --profile <name> --dump-config` 组合结果中：
 *    - 存在 id: dsh-llm-governor 的 host 插件行（带完整 config）；
 *    - 基础 llm-retry 行被本 bundle patch 为 disabled: true（Recovery Owner 唯一）。
 * 3. `dsh plugin --profile <name> remove dsh-llm-governor` 后：
 *    - dump 中不再出现 Governor 行；
 *    - llm-retry 行恢复启用（卸载后回到基础 retry）。
 *
 * 全程使用临时 DSH_HOME 与临时目录；不读取或修改真实 Profile、凭证、Provider。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 项目根目录。 */
const projectRoot = process.cwd();
/** 真实 dsh CLI 入口（仓库唯一的 rc.8 devDependency）。 */
const dshBin = join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

/** 临时工作目录（tarball + DSH_HOME）。 */
let workDir: string;
/** tarball 绝对路径。 */
let tarballPath: string;
let sourceDir: string;
/** 临时 DSH_HOME。 */
let dshHome: string;
/** 测试 profile 名。 */
const profileName = 'gov-install-real';

/** 在 DSH_HOME 指向临时目录的环境里运行 dsh CLI。 */
function runDsh(args: string[]): string {
  return execFileSync(process.execPath, [dshBin, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: dshHome },
  });
}

beforeAll(() => {
  if (!existsSync(dshBin)) {
    throw new Error(`真实 dsh CLI 不存在：${dshBin}`);
  }
  workDir = mkdtempSync(join(tmpdir(), 'dsh-gov-real-'));
  dshHome = join(workDir, 'home');
  sourceDir = join(workDir, 'source');
  mkdirSync(sourceDir);
  for (const entry of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.json',
    'vitest.config.ts',
    'cordis.patch.yml',
    'LICENSE',
    'README.md',
    'src',
    'scripts',
    'test',
  ]) {
    cpSync(join(projectRoot, entry), join(sourceDir, entry), { recursive: true });
  }
  symlinkSync(join(projectRoot, 'node_modules'), join(sourceDir, 'node_modules'), 'dir');
  // 在临时源码副本执行完整 build，不改动仓库 dist/**。
  execFileSync('npm', ['run', 'build'], {
    cwd: sourceDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  execFileSync('pnpm', ['pack', '--pack-destination', workDir], {
    cwd: sourceDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
  });
  const tgzs = readdirSync(workDir).filter((f) => f.endsWith('.tgz'));
  if (tgzs.length !== 1) throw new Error(`预期一个 tgz，实际：${tgzs.join(', ')}`);
  tarballPath = join(workDir, tgzs[0]!);
}, 300000);

afterAll(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

describe('真实安装：tgz → 临时 DSH profile → dump-config', () => {
  it('dsh plugin add 后 Governor 进入 dsh.profile.bundles（profile layer）', () => {
    const output = runDsh(['plugin', '--profile', profileName, 'add', tarballPath]);
    // 不能再出现 "declares no dsh.bundle" 警告（上次验收失败的直接原因）
    expect(output).not.toContain('declares no dsh.bundle');

    const manifest = JSON.parse(
      readFileSync(join(dshHome, 'profiles', profileName, 'package.json'), 'utf8'),
    ) as { dsh?: { profile?: { bundles?: string[] } } };
    expect(manifest.dsh?.profile?.bundles).toContain('dsh-llm-governor');
  }, 300000);

  it('dump-config 包含 Governor host 行，且 llm-retry 被禁用（Recovery Owner 唯一）', () => {
    const dump = runDsh(['--profile', profileName, '--dump-config']);

    // Governor host 插件行（带完整 config）存在
    expect(dump).toMatch(/- id: dsh-llm-governor\b/);
    expect(dump).toMatch(/name: '?dsh-llm-governor'?/);
    expect(dump).toMatch(/provider: local/);
    expect(dump).toMatch(/storage:\s*\n\s*enabled: true/);

    // 基础 llm-retry 行被本 bundle 禁用：Governor 是唯一 Recovery Owner
    const retryIdx = dump.indexOf('- id: llm-retry');
    expect(retryIdx).toBeGreaterThanOrEqual(0);
    const retryBlock = dump.slice(retryIdx, retryIdx + 200);
    expect(retryBlock).toContain("name: '@deepseek-ai/dsh-llm-retry'");
    expect(retryBlock).toContain('disabled: true');
  });

  it('dsh plugin remove 后基础 llm-retry 恢复，Governor 行消失', () => {
    runDsh(['plugin', '--profile', profileName, 'remove', 'dsh-llm-governor']);

    const dump = runDsh(['--profile', profileName, '--dump-config']);
    expect(dump).not.toContain('id: dsh-llm-governor');

    // llm-retry 行恢复：不再有 disabled: true
    const retryIdx = dump.indexOf('- id: llm-retry');
    expect(retryIdx).toBeGreaterThanOrEqual(0);
    const retryBlock = dump.slice(retryIdx, retryIdx + 200);
    expect(retryBlock).toContain("name: '@deepseek-ai/dsh-llm-retry'");
    expect(retryBlock).not.toContain('disabled: true');
  }, 300000);
});
