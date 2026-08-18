# eesa-plugin-quickbooks

QuickBooks Online as agent tools for Eesa — all 142 tools from
[Intuit's official MCP server](https://github.com/intuit/quickbooks-online-mcp-server)
(Apache-2.0), ported to run **multi-tenant** behind Eesa's authentication.

Deployed at `qb.plugins.bibekpoudel.com`.

## What changed, and why

The previous version of this plugin ran Intuit's server as a stdio subprocess
behind an HTTP bridge. That works for exactly one company, because Intuit's
server is built for exactly one company:

```ts
// clients/quickbooks-client.ts — Intuit's server, at module load
export const quickbooksClient = new QuickbooksClient({
  refreshToken: process.env.QUICKBOOKS_REFRESH_TOKEN,
  realmId:      process.env.QUICKBOOKS_REALM_ID,
  ...
});
```

Every one of its 142 handlers then calls `QuickbooksClient.getInstance()`. There
is no tenant anywhere in that path — the credential is ambient, read from the
environment once. Correct for a stdio server serving one accountant on their own
laptop. For a hosted service it would mean **every workspace's agent reading and
writing the same company's books**, and no amount of wrapping fixes that from
outside.

So the tools were ported rather than wrapped. The tenant now comes from the
verified Eesa token on each call, the credential is resolved for that tenant,
and there is no ambient default: a call with no tenant cannot reach QuickBooks
at all.

Everything else about the port is faithful. Same 142 tool names, same
parameters, same QuickBooks payload construction — including the parts that
encode hard-won knowledge, like the read-merge-write in `update_bill` that stops
QuickBooks silently stripping line-level class and tax coding.

## Write posture — as deployed

`QUICKBOOKS_DISABLE_WRITE` / `_UPDATE` / `_DELETE` decide the tool surface at
container start: a disabled verb is never registered, so it cannot be called
however it is asked for. All three on is 71 read-only tools.

**As deployed today: write and update are ON, delete is OFF** — set on the
production (`is_preview: false`) env rows in Coolify, which override the image's
defaults of all `true`. They were turned on so the month-end journal-entry sync
can post and revise, against the **sandbox** realm rather than anyone's real
books. Delete has never been enabled and nothing in that sync removes anything.

> **This version adds a second gate, and the sync will break without it.**
> Clearing `QUICKBOOKS_DISABLE_WRITE` is no longer sufficient. A write now also
> requires the caller to resolve to `admin`, and an agent-path call carries no
> user for a role to attach to — so `QUICKBOOKS_AGENT_MAY_WRITE=true` has to be
> set on the same env rows, or every posting attempt is refused with "you do not
> have permission to change anything in QuickBooks". See *Write protection*.

If you change these flags, change this section in the same commit. A README that
claims read-only while the container can post is worse than no README.

## Permissions

`/app` has a **Permissions tab**, visible to QuickBooks admins, listing everyone
in the workspace with a per-person setting:

| Setting | Can |
|---|---|
| **Admin** | read everything, let the agent create/update/delete, and change this page |
| **Reader** | read invoices, bills, contacts and reports |
| **No access** | nothing — refused in chat and in the app |

People come from Eesa (`/api/v1/gateway/tenant-roster/`, gateway-secret authed,
the same call the attendance plugin makes); the assignment is stored here.

**Eesa wins wherever it has an opinion.** The order is: an `appRole` claim →
a granted `quickbooks:admin:write` / `quickbooks:reader:read` permission →
the agent-path rule → this page's assignment → the bootstrap → no access. So
these rows are a fallback for workspaces Eesa has not governed, not a competing
source of truth — which is where the attendance plugin ended up too, having
moved its own membership rows out of the access decision.

### The bootstrap

A workspace admin in Eesa keeps access **while the workspace has no QuickBooks
admin of its own**, so somebody can open the page and appoint one. It closes on
the first admin appointed.

It counts admins rather than members, and that distinction was a bug first:
counting members meant granting the very first person *Reader* access closed the
bootstrap, and the workspace admin lost the page halfway through the task —
leaving one reader and nobody able to administer anything. An admin also cannot
remove or demote their own access, so the last admin cannot strand the workspace
either.

## What is stored

One table, `qb_members`: tenant, user, role. That is all.

**No QuickBooks credential is stored here, and none should be added.** Eesa
already owns per-tenant QuickBooks OAuth —
`apps/marketplace/oauth_connect.py` registers `quickbooks` as a broker provider,
runs the consent flow, holds `{access_token, refresh_token, expires_at,
realm_id}` in the tenant's encrypted `Subscription.configuration`, and persists
Intuit's rotated refresh token. This plugin asks Eesa for a live access token per
call and forgets it on restart.

That is deliberate, and it is the fix for how the previous deployment died.
Intuit rotates the refresh token on nearly every refresh and expires the old one
shortly after. The old bridge wrote the rotated token to a file inside the
container — whose filesystem is recreated on every deploy. The rotated token was
erased, the next boot presented an expired one, and the connection died about a
day later. It stayed dead for weeks, because nothing checks a credential until
something needs it.

A second copy of the token here would reintroduce exactly that class of bug, and
add a rotation race against the platform's own refresh: Intuit invalidates the
previous refresh token on rotation, so whichever copy loses that race is dead.
One copy, in one place, owned by the system that already does this correctly.

### How the credential reaches the plugin

Eesa forwards it with the call. On every tool call `MCPToolExecutor` resolves the
tenant's subscription config — the same dict the OAuth broker writes — and sends
it as `X-Mcp-Tenant-Cred-*` headers alongside the bearer, HMAC-signed with
`X-Mcp-Signature`. This mechanism predates the plugin and its own docstring names
QuickBooks as the case it was built for. **No platform change is needed for the
plugin to get credentials.**

Two settings on the connection row have to be right — `auth_scope` must not be
`NONE`, and the tenant's subscription must be `is_configured`. Both are covered
in [docs/PLATFORM_CONTRACT.md](docs/PLATFORM_CONTRACT.md).

> **One durability wrinkle.** The forwarded `access_token` is passed through as
> stored, not refreshed, and Intuit's expire in about an hour. The plugin
> refreshes in flight as a stopgap, but cannot persist Intuit's rotated refresh
> token — which is the exact failure that killed the previous deployment. The
> one-line platform fix (refresh before forwarding, via the broker's existing
> `get_oauth_access_token`, which already persists rotation) is written out in
> the same document.

## Authentication

Two independent checks on every `/mcp` call, because they answer different
questions:

| Check | Question | Fails closed when |
|---|---|---|
| `X-Eesa-Gateway-Secret` | Did this come through Eesa's broker? | `PLUGIN_GATEWAY_SECRET` unset |
| RS256 bearer via JWKS | Who is calling, for which tenant? | token missing, wrong `aud`/`iss`, or no `tenantId` |

A token alone proves identity but not provenance; anyone able to replay a valid
Eesa token from another surface would otherwise reach a company's books
directly. Both are required.

## Write protection

Two independent gates stand between an agent and a change to someone's
accounting records, and they are controlled by different people:

1. **Deployment** — `QUICKBOOKS_DISABLE_WRITE` / `_UPDATE` / `_DELETE`. These
   unregister the whole class of tools: they never appear in `tools/list` and
   cannot be called by name either. The container is then physically incapable
   of the operation, so a bug in the role gate cannot become a wrong journal
   entry.
2. **Caller** — the role, below. Even with the tools registered, a caller
   resolved as `staff` is refused every mutation.

**The image ships with all three write categories disabled**, and the role gate
defaults to read-only. 71 read tools work regardless. Turn writes on
deliberately, in a change that says so.

### Roles

| Role | May |
|---|---|
| `admin` | read everything, and create/update/delete |
| `staff` | read only |
| `none` | nothing |

Resolved in this order:

1. The `appRole` claim, if Eesa stamped one — including an explicit `none`.
2. `quickbooks:admin:write` or `quickbooks:reader:read` in the token's scopes.
   These are the `permissions` keys from the manifest, which the platform adds
   to a token once a tenant admin has granted them to that user.
3. The agent path (`sub: "gateway"`) → `staff`, or `admin` when
   `QUICKBOOKS_AGENT_MAY_WRITE=true`. There is no user to look up here.
4. This workspace's own assignment, from the Permissions tab.
5. The bootstrap: a platform admin, while no QuickBooks admin exists yet.
6. Otherwise `none`.

Steps 1–3 never touch the database, so a membership-store outage cannot stop the
agent reading QuickBooks in chat — it can only stop someone editing the
Permissions tab.

#### Why `quickbooks:write` in `scopes` is not a grant

The obvious reading is wrong, and getting it wrong would hand every caller
admin. `manifest.scopes` becomes `connection.plugin_scopes`, and
`_execute_external` stamps **that whole list** into every tenant's token:

```python
bearer = mint_plugin_service_token(
    tenant_id=tenant_id,
    audience=connection.slug,
    scopes=list(connection.plugin_scopes or []),   # the manifest's list, verbatim
)
```

So `quickbooks:write` appearing in a token means only "this plugin is one that
writes" — it is a constant, identical for every workspace and every user. The
per-user grant is the three-part `permissions` key (`quickbooks:admin:write`),
which is why the role gate looks for that and ignores the two-part form.
[test/roles.test.js](test/roles.test.js) pins this down.

#### The agent path today

MCP tokens for a self-hosted plugin carry `sub: "gateway"` and **no user
identity** — the platform mints them per *tenant*, and derives `appRole` only
for the attendance plugin. So on the agent path there is currently nobody to
attribute a write to, and the plugin refuses writes rather than pretending
otherwise.

If a deployment is willing to let the agent post to QuickBooks on a tenant's
behalf without a named user, set `QUICKBOOKS_AGENT_MAY_WRITE=true`. It is off by
default, and it does nothing while the deployment gate is closed. When Eesa
starts stamping a per-user QuickBooks `appRole`, rule 1 takes over and this can
be turned back off with no code change.

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness. Touches nothing external, so it answers during boot. |
| `GET /health/config` | none | **Readiness.** Whether this container is configured to reach Eesa at all. |
| `GET /manifest` | none | The plugin manifest. |
| `POST /mcp` | gateway secret + token | JSON-RPC: `initialize`, `tools/list`, `tools/call`, `ping`. |
| `GET /api/me` | token | Role probe. The launcher hides the tile if this fails. |
| `GET /api/status` | token, reader+ | Connection state, role, which gates are open. Never returns a token. |
| `GET /api/tools` | token, reader+ | The tool inventory, so an admin can see what the agent can reach. |
| `GET /api/admin/members` | token, **admin** | The workspace roster merged with assigned access. |
| `POST /api/admin/members` | token, **admin** | Set one person's access (`admin` / `staff` / `none`). |
| `GET /app` | — | Embedded page: Overview, Permissions, Tools. |

## The tools

142, identical in name and parameters to Intuit's server.

| Group | Tools |
|---|---|
| Reads | 71 — `get_*`, `read_*`, `search_*`, and all 11 reports |
| Creates | 25 |
| Updates | 26 |
| Deletes | 20 |

Covering invoices, estimates, customers, vendors, employees, items, the chart of
accounts, bills, purchases, purchase orders, vendor credits, payments, bill
payments, sales receipts, credit memos, refund receipts, deposits, transfers,
journal entries, time activities, classes, departments, terms, payment methods,
budgets, tax codes/rates/agencies, company info, preferences, attachments, and
the eleven financial reports (balance sheet, P&L, cash flow, trial balance,
general ledger, customer sales, A/R and A/P ageing, customer and vendor
balances, vendor expenses).

Source layout mirrors that grouping under [src/tools/](src/tools/); the shapes
that repeat across entities are factories in
[registry.js](src/tools/registry.js), so each module carries only what is
genuinely specific to its entity.

## Deliberate differences from upstream

Each of these is a behaviour change, made because the hosting model changed.

**Tool names are consistently snake_case.** Intuit names eight tools with
hyphens (`create-bill`, `get-vendor`, …) and the other 134 with underscores. We
publish the underscore form and keep the hyphen form working as an unadvertised
alias, so anything written against their docs still resolves.

**Delete tools take one consistent argument.** Upstream varies:
`delete_customer` takes `idOrEntity`, `delete_vendor` takes
`{vendor: {Id, SyncToken}}`, `delete_attachable` takes `{id, sync_token}`. All
of them here take `idOrEntity`, which accepts a bare Id or a full record — a
superset of all three. When given a bare Id, the record is fetched first,
because QuickBooks needs a current `SyncToken` and an agent holding a search
result usually has only the Id.

**`create_attachable` no longer accepts `file_path`.** Upstream runs on the same
machine as the person asking, so a local path is a reasonable thing to say and
it guards one with an allowlist. Here the only filesystem is the container's,
which no user can put a file on — so the parameter could never do anything
useful, and the one thing it *could* do is let a prompt-injected agent probe the
container's own files. `file_url` (SSRF-guarded) and `base64_content` remain.

**`get_invoice_pdf` no longer accepts `output_path`.** Same reason: writing a
tenant's invoice into the container's filesystem helps nobody. It returns base64.

**Search results come back as one JSON array.** Upstream emits one MCP content
block per record, so a 100-invoice search returns 101 blocks.

**Errors are read, not dumped.** Upstream `JSON.stringify`s the whole QuickBooks
fault envelope — realm id, `intuit_tid` trace identifiers and all — into the
tool result. [errors.js](src/errors.js) extracts the message, detail and error
code, adds a sentence of guidance for the common codes (5010 stale SyncToken,
610 not found, 6240 duplicate name), and leaves the trace identifiers in the
server log where they are useful and not exposed.

## Environment

See [.env.example](.env.example). Required: `EESA_JWKS_URL`, `EESA_API_BASE`,
`PLUGIN_GATEWAY_SECRET`, and `DATABASE_URL` for the Permissions tab.

There are no Intuit credentials here. The app id and secret live on the Eesa
server as `QB_OAUTH_CLIENT_ID` / `QB_OAUTH_CLIENT_SECRET`.

Currently set on the production env rows: `QUICKBOOKS_DISABLE_WRITE=false`,
`QUICKBOOKS_DISABLE_UPDATE=false`, `QUICKBOOKS_DISABLE_DELETE=true` — keep
DELETE `true` — plus `QUICKBOOKS_AGENT_MAY_WRITE=true` so the month-end sync can
post. See *Write posture — as deployed*.

```bash
npm run schema           # apply db/schema.sql (idempotent)
```

## Development

```bash
npm install
npm test                 # 52 tests, no network, no database

# The store tests need a real Postgres — the SQL is what is under test.
docker run -d --name qb-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=qbtest \
  -p 55433:5432 postgres:16-alpine
export DATABASE_URL=postgres://postgres:test@127.0.0.1:55433/qbtest PGSSL=disable
npm run schema && npm test   # 59 tests

ALLOW_UNGATED_MCP=1 EESA_JWKS_URL=... npm start
```

The tests check the things that break silently: that all 142 tools are present
and uniquely named, that every schema serialises to JSON Schema without a
dangling `$ref`, that a disabled category is genuinely unreachable rather than
merely hidden, that the SSRF guard blocks the addresses it should, and that
reference objects are built as `{value: "<id>"}` rather than coerced to the
string `"[object Object]"` — which is QuickBooks error 2010, and the reason
account re-parenting breaks when a nested ref meets a scalar coercion map.

## Provenance

Ported from `intuit/quickbooks-online-mcp-server` at commit
`099351858ee696dbbeb00dc7ca8e3a86276d86bb` (Apache-2.0). Behaviour was taken
from the handlers, not from the README; where the two disagreed, the code won.
When re-syncing against a newer upstream, diff `src/tools/` and `src/handlers/`
there against [src/tools/](src/tools/) here — the tool count in
[test/tools.test.js](test/tools.test.js) will fail first if anything was added
or dropped.
