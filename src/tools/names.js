// Customers, vendors and employees — QuickBooks' three "name list" entities.
//
// They share a shape (a display name, contact details, a balance) and share the
// same deletion rule: QuickBooks will not delete a name that any transaction
// refers to, so "delete" means "make inactive", exactly as the QuickBooks UI's
// own delete button does.
import { z } from 'zod';
import {
  tool, getById, searchPassthrough, deactivate, createRaw, updateRaw,
} from './registry.js';

const emailSchema = z.object({ Address: z.string().optional() }).describe('e.g. { "Address": "ap@acme.com" }');
const phoneSchema = z.object({ FreeFormNumber: z.string().optional() });
const addressSchema = z.object({
  Line1: z.string().optional(),
  Line2: z.string().optional(),
  City: z.string().optional(),
  Country: z.string().optional(),
  CountrySubDivisionCode: z.string().optional().describe('State or province code.'),
  PostalCode: z.string().optional(),
}).passthrough();

const nameEntityShape = {
  DisplayName: z.string().describe('The name shown in QuickBooks. Must be unique.'),
  GivenName: z.string().optional(),
  MiddleName: z.string().optional(),
  FamilyName: z.string().optional(),
  CompanyName: z.string().optional(),
  PrimaryEmailAddr: emailSchema.optional(),
  PrimaryPhone: phoneSchema.optional(),
  Mobile: phoneSchema.optional(),
  BillAddr: addressSchema.optional(),
  Notes: z.string().optional(),
  Active: z.boolean().optional(),
};

const CUSTOMER_TAX_NOTE =
  'Tax details for non-US companies: PrimaryTaxIdentifier holds the tax registration number '
  + '(EU VAT number / CIF); Taxable (boolean) and DefaultTaxCodeRef ({ value: <TaxCode Id> }) set '
  + 'the default sales tax treatment. QuickBooks always returns PrimaryTaxIdentifier masked.';

const customerShape = z.object({
  ...nameEntityShape,
  ShipAddr: addressSchema.optional(),
  Taxable: z.boolean().optional(),
  PrimaryTaxIdentifier: z.string().optional().describe('Tax registration number (VAT/CIF).'),
  DefaultTaxCodeRef: z.object({ value: z.string() }).optional(),
  SalesTermRef: z.object({ value: z.string() }).optional(),
  CurrencyRef: z.object({ value: z.string() }).optional(),
}).passthrough();

const vendorShape = z.object({
  ...nameEntityShape,
  AcctNum: z.string().optional().describe('Your account number with this vendor.'),
  Vendor1099: z.boolean().optional(),
  TaxIdentifier: z.string().optional(),
  WebAddr: z.object({ URI: z.string() }).optional(),
}).passthrough();

const employeeShape = z.object({
  ...nameEntityShape,
  EmployeeNumber: z.string().optional(),
  SSN: z.string().optional().describe('Returned masked by QuickBooks.'),
  BillableTime: z.boolean().optional(),
  BillRate: z.number().optional(),
  HiredDate: z.string().optional().describe('YYYY-MM-DD'),
}).passthrough();

const CUSTOMER_FIELDS = 'Id, DisplayName, GivenName, FamilyName, CompanyName, '
  + 'PrimaryEmailAddr, PrimaryPhone, Balance, Active, MetaData.LastUpdatedTime';
const VENDOR_FIELDS = 'Id, DisplayName, CompanyName, GivenName, FamilyName, PrimaryEmailAddr, '
  + 'PrimaryPhone, Balance, BillRate, AcctNum, Vendor1099, Active';
const EMPLOYEE_FIELDS = 'Id, DisplayName, GivenName, FamilyName, Active, PrimaryEmailAddr, EmployeeNumber';

