# Connecting an app

Tela runs a small OAuth 2.1 authorization server for public native clients (RFC 8252): the
authorization code grant with PKCE, and nothing else. There is no client secret, no implicit grant
and no password grant. A desktop app cannot keep a secret, and a member never gives an app their
password.

| | |
|---|---|
| Issuer | `https://api.telaread.com` |
| Metadata (RFC 8414) | `https://api.telaread.com/.well-known/oauth-authorization-server` |
| Authorization endpoint | `https://telaread.com/connect` |
| Token endpoint | `https://api.telaread.com/oauth/token` |
| Revocation endpoint (RFC 7009) | `https://api.telaread.com/oauth/revoke` |
| PKCE | `S256` only, required |
| Scopes | `read` or `write`, and optionally `email` |
| Access token | `tela_at_…`, one hour |
| Refresh token | `tela_rt_…`, swapped on every use, ends after 90 days unused |

The authorization endpoint is on `telaread.com`, not the API host, because it needs the member's
Tela session in their browser.

## Redirect URIs

Your app is registered with one to ten redirect URIs, of two kinds:

- **Loopback**, for desktop apps and command-line tools: `http://127.0.0.1/<path>` or
  `http://[::1]/<path>`. Register it without a port. At run time your app listens on any free
  port and sends that port in `redirect_uri` (`http://127.0.0.1:53682/callback`): a loopback
  redirect matches a registered one on the same host, path and query, on any port (RFC 8252
  §7.3). `localhost` is never accepted, since it can resolve to something other than the loopback
  interface; use the literal address.
- **A private-use scheme**, for apps that cannot listen on a port: a reverse domain name you
  control, then `:/` and a path, such as `com.example.reader:/callback` (RFC 8252 §7.1). It must
  match a registered URI exactly. Another app on the device can claim the same scheme; PKCE is
  what stops it using a code it catches.

`https://` redirects, fragments and credentials in the URI are refused.

## The flow

### 1. Make a verifier, a challenge and a state

```sh
VERIFIER=$(openssl rand -base64 48 | tr -d '=+/\n' | cut -c1-64)
CHALLENGE=$(printf %s "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
STATE=$(openssl rand -hex 16)
```

The verifier is 43 to 128 characters from `A–Z a–z 0–9 - . _ ~`. The challenge is the
unpadded base64url of its SHA-256: always 43 characters. Make a new verifier and state for every
connection.

### 2. Send the member's browser to `/connect`

Open the member's own browser, never a web view inside your app: the member's Tela session is in
their browser, and a web view would let your app see what they type (RFC 8252 §8.12).

```
https://telaread.com/connect
  ?response_type=code
  &client_id=tela_app_…
  &redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2Fcallback
  &scope=write%20email
  &state=<STATE>
  &code_challenge=<CHALLENGE>
  &code_challenge_method=S256
```

- `scope` is space-separated: `read` or `write` (`write` includes read; both is `write`), and
  `email` beside either if you need the address. It must name a level.
- `state` is yours, at most 1,024 characters, and comes back as you sent it.
- Name every parameter once.

The member signs in if they need to, and stays on the page. It shows the account they are signed
in as (with a way to switch), your app's name, developer, homepage and privacy policy, where the
answer goes, the level asked for, the email line when you asked and the operator allows it, and
what no app can do. A draft app says it is not yet approved. The page always asks, even when the
member has connected your app before: a `client_id` is public, so any program on the computer can
use it (RFC 8252 §8.6).

The member may lower `write` to `read`, and may leave the email unticked. What they granted comes
back in the token response's `scope`.

**A request Tela cannot answer is never redirected.** An unknown `client_id`, a `redirect_uri`
that was not registered, a malformed request, a scope Tela does not offer, a draft opened by
anyone but its owner, a cut-off app, or an app at its limit of connected members: the page says
so to the member, and your redirect URI hears nothing. Give up after a while and let the member
try again.

### 3. Receive the answer

The browser is sent to your redirect URI:

```
http://127.0.0.1:53682/callback?code=<CODE>&state=<STATE>&iss=https%3A%2F%2Fapi.telaread.com
```

or, when the member declined:

```
http://127.0.0.1:53682/callback?error=access_denied&state=<STATE>&iss=https%3A%2F%2Fapi.telaread.com
```

Check that `state` is the one you sent and that `iss` is exactly `https://api.telaread.com` (RFC
9207), and drop the answer otherwise. Answer the browser with a short page that says the member
can go back to your app.

Testing by hand with nothing listening on the port, the browser shows a connection error, and the
address bar holds the code. That is enough to try step 4.

### 4. Exchange the code

The code is single-use and lives two minutes.

```sh
curl -s https://api.telaread.com/oauth/token \
  -d grant_type=authorization_code \
  --data-urlencode "code=$CODE" \
  --data-urlencode "redirect_uri=http://127.0.0.1:53682/callback" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "code_verifier=$VERIFIER"
```

The body is `application/x-www-form-urlencoded`, each field once. `redirect_uri` is exactly what
step 2 sent, port included. The answer is never cached (`Cache-Control: no-store`):

```json
{
  "access_token": "tela_at_…",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "tela_rt_…",
  "scope": "write email"
}
```

`scope` is what the member granted: `read` or `write`, and `email` when they let you see it.

A code that comes back a second time, with its verifier, ends the tokens it made: someone else has
seen it.

### 5. Call the API

```sh
curl -s https://api.telaread.com/v1/me -H "Authorization: Bearer $ACCESS"
```

Send the access token in the `Authorization` header, and nowhere else: never in a query string. A
request carrying anything in `Authorization` that is not a Tela access token is refused, and
cookies are dropped. See [v1.md](v1.md).

