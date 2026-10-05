/**
 * The People ledger (ADR 0039): every member's public card and account basics, and signing one
 * out everywhere. The record says, before anything else, what it will never show: what a member
 * reads, subscribes to and likes. tela-api never sends it, so there is nothing here to hide.
 */
import { groupInviteCode, INVITE_ALLOWANCE } from '@tela/shared'
import type {
  AdminFilter,
  AdminHistoryEntry,
  AdminPerson,
  AdminPersonDetail,
  AdminPersonRow,
  LedgerArea,
} from '@tela/shared/admin'
import { useMemo } from 'react'
import { useLocale, useTranslations } from 'use-intl'
import { PersonAvatar } from '../../components/person-avatar'
import { displayHost, relativeTime, shortDate } from '../../lib/format'
import { adminGet, adminListSearchedHere } from '../api'
import type { AnyAreaSpec, AreaSpec, RecordProps } from '../area'
import { History, KeyValues, Note, Section } from '../components/record'

/** A day as a record names it, year and all: "Sep 3, 2026", "2026年9月3日". */
export function fullDate(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(at))
}

/** A member named in a record, which opens their own record. */
export function PersonLink({
  person,
  open,
}: {
  person: AdminPerson
  open: (area: LedgerArea, id: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => open('people', person.id)}
      className="cursor-pointer border-0 bg-transparent p-0 text-left text-ink underline decoration-thumb underline-offset-2 hover:decoration-ink"
    >
      @{person.handle}
    </button>
  )
}

/** Searched in the browser: a search is often an email address (`adminListSearchedHere`). */
const loadPeople = (f: AdminFilter<'people'>, q: string, signal?: AbortSignal) =>
  adminListSearchedHere<AdminPersonRow, 'people'>(
    'people',
    f,
    q,
    (row) => `${row.handle} ${row.name ?? ''} ${row.email}`,
    signal,
  )

const loadPerson = (id: string, signal?: AbortSignal) =>
  adminGet<AdminPersonDetail>(`people/${encodeURIComponent(id)}`, signal)

/** The console's translator for this group. */
export type MembersT = ReturnType<typeof useTranslations>

/** The ways in a member has, in words: the mailed code always, then what `account` rows add. */
function waysIn(t: MembersT, person: AdminPersonRow): string {
  return [
    'code',
    ...['credential', 'google', 'github'].filter((way) => person.signIn.includes(way)),
  ]
    .map((way) => t(`signIn.${way}`))
    .join(t('people.separator'))
}

