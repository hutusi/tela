/**
 * Which article the reader pane should be showing.
 *
 * Two things claim to know: the URL, which `ReadingShell` drives with `pushState`, and the state
 * the server sent with its last render, which Next drives from its own router cache. They can
 * disagree — press Back onto an entry written by `pushState` and Next replays the payload it
 * rendered *before* the article was opened, so the URL names an article and the server says there
 * is none.
 *
 * ADR 0017 already settled who wins: **the URL is authoritative**. This is that rule, in one place
 * and out of React, because every version of it spread across effects has been wrong.
 */

export type ServerState =
  | { kind: 'empty' }
  | { kind: 'ready'; articleId: number }
  | { kind: 'gone'; articleId: number }

export type PaneState =
  | { kind: 'empty' }
  | { kind: 'loading'; articleId: number }
  | { kind: 'ready'; articleId: number }
  | { kind: 'gone'; articleId: number }

export type PaneAction =
  | { do: 'nothing' }
  | { do: 'clear' }
  /** The server already rendered what the URL asks for; take it, and spend no request. */
  | { do: 'adopt' }
  | { do: 'fetch'; articleId: number }

export type Reconcile = {
  /** The article the URL names, which is the one that must end up on screen. */
  urlArticleId: number | null
  server: ServerState
  /** Whether `server` is new since the last time this ran. */
  serverChanged: boolean
  pane: PaneState
}

/** The article a server state describes, or null when it describes none. */
export function serverArticleId(server: ServerState): number | null {
  return server.kind === 'empty' ? null : server.articleId
}

/** The article the pane is showing or fetching, or null. */
export function paneArticleId(pane: PaneState): number | null {
  return pane.kind === 'empty' ? null : pane.articleId
}

export function reconcile({ urlArticleId, server, serverChanged, pane }: Reconcile): PaneAction {
  // No article in the URL: nothing may be open, whatever the server or an in-flight fetch thinks.
  if (urlArticleId === null) return pane.kind === 'empty' ? { do: 'nothing' } : { do: 'clear' }

  // The server just rendered this very article — including the "it is gone" answer for a stale
  // link. Free, so it beats a fetch. Only when it is *new*: re-adopting an old server state would
  // undo a client-side open.
  if (serverChanged && serverArticleId(server) === urlArticleId) return { do: 'adopt' }

  // Already showing it, or already on the way to it.
  if (paneArticleId(pane) === urlArticleId && pane.kind !== 'empty') return { do: 'nothing' }

  // The URL wants an article nobody has. This is the case that used to leave the pane blank after
  // Back, because a disagreeing server state was adopted instead.
  return { do: 'fetch', articleId: urlArticleId }
}
