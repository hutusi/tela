import type { MetadataRoute } from 'next'
import { isPrivateBeta } from '@/lib/platform/env'

/** Crawlers are turned away while Tela is in private testing; afterwards everything is fair game. */
export default function robots(): MetadataRoute.Robots {
  return isPrivateBeta()
    ? { rules: { userAgent: '*', disallow: '/' } }
    : { rules: { userAgent: '*', allow: '/' } }
}
