# 0023 — Translation streams in chunks, and runs on leases instead of attempts

Status: accepted (2026-09-28). Amends 0006. Its policy stands: eager titles, lazy bodies, the
launch language set, the provider adapter, output validation. The attempt, heartbeat and sweeper
machinery that enforced it is retired.

## Context

Body translation was all-or-nothing. A reader who opened a foreign post waited until the whole
article was translated. Spike S6 measured what that costs with GLM from a Worker in Singapore:

- The model emits about 70–100 tokens a second.
- A 2k-token chunk takes 15–22 s. At the old 3k-token chunks, the first paragraph would arrive
  after about 30 s.
- A chunk of about 400 source tokens takes about 5 s.

Around that sat the enforcement machinery from the Postgres stack, about 550 lines and 700 of
tests. It had grown to cover the ways a pg-boss job could outlive or race its own retry:

- an attempt id on every row;
- heartbeats after each chunk;
- a sweeper that re-sent or abandoned stale attempts;
- a conditional write for every status change.

Title translations were queued from inside each fetch's transaction. A caller that forgot to
queue them left articles that nothing would ever translate, and 46 live articles once ended up
that way (AGENTS.md).

## Decision

- **Bodies stream.**
  - The job reads the content object, serves cache hits by block hash, and groups what remains
    along top-level block boundaries: the first group about 400 source tokens, later ones about
    3k.
  - Each group is one `translateBlocks` call with its own strict retry, so a chunk is final when
    it is written. Validation is unchanged: placeholder multiset, length ratio, echo guard, and
    re-escaping on rehydration (ADR 0005).
  - Each group becomes a chunk object, `tc/<key>/<lang>/<request>/<n>.json`: rehydrated HTML for
    its top-level blocks, by index. It is committed in a fenced batch with its cache rows, the
    call log and the running token count, and that batch extends the lease for the next group.
  - When every group is done, the finished translation object, `t/<key>/<lang>/<sha>.json`, is
    stored beside the content object. It is keyed by content version, so two articles with the
    same body share it.
- **An execution has a budget.** It starts no group after ten minutes of its fifteen, and
  releases the lease with the row still `running`. The next tick claims the row again and
  continues: the blocks it already translated are now cache hits, and only groups that still need
  the model are streamed again.
- **Titles are found, not queued.** Each article carries the hash of the title and excerpt
  readers see. A title is due when some launch language has no translation made from that hash.
  Echoes and failures are recorded against the hash too, so the sweep stops asking until the
  title changes. An echo still never enters the shared cache.
- **Titles are batched by feed.** The title lease is keyed by feed, and one job translates up to
  20 of its due titles and excerpts in one call per language, with the site's name as context.
  Titles were 81% of production's model spend (937k of 1.16M tokens over 1,961 calls), and a
  call averaged 393 input tokens to carry about 90 of title and excerpt: the prompt was paid
  once an article. If the provider fails for one language, what the others made is committed
  and only the rest backs off.
- **Budgets live in `usage_daily`**, one row per subject and UTC day:
  - A member's subject is their user id. The API reserves an estimate against it when the reader
    asks; ADR 0024 says how.
  - The translation replaces that reservation with what it actually spent when it concludes,
    charged to the day of the reservation.
  - Background work (titles) charges subject `'*'`. The title sweep claims nothing once the
    day's budget is spent.
- **A claim is taken over before any work.** `runJob` first moves the lease from the claim's
  owner to one of its own, renewing it, and drops a message whose claim lapsed while it waited in
  its queue. Without this, a stale message spent a model call that the fence then threw away;
  the translation tests caught it. Taking the claim over, rather than only renewing it, also
  drops a second delivery of the same message: the queue delivers at least once, and two runs
  under one owner both passed the fence and sent every block to the model twice (ADR 0021).
- **No accidental mock.** A deployment whose provider falls back to the mock (no key) has no
  translator, and the translation kinds are disabled (AGENTS.md).

## Consequences

- **The first translated paragraphs appear in about five seconds** instead of after the whole
  article. The reader overlays chunks onto the source by block index as they land (ADR 0025, to
  come).
- **The attempt model is gone:** attempt ids, heartbeats, the sweeper, the per-member advisory
  lock and conditional status writes. What they guaranteed is now the lease, the fence and a
  conditional upsert.
- **A stuck translation needs no special handling.** When a lease expires, the next tick claims
  the row; after its attempts, it is a dead letter and the row is `failed`.
- **A request past midnight is charged to the day it was reserved**, not the day it finished.
- **Content from an older `NORM_VERSION` is refused, not translated.** Old hashes under new rules
  would mix cache entries. Renormalizing from the raw HTML first is the fix, and it will be built
  when a bump happens.
