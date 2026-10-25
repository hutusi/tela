# 0059 — Reports and suspension: members say what is wrong, the operator can stop an account

Status: accepted (2026-10-25). Amends 0039: the console gains a Reports queue and suspending a
member, which it left out because nothing stood behind them. Narrows 0050's abuse gap: a public
blogroll can be reported, and a suspended member's blogrolls leave every page. Amends 0031: a
follow of a member not in good standing is refused, and a follower's device drops it.

## Context

Opening sign-up (0056) lets anyone make a profile, write notes beside recommendations and publish
blogrolls: text of a stranger's on public pages, which the edge caches for every visitor. Until
now the operator heard of a bad one only by chance, and could act only on a blog (Hide) or a
blogroll (Hide from Discover, which leaves its page up). Against a member there was Sign out
everywhere, which ends sessions and changes nothing a visitor sees, and SQL by hand.

## Decision

**What can be reported is what a public page shows.** A profile (its name, bio and picture), a
public blogroll, a blog's page, and a note beside a recommendation: four kinds, each named by a
key (a member's account id, a blogroll's id, a site's id, `<userId>:<articleId>` for a note), and
six reasons (spam, abuse, impersonation, copyright, illegal, other) with up to a thousand
characters of the reporter's own. Only while anyone can see it, by the rules its own page answers
by: a private blogroll, an unlisted blog, a suspended member or a note taken back is a 404.

**Members report from a sheet; visitors write.** `POST /api/v1/reports` is a member call like any
other, twenty a day per member. A visitor has no account to report with, and a form open to
anyone is a spam channel of its own, so their Report is a `mailto:` to the contact address with
the page's address in the body. That link is built from the page's canonical path, never the
address asked for: the edge caches one guest copy of each page for everyone, and nothing about a
member enters it. The app draws the same link over it, and the member's button once it knows a
member is reading.

**One open report per member per thing, and the answer never tells.** A repeat while the first is
open changes nothing and is answered as the first was, so no answer says whether anyone, the
member included, reported it before. Reporters are named to the operator alone, in the report's
record; the member reported is never told who.

**The queue holds things, not reports.** One row per thing reported, however many members did:
the operator decides about a spam profile once. Resolve says it was acted on, Dismiss that there
was nothing to do; either closes every open report of the thing in one audited batch, and its
undo opens them again while each still holds that decision. A later decision on the same thing
stands in the way of undoing an earlier one. The badge counts things waiting.

**The queue acts through the actions that already act.** A report's record offers Hide from
Discover for a blog or a blogroll, and Suspend or Delete account (0058) for its member, each on
the id that action takes, with that action's own confirmation, audit and undo. A report of a note
offers its author's; there is no take-down of one note.

**Suspension is standing, not a deletion.** `member.suspend` sets `profiles.suspended_at` and ends
every session in the same batch; the sign-in hook (0058) refuses the account from then on. It is
refused for an admin (ungrant first, from the command line) and for the operator acting.
`member.unsuspend` clears it. Both move the profile's seq, and both undo while nothing moved since:
undoing a lift ends the sessions made meanwhile; undoing a suspension gives none back.

**One predicate hides a member everywhere public.** `standingOk` (a profile with neither
`suspended_at` nor `deleted_at`) is in every public answer that names a member: the profile page,
Discover's readers and blogrolls, the notes beside a blog's posts and Discover's, the recommenders
a post lists and the counts made of them, a blog's claimant, the front page's edition, follower
and following counts, a picture's address, the Following feed, a blog owner's Dashboard notes, and
a public blogroll's page. A suspended and a closed account are hidden alike, and come back alike
if the column is cleared. Their handle stays taken.

**A follow of someone not in good standing goes, on the device, and comes back.** A new follow of
one is acknowledged and writes nothing. An existing one is sent to the follower's device as
unfollowed, at the time they left, for as long as they are out (the profile's seq move resends
the row); the row itself is untouched, so lifting a suspension gives every follower back on their
next pull, with no write per follow.

## Consequences

- No migration: migration 0014 holds `reports` and the standing columns. `report` joins the action
  limits (20 a day). The console's People area gains a Suspended filter; the shared contract gains
  the `reports` area, `AdminCounts.reports` and `AdminPersonRow.suspendedAt`.
- The protocol stays where it is. Sending a follow as unfollowed is a row every shell already
  reads; a public answer that leaves someone out is one every shell already renders.
- **Caches outlive a suspension by minutes.** A profile, a blogroll and Discover's answers are kept
  five minutes per colo and a minute in a browser (0031); a picture's address is kept longer
  (0032). The 404s arrive within those times, not at once.
- Counters stored on rows (a post's recommendation and like counts, a blog's readers) still count
  a suspended member, as they would count them back if the suspension is lifted; the lists those
  counts summarise leave them out. A closed account's are recounted when it is erased (0058).
- The operator hears of open reports by mail, at most once an hour, from the operator alerts
  (0057).
- A report's `url` is kept as the reporter's browser had it, capped at a thousand characters, for
  the operator only. Reports are in the nightly export. A closed account (0058) keeps its user row
  as an anonymized shell, so its reports keep their reporter's id and lose only the name.
- Deferred: telling a reporter what came of their report, a take-down of one note, and reports of
  a single post's title or excerpt, which are the writer's and reach the operator through the
  blog's own report.
