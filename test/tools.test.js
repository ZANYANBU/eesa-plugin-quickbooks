// Registry and contract tests. No network, no QuickBooks, no Eesa — these check
// the things that break silently: a tool that vanished in the port, a schema
// that will not serialise, a gate that does not gate.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

// auth.js throws at import without this; the value is never dereferenced here.
process.env.EESA_JWKS_URL ||= 'https://example.invalid/jwks.json';

let tools;
let registry;
let mcp;

before(async () => {
  tools = await import('../src/tools/index.js');
  registry = await import('../src/tools/registry.js');
  mcp = await import('../src/mcp.js');
});

describe('tool catalogue', () => {
  test('ports every tool from Intuit\'s server', () => {
    // The upstream server registers 142 tools. If this number changes, either a
    // tool was dropped in the port or one was added — both worth noticing.
    assert.equal(tools.ALL_TOOLS.length, 142);
  });

  test('every tool has a name, a description and a runnable body', () => {
    for (const t of tools.ALL_TOOLS) {
      assert.ok(t.name, 'missing name');
      assert.ok(t.description.length > 20, `${t.name}: description too thin`);
      assert.equal(typeof t.run, 'function', `${t.name}: run is not a function`);
      assert.ok(t.schema, `${t.name}: no schema`);
    }
  });

  test('names are unique, including aliases', () => {
    const seen = new Set();
    for (const t of tools.ALL_TOOLS) {
      for (const key of [t.name, ...(t.aliases || [])]) {
        assert.ok(!seen.has(key), `duplicate tool name: ${key}`);
        seen.add(key);
      }
    }
  });

  test('every schema converts to JSON Schema for tools/list', () => {
    for (const t of tools.listTools()) {
      assert.equal(typeof t.inputSchema, 'object', `${t.name}: no inputSchema`);
      assert.equal(t.inputSchema.type, 'object', `${t.name}: inputSchema is not an object schema`);
      // A $ref that escaped inlining would be unresolvable for the caller.
      assert.ok(!JSON.stringify(t.inputSchema).includes('"$ref"'), `${t.name}: unresolved $ref`);
    }
  });

  test('upstream hyphenated names still resolve', () => {
    // Intuit's server names eight tools with hyphens and the rest with
    // underscores. We publish the underscore form and keep the hyphen form
    // working, so anything written against their docs does not break.
    for (const legacy of [
      'create-bill', 'update-bill', 'get-bill', 'delete-bill',
      'create-vendor', 'update-vendor', 'get-vendor', 'delete-vendor',
    ]) {
      const found = tools.findTool(legacy);
      assert.ok(found, `alias ${legacy} does not resolve`);
      assert.equal(found.name, legacy.replace('-', '_'));
    }
  });

  test('aliases are not advertised in tools/list', () => {
    const listed = new Set(tools.listTools().map((t) => t.name));
    assert.ok(!listed.has('create-bill'));
    assert.ok(listed.has('create_bill'));
  });
});

describe('CRUD gating', () => {
  test('categorises tools by name prefix', () => {
    assert.equal(registry.crudCategory('create_invoice'), 'WRITE');
    assert.equal(registry.crudCategory('update_invoice'), 'UPDATE');
    assert.equal(registry.crudCategory('delete_invoice'), 'DELETE');
    assert.equal(registry.crudCategory('search_invoices'), 'READ');
    assert.equal(registry.crudCategory('get_balance_sheet'), 'READ');
    // The hyphenated legacy forms must categorise identically, or a
    // read-only deployment would happily register create-bill.
    assert.equal(registry.crudCategory('create-bill'), 'WRITE');
  });

  test('reads can never be disabled', () => {
    process.env.QUICKBOOKS_DISABLE_WRITE = 'true';
    try {
      assert.equal(registry.isToolDisabled('search_invoices'), false);
      assert.equal(registry.isToolDisabled('get_profit_and_loss'), false);
    } finally {
      delete process.env.QUICKBOOKS_DISABLE_WRITE;
    }
  });

  test('a disabled category is unregistered, not merely refused', () => {
    process.env.QUICKBOOKS_DISABLE_WRITE = 'true';
    process.env.QUICKBOOKS_DISABLE_DELETE = 'true';
    try {
      const names = new Set(tools.listTools().map((t) => t.name));
      assert.ok(!names.has('create_invoice'), 'create_invoice still listed');
      assert.ok(!names.has('delete_invoice'), 'delete_invoice still listed');
      assert.ok(names.has('update_invoice'), 'update_invoice should be unaffected');
      assert.ok(names.has('search_invoices'));
      // Unregistered means unreachable by name too, not just hidden from the list.
      assert.equal(tools.findTool('create_invoice'), null);
      assert.equal(tools.findTool('create-bill'), null, 'alias bypassed the gate');
    } finally {
      delete process.env.QUICKBOOKS_DISABLE_WRITE;
      delete process.env.QUICKBOOKS_DISABLE_DELETE;
    }
  });
});

describe('argument unwrapping', () => {
  test('accepts flat arguments', () => {
    assert.deepEqual(mcp.unwrapArguments({ id: '5' }), { id: '5' });
  });

  test("accepts Intuit's nested { params: ... } form", () => {
    assert.deepEqual(mcp.unwrapArguments({ params: { id: '5' } }), { id: '5' });
  });

  test('does not unwrap when other keys are present', () => {
    const args = { params: { id: '5' }, other: 1 };
    assert.deepEqual(mcp.unwrapArguments(args), args);
  });

  test('tolerates missing or malformed arguments', () => {
    assert.deepEqual(mcp.unwrapArguments(undefined), {});
    assert.deepEqual(mcp.unwrapArguments(null), {});
    assert.deepEqual(mcp.unwrapArguments('nope'), {});
  });
});

describe('schema validation', () => {
  test('rejects a create_invoice with no line items', () => {
    const t = tools.findTool('create_invoice');
    const r = t.schema.safeParse({ customer_ref: '1', line_items: [] });
    assert.equal(r.success, false);
  });

  test('accepts a well-formed create_invoice', () => {
    const t = tools.findTool('create_invoice');
    const r = t.schema.safeParse({
      customer_ref: '1',
      line_items: [{ item_ref: '2', qty: 3, unit_price: 10 }],
    });
    assert.equal(r.success, true);
  });

  test('a Billable vendor-credit line requires a customer', () => {
    const t = tools.findTool('create_vendor_credit');
    const bad = t.schema.safeParse({
      vendor_ref: '1',
      line_items: [{ amount: 10, billable_status: 'Billable' }],
    });
    assert.equal(bad.success, false, 'QuickBooks would reject this — catch it locally');

    const good = t.schema.safeParse({
      vendor_ref: '1',
      line_items: [{ amount: 10, billable_status: 'Billable', customer_ref: '7' }],
    });
    assert.equal(good.success, true);
  });

  test('sparse updates require a SyncToken', () => {
    const t = tools.findTool('update_payment');
    assert.equal(t.schema.safeParse({ id: '1' }).success, false);
    assert.equal(t.schema.safeParse({ id: '1', sync_token: '0' }).success, true);
  });
});
