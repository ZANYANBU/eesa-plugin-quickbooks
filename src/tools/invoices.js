// Invoices — create, read, search, update, delete (void) and PDF.
import { z } from 'zod';
import {
  tool, qb, queryRows, getById, searchByCriteria,
  ref, compact, salesLineItemSchema, salesLines, globalTaxCalculationSchema,
} from './registry.js';
import { criteriaValidator } from '../criteria.js';

// Primitive fields QuickBooks is fussy about receiving as the declared type.
// Ported from create-quickbooks-invoice.handler.ts.
const FIELD_TYPES = {
  DocNumber: 'string',
  TxnDate: 'string',
  PrivateNote: 'string',
  GlobalTaxCalculation: 'string',
  ApplyTaxAfterDiscount: 'boolean',
  TotalAmt: 'number',
};

function normalizeFields(obj) {
  const out = { ...obj };
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    switch (FIELD_TYPES[key]) {
      case 'string': out[key] = String(value); break;
      case 'number': out[key] = typeof value === 'number' ? value : Number(value); break;
      case 'boolean': out[key] = typeof value === 'boolean' ? value : value === 'true'; break;
      default: break;
    }
  }
  return out;
}

const linkedTxnSchema = z.object({
  txn_id: z.string().min(1).describe('Id of the transaction to link.'),
  txn_type: z.string().min(1).describe('Type of the linked transaction, e.g. Estimate.'),
});

const searchValidator = criteriaValidator({
  filterFields: [
    'Id', 'MetaData.CreateTime', 'MetaData.LastUpdatedTime', 'DocNumber', 'TxnDate',
    'DueDate', 'CustomerRef', 'ClassRef', 'DepartmentRef', 'Balance', 'TotalAmt',
  ],
  sortFields: [
    'Id', 'MetaData.CreateTime', 'MetaData.LastUpdatedTime', 'DocNumber', 'TxnDate',
    'Balance', 'TotalAmt',
  ],
  types: {
    Id: 'string',
    'MetaData.CreateTime': 'date',
    'MetaData.LastUpdatedTime': 'date',
    DocNumber: 'string',
    TxnDate: 'date',
    DueDate: 'date',
    CustomerRef: 'string',
    ClassRef: 'string',
    DepartmentRef: 'string',
    Balance: 'number',
    TotalAmt: 'number',
  },
});

