# 0034 — Invite codes: five for each member, many for the operator, one gate for every new account

Status: accepted (2026-10-02). Supersedes 0015's "invite codes are deliberately not built": the
beta stays private (`TELA_PRIVATE_BETA`, noindex), and every new account still needs an
invitation, now from a member or the operator. Amends 0024: an account is created at its first
sign-in, once the gate below admits it, and no longer only by `bun run admin invite`.

## Context

0015 deferred invite codes because their design should follow how Tela opens up: one person at a
time, waitlist batches and open signup with limits are three different features. That decision is
now made. Members bring people in:

- Every member may invite five people, ever. One code admits one person, and a used code counts
  for good.
- An unused code can be revoked, which frees its slot. Codes never expire, and the people a member
  invites get five of their own.
- The operator makes codes of their own, with text of their choosing and a maximum number of
  uses. `bun run admin invite <email>` stays.

Today an account exists only because the operator made it: better-auth's email-code plugin has
`disableSignUp` on, and `POST /api/admin/invite` creates the user. Two paths create a user, the
admin route (`internalAdapter.createUser`, outside any better-auth endpoint) and the code sign-in;
0036 adds the Google and GitHub callback as a third.

Two constraints shape the rest. D1 is batch-only, so nothing can hold a transaction across "take a
place" and "create the user". And better-auth inserts the user in a statement of its own, after its
hooks have run.

## Decision

**Two tables, neither synced.**

