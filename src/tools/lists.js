// Reference lists: classes, departments (locations), payment terms, payment
// methods, budgets, and the three tax lists.
//
// These are the small lookup tables the transaction tools reference by Id. An
// agent asked to "put this on the Marketing class" has to resolve that name to
// an Id first, which is why every one of them has a search tool.
import { z } from 'zod';
import {
  tool, qb, getById, searchByFields, sparseUpdate, updateHead, ref, compact,
} from './registry.js';

/** name / active / limit — the filter set almost every reference list shares. */
const nameActiveLimit = z.object({
  name: z.string().optional().describe('Filter by exact name.'),
  active: z.boolean().optional().describe('Filter by active status.'),
  limit: z.number().int().positive().optional().describe('Maximum records to return.'),
});

const mapNameActiveLimit = (p) => compact({
  Name: p.name,
  Active: p.active,
  limit: p.limit,
});

/** create_x / update_x / get_x / search_x for a simple named, nestable list. */
function namedList({ noun, singular, plural, entity, methods, createDescription, parentDescription }) {
  return [
    tool({
      name: `create_${singular}`,
      description: createDescription,
      label: `${noun} created`,
      schema: z.object({
        name: z.string().min(1).describe(`${noun} name.`),
        parent_ref: z.string().optional().describe(parentDescription),
      }),
      run: (ctx, p) => qb(ctx, methods.create, compact({
        Name: p.name,
        ParentRef: ref(p.parent_ref),
        SubDepartment: undefined,
      })),
    }),
    getById({
      name: `get_${singular}`,
      description: `Get a ${noun.toLowerCase()} by Id from QuickBooks Online.`,
      method: methods.get,
      label: noun,
    }),
    sparseUpdate({
      name: `update_${singular}`,
      description: `Update a ${noun.toLowerCase()} in QuickBooks Online. Set active: false to retire it.`,
      method: methods.update,
      label: `${noun} updated`,
      schema: z.object({
        ...updateHead(noun),
        name: z.string().optional().describe('New name.'),
        active: z.boolean().optional().describe('Whether it stays available for use.'),
      }),
      map: (p) => compact({ Name: p.name, Active: p.active }),
    }),
    searchByFields({
      name: `search_${plural}`,
      description: `Search ${plural.replace(/_/g, ' ')} in QuickBooks Online.`,
      method: methods.find,
      entity,
      schema: nameActiveLimit,
      map: mapNameActiveLimit,
      label: noun + 's',
    }),
  ];
}

