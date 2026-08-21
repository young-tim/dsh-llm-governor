/**
 * 打包安装 smoke 测试：
 * - 在临时源码副本运行 `pnpm build`，不改动仓库 dist/
 * - 使用 `pnpm pack --pack-destination <临时目录>` 打包
 * - 解压 tarball 到临时目录
 * - 在临时 consumer 中真实安装 tarball 并导入 Remote export
 * - 验证 tarball 包含 package.json、dist/index.js 以及 dist 下所有 JS 文件
 * - 验证 dist/ 中有编译后的 JS 文件
 * - 验证 package.json 的 peerDependencies 正确
 *
 * 不读取或修改真实 Profile/凭证/Provider，全程使用临时目录。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 项目根目录（vitest 默认 cwd 为项目根）。 */
const projectRoot = process.cwd();

/** 临时工作目录，所有产物在此完成。 */
let workDir: string;
/** 解压后的 package 目录（tarball 内顶层是 package/）。 */
let packageDir: string;
/** tarball 文件路径。 */
let tarballPath: string;
/** 临时源码副本与真实安装 consumer。 */
let sourceDir: string;
let consumerDir: string;
let rootDistBefore: string;
let rootDistAfter: string;

/** 递归收集目录下所有文件路径（相对路径）。 */
function listFilesRecursive(root: string, base = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(root, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/** 对仓库 dist 做稳定内容摘要，验证 smoke 自身没有写入白名单外产物。 */
function directoryDigest(root: string): string {
  const hash = createHash('sha256');
  if (!existsSync(root)) return hash.update('<missing>').digest('hex');
  for (const file of listFilesRecursive(root).sort()) {
    hash.update(file);
    hash.update(readFileSync(join(root, file)));
  }
  return hash.digest('hex');
}

// beforeAll 执行 tsc 编译 + pnpm pack + tar 解压（实测合计约 3 秒），
// 默认 hook 超时即可覆盖，不得放宽超时规避门禁失败。
beforeAll(() => {
  // 1. 创建临时工作目录（不触碰仓库 dist/、真实 DSH_HOME / Profile / 凭证）
  workDir = mkdtempSync(join(tmpdir(), 'dsh-gov-pack-'));
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
  // 只复用已安装依赖；构建与 prepack 的全部输出仍位于临时副本。
  symlinkSync(join(projectRoot, 'node_modules'), join(sourceDir, 'node_modules'), 'dir');
  rootDistBefore = directoryDigest(join(projectRoot, 'dist'));

  // 2. 在临时源码副本构建完整 Host、Remote 与 browser client。
  execSync('npm run build', { cwd: sourceDir, stdio: 'inherit' });

  // 3. 打包到临时目录
  execSync(`pnpm pack --pack-destination "${workDir}"`, {
    cwd: sourceDir,
    stdio: 'inherit',
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
  });

  // 4. 找到 tarball（命名格式 <name>-<version>.tgz）
  const tgzs = readdirSync(workDir).filter((f) => f.endsWith('.tgz'));
  if (tgzs.length !== 1) {
    throw new Error(`预期一个 tgz，实际：${tgzs.join(', ')}`);
  }
  tarballPath = join(workDir, tgzs[0]!);

  // 5. 解压 tarball 到 workDir（tarball 顶层为 package/）
  execSync(`tar -xzf "${tarballPath}" -C "${workDir}"`, {
    stdio: 'inherit',
  });
  packageDir = join(workDir, 'package');

  // 6. 真实 production 安装 tarball 与 Host peers；禁止依赖仓库 devDependencies。
  consumerDir = join(workDir, 'consumer');
  mkdirSync(consumerDir);
  writeFileSync(join(consumerDir, 'package.json'), '{"name":"governor-smoke","private":true}');
  execSync(
    `pnpm add --offline --ignore-scripts --config.auto-install-peers=false "${tarballPath}"`,
    { cwd: consumerDir, stdio: 'inherit' },
  );
  // DSH Host 提供 peer runtime；用当前 rc.8 安装树模拟平台，而非让包偷用 devDependency。
  const peerScope = join(consumerDir, 'node_modules', '@deepseek-ai');
  mkdirSync(peerScope, { recursive: true });
  for (const peer of [
    'cordis',
    'dsh-agent',
    'dsh-llm',
    'dsh-session',
    'dsh-typert-protocol',
    'dsh-typert-registry',
    'dsh-api-gateway',
  ]) {
    const destination = join(peerScope, peer);
    if (!existsSync(destination)) {
      symlinkSync(join(projectRoot, 'node_modules', '@deepseek-ai', peer), destination, 'dir');
    }
  }
  writeFileSync(
    join(consumerDir, 'production-smoke.mjs'),
    `import GovernorPlugin from 'dsh-llm-governor';
import { TYPERT } from 'dsh-llm-governor/typert';
import { GOVERNOR_REMOTE_CONTRIBUTION } from 'dsh-llm-governor/remote';
import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway';

const ctx = new Context();
const registry = ctx.plugin(TypertRegistry);
await registry;
const unregister = ctx.typert.register(TYPERT);
const llm = ctx.plugin(LlmRuntime);
await llm;
const governor = ctx.plugin(GovernorPlugin, {
  schema_version: 1,
  identity: { provider: 'local', local_user_id: 'owner' },
  storage: { enabled: false },
  ui: { enabled: false },
  models: { 'p:a': { enabled: true, multiplier: 1 } },
});
await governor;
const gateway = ctx.plugin(TypertGatewayService);
await gateway;
const models = await ctx.typertGateway.invoke({ namespace: 'governor', method: 'listModels', args: {} });
if (!Array.isArray(models) || models[0]?.routeId !== 'p:a') process.exitCode = 2;
if (GOVERNOR_REMOTE_CONTRIBUTION.package !== 'dsh-llm-governor') process.exitCode = 3;
await gateway.dispose();
await governor.dispose();
await llm.dispose();
await unregister();
await registry.dispose();
`,
  );
  execSync('node production-smoke.mjs', { cwd: consumerDir, stdio: 'inherit' });
  rootDistAfter = directoryDigest(join(projectRoot, 'dist'));
});

afterAll(() => {
  if (workDir && existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

describe('package smoke (pnpm pack + dist)', () => {
  it('临时构建与打包不修改仓库 dist/**', () => {
    expect(rootDistAfter).toBe(rootDistBefore);
  });

  it('仓库直接 DSH 依赖统一为 rc.8 且不存在版本别名', () => {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
    };
    const dependencies = pkg.devDependencies ?? {};
    const directDsh = Object.entries(dependencies).filter(([name]) =>
      name.startsWith('@deepseek-ai/dsh'),
    );

    expect(directDsh.length).toBeGreaterThan(0);
    expect(directDsh.every(([, version]) => version === '0.1.0-rc.8')).toBe(true);
    expect(Object.keys(dependencies).some((name) => /^dsh-.+-rc\d+$/.test(name))).toBe(false);
  });

  it('lockfile 中每个 DSH 包只解析一个版本', () => {
    const lockfile = readFileSync(join(projectRoot, 'pnpm-lock.yaml'), 'utf8');
    const versionsByPackage = new Map<string, Set<string>>();
    const packageEntry = /^[ ]{2}'(@deepseek-ai\/dsh(?:-[^@']+)?)@(0\.1\.0-rc\.\d+)':$/gm;

    for (const match of lockfile.matchAll(packageEntry)) {
      const [, name, version] = match;
      if (name === undefined || version === undefined) continue;
      const versions = versionsByPackage.get(name) ?? new Set<string>();
      versions.add(version);
      versionsByPackage.set(name, versions);
    }

    expect(versionsByPackage.size).toBeGreaterThan(0);
    expect(
      [...versionsByPackage]
        .filter(([, versions]) => versions.size > 1)
        .map(([name, versions]) => `${name}: ${[...versions].sort().join(', ')}`),
    ).toEqual([]);
  });

  it('tarball 存在且非空', () => {
    expect(existsSync(tarballPath)).toBe(true);
    expect(statSync(tarballPath).size).toBeGreaterThan(0);
  });

  it('解压后存在 package.json', () => {
    const pkgJsonPath = join(packageDir, 'package.json');
    expect(existsSync(pkgJsonPath)).toBe(true);
  });

  it('解压后包含 dist/index.js 入口', () => {
    const indexPath = join(packageDir, 'dist', 'index.js');
    expect(existsSync(indexPath)).toBe(true);
  });

  it('解压后的 dist/ 包含编译后的 JS 文件（覆盖核心模块）', () => {
    const distRoot = join(packageDir, 'dist');
    expect(existsSync(distRoot)).toBe(true);
    const files = listFilesRecursive(distRoot);
    const jsFiles = files.filter((f) => f.endsWith('.js'));
    expect(jsFiles.length).toBeGreaterThan(0);
    // 核心领域模块均应被编译并随包发布
    expect(jsFiles.some((f) => f.startsWith('access/'))).toBe(true);
    expect(jsFiles.some((f) => f.startsWith('classifier/'))).toBe(true);
    expect(jsFiles.some((f) => f.startsWith('credits/'))).toBe(true);
    expect(jsFiles.some((f) => f.startsWith('dsh-adapter/'))).toBe(true);
    expect(jsFiles.some((f) => f.startsWith('routing/'))).toBe(true);
    expect(jsFiles.some((f) => f.startsWith('fallback/'))).toBe(true);
    expect(jsFiles.some((f) => f.startsWith('identity/'))).toBe(true);
    expect(jsFiles).toContain('plugin/typert-host.js');
    expect(jsFiles).toContain('plugin/typert-remote-client.js');
    expect(jsFiles).toContain('client.js');
  });

  it('dist/index.js 是有效的 ESM 产物（含 export 语句）', () => {
    const indexPath = join(packageDir, 'dist', 'index.js');
    const content = readFileSync(indexPath, 'utf8');
    expect(content).toMatch(/\bexport\b/);
  });

  it('package.json 的 peerDependencies 正确', () => {
    const pkgJsonPath = join(packageDir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>;
    const peer = pkg.peerDependencies as Record<string, string> | undefined;
    expect(peer).toBeDefined();
    expect(peer?.['@deepseek-ai/cordis']).toBe('>=4.0.1 <5');
    expect(peer?.['@deepseek-ai/dsh-agent']).toBe('>=0.1.0-rc.8 <0.2.0-0');
    expect(peer?.['@deepseek-ai/dsh-llm']).toBe('>=0.1.0-rc.8 <0.2.0-0');
    expect(peer?.['@deepseek-ai/dsh-session']).toBe('>=0.1.0-rc.8 <0.2.0-0');
    expect(peer?.['@deepseek-ai/dsh-typert-protocol']).toBe('>=0.1.0-rc.8 <0.2.0-0');
  });

  it('package.json 包含正确的 name/version/type/license 元数据', () => {
    const pkgJsonPath = join(packageDir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>;
    expect(pkg.name).toBe('dsh-llm-governor');
    expect(pkg.version).toBe('0.1.0');
    expect(pkg.type).toBe('module');
    expect(pkg.license).toBe('MIT');
  });
});
