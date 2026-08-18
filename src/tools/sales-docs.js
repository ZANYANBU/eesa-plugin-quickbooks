// Sales documents other than invoices: estimates, credit memos, sales receipts
// and refund receipts.
//
// The four share a body (a customer, item lines, an optional tax treatment) and
// differ mainly in what they mean: an estimate is a quote, a credit memo owes
// the customer money, a sales receipt is a sale already paid for, a refund
// receipt is money going back out.
import { z } from 'zod';
import {
  tool, qb, getById, deleteById, sparseUpdate, updateHead, searchByOperators,
  searchPassthrough, createRaw, updateRaw,
  ref, compact, salesLineItemSchema, salesLines, globalTaxCalculationSchema,
} from './registry.js';

/** create_* for a customer-facing sales document built from item lines. */
function createSalesDoc({ name, description, method, label, withPayment = false }) {
  const shape = {
    customer_ref: z.string().min(1).describe('Customer Id (use search_customers).'),
    line_items: z.array(salesLineItemSchema).min(1),
    txn_date: z.string().optional().describe('Transaction date (YYYY-MM-DD).'),
    doc_number: z.string().optional().describe('Document number. QuickBooks assigns one if omitted.'),
    private_note: z.string().optional().describe('Internal memo, not shown to the customer.'),
    global_tax_calculation: globalTaxCalculationSchema.optional(),
  };
  if (withPayment) {
    shape.payment_method_ref = z.string().optional().describe('Payment method Id (use search_payment_methods).');
    shape.deposit_to_account_ref = z
      .string()
      .optional()
      .describe('Id of the account the money moves through (use search_accounts).');
  }
  return tool({
    name,
    description,
    label,
    schema: z.object(shape),
    run: (ctx, p) => qb(ctx, method, compact({
      CustomerRef: ref(p.customer_ref),
      Line: salesLines(p.line_items),
      TxnDate: p.txn_date,
      DocNumber: p.doc_number,
      PrivateNote: p.private_note,
      GlobalTaxCalculation: p.global_tax_calculation,
      PaymentMethodRef: ref(p.payment_method_ref),
      DepositToAccountRef: ref(p.deposit_to_account_ref),
    })),
  });
}

/** update_* for a sales document — QBO accepts a sparse update on all four. */
function updateSalesDoc({ name, description, method, noun, label }) {
  return sparseUpdate({
    name,
    description,
    method,
    label,
    schema: z.object({
      ...updateHead(noun),
      customer_ref: z.string().optional().describe('Move the document to a different customer.'),
      private_note: z.string().optional(),
      doc_number: z.string().optional(),
    }),
    map: (p) => compact({
      CustomerRef: ref(p.customer_ref),
      PrivateNote: p.private_note,
      DocNumber: p.doc_number,
    }),
  });
}

/** search_* by customer and date range — the array-criteria form. */
function searchSalesDoc({ name, description, method, entity, label }) {
  return searchByOperators({
    name,
    description,
    method,
    entity,
    label,
    schema: z.object({
      customer_ref: z.string().optional().describe('Only records for this customer Id.'),
      txn_date_from: z.string().optional().describe('On or after this date (YYYY-MM-DD).'),
      txn_date_to: z.string().optional().describe('On or before this date (YYYY-MM-DD).'),
      limit: z.number().int().positive().optional().describe('Maximum records to return.'),
    }),
    filters: [
      ['customer_ref', 'CustomerRef', '='],
      ['txn_date_from', 'TxnDate', '>='],
      ['txn_date_to', 'TxnDate', '<='],
    ],
  });
}

