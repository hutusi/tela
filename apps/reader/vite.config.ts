import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * The faces every page sets text in first: Figtree for the interface, EB Garamond 500 for the
 * headings and the list's titles. Latin only, the subset English, French and the Latin in Chinese
 * all use (styles.css imports every subset, each with its `unicode-range`).
 */
const PRELOAD_FONTS = ['figtree-latin-400-normal', 'eb-garamond-latin-500-normal']

/**
 * Preload those faces from index.html, so they download beside the stylesheet rather than after
 * it has been parsed and the first text laid out. Their names carry the build's hash, so they are
 * read from the bundle. `sw.js` precaches what index.html links, these with it, and the edge pours
 * its public pages into this file, so they preload there too. A build that finds either missing
 * (a fontsource release renamed it) fails rather than ship without.
 */
function preloadFonts(): Plugin {
  let base = '/'
  return {
    name: 'tela-preload-fonts',
    apply: 'build',
    configResolved(config) {
      base = config.base
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        if (!ctx.bundle) return
        const files = Object.values(ctx.bundle).map((chunk) => chunk.fileName)
        return PRELOAD_FONTS.map((face) => {
          const file = files.find((name) => new RegExp(`(^|/)${face}-[\\w-]+\\.woff2$`).test(name))
          if (!file) throw new Error(`preloadFonts: no ${face}.woff2 in the bundle`)
          return {
            tag: 'link',
            // A font is fetched in CORS mode: a preload without `crossorigin` is not used for it.
            attrs: {
              rel: 'preload',
              href: `${base}${file}`,
              as: 'font',
              type: 'font/woff2',
              crossorigin: true,
            },
            injectTo: 'head' as const,
          }
        })
      },
    },
  }
}

// One Vite project, one Worker (ADR 0020): the SPA's static assets and the edge Worker in
// worker/, built together. `vite dev` also runs tela-api and tela-jobs beside it, so the whole
// stack runs locally in workerd with its service bindings.
export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    tailwindcss(),
    preloadFonts(),
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