### 6. Refresh

An access token lasts an hour. Before it runs out, or when a call answers 401 `invalid_token`,
swap the refresh token for a new pair:

```sh
curl -s https://api.telaread.com/oauth/token \
  -d grant_type=refresh_token \
  --data-urlencode "refresh_token=$REFRESH" \
  --data-urlencode "client_id=$CLIENT_ID"
```

The answer has the same shape as step 4. **Store the new refresh token before you use anything
else:** the old one is spent.

- **A lost answer is safe to retry.** If the network fails and you never see the answer, send the
  same refresh token again within two minutes, before using anything else. Tela swaps it once
  more, as long as the pair it gave in the lost answer has not been used.
- **Any other spent refresh token that comes back ends that device's tokens**, both of them, and
  the member has to connect again. It means someone else holds a token your app let go.
- **Refresh one at a time per device.** Two refreshes racing with the same token both get a pair,
  and the first pair stops working.
- A refresh token unused for 90 days ends. Each use starts the 90 days again.
- `invalid_grant` means the refresh token does not work now. Almost always the connection or the
  device has ended (see below), and the member has to connect again. The one exception is an app
  the operator has cut off: its refresh tokens are refused the same way until it is restored, and
  then work again.

### 7. Revoke when the member signs out of your app

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://api.telaread.com/oauth/revoke \
  --data-urlencode "token=$REFRESH" \
  --data-urlencode "client_id=$CLIENT_ID"
```

Either token ends both of that device's tokens. The answer is 200 whether or not anything ended.
The member's connection to your app stays, with any other devices; they disconnect it in Tela's
Settings.

## In an app

```text
connect():
  verifier  = 32+ random bytes, base64url             // 43–128 characters
  challenge = base64url(sha256(verifier))
  state     = 16 random bytes, hex
  listener  = listen on 127.0.0.1, any free port
  redirect  = "http://127.0.0.1:" + listener.port + "/callback"
  open the system browser at
    https://telaread.com/connect?response_type=code&client_id=…&redirect_uri=<redirect>
      &scope=read&state=<state>&code_challenge=<challenge>&code_challenge_method=S256
  request = listener.next_request(timeout: 10 minutes)
  answer the browser: "You can go back to <app> now."
  close the listener
  if request.state != state or request.iss != "https://api.telaread.com": fail
  if request.error == "access_denied": the member declined
  tokens = POST /oauth/token (authorization_code, code, redirect, client_id, verifier)
  keychain.save(account, tokens.refresh_token)
  keep tokens.access_token in memory, with its expiry

call(request):
  if access token expires within a minute: refresh()
  response = send(request, Authorization: Bearer <access>)
  if response.status == 401: refresh(); send once more
  return response

refresh():                                  // one at a time
  old = keychain.load(account)
  answer = POST /oauth/token (refresh_token, old, client_id)
  if no answer (network): retry with the same old token, within two minutes
  if answer.error == "invalid_grant": ask the member to connect again
  keychain.save(account, answer.refresh_token)
```

## Keeping tokens

Keep the refresh token in the operating system's credential store: the macOS Keychain, the
Windows Credential Manager, or the Secret Service (libsecret) on Linux. Never write either token
to a plain file, a log, a crash report, analytics, or a URL. Tokens start with `tela_at_` and
`tela_rt_` so secret scanners can find them if they leak; if one does, revoke it.

Each device that connects gets its own tokens. Never copy tokens from one device to another or
share them between members.

## When a connection ends

A connection ends, and every device's tokens with it, when:

- the member disconnects your app in Settings → Connected apps;
- the member sets, changes or resets their password, links Google or GitHub, or signs out
  everywhere;
- the operator signs the member out, or suspends them;
- the member closes their account;
- the operator ends every connection to your app.

From then on the access token answers 401 `invalid_token` and the refresh token `invalid_grant`.
The member connects again from your app if they want to. What your app stored is still yours to
handle: delete it, or ask the member, as your privacy policy says.

One device's tokens alone end when your app revokes them, when a spent refresh token or code comes
back, or after 90 days unused.

Two things stop your app without ending connections:

- **Your app is cut off** (suspended) by the operator: every access token is refused with 401
  `invalid_token`, and every refresh token with `invalid_grant`, until the app is restored; then
  they work again. Content a device was allowed in the last minute can still load for up to a
  minute. The operator writes to your contact address before or as they do this.
- **The operator stops every app** (`apps.enabled`): every call answers 503 `apps_paused` with
  `Retry-After`. Wait, and keep the tokens.

The operator lowering your app's level, or taking the email away, reaches live tokens at once: a
`write` token then acts as `read`. Settings lists each connection with what it may do, when it was
connected and last used (to the day), and how many devices hold tokens.

## Errors

The token and revocation endpoints answer refusals as RFC 6749 §5.2 does, with `Cache-Control:
no-store`:

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_request` | A field is missing, given twice, or malformed (a verifier of the wrong shape), or the body is not form-encoded |
| 400 | `unsupported_grant_type` | Only `authorization_code` and `refresh_token` exist |
| 400 | `invalid_grant` | The code or refresh token is unknown, spent, expired, for another client or redirect, or its verifier is wrong; or the connection, the app or the member's account can no longer be used. One answer for all of them, on purpose |
| 401 | `invalid_client` | No app has this `client_id` |
| 429 | `rate_limited` | More than 30 token or revocation requests a minute from one IP for your app. Wait `Retry-After` seconds |
| 503 | `apps_paused` | The operator has stopped every app. Wait `Retry-After` seconds |

The consent page's answers to the member (approve or decline) are limited to 30 an hour per
member, which is room to connect and reconnect, not to mint codes.
