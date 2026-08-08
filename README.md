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

## Read-only by default

`QUICKBOOKS_DISABLE_WRITE`, `QUICKBOOKS_DISABLE_UPDATE` and
`QUICKBOOKS_DISABLE_DELETE` are set, so Intuit's server never registers the
`create_*`, `update_*` or `delete_*` tools at all.

This is deliberate defence in depth. Eesa *also* gates QuickBooks writes behind
a four-eyes approval that binds even admins — but that gate is code, and code
has bugs. With these flags the container is physically incapable of mutating
QuickBooks, so a gating bug cannot become a wrong journal entry. Unset them only
when posting is actually being turned on, deliberately, in a single commit that
says so.

## The token problem — read this before changing anything

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

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness. Does not touch Intuit, so it answers during boot. |
| `GET /health/token` | none | **Readiness.** Whether the credential is actually alive. `/health` stays green with a dead token — alert on this one. |
| `POST /` | `Bearer $GATEWAY_TOKEN` | JSON-RPC: `tools/list`, `tools/call`, `ping` |

## Environment

| Var | Notes |
|---|---|
| `QUICKBOOKS_CLIENT_ID` / `QUICKBOOKS_CLIENT_SECRET` | From the Intuit app |
| `QUICKBOOKS_REFRESH_TOKEN` | Bootstrap only — the token store takes over after the first refresh |
| `QUICKBOOKS_REALM_ID` | The company. A sandbox realm with a production environment is a 401 that looks like a credential problem. |
| `QUICKBOOKS_ENVIRONMENT` | `sandbox` or `production` — must match the realm |
| `QUICKBOOKS_DISABLE_WRITE/UPDATE/DELETE` | `true` unless posting is being turned on |
| `GATEWAY_TOKEN` | Shared secret Eesa presents as `Authorization: Bearer` |
| `QB_TOKEN_STORE` | Default `/data/qb-token.json`. Must be on a volume. |
| `GATEWAY_PORT` | Default `8080` |

## Provenance

Intuit's server is **pinned to a commit**, not a branch, and built from source
(`@qboapi/qbo-mcp-server` is not published to npm). This container holds
credentials for a real company's books; "whatever `main` was at build time" is
not acceptable provenance for that. Bump the `QBO_MCP_SHA` build arg
deliberately, and read the diff.
