// Milestone 21 soak config. The default jest.config.js `testMatch` only
// discovers the `__tests__` directory; the thousand-item soak lives in `soak/`
// and runs solely via `pnpm --filter ./extensions/queue-ingress test:soak`.
// Everything here mirrors jest.config.js (same ts-jest ESM transform, same
// moduleNameMapper) except the discovery glob and coverage — a soak is a
// correctness/scale check, not a coverage target, so no threshold applies.

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
  testMatch: ['**/soak/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
};
