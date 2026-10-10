/**
 * GitHub's public profile of a member, asked by the numeric id their GitHub sign-in left behind
 * (ADR 0036 keeps nothing else): a claim checks that the blog links this profile and that the
 * profile names the blog (ADR 0045). Tela names the host, so this is a plain `fetch` and not the
 * HTTP client for member-given URLs, as the Gravatar check is in tela-api; and the token, when
 * there is one, goes to that host only, on no redirect.
 */

export type GitHubUser = {
  login: string
  /** The profile's website, as typed into GitHub (often without a scheme); empty when unset. */
  website: string
}

export type GitHub = {
  /** The profile behind a numeric account id; null when GitHub has none under it. */
  user(id: string): Promise<GitHubUser | null>
}

/** GitHub did not answer, or not in a way that says whether the profile exists. */
export class GitHubUnavailable extends Error {}

export const GITHUB_API_URL = 'https://api.github.com'

export function createGitHub(options: {
  userAgent: string
  /** A token with no permissions: 5,000 requests an hour instead of 60 per egress IP. */
  token?: string
  apiUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}): GitHub {
  const base = (options.apiUrl ?? GITHUB_API_URL).replace(/\/+$/, '')
  const doFetch = options.fetch ?? fetch
  return {
    async user(id) {
      if (!/^\d{1,20}$/.test(id)) return null
      let res: Response
      try {
        res = await doFetch(`${base}/user/${id}`, {
          headers: {
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': options.userAgent,
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        })
      } catch (err) {
        throw new GitHubUnavailable(err instanceof Error ? err.message : String(err))
      }
      if (res.status === 404) return null
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {})
        throw new GitHubUnavailable(`GitHub answered HTTP ${res.status}`)
      }
      const body = (await res.json().catch(() => null)) as { login?: unknown; blog?: unknown }
      if (typeof body?.login !== 'string') throw new GitHubUnavailable('GitHub sent no login')
      return { login: body.login, website: typeof body.blog === 'string' ? body.blog.trim() : '' }
    },
  }
}
