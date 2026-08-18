// Eesa QuickBooks plugin — three surfaces on one container:
//   POST /mcp    MCP JSON-RPC (gateway secret + Eesa token)  -> the agent tools
//   GET  /api/*  status for the embedded UI (Eesa token)
//   GET  /app    embedded admin page (surface="ui")
//
// The plugin is stateless. It stores no QuickBooks credential: per-tenant tokens
// live in Eesa's connections broker and are fetched per call (src/credentials.js).
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { verifyToken, requireGateway } from './auth.js';
import { handleRpc } from './mcp.js';
import * as credentials from './credentials.js';
import * as db from './db.js';
import { fetchRoster, rosterHealth } from './roster.js';
import { toolStats, enabledTools } from './tools/index.js';
import { crudCategory, CRUD } from './tools/registry.js';
import { formatError } from './errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(__dirname, '..', 'manifest.json'), 'utf-8'));
const serverInfo = { name: MANIFEST.slug, version: MANIFEST.version };

const app = express();
app.disable('x-powered-by');
// Keep the raw bytes: Eesa's X-Mcp-Signature is an HMAC over
// `{timestamp}.{body}`, and re-serialising the parsed object would not
// reproduce them byte for byte.
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// The admin page is embedded inside the Eesa shell; allow framing from there only.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "frame-ancestors https://app.eesa.ai https://eesa.ai");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// ---------------------------------------------------------------------------
// Roles
//
// Eesa is authoritative — the plugin never accepts a role from the client. What
// it can learn about a caller depends on which surface called:
//
//   MCP (agent) tokens carry sub="gateway" and NO user identity: the platform
//     mints them per TENANT, and stamps appRole only for the attendance plugin
//     today. So on this path there is currently nobody to attribute a write to.
//
//   UI-session tokens carry a real user, their platform `role`, and sometimes
//     `appRole`.
//
// A NOTE ON SCOPES, because the obvious reading is wrong. `manifest.scopes`
// becomes `connection.plugin_scopes`, and the executor stamps that WHOLE list
// into every tenant's token. It is a declaration of what the plugin can do, not
// a grant to a particular caller — so finding "quickbooks:write" there means
// only "this plugin writes", and treating it as authorisation would hand every
// caller admin. The per-user grant is the `permissions` key
// (quickbooks:admin:write), which the platform adds to a token once a tenant
// admin has granted it.
// ---------------------------------------------------------------------------

/** Deployment-level statement that the agent path may write without a named user. */
const AGENT_MAY_WRITE = process.env.QUICKBOOKS_AGENT_MAY_WRITE === 'true';

/** The agent path: a per-tenant token with sub="gateway" and no user to name. */
const isAgentCall = (ctx) => String(ctx.sub || '') === 'gateway';

/**
 * Resolve the caller's role. Eesa wins wherever it has an opinion; the plugin's
 * own assignments (the permissions page) are the fallback for workspaces Eesa
 * has not governed.
 *
 * Deliberately async, and deliberately does NOT touch the database on the agent
 * path — so a membership-store outage cannot stop the agent reading QuickBooks
 * in chat. It can only stop someone editing the permissions page.
 */
async function effectiveRole(ctx) {
  // 1. An explicit per-user role from Eesa always wins, including "none".
  const claim = String(ctx.raw?.appRole || '').toLowerCase();
  if (claim === 'admin' || claim === 'staff' || claim === 'none') return claim;

  // 2. A granted permission (three-part key). Unlike the declared scopes, this
  //    is present only when a tenant admin granted it to THIS user.
  const scopes = (ctx.scopes || []).map(String);
  if (scopes.includes('quickbooks:admin:write')) return 'admin';
  if (scopes.includes('quickbooks:reader:read')) return 'staff';

  // 3. The agent path. There is no user here to look up — Eesa mints these per
  //    tenant — so the tenant-level decision applies: read, and write only if
  //    the operator has said this deployment's agent may.
  if (isAgentCall(ctx)) return AGENT_MAY_WRITE ? 'admin' : 'staff';

  // 4. This plugin's own assignment, from the permissions page.
  let member = null;
  let storeReachable = true;
  if (db.configured()) {
    try {
      member = await db.getMember(ctx.tenantId, ctx.sub);
    } catch (e) {
      storeReachable = false;
      console.error('[quickbooks] membership lookup failed:', e.message);
    }
  }
  if (member) return member.role;

  // 5. Bootstrap. A platform admin gets access while the workspace has no
  //    QuickBooks ADMIN of its own, so somebody can open the page and appoint
  //    one. It closes on the first admin appointed — not the first member —
  //    because otherwise granting the first person Reader access would strand
  //    the workspace with nobody able to administer it.
  if (String(ctx.role || '').toUpperCase() === 'ADMIN') {
    if (!db.configured() || !storeReachable) return 'admin';
    try {
      if ((await db.adminCount(ctx.tenantId)) === 0) return 'admin';
    } catch {
      return 'admin'; // store unreachable — don't lock the admin out of their own page
    }
  }

  // 6. Assigned nothing, so has nothing.
  return 'none';
}

