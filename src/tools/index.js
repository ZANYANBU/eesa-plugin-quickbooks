// The tool catalogue: every module's tools, gated by configuration and indexed
// by name (and by the legacy names that still resolve).
import invoices from './invoices.js';
import names from './names.js';
import accountsItems from './accounts-items.js';
import salesDocs from './sales-docs.js';
import money from './money.js';
import expenses from './expenses.js';
import ledger from './ledger.js';
import lists from './lists.js';
import company from './company.js';
import attachables from './attachables.js';
import reports from './reports.js';
import { isToolDisabled, inputSchema, crudCategory } from './registry.js';

/** Every tool this plugin knows how to run, before configuration gating. */
export const ALL_TOOLS = [
  ...invoices,
  ...names,
  ...accountsItems,
  ...salesDocs,
  ...money,
  ...expenses,
  ...ledger,
  ...lists,
  ...company,
  ...attachables,
  ...reports,
];

// A duplicate name would mean one tool silently shadowing another, which is the
// kind of thing that is invisible until an agent calls the wrong one against a
// real company's books. Fail at import instead.
{
  const seen = new Set();
  for (const t of ALL_TOOLS) {
    for (const key of [t.name, ...(t.aliases || [])]) {
      if (seen.has(key)) throw new Error(`Duplicate QuickBooks tool name: ${key}`);
      seen.add(key);
    }
  }
}

/**
 * Tools currently enabled.
 *
 * Read fresh rather than computed once at import, because the CRUD gates are
 * environment-driven and the tests flip them. In a deployed container the
 * environment never changes, so this is a filter over ~150 items per call.
 */
export function enabledTools() {
  return ALL_TOOLS.filter((t) => !isToolDisabled(t.name));
}

/** Resolve a requested tool name (or legacy alias) to an enabled tool. */
export function findTool(name) {
  if (!name) return null;
  for (const t of enabledTools()) {
    if (t.name === name || (t.aliases || []).includes(name)) return t;
  }
  return null;
}

/** The `tools/list` payload. Aliases are deliberately not advertised. */
export function listTools() {
  return enabledTools().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: inputSchema(t),
  }));
}

/** Counts for the health endpoint and the admin UI. */
export function toolStats() {
  const enabled = enabledTools();
  const byCategory = {};
  for (const t of enabled) {
    const c = crudCategory(t.name);
    byCategory[c] = (byCategory[c] || 0) + 1;
  }
  return { total: ALL_TOOLS.length, enabled: enabled.length, byCategory };
}
