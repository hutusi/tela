/**
 * Claiming a blog (ADR 0011, 0018): give its address, put a proof on the home page, then ask for
 * the check. The check runs in tela-jobs; this page asks how it went every few seconds.
 *
 * For writers' card lands here as `/claim?url=…`, the address filled in, and with `&taken=1`
 * when the handle it chose was someone else's by the time the account was made.
 */
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useTranslations } from 'use-intl'
import { useTitle } from '../lib/title'
import { apiJson } from '../store/api'
import { NotFoundPage } from './not-found'

type Standing =
  | { siteId: number; homeUrl: string; status: 'verified' }
  | { siteId: number; homeUrl: string; status: 'claimed_by_other' }
  | {
      siteId: number
      homeUrl: string
      status: 'unverified' | 'pending' | 'failed'
      error: string | null
      proofs: { meta: string; relMe: string }
    }

type StartError = 'invalid_url' | 'fetch_failed' | 'no_feed' | 'rate_limited'

export function claimError(code: string | undefined): StartError {
  if (code === 'invalid_url' || code === 'rate_limited') return code
  if (code === 'not_a_feed') return 'no_feed'
  return 'fetch_failed'
}

const POLL_MS = 2500
const POLL_FOR_MS = 120_000
const ERROR = 'text-sm text-danger'

export function ClaimPage() {
  const t = useTranslations('claim')
  const navigate = useNavigate()
  const [search] = useSearchParams()
  const [url, setUrl] = useState(() => search.get('url') ?? '')
  const taken = search.get('taken') === '1'
  const [error, setError] = useState<StartError | null>(null)
  const [busy, setBusy] = useState(false)
  useTitle(t('title'))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { status, body } = await apiJson<Standing & { error?: string }>('/api/v1/claims', {
        body: { url },
      })
      if (status === 200 && body.siteId) navigate(`/sites/${body.siteId}/claim`)
      else setError(claimError(body?.error ?? undefined))
    } catch {
      setError('fetch_failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-4 py-12 animate-fade md:px-8">
      <div>
        <h1 className="font-serif text-[34px] font-medium leading-tight tracking-tight">
          {t('title')}
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{t('intro')}</p>
      </div>
      {taken ? (
        <p
          className="m-0 rounded-xl border border-line bg-surface px-4 py-3 text-[14px] leading-relaxed text-ink-2"
          data-testid="claim-taken"
        >
          {t.rich('taken', { link: (chunks) => <Link to="/settings">{chunks}</Link> })}
        </p>
      ) : null}
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <div className="flex gap-2">
          <input
            name="url"
            type="text"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://your.blog"
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2.5 outline-none focus:border-muted"
            data-testid="claim-url"
          />
          <button
            type="submit"
            disabled={busy}
            className="whitespace-nowrap rounded-full bg-ink px-4 py-2.5 font-medium text-paper hover:brightness-125 disabled:opacity-60"
            data-testid="claim-continue"
          >
            {busy ? t('searching') : t('continue')}
          </button>
        </div>
        {error ? <p className={ERROR}>{t(`errors.${error}`)}</p> : null}
      </form>
    </main>
  )
}

export function ClaimSitePage() {
  const t = useTranslations('claim')
  const siteId = Number(useParams().siteId)
  const valid = Number.isInteger(siteId) && siteId > 0
  const [standing, setStanding] = useState<Standing | null | 'missing'>(null)
  const [pollingSince, setPollingSince] = useState<number | null>(null)
  useTitle(t('verifyTitle'))

  const load = useCallback(async () => {
    const { status, body } = await apiJson<Standing>(`/api/v1/claims/${siteId}`)
    setStanding(status === 200 ? body : status === 404 ? 'missing' : null)
  }, [siteId])

  useEffect(() => {
    if (valid) load().catch(() => undefined)
  }, [valid, load])

  const pending = standing !== null && standing !== 'missing' && standing.status === 'pending'
  useEffect(() => {
    if (!pending) return
    const since = pollingSince ?? Date.now()
    if (pollingSince === null) setPollingSince(since)
    const id = setInterval(() => {
      if (Date.now() - since > POLL_FOR_MS) clearInterval(id)
      else load().catch(() => undefined)
    }, POLL_MS)
    return () => clearInterval(id)
  }, [pending, pollingSince, load])

  const verify = async () => {
    const { status, body } = await apiJson<Standing>(`/api/v1/claims/${siteId}/verify`, {
      method: 'POST',
    })
    if (status === 200) {
      setPollingSince(Date.now())
      setStanding(body)
    }
  }

  if (!valid || standing === 'missing') return <NotFoundPage />
  if (!standing) return <main className="flex-1" aria-busy="true" />

  return (
    <main
      className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-7 px-4 py-12 animate-fade md:px-8"
      data-testid="claim-page"
      data-status={standing.status === 'claimed_by_other' ? 'claimed' : standing.status}
    >
      <div>
        <h1 className="font-serif text-[34px] font-medium leading-tight tracking-tight">
          {t('verifyTitle')}
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-2">
          {t('verifyIntro', { site: standing.homeUrl })}{' '}
          <a href={standing.homeUrl} target="_blank" rel="noopener noreferrer">
            {standing.homeUrl}
          </a>
        </p>
      </div>

      {standing.status === 'claimed_by_other' ? (
        <p className="rounded-xl border border-line bg-surface p-5 text-ink-2">
          {t('claimedByOther')}
        </p>
      ) : standing.status === 'verified' ? (
        <div
          className="rounded-xl border border-accent/40 bg-surface p-5"
          data-testid="claim-verified"
        >
          <div className="font-medium text-accent">✓ {t('verified')}</div>
          <p className="mt-1 text-[14px] text-ink-2">{t('verifiedHint')}</p>
          <Link
            to={`/s/${siteId}`}
            className="mt-3 inline-block rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-paper hover:no-underline"
          >
            {t('viewSite')}
          </Link>
        </div>
      ) : (
        <>
          <section className="flex flex-col gap-3">
            <h2 className="font-serif text-[22px] font-medium">{t('optionMeta')}</h2>
            <p className="text-[14px] text-ink-2">{t('optionMetaHint')}</p>
            <pre
              className="overflow-x-auto rounded-lg border border-line bg-surface px-4 py-3 text-[13px]"
              data-testid="meta-snippet"
            >
              {standing.proofs.meta}
            </pre>
          </section>
          <section className="flex flex-col gap-3">
            <h2 className="font-serif text-[22px] font-medium">{t('optionRelMe')}</h2>
            <p className="text-[14px] text-ink-2">{t('optionRelMeHint')}</p>
            <pre className="overflow-x-auto rounded-lg border border-line bg-surface px-4 py-3 text-[13px]">
              {standing.proofs.relMe}
            </pre>
          </section>
          <div className="flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={() => void verify()}
              disabled={pending}
              className="rounded-full bg-ink px-5 py-2.5 font-medium text-paper hover:brightness-125 disabled:opacity-60"
              data-testid="claim-verify"
            >
              {standing.status === 'failed' ? t('verifyAgain') : t('verify')}
            </button>
            {pending ? <span className="text-[13px] text-muted">{t('checking')}</span> : null}
            {standing.status === 'failed' && standing.error ? (
              <span className="text-[13px] text-danger" data-testid="claim-error">
                {t('failed')} {standing.error}
              </span>
            ) : null}
          </div>
        </>
      )}
    </main>
  )
}
