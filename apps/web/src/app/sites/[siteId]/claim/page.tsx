import { getOrCreateClaim, getProfile, getSitePage } from '@tela/db/queries'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { AppHeader } from '@/components/app-header'
import { AutoRefresh } from '@/components/auto-refresh'
import { requireUser } from '@/lib/auth'
import { getDb } from '@/lib/platform/db'
import { verifyClaimAction } from './actions'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ siteId: string }> }

export async function generateMetadata() {
  const t = await getTranslations('claim')
  return { title: t('verifyTitle') }
}

/** Step 2 of claiming: prove you control the site, then verify. */
export default async function SiteClaimPage({ params }: Props) {
  const { siteId: raw } = await params
  const siteId = Number(raw)
  if (!Number.isInteger(siteId) || siteId <= 0) notFound()
  const user = await requireUser(`/sites/${siteId}/claim`)
  const db = await getDb()
  const [page, profile, t] = await Promise.all([
    getSitePage(db, siteId, user.id),
    getProfile(db, user.id),
    getTranslations('claim'),
  ])
  if (!page || !profile) notFound()
  const claimedByOther = page.site.claimedBy !== null && page.site.claimedBy !== user.id
  // No token is minted for a site somebody else already proved control of.
  const claim = claimedByOther ? null : await getOrCreateClaim(db, siteId, user.id)
  const publicUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://tela.ainaive.com').replace(
    /\/+$/,
    '',
  )
  const profileUrl = `${publicUrl}/@${profile.handle}`
  const metaSnippet = `<meta name="tela-site-verification" content="${claim?.token ?? ''}">`
  const relMeSnippet = `<link rel="me" href="${profileUrl}">`

  return (
    <>
      <AppHeader active="discover" />
      <main
        className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-7 px-8 py-12 animate-fade"
        data-testid="claim-page"
        data-status={claim?.status ?? 'claimed'}
      >
        {claim?.status === 'pending' ? <AutoRefresh intervalMs={2500} maxMs={120_000} /> : null}
        <div>
          <h1 className="font-serif text-[34px] font-medium leading-tight tracking-tight">
            {t('verifyTitle')}
          </h1>
          <p className="mt-2 text-[15px] leading-relaxed text-ink-2">
            {t('verifyIntro', { site: page.site.title ?? page.site.homeUrl })}{' '}
            <a href={page.site.homeUrl} target="_blank" rel="noopener noreferrer">
              {page.site.homeUrl}
            </a>
          </p>
        </div>

        {claim === null ? (
          <p className="rounded-xl border border-line bg-white p-5 text-ink-2">
            {t('claimedByOther')}
          </p>
        ) : claim.status === 'verified' ? (
          <div
            className="rounded-xl border border-accent/40 bg-white p-5"
            data-testid="claim-verified"
          >
            <div className="font-medium text-accent">✓ {t('verified')}</div>
            <p className="mt-1 text-[14px] text-ink-2">{t('verifiedHint')}</p>
            <Link
              href={`/s/${siteId}`}
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
                className="overflow-x-auto rounded-lg border border-line bg-white px-4 py-3 text-[13px]"
                data-testid="meta-snippet"
              >
                {metaSnippet}
              </pre>
            </section>
            <section className="flex flex-col gap-3">
              <h2 className="font-serif text-[22px] font-medium">{t('optionRelMe')}</h2>
              <p className="text-[14px] text-ink-2">{t('optionRelMeHint')}</p>
              <pre className="overflow-x-auto rounded-lg border border-line bg-white px-4 py-3 text-[13px]">
                {relMeSnippet}
              </pre>
            </section>
            <form action={verifyClaimAction} className="flex flex-wrap items-center gap-4">
              <input type="hidden" name="claimId" value={claim.id} />
              <button
                type="submit"
                className="rounded-full bg-ink px-5 py-2.5 font-medium text-paper hover:brightness-125"
                data-testid="claim-verify"
              >
                {claim.status === 'failed' ? t('verifyAgain') : t('verify')}
              </button>
              {claim.status === 'pending' ? (
                <span className="text-[13px] text-muted">{t('checking')}</span>
              ) : null}
              {claim.status === 'failed' && claim.error ? (
                <span className="text-[13px] text-[oklch(0.5_0.15_25)]" data-testid="claim-error">
                  {t('failed')} {claim.error}
                </span>
              ) : null}
            </form>
          </>
        )}
      </main>
    </>
  )
}
