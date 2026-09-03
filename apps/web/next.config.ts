import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare'
import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source; Next compiles them.
  transpilePackages: ['@tela/db', '@tela/shared', '@tela/content'],
  // Body images go through the signed /img proxy, never next/image optimization.
  images: { unoptimized: true },
}

export default withNextIntl(nextConfig)

// Makes Cloudflare bindings (Hyperdrive, ASSETS) available during `next dev` only.
// Under `next start` it would boot a local Workers runtime whose fake Hyperdrive
// binding shadows DATABASE_URL.
if (process.env.NODE_ENV === 'development') {
  initOpenNextCloudflareForDev()
}
