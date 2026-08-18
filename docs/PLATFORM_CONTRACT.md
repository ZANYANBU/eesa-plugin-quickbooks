# What this plugin needs from Eesa

Short answer: **nothing new in the core.** The per-tenant credential path already
exists and is already shaped for QuickBooks. What follows is what it is, the two
configuration values it depends on, and the one durability wrinkle worth a
one-line change.

> An earlier draft of this document specified a new `tenant-credentials`
> endpoint. That was wrong. It was written after reading only
> `_execute_external`'s bearer logic, where the Eesa service token and the vendor
> OAuth token are indeed either/or — and concluding, incorrectly, that the vendor
> credential therefore had no route to a self-hosted plugin. It has a different
> route, described below. No endpoint is needed.

## How the credential arrives

`apps/tools_registry/mcp_tenant_auth.py` exists to answer exactly this — its own
docstring opens with "which QuickBooks company id + OAuth tokens to use". On
every tool call, `MCPToolExecutor`:

1. resolves the tenant's ACTIVE marketplace `Subscription` whose product slug
   matches the connection slug (`resolve_tenant_credentials`);
2. takes that subscription's `configuration` dict — the **same dict the OAuth
   broker writes** when a workspace connects QuickBooks, holding `realm_id`,
   `access_token`, `refresh_token`, `expires_at`;
3. forwards it as `X-Mcp-Tenant-Cred-*` headers
   (`build_tenant_credential_headers`), plus `X-Mcp-Tenant-Id`;
4. signs the request with `X-Mcp-Signature` (HMAC-SHA256 over
   `{timestamp}.{body}`) when the connection has a signing secret.

Crucially this is passed **alongside** the bearer, not instead of it:

```python
client.call_tool(tool.name, args, tenant_context=tenant_context, bearer_token=bearer)
```

So a self-hosted plugin gets both: an Eesa service token that says *who is
calling and for which tenant*, and the tenant's QuickBooks credentials in the
headers. The plugin reads them in [src/credentials.js](../src/credentials.js).

## The two things to get right on the connection row

Both are configuration, not code:

| Setting | Required value | If wrong |
|---|---|---|
| `auth_scope` | anything except `NONE` | `NONE` means "the server holds its own credentials" — which is what the OLD single-company gateway was. The executor then skips credential resolution entirely and every call arrives with no credentials. |
| Subscription `is_configured` | true | `resolve_tenant_credentials` raises `MCPSubscriptionNotConfigured` and the tool call fails before any HTTP. |

The subscription is the one the OAuth broker already creates or reuses when a
workspace connects QuickBooks (`oauth_callback` upserts it and sets it ACTIVE),
so in practice connecting the company is what makes this work.

Set `MCP_SIGNING_SECRET` on the plugin to the connection's signing secret and
the credential headers are HMAC-verified too. Without it the plugin still checks
the gateway secret; the signature is a strengthening, not the primary gate.

## The one real wrinkle: the forwarded token is not refreshed

`resolve_tenant_credentials` reads `sub.configuration` **raw**. It does not call
the broker's `get_oauth_access_token`, so the `access_token` it forwards is
whatever was last stored — and Intuit's access tokens expire in about an hour.

Nothing else refreshes it for a self-hosted plugin either: `bearer_for_connection`
(which does refresh, via `get_oauth_access_token`) only runs for connections that
are *not* `hosted_by="self"`.

So roughly an hour after a workspace connects, the forwarded token is stale.

**What the plugin does about it today.** If `QUICKBOOKS_CLIENT_ID` and
`QUICKBOOKS_CLIENT_SECRET` are set, it refreshes in flight with the forwarded
refresh token and uses the result for that call. That works, but it is a stopgap
and the reason matters: Intuit **rotates** the refresh token roughly daily and
retires the old one shortly after. The plugin has nowhere to persist a rotated
token — the platform holds the stored copy — so the rotation is lost and the
stored refresh token eventually goes stale. **That is precisely how the previous
deployment of this plugin died.** The plugin logs loudly the moment it sees a
rotation it cannot persist.

**The durable fix, one line.** Refresh before forwarding, using the broker
function that already persists rotation correctly (`get_oauth_access_token`
explicitly keeps the rotated refresh token — the comment there says so, and cites
this same QuickBooks outage). In `resolve_tenant_credentials`, after loading
`sub`:

```python
# Vendor OAuth configs carry a short-lived access_token. Hand the caller a live
# one, and let the broker persist any rotation, rather than forwarding whatever
# was last written and making every plugin invent its own refresh.
from apps.marketplace.oauth_connect import provider_for_slug, get_oauth_access_token

provider = provider_for_slug(mcp_slug)
config = dict(sub.configuration or {})
if provider:
    fresh = get_oauth_access_token(sub.tenant, provider)
    if fresh:
        config["access_token"] = fresh
        # get_oauth_access_token persists the rotated refresh token and the new
        # expiry, so re-read rather than keeping the pre-refresh values.
        config.update({
            k: v for k, v in (Subscription.objects
                              .filter(pk=sub.pk)
                              .values_list("configuration", flat=True)
                              .first() or {}).items()
            if k in ("refresh_token", "expires_at")
        })

return TenantCredentialContext(tenant_id=str(tenant_id), credentials=config)
```

This benefits every broker-backed plugin, not just this one, and removes the
plugin's need for `QUICKBOOKS_CLIENT_ID`/`SECRET` entirely.

Until it lands, set those two variables on the plugin so the stopgap works, and
watch the logs for the rotation warning.

## Registration

```bash
curl -X POST https://eesa.ai/api/v1/tools/plugins/register/ \
  -H "Authorization: Bearer <super-admin JWT>" \
  -H "Content-Type: application/json" \
  --data @manifest.json
```

Then, per tenant:

1. Grant the `quickbooks` entitlement.
2. Check the connection's `auth_scope` is not `NONE` (see the table above).
3. The workspace admin connects their company under Settings, Integrations —
   the existing broker flow, unchanged.
4. Optionally grant `quickbooks:admin:write` to the users whose agent may post
   to QuickBooks. See the write-protection section of the README; it is one of
   three independent gates.
