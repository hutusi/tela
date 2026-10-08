# 0043 — Password first

Status: accepted (2026-10-08). Supersedes 0036's "with none configured the sheet is the code
alone": the sheet opens on the password, and the code is a press away. The rest of 0036 stands:
four ways in, one gate, a password never set before a code has proved the address.

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
pair; in code mode it stays `email`. Joining is unchanged by this: it always starts with the
invite code and the address, and the code proves the address.

**No memory of the last method.** The sheet does not keep, per device, the way it last signed in.
Sessions last 60 days, so a sign-in is rare, and a member who uses the code presses the toggle
once when it comes.

**A wrong password names the way out.** The one answer for an unknown address, an account with no
password and a wrong one stays one answer (0036); its words now add "No password yet? Choose
*Email me a code instead*", which says nothing about the address and tells a member who never set
one where to go.

## Consequences

- A member who joined by code and never chose a password sees a field they cannot fill, and
  presses the toggle; or tries a password, and is told where the code is. They can add a password
  in Settings → Account, or with *Forgot password?*.
- The code is still always offered and still the way that always works, from anywhere.