// QBO invoice PDFs run 25-100 KB in practice. The cap exists so a
// pathological response cannot balloon the process heap — and, here, so a
// single tenant cannot do that to every other tenant sharing the container.
const DEFAULT_MAX_PDF_BYTES = 8 * 1024 * 1024;
function maxPdfBytes() {
  const parsed = Number.parseInt(process.env.QBO_PDF_MAX_BYTES || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PDF_BYTES;
}

export default [
  tool({
    name: 'create_invoice',
    description: 'Create an invoice in QuickBooks Online.',
    label: 'Invoice created',
    schema: z.object({
      customer_ref: z.string().min(1).describe('Customer Id (use search_customers).'),
      line_items: z.array(salesLineItemSchema).min(1),
      doc_number: z.string().optional().describe('Invoice number. QuickBooks assigns one if omitted.'),
      txn_date: z.string().optional().describe('Invoice date (YYYY-MM-DD).'),
      linked_txn: z.array(linkedTxnSchema).optional().describe('Transactions to link, e.g. an accepted estimate.'),
      global_tax_calculation: globalTaxCalculationSchema.optional(),
      customer_memo: z.string().min(1).optional().describe('Customer-facing message printed on the invoice.'),
      sales_term_ref: z
        .string()
        .min(1)
        .optional()
        .describe('Sales term Id (use search_terms), e.g. Net 30. Falls back to the customer default.'),
      bill_email: z
        .string()
        .min(1)
        .optional()
        .describe('Billing email address. Falls back to the customer default.'),
    }),
    run: (ctx, p) => {
      const payload = compact({
        CustomerRef: ref(p.customer_ref),
        Line: salesLines(p.line_items),
        DocNumber: p.doc_number,
        TxnDate: p.txn_date,
        LinkedTxn: p.linked_txn?.map((lt) => ({ TxnId: lt.txn_id, TxnType: lt.txn_type })),
        CustomerMemo: p.customer_memo ? { value: p.customer_memo } : undefined,
        SalesTermRef: ref(p.sales_term_ref),
        BillEmail: p.bill_email ? { Address: p.bill_email } : undefined,
        GlobalTaxCalculation: p.global_tax_calculation,
      });
      return qb(ctx, 'createInvoice', normalizeFields(payload));
    },
  }),

  getById({
    name: 'read_invoice',
    description: 'Read a single invoice from QuickBooks Online by its Id.',
    method: 'getInvoice',
    idField: 'invoice_id',
    label: 'Invoice',
  }),

  searchByCriteria({
    name: 'search_invoices',
    description:
      'Search invoices in QuickBooks Online. Filter on Id, DocNumber, TxnDate, DueDate, '
      + 'CustomerRef, ClassRef, DepartmentRef, Balance or TotalAmt.',
    method: 'findInvoices',
    entity: 'Invoice',
    validate: searchValidator,
    label: 'Invoices',
  }),

  tool({
    name: 'update_invoice',
    description:
      'Update an existing invoice by Id. Reads the current invoice for its SyncToken, then '
      + 'applies your patch as a sparse update, so fields you omit are left alone.',
    label: 'Invoice updated',
    schema: z.object({
      invoice_id: z.string().min(1).describe('Invoice Id.'),
      patch: z
        .record(z.any())
        .describe('QuickBooks Invoice fields to change, e.g. { "DueDate": "2026-09-30" }.'),
    }),
    run: async (ctx, p) => {
      const existing = await qb(ctx, 'getInvoice', String(p.invoice_id));
      return qb(ctx, 'updateInvoice', { ...existing, ...p.patch, Id: String(p.invoice_id), sparse: true });
    },
  }),

  tool({
    name: 'delete_invoice',
    description:
      'Delete an invoice in QuickBooks Online. QuickBooks does not truly delete invoices — if the '
      + 'delete is refused, the invoice is voided instead (zeroed and marked Voided), which preserves '
      + 'the audit trail and the document number.',
    label: 'Invoice deleted or voided',
    schema: z.object({
      idOrEntity: z.any().describe('The invoice Id, or the full invoice object including Id and SyncToken.'),
    }),
    run: async (ctx, p) => {
      const given = p.idOrEntity;
      try {
        return await qb(ctx, 'deleteInvoice', given);
      } catch (deleteError) {
        const invoice = given && typeof given === 'object' && given.Id
          ? given
          : await qb(ctx, 'getInvoice', String(given)).catch(() => null);
        if (!invoice?.Id) throw deleteError;
        return qb(ctx, 'voidInvoice', {
          Id: invoice.Id,
          SyncToken: invoice.SyncToken,
          sparse: true,
          PrivateNote: 'Voided via Eesa',
        });
      }
    },
  }),

  tool({
    name: 'get_invoice_pdf',
    description:
      'Download a QuickBooks Online invoice as a PDF. Returns the bytes base64-encoded.',
    label: 'Invoice PDF',
    schema: z.object({
      invoice_id: z.string().min(1).describe('Invoice Id.'),
    }),
    // Upstream also offers an `output_path` that writes the PDF to disk, guarded
    // by an allowlist directory. That option is meaningful for a stdio server
    // sharing a filesystem with the person asking; here the only filesystem is
    // the container's own, which the user cannot reach and we should not be
    // writing tenant documents into. Base64 only.
    run: async (ctx, p) => {
      const pdf = await qb(ctx, 'getInvoicePdf', String(p.invoice_id));
      const buffer = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf || '');
      const cap = maxPdfBytes();
      if (buffer.length > cap) {
        throw new Error(
          `The PDF is ${buffer.length} bytes, over the ${cap}-byte limit for an inline response `
          + '(raise QBO_PDF_MAX_BYTES if this is legitimate).',
        );
      }
      return {
        invoice_id: String(p.invoice_id),
        content_type: 'application/pdf',
        bytes: buffer.length,
        base64: buffer.toString('base64'),
      };
    },
  }),
];

export { queryRows };
