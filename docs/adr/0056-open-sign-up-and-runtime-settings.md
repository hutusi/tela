# 0056 — Open sign-up behind a switch, and settings that change while Tela runs

Status: accepted (2026-10-25). Supersedes 0034's "Opening up is three steps, in order" (an
operator code, then lifting the gate, then the noindex var): sign-up opens and closes with one
setting, and indexing is a separate matter. Amends 0034's gate, which admits an account only by
claiming an invitation: while sign-up is open, a proved address is enough. Amends 0036's "the
callback is admitted by that code and nothing else": while open, a provider's return makes an
account with no code, and still claims only the code its own sign-in carried, never a hold. Amends
0043's "joining still starts with the invite code and the address": while open, with the address
alone. The rest of 0034, 0036 and 0043 stands: one gate, refusals thrown, a missing context
granting nothing, a password set only once a code has proved the address, and a provider linked
to a member only from Settings.

## Context

Tela is opening to anyone. Every account still needs an invitation, and the gate that says so is
code. Opening needs a way back that does not wait on a deploy: if spam arrives at 3 a.m., the
operator, or whoever can reach the console, should close sign-up in one step and have it hold from
the next request. The same is true of the limits the public launch adds (translations and new
feeds a day per member, subscriptions per account, the site's daily translation budget, when to be
mailed): each is a number someone will want to move the week it is first met.

Today every one of those is a constant in the code or a var in a `wrangler.jsonc`. A var changes
only with a deploy of the Worker that reads it, and tela-jobs, tela-api and tela-web each hold
their own. Two constraints shape the rest. D1 is batch-only, so a limit is enforced in the
statement that spends it, never by a read and a later write. And nothing in an isolate's memory is
shared or survives, so a value cached there is stale for as long as that isolate lives, in as many
copies as there are isolates.

## Decision

**Runtime settings are rows.** A `settings` table: the key (primary key), the value as JSON
(checked `json_valid`), when it was set and by whom (`set null` when that member goes). Not
synced: no device reads it. Kept in the nightly export, since a restore that lost them would
quietly open what was closed. The registry (`packages/shared/src/settings.ts`) lists every key with
its kind, its default and its bounds, and one `parseSetting` checks a value for the API, the CLI
and the console alike. A key with no row holds its default; a stored value that no longer parses
(a rule tightened since) reads as the default too.

**A limit is a number or null, and they mean different things.** `null` is no limit. `0` is none
at all: a budget of 0 pauses what it budgets, a daily cap of 0 takes nobody new. An operator who
reaches for "stop" gets stop, never "unlimited". The env vars a setting replaces keep their own old
meaning only as the fallback of a `null` (`translation.backgroundDailyTokens` reads
`LLM_DAILY_BUDGET_TOKENS`, where 0 always meant no limit).

**Read where it is used, never cached.** A statement that enforces a limit embeds the setting as
an SQL expression (`settingSql(key)`: the stored value, else the default, a stored `null`
included), so the value is never older than the statement and costs no round trip of its own. The
few paths that decide in JavaScript (the sign-in gates, the console) read the table as they run
(`readSettings`, `signupState`). No isolate keeps a copy; tela-jobs reads them once per tick.

**Changing one is audited and undoable.** The console's `setting.set` and
`bun run admin set <key> <value>` (through `POST /api/admin/settings`, behind `ADMIN_TOKEN`) write
the same statements: an admin-ledger row, written only when the value changes, and a `RETURNING`
upsert. Its undo puts back what it replaced, the previous value or no row (the default), while
the row still holds what the action wrote. `bun run admin settings` lists what holds now.

**Sign-up is `signup.mode`: `invite` (the default) or `open`.** While `invite`, everything is as
0034 and 0036 say. While `open`:

- **The gate admits a proved address.** `user.create.before` claims an invitation first, in
  either mode: the address's hold or operator invitation at a code sign-in, the carried code at a
  provider's return. Who invited whom stays recorded, and an invited account is never held back by
  the day's cap. Without one, it admits the account only inside the code sign-in or a provider's
  return, for a verified address, the checks 0036 made strict for every endpoint. Outside an
  endpoint (the admin route) it still admits only by the operator's invitation: an open mode does
  not make a missing context permission. The mode is read as the gate runs, so closing sign-up
  refuses a code already mailed.
- **The mail gate mails anyone.** A newcomer is mailed "Welcome to Tela" rather than an
  invitation, with the `join=1` link that asks for a password (0043).
