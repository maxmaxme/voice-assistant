import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Inline tsconfig for the oxc transform instead of per-file discovery.
  // Discovery breaks the web↔core contract suite in CI: transforming
  // web/server/** finds web/tsconfig.json, whose project references point at
  // nuxt-generated .nuxt/tsconfig.*.json — absent unless `nuxt prepare` ran
  // (the root test job installs only root deps). The inline config mirrors
  // the only transform-relevant root tsconfig option.
  oxc: {
    tsconfig: { compilerOptions: { verbatimModuleSyntax: true } },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
  },
});
