import { describe, expect, test } from 'bun:test'
import { createGitHub, GitHubUnavailable } from '../src/github'
import { namesSite, profileHosts, readProofs, VERIFICATION_META } from '../src/pipeline'

const HOSTS = profileHosts('https://telaread.com')
const PAGE = 'https://blog.example/'
const read = (html: string) => readProofs(html, PAGE, 'tok', HOSTS)

describe('readProofs', () => {
  test('finds the token only in its own meta tag, exactly', () => {
    expect(read(`<meta name="${VERIFICATION_META.toUpperCase()}" content=" tok ">`).meta).toBe(true)
    expect(read(`<meta name="${VERIFICATION_META}" content="TOK">`).meta).toBe(false)
    expect(read(`<meta property="${VERIFICATION_META}" content="tok">`).meta).toBe(false)
  })

  test('reads a link to a Tela profile however a browser would reach it', () => {
    const hrefs = [
      'https://telaread.com/@hutusi',
      'http://telaread.com/@hutusi/',
      'https://www.telaread.com/@Hutusi',
      '//telaread.com/@hutusi',
      'https://tela.ainaive.com/@hutusi',
      'https://telaread.com/%40hutusi?ref=footer#top',
    ]
    for (const href of hrefs) {
      expect(read(`<a href="${href}">Tela</a>`).profiles).toEqual([
        { name: 'hutusi', me: false, marked: null },
      ])
    }
  })

  test('is not fooled by what only looks like a profile', () => {
    const hrefs = [
      '/@hutusi',
      'https://telaread.com/@hutusi/posts',
      'https://telaread.com/',
      'https://telaread.com.evil.example/@hutusi',
      'https://telaread.com/%E0%A4%A',
      'javascript:alert(1)',
    ]
    for (const href of hrefs) expect(read(`<a href="${href}">x</a>`).profiles).toEqual([])
  })

  test('tells "this is me" from a link marked as someone else\'s', () => {
    const page = read(`
      <link rel="me" href="https://telaread.com/@ann">
      <a rel="noopener ME" href="https://telaread.com/@bob">b</a>
      <a rel="external nofollow ugc" href="https://telaread.com/@cat">c</a>
      <a rel="sponsored" href="https://github.com/Sponsor">s</a>`)
    expect(page.profiles).toEqual([
      { name: 'ann', me: true, marked: null },
      { name: 'bob', me: true, marked: null },
      { name: 'cat', me: false, marked: 'nofollow ugc' },
    ])
    expect(page.github).toEqual([{ name: 'sponsor', me: false, marked: 'sponsored' }])
  })

  test('reads a GitHub profile, and nothing else on GitHub, as a GitHub link', () => {
    const page = read(`
      <a href="https://github.com/hutusi">profile</a>
      <a href="https://www.github.com/Hutusi/?tab=repositories">tab</a>
      <a href="https://github.com/hutusi/amytis">a repository</a>
      <a href="https://gist.github.com/hutusi">a gist</a>`)
    expect(page.github.map((l) => l.name)).toEqual(['hutusi', 'hutusi'])
  })
})

describe('namesSite', () => {
  test('matches a GitHub website to the blog by host, scheme or www or path aside', () => {
    expect(namesSite('hutusi.com', 'https://hutusi.com')).toBe(true)
    expect(namesSite('https://www.hutusi.com/about', 'https://hutusi.com')).toBe(true)
    expect(namesSite('http://Hutusi.com', 'https://www.hutusi.com')).toBe(true)
  })

  test('refuses another host, a sub-domain, and nothing at all', () => {
    expect(namesSite('', 'https://hutusi.com')).toBe(false)
    expect(namesSite('blog.hutusi.com', 'https://hutusi.com')).toBe(false)
    expect(namesSite('https://hutusi.com.evil.example', 'https://hutusi.com')).toBe(false)
    expect(namesSite('not a url at all', 'https://hutusi.com')).toBe(false)
  })
})

describe('createGitHub', () => {
  const answering = (status: number, body: unknown, seen: Request[] = []) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Request(String(input), init))
      return new Response(JSON.stringify(body), { status })
    }) as typeof fetch

  test('asks for the account by id, with the token when there is one', async () => {
    const seen: Request[] = []
    const github = createGitHub({
      userAgent: 'Tela/test',
      token: 'secret',
      apiUrl: 'https://api.github.test/',
      fetch: answering(200, { login: 'hutusi', blog: ' https://hutusi.com ' }, seen),
    })
    expect(await github.user('487036')).toEqual({ login: 'hutusi', website: 'https://hutusi.com' })
    expect(seen[0]?.url).toBe('https://api.github.test/user/487036')
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer secret')
    expect(seen[0]?.headers.get('user-agent')).toBe('Tela/test')
  })

  test('sends no token when it has none, and reads a missing website as empty', async () => {
    const seen: Request[] = []
    const github = createGitHub({
      userAgent: 'Tela/test',
      fetch: answering(200, { login: 'hutusi', blog: null }, seen),
    })
    expect(await github.user('1')).toEqual({ login: 'hutusi', website: '' })
    expect(seen[0]?.headers.get('authorization')).toBe(null)
  })

  test('a missing account is null; a refusal or a fault is GitHub being unavailable', async () => {
    expect(await createGitHub({ userAgent: 'x', fetch: answering(404, {}) }).user('1')).toBe(null)
    await expect(
      createGitHub({ userAgent: 'x', fetch: answering(403, {}) }).user('1'),
    ).rejects.toBeInstanceOf(GitHubUnavailable)
    const broken = (async () => {
      throw new TypeError('network down')
    }) as unknown as typeof fetch
    await expect(createGitHub({ userAgent: 'x', fetch: broken }).user('1')).rejects.toBeInstanceOf(
      GitHubUnavailable,
    )
  })

  test('never asks about an id that is not a number', async () => {
    const seen: Request[] = []
    const github = createGitHub({ userAgent: 'x', fetch: answering(200, { login: 'x' }, seen) })
    expect(await github.user('../orgs/x')).toBe(null)
    expect(seen).toEqual([])
  })
})
