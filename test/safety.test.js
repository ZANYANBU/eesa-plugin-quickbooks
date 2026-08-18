// The checks that protect somebody's actual accounting data: the SSRF guard on
// attachment URLs, criteria whitelisting, and the payload builders whose output
// QuickBooks silently mangles when it is wrong.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.EESA_JWKS_URL ||= 'https://example.invalid/jwks.json';

let attachments;
let criteria;
let registry;
let tools;

before(async () => {
  attachments = await import('../src/attachments.js');
  criteria = await import('../src/criteria.js');
  registry = await import('../src/tools/registry.js');
  tools = await import('../src/tools/index.js');
});

describe('attachment URL SSRF guard', () => {
  test('blocks loopback, private, link-local and CGNAT addresses', () => {
    for (const ip of [
      '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.5', '172.16.9.9', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.255',
      '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1',
      '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::127.0.0.1', '::a00:1',
    ]) {
      assert.equal(attachments.isBlockedIp(ip), true, `${ip} should be blocked`);
    }
  });

  test('allows ordinary public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700::1111']) {
      assert.equal(attachments.isBlockedIp(ip), false, `${ip} should be allowed`);
    }
  });

  test('treats anything unparseable as blocked', () => {
    for (const junk of ['', 'not-an-ip', '999.999.999.999', 'localhost']) {
      assert.equal(attachments.isBlockedIp(junk), true, `${junk} should fail closed`);
    }
  });

  test('rejects plain http before any lookup happens', async () => {
    await assert.rejects(
      () => attachments.fetchUrlToTempFile('http://example.com/a.pdf'),
      /must use https/,
    );
  });

  test('rejects a literal internal address', async () => {
    await assert.rejects(
      () => attachments.fetchUrlToTempFile('https://169.254.169.254/latest/meta-data/'),
      /blocked address/,
    );
  });
});

describe('attachment content types', () => {
  test('infers from the first candidate with a known extension', () => {
    assert.equal(attachments.inferContentType('receipt.pdf'), 'application/pdf');
    assert.equal(attachments.inferContentType('nope.zzz', 'sheet.xlsx'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(attachments.inferContentType('nope.zzz'), null);
    assert.equal(attachments.inferContentType(undefined), null);
  });

  test('every inferred type is one QuickBooks actually accepts', () => {
    for (const ext of ['.pdf', '.png', '.jpg', '.csv', '.xlsx', '.docx', '.txt', '.xml']) {
      const mime = attachments.inferContentType(`f${ext}`);
      assert.ok(
        attachments.ALLOWED_UPLOAD_CONTENT_TYPES.has(mime),
        `${ext} -> ${mime} is not in the accepted set`,
      );
    }
  });

  test('estimates base64 size without decoding', () => {
    const raw = Buffer.from('hello world, this is a test payload');
    const b64 = raw.toString('base64');
    assert.equal(attachments.approximateDecodedSize(b64), raw.length);
  });
});

describe('search criteria', () => {
  const build = (i) => criteria.buildQuickbooksSearchCriteria(i);

  test('passes a plain criteria object straight through', () => {
    assert.deepEqual(build({ Name: 'Acme' }), { Name: 'Acme' });
  });

  test('passes an array straight through', () => {
    const arr = [{ field: 'TxnDate', value: '2026-01-01', operator: '>=' }];
    assert.deepEqual(build(arr), arr);
  });

  test('converts the advanced form to the array node-quickbooks needs', () => {
    const out = build({
      filters: [{ field: 'Balance', value: 0, operator: '>' }],
      desc: 'TxnDate',
      limit: 10,
      offset: 20,
      count: true,
      fetchAll: true,
    });
    assert.deepEqual(out, [
      { field: 'Balance', value: 0, operator: '>' },
      { field: 'desc', value: 'TxnDate' },
      { field: 'limit', value: 10 },
      { field: 'offset', value: 20 },
      { field: 'count', value: true },
      { field: 'fetchAll', value: true },
    ]);
  });

  test('accepts filters under either key, and the legacy {key,value} pair', () => {
    assert.deepEqual(
      build({ criteria: [{ key: 'DocNumber', value: '1001' }] }),
      [{ field: 'DocNumber', value: '1001' }],
    );
  });

  test('an empty advanced form returns {} so QuickBooks returns everything', () => {
    assert.deepEqual(build({ filters: [] }), {});
  });

  test('validator names the allowed fields rather than just refusing', () => {
    const validate = criteria.criteriaValidator({
      filterFields: ['DocNumber', 'TxnDate'],
      sortFields: ['TxnDate'],
      types: { DocNumber: 'string', TxnDate: 'date' },
    });
    assert.equal(validate({ DocNumber: '1001' }), null);
    assert.match(validate({ Nope: 'x' }), /Filterable fields are: DocNumber, TxnDate/);
    assert.match(validate({ DocNumber: 5 }), /wrong type/);
    assert.match(validate({ asc: 'Nope' }), /Sortable fields are: TxnDate/);
    // Paging pseudo-fields are not columns and must not be whitelisted against.
    assert.equal(validate({ limit: 5, offset: 1 }), null);
    assert.equal(validate([{ field: 'limit', value: 5 }]), null);
  });
});

describe('QBO payload shapes', () => {
  test('references are emitted as { value: "<id>" }, never coerced strings', () => {
    // String()-ing a reference object yields "[object Object]", which QuickBooks
    // rejects with error 2010 — the bug that makes re-parenting an account
    // impossible if a nested ref is run through a scalar coercion map.
    assert.deepEqual(registry.ref('5'), { value: '5' });
    assert.deepEqual(registry.ref(5), { value: '5' });
    assert.equal(registry.ref(undefined), undefined);
    assert.equal(registry.ref(''), undefined);
  });

  test('compact drops undefined so it never reaches QuickBooks', () => {
    assert.deepEqual(registry.compact({ a: 1, b: undefined, c: null, d: 0, e: '' }),
      { a: 1, c: null, d: 0, e: '' });
  });

  test('sales lines compute Amount and number themselves from 1', () => {
    const lines = registry.salesLines([
      { item_ref: '7', qty: 2, unit_price: 15.5, description: 'Consulting' },
      { item_ref: '8', qty: 1, unit_price: 100, tax_code_ref: 'TAX' },
    ]);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].Amount, 31);
    assert.equal(lines[0].LineNum, 1);
    assert.equal(lines[0].DetailType, 'SalesItemLineDetail');
    assert.deepEqual(lines[0].SalesItemLineDetail.ItemRef, { value: '7' });
    assert.equal(lines[1].Amount, 100);
    assert.deepEqual(lines[1].SalesItemLineDetail.TaxCodeRef, { value: 'TAX' });
    // An absent tax code must be absent, not present-and-undefined.
    assert.ok(!('TaxCodeRef' in lines[0].SalesItemLineDetail));
  });
});

describe('write protection', () => {
  test('every mutating tool is categorised as mutating', () => {
    const mutating = tools.ALL_TOOLS.filter((t) => registry.isMutating(t.name));
    // 25 create + 26 update + 20 delete in Intuit's server.
    assert.equal(mutating.length, 71);
    for (const t of mutating) {
      assert.match(t.name, /^(create|update|delete)[_-]/, `${t.name} is not clearly a mutation`);
    }
  });

  test('no read tool is misfiled as a mutation', () => {
    const reads = tools.ALL_TOOLS.filter((t) => !registry.isMutating(t.name));
    assert.equal(reads.length, 71);
    for (const t of reads) {
      assert.match(t.name, /^(get|read|search)_/, `${t.name} is not clearly a read`);
    }
  });
});