function PersonRecord({ row, detail, open }: RecordProps<AdminPersonRow, AdminPersonDetail>) {
  const t = useTranslations('admin.members')
  const locale = useLocale()
  const person = detail?.person ?? row
  const date = fullDate(person.joinedAt, locale)
  const by = person.invitedBy
  const joined =
    by === null
      ? t('people.joinedBy.none', { date })
      : by.kind === 'operator'
        ? t('people.joinedBy.operator', { date })
        : by.kind === 'code'
          ? t('people.joinedBy.code', { date, code: groupInviteCode(by.code) })
          : by.by
            ? t.rich('people.joinedBy.member', {
                date,
                handle: by.by.handle,
                code: groupInviteCode(by.code),
                who: () => (by.by ? <PersonLink person={by.by} open={open} /> : null),
              })
            : t('people.joinedBy.someone', { date, code: groupInviteCode(by.code) })
  const sessions = t('people.sessions', { n: person.sessions })
  const describe = (entry: AdminHistoryEntry): string | undefined => {
    switch (entry.action) {
      case 'member.signOut':
        return t('people.history.signOut', {
          n: (entry.from as { sessions?: number } | undefined)?.sessions ?? 0,
        })
      case 'invite.address':
        return (entry.to as { created?: boolean } | undefined)?.created
          ? t('people.history.invited')
          : t('people.history.mailed')
      case 'admin.grant':
        return t('people.history.grant')
      case 'admin.ungrant':
        return t('people.history.ungrant')
      default:
        return undefined
    }
  }
  return (
    <div className="flex flex-col gap-5">
      <Note>{t('people.privacy')}</Note>
      <KeyValues
        rows={[
          [t('people.kv.email'), person.email],
          [t('people.kv.signIn'), waysIn(t, person)],
          [t('people.kv.joined'), joined],
          [
            t('people.kv.invites'),
            t('people.invitesUsed', { used: person.invitesUsed, allowance: INVITE_ALLOWANCE }),
          ],
          [
            t('people.kv.sessions'),
            person.lastSeenAt === null
              ? sessions
              : t('people.lastSeen', { sessions, when: relativeTime(person.lastSeenAt, locale) }),
          ],
          [t('people.kv.bio'), detail?.bio ?? null],
        ]}
      />
      {detail && detail.blogs.length > 0 ? (
        <Section label={t('people.blogs')}>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {detail.blogs.map((blog) => (
              <li key={blog.siteId} className="flex flex-col text-[13.5px]">
                <button
                  type="button"
                  onClick={() => open('sites', String(blog.siteId))}
                  className="cursor-pointer self-start border-0 bg-transparent p-0 text-left font-medium text-ink underline decoration-thumb underline-offset-2 hover:decoration-ink"
                >
                  {blog.title || displayHost(blog.homeUrl)}
                </button>
                <span className="text-[12.5px] text-muted">
                  {displayHost(blog.homeUrl)} ·{' '}
                  {t('people.blogLine', {
                    listing: t(`listing.${blog.listing}`),
                    readers: blog.readerCount,
                  })}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {detail && detail.codes.length > 0 ? (
        <Section label={t('people.codes')}>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {detail.codes.map((code) => (
              <li key={code.code} className="flex flex-wrap items-baseline gap-x-2 text-[13.5px]">
                <button
                  type="button"
                  onClick={() => open('invites', code.id)}
                  className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[12.5px] text-ink underline decoration-thumb underline-offset-2 hover:decoration-ink"
                >
                  {groupInviteCode(code.code)}
                </button>
                <span className="text-muted">
                  {code.revokedAt !== null
                    ? t('invites.status.revoked')
                    : t('invites.usesOf', { used: code.used, max: code.maxUses })}
                </span>
                {code.joined.length > 0 ? (
                  <span className="flex flex-wrap gap-x-1.5 text-muted">
                    {t('people.joinedWith')}
                    {code.joined.map((who) => (
                      <PersonLink key={who.id} person={who} open={open} />
                    ))}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {detail ? <History entries={detail.history} describe={describe} /> : null}
    </div>
  )
}

export function usePeopleArea(): AnyAreaSpec {
  const t = useTranslations('admin.members')
  const locale = useLocale()
  // Built once per language: the ledger may key its loading on the spec's functions.
  return useMemo(() => {
    const spec: AreaSpec<'people', AdminPersonRow, AdminPersonDetail> = {
      area: 'people',
      filterLabel: (filter) => t(`people.filters.${filter}`),
      searchHint: t('people.search'),
      load: loadPeople,
      loadDetail: loadPerson,
      rowOf: (detail) => detail.person,
      name: {
        label: t('people.name'),
        title: (row) => row.name || `@${row.handle}`,
        sub: (row) => (row.name ? `@${row.handle} · ${row.email}` : row.email),
        tile: (row) => (
          <PersonAvatar handle={row.handle} displayName={row.name} avatar={row.avatar} size={28} />
        ),
      },
      columns: [
        {
          label: t('people.columns.role'),
          text: (row) => t(row.isAdmin ? 'people.role.admin' : 'people.role.member'),
        },
        { label: t('people.columns.signIn'), text: (row) => waysIn(t, row) },
        {
          label: t('people.columns.joined'),
          text: (row) => shortDate(row.joinedAt, locale),
          number: (row) => row.joinedAt,
        },
      ],
      status: (row) =>
        row.isAdmin
          ? { tone: 'info', label: t('people.role.admin') }
          : { tone: 'neutral', label: t('people.role.member') },
      Record: PersonRecord,
      bulk: [],
    }
    return spec
  }, [t, locale])
}
