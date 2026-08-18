// Money going out: bills, purchases (expenses), purchase orders, vendor credits.
import { z } from 'zod';
import {
  tool, qb, getById, deleteById, sparseUpdate, updateHead, searchByOperators,
  searchPassthrough, createRaw, updateRaw, ref, compact, globalTaxCalculationSchema,
} from './registry.js';

const refSchema = z.object({
  value: z.string().describe('The record Id.'),
  name: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------

const billLineSchema = z.object({
  Id: z.string().optional().describe('Existing line Id. Omit to add a new line.'),
  Amount: z.number().optional(),
  DetailType: z.string().optional().describe('AccountBasedExpenseLineDetail or ItemBasedExpenseLineDetail.'),
  Description: z.string().optional(),
  AccountRef: refSchema.optional().describe('Shorthand: moved under AccountBasedExpenseLineDetail for you.'),
  AccountBasedExpenseLineDetail: z.object({
    AccountRef: refSchema.optional(),
    BillableStatus: z.string().optional(),
    CustomerRef: refSchema.optional(),
    ClassRef: refSchema.optional(),
    TaxCodeRef: refSchema.optional(),
  }).passthrough().optional(),
  ItemBasedExpenseLineDetail: z.object({
    ItemRef: refSchema,
    Qty: z.number().optional(),
    UnitPrice: z.number().optional(),
    BillableStatus: z.string().optional(),
    CustomerRef: refSchema.optional(),
    ClassRef: refSchema.optional(),
    TaxCodeRef: refSchema.optional(),
  }).passthrough().optional(),
}).passthrough();

const DETAIL_KEYS = ['AccountBasedExpenseLineDetail', 'ItemBasedExpenseLineDetail'];

// Refs we assert survive the round trip. ClassRef is never auto-stripped by
// QuickBooks, so a dropped one is always real data loss. TaxCodeRef is
// different: under Automated Sales Tax, QuickBooks manages tax centrally and
// legitimately removes line-level tax codes.
const PRESERVED_REFS = ['ClassRef', 'TaxCodeRef'];

function mergeLine(currentLine, incomingLine) {
  if (!currentLine) return incomingLine; // no Id match — a new line
  const merged = { ...currentLine, ...incomingLine };
  for (const key of DETAIL_KEYS) {
    if (currentLine[key] || incomingLine[key]) {
      // Merge the nested detail so sub-refs the caller didn't mention survive,
      // while still letting them override anything they did supply.
      merged[key] = { ...currentLine[key], ...incomingLine[key] };
    }
  }
  return merged;
}

function mergeBill(current, incoming) {
  // Always write with the freshest SyncToken; a stale one from the caller would
  // come back as a 5010 conflict.
  const merged = { ...current, ...incoming, SyncToken: current.SyncToken };
  if (!Array.isArray(incoming.Line)) {
    merged.Line = current.Line; // header-only change — keep the lines verbatim
    return merged;
  }
  const currentById = new Map((current.Line || []).map((l) => [String(l.Id), l]));
  merged.Line = incoming.Line.map((line) =>
    mergeLine(line.Id != null ? currentById.get(String(line.Id)) : undefined, line));
  return merged;
}

/** Preserved refs present before the write and missing from the same line after it. */
function findDroppedRefs(current, updated) {
  const updatedById = new Map((updated.Line || []).map((l) => [String(l.Id), l]));
  const dropped = { ClassRef: [], TaxCodeRef: [] };
  for (const cur of current.Line || []) {
    const upd = updatedById.get(String(cur.Id));
    if (!upd) continue; // the caller removed this line on purpose
    for (const detailKey of DETAIL_KEYS) {
      const curDetail = cur[detailKey];
      if (!curDetail) continue;
      const updDetail = upd[detailKey] || {};
      for (const refName of PRESERVED_REFS) {
        if (curDetail[refName] && !updDetail[refName]) dropped[refName].push(`Line ${cur.Id}`);
      }
    }
  }
  return dropped;
}

// Automated Sales Tax is on when Preferences.TaxPrefs.PartnerTaxEnabled is
// PRESENT, true or false. Absent means the company is not on AST at all.
function isAutomatedSalesTax(preferences) {
  const taxPrefs = preferences?.TaxPrefs;
  return Boolean(taxPrefs) && Object.prototype.hasOwnProperty.call(taxPrefs, 'PartnerTaxEnabled');
}

// ---------------------------------------------------------------------------
// Vendor credits
// ---------------------------------------------------------------------------

const vendorCreditLineSchema = z.object({
  amount: z.number().nonnegative(),
  description: z.string().optional(),
  account_ref: z.string().optional().describe('Expense account Id.'),
  class_ref: z.string().optional().describe('Class Id, for class tracking.'),
  tax_code_ref: z
    .string()
    .optional()
    .describe('TaxCode Id for this line. Required for fiscally valid credits outside the US.'),
  billable_status: z.enum(['Billable', 'NotBillable', 'HasBeenBilled']).optional(),
  customer_ref: z.string().optional().describe('Customer the line is billable to.'),
}).superRefine((l, ctx) => {
  // QuickBooks rejects a Billable line with no customer — catch it here, where
  // the message can say what to do, rather than as a QBO fault.
  if (l.billable_status === 'Billable' && !l.customer_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "customer_ref is required when billable_status is 'Billable'",
      path: ['customer_ref'],
    });
  }
});

