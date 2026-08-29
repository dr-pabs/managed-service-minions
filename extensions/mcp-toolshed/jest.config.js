// A filtered run (`jest <pattern>`, e.g. the Milestone 14 gate `pnpm --filter
// ./extensions/mcp-toolshed test -- effect-gateway`) executes only a subset of
// src/, so the global coverage thresholds cannot hold there — skip them when a
// positional test-path pattern is present. Unfiltered runs (the `pnpm -r test`
// full-suite bar) keep the thresholds; they are never lowered. Mirrors the same
// guard framework-core's jest.config.js grew in Milestone 5.
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
  },
  // Explicit (not jest's default): only *.test.ts files are suites. The
  // default also matches support scripts that live under __tests__ (e.g.
  // the azurite two-replica child), which then run outside a test context.
  testMatch: ['**/__tests__/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  // The azurite two-replica child is a support script driven over stdio by
  // the integration suite, not library code — it has no in-process coverage.
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/', 'azurite-breaker-replica'],
  collectCoverageFrom: ['src/**/*.ts'],
  ...(hasTestPathPattern ? {} : {
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
