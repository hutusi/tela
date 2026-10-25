# 0058 — Leaving Tela: an account closes at once and is erased after, and a claim can be let go

Status: accepted (2026-10-25). Amends 0025: a closed account's devices are signed out by a 401,
and nothing it leaves on other devices is hard-deleted. Amends 0031, whose Settings had no
"delete account", and 0034, whose last consequence said nothing deletes an account: one is now
closed without deleting its rows, so the codes and redemptions that name it never cascade. Amends
0011 and 0045: a claimant may let their blog go.

## Context

Opening sign-up to anyone means anyone can also want to leave, and the Privacy page has to say
what leaving does. Three things were missing: a member could not delete their account, the export
(`GET /api/v1/export`) left out claims, invite codes, read states and the picture, and only the
operator could take a claim off a blog.

Deleting the `user` row would look simplest, and every foreign key cascades or nulls. It does the
wrong thing in three places:

- **Other members' records go with it.** `invite_codes.created_by` cascades, and the codes own
  their redemptions, so deleting an inviter deletes the record of who joined by their codes (0034
  noted this).
- **Other devices are never told.** A follow of the member lives on each follower's device. A
  device drops a row only when a pull says so, as a soft delete with a new seq or a tombstone
  (0025); a row that is simply gone stays on every device that held it.
- **The handle is freed.** The next person to ask for it gets it, and with it the profile address
  the member's readers, followers and blog links point at: an impersonation waiting to happen.

Two constraints shape the rest. D1 is batch-only, and a member with years of reading has tens of
thousands of rows: likes, read states, highlights, subscriptions. And the counts others see (a
post's likes and recommendations, a blog's readers) rest on those rows, so removing them means
recounting rows other members sync, and a seq that stamps more rows than a pull page holds pushes
every one of those members onto the unpaged path.

## Decision

**An account is closed, never deleted.** The `user` and `profiles` rows stay for good, as shells:
the address becomes `deleted+<id>@deleted.invalid`, which no mail reaches and which stays unique,
the name and picture go, and the profile keeps its handle and nothing else. The handle stays taken,
because the unique index says so. Rows of other members that name the account (a redemption, a
follow of it, an audit row) stay valid, and no cascade ever fires. Tela mails nothing to an address
at `deleted.invalid`, in any case: a code asked for one is deleted unsent, and the endpoint answers
as it does for any address.

**Closing is one batch, at once** (`closeAccount` in `@tela/data`), shared by the member's own
deletion and the operator's:

1. the audit row, written only while the account is open, so a repeat logs nothing;
2. `bumpSeq`;
3. follows both ways, deleted as an unfollow is, so each follower's device drops its row at its
   next pull;
4. recommendation notes, blogroll names and descriptions and per-blog notes emptied, and the
   recommendations and blogrolls deleted (soft);
5. the profile emptied (name, bio, picture, languages, both privacy switches, the console) and
   `deleted_at` set, with seq;
6. every way in: sessions, passwords and provider links, mailed codes and OAuth states for the
   address, and Tela's own rate-limit counts for the member and the address;
7. its invite codes revoked and the holds on them cancelled (and again by the erasure, for a code
   whose request passed the standing check just before the closing); the redemption it joined by
   keeps its place and its member, with `deleted:<id>` for the address;
8. the address replaced (after every statement that reads it);
9. its blogs released, and a claim still pending failed with its check cut off;
10. its body translations still waiting given back to its ledger and ended (`failed`); one already
    running finishes and settles as ever, to the member it names (`requested_by` is never nulled
    while a request is open);
11. its imports waiting to be added dropped.

Every statement selects by the member's id, a handful of parameters however much they had.

**What only the member's devices held is erased after, in chunks** (`member.erase`, tela-jobs).
It is due ten minutes after the closing, past the five-minute signed copy of a session, so nothing
a tab of the member's still sends lands after it. Each step takes at most 500 rows of one table in
a fenced batch, and repeats until it takes fewer: read and like states, recommendations,
highlights, filings and folders, blogrolls and their blogs, subscriptions, prefs, the member's own
follows, applied mutations, tombstones, queued imports and claims. Likes, recommendations and
readers are recounted without the member before the rows behind them go, in the same batch, so at
most 500 posts or blogs move per seq. What names the member in Tela's own records stops naming
them: model calls, the feeds they added, translations they asked for that have ended, reports they
made or resolved. Their uploaded pictures (`avatars/<id>/`) are deleted. The usage ledger is
last, and it is folded, never dropped: each day's row is added into one subject that is no member
(`'~closed'`) and then deleted, so the site's total for every day (0057, a sum over subjects)
stays what it was.
`erased_at` is stamped only while nothing is left and no translation of theirs is running; a run
that finds one ends without it and is claimed again. Out of attempts, nothing is marked done: the
dead letter stops it, and a retry from the console resolves the letter and makes it due again.

