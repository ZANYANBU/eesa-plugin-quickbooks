// The eleven QuickBooks reports.
//
// Reports are the read tools that actually get asked for — "how did we do last
// quarter", "who owes us money" — so their parameters are worth describing
// properly rather than as bare field names.
import { z } from 'zod';
import { tool, qb, compact } from './registry.js';

const startDate = z.string().optional().describe('Start of the period (YYYY-MM-DD).');
const endDate = z.string().optional().describe('End of the period (YYYY-MM-DD).');
const reportDate = z.string().optional().describe('The date to report as at (YYYY-MM-DD). Defaults to today.');
const accountingMethod = z
  .enum(['Cash', 'Accrual'])
  .optional()
  .describe('Cash counts money when it moves; Accrual counts it when it is earned or owed. Defaults to the company preference.');
const summarizeBy = (extra = []) => z
  .enum(['Total', 'Month', 'Week', 'Days', ...extra])
  .optional()
  .describe('Break the report into columns by period. Total is a single column.');

/** Report tools differ only in their parameter set, so build them from one shape. */
function report({ name, description, method, label, schema, map }) {
  return tool({
    name,
    description,
    label,
    schema,
    run: (ctx, p) => qb(ctx, method, compact(map(p))),
  });
}

export default [
  tool({
    name: 'get_balance_sheet',
    description:
      'Generate a Balance Sheet from QuickBooks Online — assets, liabilities and equity as at a '
      + 'point in time.',
    label: 'Balance sheet',
    schema: z.object({
      start_date: startDate,
      end_date: endDate,
      accounting_method: accountingMethod,
      summarize_column_by: summarizeBy(),
    }),
    run: (ctx, p) => {
      // A balance sheet is a point in time, and QuickBooks silently ignores
      // end_date unless start_date is also present — so a caller who asks for
      // "the balance sheet at 31 December" gets today's figures back without
      // any indication their date was dropped. Supply 1 January of the same
      // year when only end_date is given.
      const params = {};
      if (p.end_date) {
        params.end_date = p.end_date;
        params.start_date = p.start_date || `${p.end_date.substring(0, 4)}-01-01`;
      } else if (p.start_date) {
        params.start_date = p.start_date;
      }
      if (p.accounting_method) params.accounting_method = p.accounting_method;
      if (p.summarize_column_by) params.summarize_column_by = p.summarize_column_by;
      return qb(ctx, 'reportBalanceSheet', params);
    },
  }),

  report({
    name: 'get_profit_and_loss',
    description: 'Generate a Profit and Loss (income statement) from QuickBooks Online.',
    method: 'reportProfitAndLoss',
    label: 'Profit and loss',
    schema: z.object({
      start_date: startDate,
      end_date: endDate,
      accounting_method: accountingMethod,
      summarize_column_by: summarizeBy(['Classes']),
      customer: z.string().optional().describe('Limit to one customer Id.'),
      vendor: z.string().optional().describe('Limit to one vendor Id.'),
      item: z.string().optional().describe('Limit to one item Id.'),
      department: z.string().optional().describe('Limit to one department Id.'),
      class: z.string().optional().describe('Limit to one class Id.'),
    }),
    map: (p) => ({
      start_date: p.start_date,
      end_date: p.end_date,
      accounting_method: p.accounting_method,
      summarize_column_by: p.summarize_column_by,
      customer: p.customer,
      vendor: p.vendor,
      item: p.item,
      department: p.department,
      class: p.class,
    }),
  }),

  report({
    name: 'get_cash_flow',
    description: 'Generate a Statement of Cash Flows from QuickBooks Online.',
    method: 'reportCashFlow',
    label: 'Cash flow',
    schema: z.object({
      start_date: startDate,
      end_date: endDate,
      summarize_column_by: summarizeBy(),
    }),
    map: (p) => ({
      start_date: p.start_date,
      end_date: p.end_date,
      summarize_column_by: p.summarize_column_by,
    }),
  }),

  report({
    name: 'get_trial_balance',
    description: 'Generate a Trial Balance from QuickBooks Online — the debit and credit balance of every account.',
    method: 'reportTrialBalance',
    label: 'Trial balance',
    schema: z.object({
      start_date: startDate,
      end_date: endDate,
      accounting_method: accountingMethod,
    }),
    map: (p) => ({
      start_date: p.start_date,
      end_date: p.end_date,
      accounting_method: p.accounting_method,
    }),
  }),

  report({
    name: 'get_general_ledger',
    description:
      'Generate a General Ledger from QuickBooks Online — every transaction, by account, with a '
      + 'running balance. This can be very large; narrow it with a date range and an account.',
    method: 'reportGeneralLedgerDetail',
    label: 'General ledger',
    schema: z.object({
      start_date: startDate,
      end_date: endDate,
      accounting_method: accountingMethod,
      account: z.string().optional().describe('Limit to one account Id.'),
      source_account: z.string().optional().describe('Limit to transactions originating in this account.'),
      sort_by: z.string().optional().describe('Field to sort by.'),
    }),
    map: (p) => ({
      start_date: p.start_date,
      end_date: p.end_date,
      accounting_method: p.accounting_method,
      account: p.account,
      source_account: p.source_account,
      sort_by: p.sort_by,
    }),
  }),

  report({
    name: 'get_customer_sales',
    description: 'Generate a Sales by Customer report from QuickBooks Online.',
    method: 'reportCustomerSales',
    label: 'Customer sales',
    schema: z.object({
      start_date: startDate,
      end_date: endDate,
      customer: z.string().optional().describe('Limit to one customer Id.'),
      summarize_column_by: summarizeBy(),
    }),
    map: (p) => ({
      start_date: p.start_date,
      end_date: p.end_date,
      customer: p.customer,
      summarize_column_by: p.summarize_column_by,
    }),
  }),

  report({
    name: 'get_aged_receivables',
    description:
      'Generate an A/R Ageing report from QuickBooks Online — unpaid customer invoices bucketed by '
      + 'how overdue they are.',
    method: 'reportAgedReceivables',
    label: 'Aged receivables',
    schema: z.object({
      report_date: reportDate,
      customer: z.string().optional().describe('Limit to one customer Id.'),
      aging_method: z
        .enum(['Current', 'Report_Date'])
        .optional()
        .describe('Age from the due date (Current) or from the report date (Report_Date).'),
      days_per_aging_period: z.number().int().positive().optional().describe('Bucket width in days. Default 30.'),
      num_periods: z.number().int().positive().optional().describe('Number of buckets. Default 4.'),
    }),
    map: (p) => ({
      report_date: p.report_date,
      customer: p.customer,
      aging_method: p.aging_method,
      days_per_aging_period: p.days_per_aging_period,
      num_periods: p.num_periods,
    }),
  }),

  report({
    name: 'get_customer_balance',
    description: 'Generate a Customer Balance report from QuickBooks Online — what each customer currently owes.',
    method: 'reportCustomerBalance',
    label: 'Customer balances',
    schema: z.object({
      report_date: reportDate,
      customer: z.string().optional().describe('Limit to one customer Id.'),
      summarize_column_by: summarizeBy(),
    }),
    map: (p) => ({
      report_date: p.report_date,
      customer: p.customer,
      summarize_column_by: p.summarize_column_by,
    }),
  }),

  report({
    name: 'get_aged_payables',
    description:
      'Generate an A/P Ageing report from QuickBooks Online — unpaid vendor bills bucketed by how '
      + 'overdue they are.',
    method: 'reportAgedPayables',
    label: 'Aged payables',
    schema: z.object({
      report_date: reportDate,
      vendor: z.string().optional().describe('Limit to one vendor Id.'),
      aging_method: z
        .enum(['Current', 'Report_Date'])
        .optional()
        .describe('Age from the due date (Current) or from the report date (Report_Date).'),
      days_per_aging_period: z.number().int().positive().optional().describe('Bucket width in days. Default 30.'),
      num_periods: z.number().int().positive().optional().describe('Number of buckets. Default 4.'),
    }),
    map: (p) => ({
      report_date: p.report_date,
      vendor: p.vendor,
      aging_method: p.aging_method,
      days_per_aging_period: p.days_per_aging_period,
      num_periods: p.num_periods,
    }),
  }),

  report({
    name: 'get_vendor_expenses',
    description: 'Generate an Expenses by Vendor report from QuickBooks Online.',
    method: 'reportVendorExpenses',
    label: 'Vendor expenses',
    schema: z.object({
      start_date: startDate,
      end_date: endDate,
      vendor: z.string().optional().describe('Limit to one vendor Id.'),
      summarize_column_by: summarizeBy(),
      accounting_method: accountingMethod,
    }),
    map: (p) => ({
      start_date: p.start_date,
      end_date: p.end_date,
      vendor: p.vendor,
      summarize_column_by: p.summarize_column_by,
      accounting_method: p.accounting_method,
    }),
  }),

  report({
    name: 'get_vendor_balance',
    description: 'Generate a Vendor Balance report from QuickBooks Online — what the company currently owes each vendor.',
    method: 'reportVendorBalance',
    label: 'Vendor balances',
    schema: z.object({
      report_date: reportDate,
      vendor: z.string().optional().describe('Limit to one vendor Id.'),
      summarize_column_by: summarizeBy(),
    }),
    map: (p) => ({
      report_date: p.report_date,
      vendor: p.vendor,
      summarize_column_by: p.summarize_column_by,
    }),
  }),
];
