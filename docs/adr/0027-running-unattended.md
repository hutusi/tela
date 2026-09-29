# 0027 — Running unattended: a dead-man's switch, a weekly digest, and a restorable export

Status: accepted (2026-09-29). Builds on 0020 (all-in Cloudflare) and 0021 (portable by
construction).

## Context

The owner ranks years of running with little attention above cost, and neglect is the bigger
risk. The Postgres app's only health check wrote a log line nobody read. Three kinds of failure
matter:

- **The work stops**, and nothing notices: a broken deploy, an expired key, an account problem.
- **The work degrades:** feeds fall behind, a provider fails, extraction fails on a host. Each
  degrades quietly.
- **The data is lost**, or locked into one provider.

Supabase's free plan also paused projects after a week of low activity; nothing on Cloudflare does
that, but nothing on Cloudflare tells the owner anything either.

## Decision

**A dead-man's switch, pinged from inside the work.** Every five minutes after the minute tick,
tela-jobs runs a health check and reports it to an outside service. The health check asks:

- are feeds past due by two hours with nobody holding them?
- has a member waited over 30 minutes on a translation?
- is extraction piling up?
- was there a burst of dead letters?
- is the backup stale or unverified?

The service is healthchecks.io's convention: the ping URL when healthy, `/fail` with the problems
when not. Its alert on silence is the only signal that covers everything that stops the tick
itself. The ping comes from the pinned fetch handler after the tick has done its work, so a green
check means the work ran, not just that a cron fired.

**A Monday digest, not a dashboard.** A plain-text mail to the owner, one page:

- new posts and members;
- failing and dead feeds;
- dead letters;
- model use;
- database size;
- the last backup;
- feeds Cloudflare cannot reach.

The last is the evidence for provisioning the relay. A dashboard is something to remember to
look at, while a mail arrives either way.

**A nightly export that is restored in CI.** D1's Time Travel is the point-in-time copy (30 days,
in place). The export is the portable one:

- **What it holds:** every table worth keeping, as JSON lines in the private bucket, parts of
  5,000 rows, with a manifest of row counts and SHA-256 hashes.
- **Verification:** a second pass reads it all back, and `latest.json` records the result for the
  health check and the digest.
- **Left out:** sessions, sign-in codes, leases and limits. They are credentials or live
  coordination, and a restored database signs everyone in again.
- **Order:** tables come from the Drizzle schema, parents before children.
- **Kept for** 30 days.

**No GitHub scheduled workflows.** GitHub disables them in a public repository after 60 days
without a commit, which is exactly the neglect this is for. They would also need an R2 token that
can expire. Everything runs from the jobs Worker's own crons.

## Consequences

- **Every alarm path is exercised.**
  - The health check's thresholds, the ping's two URLs and the digest's sections have tests
    (`apps/jobs/test/ops.test.ts`).
  - The export runs on libSQL and on D1 in the contract suite.
  - The suite writes a member's feed, likes and a highlight through the real API, exports and
    verifies it, restores it into a fresh libSQL database, compares every table, then signs in on
    the restored stack and pulls the same rows back (`apps/api/test/backup.test.ts`). The exit
    path is run on every commit rather than kept in a runbook nobody has tried.
- **The export is not one snapshot.** Tables are read in turn while writes go on, so a child can
  name a parent written after its table was read, and a restore turns foreign-key checks off. An
  orphan costs a missing join. Time Travel is the transactional copy.
- **Two outside accounts to keep alive:** healthchecks.io and Resend, both on free tiers. If either
  lapses, nothing breaks; the owner stops hearing, and the next digest or ping says so.
- **The thresholds are guesses at current volume** (40 feeds, one reader). They live in one object
  (`THRESHOLDS` in `apps/jobs/src/ops.ts`) to be tuned when the numbers are real.