A follow of the member stays as the closing left it, deleted (soft): a follower's device that has
not pulled since would never hear of a row that is gone.

**Every tab signs out without a protocol change.** The deletion's answer clears the asking
browser's cookies through better-auth's sign-out. Every other tab and device keeps its cookie, and
with it a signed copy of the session for up to five minutes; so tela-api reads the account's
standing from D1 on `/me`, the pull, the export and every call that is not a GET, and answers a
closed or suspended account (0059) 401, which every shell already reads as the end of the session
(0025): it wipes the device's copy. `session.create.before` refuses either standing a new session,
whichever way in made it, by throwing (0034's rule for hooks), and `session.create.after` reads the
standing again once the row exists: a closing or a suspension that lands between the read and the
insert ends every session but that one, so the after hook ends the account's sessions and refuses
the sign-in before a cookie is set. A follow of an account out of
standing writes nothing, so a follow queued on a device offline as the account closed cannot bring
its row back. Soft deletes are the only deletion devices already understand, so `MIN_CLIENT`
stays where it is.

**The member deletes from Settings › Account, with a mailed code.** `POST /api/v1/account/delete/code`
mails a six-digit code, kept hashed in Tela's own `verification` row (`account-delete-otp-<address>`,
so the closing deletes it with better-auth's codes) and counted under `otpSend` like every code
mailed to an address. `POST /api/v1/account/delete {code}` is counted under `otpVerify`, and each try
spends one of the code's three. The mail carries no link: a link that deletes an account is one a
mail scanner or a slip could follow. The confirmation says what goes at once, what goes within
minutes, what stays (the handle) and how long backups keep a copy. An admin's account is refused:
the console is ungranted first. The operator's `member.delete` runs the same batch, audited, with
no undo, refused for an admin and for the operator themselves.

**A closure survives a restore.** Before the closing batch, `closures/<id>` (the id and the time,
nothing else) is written to R2. A backup restored from before the closing brings the account back,
so the restore runbook re-applies every closure (`reapplyClosures`), which re-runs the closing for
each, idempotently; `member.erase` then erases again what the backup brought back. Written before
the batch, a closing that fails is re-applied too: the member asked for it, with the code. Backups
keep a closed account's data for 30 days, until the last backup from before the closing is pruned.

**The export carries what leaving would take**: the blogs the member claimed, their codes and who
joined by each (by handle, never a pending address), the invitation they joined by, what they read
or marked unread, each subscription's read-up-to post, and the picture's whole address.

**A claimant lets their blog go** (`POST /api/v1/claims/:siteId/release`, Dashboard › "Release this
blog"), through the statements the console's `claim.remove` runs (`releaseClaim`, by `operator`,
`member` or `closure`). The claim fails with a reason its claimant reads; the blog loses its owner,
the feeds it declared and a listing only the claim opened. Only an operator's removal also resets
the translation opt-out and marks the claim overruled (0045): what a writer chose for their blog
stays chosen when they leave, and any proof wins it back. The operator can still change it.

**Alternatives considered:**

- **Deleting the user row, with tombstones.** Tombstones exist for a few entities only, every
  cascade would need one, others' invitation records would still go, and the handle would be free.
- **Erasing everything in the closing batch.** Unbounded rows in one statement each, and a recount
  of every post the member liked stamped with one seq: more than a page for every member who holds
  those posts.
- **A grace period with an undo.** The decision was immediate deletion, confirmed by a fresh code;
  the export is one link away in the confirmation, and a grace period would keep personal data
  past the member's request.
- **Freeing the handle after a while.** Whoever took it would inherit the profile address others
  link to.

## Consequences

- A handle, once used, is never available again. The namespace pays for that, and a member who
  wants their handle back after deleting cannot have it.
- What caches hold outlives the closing: a picture for up to 30 days per colo, a public profile for
  up to about nine minutes (0024, 0031). The Privacy page says so.
- Within the five minutes of the signed session copy, a GET other than `/me`, the pull and the
  export can still answer a closed account's tab. It is answering the member about what is left of
  their own account, and the next pull ends it.
- The account's usage ledger stops naming them, but what they spent stays in the site's total for
  each day (0057): closing accounts gives no budget back. The `'~closed'` subject holds every closed
  account's days together; the console's count of members at the day's limit leaves it out, as it
  does `'*'`.
- Counts others see drop ten minutes after a closing, not at once, and only when `member.erase`
  runs; until then a post shows the member's like.
- A release leaves the claim row `failed` with the text `released by its claimant`: claims have no
  tombstone, so a device holding the row must see it change.
- `member.erase` is the one kind whose exhaustion marks nothing: an erasure stuck on its dead letter
  is visible in the console and in the health check's dead letters until someone retries it.
