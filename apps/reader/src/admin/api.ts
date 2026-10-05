/**
 * The admin console's calls to tela-api (ADR 0039). Unlike the rest of the reader, the console reads
 * over the network: what it shows (every member's account, every feed) is on no device. Each call
 * goes through `api`, so it names the member and a 401 or a changed account reaches the session.
 */
import type {
  AdminActRequest,
  AdminActResponse,
  AdminFilter,
  AdminList,
  AdminUndoResponse,
  LedgerArea,
} from '@tela/shared/admin'
import { apiJson } from '../store/api'

/** Thrown for a 403: the member is no admin (any more), and the console is a page that is not. */
export class NotAdmin extends Error {
  override name = 'NotAdmin'
}

/** A read: its body, or null when it failed (offline, a 5xx, a 404). */
export async function adminGet<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  const { status, body } = await apiJson<T>(`/api/v1/admin/${path}`, signal ? { signal } : {})
  if (status === 403) throw new NotAdmin()
  return status === 200 ? body : null
}

/** One ledger's rows under a filter and a search. */
export function adminList<R, A extends LedgerArea>(
  area: A,
  filter: AdminFilter<A>,
  q: string,
  signal?: AbortSignal,
): Promise<AdminList<R, A> | null> {
  const params = new URLSearchParams({ f: filter })
  if (q.trim()) params.set('q', q.trim())
  return adminGet<AdminList<R, A>>(`${area}?${params}`, signal)
}

/**
 * One ledger's rows under a filter and a search, the search posted rather than put in the URL.
 * People and Invitations are searched by email address, and a request's URL reaches the Workers'
 * logs, which the console keeps addresses out of as it keeps them out of `admin_actions`
 * (ADR 0039). With no search it is the plain list.
 */
export async function adminSearch<R, A extends LedgerArea>(
  area: A,
  filter: AdminFilter<A>,
  q: string,
  signal?: AbortSignal,
): Promise<AdminList<R, A> | null> {
  if (!q.trim()) return adminList<R, A>(area, filter, '', signal)
  const { status, body } = await apiJson<AdminList<R, A>>(`/api/v1/admin/${area}`, {
    body: { f: filter, q: q.trim() },
    ...(signal ? { signal } : {}),
  })
  if (status === 403) throw new NotAdmin()
  return status === 200 ? body : null
}

export async function adminAct(request: AdminActRequest): Promise<AdminActResponse | null> {
  const { status, body } = await apiJson<AdminActResponse>('/api/v1/admin/act', { body: request })
  if (status === 403) throw new NotAdmin()
  return status === 200 ? body : null
}

export async function adminUndo(group: string): Promise<AdminUndoResponse | null> {
  const { status, body } = await apiJson<AdminUndoResponse>('/api/v1/admin/undo', {
    body: { group },
  })
  if (status === 403) throw new NotAdmin()
  return status === 200 || status === 409 || status === 404 ? body : null
}
