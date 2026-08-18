// Journal entries and time tracking.
import { z } from 'zod';
import {
  tool, qb, getById, deleteById, sparseUpdate, updateHead,
  searchByOperators, searchPassthrough, createRaw, updateRaw, ref, compact,
} from './registry.js';

const refSchema = z.object({ value: z.string(), name: z.string().optional() });

// .passthrough() throughout so valid QBO fields this schema doesn't model —
// Entity (for A/R and A/P lines), Adjustment, CurrencyRef/ExchangeRate,
// TxnTaxDetail, custom fields — reach the API instead of being silently dropped.
const journalLineSchema = z.object({
  Id: z.string().optional().describe('Existing line Id, when updating.'),
  Amount: z.number(),
  DetailType: z.literal('JournalEntryLineDetail'),
  Description: z
    .string()
    .optional()
    .describe('Line description. Must sit at Line level, NOT inside JournalEntryLineDetail.'),
  JournalEntryLineDetail: z.object({
    PostingType: z.enum(['Debit', 'Credit']),
    AccountRef: refSchema,
    ClassRef: refSchema.optional(),
    DepartmentRef: refSchema.optional(),
  }).passthrough(),
}).passthrough();

const journalEntryShape = z.object({
  TxnDate: z.string().describe('Entry date (YYYY-MM-DD).'),
  PrivateNote: z.string().optional().describe('Memo for the entry.'),
  DocNumber: z.string().optional().describe('Journal number.'),
  Line: z.array(journalLineSchema).describe('Debits and credits. Totals must balance.'),
}).passthrough();

export default [
  // ---- journal entries ----------------------------------------------------
  createRaw({
    name: 'create_journal_entry',
    description:
      'Create a journal entry in QuickBooks Online. Total debits must equal total credits. Note that '
      + 'a line description belongs at Line level, not inside JournalEntryLineDetail.',
    method: 'createJournalEntry',
    key: 'journalEntry',
    shape: journalEntryShape,
    label: 'Journal entry created',
  }),
  getById({
    name: 'get_journal_entry',
    description: 'Get a journal entry by Id from QuickBooks Online.',
    method: 'getJournalEntry',
    label: 'Journal entry',
  }),
  updateRaw({
    name: 'update_journal_entry',
    description: 'Update a journal entry in QuickBooks Online. Include Id and SyncToken.',
    method: 'updateJournalEntry',
    key: 'journalEntry',
    shape: journalEntryShape.partial({ TxnDate: true, Line: true }).extend({
      Id: z.string().describe('Journal entry Id.'),
      SyncToken: z.string().describe('SyncToken from the latest read.'),
      sparse: z.boolean().optional(),
    }),
    label: 'Journal entry updated',
  }),
  deleteById({
    name: 'delete_journal_entry',
    description: 'Delete a journal entry in QuickBooks Online.',
    method: 'deleteJournalEntry',
    getMethod: 'getJournalEntry',
    noun: 'journal entry',
    label: 'Journal entry deleted',
  }),
  searchPassthrough({
    name: 'search_journal_entries',
    description: 'Search journal entries in QuickBooks Online.',
    method: 'findJournalEntries',
    entity: 'JournalEntry',
    fieldHint: 'Id, TxnDate, DocNumber, PrivateNote, Adjustment, TotalAmt',
    label: 'Journal entries',
  }),

  // ---- time activities ----------------------------------------------------
  tool({
    name: 'create_time_activity',
    description:
      'Record a time activity (a time-tracking entry) in QuickBooks Online. Give either hours and '
      + 'minutes, or start_time and end_time.',
    label: 'Time activity created',
    schema: z.object({
      name_of: z.enum(['Vendor', 'Employee']).describe('Whose time this is.'),
      vendor_ref: z.string().optional().describe('Vendor Id, when name_of is Vendor.'),
      employee_ref: z.string().optional().describe('Employee Id, when name_of is Employee.'),
      customer_ref: z.string().optional().describe('Customer to bill the time to.'),
      item_ref: z.string().optional().describe('Service item Id representing the work done.'),
      hours: z.number().optional(),
      minutes: z.number().optional(),
      start_time: z.string().optional().describe('ISO 8601 start timestamp.'),
      end_time: z.string().optional().describe('ISO 8601 end timestamp.'),
      txn_date: z.string().optional().describe('Date the work was done (YYYY-MM-DD).'),
      description: z.string().optional().describe('What was done.'),
      billable_status: z.enum(['Billable', 'NotBillable', 'HasBeenBilled']).optional(),
      hourly_rate: z.number().optional(),
    }),
    run: (ctx, p) => qb(ctx, 'createTimeActivity', compact({
      NameOf: p.name_of,
      VendorRef: ref(p.vendor_ref),
      EmployeeRef: ref(p.employee_ref),
      CustomerRef: ref(p.customer_ref),
      ItemRef: ref(p.item_ref),
      Hours: p.hours,
      Minutes: p.minutes,
      StartTime: p.start_time,
      EndTime: p.end_time,
      TxnDate: p.txn_date,
      Description: p.description,
      BillableStatus: p.billable_status,
      HourlyRate: p.hourly_rate,
    })),
  }),
  getById({
    name: 'get_time_activity',
    description: 'Get a time activity by Id from QuickBooks Online.',
    method: 'getTimeActivity',
    label: 'Time activity',
  }),
  sparseUpdate({
    name: 'update_time_activity',
    description: 'Update a time activity in QuickBooks Online.',
    method: 'updateTimeActivity',
    label: 'Time activity updated',
    schema: z.object({
      ...updateHead('Time activity'),
      hours: z.number().optional(),
      minutes: z.number().optional(),
      description: z.string().optional(),
      billable_status: z.enum(['Billable', 'NotBillable', 'HasBeenBilled']).optional(),
      item_ref: z.string().optional().describe('Service item Id for this entry.'),
    }),
    map: (p) => compact({
      Hours: p.hours,
      Minutes: p.minutes,
      Description: p.description,
      BillableStatus: p.billable_status,
      ItemRef: ref(p.item_ref),
    }),
  }),
  deleteById({
    name: 'delete_time_activity',
    description: 'Delete a time activity in QuickBooks Online.',
    method: 'deleteTimeActivity',
    getMethod: 'getTimeActivity',
    noun: 'time activity',
    label: 'Time activity deleted',
  }),
  searchByOperators({
    name: 'search_time_activities',
    description: 'Search time activities in QuickBooks Online by person, customer and date range.',
    method: 'findTimeActivities',
    entity: 'TimeActivity',
    label: 'Time activities',
    schema: z.object({
      employee_ref: z.string().optional().describe('Only entries for this employee Id.'),
      vendor_ref: z.string().optional().describe('Only entries for this vendor Id.'),
      customer_ref: z.string().optional().describe('Only entries billed to this customer Id.'),
      txn_date_from: z.string().optional().describe('On or after this date (YYYY-MM-DD).'),
      txn_date_to: z.string().optional().describe('On or before this date (YYYY-MM-DD).'),
      limit: z.number().int().positive().optional(),
    }),
    filters: [
      ['employee_ref', 'EmployeeRef', '='],
      ['vendor_ref', 'VendorRef', '='],
      ['customer_ref', 'CustomerRef', '='],
      ['txn_date_from', 'TxnDate', '>='],
      ['txn_date_to', 'TxnDate', '<='],
    ],
  }),
];
