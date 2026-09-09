import { describe, expect, test } from 'bun:test'
import { type PaneState, reconcile, type ServerState } from './reader-navigation'

const empty: ServerState = { kind: 'empty' }
const paneEmpty: PaneState = { kind: 'empty' }

describe('reconcile', () => {
  test('a URL with no article closes whatever is open', () => {
    expect(
      reconcile({
        urlArticleId: null,
        server: { kind: 'ready', articleId: 7 },
        serverChanged: true,
        pane: { kind: 'ready', articleId: 7 },
      }),
    ).toEqual({ do: 'clear' })
  })

  test('and does nothing when nothing is open', () => {
    expect(
      reconcile({ urlArticleId: null, server: empty, serverChanged: true, pane: paneEmpty }),
    ).toEqual({ do: 'nothing' })
  })

  test('a fresh server render of the article on the URL is taken for free', () => {
    expect(
      reconcile({
        urlArticleId: 7,
        server: { kind: 'ready', articleId: 7 },
        serverChanged: true,
        pane: paneEmpty,
      }),
    ).toEqual({ do: 'adopt' })
  })

  test('including its answer that the article is gone', () => {
    expect(
      reconcile({
        urlArticleId: 7,
        server: { kind: 'gone', articleId: 7 },
        serverChanged: true,
        pane: paneEmpty,
      }),
    ).toEqual({ do: 'adopt' })
  })

  test('the URL wins when the server disagrees with it', () => {
    // Back onto an entry written by pushState: Next replays the payload from before the article
    // was opened, so it says "empty" while the URL names article 7. Adopting that emptied the pane
    // and left the reader looking at nothing.
    expect(
      reconcile({ urlArticleId: 7, server: empty, serverChanged: true, pane: paneEmpty }),
    ).toEqual({ do: 'fetch', articleId: 7 })
  })

  test('and when the server is fresh but names a different article', () => {
    expect(
      reconcile({
        urlArticleId: 7,
        server: { kind: 'ready', articleId: 9 },
        serverChanged: true,
        pane: paneEmpty,
      }),
    ).toEqual({ do: 'fetch', articleId: 7 })
  })

  test('a stale server state never displaces a client-side open', () => {
    // The same server state arriving again — a re-render for some other reason — must not undo
    // the article the reader just clicked.
    expect(
      reconcile({
        urlArticleId: 7,
        server: { kind: 'ready', articleId: 7 },
        serverChanged: false,
        pane: { kind: 'ready', articleId: 7 },
      }),
    ).toEqual({ do: 'nothing' })
  })

  test('an article already showing or already loading is left alone', () => {
    for (const pane of [
      { kind: 'ready', articleId: 7 },
      { kind: 'loading', articleId: 7 },
      { kind: 'gone', articleId: 7 },
    ] satisfies PaneState[]) {
      expect(reconcile({ urlArticleId: 7, server: empty, serverChanged: false, pane })).toEqual({
        do: 'nothing',
      })
    }
  })

  test('moving to another article fetches it, whatever the pane was doing', () => {
    for (const pane of [
      { kind: 'ready', articleId: 7 },
      { kind: 'loading', articleId: 7 },
      { kind: 'gone', articleId: 7 },
    ] satisfies PaneState[]) {
      expect(reconcile({ urlArticleId: 8, server: empty, serverChanged: false, pane })).toEqual({
        do: 'fetch',
        articleId: 8,
      })
    }
  })
})
