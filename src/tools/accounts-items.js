// Chart of accounts, and items (the products and services you sell).
import { z } from 'zod';
import {
  tool, qb, getById, searchByCriteria, deactivate, ref, compact,
} from './registry.js';
import { criteriaValidator } from '../criteria.js';

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

// Scalar coercion map. ParentRef is deliberately ABSENT: it is a QBO reference
// object ({ value: "<id>" }), and String()-ing it produces the literal
// "[object Object]", which QuickBooks rejects with error 2010 — making it
// impossible to nest an account. It is built separately below.
const ACCOUNT_FIELD_TYPES = {
  Name: 'string',
  AccountType: 'string',
  AccountSubType: 'string',
  Description: 'string',
  Classification: 'string',
  Active: 'boolean',
  SubAccount: 'boolean',
  CurrentBalance: 'number',
};

function coerceAccountFields(payload) {
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    switch (ACCOUNT_FIELD_TYPES[key]) {
      case 'string': out[key] = String(value); break;
      case 'boolean': out[key] = typeof value === 'boolean' ? value : value === 'true'; break;
      case 'number': out[key] = typeof value === 'number' ? value : Number(value); break;
      default: out[key] = value; // unknown keys pass through untouched
    }
  }
  return out;
}

// Accept { value: "5" }, "5" or 5, and always emit the reference object.
function parentRef(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'object') return value.value !== undefined ? { value: String(value.value) } : undefined;
  return { value: String(value) };
}

const accountSearchValidator = criteriaValidator({
  filterFields: [
    'Id', 'MetaData.CreateTime', 'MetaData.LastUpdatedTime', 'Name', 'SubAccount',
    'ParentRef', 'Description', 'Active', 'Classification', 'AccountType', 'CurrentBalance',
  ],
  sortFields: [
    'Id', 'MetaData.CreateTime', 'MetaData.LastUpdatedTime', 'Name', 'SubAccount',
    'ParentRef', 'Description', 'CurrentBalance',
  ],
  types: {
    Id: 'string',
    'MetaData.CreateTime': 'date',
    'MetaData.LastUpdatedTime': 'date',
    Name: 'string',
    SubAccount: 'boolean',
    ParentRef: 'string',
    Description: 'string',
    Active: 'boolean',
    Classification: 'string',
    AccountType: 'string',
    CurrentBalance: 'number',
  },
});

const itemSearchValidator = criteriaValidator({
  filterFields: ['Id', 'MetaData.CreateTime', 'MetaData.LastUpdatedTime', 'Name', 'Active', 'Type', 'Sku'],
  sortFields: [
    'Id', 'MetaData.CreateTime', 'MetaData.LastUpdatedTime', 'Name', 'ParentRef',
    'PrefVendorRef', 'UnitPrice', 'Type', 'QtyOnHand',
  ],
  types: {
    Id: 'string',
    'MetaData.CreateTime': 'date',
    'MetaData.LastUpdatedTime': 'date',
    Name: 'string',
    Active: 'boolean',
    Type: 'string',
    Sku: 'string',
  },
});

