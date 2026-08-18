// Per-tenant QuickBooks credentials, delivered by Eesa with the call itself.
//
// HOW THIS WORKS, AND WHY THERE IS NO CALLBACK
//
// Eesa already forwards per-tenant vendor credentials to an MCP plugin. On every
// tool call, `MCPToolExecutor` resolves the tenant's ACTIVE Subscription for
// this plugin's slug (apps/tools_registry/mcp_tenant_auth.py) and forwards its
// `configuration` dict as `X-Mcp-Tenant-Cred-*` headers, HMAC-signed with
// `X-Mcp-Signature`. That configuration dict is the SAME one the OAuth broker
// writes when a workspace connects QuickBooks — realm_id, access_token,
// refresh_token, expires_at.
//
// So the credential arrives in the request. The plugin holds none, asks for
// none, and there is nothing to add on the platform side. (An earlier draft of
// this file called back to a `tenant-credentials` endpoint that would have had
// to be written; it was unnecessary — this mechanism predates it and is already
// shaped for QuickBooks specifically.)
//
// Two conditions on the platform row, both configuration rather than code:
//   * the connection's `auth_scope` must NOT be NONE — that value means "the
//     server holds its own credentials", which is what the OLD single-company
//     gateway was, and it makes the executor skip credential resolution
//     entirely;
//   * the tenant's Subscription must be `is_configured`.
//
// See docs/PLATFORM_CONTRACT.md for the one remaining wrinkle: the forwarded
// access token is passed through as stored, not refreshed.
import crypto from 'node:crypto';
import { formatError } from './errors.js';

const SIGNING_SECRET = process.env.MCP_SIGNING_SECRET || '';
const SIGNATURE_MAX_AGE_SECONDS = 300;

// Intuit's app credentials. Present only so an expired access token can be
// refreshed in-flight; see refreshInline() for why that is a stopgap.
const CLIENT_ID = process.env.QUICKBOOKS_CLIENT_ID || '';
const CLIENT_SECRET = process.env.QUICKBOOKS_CLIENT_SECRET || '';

export class NotConnectedError extends Error {
  constructor(message) {
    super(message);
    this.code = 'NOT_CONNECTED';
  }
}

export const NOT_CONNECTED_MESSAGE =
  'This workspace has not connected a QuickBooks company yet. A workspace admin can '
  + 'connect one under Settings, Integrations in Eesa, then ask again.';

/** Header name for a credential field, matching Eesa's `_field_to_header_name`. */
const credHeader = (field) =>
  'X-Mcp-Tenant-Cred-' + field.split('_').filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join('-');

/**
 * Verify the `X-Mcp-Signature` HMAC over `{timestamp}.{rawBody}`.
 *
 * The gateway secret already proves the call came through Eesa. This proves the
 * CREDENTIAL HEADERS were not rewritten in transit by anything between Eesa and
 * this container — which matters more here than usual, because those headers are
 * the only thing deciding which company's books get written to.
 *
 * Skipped when no signing secret is configured, since the connection may not
 * have one; it is a strengthening, not the primary gate.
 */
export function verifySignature(req) {
  if (!SIGNING_SECRET) return { ok: true, checked: false };

  const signature = req.get('X-Mcp-Signature') || '';
  const timestamp = req.get('X-Mcp-Timestamp') || '';
  if (!signature || !timestamp) {
    return { ok: false, checked: true, reason: 'missing X-Mcp-Signature or X-Mcp-Timestamp' };
  }

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > SIGNATURE_MAX_AGE_SECONDS) {
    // Bounding the age stops a captured request being replayed later with its
    // still-valid signature intact.
    return { ok: false, checked: true, reason: 'signature timestamp outside the allowed window' };
  }

  const raw = req.rawBody ?? Buffer.from('');
  const expected = crypto.createHmac('sha256', SIGNING_SECRET)
    .update(`${timestamp}.${raw.toString('utf8')}`)
    .digest('hex');

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, checked: true, reason: 'signature mismatch' };
  }
  return { ok: true, checked: true };
}