export default [
  // ---- customers ----------------------------------------------------------
  createRaw({
    name: 'create_customer',
    description: `Create a customer in QuickBooks Online. DisplayName is required and must be unique. ${CUSTOMER_TAX_NOTE}`,
    method: 'createCustomer',
    key: 'customer',
    shape: customerShape,
    label: 'Customer created',
  }),
  getById({
    name: 'get_customer',
    description: 'Get a customer by Id from QuickBooks Online.',
    method: 'getCustomer',
    label: 'Customer',
  }),
  updateRaw({
    name: 'update_customer',
    description: `Update a customer in QuickBooks Online. Include Id and SyncToken; add sparse: true to change only the fields supplied. ${CUSTOMER_TAX_NOTE}`,
    method: 'updateCustomer',
    key: 'customer',
    shape: customerShape.extend({
      Id: z.string(),
      SyncToken: z.string(),
      sparse: z.boolean().optional(),
    }).partial({ DisplayName: true }),
    label: 'Customer updated',
  }),
  deactivate({
    name: 'delete_customer',
    description:
      'Make a customer inactive in QuickBooks Online. QuickBooks does not delete customers that '
      + 'appear on any transaction; inactive hides them from lists while preserving history.',
    getMethod: 'getCustomer',
    updateMethod: 'updateCustomer',
    deleteMethod: 'deleteCustomer',
    noun: 'customer',
    label: 'Customer made inactive',
  }),
  searchPassthrough({
    name: 'search_customers',
    description: 'Search customers in QuickBooks Online.',
    method: 'findCustomers',
    entity: 'Customer',
    fieldHint: CUSTOMER_FIELDS,
    label: 'Customers',
  }),

  // ---- vendors ------------------------------------------------------------
  createRaw({
    name: 'create_vendor',
    description: 'Create a vendor (supplier) in QuickBooks Online. DisplayName is required and must be unique.',
    method: 'createVendor',
    key: 'vendor',
    shape: vendorShape,
    label: 'Vendor created',
    aliases: ['create-vendor'],
  }),
  getById({
    name: 'get_vendor',
    description: 'Get a vendor by Id from QuickBooks Online.',
    method: 'getVendor',
    label: 'Vendor',
    aliases: ['get-vendor'],
  }),
  updateRaw({
    name: 'update_vendor',
    description: 'Update a vendor in QuickBooks Online. Include Id and SyncToken; add sparse: true for a partial update.',
    method: 'updateVendor',
    key: 'vendor',
    shape: vendorShape.extend({
      Id: z.string(),
      SyncToken: z.string(),
      sparse: z.boolean().optional(),
    }).partial({ DisplayName: true }),
    label: 'Vendor updated',
    aliases: ['update-vendor'],
  }),
  deactivate({
    name: 'delete_vendor',
    description:
      'Make a vendor inactive in QuickBooks Online. QuickBooks does not delete vendors that appear '
      + 'on any bill or purchase; inactive hides them from lists while preserving history.',
    getMethod: 'getVendor',
    updateMethod: 'updateVendor',
    deleteMethod: 'deleteVendor',
    noun: 'vendor',
    label: 'Vendor made inactive',
    aliases: ['delete-vendor'],
  }),
  searchPassthrough({
    name: 'search_vendors',
    description: 'Search vendors in QuickBooks Online.',
    method: 'findVendors',
    entity: 'Vendor',
    fieldHint: VENDOR_FIELDS,
    label: 'Vendors',
  }),

  // ---- employees ----------------------------------------------------------
  createRaw({
    name: 'create_employee',
    description: 'Create an employee in QuickBooks Online.',
    method: 'createEmployee',
    key: 'employee',
    shape: employeeShape,
    label: 'Employee created',
  }),
  getById({
    name: 'get_employee',
    description: 'Get an employee by Id from QuickBooks Online.',
    method: 'getEmployee',
    label: 'Employee',
  }),
  updateRaw({
    name: 'update_employee',
    description: 'Update an employee in QuickBooks Online. Include Id and SyncToken.',
    method: 'updateEmployee',
    key: 'employee',
    shape: employeeShape.extend({
      Id: z.string(),
      SyncToken: z.string(),
      sparse: z.boolean().optional(),
    }).partial({ DisplayName: true }),
    label: 'Employee updated',
  }),
  deactivate({
    name: 'delete_employee',
    description: 'Make an employee inactive in QuickBooks Online. QuickBooks does not delete employees.',
    getMethod: 'getEmployee',
    updateMethod: 'updateEmployee',
    noun: 'employee',
    label: 'Employee made inactive',
  }),
  searchPassthrough({
    name: 'search_employees',
    description: 'Search employees in QuickBooks Online.',
    method: 'findEmployees',
    entity: 'Employee',
    fieldHint: EMPLOYEE_FIELDS,
    label: 'Employees',
  }),
];

export { tool };
