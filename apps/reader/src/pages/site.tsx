import { TOPICS } from '@tela/shared'
import { useState } from 'react'
import { useParams } from 'react-router'
import { useTranslations } from 'use-intl'
import { displayHost } from '../lib/format'
import { useMemberControls } from '../lib/member'
import { useTitle } from '../lib/title'
import { forgetPublic, usePublic } from '../lib/use-public'
import { api } from '../store/api'
import { useNow } from '../store/hooks'
import { useUi } from '../ui'
import { SiteView } from '../views/site'
import type { SiteData } from '../views/types'
import { NotFoundPage } from './not-found'

export const sitePath = (siteId: number) => `/api/v1/public/sites/${siteId}`

export function SitePage() {
  const siteId = Number(useParams().siteId)
  const valid = Number.isInteger(siteId) && siteId > 0
  const loaded = usePublic<SiteData>(valid ? sitePath(siteId) : null)
  const member = useMemberControls()
  const { locale } = useUi()
  const now = useNow()
  const data = loaded.status === 'ready' ? loaded.data : null
  useTitle(data ? (data.site.title ?? displayHost(data.site.homeUrl)) : null)

  if (!valid || loaded.status === 'missing') return <NotFoundPage />
  if (!data) return <main className="flex-1" aria-busy="true" />
  const owner = member?.handle != null && data.site.claimedBy === member.handle
  return (
    <SiteView
      data={data}
      member={member}
      locale={locale}
      now={now}
      ownerPanel={owner ? <TopicsForm siteId={data.site.id} topics={data.topics} /> : null}
    />
  )
}

/** The blog's topics, which its owner picks (they decide where Discover lists it). */
function TopicsForm({ siteId, topics }: { siteId: number; topics: string[] }) {
  const t = useTranslations('site')
  const td = useTranslations('discover')
  const [chosen, setChosen] = useState(() => new Set(topics))
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await api(`/api/v1/sites/${siteId}/topics`, {
        method: 'PUT',
        body: { topics: [...chosen] },
      })
      if (res.ok) {
        forgetPublic(sitePath(siteId))
        forgetPublic('/api/v1/public/discover')
        setSaved(true)
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      onSubmit={(e) => void save(e)}
      className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-4"
      data-testid="topics-form"
    >
      <span className="mr-2 text-[13px] font-medium">{t('yourTopics')}</span>
      {TOPICS.map((topic) => (
        <label
          key={topic}
          className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[12.5px]"
        >
          <input
            type="checkbox"
            checked={chosen.has(topic)}
            onChange={(e) => {
              setSaved(false)
              setChosen((held) => {
                const next = new Set(held)
                if (e.target.checked) next.add(topic)
                else next.delete(topic)
                return next
              })
            }}
          />
          {td(`topics.${topic}`)}
        </label>
      ))}
      <button
        type="submit"
        disabled={busy}
        className="ml-auto rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-medium text-paper disabled:opacity-60"
      >
        {saved ? '✓' : t('saveTopics')}
      </button>
    </form>
  )
}
