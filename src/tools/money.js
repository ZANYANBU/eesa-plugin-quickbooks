// Money moving: customer payments, bill payments, bank deposits and transfers.
import { z } from 'zod';
import {
  tool, qb, getById, deleteById, sparseUpdate, updateHead, searchByOperators,
  searchPassthrough, createRaw, updateRaw, ref, compact,
} from './registry.js';

const linkedTxnSchema = z.object({
  txn_id: z.string().min(1).describe('Id of the transaction being paid.'),
  txn_type: z.string().min(1).describe('Type of that transaction, usually Invoice.'),
});

/** Date-range-only search, used by deposits and transfers. */
function searchByDate({ name, description, method, entity, label }) {
  return searchByOperators({
    name,
    description,
    method,
    entity,
    label,
    schema: z.object({
      txn_date_from: z.string().optional().describe('On or after this date (YYYY-MM-DD).'),
      txn_date_to: z.string().optional().describe('On or before this date (YYYY-MM-DD).'),
      limit: z.number().int().positive().optional().describe('Maximum records to return.'),
    }),
    filters: [
      ['txn_date_from', 'TxnDate', '>='],
      ['txn_date_to', 'TxnDate', '<='],
    ],
  });
}

export default [
  // ---- customer payments --------------------------------------------------
  tool({
    name: 'create_payment',
    description:
      'Record a payment received from a customer in QuickBooks Online. Supply `line` to apply the '
      + 'payment against specific invoices; omit it and QuickBooks leaves the money unapplied as a '
      + 'credit on the customer.',
    label: 'Payment recorded',
    schema: z.object({
      customer_ref: z.string().min(1).describe('Customer Id.'),
      total_amt: z.number().positive().describe('Total amount received.'),
      payment_method_ref: z.string().optional().describe('Payment method Id (use search_payment_methods).'),
      deposit_to_account_ref: z.string().optional().describe('Account the money was deposited into.'),
      txn_date: z.string().optional().describe('Payment date (YYYY-MM-DD).'),
      private_note: z.string().optional().describe('Internal memo.'),
      payment_ref_num: z.string().optional().describe('Reference number, e.g. a cheque or bank transfer number.'),
      currency_ref: z
        .string()
        .optional()
        .describe('Currency code (e.g. USD, GBP). Required when the company has multicurrency enabled.'),
      exchange_rate: z
        .number()
        .positive()
        .optional()
        .describe('Home-currency units per unit of currency_ref. Multicurrency companies only.'),
      line: z
        .array(z.object({
          amount: z.number().describe('Amount to apply to this transaction.'),
          linked_txn: z.array(linkedTxnSchema).min(1),
        }))
        .optional()
        .describe('How to apply the payment across invoices.'),
    }),
    run: (ctx, p) => qb(ctx, 'createPayment', compact({
      CustomerRef: ref(p.customer_ref),
      TotalAmt: p.total_amt,
      PaymentMethodRef: ref(p.payment_method_ref),
      DepositToAccountRef: ref(p.deposit_to_account_ref),
      TxnDate: p.txn_date,
      PrivateNote: p.private_note,
      PaymentRefNum: p.payment_ref_num,
      CurrencyRef: ref(p.currency_ref),
      ExchangeRate: p.exchange_rate,
      Line: p.line?.map((l) => ({
        Amount: l.amount,
        LinkedTxn: l.linked_txn.map((lt) => ({ TxnId: lt.txn_id, TxnType: lt.txn_type })),
      })),
    })),
  }),
  getById({
    name: 'get_payment',
    description: 'Get a single customer payment by Id from QuickBooks Online.',
    method: 'getPayment',
    label: 'Payment',
  }),
  sparseUpdate({
    name: 'update_payment',
    description: 'Update a customer payment in QuickBooks Online.',
    method: 'updatePayment',
    label: 'Payment updated',
    schema: z.object({
      ...updateHead('Payment'),
      customer_ref: z.string().optional(),
      total_amt: z.number().optional(),
      payment_method_ref: z.string().optional(),
      private_note: z.string().optional(),
    }),
    map: (p) => compact({
      CustomerRef: ref(p.customer_ref),
      TotalAmt: p.total_amt,
      PaymentMethodRef: ref(p.payment_method_ref),
      PrivateNote: p.private_note,
    }),
  }),
  deleteById({
    name: 'delete_payment',
    description: 'Delete a customer payment in QuickBooks Online. Any invoices it was applied to become unpaid again.',
    method: 'deletePayment',
    getMethod: 'getPayment',
    noun: 'payment',
    label: 'Payment deleted',
  }),
  searchByOperators({
    name: 'search_payments',
    description: 'Search customer payments in QuickBooks Online by customer and date range.',
    method: 'findPayments',
    entity: 'Payment',
    label: 'Payments',
    schema: z.object({
      customer_ref: z.string().optional().describe('Only payments from this customer Id.'),
      txn_date_from: z.string().optional().describe('On or after this date (YYYY-MM-DD).'),
      txn_date_to: z.string().optional().describe('On or before this date (YYYY-MM-DD).'),
      limit: z.number().int().positive().optional(),
    }),
    filters: [
      ['customer_ref', 'CustomerRef', '='],
      ['txn_date_from', 'TxnDate', '>='],
      ['txn_date_to', 'TxnDate', '<='],
    ],
  }),

  // ---- bill payments ------------------------------------------------------
  createRaw({
    name: 'create_bill_payment',
    description:
      'Pay one or more vendor bills in QuickBooks Online. The BillPayment object needs VendorRef, '
      + 'TotalAmt, PayType (Check or CreditCard) with the matching CheckPayment/CreditCardPayment '
      + 'block, and Line[] linking the bills being paid.',
    method: 'createBillPayment',
    key: 'billPayment',
    label: 'Bill payment created',
  }),
  getById({
    name: 'get_bill_payment',
    description: 'Get a bill payment by Id from QuickBooks Online.',
    method: 'getBillPayment',
    label: 'Bill payment',
  }),
  updateRaw({
    name: 'update_bill_payment',
    description: 'Update a bill payment in QuickBooks Online. Include Id and SyncToken.',
    method: 'updateBillPayment',
    key: 'billPayment',
    label: 'Bill payment updated',
  }),
  deleteById({
    name: 'delete_bill_payment',
    description: 'Delete a bill payment in QuickBooks Online. The bills it paid become outstanding again.',
    method: 'deleteBillPayment',
    getMethod: 'getBillPayment',
    noun: 'bill payment',
    label: 'Bill payment deleted',
  }),
  searchPassthrough({
    name: 'search_bill_payments',
    description: 'Search bill payments in QuickBooks Online.',
    method: 'findBillPayments',
    entity: 'BillPayment',
    fieldHint: 'Id, VendorRef, TxnDate, TotalAmt, DocNumber, PayType',
    label: 'Bill payments',
  }),

  // ---- deposits -----------------------------------------------------------
  tool({
    name: 'create_deposit',
    description:
      'Record a bank deposit in QuickBooks Online — money arriving in an account, optionally '
      + 'attributed to a customer or vendor per line.',
    label: 'Deposit created',
    schema: z.object({
      deposit_to_account_ref: z.string().min(1).describe('Id of the bank account receiving the money.'),
      line_items: z
        .array(z.object({
          amount: z.number().positive(),
          account_ref: z.string().optional().describe('Id of the account this line posts against.'),
          entity_ref: z
            .object({
              type: z.string().describe('Customer, Vendor or Employee.'),
              value: z.string().describe('Id of that record.'),
            })
            .optional()
            .describe('Who the money came from.'),
          description: z.string().optional(),
        }))
        .min(1),
      txn_date: z.string().optional().describe('Deposit date (YYYY-MM-DD).'),
      private_note: z.string().optional(),
    }),
    run: (ctx, p) => qb(ctx, 'createDeposit', compact({
      DepositToAccountRef: ref(p.deposit_to_account_ref),
      Line: p.line_items.map((l, idx) => compact({
        Id: `${idx + 1}`,
        Amount: l.amount,
        Description: l.description,
        DetailType: 'DepositLineDetail',
        DepositLineDetail: compact({
          AccountRef: ref(l.account_ref),
          Entity: l.entity_ref
            ? { Type: l.entity_ref.type, EntityRef: { value: String(l.entity_ref.value) } }
            : undefined,
        }),
      })),
      TxnDate: p.txn_date,
      PrivateNote: p.private_note,
    })),
  }),
  getById({
    name: 'get_deposit',
    description: 'Get a deposit by Id from QuickBooks Online.',
    method: 'getDeposit',
    label: 'Deposit',
  }),
  tool({
    name: 'update_deposit',
    description: 'Update a deposit in QuickBooks Online.',
    label: 'Deposit updated',
    schema: z.object({
      ...updateHead('Deposit'),
      private_note: z.string().optional(),
    }),
    run: async (ctx, p) => {
      // Unlike most transactions, QBO rejects a sparse Deposit update that omits
      // DepositToAccountRef and the lines. Read the current deposit and send it
      // back whole with the caller's changes applied.
      const current = await qb(ctx, 'getDeposit', String(p.id));
      const payload = { ...current, Id: String(p.id), SyncToken: String(p.sync_token) };
      if (p.private_note !== undefined) payload.PrivateNote = p.private_note;
      return qb(ctx, 'updateDeposit', payload);
    },
  }),
  deleteById({
    name: 'delete_deposit',
    description: 'Delete a deposit in QuickBooks Online.',
    method: 'deleteDeposit',
    getMethod: 'getDeposit',
    noun: 'deposit',
    label: 'Deposit deleted',
  }),
  searchByDate({
    name: 'search_deposits',
    description: 'Search deposits in QuickBooks Online by date range.',
    method: 'findDeposits',
    entity: 'Deposit',
    label: 'Deposits',
  }),

  // ---- transfers ----------------------------------------------------------
  tool({
    name: 'create_transfer',
    description: 'Move money between two of the company\'s own accounts in QuickBooks Online.',
    label: 'Transfer created',
    schema: z.object({
      from_account_ref: z.string().min(1).describe('Id of the account money leaves.'),
      to_account_ref: z.string().min(1).describe('Id of the account money arrives in.'),
      amount: z.number().positive(),
      txn_date: z.string().optional().describe('Transfer date (YYYY-MM-DD).'),
      private_note: z.string().optional(),
    }),
    run: (ctx, p) => qb(ctx, 'createTransfer', compact({
      FromAccountRef: ref(p.from_account_ref),
      ToAccountRef: ref(p.to_account_ref),
      Amount: p.amount,
      TxnDate: p.txn_date,
      PrivateNote: p.private_note,
    })),
  }),
  getById({
    name: 'get_transfer',
    description: 'Get a transfer by Id from QuickBooks Online.',
    method: 'getTransfer',
    label: 'Transfer',
  }),
  sparseUpdate({
    name: 'update_transfer',
    description: 'Update a transfer in QuickBooks Online.',
    method: 'updateTransfer',
    label: 'Transfer updated',
    schema: z.object({
      ...updateHead('Transfer'),
      from_account_ref: z.string().optional(),
      to_account_ref: z.string().optional(),
      amount: z.number().optional(),
      private_note: z.string().optional(),
    }),
    map: (p) => compact({
      FromAccountRef: ref(p.from_account_ref),
      ToAccountRef: ref(p.to_account_ref),
      Amount: p.amount,
      PrivateNote: p.private_note,
    }),
  }),
  deleteById({
    name: 'delete_transfer',
    description: 'Delete a transfer in QuickBooks Online.',
    method: 'deleteTransfer',
    getMethod: 'getTransfer',
    noun: 'transfer',
    label: 'Transfer deleted',
  }),
  searchByDate({
    name: 'search_transfers',
    description: 'Search transfers in QuickBooks Online by date range.',
    method: 'findTransfers',
    entity: 'Transfer',
    label: 'Transfers',
  }),
];
