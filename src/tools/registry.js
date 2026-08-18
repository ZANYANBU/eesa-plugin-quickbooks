// Tool registry — definition shape, CRUD gating, and factories for the shapes
// that repeat across QuickBooks' entities.
//
// Intuit's server ships 142 tools as 284 files: one `*.tool.ts` holding a zod
// schema and a response formatter, one `*.handler.ts` holding a promisified
// node-quickbooks call. The overwhelming majority of both are identical apart
// from a noun — `getAccount`/`getCustomer`/`getBill` differ only in the method
// name and the word in the error message.
//
// Every tool is still here, with its name, description, schema and behaviour
// intact. What is gone is the copy: the repeating shapes became the factories
// below, so the entity modules carry only what is genuinely per-entity — which
// is where the real QuickBooks knowledge lives (payload mapping, sparse-vs-full
// update rules, the fields that must survive a round trip).
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { formatError, logError } from '../errors.js';
import { buildQuickbooksSearchCriteria } from '../criteria.js';
import * as qbo from '../qbo.js';

// ---------------------------------------------------------------------------
// CRUD categories and the environment gates that disable them.
// Ported verbatim in behaviour from helpers/register-tool.ts — a disabled tool
// is not registered at all, so it never appears in tools/list and cannot be
// called by name either.
// ---------------------------------------------------------------------------

export const CRUD = { WRITE: 'WRITE', UPDATE: 'UPDATE', DELETE: 'DELETE', READ: 'READ' };

const DISABLE_ENV = {
  [CRUD.WRITE]: 'QUICKBOOKS_DISABLE_WRITE',
  [CRUD.UPDATE]: 'QUICKBOOKS_DISABLE_UPDATE',
  [CRUD.DELETE]: 'QUICKBOOKS_DISABLE_DELETE',
};

const PREFIX_CATEGORY = [
  ['create_', CRUD.WRITE], ['create-', CRUD.WRITE],
  ['update_', CRUD.UPDATE], ['update-', CRUD.UPDATE],
  ['delete_', CRUD.DELETE], ['delete-', CRUD.DELETE],
];

/** Category of a tool from its name prefix; anything unprefixed is a READ. */
export function crudCategory(toolName) {
  for (const [prefix, category] of PREFIX_CATEGORY) {
    if (toolName.startsWith(prefix)) return category;
  }
  return CRUD.READ;
}

/**
 * Is this tool switched off by configuration?
 *
 * Reads the environment on every call rather than caching at import, so the
 * unit tests can flip a gate without reloading the module graph. READ tools can
 * never be disabled this way.
 */
export function isToolDisabled(toolName) {
  const category = crudCategory(toolName);
  if (category === CRUD.READ) return false;
  return process.env[DISABLE_ENV[category]] === 'true';
}

/** Tools that change the books require the `admin` app role, never `staff`. */
export function isMutating(toolName) {
  return crudCategory(toolName) !== CRUD.READ;
}

// ---------------------------------------------------------------------------
// Definition + result helpers
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ToolDef
 * @property {string}   name
 * @property {string}   description
 * @property {import('zod').ZodType} schema
 * @property {string[]} [aliases]  Legacy names that still resolve to this tool.
 * @property {string}   [label]    Lead line on a successful result.
 * @property {(ctx: object, params: object) => Promise<any>} run
 */

/** @param {ToolDef} def @returns {ToolDef} */
export function tool(def) {
  if (!def.name) throw new Error('tool() requires a name');
  if (!def.description) throw new Error(`tool ${def.name} requires a description`);
  if (!def.schema) throw new Error(`tool ${def.name} requires a schema`);
  if (typeof def.run !== 'function') throw new Error(`tool ${def.name} requires run()`);
  return { aliases: [], ...def, category: def.category || crudCategory(def.name) };
}

/** MCP inputSchema for a tool. */
export function inputSchema(def) {
  // $refStrategy 'none' inlines everything. Upstream hit "deep $ref issues" with
  // nested schemas and worked around them by degrading several tools to
  // `z.any()`; inlining fixes the cause, so those tools keep real schemas here.
  const json = zodToJsonSchema(def.schema, { $refStrategy: 'none', target: 'jsonSchema7' });
  delete json.$schema;
  return json;
}

