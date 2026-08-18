// Role derivation. This is the gate between an agent and someone's accounting
// records, and the subtle part is what must NOT count as a grant.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.EESA_JWKS_URL ||= 'https://example.invalid/jwks.json';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf-8'));

let effectiveRole;
let expressApp;
let httpServer;

before(async () => {
  // server.js calls app.listen() at import; give it a port nothing else wants,
  // and close it afterwards so this file does not hold the run open.
  process.env.PORT = '8123';
  const mod = await import('../src/server.js');
  effectiveRole = mod.effectiveRole;
  expressApp = mod.app;
  httpServer = mod.server;
});

after(async () => {
  // Closing the one open handle, rather than process.exit() — which would kill
  // the whole test run, including the files still executing alongside this one.
  await new Promise((resolve) => httpServer.close(resolve));
});

/** The claim set the platform actually mints for an agent call. */
const agentToken = (extra = {}) => ({
  sub: 'gateway',
  tenantId: 't1',
  scopes: MANIFEST.scopes, // whatever the manifest declares, verbatim
  surface: 'mcp',
  role: '',
  raw: { ...extra },
  ...extra,
});

const uiToken = (extra = {}) => ({
  sub: 'user-42',
  tenantId: 't1',
  scopes: [],
  surface: 'ui',
  role: 'STAFF',
  raw: {},
  ...extra,
});

describe('role derivation', () => {
  test('the declared manifest scopes do NOT grant write', async () => {
    // manifest.scopes becomes connection.plugin_scopes, and the executor stamps
    // that whole list into EVERY tenant's token. It says what the plugin can do,
    // not what this caller may do. Reading it as a grant would hand admin to
    // everyone — which is precisely the bug this test exists to prevent.
    assert.ok(MANIFEST.scopes.includes('quickbooks:write'),
      'manifest should still declare the write scope');
    assert.equal(await effectiveRole(agentToken()), 'staff');
  });

  test('a granted per-user permission does grant write', async () => {
    const ctx = agentToken();
    ctx.scopes = [...MANIFEST.scopes, 'quickbooks:admin:write'];
    assert.equal(await effectiveRole(ctx), 'admin');
  });

  test('appRole from Eesa wins over everything, including "none"', async () => {
    const denied = agentToken();
    denied.scopes = [...MANIFEST.scopes, 'quickbooks:admin:write'];
    denied.raw = { appRole: 'none' };
    assert.equal(await effectiveRole(denied), 'none',
      'an explicit "none" must not be overridden by a scope');

    const reader = agentToken();
    reader.raw = { appRole: 'staff' };
    assert.equal(await effectiveRole(reader), 'staff');

    const admin = agentToken();
    admin.raw = { appRole: 'admin' };
    assert.equal(await effectiveRole(admin), 'admin');
  });

  test('a platform admin can bootstrap the permissions page', async () => {
    // With no membership store configured there is nobody assigned yet, so a
    // platform admin has to get in — otherwise the first admin could never open
    // the page to grant anyone access, including themselves.
    assert.equal(await effectiveRole(uiToken({ role: 'ADMIN' })), 'admin');
  });

  test('an ordinary user with no assignment has no access', async () => {
    // This is the point of having a permissions page: access is granted, not
    // assumed. A user Eesa has said nothing about, and nobody has added, gets
    // nothing.
    assert.equal(await effectiveRole(uiToken({ role: 'STAFF' })), 'none');
  });

  test('a granted reader permission is enough for read access', async () => {
    const ctx = uiToken({ role: 'STAFF' });
    ctx.scopes = ['quickbooks:reader:read'];
    assert.equal(await effectiveRole(ctx), 'staff');
  });

  test('the agent path can be trusted with writes only by explicit opt-in', async () => {
    assert.equal(await effectiveRole(agentToken()), 'staff');
    // The env var is read at import, so this asserts the default rather than
    // re-importing the module; the opt-in path is exercised by the constant.
    assert.notEqual(process.env.QUICKBOOKS_AGENT_MAY_WRITE, 'true',
      'the default must be read-only');
  });

  test('an unknown appRole value falls through rather than being trusted', async () => {
    const ctx = agentToken();
    ctx.raw = { appRole: 'superuser' };
    assert.equal(await effectiveRole(ctx), 'staff');
  });
});

describe('manifest', () => {
  test('declares the surfaces and identity the platform maps', async () => {
    assert.equal(MANIFEST.manifestVersion, '1.0');
    assert.equal(MANIFEST.slug, 'quickbooks');
    assert.equal(MANIFEST.hostedBy, 'self');
    assert.equal(MANIFEST.auth.verify, 'eesa-jwks');
    assert.equal(MANIFEST.auth.gatewayOnly, true);
    assert.equal(MANIFEST.surfaces.mcp.transport, 'streamable-http');
    assert.match(MANIFEST.surfaces.mcp.endpoint, /^https:\/\/.+\/mcp$/);
    assert.match(MANIFEST.surfaces.ui.url, /^https:\/\/.+\/app$/);
    assert.equal(MANIFEST.entitlementKey, 'quickbooks');
  });

  test('version matches package.json, so the listing is not stale', async () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    assert.equal(MANIFEST.version, pkg.version);
  });

  test('permission keys are the three-part form the platform grants', async () => {
    for (const p of MANIFEST.permissions) {
      assert.match(p.key, /^[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_*-]*){2}$/, `${p.key} is not a plugin:role:action key`);
      assert.ok(p.label, `${p.key} has no label`);
    }
    const keys = MANIFEST.permissions.map((p) => p.key);
    assert.ok(keys.includes('quickbooks:admin:write'),
      'the write permission the role gate looks for must be declared');
  });

  test('icon is empty rather than a URL that might not resolve', async () => {
    // The platform's contract: empty is handled and falls back; a dead URL
    // renders as a broken image on every surface that trusts it.
    assert.ok(MANIFEST.icon === '' || /^https:\/\//.test(MANIFEST.icon));
  });

  test('the app exposes the routes the manifest promises', async () => {
    const routes = expressApp._router.stack
      .filter((l) => l.route)
      .map((l) => l.route.path);
    for (const path of [
      '/health', '/manifest', '/mcp', '/api/me', '/api/status', '/api/tools',
      '/api/admin/members', '/app',
    ]) {
      assert.ok(routes.includes(path), `route ${path} is missing`);
    }
  });

  test('the roles it declares are the ones it actually resolves', async () => {
    // A manifest role the code never returns is a promise to a tenant admin
    // that nothing keeps.
    const declared = MANIFEST.roles.map((r) => r.key).sort();
    assert.deepEqual(declared, ['admin', 'staff']);
    for (const role of declared) {
      const ctx = uiToken();
      ctx.raw = { appRole: role };
      assert.equal(await effectiveRole(ctx), role);
    }
  });
});
