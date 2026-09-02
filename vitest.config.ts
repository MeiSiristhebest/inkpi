import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      thresholds: {
        lines: 85,
        branches: 80,
        functions: 85,
        statements: 85
      },
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/tests/**',
        '**/*.test.ts',
        'packages/protocol/**',
        '**/types.ts',
        'scripts/**',
        'vitest.config.ts',
        'packages/ai/src/models.generated.ts',
        'packages/agent-core/src/plugins/index.ts',
        'packages/agent-core/src/clipboard/system-clipboard.ts'
      ]

    },
    alias: {
      '@inkpi/protocol': resolve(__dirname, './packages/protocol/src/index.ts'),
      '@inkpi/tui': resolve(__dirname, './packages/tui/src/index.ts'),
      '@inkpi/ai': resolve(__dirname, './packages/ai/src/index.ts'),
      '@inkpi/agent-core': resolve(__dirname, './packages/agent-core/src/index.ts'),
      '@inkpi/editor-core': resolve(__dirname, './packages/editor-core/src/index.ts'),
      '@inkpi/storage': resolve(__dirname, './packages/storage/src/index.ts'),
      '@inkpi/session-backends': resolve(__dirname, './packages/session-backends/src/index.ts'),
      '@inkpi/client': resolve(__dirname, './packages/client/src/index.ts'),
      '@inkpi/server': resolve(__dirname, './packages/server/src/index.ts'),
      '@inkpi/evals': resolve(__dirname, './packages/evals/src/index.ts')
    }
  }
});
