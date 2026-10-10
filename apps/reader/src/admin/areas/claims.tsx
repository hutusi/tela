/**
 * The Claims ledger (ADR 0039): the claims the check could not settle, the ones it is checking,
 * and the verified ones an operator may remove. A record shows what the check saw and links to the
 * blog and the people on both sides of a dispute.
 */
import { describeClaimError } from '@tela/shared'
import type { AdminClaimDetail, AdminClaimRow, AdminFilter } from '@tela/shared/admin'
import { useMemo } from 'react'
import { useLocale, useTranslations } from 'use-intl'
import { displayHost, relativeTime } from '../../lib/format'
import { adminGet, adminList } from '../api'
import type { AnyAreaSpec, AreaSpec, RecordProps } from '../area'
import { Evidence, History, KeyValues, Note, useWhen } from '../components/record'
import {
  BlogTile,
  blogName,
  claimStatus,
  count,
  handleOf,
  personName,
  RecordLink,
  type Translate,
  useDescribe,
} from './sites'

const loadClaims = (filter: AdminFilter<'claims'>, q: string, signal?: AbortSignal) =>
  adminList<AdminClaimRow, 'claims'>('claims', filter, q, signal)

const loadClaim = (id: string, signal?: AbortSignal) =>
  adminGet<AdminClaimDetail>(`claims/${encodeURIComponent(id)}`, signal)

function claimsSpec(
  t: Translate,
  locale: string,
): AreaSpec<'claims', AdminClaimRow, AdminClaimDetail> {
  return {
    area: 'claims',
    filterLabel: (filter) => t(`filters.claims.${filter}`),
    searchHint: t('search.claims'),
    load: loadClaims,
    loadDetail: loadClaim,
    rowOf: (detail) => detail.claim,
    name: {
      label: t('names.blog'),
      title: (row) => displayHost(row.homeUrl),
      sub: (row) =>
        [row.siteTitle, row.claimant?.name ?? (row.claimant ? handleOf(t, row.claimant) : null)]
          .filter(Boolean)
          .join(' · '),
      tile: (row) => (
        <BlogTile
          siteId={row.siteId}
          title={row.siteTitle}
          homeUrl={row.homeUrl}
          faviconKey={row.faviconKey}
        />
      ),
    },
    columns: [
      { label: t('columns.claimant'), text: (row) => handleOf(t, row.claimant) },
      { label: t('columns.method'), text: (row) => t(`methods.${row.method}`) },
      {
        label: t('columns.opened'),
        text: (row) => relativeTime(row.createdAt, locale),
        number: (row) => row.createdAt,
      },
    ],
    status: (row) => claimStatus(t, row),
    Record: ClaimRecord,
    bulk: ['claim.recheck', 'claim.reject'],
    queue: true,
  }
}

export function useClaimsArea(): AnyAreaSpec {
  const t = useTranslations('admin.library')
  const locale = useLocale()
  return useMemo(() => claimsSpec(t, locale), [t, locale])
}

function ClaimRecord({ row, detail, open }: RecordProps<AdminClaimRow, AdminClaimDetail>) {
  const t = useTranslations('admin.library')
  const locale = useLocale()
  const when = useWhen()
  const describe = useDescribe()
  const claim = detail?.claim ?? row
  const person = (who: NonNullable<AdminClaimRow['claimant']>) => (
    <RecordLink onClick={() => open('people', who.id)}>{personName(t, who)}</RecordLink>
  )
  const blog = (
    <RecordLink onClick={() => open('sites', String(claim.siteId))}>
      {t('kv.blogValue', { title: blogName(claim.siteTitle, claim.homeUrl), n: claim.readerCount })}
    </RecordLink>
  )
  return (
    <div className="flex flex-col gap-5">
      <KeyValues
        rows={[
          [t('kv.blog'), blog],
          [t('kv.claimant'), claim.claimant ? person(claim.claimant) : t('none')],
          [t('kv.currentOwner'), claim.owner ? person(claim.owner) : null],
          [t('kv.method'), t(`methods.${claim.method}`)],
          [t('kv.attempts'), claim.attempts === null ? null : count(claim.attempts, locale)],
          [t('kv.nextTry'), claim.nextTry === null ? null : when(claim.nextTry)],
          [t('kv.opened'), when(claim.createdAt)],
          [t('kv.lastChecked'), claim.lastCheckedAt === null ? null : when(claim.lastCheckedAt)],
          [t('kv.verified'), claim.verifiedAt === null ? null : when(claim.verifiedAt)],
          [t('kv.reviewed'), claim.reviewedAt === null ? null : when(claim.reviewedAt)],
          [t('kv.token'), detail ? t('kv.tokenValue', { head: detail.tokenHead }) : null],
        ]}
      />
      {claim.error ? (
        <Evidence
          label={
            claim.lastCheckedAt === null
              ? t('sections.lastError')
              : t('sections.lastCheck', { when: when(claim.lastCheckedAt) })
          }
          text={describeClaimError(claim.error)}
        />
      ) : null}
      {claim.owner && claim.status !== 'verified' ? <Note>{t('notes.disputed')}</Note> : null}
      {claim.vouched ? <Note>{t('notes.vouched')}</Note> : null}
      {detail ? <History entries={detail.history} describe={describe} /> : null}
    </div>
  )
}
