import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev, /api/* is proxied to the Go backend (default :8080).
// We do NOT rewrite the path: the Go server expects /api/* (e.g. /api/health).
// Override with VITE_API_TARGET if your backend listens elsewhere.
const apiTarget = process.env.VITE_API_TARGET || 'http://127.0.0.1:8080'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      }
    }
  }
})
