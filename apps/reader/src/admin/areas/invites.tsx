/**
 * The Invitations ledger (ADR 0034, 0039): the codes, the operator's and members', and the holds
 * waiting on them. An invitation here is a code, never a mail: there is no "opened", and
 * "waiting" is an address that asked to join and has not yet signed in. A hold shows its address,
 * which the console alone may see; the audit log names it by its number.
 */
import { groupInviteCode, isOperatorCode } from '@tela/shared'
import type {
  AdminCodeRow,
  AdminFilter,
  AdminHistoryEntry,
  AdminHoldRow,
  AdminInviteDetail,
  AdminInviteRow,
} from '@tela/shared/admin'
import { useMemo } from 'react'
import { useLocale, useTranslations } from 'use-intl'
import { Swatch } from '../../components/swatch'
import { personColor, relativeTime } from '../../lib/format'
import { adminGet, adminListSearchedHere } from '../api'
import type { AnyAreaSpec, AreaSpec, RecordProps, Status } from '../area'
import { History, KeyValues, Note, Section } from '../components/record'
import { fullDate, type MembersT, PersonLink } from './people'

/** Searched in the browser: a hold is found by its address (`adminListSearchedHere`). */
const loadInvites = (f: AdminFilter<'invites'>, q: string, signal?: AbortSignal) =>
  adminListSearchedHere<AdminInviteRow, 'invites'>(
    'invites',
    f,
    q,
    (row) =>
      row.type === 'code'
        ? `${row.code} ${groupInviteCode(row.code)} ${row.createdBy?.handle ?? ''}`
        : `${row.email} ${row.code ?? ''} ${row.codeOwner?.handle ?? ''}`,
    signal,
  )

const loadInvite = (id: string, signal?: AbortSignal) =>
  adminGet<AdminInviteDetail>(`invites/${encodeURIComponent(id)}`, signal)

/** A row's name: a code as it is shown (a member's in groups), a hold by its address. */
const titleOf = (row: AdminInviteRow) =>
  row.type === 'code' ? groupInviteCode(row.code) : row.email

function subOf(t: MembersT, row: AdminInviteRow): string {
  if (row.type === 'hold') {
    return row.code === null
      ? t('invites.sub.holdOperator')
      : t('invites.sub.hold', { code: groupInviteCode(row.code) })
  }
  if (row.createdBy) return t('invites.sub.member', { handle: row.createdBy.handle })
  return isOperatorCode(row.code) ? t('invites.sub.operator') : t('invites.sub.someone')
}

/**
 * Who made a code, or whose code a hold waits on. With no card to name, a code's shape says whose
 * it is (ADR 0034), and a hold with no code is the operator's invitation to one address.
 */
function makerOf(t: MembersT, row: AdminInviteRow): string {
  const maker = row.type === 'code' ? row.createdBy : row.codeOwner
  if (maker) return `@${maker.handle}`
  const code = row.code
  return code === null || isOperatorCode(code) ? t('invites.operator') : t('invites.sub.someone')
}

function statusOf(t: MembersT, row: AdminInviteRow, locale: string, now = Date.now()): Status {
  if (row.type === 'hold') {
    return row.expiresAt > now
      ? {
          tone: 'info',
          label: t('invites.status.waiting', { when: relativeTime(row.expiresAt, locale, now) }),
        }
      : { tone: 'neutral', label: t('invites.status.lapsed') }
  }
  if (row.revokedAt !== null) return { tone: 'bad', label: t('invites.status.revoked') }
  if (row.used >= row.maxUses) return { tone: 'warn', label: t('invites.status.full') }
  return { tone: 'ok', label: t('invites.status.active', { used: row.used, max: row.maxUses }) }
}

function describeWith(t: MembersT) {
  return (entry: AdminHistoryEntry): string | undefined => {
    switch (entry.action) {
      case 'code.create':
        return t('invites.history.created', {
          n: (entry.to as { maxUses?: number } | undefined)?.maxUses ?? 1,
        })
      case 'code.addUses':
        return t('invites.history.addUses', {
          from: (entry.from as { maxUses?: number } | undefined)?.maxUses ?? 0,
          to: (entry.to as { maxUses?: number } | undefined)?.maxUses ?? 0,
        })
      default:
        return undefined
    }
  }
}

