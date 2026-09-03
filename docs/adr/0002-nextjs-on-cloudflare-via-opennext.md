# 0002 — Next.js on Cloudflare Workers via OpenNext, kept portable

Status: accepted (2026-09-04)

## Context

The owner wants Cloudflare for cost at scale and reachability from mainland China. Next.js is the
framework with the broadest ecosystem and tooling. The `@opennextjs/cloudflare` adapter supports
Next 16 but has limits: 3 MiB / 10 MiB compressed bundles, no edge runtime, per-request DB clients,
ISR only with R2 + tag cache, and `proxy.ts` support that landed in 1.20.3 (2026-08-26).

## Decision

- Deploy `apps/web` with `@opennextjs/cloudflare`; custom domain only (`workers.dev` is blocked in China).
- No ISR: pages render dynamically; public pages will use the Cache API explicitly.
- No middleware / `proxy.ts`; next-intl runs without routing (ADR 0010).
- All Cloudflare-specific code lives in `apps/web/src/lib/platform/`. The rest of the app must run
  unchanged on Vercel or a Node container.
- Postgres via Hyperdrive to Supabase's direct connection (ADR 0003), one client per request.

## Consequences

- The adapter is the largest schedule risk in the stack; the escape hatch is a config change, not a rewrite.
- `next/image` optimization is off; body images use the signed `/img` proxy anyway.
- Alternatives considered: Vercel (best DX, pricier, `*.vercel.app` blocked in China); a framework
  with first-class Cloudflare support such as SvelteKit or TanStack Start (smaller ecosystem).