// ---------------------------------------------------------------------------
// Health and metadata
// ---------------------------------------------------------------------------

// Liveness. Unauthenticated and deliberately not touching Intuit or Eesa, so it
// answers during boot.
app.get('/health', (req, res) => {
  res.json({ ok: true, plugin: MANIFEST.slug, version: MANIFEST.version, tools: toolStats() });
});

// Readiness. Whether this container is CONFIGURED to work — not whether any
// particular tenant has connected, which is a per-tenant question with a
// per-tenant answer. /health stays green with a misconfigured deployment, so
// this is the one worth alerting on.
app.get('/health/config', (req, res) => {
  const checks = {
    eesa_api_base: Boolean(process.env.EESA_API_BASE),
    gateway_secret: Boolean(process.env.PLUGIN_GATEWAY_SECRET),
    jwks_url: Boolean(process.env.EESA_JWKS_URL),
    membership_store: db.configured(),
  };
  const ok = Object.values(checks).every(Boolean);
  res.status(ok ? 200 : 503).json({ ok, checks, database: db.dbHost(), tools: toolStats() });
});

app.get('/manifest', (req, res) => res.json(MANIFEST));

// ---------------------------------------------------------------------------
// MCP surface
// ---------------------------------------------------------------------------
app.post('/mcp', async (req, res) => {
  const body = req.body || {};
  const isNotification = !('id' in body);
  try {
    requireGateway(req);

    // Prove the credential headers were not rewritten between Eesa and here.
    // They decide which company's books get written to, so they are worth more
    // than transport trust when a signing secret is configured.
    const sig = credentials.verifySignature(req);
    if (!sig.ok) {
      const err = new Error(`tenant credential signature rejected: ${sig.reason}`);
      err.status = 403;
      throw err;
    }

    const ctx = await verifyToken(req.get('Authorization'));
    // Role-gate the agent surface too. Without this, a user Eesa set to "none"
    // still reaches every invoice through chat — the permissions page defeated
    // by the back door.
    ctx.role_ = await effectiveRole(ctx);

    // Resolve credentials only for tools/call. tools/list and initialize
    // describe the plugin and must answer for a workspace that has not
    // connected QuickBooks at all.
    if (body.method === 'tools/call') {
      try {
        ctx.qbCredentials = await credentials.resolve(req);
      } catch (e) {
        if (!(e instanceof credentials.NotConnectedError)) throw e;
        // Carried rather than thrown, so the tool layer answers in the shape a
        // tool result has — the agent then relays a sentence the user can act
        // on instead of surfacing a transport error.
        ctx.qbCredentialError = e.message;
      }
    }

    const result = await handleRpc(body, ctx, serverInfo);
    if (isNotification || result === null) return res.status(202).end();
    return res.json({ jsonrpc: '2.0', id: body.id, result });
  } catch (e) {
    if (isNotification) return res.status(202).end();
    return res.status(e.status || 200).json({
      jsonrpc: '2.0',
      id: body.id ?? null,
      error: { code: e.code || -32000, message: e.message },
    });
  }
});

// ---------------------------------------------------------------------------
// REST surface for the embedded UI
// ---------------------------------------------------------------------------

async function authed(req, res, next) {
  try {
    req.ctx = await verifyToken(req.get('Authorization'));
    req.role = await effectiveRole(req.ctx);
    next();
  } catch (e) {
    res.status(e.status || 401).json({ ok: false, error: e.message });
  }
}

/** Verified token + the `admin` role. Everything on the permissions page. */
function adminOnly(req, res, next) {
  if (req.role !== 'admin') {
    return res.status(403).json({
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Only a QuickBooks admin can change who has access.',
      },
    });
  }
  next();
}

/** Reader or better. */
function readerOnly(req, res, next) {
  if (req.role !== 'admin' && req.role !== 'staff') {
    return res.status(403).json({
      ok: false,
      error: {
        code: 'NO_ACCESS',
        message: 'You do not have access to QuickBooks in this workspace. '
          + 'A QuickBooks admin can grant it on the Permissions tab.',
      },
    });
  }
  next();
}