function CodeRecord({
  code,
  history,
  open,
}: {
  code: AdminCodeRow
  history: readonly AdminHistoryEntry[] | null
  open: RecordProps<AdminInviteRow, AdminInviteDetail>['open']
}) {
  const t = useTranslations('admin.members')
  const locale = useLocale()
  const text = <span className="font-mono">{groupInviteCode(code.code)}</span>
  const maker = code.createdBy ? (
    <PersonLink person={code.createdBy} open={open} />
  ) : (
    makerOf(t, code)
  )
  return (
    <div className="flex flex-col gap-5">
      <KeyValues
        rows={[
          [t('invites.kv.code'), text],
          [t('invites.kv.createdBy'), maker],
          [t('invites.kv.created'), fullDate(code.createdAt, locale)],
          [t('invites.kv.uses'), t('invites.usesOf', { used: code.used, max: code.maxUses })],
          [t('invites.kv.waiting'), t('invites.waitingCount', { n: code.holds })],
          [
            t('invites.kv.revoked'),
            code.revokedAt === null ? null : fullDate(code.revokedAt, locale),
          ],
        ]}
      />
      <Section label={t('invites.joined')}>
        {code.joined.length === 0 ? (
          <p className="m-0 text-[13.5px] text-muted">{t('invites.nobody')}</p>
        ) : (
          <p className="m-0 flex flex-wrap gap-x-2 gap-y-1 text-[13.5px]">
            {code.joined.map((who) => (
              <PersonLink key={who.id} person={who} open={open} />
            ))}
            {code.joined.length === 10 && code.used > 10 ? (
              <span className="text-muted">{t('invites.latestTen')}</span>
            ) : null}
          </p>
        )}
      </Section>
      {code.revokedAt === null ? <Note>{t('invites.revokeNote')}</Note> : null}
      {code.createdBy ? <Note>{t('invites.memberNote')}</Note> : null}
      {history ? <History entries={history} describe={describeWith(t)} /> : null}
    </div>
  )
}

function HoldRecord({
  hold,
  history,
  open,
}: {
  hold: AdminHoldRow
  history: readonly AdminHistoryEntry[] | null
  open: RecordProps<AdminInviteRow, AdminInviteDetail>['open']
}) {
  const t = useTranslations('admin.members')
  const locale = useLocale()
  const code = hold.code
  const withCode =
    code === null ? (
      t('invites.sub.holdOperator')
    ) : (
      <button
        type="button"
        onClick={() => open('invites', `code:${code}`)}
        className="cursor-pointer border-0 bg-transparent p-0 font-mono text-ink underline decoration-thumb underline-offset-2 hover:decoration-ink"
      >
        {groupInviteCode(code)}
      </button>
    )
  const owner = hold.codeOwner ? (
    <PersonLink person={hold.codeOwner} open={open} />
  ) : (
    makerOf(t, hold)
  )
  return (
    <div className="flex flex-col gap-5">
      <KeyValues
        rows={[
          [t('invites.kv.email'), hold.email],
          [t('invites.kv.with'), withCode],
          [t('invites.kv.invitedBy'), owner],
          [t('invites.kv.asked'), relativeTime(hold.createdAt, locale)],
          [t('invites.kv.expires'), relativeTime(hold.expiresAt, locale)],
        ]}
      />
      <Note>{t('invites.holdNote')}</Note>
      {history ? <History entries={history} /> : null}
    </div>
  )
}

function InviteRecord({ row, detail, open }: RecordProps<AdminInviteRow, AdminInviteDetail>) {
  const invite = detail?.invite ?? row
  const history = detail?.history ?? null
  return invite.type === 'code' ? (
    <CodeRecord code={invite} history={history} open={open} />
  ) : (
    <HoldRecord hold={invite} history={history} open={open} />
  )
}

export function useInvitesArea(): AnyAreaSpec {
  const t = useTranslations('admin.members')
  const locale = useLocale()
  // Built once per language: the ledger may key its loading on the spec's functions.
  return useMemo(() => {
    const spec: AreaSpec<'invites', AdminInviteRow, AdminInviteDetail> = {
      area: 'invites',
      filterLabel: (filter) => t(`invites.filters.${filter}`),
      searchHint: t('invites.search'),
      load: loadInvites,
      loadDetail: loadInvite,
      name: {
        label: t('invites.name'),
        title: titleOf,
        sub: (row) => subOf(t, row),
        tile: (row) => {
          const name = row.type === 'code' ? row.code : row.email
          return <Swatch id={0} title={name} color={personColor(name)} size={28} />
        },
      },
      columns: [
        { label: t('invites.columns.createdBy'), text: (row) => makerOf(t, row) },
        {
          label: t('invites.columns.uses'),
          text: (row) =>
            row.type === 'code' ? t('invites.uses', { used: row.used, max: row.maxUses }) : '—',
          number: (row) => (row.type === 'code' ? row.used : null),
        },
        {
          label: t('invites.columns.when'),
          text: (row) =>
            row.type === 'code'
              ? t('invites.created', { when: relativeTime(row.createdAt, locale) })
              : t('invites.expires', { when: relativeTime(row.expiresAt, locale) }),
          number: (row) => (row.type === 'code' ? row.createdAt : row.expiresAt),
        },
      ],
      status: (row) => statusOf(t, row, locale),
      Record: InviteRecord,
      bulk: ['code.revoke', 'hold.cancel'],
      create: ['code.create', 'invite.address'],
    }
    return spec
  }, [t, locale])
}
