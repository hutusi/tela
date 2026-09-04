import { rewriteImages, signImageUrl } from '@tela/content/images'
import { imageProxySecret } from './platform/env'

/** Article HTML ready to render: image sources go through the signed proxy when configured. */
export async function renderArticleHtml(html: string): Promise<string> {
  if (!html) return ''
  const secret = await imageProxySecret()
  if (!secret) return html
  return rewriteImages(html, (url) => signImageUrl(url, secret))
}
