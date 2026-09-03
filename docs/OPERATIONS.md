# Operations

How Tela is provisioned and deployed. Sections marked *later* are filled in by the phase that
implements them (see `docs/ARCHITECTURE.md`).

## Environments

| Component | Where | Notes |
|---|---|---|
| Web | Cloudflare Workers via OpenNext (`apps/web`) | Custom domain only; never share `workers.dev` URLs (blocked in mainland China) |
| Database + Auth | Supabase, region Tokyo (`ap-northeast-1`) | IPv4 add-on for the direct connection; custom SMTP (Resend); custom auth domain *later* |
| Worker | Fly.io app `tela-worker`, region `nrt` (`apps/worker`) | Docker image, Node 22; roles via `WORKER_ROLES` |
| Relay | HK or CN box running the same image with `WORKER_ROLES=relay` | *later*, phase 8 |
| Assets | Cloudflare R2 bucket behind `assets.<domain>` | favicons and covers; *later*, phase 3 |

## Environment variables

| Name | Used by | Meaning |
|---|---|---|
| `DATABASE_URL` | worker, web (local / non-Cloudflare) | Postgres connection string. On Cloudflare the `HYPERDRIVE` binding replaces it. |
| `WORKER_ROLES` | worker | Comma list of roles; default is every role except `relay` |
| `LOG_LEVEL` | worker | `debug` / `info` / `warn` / `error` |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | web | Browser auth client (phase 4) |
| `NEXTJS_ENV` | web (`.dev.vars`) | Which `.env` files OpenNext loads locally |
| `TEST_DATABASE_URL`, `PG_BIN_DIR` | tests | Use an existing database, or point at Postgres binaries |

## Provisioning

### Supabase
1. Create a project in Tokyo. Enable the IPv4 add-on (Project Settings → Add-ons) so Hyperdrive can
   use the *direct* connection string (not the pooler).
2. Auth → SMTP: configure Resend (built-in SMTP is capped at 2 emails/hour). Verify delivery to
   qq.com and 163.com addresses.
3. Auth → Providers: Email (OTP), GitHub, Google (phase 4).
4. Apply migrations: `DATABASE_URL=<direct connection> bun run db:migrate`.

### Cloudflare
```sh
cd apps/web
bunx wrangler login
bunx wrangler hyperdrive create tela-db --connection-string="<supabase direct connection string>"
# paste the returned id into wrangler.jsonc → hyperdrive[0].id
bun run deploy            # opennextjs-cloudflare build && deploy
```
Then add the custom domain under Workers & Pages → tela-web → Settings → Domains.

### Fly.io (worker)
```sh
fly apps create tela-worker
fly secrets set --app tela-worker DATABASE_URL="<supabase direct connection string>"
fly deploy --config apps/worker/fly.toml --dockerfile apps/worker/Dockerfile
```

## Local development

- Web: `cp apps/web/.env.example apps/web/.env`, set `DATABASE_URL`, `bun run dev`.
- Cloudflare runtime locally: `cd apps/web && bun run preview` (uses `localConnectionString` from
  `wrangler.jsonc` for Hyperdrive).
- Worker: `cp apps/worker/.env.example apps/worker/.env`, `bun run dev:worker`.
- Tests: `bun run test`. DB tests start a throwaway cluster with the local `initdb`; install
  Postgres with `brew install postgresql@17` or set `TEST_DATABASE_URL`.

## Runbooks (*later*)

- Rotating the image-proxy signing key (phase 4)
- Rotating the relay secret (phase 8)
- Reviving a dead feed, adjusting the LLM budget, adding a reading language (phases 3, 5)
