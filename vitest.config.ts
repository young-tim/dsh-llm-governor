import { defineConfig } from 'vitest/config';

/**
 * Vitest 配置：使用 projects 区分 rc7/rc.8 合同测试与后续单元/集成/UI/Eval 测试。
 * 合同测试在 rc7（默认安装）与 rc8（别名安装）下各跑一遍。
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'ui',
          include: ['test/ui/**/*.test.ts'],
          testTimeout: 30000,
        },
      },
      {
        test: {
          name: 'package',
          include: ['test/package/**/*.test.ts'],
          testTimeout: 60000,
        },
      },
      {
        test: {
          name: 'contracts-rc7',
          include: ['test/contracts/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'contracts-rc8',
          include: ['test/contracts/**/*.test.ts'],
        },
        resolve: {
          alias: [
            {
              find: /^@deepseek-ai\/dsh-llm(\/.*)?$/,
              replacement: 'dsh-llm-rc8$1',
            },
            {
              find: /^@deepseek-ai\/dsh-agent(\/.*)?$/,
              replacement: 'dsh-agent-rc8$1',
            },
            {
              find: /^@deepseek-ai\/dsh-session(\/.*)?$/,
              replacement: 'dsh-session-rc8$1',
            },
          ],
        },
      },
      {
        test: {
          name: 'eval',
          include: ['test/eval/**/*.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/index.ts', 'test/**'],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
});
