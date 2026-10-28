# 0067 — Developers register their own apps

Status: accepted (2026-10-28). Amends 0064: an app no longer needs the operator to register and
approve it; any member registers their own, as on GitHub, and the operator's review becomes
optional. The API (0065) and the daily post limit (0066) are unchanged.

## Context

Under 0064, a developer wrote to the operator, who filled in the console's form, approved the app
and sent back a `client_id`. That made the operator the bottleneck for every app. The owner wants
developers to register their own apps, and to keep their own work to optional reviews and handling
reports.

Opening registration to every member also hands each of them a way to put words of their choosing
on Tela's own consent page, in front of other members. The design keeps that useful for real apps
and poor for phishing.

## Decision

**Any member in good standing registers apps in Settings → Developer,** with no account-age rule.
- **What they get:** a `client_id` at once.
- **How an app starts:** in **Testing**, where only its developer can connect it. Once it has a
  privacy policy, they make it **Live** for everyone.
- **Their limits:** up to `apps.perMember` apps (5; admins exempt on the web), registered or
  edited at most 10 times a day.
- **The developer rules** (`docs/api/policy.md`) are accepted at registration (`terms_at`).

**An app Tela has not reviewed:**
- **Members:** at most `apps.unreviewedMaxConnections` (100) connected at once, counted across all
  of one developer's unreviewed apps, so splitting users over several apps doesn't get round it.
  The developer's own connection is free.
- **No email permission,** whatever it asks.
- **On the consent page,** it is shown as "Not reviewed by Tela", with the developer's handle in
  place of the developer name they typed.

**A review** (the console's Apps area, `app.review`) lifts the cap and the email ban, and may grant
the email permission the developer asked for.
- **It is optional.** The queue holds the apps whose developers asked.
- **Changing an app's name, redirects or scope clears its review,** and the developer is warned
  first.

**Only the operator may use the word "Tela"** in an app's name or developer name (`mentionsTela`:
any word starting with it, in any case, after NFKC normalisation). Members don't otherwise have
name rules.

**A developer's standing is their apps'.**
- **Suspended:** their apps answer as a Cut off app does (403 `app_suspended`, refreshes
  `unauthorized_client`, consent `app_unavailable`), and work again when the suspension is lifted.
- **Account closed:** their apps' connections end.

**Members report apps** from the consent page and from Settings → Connected apps (a report target
of its own, `app`). The Reports area offers Cut off and End all connections on the app, and the
member actions on its developer.
- **Delete:** a developer may delete their app, ending its connections. Deleting is refused while
  the app is cut off or has an open report, so it can't be used to escape one and register again.

**The status names stay `draft`, `approved` and `suspended`,** shown as Testing, Live and Cut off,
with `approved` now meaning live.
- **Why:** renaming a value, or adding any table-level CHECK on `apps`, makes drizzle-kit rebuild
  the table. On D1, that `DROP TABLE` cascades through `ON DELETE CASCADE` into every connection,
  token and code. Deferring foreign keys defers checks, never cascades.
- **So:** the new columns are plain (`developer_id` with no foreign key: accounts are closed,
  never deleted), and `owner_user_id` keeps meaning "the account a draft connects for".

**Consent and Connected apps carry `reviewed` and `developerHandle`, so `MIN_CLIENT` goes to 6:**
a protocol-5 shell would show an unreviewed app's own words with no notice.

## Alternatives considered

- **No name rule.** The notice, the handle, the cap and reports carry most of the weight. But
  "Tela Sync wants to read and write your account", on telaread.com, reads as Tela itself. One
  check on one word costs real apps almost nothing.
- **Unreviewed apps usable only by their developer.** That is safer, but every real app would wait
  for the operator again: the bottleneck this removes.
- **An account-age rule before registering.** The owner declined it: sign-up is by invitation,
  and the cap bounds what a new account's app can reach.
- **A new status value (`live`).** It would be clearer, but costs a rebuild that cascades on D1.

## Consequences

- **The operator's work** is the review queue and app reports.
- **API notices** (preview breaks, deprecations) go to every live app's contact address:
  `bun run admin app-contacts` lists them.
- **Rolling tela-api back past this release** drops the cap, the email ban and the standing
  checks. tela-web and tela-api go back together.