function buildVendorCreditLine(l, idx) {
  return {
    Id: `${idx + 1}`,
    Amount: l.amount,
    Description: l.description,
    DetailType: 'AccountBasedExpenseLineDetail',
    AccountBasedExpenseLineDetail: compact({
      AccountRef: ref(l.account_ref),
      ClassRef: ref(l.class_ref),
      TaxCodeRef: ref(l.tax_code_ref),
      BillableStatus: l.billable_status,
      CustomerRef: ref(l.customer_ref),
    }),
  };
}

export default [
  // ---- bills --------------------------------------------------------------
  tool({
    name: 'create_bill',
    description: 'Create a bill (money owed to a vendor) in QuickBooks Online.',
    label: 'Bill created',
    aliases: ['create-bill'],
    schema: z.object({
      bill: z.object({
        VendorRef: refSchema,
        Line: z.array(billLineSchema).min(1),
        TxnDate: z.string().optional().describe('Bill date (YYYY-MM-DD).'),
        DueDate: z.string().optional(),
        DocNumber: z.string().optional().describe("The vendor's invoice number."),
        PrivateNote: z.string().optional(),
        APAccountRef: refSchema.optional(),
        TotalAmt: z.number().optional(),
      }).passthrough(),
    }),
    run: (ctx, p) => {
      const bill = p.bill;
      // Accept a line-level AccountRef and nest it where QuickBooks expects it.
      // Callers (and the QuickBooks docs' own older examples) write it flat.
      const reshaped = {
        ...bill,
        Line: (bill.Line || []).map((line) => {
          if (line.AccountBasedExpenseLineDetail || line.ItemBasedExpenseLineDetail) return line;
          if (line.AccountRef) {
            const { AccountRef, ...rest } = line;
            return { ...rest, AccountBasedExpenseLineDetail: { AccountRef } };
          }
          return line;
        }),
      };
      return qb(ctx, 'createBill', reshaped);
    },
  }),

  getById({
    name: 'get_bill',
    description: 'Get a bill by Id from QuickBooks Online.',
    method: 'getBill',
    label: 'Bill',
    aliases: ['get-bill'],
  }),

  tool({
    name: 'update_bill',
    description:
      'Update a bill in QuickBooks Online. Pass bill.Id plus only the fields to change — the current '
      + 'bill is read and your changes merged over it, so line-level class and tax coding you omit is '
      + 'preserved. Match an existing line by its Id; a line without an Id is added. SyncToken is '
      + 'optional, the latest is fetched automatically.',
    label: 'Bill updated',
    aliases: ['update-bill'],
    schema: z.object({
      bill: z.object({
        Id: z.string(),
        SyncToken: z.string().optional(),
        Line: z.array(billLineSchema).optional(),
        VendorRef: refSchema.optional(),
        DocNumber: z.string().optional(),
        TxnDate: z.string().optional(),
        DueDate: z.string().optional(),
        PrivateNote: z.string().optional(),
        TotalAmt: z.number().optional(),
      }).passthrough(),
    }),
    // A QBO bill update is a FULL overwrite: any field absent from the payload is
    // deleted server-side. Callers routinely omit line-level ClassRef and
    // TaxCodeRef, which silently strips class and tax tracking and quietly breaks
    // class-based P&L reporting months later. So: read, merge, write, then VERIFY
    // nothing was dropped, and say so loudly if it was.
    run: async (ctx, p) => {
      const bill = p.bill;
      if (!bill?.Id) throw new Error('update_bill requires bill.Id');

      const current = await qb(ctx, 'getBill', String(bill.Id));
      const updated = await qb(ctx, 'updateBill', mergeBill(current, bill));
      const dropped = findDroppedRefs(current, updated);

      // Only fetch Preferences when a TaxCodeRef actually went missing — it
      // decides error-vs-warning, and it is an extra API call on every update
      // otherwise.
      let astEnabled = false;
      if (dropped.TaxCodeRef.length > 0) {
        const preferences = await qb(ctx, 'getPreferences').catch(() => null);
        astEnabled = isAutomatedSalesTax(preferences);
      }

      const lost = [
        ...dropped.ClassRef.map((line) => `${line}: ClassRef`),
        ...(astEnabled ? [] : dropped.TaxCodeRef.map((line) => `${line}: TaxCodeRef`)),
      ];
      if (lost.length > 0) {
        throw Object.assign(
          new Error(
            `Bill ${bill.Id} was updated, but QuickBooks dropped these tracking fields: ${lost.join(', ')}. `
            + "The bill's class or tax coding may now be wrong — check it before relying on any report that uses it.",
          ),
          { partialResult: updated },
        );
      }

      if (astEnabled && dropped.TaxCodeRef.length > 0) {
        return {
          ...updated,
          _warning:
            'Automated Sales Tax is enabled for this company, so QuickBooks removed the line-level '
            + `TaxCodeRef on ${dropped.TaxCodeRef.join(', ')}. That is expected under AST — tax is `
            + 'managed centrally — and the update otherwise succeeded.',
        };
      }
      return updated;
    },
  }),

  deleteById({
    name: 'delete_bill',
    description: 'Delete a bill in QuickBooks Online.',
    method: 'deleteBill',
    getMethod: 'getBill',
    noun: 'bill',
    label: 'Bill deleted',
    aliases: ['delete-bill'],
  }),

  searchPassthrough({
    name: 'search_bills',
    description: 'Search bills in QuickBooks Online.',
    method: 'findBills',
    entity: 'Bill',
    fieldHint: 'Id, VendorRef, TxnDate, DueDate, Balance, TotalAmt, DocNumber, APAccountRef, DepartmentRef',
    label: 'Bills',
  }),

  // ---- purchases (expenses) ----------------------------------------------
  createRaw({
    name: 'create_purchase',
    description:
      'Record a purchase (an expense paid at the time, by card, cheque or cash) in QuickBooks Online. '
      + 'The Purchase object needs AccountRef (what it was paid from), PaymentType and Line[].',
    method: 'createPurchase',
    key: 'purchase',
    label: 'Purchase created',
  }),
  getById({
    name: 'get_purchase',
    description: 'Get a purchase by Id from QuickBooks Online.',
    method: 'getPurchase',
    label: 'Purchase',
  }),
  updateRaw({
    name: 'update_purchase',
    description: 'Update a purchase in QuickBooks Online. Include Id and SyncToken.',
    method: 'updatePurchase',
    key: 'purchase',
    label: 'Purchase updated',
  }),
  deleteById({
    name: 'delete_purchase',
    description: 'Delete a purchase in QuickBooks Online.',
    method: 'deletePurchase',
    getMethod: 'getPurchase',
    noun: 'purchase',
    label: 'Purchase deleted',
  }),
  searchPassthrough({
    name: 'search_purchases',
    description: 'Search purchases (expenses) in QuickBooks Online.',
    method: 'findPurchases',
    entity: 'Purchase',
    fieldHint: 'Id, TxnDate, TotalAmt, AccountRef, EntityRef, PaymentType, DocNumber',
    label: 'Purchases',
  }),

  // ---- purchase orders ----------------------------------------------------
  tool({
    name: 'create_purchase_order',
    description: 'Create a purchase order in QuickBooks Online.',
    label: 'Purchase order created',
    schema: z.object({
      vendor_ref: z.string().min(1).describe('Vendor Id.'),
      line_items: z
        .array(z.object({
          item_ref: z.string().min(1).describe('Item Id.'),
          qty: z.number().positive(),
          unit_price: z.number().nonnegative(),
          description: z.string().optional(),
        }))
        .min(1),
      txn_date: z.string().optional().describe('Order date (YYYY-MM-DD).'),
      doc_number: z.string().optional(),
      private_note: z.string().optional(),
      ship_addr: z.object({
        line1: z.string().optional(),
        city: z.string().optional(),
        country_sub_division_code: z.string().optional().describe('State or province code.'),
        postal_code: z.string().optional(),
      }).optional().describe('Where the goods should be delivered.'),
    }),
    run: (ctx, p) => qb(ctx, 'createPurchaseOrder', compact({
      VendorRef: ref(p.vendor_ref),
      Line: p.line_items.map((l, idx) => compact({
        Id: `${idx + 1}`,
        LineNum: idx + 1,
        Description: l.description || undefined,
        Amount: l.qty * l.unit_price,
        DetailType: 'ItemBasedExpenseLineDetail',
        ItemBasedExpenseLineDetail: {
          ItemRef: ref(l.item_ref),
          Qty: l.qty,
          UnitPrice: l.unit_price,
        },
      })),
      TxnDate: p.txn_date,
      DocNumber: p.doc_number,
      PrivateNote: p.private_note,
      ShipAddr: p.ship_addr
        ? compact({
          Line1: p.ship_addr.line1,
          City: p.ship_addr.city,
          CountrySubDivisionCode: p.ship_addr.country_sub_division_code,
          PostalCode: p.ship_addr.postal_code,
        })
        : undefined,
    })),
  }),
  getById({
    name: 'get_purchase_order',
    description: 'Get a purchase order by Id from QuickBooks Online.',
    method: 'getPurchaseOrder',
    label: 'Purchase order',
  }),
  sparseUpdate({
    name: 'update_purchase_order',
    description: 'Update a purchase order in QuickBooks Online.',
    method: 'updatePurchaseOrder',
    label: 'Purchase order updated',
    schema: z.object({
      ...updateHead('Purchase order'),
      vendor_ref: z.string().optional(),
      private_note: z.string().optional(),
      doc_number: z.string().optional(),
    }),
    map: (p) => compact({
      VendorRef: ref(p.vendor_ref),
      PrivateNote: p.private_note,
      DocNumber: p.doc_number,
    }),
  }),
  deleteById({
    name: 'delete_purchase_order',
    description: 'Delete a purchase order in QuickBooks Online.',
    method: 'deletePurchaseOrder',
    getMethod: 'getPurchaseOrder',
    noun: 'purchase order',
    label: 'Purchase order deleted',
  }),
  searchByOperators({
    name: 'search_purchase_orders',
    description: 'Search purchase orders in QuickBooks Online by vendor and date range.',
    method: 'findPurchaseOrders',
    entity: 'PurchaseOrder',
    label: 'Purchase orders',
    schema: z.object({
      vendor_ref: z.string().optional().describe('Only orders for this vendor Id.'),
      txn_date_from: z.string().optional().describe('On or after this date (YYYY-MM-DD).'),
      txn_date_to: z.string().optional().describe('On or before this date (YYYY-MM-DD).'),
      limit: z.number().int().positive().optional(),
    }),
    filters: [
      ['vendor_ref', 'VendorRef', '='],
      ['txn_date_from', 'TxnDate', '>='],
      ['txn_date_to', 'TxnDate', '<='],
    ],
  }),

  // ---- vendor credits -----------------------------------------------------
  tool({
    name: 'create_vendor_credit',
    description:
      'Create a vendor credit in QuickBooks Online — money a vendor owes back. Supports per-line tax '
      + '(tax_code_ref) and class tracking (class_ref) the same way bills do; for companies on the '
      + 'global tax model, set both those and global_tax_calculation and QuickBooks computes the tax.',
    label: 'Vendor credit created',
    schema: z.object({
      vendor_ref: z.string().min(1).describe('Vendor Id.'),
      line_items: z.array(vendorCreditLineSchema).min(1),
      txn_date: z.string().optional().describe('Credit date (YYYY-MM-DD).'),
      doc_number: z.string().optional(),
      private_note: z.string().optional(),
      global_tax_calculation: globalTaxCalculationSchema.optional(),
    }),
    run: (ctx, p) => qb(ctx, 'createVendorCredit', compact({
      VendorRef: ref(p.vendor_ref),
      Line: p.line_items.map(buildVendorCreditLine),
      TxnDate: p.txn_date,
      DocNumber: p.doc_number,
      PrivateNote: p.private_note,
      GlobalTaxCalculation: p.global_tax_calculation,
    })),
  }),
  getById({
    name: 'get_vendor_credit',
    description: 'Get a vendor credit by Id from QuickBooks Online.',
    method: 'getVendorCredit',
    label: 'Vendor credit',
  }),
  tool({
    name: 'update_vendor_credit',
    description:
      'Update a vendor credit in QuickBooks Online. Supplying line_items REPLACES every existing '
      + 'line — read the credit first if you only mean to change one.',
    label: 'Vendor credit updated',
    schema: z.object({
      ...updateHead('Vendor credit'),
      vendor_ref: z.string().optional(),
      private_note: z.string().optional(),
      line_items: z
        .array(vendorCreditLineSchema)
        .min(1)
        .optional()
        .describe('Full replacement set of lines.'),
      global_tax_calculation: globalTaxCalculationSchema.optional(),
    }),
    run: async (ctx, p) => {
      let payload;
      if (p.line_items) {
        // QBO rejects a sparse update carrying a Line array ("Required parameter
        // VendorRef is missing", error 2020). Read the current entity and merge
        // so nothing the caller didn't mention is lost, dropping the fields
        // QuickBooks recomputes from the new lines.
        const existing = await qb(ctx, 'getVendorCredit', String(p.id));
        const {
          TxnTaxDetail: _tax,   // recomputed from the new lines' tax codes
          TotalAmt: _total,     // derived
          Balance: _balance,    // derived
          MetaData: _meta,      // read-only
          ...base
        } = existing;
        payload = {
          ...base,
          Id: String(p.id),
          SyncToken: String(p.sync_token),
          sparse: false,
          Line: p.line_items.map(buildVendorCreditLine),
        };
      } else {
        payload = { Id: String(p.id), SyncToken: String(p.sync_token), sparse: true };
      }
      if (p.vendor_ref) payload.VendorRef = ref(p.vendor_ref);
      if (p.private_note !== undefined) payload.PrivateNote = p.private_note;
      if (p.global_tax_calculation) payload.GlobalTaxCalculation = p.global_tax_calculation;
      return qb(ctx, 'updateVendorCredit', payload);
    },
  }),
  deleteById({
    name: 'delete_vendor_credit',
    description: 'Delete a vendor credit in QuickBooks Online.',
    method: 'deleteVendorCredit',
    getMethod: 'getVendorCredit',
    noun: 'vendor credit',
    label: 'Vendor credit deleted',
  }),
  searchByOperators({
    name: 'search_vendor_credits',
    description: 'Search vendor credits in QuickBooks Online.',
    method: 'findVendorCredits',
    entity: 'VendorCredit',
    label: 'Vendor credits',
    schema: z.object({
      vendor_ref: z.string().optional().describe('Only credits from this vendor Id.'),
      limit: z.number().int().positive().optional(),
    }),
    filters: [['vendor_ref', 'VendorRef', '=']],
  }),
];