- **A join needs no code.** `POST /api/v1/join {email}` mails the code under the same per-IP and
  per-address limits as a join with one (`joinIp`, `joinAddress`, `otpSend`). A code it carries is
  held as before, and claimed at sign-in. A code everyone has joined with is left behind rather
  than refused, since nothing the joiner can do would fix it; an unknown or revoked one is still
  400 `invalid_code`, so a typo is put right rather than lost. A provider's start treats a code
  the same way. While `invite`, a join with no code is 400 `invalid_code`, before anything is
  counted, as it always was.
- **The sheet asks, every time.** `GET /api/v1/public/auth` says `signup` and `paused`, and the
  browser keeps it a minute, not five. The reader asks as the app starts and as each sheet opens,
  remembers the answer on the device, and follows a refusal at once (a join that sent no code and
  hears `invalid_code` is told a code is needed, and the field comes back). While open, the code
  field shows only for a code a link brought, or while the day is full; nothing says Tela is
  invite-only, and Settings › Invites and the menu's Invite friends go. Members' codes stay
  stored, and work again the day the mode goes back to `invite`.

**A cap on new accounts a day: `signup.maxPerDay`, 200 by default.** A safety net for a night
nobody watches, beside the alert at `alerts.signupsPerDay` (50). Once the UTC day's new accounts
reach it, a join without an invitation waits for the next day: the mail gate sends no code to an
address with no account, the gate refuses `SIGNUPS_PAUSED` (`signups_paused` on a provider's
return), `/api/v1/join` answers 403 `signups_paused`, and the sheet says when joining opens again
in the reader's own time. The join answers that for any address, a member's included: whether Tela
takes anyone new today is public (`paused`), so the answer says nothing of who has an account.
Invitations are never capped. The day's accounts are counted by their profiles
(`accountsTodaySql`), which Tela stamps with its own clock, as better-auth does not stamp
`user.created_at`, and which no account loses, a closed one included.

**Alternatives considered:**

- **Wrangler vars.** A deploy to flip, per Worker, and a var tela-api reads is not one tela-jobs
  reads. The point of the switch is that it does not wait for a deploy.
- **A cache in the isolate, refreshed every minute.** Cheaper by a read, and wrong for up to a
  minute in every isolate separately: a closed sign-up would keep admitting from the isolates that
  had not refreshed. Inline reads cost nothing for a limit, and the gates are rare.
- **Sign-up open by an operator code with a huge number of uses.** 0034's way to open: it admits
  only through the join's code path, so Google and GitHub need the code too, the code leaks into
  every link, and closing means revoking it, which also ends its pending holds. A mode says what is
  meant, and survives being flipped back and forth.
- **The joining sheet's no-code join through the plain code sign-in** (`send-verification-otp`).
  It would skip `joinIp` and `joinAddress`, and answer 200 to a paused day, leaving the joiner
  waiting for a mail that never comes.
- **Counting the cap atomically, as `action_limits` counts.** better-auth writes the user in its
  own statement after the hook, so no reservation can be made in the same statement as the
  account; a reservation spent by a failed create would need giving back. The count overshoots by
  at most the sign-ins racing past it, which a safety net can afford.

## Consequences

- Opening is now: set `signup.mode = open` from the console, then deploy tela-web without the
  noindex var. Closing is the same setting, at once, with no deploy.
- 0036's admitted risk grows while open. Anyone whose Google or GitHub account still lists an
  address as verified can make that address's account without any code now, before its owner
  joins. The notice mailed to the address is still what warns the owner; requiring a mailed code at
  a provider's first sign-in would close it, at the cost a provider is there to save.
- A newcomer who uses Log in's "Email me a code" while open is made a member by that code, and
  lands where a log-in goes, not on Discover; the mail's link still asks for a password.
- A sheet may show the last mode it heard for a moment, or for a minute from the browser's copy.
  The gate decides regardless; the sheet follows any refusal at once.
- Every sheet that opens reads the settings, and while open and capped counts today's profiles,
  which has no index on `created_at` yet: a scan of `profiles`, cheap now, worth an index before
  the table is large.
- The cap counts every new account of the day, invited ones too: invitations are never refused
  by it, but a busy day of them leaves fewer places for anyone else.
- The statements are run on libSQL and D1 by the data contract suite, and tela-api's open join on
  D1 by its workers suite.
