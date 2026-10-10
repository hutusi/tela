/**
 * Claiming a blog (ADRs 0011, 0018, 0045): give its address, show it is yours (a GitHub that
 * links it both ways, a link to the profile, or a meta tag), then ask for the check, which tries
 * every way. It runs in tela-jobs; this page asks how it went every few seconds, and words what
 * the check found when it found no proof.
 *
 * For writers' card lands here as `/claim?url=…`, the address filled in, and with `&taken=1`
 * when the handle it chose is another member's.
 */
import type { ClaimReason } from '@tela/shared'
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
      /** A failure in words, as the check wrote it (the page did not answer, an operator's word). */
      error: string | null
      /** What the check found when it found no proof, for this page to word. */
      reason: ClaimReason | null
      /** Whether the member has a GitHub on their account to claim by. */
      github: boolean
      proofs: { meta: string; relMe: string }
    }

type StartError = 'invalid_url' | 'fetch_failed' | 'no_feed' | 'rate_limited'

export function claimError(code: string | undefined): StartError {
  if (code === 'invalid_url' || code === 'rate_limited') return code
  if (code === 'not_a_feed') return 'no_feed'
  return 'fetch_failed'
}

type Translate = ReturnType<typeof useTranslations<'claim'>>

/** What to change, in the member's words, for a check that found no proof. */
function reasonText(t: Translate, r: ClaimReason, site: string): string {
  switch (r.reason) {
    case 'no_proof':
      return t('reasons.no_proof', { page: r.page })
    case 'other_handle':
      return t('reasons.other_handle', { page: r.page, found: r.found, handle: r.handle })
    case 'link_marked':
      return t('reasons.link_marked', { page: r.page, target: r.target, rel: r.rel })
    case 'not_site_wide':
      return t('reasons.not_site_wide', { page: r.page, other: r.other, target: r.target })
    case 'no_not_found_page':
      return t('reasons.no_not_found_page', { page: r.page, target: r.target })
    case 'github_website':
      return t('reasons.github_website', { site })
    case 'github_link':
      return t('reasons.github_link', { page: r.page, site })
    case 'github_unavailable':
      return t('reasons.github_unavailable')
    case 'overruled':
      return t('reasons.overruled', { page: r.page, target: r.target })
    case 'home_refused':
      return t('reasons.home_refused', { page: r.page, status: r.status })
    case 'home_status':
      return t('reasons.home_status', { page: r.page, status: r.status })
    case 'home_unreachable':
      return t('reasons.home_unreachable', { page: r.page, why: r.why })
  }
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
  // Asked for long enough with no answer: the check may be waiting to retry, so the member may
  // ask for a fresh one rather than watch "Checking" for ever.
  const [stalled, setStalled] = useState(false)
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
      if (Date.now() - since > POLL_FOR_MS) {
        clearInterval(id)
        setStalled(true)
      } else load().catch(() => undefined)
    }, POLL_MS)
    return () => clearInterval(id)
  }, [pending, pollingSince, load])

  const verify = async () => {
    const { status, body } = await apiJson<Standing>(`/api/v1/claims/${siteId}/verify`, {
      method: 'POST',
    })
    if (status === 200) {
      setPollingSince(Date.now())
      setStalled(false)
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
          {t.rich('verifyIntro', {
            site: () => (
              <a href={standing.homeUrl} target="_blank" rel="noopener noreferrer">
                {standing.homeUrl}
              </a>
            ),
          })}
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
          <section className="flex flex-col gap-3" data-testid="claim-github">
            <h2 className="font-serif text-[22px] font-medium">{t('optionGitHub')}</h2>
            <p className="text-[14px] text-ink-2">
              {standing.github
                ? t('optionGitHubHint', { site: standing.homeUrl })
                : t.rich('optionGitHubUnlinked', {
                    link: (chunks) => <Link to="/settings">{chunks}</Link>,
                  })}
            </p>
          </section>
          <section className="flex flex-col gap-3">
            <h2 className="font-serif text-[22px] font-medium">{t('optionRelMe')}</h2>
            <p className="text-[14px] text-ink-2">{t('optionRelMeHint')}</p>
            <pre
              className="overflow-x-auto rounded-lg border border-line bg-surface px-4 py-3 text-[13px]"
              data-testid="rel-me-snippet"
            >
              {standing.proofs.relMe}
            </pre>
          </section>
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
          <div className="flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={() => void verify()}
              disabled={pending && !stalled}
              className="rounded-full bg-ink px-5 py-2.5 font-medium text-paper hover:brightness-125 disabled:opacity-60"
              data-testid="claim-verify"
            >
              {standing.status === 'failed' || stalled ? t('verifyAgain') : t('verify')}
            </button>
            {pending ? (
              <span className="text-[13px] text-muted" data-testid="claim-checking">
                {stalled ? t('stillChecking') : t('checking')}
              </span>
            ) : null}
            {standing.status === 'failed' && (standing.reason || standing.error) ? (
              <span className="text-[13px] text-danger" data-testid="claim-error">
                {t('failed')}{' '}
                {standing.reason
                  ? reasonText(t, standing.reason, standing.homeUrl)
                  : standing.error}
              </span>
            ) : null}
          </div>
        </>
      )}
    </main>
  )
}
