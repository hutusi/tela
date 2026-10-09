import { isTopic } from '@tela/shared'

/** `page` counts from 1; the first page's URL leaves it out. */
export type DiscoverParams = { topic: string | null; lang: string | null; page: number }

export function parseDiscoverParams(search: URLSearchParams): DiscoverParams {
  const topic = search.get('topic')
  const lang = search.get('lang')
  const page = Number(search.get('page'))
  return {
    topic: topic && isTopic(topic) ? topic : null,
    lang: lang && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(lang) ? lang : null,
    page: Number.isInteger(page) && page > 1 && page <= 1000 ? page : 1,
  }
}

export function discoverHref(params: Partial<DiscoverParams>): string {
  const q = new URLSearchParams()
  if (params.topic) q.set('topic', params.topic)
  if (params.lang) q.set('lang', params.lang)
  if (params.page && params.page > 1) q.set('page', String(params.page))
  const s = q.toString()
  return s ? `/discover?${s}` : '/discover'
}

/** The public endpoint a Discover URL reads. */
export function discoverApiPath(params: DiscoverParams): string {
  return `/api/v1/public${discoverHref(params)}`
}
