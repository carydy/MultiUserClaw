import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3085,
    proxy: {
      '/api/openclaw/events/stream': {
        target: 'http://localhost:8080',
        configure: (proxy: any) => {
          proxy.on('proxyRes', (proxyRes: any) => {
            proxyRes.headers['cache-control'] = 'no-cache'
            proxyRes.headers['x-accel-buffering'] = 'no'
          })
        },
      },
      '/api/openclaw/terminal/ws': {
        target: 'http://localhost:8080',
        ws: true,
      },
      '/api': 'http://localhost:8080',
    },
  },
})
