# 0008 — China fetch relay: a signed fetch-and-return endpoint, not a second worker

Status: accepted (2026-09-04)

## Context

Many independent Chinese blogs are slow or unreachable from Tokyo, and the reverse is true for
the rest of the web from mainland China. A full worker instance in China would need database
credentials and the LLM API on a box inside the firewall, cross-border Postgres traffic for every
job, and a second deployment to keep in sync. The requirement is narrower: some HTTP GETs should
originate from a different network.

## Decision

- **The `relay` worker role serves one HTTP endpoint** (`POST /fetch`, plus `GET /healthz`) from
  the same image as every other role, with no database or queue. It performs a single GET with an
  allowlisted subset of the caller's headers (`user-agent`, `accept`, `accept-language`,
  `if-none-match`, `if-modified-since`), does not follow redirects, caps the body at 5 MB, applies
  the same private-network rules as the direct path, and returns `{status, headers, bodyB64}`.
  Fetch failures come back as `{ok: false, kind}` in the client's own error taxonomy.
- **Requests are HMAC-SHA256 signed** over a timestamp and the exact JSON body with a shared
  secret (`RELAY_SECRET`); the relay rejects signatures older than five minutes and keeps
  accepting `RELAY_SECRET_PREVIOUS` during rotation.
- **The global worker follows redirects hop by hop through the relay**, so every hop is checked
  on both ends and the feed's `feed_url` can still adopt permanent redirects.
- **Feeds move onto the relay automatically.** A feed starts `global`. Its third consecutive
  timeout, while a control URL (`RELAY_CONTROL_URL`) still answers, flips it to `fetch_region =
  'cn'` and retries at the next tick. Only timeouts count: 4xx/5xx mean the origin answered.
  The daily maintenance job sends feeds back to `global` after seven days; if they time out again
  they flip back, so nothing is stuck on the relay forever.
- **Hong Kong first.** A HK box reaches mainland hosts well, has good international links and
  needs no ICP filing. A mainland box is a config change (`RELAY_URL`), not a code change.

## Consequences

- No secrets beyond `RELAY_SECRET` live outside the primary region, and the relay cannot be used
  as an open proxy: it needs a valid signature, refuses private ranges, and only ever GETs.
- Relay round trips add latency and one extra hop of failure; `FETCH_TIMEOUT_MS` applies on both
  sides and the client waits ten extra seconds for the relay itself.
- Claim verification and favicon fetches use the same client, so they benefit from the relay once
  a feed's site has flipped.
- Translation and extraction never run in China; the relay returns bytes, everything else stays in
  the global worker.