export const EMPTY = z.object({});

// ---------------------------------------------------------------------------
// Calling QuickBooks
// ---------------------------------------------------------------------------

/**
 * Run a node-quickbooks method for the calling tenant.
 * The credentials ride on `ctx`, forwarded by Eesa with the request.
 */
export async function qb(ctx, method, ...args) {
  return qbo.withClient(ctx, (client) => qbo.call(client, method, ...args));
}

/** Read the array out of a QBO QueryResponse, tolerating count-only replies. */
export function queryRows(result, entity) {
  const qr = result?.QueryResponse;
  if (!qr) return [];
  const rows = qr[entity];
  if (Array.isArray(rows)) return rows;
  if (rows) return [rows];
  // `count: true` searches answer with a number instead of rows. Upstream
  // surfaces it, so preserve that rather than reporting zero results.
  if (typeof qr.totalCount === 'number') return qr.totalCount;
  return [];
}

// ---------------------------------------------------------------------------
// Factories for the repeating CRUD shapes
// ---------------------------------------------------------------------------

/** `get_x` / `read_x` — fetch one record by id. */
export function getById({ name, description, method, label, idField = 'id', aliases = [] }) {
  return tool({
    name,
    description,
    aliases,
    label,
    schema: z.object({
      [idField]: z.string().min(1).describe('The QuickBooks record Id.'),
    }),
    run: (ctx, p) => qb(ctx, method, String(p[idField])),
  });
}

/**
 * `search_x` where the tool exposes named filters that map to a plain criteria
 * object (e.g. search_classes: name/active/limit -> {Name, Active, limit}).
 */
export function searchByFields({ name, description, method, entity, schema, map, label, aliases = [] }) {
  return tool({
    name,
    description,
    aliases,
    label,
    schema,
    run: async (ctx, p) => queryRows(await qb(ctx, method, map(p)), entity),
  });
}

/**
 * `search_x` where the named filters become an ARRAY of {field,value,operator}
 * criteria — the shape node-quickbooks needs for range and comparison filters
 * (e.g. TxnDate >= / <=).
 */
export function searchByOperators({ name, description, method, entity, schema, filters, label, aliases = [] }) {
  return tool({
    name,
    description,
    aliases,
    label,
    schema,
    run: async (ctx, p) => {
      const criteria = [];
      for (const [key, field, operator] of filters) {
        if (p[key] !== undefined && p[key] !== null && p[key] !== '') {
          criteria.push(operator ? { field, value: p[key], operator } : { field, value: p[key] });
        }
      }
      if (p.limit) criteria.push({ field: 'limit', value: p.limit });
      return queryRows(await qb(ctx, method, criteria), entity);
    },
  });
}

/**
 * `search_x` that takes a free-form `criteria` blob (object, array, or the
 * advanced {filters,asc,desc,limit,...} form) and passes it through
 * buildQuickbooksSearchCriteria.
 *
 * `validate` is the per-entity runtime check — the allowed filter/sort field
 * whitelists Intuit's server applies after the schema, because the exposed
 * schema is deliberately loose.
 */
export function searchByCriteria({ name, description, method, entity, validate, label, aliases = [] }) {
  return tool({
    name,
    description,
    aliases,
    label,
    schema: z.object({
      criteria: z
        .any()
        .optional()
        .describe(
          'Filters. Either a plain object of field/value pairs, or the advanced form '
          + '{ filters: [{field, value, operator}], asc, desc, limit, offset, count, fetchAll }. '
          + 'Omit to return everything.',
        ),
    }),
    run: async (ctx, p) => {
      const criteria = p.criteria ?? {};
      if (validate) {
        const problem = validate(criteria);
        // Flagged as the caller's mistake so it is answered rather than logged
        // as a fault — a mistyped column name is not an incident.
        if (problem) throw Object.assign(new Error(problem), { userError: true });
      }
      const normalized = buildQuickbooksSearchCriteria(criteria);
      return queryRows(await qb(ctx, method, normalized), entity);
    },
  });
}