// The Eesa launcher probes this to decide whether to show the app tile, and
// fails CLOSED when it cannot reach it — without this route the tile never
// appears for anyone, whatever their role.
app.get('/api/me', authed, (req, res) => {
  res.json({
    ok: true,
    // null (not the string "none") is what the launcher reads as "no access".
    role: req.role === 'none' ? null : req.role,
    // So the permissions page can find the caller's own row and refuse to let
    // them remove their own access.
    sub: req.ctx.sub,
    plugin: MANIFEST.slug,
  });
});

// Connection status for this tenant, plus what the container will actually let
// the agent do. Never returns a token.
app.get('/api/status', authed, readerOnly, async (req, res) => {
  try {
    // The UI talks to this container directly, so it carries no
    // X-Mcp-Tenant-Cred-* headers — only Eesa's tool-call path does. The plugin
    // therefore cannot see this workspace's connection state from here, and
    // says so rather than guessing or implying it checked.
    const connection = {
      knownHere: false,
      managedBy: 'Eesa',
      message: 'QuickBooks connection status is held by Eesa, not by this plugin. '
        + 'Check or change it under Settings, Integrations.',
    };
    const writesEnabled = {
      create: process.env.QUICKBOOKS_DISABLE_WRITE !== 'true',
      update: process.env.QUICKBOOKS_DISABLE_UPDATE !== 'true',
      delete: process.env.QUICKBOOKS_DISABLE_DELETE !== 'true',
    };
    res.json({
      ok: true,
      data: {
        connection,
        role: req.role,
        canWrite: req.role === 'admin',
        writesEnabled,
        tools: toolStats(),
        connectUrl: `${(process.env.EESA_APP_BASE || 'https://app.eesa.ai').replace(/\/$/, '')}/settings/integrations`,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: formatError(e) });
  }
});

// The tool inventory, so an admin can see exactly what the agent can reach.
app.get('/api/tools', authed, readerOnly, (req, res) => {
  const tools = enabledTools().map((t) => ({
    name: t.name,
    description: t.description,
    category: crudCategory(t.name),
    mutating: crudCategory(t.name) !== CRUD.READ,
  }));
  res.json({ ok: true, data: { tools, stats: toolStats() } });
});

// ---------------------------------------------------------------------------
// Permissions — who in this workspace may use QuickBooks, and how much.
//
// The workspace's people come from Eesa (the roster); the assignment is ours.
// Every row is merged so an admin sees everyone, whether or not they have been
// given access — a page that lists only the people who already have access
// gives you no way to add anybody.
// ---------------------------------------------------------------------------

const ACCESS_LEVELS = ['none', 'staff', 'admin'];

app.get('/api/admin/members', authed, adminOnly, async (req, res) => {
  const tenantId = req.ctx.tenantId;
  try {
    const [roster, members] = await Promise.all([
      fetchRoster(tenantId).catch(() => []),
      db.configured() ? db.listMembers(tenantId) : Promise.resolve([]),
    ]);
    const byRef = new Map(members.map((m) => [String(m.employeeRef), m]));

    const rows = roster.map((u) => {
      const m = byRef.get(String(u.id));
      byRef.delete(String(u.id));
      return {
        employeeRef: String(u.id),
        name: u.name || u.email || String(u.id),
        email: u.email || '',
        platformRole: u.platformRole || '',
        access: m ? m.role : 'none',
        assignedBy: m?.assignedBy || '',
        updatedAt: m?.updatedAt || null,
        // Eesa's own grant overrides whatever is set here. Flagged so the page
        // can say so rather than showing a control that will not take effect.
        managedByEesa: false,
      };
    });

    // Anyone still holding access who is no longer on the roster (left the
    // workspace, or the roster call failed) must still be visible and
    // removable — otherwise their access is invisible and permanent.
    for (const m of byRef.values()) {
      rows.push({
        employeeRef: m.employeeRef,
        name: m.name || m.employeeRef,
        email: m.email || '',
        platformRole: '',
        access: m.role,
        assignedBy: m.assignedBy,
        updatedAt: m.updatedAt,
        managedByEesa: false,
        offRoster: true,
      });
    }

    const admins = rows.filter((m) => m.access === 'admin').length;
    const out = {
      ok: true,
      data: {
        members: rows,
        levels: ACCESS_LEVELS,
        storeConfigured: db.configured(),
        adminCount: admins,
        // While this is 0 the page is reachable only because the caller is a
        // platform admin. Appointing a QuickBooks admin is what makes the
        // workspace's access self-sustaining, so the page says so.
        bootstrap: admins === 0,
      },
    };
    // An empty page is indistinguishable from a broken one — say which.
    if (rows.length === 0) out.data.diag = await rosterHealth(tenantId);
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: formatError(e) });
  }
});

