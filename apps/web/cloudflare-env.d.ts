// Minimal binding types. Regenerate with `bun run cf-typegen` once wrangler is authenticated.
interface CloudflareEnv {
  HYPERDRIVE?: { connectionString: string }
  ASSETS?: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }
}