/**
 * `search_x` that forwards a criteria array plus paging options straight
 * through — the shape used by the entities whose tools expose
 * {criteria[], asc, desc, limit, offset, count, fetchAll}.
 */
export function searchPassthrough({ name, description, method, entity, fieldHint, label, aliases = [] }) {
  return tool({
    name,
    description,
    aliases,
    label,
    schema: z.object({
      criteria: z
        .array(z.record(z.any()))
        .optional()
        .describe(
          'Filters as {field, value, operator?} objects'
          + (fieldHint ? `. Common fields: ${fieldHint}.` : '.'),
        ),
      asc: z.string().optional().describe('Sort ascending by this field.'),
      desc: z.string().optional().describe('Sort descending by this field.'),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
      count: z.boolean().optional().describe('Return only the number of matches.'),
      fetchAll: z.boolean().optional().describe('Page through every match.'),
    }),
    run: async (ctx, p) => {
      const { criteria = [], ...options } = p;
      const normalized = buildQuickbooksSearchCriteria(
        criteria.length ? { filters: criteria, ...options } : options,
      );
      return queryRows(await qb(ctx, method, normalized), entity);
    },
  });
}

/**
 * `delete_x` — a genuine QBO delete.
 *
 * Every delete tool takes the same `idOrEntity`, which accepts either a bare Id
 * or a full record. Upstream is inconsistent here — delete_customer takes
 * `idOrEntity`, delete_vendor takes `{vendor: {Id, SyncToken}}`, delete_attachable
 * takes `{id, sync_token}` — and an agent choosing between 142 tools should not
 * have to remember which noun wants which shape. The single form is a superset
 * of all three.
 *
 * @param getMethod  How to load the record when only an Id was supplied.
 *                   QuickBooks needs a current SyncToken to delete anything, and
 *                   an agent holding a search result usually has only the Id.
 */
export function deleteById({ name, description, method, getMethod, noun = 'record', label, aliases = [] }) {
  return tool({
    name,
    description,
    aliases,
    label,
    schema: z.object({
      idOrEntity: z
        .any()
        .describe(`The ${noun} Id, or the full ${noun} object including Id and SyncToken.`),
    }),
    run: async (ctx, p) => {
      let target = p.idOrEntity;
      if (getMethod && (typeof target !== 'object' || target === null || !target.Id)) {
        target = await qb(ctx, getMethod, String(target));
        if (!target?.Id) throw new Error(`Could not load the ${noun} to delete it.`);
      }
      return qb(ctx, method, target);
    },
  });
}

/**
 * `delete_x` for entities QuickBooks refuses to delete — customers, vendors,
 * employees, items. These are deactivated instead (Active: false), which is
 * what the QuickBooks UI's "delete" button does too.
 *
 * @param tryDelete  Attempt the real delete first and fall back on failure.
 *                   Customers and vendors support it on some API versions;
 *                   items and employees never do.
 */
export function deactivate({ name, description, getMethod, updateMethod, deleteMethod, noun, label, aliases = [] }) {
  return tool({
    name,
    description,
    aliases,
    label,
    schema: z.object({
      idOrEntity: z
        .any()
        .describe(`The ${noun} Id, or the full ${noun} object including Id and SyncToken.`),
    }),
    run: async (ctx, p) => {
      const given = p.idOrEntity;

      return qbo.withClient(ctx, async (client) => {
        // node-quickbooks does not implement deleteCustomer or deleteVendor at
        // all, and its coverage varies by version — so probe rather than call
        // and catch, which would otherwise log a spurious "no such method"
        // failure on the normal path for every deletion.
        if (deleteMethod && typeof client[deleteMethod] === 'function') {
          try {
            return await qbo.call(client, deleteMethod, given);
          } catch {
            // Fall through to deactivation. QuickBooks refuses a hard delete for
            // any record a transaction already refers to, which is most of
            // them — that refusal is the expected case, not an exception.
          }
        }

        const entity = given && typeof given === 'object' && given.Id
          ? given
          : await qbo.call(client, getMethod, String(given));

        if (!entity?.Id) throw new Error(`Could not load the ${noun} to deactivate it.`);

        // SyncToken must be the current one or QuickBooks answers 5010.
        return qbo.call(client, updateMethod, {
          Id: entity.Id,
          SyncToken: entity.SyncToken,
          Active: false,
          sparse: true,
        });
      });
    },
  });
}

