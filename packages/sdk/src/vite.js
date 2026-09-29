// Plain JavaScript with a .d.ts next to it, because Vite loads vite.config.ts
// dependencies with Node, which does not strip types under node_modules.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { parseHobworkJson } from './hobwork-json.js'

// Hobwork loads each handler in hobwork.json from dist/handlers/<path without
// extension>.js, with its dependencies bundled in.
export function handlerEntries(dir) {
  const config = parseHobworkJson(readFileSync(join(dir, 'hobwork.json'), 'utf8'))
  const handlers = [config.routes, config.crons, config.webhooks, config.triggers]
    .flatMap((entries) => Object.values(entries ?? {}))
    .map((entry) => entry.handler)
  return Object.fromEntries(handlers.map((path) => [path.replace(/^\.\//, '').replace(/\.[cm]?[jt]sx?$/, ''), path]))
}

export function hobworkViteConfig(dir = process.cwd()) {
  return {
    base: '/',
    plugins: [react(), tailwindcss()],
    // `vite build` builds the dashboard (client) and the handlers.
    builder: {},
    environments: {
      client: { build: { rollupOptions: { input: 'index.html' } } },
      handlers: {
        consumer: 'server',
        resolve: { noExternal: true },
        build: {
          outDir: 'dist/handlers',
          rollupOptions: { input: handlerEntries(dir), output: { format: 'es', entryFileNames: '[name].js' } },
        },
      },
    },
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
  }
}
