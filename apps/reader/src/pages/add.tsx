/**
 * Adding feeds: find one at an address (tela-jobs fetches it), subscribe, or import an OPML
 * file. These are RPCs, not mutations: the member needs the answer (ADR 0025).
 */
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useTranslations } from 'use-intl'
import { readingHref } from '../lib/href'
import { useTitle } from '../lib/title'
import { apiJson } from '../store/api'
import { useStore } from '../store/hooks'

type Candidate = { url: string; title: string | null; format: string; itemCount: number }
type AddError = 'invalid_url' | 'fetch_failed' | 'rate_limited' | 'opml_invalid' | 'opml_too_large'

/** tela-api's answer, as the message the page has for it. */
export function addError(code: string | undefined): AddError {
  if (
    code === 'invalid_url' ||
    code === 'rate_limited' ||
    code === 'opml_invalid' ||
    code === 'opml_too_large'
  )
    return code
  return 'fetch_failed'
}

const ERROR = 'text-sm text-[oklch(0.5_0.15_25)]'

export function AddPage() {
  const t = useTranslations('add')
  useTitle(t('title'))
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-4 py-12 animate-fade md:px-8">
      <div>
        <h1 className="font-serif text-[34px] font-medium leading-tight tracking-tight">
          {t('title')}
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{t('intro')}</p>
      </div>
      <AddFeedForm />
      <div className="border-t border-line pt-8">
        <h2 className="font-serif text-[22px] font-medium">{t('opml')}</h2>
        <p className="mb-3 text-[13px] text-muted">{t('opmlHint')}</p>
        <OpmlForm />
      </div>
    </main>
  )
}

function AddFeedForm() {
  const t = useTranslations('add')
  const { engine } = useStore()
  const navigate = useNavigate()
  const [url, setUrl] = useState('')
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [error, setError] = useState<AddError | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const find = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy('find')
    setError(null)
    setCandidates(null)
    try {
      const { status, body } = await apiJson<{ feeds?: Candidate[]; error?: string }>(
        '/api/v1/feeds/discover',
        {
          body: { url },
        },
      )
      if (status === 200 && body.feeds) setCandidates(body.feeds)
      else if (body?.error === 'not_a_feed') setCandidates([])
      else setError(addError(body?.error))
    } catch {
      setError('fetch_failed')
    } finally {
      setBusy(null)
    }
  }

  const subscribe = async (feedUrl: string) => {
    setBusy(feedUrl)
    setError(null)
    try {
      const { status, body } = await apiJson<{ feedId?: number; error?: string }>('/api/v1/feeds', {
        body: { feedUrl },
      })
      if (status !== 200 || body.feedId === undefined) {
        setError(addError(body?.error))
        return
      }
      // The subscription and the feed arrive by sync; the reading page waits for its first posts.
      void engine.pull()
      navigate(readingHref({ feedId: body.feedId }))
    } catch {
      setError('fetch_failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={(e) => void find(e)} className="flex gap-2">
        <input
          name="url"
          type="text"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t('placeholder')}
          className="min-w-0 flex-1 rounded-lg border border-line bg-white px-3 py-2.5 outline-none focus:border-muted"
          data-testid="feed-url"
        />
        <button
          type="submit"
          disabled={busy !== null}
          className="whitespace-nowrap rounded-full bg-ink px-4 py-2.5 font-medium text-paper hover:brightness-125 disabled:opacity-60"
          data-testid="find-feeds"
        >
          {busy === 'find' ? t('searching') : t('find')}
        </button>
      </form>
      {error ? (
        <p className={ERROR} data-testid="add-error">
          {t(`errors.${error}`)}
        </p>
      ) : null}
      {candidates && candidates.length === 0 ? (
        <p className="text-sm text-muted">{t('none')}</p>
      ) : null}
      {candidates && candidates.length > 0 ? (
        <ul className="flex flex-col gap-2" data-testid="feed-candidates">
          {candidates.map((c) => (
            <li
              key={c.url}
              className="flex items-center gap-3 rounded-xl border border-line bg-white px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{c.title ?? c.url}</div>
                <div className="truncate text-[12.5px] text-muted">
                  {c.url} · {c.format.toUpperCase()} · {t('items', { n: c.itemCount })}
                </div>
              </div>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void subscribe(c.url)}
                className="rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-medium text-paper hover:brightness-125 disabled:opacity-60"
                data-testid="subscribe"
              >
                {t('subscribe')}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function OpmlForm() {
  const t = useTranslations('add')
  const { engine } = useStore()
  const [file, setFile] = useState<File | null>(null)
  const [imported, setImported] = useState<number | null>(null)
  const [error, setError] = useState<AddError | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!file) return
    setBusy(true)
    setError(null)
    setImported(null)
    try {
      if (file.size > 1024 * 1024) {
        setError('opml_too_large')
        return
      }
      const { status, body } = await apiJson<{ feeds?: number; error?: string }>(
        '/api/v1/feeds/opml',
        {
          method: 'POST',
          raw: await file.text(),
        },
      )
      if (status !== 200 || body.feeds === undefined) {
        setError(addError(body?.error))
        return
      }
      setImported(body.feeds)
      void engine.pull()
    } catch {
      setError('fetch_failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-center gap-3">
      <input
        name="opml"
        type="file"
        accept=".opml,.xml,text/xml,application/xml,text/x-opml"
        required
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="text-sm"
        data-testid="opml-file"
      />
      <button
        type="submit"
        disabled={busy}
        className="rounded-full border border-ink px-4 py-2 font-medium hover:bg-ink hover:text-paper disabled:opacity-60"
        data-testid="opml-import"
      >
        {t('import')}
      </button>
      {imported !== null ? (
        <span className="text-sm text-ink-2" data-testid="opml-result">
          {t('imported', { n: imported })}
        </span>
      ) : null}
      {error ? <span className={ERROR}>{t(`errors.${error}`)}</span> : null}
    </form>
  )
}
