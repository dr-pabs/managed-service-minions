// A filtered run (`jest <pattern>`, e.g. the Milestone 16 gate `pnpm --filter
// ./test test -- e2e-item-pipeline`) executes only a subset of src/, so the
// global coverage thresholds cannot hold there — skip them when a positional
// test-path pattern is present. Unfiltered runs (the `pnpm -r test` full-suite
// bar) keep the thresholds; they are never lowered. Mirrors the same guard
// framework-core and mcp-toolshed grew in Milestones 5 and 14.
const hasTestPathPattern = process.argv.slice(2).some((arg) => !arg.startsWith('-'));

/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true
      }
    ]
  },
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^framework-core$': '<rootDir>/../packages/framework-core/src/index.ts',
    '^mcp-toolshed$': '<rootDir>/../extensions/mcp-toolshed/src/index.ts',
    '^orchestrator$': '<rootDir>/../extensions/orchestrator/src/index.ts',
    '^slack-bot/slack-bot\\.js$': '<rootDir>/../extensions/slack-bot/src/slack-bot.ts',
    '^webhook-ingress/webhook-ingress\\.js$': '<rootDir>/../extensions/webhook-ingress/src/webhook-ingress.ts',
    '^queue-ingress/(.*)\\.js$': '<rootDir>/../extensions/queue-ingress/src/$1.ts'
  },
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  collectCoverageFrom: ['src/prompt-quality/**/*.ts'],
  ...(hasTestPathPattern ? {} : {
    coverageThreshold: {
      global: { branches: 95, functions: 100, lines: 95, statements: 100 }
    }
  }),
  coverageReporters: ['text', 'text-summary', 'lcov']
};
