// Mutation testing for the format/merge logic. Run with `npm run test:mutation`.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  mutate: ['src/core/**/*.ts', '!src/core/**/*.test.ts', '!src/core/types.ts', '!src/core/fixtures.ts'],
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  // The ~12 surviving mutants are equivalent (no test can tell them apart), so 95 is the floor.
  thresholds: { high: 98, low: 95, break: 95 },
  tempDirName: '.stryker-tmp',
  // Stryker rewrites tsconfig.json through the TypeScript JS API, which TypeScript 7 (native)
  // no longer ships. Our tsconfig has no extends/references, so the rewrite isn't needed:
  // naming a file that doesn't exist skips it.
  tsconfigFile: 'stryker-skip-tsconfig-rewrite.json',
};
