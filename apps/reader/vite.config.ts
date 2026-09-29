import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// One Vite project, one Worker (ADR 0020): the SPA's static assets and the edge Worker in
// worker/, built together. `vite dev` also runs tela-api and tela-jobs beside it, so the whole
// stack runs locally in workerd with its service bindings.
export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    tailwindcss(),
    cloudflare({
      configPath: './wrangler.jsonc',
      ...(command === 'serve'
        ? {
            auxiliaryWorkers: [
              { configPath: '../api/wrangler.jsonc' },
              { configPath: '../jobs/wrangler.jsonc' },
            ],
          }
        : {}),
    }),
  ],
}))
