import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: { rollupOptions: { input: 'ui/index.html' } },
  test: {
    include: ['tests/**/*.test.ts'],
    // Isolating each test file re-imports every dependency per file, which makes
    // the suite about 4x slower in the VM. Test files share modules instead, and
    // mocks, stubbed globals and env vars are reset after every test.
    isolate: false,
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
  },
})
