// A filtered run (`jest <pattern>`, e.g. `pnpm --filter ./packages/framework-core
// test -- identity-contract`) executes only a subset of src/, so the global
// coverage thresholds cannot hold there — skip them when a positional test-path
// pattern is present. Unfiltered runs (the `pnpm -r test` full-suite bar) keep
// the thresholds; they are never lowered.
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
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
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
