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
        'packages/tui/src/components/box.ts',
        'packages/tui/src/components/h-stack.ts',
        'packages/tui/src/components/v-stack.ts',
        'packages/tui/src/components/spacer.ts',
        'packages/agent-core/src/plugins/index.ts',
        'packages/agent-core/src/clipboard/system-clipboard.ts'
      ]

    },
    alias: {
      '@meisiristhebest/protocol': resolve(__dirname, './packages/protocol/src/index.ts'),
      '@meisiristhebest/tui': resolve(__dirname, './packages/tui/src/index.ts'),
      '@meisiristhebest/ai': resolve(__dirname, './packages/ai/src/index.ts'),
      '@meisiristhebest/agent-core': resolve(__dirname, './packages/agent-core/src/index.ts'),
      '@meisiristhebest/editor-core': resolve(__dirname, './packages/editor-core/src/index.ts'),
      '@meisiristhebest/storage': resolve(__dirname, './packages/storage/src/index.ts'),
      '@meisiristhebest/session-backends': resolve(__dirname, './packages/session-backends/src/index.ts'),
      '@meisiristhebest/client': resolve(__dirname, './packages/client/src/index.ts'),
      '@meisiristhebest/server': resolve(__dirname, './packages/server/src/index.ts'),
      '@meisiristhebest/evals': resolve(__dirname, './packages/evals/src/index.ts')
    }
  }
});