export default [
  // ---- estimates ----------------------------------------------------------
  createRaw({
    name: 'create_estimate',
    description:
      'Create an estimate (quote) in QuickBooks Online. Accepts a raw QBO Estimate object. Per-line '
      + 'tax codes go in Line[].SalesItemLineDetail.TaxCodeRef.',
    method: 'createEstimate',
    key: 'estimate',
    label: 'Estimate created',
  }),
  getById({
    name: 'get_estimate',
    description: 'Get an estimate by Id from QuickBooks Online.',
    method: 'getEstimate',
    label: 'Estimate',
  }),
  updateRaw({
    name: 'update_estimate',
    description: 'Update an estimate in QuickBooks Online. Include Id and SyncToken.',
    method: 'updateEstimate',
    key: 'estimate',
    label: 'Estimate updated',
  }),
  deleteById({
    name: 'delete_estimate',
    description: 'Delete an estimate in QuickBooks Online.',
    method: 'deleteEstimate',
    getMethod: 'getEstimate',
    noun: 'estimate',
    label: 'Estimate deleted',
  }),
  searchPassthrough({
    name: 'search_estimates',
    description: 'Search estimates in QuickBooks Online.',
    method: 'findEstimates',
    entity: 'Estimate',
    fieldHint: 'Id, DocNumber, TxnDate, TxnStatus, CustomerRef, TotalAmt, MetaData.LastUpdatedTime',
    label: 'Estimates',
  }),

  // ---- credit memos -------------------------------------------------------
  createSalesDoc({
    name: 'create_credit_memo',
    description:
      'Create a credit memo in QuickBooks Online — a credit the customer can apply against future '
      + 'invoices. Use a refund receipt instead when money is actually paid back.',
    method: 'createCreditMemo',
    label: 'Credit memo created',
  }),
  getById({
    name: 'get_credit_memo',
    description: 'Get a credit memo by Id from QuickBooks Online.',
    method: 'getCreditMemo',
    label: 'Credit memo',
  }),
  updateSalesDoc({
    name: 'update_credit_memo',
    description: 'Update a credit memo in QuickBooks Online.',
    method: 'updateCreditMemo',
    noun: 'Credit memo',
    label: 'Credit memo updated',
  }),
  deleteById({
    name: 'delete_credit_memo',
    description: 'Delete a credit memo in QuickBooks Online.',
    method: 'deleteCreditMemo',
    getMethod: 'getCreditMemo',
    noun: 'credit memo',
    label: 'Credit memo deleted',
  }),
  searchSalesDoc({
    name: 'search_credit_memos',
    description: 'Search credit memos in QuickBooks Online by customer and date range.',
    method: 'findCreditMemos',
    entity: 'CreditMemo',
    label: 'Credit memos',
  }),

  // ---- sales receipts -----------------------------------------------------
  createSalesDoc({
    name: 'create_sales_receipt',
    description:
      'Create a sales receipt in QuickBooks Online — a sale that was paid at the time it was made, '
      + 'so no invoice or payment is needed.',
    method: 'createSalesReceipt',
    label: 'Sales receipt created',
    withPayment: true,
  }),
  getById({
    name: 'get_sales_receipt',
    description: 'Get a sales receipt by Id from QuickBooks Online.',
    method: 'getSalesReceipt',
    label: 'Sales receipt',
  }),
  updateSalesDoc({
    name: 'update_sales_receipt',
    description: 'Update a sales receipt in QuickBooks Online.',
    method: 'updateSalesReceipt',
    noun: 'Sales receipt',
    label: 'Sales receipt updated',
  }),
  deleteById({
    name: 'delete_sales_receipt',
    description: 'Delete a sales receipt in QuickBooks Online.',
    method: 'deleteSalesReceipt',
    getMethod: 'getSalesReceipt',
    noun: 'sales receipt',
    label: 'Sales receipt deleted',
  }),
  searchSalesDoc({
    name: 'search_sales_receipts',
    description: 'Search sales receipts in QuickBooks Online by customer and date range.',
    method: 'findSalesReceipts',
    entity: 'SalesReceipt',
    label: 'Sales receipts',
  }),

  // ---- refund receipts ----------------------------------------------------
  createSalesDoc({
    name: 'create_refund_receipt',
    description:
      'Create a refund receipt in QuickBooks Online — money actually returned to a customer. '
      + 'deposit_to_account_ref is the account the refund is paid from.',
    method: 'createRefundReceipt',
    label: 'Refund receipt created',
    withPayment: true,
  }),
  getById({
    name: 'get_refund_receipt',
    description: 'Get a refund receipt by Id from QuickBooks Online.',
    method: 'getRefundReceipt',
    label: 'Refund receipt',
  }),
  updateSalesDoc({
    name: 'update_refund_receipt',
    description: 'Update a refund receipt in QuickBooks Online.',
    method: 'updateRefundReceipt',
    noun: 'Refund receipt',
    label: 'Refund receipt updated',
  }),
  deleteById({
    name: 'delete_refund_receipt',
    description: 'Delete a refund receipt in QuickBooks Online.',
    method: 'deleteRefundReceipt',
    getMethod: 'getRefundReceipt',
    noun: 'refund receipt',
    label: 'Refund receipt deleted',
  }),
  searchSalesDoc({
    name: 'search_refund_receipts',
    description: 'Search refund receipts in QuickBooks Online by customer and date range.',
    method: 'findRefundReceipts',
    entity: 'RefundReceipt',
    label: 'Refund receipts',
  }),
];
