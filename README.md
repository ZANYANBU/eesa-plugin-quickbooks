# eesa-plugin-quickbooks

QuickBooks Online as agent tools for Eesa, wrapping **Intuit's official MCP server**
([intuit/quickbooks-online-mcp-server](https://github.com/intuit/quickbooks-online-mcp-server),
Apache-2.0) in a thin HTTP bridge.

Deployed at `qb.plugins.bibekpoudel.com`.

## Why a bridge exists

Eesa's `MCPClient` speaks stateless JSON-RPC over HTTP POST
(`{jsonrpc, id, method, params}`) with no MCP initialize/session/SSE handshake.
Intuit's server speaks stdio MCP. `gateway/gateway.mjs` holds one persistent
stdio session and maps `tools/list` and `tools/call` onto it.

## Write posture — currently WRITE + UPDATE enabled

`QUICKBOOKS_DISABLE_WRITE`, `QUICKBOOKS_DISABLE_UPDATE` and
`QUICKBOOKS_DISABLE_DELETE` decide the tool surface at container start. Intuit's
server never *registers* a disabled verb, so it cannot be called however it is
asked for. All three on is 70 read-only tools; write and update on is 121.

This is defence in depth, and it is the reason the flags exist. Eesa *also*
gates QuickBooks writes behind a four-eyes approval that binds even admins — but
that gate is code, and code has bugs. With a flag set the container is
physically incapable of that mutation, so a gating bug cannot become a wrong
journal entry.

**As deployed today: write and update are ON, delete is OFF.** They were turned
on so the Chups month-end sync (`manage.py qb_post_month`) can post and revise
journal entries, and they are pointed at the **sandbox** realm, not Chups Inc's
real books. Delete has never been enabled and there is no reason to enable it —
nothing in the sync removes anything.

To put it back to read-only, set `QUICKBOOKS_DISABLE_WRITE=true` and
`QUICKBOOKS_DISABLE_UPDATE=true` on the *production* (`is_preview: false`) env
rows in Coolify and redeploy. Note the deploy rebuilds the whole image (~6 min,
it recompiles Intuit's server from source) and the container only swaps at the
very end — a tool count read mid-deploy is the *old* container's answer.

If you change these flags, change this section and `manifest.json` in the same
commit. A manifest that claims read-only while the container can post is worse
than no manifest.

## The token problem — read this before changing anything

### The two-refresher bug (fixed 19 Aug 2026)

Symptom: `tools/list` returns all its tools and the container looks healthy, but
every `tools/call` comes back with
`Error: listen EADDRINUSE: address already in use :::8000` — and, because of how
Intuit's server reports failures, with `isError: false`.

That port is Intuit's **interactive OAuth callback server**
(`src/clients/quickbooks-client.ts`). It only starts when the client has given
up on refreshing and wants a human at a browser. So the message is not really
about a port; it means *auth is dead*.

Cause: both halves managed the same rotating credential. This gateway refreshed
and persisted it, and Intuit's client refreshed it too, writing to `/app/.env`.
Whichever rotated second invalidated the other's copy. Worse, a child is spawned
with a **snapshot** of `process.env`, so rotating here never reached a running
child. It stayed working for about an hour on the child's access token, then
died — which is why it always looked fine right after a deploy.

Fix: exactly one component rotates the token. The gateway refreshes every 45
minutes — inside the ~60-minute access-token lifetime, so the child never
reaches the point of refreshing itself — and drops the child whenever the token
rotates, so the next call respawns it with the new one.

If you ever see EADDRINUSE :8000 again, do not go looking for a port conflict.
Check whether something else has rotated the refresh token.

### The original problem

Intuit rotates the refresh token on roughly every refresh and expires the old
one shortly after. A long-lived server holds the rotated value only in memory,
so a restart boots with whatever is in the environment.

**The previous deployment of this rewrote its own `.env` file.** That works on a
box with a disk. In a container the filesystem is recreated on every deploy, so
the rotated token was erased, the next boot presented an expired one, and the
connection died about a day later. It stayed dead for weeks, because nothing
checks a credential until something needs it.

So: the token is written to `QB_TOKEN_STORE` (default `/data/qb-token.json`),
written via write-then-rename so a crash cannot truncate it, and **the file wins
over the environment variable on boot** because the file is the one kept
current.

> **`/data` must be a mounted volume.** Without one this is the old bug wearing
> a new hat. `GET /health/token` reports `store_present` — if that is `false`
> after a deploy, the volume is missing.


## Connecting a company (and why this is not the localhost flow)

`GET /oauth/start?key=$QB_CONNECT_TOKEN` sends the person to Intuit;
`GET /oauth/callback` takes the code, exchanges it, and writes the refresh
token straight into the token store. The plugin does this itself for a reason
that only appears in production: **Intuit requires redirect URIs to be HTTPS
for production keys** and permits `http://localhost` only on development ones.
The localhost flow that works against a sandbox cannot be used on real books.

Doing it here also means the refresh token never travels — it is written into
the only container that reads it, rather than being handed across a system
boundary.

Register the callback on the Intuit app, under the keys you are using:

    https://<this service>/oauth/callback

Set `QB_CONNECT_TOKEN` to a secret of your choosing, `QB_OAUTH_REDIRECT_URI` if
the public domain is not what Railway reports, and open
`/oauth/start?key=…` **as the company's primary or company admin** — no other
QuickBooks role can connect an app at all.

⚠️ Sandbox and production are different apps with different keys, and a sandbox
realm with `QUICKBOOKS_ENVIRONMENT=production` is a 401 that reads like a
credential problem.

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness. Does not touch Intuit, so it answers during boot. |
| `GET /health/token` | none | **Readiness.** Whether the credential is actually alive. `/health` stays green with a dead token — alert on this one. |
| `POST /` | `Bearer $GATEWAY_TOKEN` | JSON-RPC: `tools/list`, `tools/call`, `ping` |
| `GET /app` | none | The embedded UI. Static, holds no data; framed by Eesa. |
| `GET /oauth/start` | `?key=$QB_CONNECT_TOKEN` | Begin connecting a company. |
| `GET /oauth/callback` | Intuit | Stores the refresh token. Register this URL. |

## Environment

| Var | Notes |
|---|---|
| `QUICKBOOKS_CLIENT_ID` / `QUICKBOOKS_CLIENT_SECRET` | From the Intuit app |
| `QUICKBOOKS_REFRESH_TOKEN` | Bootstrap only — the token store takes over after the first refresh |
| `QUICKBOOKS_REALM_ID` | The company. A sandbox realm with a production environment is a 401 that looks like a credential problem. |
| `QUICKBOOKS_ENVIRONMENT` | `sandbox` or `production` — must match the realm |
| `QUICKBOOKS_DISABLE_WRITE/UPDATE/DELETE` | Currently `false`/`false`/`true` — see *Write posture*. Keep DELETE `true`. |
| `GATEWAY_TOKEN` | Shared secret Eesa presents as `Authorization: Bearer` |
| `QB_TOKEN_STORE` | Default `/data/qb-token.json`. Must be on a volume. |
| `GATEWAY_PORT` | Default `8080` |

## Provenance

Intuit's server is **pinned to a commit**, not a branch, and built from source
(`@qboapi/qbo-mcp-server` is not published to npm). This container holds
credentials for a real company's books; "whatever `main` was at build time" is
not acceptable provenance for that. Bump the `QBO_MCP_SHA` build arg
deliberately, and read the diff.
