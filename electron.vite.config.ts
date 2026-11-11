import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Built app only: no inline scripts or handlers can run in the window, whatever an email contains.
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src * data: blob:; " +
  "font-src 'self' data: https:; object-src 'none'; base-uri 'none'"

// Entry points use electron-vite defaults:
// src/main/index.ts, src/preload/index.ts, src/renderer/index.html
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [
      react(),
      {
        name: 'quickmail-csp',
        apply: 'build',
        transformIndexHtml: html =>
          html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`)
      }
    ]
  }
})
