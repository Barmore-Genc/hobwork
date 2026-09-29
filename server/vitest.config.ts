import { defineConfig } from 'vitest/config'

const INTEGRATION = 'src/**/*.integration.test.ts'

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['src/**/*.test.ts'], exclude: [INTEGRATION] } },
      // The integration tests share the entities of one dev Home Assistant.
      { test: { name: 'integration', include: [INTEGRATION], fileParallelism: false } },
    ],
  },
})