/**
 * Read this tenant's QuickBooks credentials off the request.
 * @returns {null|{accessToken,refreshToken,realmId,environment,expiresAt}}
 */
export function fromRequest(req) {
  const get = (field) => (req.get(credHeader(field)) || '').trim();

  const accessToken = get('access_token');
  const realmId = get('realm_id');
  if (!accessToken || !realmId) return null;

  const expiresAtRaw = Number(get('expires_at'));
  return {
    accessToken,
    refreshToken: get('refresh_token'),
    realmId,
    // The broker does not record which Intuit environment a company lives in,
    // so the deployment says. A sandbox realm against production is a 401 that
    // reads exactly like a bad credential.
    environment: (get('environment') || process.env.QUICKBOOKS_ENVIRONMENT) === 'sandbox'
      ? 'sandbox'
      : 'production',
    // Unix seconds, as the broker writes it. 0 when absent — treated as unknown
    // rather than expired, so a missing field does not break every call.
    expiresAt: Number.isFinite(expiresAtRaw) && expiresAtRaw > 0 ? expiresAtRaw * 1000 : 0,
  };
}

/** True when the forwarded access token is known to have expired. */
export function isExpired(creds, skewMs = 60_000) {
  return Boolean(creds.expiresAt) && creds.expiresAt - skewMs <= Date.now();
}

/**
 * Exchange the forwarded refresh token for a fresh access token.
 *
 * THIS IS A STOPGAP, and the reason is worth understanding before relying on it.
 * Intuit rotates the refresh token roughly daily and retires the previous one
 * shortly after. We can use a rotated token for the current call, but we have
 * nowhere to persist it — the platform holds the stored copy — so the rotation
 * is lost and the stored refresh token eventually goes stale. That is precisely
 * how the previous deployment of this plugin died.
 *
 * The durable fix is one line on the platform: refresh before forwarding, using
 * the broker's existing get_oauth_access_token(), which already persists
 * rotation correctly. See docs/PLATFORM_CONTRACT.md.
 */
export async function refreshInline(creds) {
  if (!creds.refreshToken || !CLIENT_ID || !CLIENT_SECRET) return null;

  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  let res;
  try {
    res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
      }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    console.error('[quickbooks] inline token refresh could not reach Intuit:', e.message);
    return null;
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    console.error(`[quickbooks] inline token refresh refused (HTTP ${res.status} ${body.error || ''})`);
    return null;
  }

  if (body.refresh_token && body.refresh_token !== creds.refreshToken) {
    // Loud, because it is the moment the stored copy silently became stale.
    console.warn(
      '[quickbooks] Intuit ROTATED the refresh token and this plugin cannot persist it — '
      + 'the copy Eesa holds is now the old one. Refresh before forwarding on the platform '
      + 'side (see docs/PLATFORM_CONTRACT.md) or this connection will stop working.',
    );
  }

  return {
    ...creds,
    accessToken: body.access_token,
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    rotatedUnpersisted: Boolean(body.refresh_token && body.refresh_token !== creds.refreshToken),
  };
}

/**
 * The credentials to use for this request, refreshing in flight if the
 * forwarded access token has already expired.
 */
export async function resolve(req) {
  const creds = fromRequest(req);
  if (!creds) throw new NotConnectedError(NOT_CONNECTED_MESSAGE);
  if (!isExpired(creds)) return creds;

  const refreshed = await refreshInline(creds);
  if (refreshed) return refreshed;

  throw new NotConnectedError(
    "The QuickBooks access token Eesa holds for this workspace has expired and could not be "
    + 'renewed. A workspace admin can reconnect QuickBooks under Settings, Integrations.',
  );
}

/** Whether this deployment could refresh an expired token if it had to. */
export function canRefresh() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

export { formatError };