/**
 * `update_x` for entities that accept a QBO sparse update: send Id + SyncToken
 * plus only the fields being changed.
 *
 * @param map  (params) => partial QBO payload
 */
export function sparseUpdate({ name, description, method, schema, map, label, aliases = [] }) {
  return tool({
    name,
    description,
    aliases,
    label,
    schema,
    run: (ctx, p) => qb(ctx, method, {
      Id: String(p.id),
      SyncToken: String(p.sync_token),
      sparse: true,
      ...map(p),
    }),
  });
}

/** Standard {id, sync_token} head shared by every sparse update schema. */
export function updateHead(noun) {
  return {
    id: z.string().min(1).describe(`${noun} Id.`),
    sync_token: z
      .string()
      .min(1)
      .describe(`SyncToken from the most recent read of this ${noun.toLowerCase()}. A stale one is rejected with QuickBooks error 5010.`),
  };
}

/** `create_x` that forwards a raw QBO entity object with no reshaping. */
export function createRaw({ name, description, method, key, label, aliases = [], shape }) {
  return tool({
    name,
    description,
    aliases,
    label,
    schema: z.object({
      [key]: (shape || z.record(z.any())).describe(`The QuickBooks ${key} object to create.`),
    }),
    run: (ctx, p) => qb(ctx, method, p[key]),
  });
}

/** `update_x` that forwards a raw QBO entity object (must carry Id + SyncToken). */
export function updateRaw({ name, description, method, key, label, aliases = [], shape }) {
  return tool({
    name,
    description,
    aliases,
    label,
    schema: z.object({
      [key]: (shape || z.record(z.any())).describe(
        `The QuickBooks ${key} object to update. Must include Id and SyncToken; add sparse: true for a partial update.`,
      ),
    }),
    run: (ctx, p) => qb(ctx, method, p[key]),
  });
}

// ---------------------------------------------------------------------------
// Shared QBO payload fragments
// ---------------------------------------------------------------------------

/** QBO reference object: `{ value: "<id>" }`. */
export const ref = (id) => (id === undefined || id === null || id === '' ? undefined : { value: String(id) });

/** Drop undefined keys so they are never serialised into a QBO payload. */
export function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * The sales-document line shape shared by invoices, estimates, credit memos,
 * sales receipts and refund receipts: quantity × unit price against an item.
 */
export const salesLineItemSchema = z.object({
  item_ref: z.string().min(1).describe('Item Id (use search_items).'),
  qty: z.number().positive().describe('Quantity.'),
  unit_price: z.number().nonnegative().describe('Price per unit.'),
  description: z.string().optional().describe('Line description.'),
  tax_code_ref: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Tax code for this line: a TaxCode Id for non-US companies (use search_tax_codes), or 'TAX'/'NON' for US companies.",
    ),
  service_date: z
    .string()
    .optional()
    .describe('Date the service was performed (YYYY-MM-DD), shown per line.'),
});

/** Build the QBO Line array for a sales document from salesLineItemSchema rows. */
export function salesLines(lineItems) {
  return lineItems.map((l, idx) => compact({
    Id: `${idx + 1}`,
    LineNum: idx + 1,
    Description: l.description || undefined,
    Amount: l.qty * l.unit_price,
    DetailType: 'SalesItemLineDetail',
    SalesItemLineDetail: compact({
      ItemRef: ref(l.item_ref),
      Qty: l.qty,
      UnitPrice: l.unit_price,
      TaxCodeRef: ref(l.tax_code_ref),
      ServiceDate: l.service_date || undefined,
    }),
  }));
}

export const globalTaxCalculationSchema = z
  .enum(['TaxExcluded', 'TaxInclusive', 'NotApplicable'])
  .describe(
    'Non-US companies: whether line amounts exclude tax (TaxExcluded), already include it '
    + '(TaxInclusive), or tax does not apply. Use together with per-line tax_code_ref.',
  );

export { formatError, logError };
