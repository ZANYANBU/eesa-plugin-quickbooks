// Reading the tenant's QuickBooks credentials off the request Eesa sends.
//
// These headers decide which company's books a call reaches, so the parsing and
// the signature check are worth pinning precisely.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.EESA_JWKS_URL ||= 'https://example.invalid/jwks.json';

let credentials;

before(async () => {
  credentials = await import('../src/credentials.js');
});

/** A stand-in for the Express request, with case-insensitive get(). */
function fakeReq(headers = {}, rawBody = '') {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    get: (name) => lower.get(String(name).toLowerCase()) || undefined,
    rawBody: Buffer.from(rawBody),
  };
}

/** The headers Eesa's build_tenant_credential_headers() actually produces. */
const eesaHeaders = (over = {}) => ({
  'X-Mcp-Tenant-Id': 't_demo',
  'X-Mcp-Tenant-Cred-Realm-Id': '9130354674505161',
  'X-Mcp-Tenant-Cred-Access-Token': 'access-abc',
  'X-Mcp-Tenant-Cred-Refresh-Token': 'refresh-xyz',
  'X-Mcp-Tenant-Cred-Expires-At': String(Math.floor(Date.now() / 1000) + 3000),
  'X-Mcp-Tenant-Cred-Token-Type': 'Bearer',
  'X-Mcp-Tenant-Cred-Connected': 'True',
  ...over,
});

describe('reading forwarded credentials', () => {
  test('parses the headers Eesa sends', () => {
    const c = credentials.fromRequest(fakeReq(eesaHeaders()));
    assert.equal(c.realmId, '9130354674505161');
    assert.equal(c.accessToken, 'access-abc');
    assert.equal(c.refreshToken, 'refresh-xyz');
    assert.equal(c.environment, 'production');
    assert.ok(c.expiresAt > Date.now());
  });

  test('header names follow Eesa\'s snake_case to Kebab-Case rule', () => {
    // Eesa's _field_to_header_name capitalises each underscore-separated part.
    // Getting this wrong reads as "not connected" for every tenant, which looks
    // like an OAuth problem and is not one.
    const c = credentials.fromRequest(fakeReq({
      'x-mcp-tenant-cred-realm-id': '42',
      'x-mcp-tenant-cred-access-token': 'tok',
    }));
    assert.equal(c.realmId, '42', 'header lookup must be case-insensitive');
  });

  test('no credentials at all is null, not a broken object', () => {
    assert.equal(credentials.fromRequest(fakeReq({})), null);
  });

  test('a token with no realm is unusable and refused', () => {
    // Every QBO v3 path is /v3/company/<realmId>/..., so a token without a
    // realm cannot address anything.
    assert.equal(credentials.fromRequest(fakeReq({
      'X-Mcp-Tenant-Cred-Access-Token': 'access-abc',
    })), null);
  });

  test('environment comes from the headers, else the deployment', () => {
    const sandbox = credentials.fromRequest(fakeReq(eesaHeaders({
      'X-Mcp-Tenant-Cred-Environment': 'sandbox',
    })));
    assert.equal(sandbox.environment, 'sandbox');

    const dflt = credentials.fromRequest(fakeReq(eesaHeaders()));
    assert.equal(dflt.environment, 'production');
  });

  test('expiry is understood, and an absent one is not treated as expired', () => {
    const live = credentials.fromRequest(fakeReq(eesaHeaders()));
    assert.equal(credentials.isExpired(live), false);

    const dead = credentials.fromRequest(fakeReq(eesaHeaders({
      'X-Mcp-Tenant-Cred-Expires-At': String(Math.floor(Date.now() / 1000) - 60),
    })));
    assert.equal(credentials.isExpired(dead), true);

    // A missing expires_at means "unknown", and must not fail every call.
    const unknown = credentials.fromRequest(fakeReq(eesaHeaders({
      'X-Mcp-Tenant-Cred-Expires-At': '',
    })));
    assert.equal(unknown.expiresAt, 0);
    assert.equal(credentials.isExpired(unknown), false);
  });

  test('resolve refuses cleanly when nothing was forwarded', async () => {
    await assert.rejects(
      () => credentials.resolve(fakeReq({})),
      (e) => e instanceof credentials.NotConnectedError,
    );
  });
});

describe('credential header signature', () => {
  const BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' });

  function signed(secret, { body = BODY, timestamp = Math.floor(Date.now() / 1000) } = {}) {
    const signature = crypto.createHmac('sha256', secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    return fakeReq({ 'X-Mcp-Signature': signature, 'X-Mcp-Timestamp': String(timestamp) }, body);
  }

  test('is skipped, not failed, when no secret is configured', () => {
    // The connection may not have a signing secret; the gateway secret is the
    // primary gate and this is a strengthening on top of it.
    const r = credentials.verifySignature(fakeReq({}));
    assert.equal(r.ok, true);
    assert.equal(r.checked, false);
  });

  test('accepts a correctly signed request', async () => {
    process.env.MCP_SIGNING_SECRET = 'shhh';
    const mod = await import(`../src/credentials.js?sig=${Date.now()}`);
    try {
      const r = mod.verifySignature(signed('shhh'));
      assert.equal(r.ok, true, r.reason);
      assert.equal(r.checked, true);
    } finally {
      delete process.env.MCP_SIGNING_SECRET;
    }
  });

  test('rejects a wrong signature, a stale one, and a missing one', async () => {
    process.env.MCP_SIGNING_SECRET = 'shhh';
    const mod = await import(`../src/credentials.js?sig=${Date.now()}b`);
    try {
      assert.equal(mod.verifySignature(signed('wrong-key')).ok, false,
        'a signature made with another key must not pass');

      // Bounded age: otherwise a captured request replays forever with its
      // signature still intact.
      const stale = mod.verifySignature(signed('shhh', {
        timestamp: Math.floor(Date.now() / 1000) - 3600,
      }));
      assert.equal(stale.ok, false);
      assert.match(stale.reason, /window/);

      assert.equal(mod.verifySignature(fakeReq({}, BODY)).ok, false,
        'a configured deployment must not accept an unsigned request');

      // A tampered body with an otherwise valid signature.
      const tampered = signed('shhh');
      tampered.rawBody = Buffer.from(BODY.replace('tools/call', 'tools/evil'));
      assert.equal(mod.verifySignature(tampered).ok, false);
    } finally {
      delete process.env.MCP_SIGNING_SECRET;
    }
  });
});
