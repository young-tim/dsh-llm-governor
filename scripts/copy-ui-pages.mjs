/**
 * 构建辅助脚本：将 src/ui/pages 下的静态 HTML 页面复制到 dist/ui/pages。
 *
 * tsc 只编译 TypeScript，不会复制 HTML；安装后的插件从 dist/ui/pages 提供页面，
 * 因此 build 必须保证这些文件与编译产物一起进入 dist。
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录。 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
/** 源页面目录。 */
const srcDir = join(root, 'src', 'ui', 'pages');
/** 目标页面目录。 */
const destDir = join(root, 'dist', 'ui', 'pages');

if (!existsSync(srcDir)) {
  console.error(`copy-ui-pages: source directory not found: ${srcDir}`);
  process.exit(1);
}

// 全量重建目标目录，避免删除模型后残留旧页面
rmSync(destDir, { recursive: true, force: true });
mkdirSync(destDir, { recursive: true });
cpSync(srcDir, destDir, { recursive: true });

console.log(`copy-ui-pages: copied src/ui/pages -> dist/ui/pages`);
