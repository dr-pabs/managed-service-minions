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
    '^webhook-ingress/webhook-ingress\\.js$': '<rootDir>/../extensions/webhook-ingress/src/webhook-ingress.ts'
  },
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  collectCoverageFrom: ['src/prompt-quality/**/*.ts'],
  coverageThreshold: {
    global: { branches: 95, functions: 100, lines: 95, statements: 100 }
  },
  coverageReporters: ['text', 'text-summary', 'lcov']
};
