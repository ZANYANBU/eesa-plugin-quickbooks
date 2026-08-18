// The company record itself, and its preferences.
import { z } from 'zod';
import { tool, qb, sparseUpdate, updateHead, compact, EMPTY } from './registry.js';
import { getRealmId } from '../qbo.js';

export default [
  tool({
    name: 'get_company_info',
    description:
      'Get the connected company\'s details from QuickBooks Online — legal and trading name, '
      + 'address, contact details, fiscal year start and country.',
    label: 'Company',
    schema: z.object({
      company_id: z
        .string()
        .optional()
        .describe('Company (realm) Id. Defaults to the company this workspace has connected.'),
    }),
    // Upstream reads the realm off the node-quickbooks instance. Here the realm
    // belongs to the tenant, so it is resolved per call from their connection.
    run: async (ctx, p) => {
      const id = p.company_id || (getRealmId(ctx));
      return qb(ctx, 'getCompanyInfo', String(id));
    },
  }),

  sparseUpdate({
    name: 'update_company_info',
    description: 'Update the company\'s details in QuickBooks Online.',
    method: 'updateCompanyInfo',
    label: 'Company updated',
    schema: z.object({
      ...updateHead('Company'),
      company_name: z.string().optional().describe('Trading name.'),
      legal_name: z.string().optional().describe('Registered legal name.'),
      company_addr: z.object({
        line1: z.string().optional(),
        city: z.string().optional(),
        country_sub_division_code: z.string().optional().describe('State or province code.'),
        postal_code: z.string().optional(),
        country: z.string().optional(),
      }).optional(),
      primary_phone: z.string().optional(),
      email: z.string().optional(),
      web_addr: z.string().optional().describe('Website URL.'),
    }),
    map: (p) => compact({
      CompanyName: p.company_name,
      LegalName: p.legal_name,
      CompanyAddr: p.company_addr
        ? compact({
          Line1: p.company_addr.line1,
          City: p.company_addr.city,
          CountrySubDivisionCode: p.company_addr.country_sub_division_code,
          PostalCode: p.company_addr.postal_code,
          Country: p.company_addr.country,
        })
        : undefined,
      PrimaryPhone: p.primary_phone ? { FreeFormNumber: p.primary_phone } : undefined,
      Email: p.email ? { Address: p.email } : undefined,
      WebAddr: p.web_addr ? { URI: p.web_addr } : undefined,
    }),
  }),

  tool({
    name: 'get_preferences',
    description:
      'Get the company\'s QuickBooks preferences — accounting method, whether class and department '
      + 'tracking are switched on, purchase order settings, and the sales tax model. Worth reading '
      + 'before setting class or tax fields on a transaction, since those are rejected when the '
      + 'corresponding preference is off.',
    label: 'Preferences',
    schema: EMPTY,
    run: (ctx) => qb(ctx, 'getPreferences'),
  }),
];
