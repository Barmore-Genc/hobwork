import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const host = 'http://localhost:7420'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // ws: the Apple apps' device socket is /api/devices/ws.
      '/api': { target: host, ws: true },
      '/auth': host,
      '/theme': host,
      '/oauth': host,
      '/.well-known': host,
      '/mcp': host,
    },
  },
})
