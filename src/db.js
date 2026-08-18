// Membership store — who in a workspace may use QuickBooks, and how much.
//
// This is the ONLY thing the plugin persists. Credentials are not here and must
// not be added: Eesa's connections broker owns those, and a second copy would
// race its refresh-token rotation (see db/schema.sql for why that is fatal
// rather than merely untidy).
//
// Every query is scoped to tenant_id, which comes from the verified Eesa token
// and never from request input.
import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Managed Postgres (Supabase/Neon/RDS) needs SSL; set PGSSL=disable for a
  // plain local or Coolify-hosted database.
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  // Don't let a request queue forever behind a database that isn't answering.
  connectionTimeoutMillis: Number(process.env.PGCONNECT_TIMEOUT_MS) || 8000,
});

// An idle client dying (database restarted, network dropped) makes the pool
// emit 'error'. On an EventEmitter an unhandled 'error' is THROWN, which would
// kill the process over something the next query recovers from on a fresh
// connection.
pool.on('error', (err) => {
  console.error('[quickbooks] idle database client error:', err?.code ? `${err.code} ${err.message}` : err);
});

export function configured() {
  return Boolean(process.env.DATABASE_URL);
}

/** The database host, for diagnostics — parsed so the password is never shown. */
export function dbHost() {
  try {
    return new URL(process.env.DATABASE_URL || '').hostname || '(DATABASE_URL not set)';
  } catch {
    return '(DATABASE_URL unparseable)';
  }
}

async function q(text, params) {
  const r = await pool.query(text, params);
  return r.rows;
}

export const ROLES = ['admin', 'staff'];
const DEFAULT_ROLE = 'staff';

const memberOut = (m) => m && {
  employeeRef: m.employee_ref,
  role: m.role,
  name: m.name,
  email: m.email,
  assignedBy: m.assigned_by || '',
  updatedAt: m.updated_at ? new Date(m.updated_at).toISOString() : null,
};

/** One member, or null when this user has never been given access. */
export async function getMember(tenantId, employeeRef) {
  if (!tenantId || !employeeRef) return null;
  const rows = await q(
    `select * from qb_members where tenant_id = $1 and employee_ref = $2 and active = true`,
    [tenantId, String(employeeRef)],
  );
  return memberOut(rows[0]) || null;
}

/** Everyone with access in this workspace. */
export async function listMembers(tenantId) {
  const rows = await q(
    `select * from qb_members where tenant_id = $1 and active = true order by role desc, name`,
    [tenantId],
  );
  return rows.map(memberOut);
}

/**
 * How many QuickBooks admins this workspace has.
 *
 * Drives the platform-admin bootstrap, and it counts ADMINS rather than members
 * on purpose. Counting members meant that granting the very first person Reader
 * access closed the bootstrap — the platform admin lost the permissions page
 * mid-task, leaving a workspace with one reader and nobody able to administer
 * it. The invariant that matters is "somebody can administer this", so that is
 * what is measured.
 */
export async function adminCount(tenantId) {
  const rows = await q(
    `select count(*)::int as n from qb_members
      where tenant_id = $1 and active = true and role = 'admin'`,
    [tenantId],
  );
  return rows[0].n;
}

export async function upsertMember(tenantId, { employeeRef, role = DEFAULT_ROLE, name = '', email = '', assignedBy = '' }) {
  // Validate against the known set. Passing a caller-supplied string straight
  // into the role column is how "staff" quietly becomes "admin".
  const validRole = ROLES.includes(role) ? role : DEFAULT_ROLE;
  const rows = await q(
    `insert into qb_members (tenant_id, employee_ref, role, name, email, assigned_by, active, updated_at)
     values ($1,$2,$3,$4,$5,$6,true, now())
     on conflict (tenant_id, employee_ref) do update
       set role = excluded.role, name = excluded.name, email = excluded.email,
           assigned_by = excluded.assigned_by, active = true, updated_at = now()
     returning *`,
    [tenantId, String(employeeRef), validRole,
     String(name || '').slice(0, 200), String(email || '').slice(0, 200), String(assignedBy || '')],
  );
  return memberOut(rows[0]);
}

/**
 * Remove someone's access.
 *
 * Deactivates rather than deletes, so "who took this person's access away, and
 * when" is still answerable — the same reason the row carries assigned_by.
 */
export async function removeMember(tenantId, employeeRef) {
  await q(
    `update qb_members set active = false, updated_at = now()
      where tenant_id = $1 and employee_ref = $2`,
    [tenantId, String(employeeRef)],
  );
}

export async function ping() {
  const rows = await q('select 1 as ok', []);
  return rows[0].ok === 1;
}
