// The workspace's user list, fetched from Eesa server-to-server so the
// permissions page has people to assign access to.
//
// Same endpoint and same trust boundary the attendance plugin uses: gateway-
// secret authed, and the tenant comes from the token we already verified, never
// from the request.
const API_BASE = (process.env.EESA_API_BASE || '').replace(/\/+$/, '');
const GATEWAY_SECRET = process.env.PLUGIN_GATEWAY_SECRET || '';

function rosterUrl(tenantId) {
  return `${API_BASE}/api/v1/gateway/tenant-roster/?tenant=${encodeURIComponent(tenantId)}`;
}

/** @returns {Promise<Array<{id,email,name,platformRole}>>} */
export async function fetchRoster(tenantId) {
  if (!GATEWAY_SECRET || !API_BASE || !tenantId) return [];
  const res = await fetch(rosterUrl(tenantId), {
    headers: { 'X-Eesa-Gateway-Secret': GATEWAY_SECRET, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`roster fetch failed (${res.status})`);
  const data = await res.json();
  return Array.isArray(data.users) ? data.users : [];
}

/**
 * WHY is the roster empty?
 *
 * An empty permissions page is indistinguishable from a broken one, and the
 * three causes need three different fixes — a mismatched secret, a tenant the
 * backend cannot resolve, or a workspace that genuinely has no users. Report
 * which, in words, and never the secret itself.
 *
 * Only called on the empty path, so the normal case costs one request.
 */
export async function rosterHealth(tenantId) {
  const diag = {
    apiBase: API_BASE || null,
    hasSecret: Boolean(GATEWAY_SECRET),
    tenantId: tenantId || null,
    ok: false,
    count: 0,
    status: null,
    error: null,
  };
  if (!API_BASE) {
    diag.error = 'EESA_API_BASE is not set on the plugin service.';
    return diag;
  }
  if (!GATEWAY_SECRET) {
    diag.error = 'PLUGIN_GATEWAY_SECRET is not set on the plugin service.';
    return diag;
  }
  if (!tenantId) {
    diag.error = 'No tenantId in the session token.';
    return diag;
  }
  try {
    const res = await fetch(rosterUrl(tenantId), {
      headers: { 'X-Eesa-Gateway-Secret': GATEWAY_SECRET, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    diag.status = res.status;
    if (!res.ok) {
      diag.error = res.status === 403
        ? 'Eesa rejected the gateway secret — PLUGIN_GATEWAY_SECRET differs between this plugin and the backend, or is unset on the backend.'
        : res.status === 404
          ? 'Eesa could not resolve this workspace from the token tenantId.'
          : `Eesa returned HTTP ${res.status}.`;
      return diag;
    }
    const data = await res.json().catch(() => ({}));
    const users = Array.isArray(data.users) ? data.users : [];
    diag.ok = true;
    diag.count = users.length;
    if (users.length === 0) diag.error = 'Eesa resolved the workspace but it has no users.';
    return diag;
  } catch (e) {
    diag.error = `Could not reach Eesa at ${API_BASE} (${e.message}).`;
    return diag;
  }
}
