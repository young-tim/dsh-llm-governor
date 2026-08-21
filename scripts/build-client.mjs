import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild-wasm';

const packageId = 'dsh-llm-governor';
const outputPath = resolve(process.env['DSH_GOVERNOR_CLIENT_OUTFILE'] ?? 'dist/client.js');
const result = await build({
  entryPoints: [resolve('src/client/index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  write: false,
  legalComments: 'none',
  external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-client-runtime/client', 'react'],
});

// With `write: false` and no explicit outfile esbuild names the single output
// `<stdout>` rather than `*.js`.  There is exactly one JS entry and CSS is not
// imported by this client, so the first output is the browser module body.
const javascript = result.outputFiles[0];
if (javascript === undefined) {
  throw new Error('governor client build produced no JavaScript output');
}

const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(packageId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${javascript.text
  .split('\n')
  .map((line) => `    ${line}`)
  .join('\n')}
    return module.exports;
  }
});
`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, wrapped, 'utf8');