app.post('/api/admin/members', authed, adminOnly, async (req, res) => {
  // Validate the request BEFORE reporting configuration problems, so a caller
  // who sent something wrong is told what, rather than being handed an
  // unrelated deployment complaint.
  const { employeeRef, access, name = '', email = '' } = req.body || {};
  if (!employeeRef) {
    return res.status(400).json({ ok: false, error: 'employeeRef is required' });
  }
  if (!ACCESS_LEVELS.includes(access)) {
    return res.status(400).json({ ok: false, error: `access must be one of ${ACCESS_LEVELS.join(', ')}` });
  }
  // Removing your own admin access would lock the workspace out of this page,
  // and the only way back would be a database edit.
  if (String(employeeRef) === String(req.ctx.sub) && access !== 'admin') {
    return res.status(400).json({
      ok: false,
      error: {
        code: 'LAST_ADMIN',
        message: 'You cannot remove your own admin access. Ask another QuickBooks admin to do it.',
      },
    });
  }
  if (!db.configured()) {
    return res.status(503).json({
      ok: false,
      error: { code: 'NO_STORE', message: 'DATABASE_URL is not set, so access cannot be saved.' },
    });
  }
  try {
    if (access === 'none') {
      await db.removeMember(req.ctx.tenantId, employeeRef);
      return res.json({ ok: true, data: { employeeRef: String(employeeRef), access: 'none' } });
    }
    const saved = await db.upsertMember(req.ctx.tenantId, {
      employeeRef, role: access, name, email, assignedBy: req.ctx.sub,
    });
    res.json({ ok: true, data: { ...saved, access: saved.role } });
  } catch (e) {
    res.status(500).json({ ok: false, error: formatError(e) });
  }
});

// ---------------------------------------------------------------------------
// Embedded UI
// ---------------------------------------------------------------------------
app.get('/app', (req, res) => res.sendFile(join(__dirname, '..', 'public', 'app.html')));

// ---------------------------------------------------------------------------
// Errors
//
// Express's default handler answers a malformed body with an HTML stack trace
// listing /app/node_modules/... — a free map of the dependency tree to anyone
// who POSTs `{`. Answer in the shape the caller expected, keep detail in the log.
// ---------------------------------------------------------------------------
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('unhandled error:', err);
  const message = status === 400 && err.type === 'entity.parse.failed'
    ? 'malformed JSON body'
    : (status >= 500 ? 'internal error' : (err.message || 'request rejected'));
  if (req.path === '/mcp') {
    return res.status(status).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message } });
  }
  res.status(status).json({ ok: false, error: message });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
// Exported so tests can close it; nothing else should touch it.
const server = app.listen(PORT, '0.0.0.0', () => {
  const stats = toolStats();
  console.log(`eesa-plugin-quickbooks listening on :${PORT}`);
  console.log(`  tools: ${stats.enabled}/${stats.total} enabled — ${JSON.stringify(stats.byCategory)}`);
  // Say plainly at boot which switches are on. "Why did the agent refuse to
  // create that invoice" should be answerable from the first ten log lines.
  for (const [label, env] of [
    ['create', 'QUICKBOOKS_DISABLE_WRITE'],
    ['update', 'QUICKBOOKS_DISABLE_UPDATE'],
    ['delete', 'QUICKBOOKS_DISABLE_DELETE'],
  ]) {
    if (process.env[env] === 'true') console.log(`  ${label} tools are DISABLED by ${env}`);
  }
  console.log(
    `  tenant credentials: forwarded by Eesa per call${
      process.env.MCP_SIGNING_SECRET ? ', HMAC-verified' : ' (no MCP_SIGNING_SECRET — signature not checked)'}`,
  );
  if (!credentials.canRefresh()) {
    console.warn(
      '  QUICKBOOKS_CLIENT_ID/SECRET are not set — an expired forwarded access token cannot be '
      + 'renewed in flight, and those calls will ask the workspace to reconnect.',
    );
  }
  if (!db.configured()) {
    console.warn(
      '  DATABASE_URL is not set — the permissions page cannot save. Access then falls back to '
      + "Eesa's own grants, and to platform admins.",
    );
  } else {
    db.ping()
      .then(() => console.log(`  membership store reachable (${db.dbHost()})`))
      // Loud now, rather than as a failed save the first time an admin tries to
      // grant somebody access.
      .catch((e) => console.warn(`  membership store UNREACHABLE (${db.dbHost()}): ${e.message}`));
  }
});

export { app, server, effectiveRole };
