/**
 * 打包安装 smoke 测试：
 * - 先运行 `pnpm build` 确保 dist/ 存在
 * - 使用 `pnpm pack --pack-destination <临时目录>` 打包
 * - 解压 tarball 到临时目录
 * - 验证 tarball 包含 package.json、dist/index.js 以及 dist 下所有 JS 文件
 * - 验证 dist/ 中有编译后的 JS 文件
 * - 验证 package.json 的 peerDependencies 正确
 *
 * 不读取或修改真实 Profile/凭证/Provider，全程使用临时目录。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
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

// beforeAll 执行 tsc 编译 + pnpm pack + tar 解压（实测合计约 3 秒），
// 默认 hook 超时即可覆盖，不得放宽超时规避门禁失败。
beforeAll(() => {
  // 1. 先运行 tsc 确保 dist/ 存在（绕过 pnpm deps status check）
  execSync('npx tsc -p tsconfig.json', { cwd: projectRoot, stdio: 'inherit' });

  // 2. 创建临时工作目录（不触碰真实 DSH_HOME / Profile / 凭证）
  workDir = mkdtempSync(join(tmpdir(), 'dsh-gov-pack-'));

  // 3. 打包到临时目录
  execSync(`pnpm pack --pack-destination "${workDir}"`, {
    cwd: projectRoot,
    stdio: 'inherit',
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
});

afterAll(() => {
  if (workDir && existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

describe('package smoke (pnpm pack + dist)', () => {
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