export default [
  // ---- classes ------------------------------------------------------------
  ...namedList({
    noun: 'Class',
    singular: 'class',
    plural: 'classes',
    entity: 'Class',
    methods: { create: 'createClass', get: 'getClass', update: 'updateClass', find: 'findClasses' },
    createDescription:
      'Create a class in QuickBooks Online. Classes cut across the chart of accounts to track '
      + 'profitability by line of business, and must be enabled in company preferences first.',
    parentDescription: 'Id of a parent class, to nest this one beneath it.',
  }),

  // ---- departments (locations) --------------------------------------------
  ...namedList({
    noun: 'Department',
    singular: 'department',
    plural: 'departments',
    entity: 'Department',
    methods: {
      create: 'createDepartment', get: 'getDepartment', update: 'updateDepartment', find: 'findDepartments',
    },
    createDescription:
      'Create a department in QuickBooks Online. Departments track results by location or division, '
      + 'and appear as "Locations" in some QuickBooks regions.',
    parentDescription: 'Id of a parent department, to nest this one beneath it.',
  }),

  // ---- payment terms ------------------------------------------------------
  tool({
    name: 'create_term',
    description:
      'Create a payment term in QuickBooks Online, e.g. Net 30 or Due on Receipt. A STANDARD term is '
      + 'a number of days after the invoice date; a DATE_DRIVEN term is due on a fixed day of the month.',
    label: 'Term created',
    schema: z.object({
      name: z.string().min(1).describe("Term name, e.g. 'Net 30'."),
      due_days: z.number().int().optional().describe('Days until payment is due (STANDARD terms).'),
      discount_days: z.number().int().optional().describe('Days within which an early-payment discount applies.'),
      discount_percent: z.number().optional().describe('Early-payment discount percentage.'),
      type: z.enum(['STANDARD', 'DATE_DRIVEN']).optional(),
      day_of_month_due: z.number().int().optional().describe('Day of month payment is due (DATE_DRIVEN).'),
      due_next_month_days: z.number().int().optional().describe('Invoices after this day of month roll to next month.'),
      discount_day_of_month: z.number().int().optional().describe('Day of month the discount expires (DATE_DRIVEN).'),
    }),
    run: (ctx, p) => qb(ctx, 'createTerm', compact({
      Name: p.name,
      DueDays: p.due_days,
      DiscountDays: p.discount_days,
      DiscountPercent: p.discount_percent,
      Type: p.type,
      DayOfMonthDue: p.day_of_month_due,
      DueNextMonthDays: p.due_next_month_days,
      DiscountDayOfMonth: p.discount_day_of_month,
    })),
  }),
  getById({
    name: 'get_term',
    description: 'Get a payment term by Id from QuickBooks Online.',
    method: 'getTerm',
    label: 'Term',
  }),
  sparseUpdate({
    name: 'update_term',
    description: 'Update a payment term in QuickBooks Online.',
    method: 'updateTerm',
    label: 'Term updated',
    schema: z.object({
      ...updateHead('Term'),
      name: z.string().optional(),
      active: z.boolean().optional(),
      due_days: z.number().int().optional(),
      discount_days: z.number().int().optional(),
      discount_percent: z.number().optional(),
    }),
    map: (p) => compact({
      Name: p.name,
      Active: p.active,
      DueDays: p.due_days,
      DiscountDays: p.discount_days,
      DiscountPercent: p.discount_percent,
    }),
  }),
  searchByFields({
    name: 'search_terms',
    description: 'Search payment terms in QuickBooks Online.',
    method: 'findTerms',
    entity: 'Term',
    schema: nameActiveLimit,
    map: mapNameActiveLimit,
    label: 'Terms',
  }),

  // ---- payment methods ----------------------------------------------------
  tool({
    name: 'create_payment_method',
    description: 'Create a payment method in QuickBooks Online, e.g. Cash, Cheque or a card type.',
    label: 'Payment method created',
    schema: z.object({
      name: z.string().min(1).describe('Payment method name.'),
      type: z.enum(['CREDIT_CARD', 'NON_CREDIT_CARD']).optional(),
    }),
    run: (ctx, p) => qb(ctx, 'createPaymentMethod', compact({ Name: p.name, Type: p.type })),
  }),
  getById({
    name: 'get_payment_method',
    description: 'Get a payment method by Id from QuickBooks Online.',
    method: 'getPaymentMethod',
    label: 'Payment method',
  }),
  sparseUpdate({
    name: 'update_payment_method',
    description: 'Update a payment method in QuickBooks Online.',
    method: 'updatePaymentMethod',
    label: 'Payment method updated',
    schema: z.object({
      ...updateHead('Payment method'),
      name: z.string().optional(),
      active: z.boolean().optional(),
    }),
    map: (p) => compact({ Name: p.name, Active: p.active }),
  }),
  searchByFields({
    name: 'search_payment_methods',
    description: 'Search payment methods in QuickBooks Online.',
    method: 'findPaymentMethods',
    entity: 'PaymentMethod',
    label: 'Payment methods',
    schema: z.object({
      name: z.string().optional().describe('Filter by exact name.'),
      active: z.boolean().optional(),
      type: z.enum(['CREDIT_CARD', 'NON_CREDIT_CARD']).optional(),
      limit: z.number().int().positive().optional(),
    }),
    map: (p) => compact({ Name: p.name, Active: p.active, Type: p.type, limit: p.limit }),
  }),

  // ---- budgets (read-only in the QBO v3 API) ------------------------------
  searchByFields({
    name: 'search_budgets',
    description:
      'Search budgets in QuickBooks Online. Each Budget carries nested BudgetDetail lines (Amount, '
      + 'BudgetDate, AccountRef, ClassRef, CustomerRef, DepartmentRef). Budgets are read-only in the '
      + 'QuickBooks v3 API — they cannot be created or changed through it.',
    method: 'findBudgets',
    entity: 'Budget',
    schema: nameActiveLimit,
    map: mapNameActiveLimit,
    label: 'Budgets',
  }),

  // ---- tax codes / rates / agencies ---------------------------------------
  getById({
    name: 'get_tax_code',
    description: 'Get a tax code by Id from QuickBooks Online.',
    method: 'getTaxCode',
    label: 'Tax code',
  }),
  searchByFields({
    name: 'search_tax_codes',
    description:
      'Search tax codes in QuickBooks Online. Use this to find the TaxCode Id that transaction tools '
      + "want in tax_code_ref (US companies use the literals 'TAX' and 'NON' instead).",
    method: 'findTaxCodes',
    entity: 'TaxCode',
    label: 'Tax codes',
    schema: z.object({
      name: z.string().optional().describe('Filter by exact name.'),
      active: z.boolean().optional(),
      taxable: z.boolean().optional().describe('Filter by whether the code applies tax.'),
      limit: z.number().int().positive().optional(),
    }),
    map: (p) => compact({ Name: p.name, Active: p.active, Taxable: p.taxable, limit: p.limit }),
  }),
  getById({
    name: 'get_tax_rate',
    description: 'Get a tax rate by Id from QuickBooks Online.',
    method: 'getTaxRate',
    label: 'Tax rate',
  }),
  searchByFields({
    name: 'search_tax_rates',
    description: 'Search tax rates in QuickBooks Online.',
    method: 'findTaxRates',
    entity: 'TaxRate',
    schema: nameActiveLimit,
    map: mapNameActiveLimit,
    label: 'Tax rates',
  }),
  getById({
    name: 'get_tax_agency',
    description: 'Get a tax agency by Id from QuickBooks Online.',
    method: 'getTaxAgency',
    label: 'Tax agency',
  }),
  searchByFields({
    name: 'search_tax_agencies',
    description: 'Search tax agencies (the bodies tax is remitted to) in QuickBooks Online.',
    method: 'findTaxAgencies',
    entity: 'TaxAgency',
    label: 'Tax agencies',
    schema: z.object({
      name: z.string().optional().describe('Filter by exact name.'),
      limit: z.number().int().positive().optional(),
    }),
    map: (p) => compact({ Name: p.name, limit: p.limit }),
  }),
];