- `invite_codes`: the code (primary key, normalized to `[A-Z0-9]`, 4 to 32 characters), who made
  it (null for the operator's), `max_uses` (default 1, at most 100,000), when it was made and
  revoked.
- `invite_redemptions`: a code (null for an operator's invitation to one address), the address,
  when it expires, when it was redeemed, the member it made and when it was settled, and when it
  was written. One row per code and address.

A code never references its redemptions: the nightly export orders tables by their foreign keys,
and a cycle has no order. Neither table has a `seq`, nothing is pulled, and `MIN_CLIENT` stays 2.

**A hold is not a place.** `POST /api/v1/join {code, email}` writes a hold (a redemption not yet
redeemed, for 24 hours) and mails a sign-in code that says the address is invited. Places are
counted only by redemptions: a code is full when as many people have joined with it as its
`max_uses`. So a typo, a stranger who found the link, or a run of junk joins holds no place, and a
real invitee never meets "used" while nobody has joined. On a single-use code a later join moves
the hold: the same batch deletes the code's other pending holds, so only the last address asked
for can finish. The route answers 400 `invalid_code` for a code that is unknown or revoked (one
answer for both), 409 `code_used` for a full one, and 200 otherwise. An address that already has
an account gets an ordinary sign-in code, and takes neither a hold nor a place from the code it
brought. Its join still moves a single-use hold like anyone's: a hold that outlived a join with
another address, which its holder can test by asking for a sign-in code, would say that address
has an account.

**Admission is a claim, in one statement.** The gate is better-auth's
`databaseHooks.user.create.before`, which every path that creates a user runs. It admits only by
claiming an invitation: one `update … returning` sets `redeemed_at` on a live row for the address,
guarded by the code being unrevoked and under its `max_uses`, and the result is read through
`RETURNING`. Which rows it may claim depends on what proved the address. A hold says only that
someone typed the address beside a code; the six digits that reach its mailbox are what prove it.
So the code sign-in, like the admin route, claims what the address holds: its own operator
invitation, else its newest hold on a live code. An OAuth callback has only a provider's word that
the address was verified there once (0036), so it claims nothing the address holds, only the code
its own sign-in carried: that code's row for the address, or, when there is none, a redeemed row
inserted in one statement, guarded the same way and idempotent per code and address. A provider's
sign-in that carried no code is refused, even while a hold for its address waits for the six
digits. A row already claimed but never settled, for an address that still has no user, is
admitted again, on a path that may claim it, without spending a second place: the user insert that
follows the hook can fail, and the place would otherwise be gone for nothing. A provider's sign-in
takes that row whichever code it is on, when its own code could have admitted it alone, so a retry
by another method, or two sign-ins racing, spend one place between them.

**It refuses by throwing.** An `APIError('FORBIDDEN', {code})`. A hook that returns `false` makes
`createUser` return null, and the code sign-in then fails on `newUser.id` with an empty 500, after
the six digits have been spent.

**Once the account exists**, the redemption is settled: it records the member and when, and
deletes the address's other pending holds. The stamp is what ends re-admission, not the member's
id, which goes null if the member is ever deleted: their place stays spent and admits nobody. The
profile is written idempotently (`on conflict (user_id) do nothing`), when the user is created and
again whenever a session is, so a member whose profile insert failed is repaired at their next
sign-in.

**The mail gate.** With `disableSignUp` off, better-auth would mail a code to any address it is
given. `sendVerificationOTP` mails a sign-in code only to an address that has an account or a live
hold; for any other, it deletes the code it was handed and sends nothing, and the endpoint answers
exactly as it always has. The mail says "invited" to a newcomer with a hold, and to an
operator-invited account that has not yet signed in.

**A member's five.** A code counts toward the five while it is unrevoked, and for good once
someone has joined with it. One `insert … select` writes a new code only while the member has
fewer than five such codes, so two requests at once cannot make a sixth; a clash with an existing
code and a full allowance are told apart. A code is 12 symbols from `23456789ABCDEFGHJKMNPQRSTVWXYZ`
(no 0, 1, I, L, O or U), about 59 bits, drawn with `crypto.getRandomValues` and rejection
sampling, shown in groups and normalized on the way in. Revoking takes only the owner's unrevoked,
unused code, frees its slot, and cancels the holds placed with it. An inviter sees who joined by
their handle, never an address still pending.

**The operator's codes.** `bun run admin code <TEXT> --uses N` makes a code of the operator's own
text; `codes` lists them and `revoke <TEXT>` withdraws one. They are guessable by choice, since a
word is a word: give them small `--uses`, and revoke them when their moment has passed.
`bun run admin invite <email>` stays, and passes the same gate: it writes an operator invitation
for the address (expiring in an hour) before it creates the account, and the hook claims it as it
would anyone's.

**Limits.** `/api/v1/join` mails through `auth.api.sendVerificationOTP`, a server-side call that
better-auth's limiter never sees, so the route counts its own in `action_limits`: per IP (10 an
hour), per code (10 an hour) and per address (3 an hour).

**The invite routes are RPCs, not synced data.** `GET` and `POST /api/v1/invites` and
`DELETE /api/v1/invites/:code` are member calls, like `/api/v1/dashboard`, not rows a pull brings
and mutations change (0025). An invite list holds other people's state, whether someone joined and
under what handle, which changes on their schedule, as 0031 found for the people a member follows.
A code is minted by the server, unique and counted against the allowance the moment it exists,
which an optimistic mutation made offline cannot promise. And the answer, the code to copy, is
what the member is waiting for. The admin routes are `POST`, `GET` and `DELETE /api/admin/codes`.

**Holds that never joined are deleted.** The daily job deletes a hold a day after it expired, so
an address that never became a member is not kept.

**Alternatives considered:**

- **An email allowlist.** It is what `admin invite` already is, and it cannot let members bring
  people.
- **A place reserved at join.** Counting pending holds against `max_uses` lets a leaked code, or
  one mistyped address, fill every place for a day, and the real invitee is told "used" while
  nobody has joined.
- **better-auth's `user.validateUserInfo`.** 1.7.6 has a hook made for this, told the method and
  the action. It requires an endpoint context, and the admin route creates its user outside one,
  where it throws `validation_context_missing`. `create.before` runs on every path (0036 has the
  rest of that trade-off).
- **The code in the body of the code request.** better-auth validates
  `/email-otp/send-verification-otp`'s body against a schema that strips unknown keys, so the mail
  gate would never see it. Sent with `/sign-in/email-otp` instead, a bad code would be found only
  after the six digits were consumed. The hold, written before any mail is sent, carries it.
- **Treating a missing hook context as the operator.** better-auth passes the endpoint context
  through AsyncLocalStorage, and the admin route is the only creator without one today. Reading
  its absence as permission would admit anyone the day a refactor, an upgrade or a background task
  loses it. The operator writes an invitation like anyone else, and a missing context grants
  nothing.

## Consequences

- Opening up is three steps, in order: a large operator code, then lifting the gate, then removing
  `TELA_PRIVATE_BETA` (the runbook's "Later"). As 0015 said of its two switches, stopping before
  the last leaves a site that admits everyone and tells search engines to ignore it.
- A place is spent if the user insert fails after the claim. The re-admission above lets the same
  address finish; no other address can take that place.
- Two people can hold a single-use code at once only for a moment: the later join deletes the
  earlier hold. On a multi-use code the first people to sign in take the places, and anyone after
  them gets `INVITE_USED` at the sign-in.
- A newcomer who joined with an address and then chose Google or GitHub from Log in, which carries
  no code, is told an invitation is needed. The sheet's Join carries the code to the provider.
- A hold outlives the code it mailed (a day against an hour), so asking again for a code within the
  day works without joining again.
- An operator code is as guessable as its text. The limits on `/join` slow guessing; they do not
  stop someone with many addresses.
- The inviter's account owns their codes (on delete, cascade), and the codes own their
  redemptions, so deleting an inviter would take the record of who joined with them. Nothing
  deletes an account today.
- The statements are run on libSQL and on D1 by the data contract suite, as every other statement
  whose meaning depends on the engine.
