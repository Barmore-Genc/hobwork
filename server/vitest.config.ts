import { defineConfig } from 'vitest/config'

const INTEGRATION = 'src/**/*.integration.test.ts'

export default defineConfig({
  test: {
    // Vendored, so outside node_modules, but it should load as Node loads it.
    server: { deps: { external: [/\/vendor\/gondolin\//] } },
    projects: [
      { extends: true, test: { name: 'unit', include: ['src/**/*.test.ts'], exclude: [INTEGRATION] } },
      // The integration tests share the entities of one dev Home Assistant.
      { extends: true, test: { name: 'integration', include: [INTEGRATION], fileParallelism: false } },
    ],
  },
})
