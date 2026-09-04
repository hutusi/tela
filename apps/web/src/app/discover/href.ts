import { isTopic } from '@tela/shared'

export type DiscoverParams = { topic: string | null; lang: string | null }

export function parseDiscoverParams(
  raw: Record<string, string | string[] | undefined>,
): DiscoverParams {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
  const topic = one(raw.topic)
  const lang = one(raw.lang)
  return {
    topic: topic && isTopic(topic) ? topic : null,
    lang: lang && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(lang) ? lang : null,
  }
}

export function discoverHref(params: Partial<DiscoverParams>): string {
  const q = new URLSearchParams()
  if (params.topic) q.set('topic', params.topic)
  if (params.lang) q.set('lang', params.lang)
  const s = q.toString()
  return s ? `/discover?${s}` : '/discover'
}
