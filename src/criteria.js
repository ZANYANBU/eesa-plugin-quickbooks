// Search-criteria normalisation — ported from
// helpers/build-quickbooks-search-criteria.ts.
//
// node-quickbooks' find* methods accept two very different shapes:
//   • a plain object of field/value pairs           -> equality filters
//   • an array of {field, value, operator} objects  -> everything else,
//     including paging and sorting, which are smuggled in as pseudo-fields
//     ("limit", "offset", "asc", "desc", "count", "fetchAll").
//
// Tool callers should not have to know that. This accepts either, plus a
// friendlier `{filters, asc, desc, limit, ...}` form, and emits whatever
// node-quickbooks needs.

/**
 * @param {Record<string, any> | Array<Record<string, any>> | object} input
 * @returns {Record<string, any> | Array<Record<string, any>>}
 */
export function buildQuickbooksSearchCriteria(input) {
  // An array is already the shape node-quickbooks wants.
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== 'object') return {};

  const ADVANCED_KEYS = ['filters', 'criteria', 'asc', 'desc', 'limit', 'offset', 'count', 'fetchAll'];
  const isAdvanced = Object.keys(input).some((k) => ADVANCED_KEYS.includes(k));

  // A plain criteria object — pass it through untouched.
  if (!isAdvanced) return input;

  const criteria = [];

  // `filters` and `criteria` are accepted interchangeably: different tools in
  // the upstream server name the same thing differently, and callers copy from
  // whichever description they read.
  const filters = input.filters ?? input.criteria;
  if (Array.isArray(filters)) {
    for (const f of filters) {
      if (!f || typeof f !== 'object') continue;
      // Tolerate the legacy {key, value} pairs some tools documented.
      const field = f.field ?? f.key;
      if (!field) continue;
      criteria.push(
        f.operator ? { field, value: f.value, operator: f.operator } : { field, value: f.value },
      );
    }
  }

  if (input.asc) criteria.push({ field: 'asc', value: input.asc });
  if (input.desc) criteria.push({ field: 'desc', value: input.desc });
  if (typeof input.limit === 'number') criteria.push({ field: 'limit', value: input.limit });
  if (typeof input.offset === 'number') criteria.push({ field: 'offset', value: input.offset });
  if (input.count) criteria.push({ field: 'count', value: true });
  if (input.fetchAll) criteria.push({ field: 'fetchAll', value: true });

  // Nothing survived — return an empty object so QuickBooks returns everything,
  // rather than an empty array, which node-quickbooks treats differently.
  return criteria.length > 0 ? criteria : {};
}

/**
 * Build the runtime whitelist check the upstream search tools apply after the
 * (deliberately loose) schema: filter fields and sort fields must be columns
 * QuickBooks will actually accept, and values must be the right type.
 *
 * Returns a validator that answers `null` when the criteria are fine, or a
 * sentence naming the problem — worth being specific about, because "invalid
 * criteria" sends an agent into a guessing loop while "Field must be one of …"
 * lets it fix the call on the next turn.
 *
 * @param {object}   spec
 * @param {string[]} spec.filterFields
 * @param {string[]} spec.sortFields
 * @param {Record<string,'string'|'number'|'boolean'|'date'>} [spec.types]
 */
export function criteriaValidator({ filterFields, sortFields, types = {} }) {
  const typeOk = (field, value) => {
    const expected = types[field];
    if (!expected) return true;
    // `IN` and range operators legitimately carry arrays; check the members.
    if (Array.isArray(value)) return value.every((v) => typeOk(field, v));
    if (expected === 'date') return typeof value === 'string';
    return typeof value === expected; // eslint-disable-line valid-typeof
  };

  return (criteria) => {
    if (!criteria || typeof criteria !== 'object') return null;

    const filters = Array.isArray(criteria)
      ? criteria
      : (criteria.filters ?? criteria.criteria);

    if (Array.isArray(filters)) {
      for (const f of filters) {
        if (!f || typeof f !== 'object') continue;
        const field = f.field ?? f.key;
        // Paging/sorting arrive as pseudo-fields in the array form; they are
        // not columns and must skip the column whitelist.
        if (!field || ['limit', 'offset', 'asc', 'desc', 'count', 'fetchAll'].includes(field)) continue;
        if (!filterFields.includes(field)) {
          return `Cannot filter on "${field}". Filterable fields are: ${filterFields.join(', ')}.`;
        }
        if (!typeOk(field, f.value)) {
          return `The value for "${field}" is the wrong type; it must be a ${types[field]}.`;
        }
      }
    }

    if (!Array.isArray(criteria)) {
      for (const key of ['asc', 'desc']) {
        const field = criteria[key];
        if (field && !sortFields.includes(field)) {
          return `Cannot sort by "${field}". Sortable fields are: ${sortFields.join(', ')}.`;
        }
      }
      // Plain object form: every key is a filter column.
      if (!filters) {
        for (const [key, value] of Object.entries(criteria)) {
          if (['limit', 'offset', 'asc', 'desc', 'count', 'fetchAll'].includes(key)) continue;
          if (!filterFields.includes(key)) {
            return `Cannot filter on "${key}". Filterable fields are: ${filterFields.join(', ')}.`;
          }
          if (!typeOk(key, value)) {
            return `The value for "${key}" is the wrong type; it must be a ${types[key]}.`;
          }
        }
      }
    }

    return null;
  };
}
