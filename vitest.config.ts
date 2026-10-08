import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test file patterns
    include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'],

    // Exclude patterns
    exclude: ['**/node_modules/**', '**/dist/**', '**/bin/**'],

    // Test environment
    environment: 'node',

    // Timeout for tests (10 seconds default, useful for async operations)
    testTimeout: 10000,

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'bin/',
        'tests/',
        '*.config.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
      ],
    },

    // Global test setup
    globals: false, // Use explicit imports for better IDE support

    // Watch mode settings
    watch: false, // Don't run in watch mode by default

    // Every test file runs against local fakes on random ports, so files can run in parallel
    fileParallelism: true,
  },
});
