// The permissions store and the bootstrap rule.
//
// Runs against a real Postgres when DATABASE_URL points at one, and skips
// otherwise — the SQL is the thing under test, so a mock would test nothing.
//
//   docker run -d --name qb-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=qbtest \
//     -p 55433:5432 postgres:16-alpine
//   psql "$DATABASE_URL" -f db/schema.sql
//   DATABASE_URL=postgres://postgres:test@127.0.0.1:55433/qbtest PGSSL=disable npm test
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.EESA_JWKS_URL ||= 'https://example.invalid/jwks.json';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const TENANT = 't_permtest';

let db;

before(async () => {
  db = await import('../src/db.js');
  if (!HAS_DB) return;
  // Fail fast and say what is wrong. Without this, an unreachable database
  // leaves every test hanging until the runner cancels it, and the report reads
  // "test did not finish" — which says nothing about the actual cause.
  try {
    await db.ping();
  } catch (e) {
    throw new Error(
      `DATABASE_URL is set but ${db.dbHost()} is not reachable (${e.message}). `
      + 'Start Postgres and apply db/schema.sql, or unset DATABASE_URL to skip these tests.',
    );
  }
  await db.pool.query('delete from qb_members where tenant_id = $1', [TENANT]);
});

after(async () => {
  if (HAS_DB) {
    await db.pool.query('delete from qb_members where tenant_id = $1', [TENANT]);
    await db.pool.end();
  }
});

describe('membership store', { skip: HAS_DB ? false : 'set DATABASE_URL to run' }, () => {
  test('an unknown user has no membership', async () => {
    assert.equal(await db.getMember(TENANT, 'nobody'), null);
  });

  test('assigning, reading back and re-assigning', async () => {
    await db.upsertMember(TENANT, { employeeRef: 'u1', role: 'staff', name: 'Bo', email: 'bo@x.test', assignedBy: 'admin-1' });
    let m = await db.getMember(TENANT, 'u1');
    assert.equal(m.role, 'staff');
    assert.equal(m.name, 'Bo');
    assert.equal(m.assignedBy, 'admin-1');

    await db.upsertMember(TENANT, { employeeRef: 'u1', role: 'admin', name: 'Bo', assignedBy: 'admin-2' });
    m = await db.getMember(TENANT, 'u1');
    assert.equal(m.role, 'admin', 'a second assignment must replace the first');
    assert.equal(m.assignedBy, 'admin-2');
  });

  test('an unknown role falls back to the least privilege', async () => {
    // Passing a caller-supplied string straight into the column is how "staff"
    // quietly becomes "admin".
    await db.upsertMember(TENANT, { employeeRef: 'u2', role: 'superuser' });
    assert.equal((await db.getMember(TENANT, 'u2')).role, 'staff');
  });

  test('removing access hides the member but keeps the record', async () => {
    await db.upsertMember(TENANT, { employeeRef: 'u3', role: 'staff' });
    await db.removeMember(TENANT, 'u3');
    assert.equal(await db.getMember(TENANT, 'u3'), null);

    const { rows } = await db.pool.query(
      'select active from qb_members where tenant_id = $1 and employee_ref = $2', [TENANT, 'u3'],
    );
    assert.equal(rows.length, 1, 'the row should survive, so who-removed-whom stays answerable');
    assert.equal(rows[0].active, false);
  });

  test('membership is scoped to the tenant', async () => {
    await db.upsertMember(TENANT, { employeeRef: 'shared', role: 'admin' });
    assert.equal(await db.getMember('t_other', 'shared'), null,
      'a member of one workspace must not appear in another');
  });

  test('adminCount counts admins, not members — the bootstrap rule', async () => {
    await db.pool.query('delete from qb_members where tenant_id = $1', [TENANT]);
    assert.equal(await db.adminCount(TENANT), 0);

    // Granting the FIRST person Reader access must not close the bootstrap:
    // doing so stranded the workspace with a reader and nobody able to
    // administer it, because the platform admin lost the page mid-task.
    await db.upsertMember(TENANT, { employeeRef: 'reader', role: 'staff' });
    assert.equal(await db.adminCount(TENANT), 0, 'a reader must not count as an admin');

    await db.upsertMember(TENANT, { employeeRef: 'boss', role: 'admin' });
    assert.equal(await db.adminCount(TENANT), 1);

    // Demoting the only admin reopens the bootstrap rather than stranding it.
    await db.upsertMember(TENANT, { employeeRef: 'boss', role: 'staff' });
    assert.equal(await db.adminCount(TENANT), 0);
  });

  test('listMembers returns only people who still have access', async () => {
    await db.pool.query('delete from qb_members where tenant_id = $1', [TENANT]);
    await db.upsertMember(TENANT, { employeeRef: 'a', role: 'admin', name: 'A' });
    await db.upsertMember(TENANT, { employeeRef: 'b', role: 'staff', name: 'B' });
    await db.upsertMember(TENANT, { employeeRef: 'c', role: 'staff', name: 'C' });
    await db.removeMember(TENANT, 'c');

    const list = await db.listMembers(TENANT);
    assert.deepEqual(list.map((m) => m.employeeRef).sort(), ['a', 'b']);
  });
});

describe('membership store configuration', () => {
  test('reports whether it can persist at all', () => {
    assert.equal(db.configured(), HAS_DB);
  });

  test('the host is reportable without exposing the password', () => {
    const host = db.dbHost();
    assert.equal(typeof host, 'string');
    assert.ok(!host.includes(':'), 'dbHost must not leak credentials');
    if (process.env.DATABASE_URL) {
      assert.ok(!host.includes('@'), 'dbHost must not include userinfo');
    }
  });
});
