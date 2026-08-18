-- Eesa QuickBooks plugin — Postgres schema.
--
-- ONE table, holding who in a workspace may use QuickBooks and how much.
--
-- WHAT IS DELIBERATELY NOT HERE: any QuickBooks credential. Access tokens,
-- refresh tokens and the realm id stay in Eesa's connections broker, which
-- already runs the Intuit consent flow and persists the rotated refresh token.
-- A second copy would race the first — Intuit invalidates the previous refresh
-- token on every rotation, so whichever copy loses that race is permanently
-- dead, which is how the previous version of this plugin died. Role rows have
-- none of those properties: no secrets, nothing that rotates, nothing Intuit
-- knows about.
--
-- Eesa remains authoritative where it has an opinion. These rows are the
-- fallback for workspaces Eesa has not governed with an appRole claim or a
-- granted permission — see effectiveRole() in src/server.js.
--
-- Apply:  psql "$DATABASE_URL" -f db/schema.sql   (idempotent — safe to re-run)

create table if not exists qb_members (
    tenant_id    text not null,                    -- Eesa tenant id, from the verified token
    employee_ref text not null,                    -- Eesa user id (the token `sub`)
    role         text not null default 'staff'
                  check (role in ('admin', 'staff')),
    name         text not null default '',         -- denormalised from the roster, for display
    email        text not null default '',
    assigned_by  text not null default '',         -- Eesa user id of the admin who set it
    active       boolean not null default true,    -- false = access explicitly removed
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    primary key (tenant_id, employee_ref)
);

create index if not exists qb_members_tenant_idx on qb_members (tenant_id) where active;
