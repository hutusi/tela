# 0007 — Body images through a signed proxy; favicons and covers in R2

Status: accepted (2026-09-04)

## Context

Article bodies reference images on thousands of hosts. Serving them directly leaks every
reader's IP address to those hosts, breaks on hotlink protection and mixed content, and is
unreliable from mainland China for many origins. Storing every body image would cost storage and
egress for content Tela does not own.

## Decision

- Stored HTML keeps the original absolute image URLs. At render time `rewriteImages` turns each
  into `/img?u=<base64url(url)>&s=<hmac-sha256(secret, u)[:32]>`.
- The `/img` route verifies the signature, fetches the origin with a bot user agent and no
  referrer, allows only `image/*` (never SVG), caps at 10 MB, sets `nosniff` and a sandboxing CSP,
  and caches for seven days through the Cache API on Cloudflare.
- The signing secret is `IMAGE_PROXY_SECRET`; rotating it invalidates cached proxy URLs, which are
  regenerated on the next render. Without a secret (misconfiguration) images fall back to their
  origins with a logged warning; in dev-auth mode a fixed secret is used.
- Favicons and cover images are Tela-owned assets: normalized by the worker and stored in a
  Cloudflare R2 bucket behind `assets.<domain>` (phase 6), not Supabase Storage, because
  `*.supabase.co` is unreliable from China and R2 has zero egress.

## Consequences

- Readers never contact blog image hosts; hotlink protection stops mattering.
- The proxy cannot be used as an open proxy: only URLs signed by Tela render.
- Per-image latency on first view (fetch through the Worker); cached afterwards.
