// A filtered run (`jest <pattern>`, e.g. the Milestone 17 gate `pnpm --filter
// ./extensions/queue-ingress test -- cost-control`) executes only a subset of
// src/, so the global coverage thresholds cannot hold there — skip them when a
// positional test-path pattern is present. Unfiltered runs (the `pnpm -r test`
// full-suite bar) keep the thresholds; they are never lowered. Mirrors the same
// guard framework-core and mcp-toolshed's jest.config.js grew in Milestones 5
// and 14.
const hasTestPathPattern = process.argv.slice(2).some((arg) => !arg.startsWith('-'));

/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true }],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^framework-core$': '<rootDir>/../../packages/framework-core/src/index.ts',
  },
  testMatch: ['**/__tests__/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  collectCoverageFrom: ['src/**/*.ts'],
  ...(hasTestPathPattern
    ? {}
    : {
        coverageThreshold: {
          global: {
            branches: 95,
            functions: 100,
            lines: 95,
            statements: 100,
          },
        },
      }),
  coverageReporters: ['text', 'text-summary', 'lcov'],
};
