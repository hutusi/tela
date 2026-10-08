# 0043 — Password first

Status: accepted (2026-10-08). Supersedes 0036's "with none configured the sheet is the code
alone": the sheet opens on the password, and the code is a press away. Supersedes 0036's optional
password at join: joining by email chooses one. The rest of 0036 stands: four ways in, one gate,
a password never set before a code has proved the address.

## Context

0036 added passwords because a code costs a trip to the mailbox at every sign-in, and qq.com and
163.com sometimes deliver slowly. The sheet still opened on the code, with *Log in with a
password* as a toggle under the button. So the method meant to save the trip cost a press first,
and a password manager found no password field to fill when the sheet opened: it fills the fields
a form shows, not the ones a toggle would show. Mainland readers, who cannot reach Google, have
the code and the password and nothing else.

## Decision

**Log in opens on the address and the password.** The button is *Log in*, *Forgot password?*
sits under the password, and the toggle under the button reads *Email me a code instead*. In
password mode the address field is `autocomplete="username"`, so a password manager offers the
pair; in code mode it stays `email`. Joining still starts with the invite code and the address,
and the code still proves the address.

**No memory of the last method.** The sheet does not keep, per device, the way it last signed in.
Sessions last 60 days, so a sign-in is rare, and a member who uses the code presses the toggle
once when it comes.

**Joining by email chooses a password.** A sheet that opens on the password serves only members
who have one, and a member who joined by code without one would meet the toggle at every sign-in.
So the join's code step asks for the password beside the code, no longer "(optional)", and
continues only with one of 10 characters or more. The mail's link does the same: a first sign-in's
code (an address joining with an invite, or an account the operator made that has not signed in)
is mailed with `/login?email=…&otp=…&join=1`, and that link names the address, asks for the
password and goes on to Discover, under *Join Tela*. The password is saved after the code's
sign-in, as before, on the session it made; a save that fails still says so and lets the member
in.

The requirement is the form's, not the server's, and `join=1` is a hint to the page that protects
nothing: the code's sign-in makes the account before the password can be saved, and D1 has no
transaction to hold the two together. Nothing about the gate or the code changes.

**A wrong password names the way out.** The one answer for an unknown address, an account with no
password and a wrong one stays one answer (0036); its words now add "No password yet? Choose
*Email me a code instead*", which says nothing about the address and tells a member who never set
one where to go.

## Consequences

- A member who joined by code before this and never chose a password sees a field they cannot
  fill, and presses the toggle; or tries a password, and is told where the code is. They can add
  a password in Settings → Account, or with *Forgot password?*.
- Some accounts still have no password, by design or by a gap:
  - Google and GitHub make accounts without one; their members sign in with the provider.
  - An invited address that asks the Log in form for a fresh code, instead of joining or opening
    its mail's link, signs in at a code step that cannot tell a first sign-in from any other
    without saying who has an account.
  - A save that failed after the account was made.
- Joining takes one more field, once, at the moment a visitor is deciding whether to stay. The
  trade is a password manager's fill at every later sign-in, and no mail to wait for.
- The code is still always offered and still the way that always works, from anywhere.