export default [
  tool({
    name: 'create_account',
    description:
      'Create a chart-of-accounts entry in QuickBooks Online. To create a sub-account, pass '
      + "parent_id with the parent's Id — the new account's type must match the parent's.",
    label: 'Account created',
    schema: z.object({
      name: z.string().min(1).describe('Account name. Must be unique within the chart of accounts.'),
      type: z
        .string()
        .min(1)
        .describe('AccountType, e.g. Bank, Expense, Income, Accounts Receivable, Credit Card, Fixed Asset.'),
      sub_type: z.string().optional().describe('AccountSubType, e.g. Savings, OfficeGeneralAdministrativeExpenses.'),
      description: z.string().optional(),
      parent_id: z.string().min(1).optional().describe('Id of the parent account, to nest this one beneath it.'),
    }),
    run: (ctx, p) => {
      const payload = coerceAccountFields({
        Name: p.name,
        AccountType: p.type,
        AccountSubType: p.sub_type,
        Description: p.description,
      });
      // Built after coercion so the nested reference never meets the scalar map.
      const parent = parentRef(p.parent_id);
      if (parent) {
        payload.SubAccount = true;
        payload.ParentRef = parent;
      }
      return qb(ctx, 'createAccount', payload);
    },
  }),

  getById({
    name: 'get_account',
    description: 'Get a single account by Id from QuickBooks Online.',
    method: 'getAccount',
    label: 'Account',
  }),

  tool({
    name: 'update_account',
    description:
      'Update a chart-of-accounts entry. Pass only the fields to change; the current account is read '
      + 'first and your changes are merged over it.',
    label: 'Account updated',
    schema: z.object({
      account_id: z.string().min(1).describe('Account Id.'),
      patch: z
        .record(z.any())
        .describe(
          'Fields to change, e.g. { "Name": "Office Supplies", "Description": "..." }. '
          + 'To re-parent, set ParentRef to the new parent Id.',
        ),
    }),
    run: async (ctx, p) => {
      const existing = await qb(ctx, 'getAccount', String(p.account_id));

      const patch = {};
      for (const [key, value] of Object.entries(p.patch || {})) {
        if (value === undefined) continue;
        if (key === 'ParentRef') {
          const parent = parentRef(value);
          if (parent) patch.ParentRef = parent;
          continue;
        }
        Object.assign(patch, coerceAccountFields({ [key]: value }));
      }

      // QBO's Account entity does NOT support sparse updates — a sparse body
      // comes back as error 2020 ("Required parameter Name is missing"). So this
      // is a full-object write: spread the account we just read (which carries
      // Name/AccountType/AccountSubType/Classification/SyncToken) and overlay
      // the patch. `sparse` is removed rather than set.
      const payload = { ...existing, ...patch, Id: String(p.account_id) };
      delete payload.sparse;
      return qb(ctx, 'updateAccount', payload);
    },
  }),

  searchByCriteria({
    name: 'search_accounts',
    description:
      'Search the chart of accounts. Filter on Name, AccountType, Classification, Active, '
      + 'SubAccount, ParentRef, Description or CurrentBalance.',
    method: 'findAccounts',
    entity: 'Account',
    validate: accountSearchValidator,
    label: 'Accounts',
  }),

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------
  tool({
    name: 'create_item',
    description: 'Create an item (a product or service you sell) in QuickBooks Online.',
    label: 'Item created',
    schema: z.object({
      name: z.string().min(1).describe('Item name. Must be unique.'),
      type: z.string().min(1).describe('Item type: Service, Inventory, NonInventory or Category.'),
      income_account_ref: z.string().min(1).describe('Id of the income account sales post to.'),
      expense_account_ref: z.string().optional().describe('Id of the expense account purchases post to.'),
      unit_price: z.number().optional().describe('Default sales price.'),
      description: z.string().optional().describe('Default description on sales forms.'),
    }),
    run: (ctx, p) => qb(ctx, 'createItem', compact({
      Name: p.name,
      Type: p.type,
      IncomeAccountRef: ref(p.income_account_ref),
      ExpenseAccountRef: ref(p.expense_account_ref),
      UnitPrice: p.unit_price,
      Description: p.description,
    })),
  }),

  getById({
    name: 'read_item',
    description: 'Read a single item from QuickBooks Online by its Id.',
    method: 'getItem',
    idField: 'item_id',
    label: 'Item',
  }),

  tool({
    name: 'update_item',
    description:
      'Update an item by Id. Reads the current item for its SyncToken, then applies your patch as a '
      + 'sparse update.',
    label: 'Item updated',
    schema: z.object({
      item_id: z.string().min(1).describe('Item Id.'),
      patch: z.record(z.any()).describe('Item fields to change, e.g. { "UnitPrice": 120 }.'),
    }),
    run: async (ctx, p) => {
      const existing = await qb(ctx, 'getItem', String(p.item_id));
      return qb(ctx, 'updateItem', { ...existing, ...p.patch, Id: String(p.item_id), sparse: true });
    },
  }),

  deactivate({
    name: 'delete_item',
    description:
      'Make an item inactive in QuickBooks Online. QuickBooks does not delete items that appear on '
      + 'any transaction.',
    getMethod: 'getItem',
    updateMethod: 'updateItem',
    noun: 'item',
    label: 'Item made inactive',
  }),

  searchByCriteria({
    name: 'search_items',
    description: 'Search items in QuickBooks Online. Filter on Name, Type, Sku or Active.',
    method: 'findItems',
    entity: 'Item',
    validate: itemSearchValidator,
    label: 'Items',
  }),
];
