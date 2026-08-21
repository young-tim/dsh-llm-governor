import { defineConfig } from 'vitest/config';

/**
 * Vitest 配置：使用 projects 区分 rc.8 合同测试与单元/集成/UI/Eval 测试。
 * oxc target 固定为 es2022：esnext 下 oxc 不降级 TC39 装饰器语法，
 * 而 Node 24 尚不支持原生装饰器，会导致含 @Remote() 等装饰器的模块无法加载。
 */
export default defineConfig({
  oxc: { target: 'es2022' },
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
          name: 'contracts',
          include: ['test/contracts/**/*.test.ts'],
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
