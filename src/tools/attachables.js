// Attachments — files linked to a QuickBooks record (a receipt on an expense,
// a signed quote on an estimate).
import { z } from 'zod';
import {
  tool, qb, getById, deleteById, searchByFields, compact,
} from './registry.js';
import { getAuthCredentials } from '../qbo.js';
import {
  ALLOWED_UPLOAD_CONTENT_TYPES, MAX_UPLOAD_BYTES,
  inferContentType, approximateDecodedSize, fetchUrlToTempFile, uploadAttachableFile,
} from '../attachments.js';

const allowedTypesList = [...ALLOWED_UPLOAD_CONTENT_TYPES].sort().join(', ');

function assertAllowedType(contentType) {
  if (!ALLOWED_UPLOAD_CONTENT_TYPES.has(contentType)) {
    throw new Error(`QuickBooks does not accept "${contentType}". Allowed types: ${allowedTypesList}`);
  }
}

export default [
  tool({
    name: 'create_attachable',
    description:
      'Attach a file to a QuickBooks Online record, or create a note-only attachment. Provide the '
      + 'bytes as file_url (an https URL this server downloads) or base64_content (inline, only '
      + 'practical for small files). With neither, a metadata-only attachment record is created. '
      + 'Maximum 100 MB.',
    label: 'Attachment created',
    schema: z.object({
      file_name: z.string().min(1).describe("File name including extension, e.g. 'receipt.pdf'."),
      note: z.string().optional().describe('A note describing the attachment.'),
      category: z.string().optional().describe('QuickBooks attachment category.'),
      content_type: z
        .string()
        .optional()
        .describe(
          'MIME type. Inferred from the file extension when omitted. QuickBooks accepts: '
          + `${allowedTypesList}.`,
        ),
      file_url: z
        .string()
        .optional()
        .describe(
          'https URL the server downloads and forwards to QuickBooks. Plain http, and internal or '
          + 'cloud-metadata addresses, are refused. Maximum 3 redirects, 60s timeout. Takes '
          + 'precedence over base64_content.',
        ),
      base64_content: z
        .string()
        .optional()
        .describe('Base64-encoded file bytes. Ignored when file_url is given.'),
      attachable_ref: z
        .object({
          entity_ref_type: z.string().describe("Record type, e.g. 'Invoice', 'Bill', 'Purchase'."),
          entity_ref_value: z.string().describe('Id of that record.'),
          include_on_send: z
            .boolean()
            .optional()
            .describe('Include the file when the record is emailed to a customer.'),
        })
        .optional()
        .describe('The QuickBooks record to attach the file to.'),
    }),
    // Upstream also accepts `file_path`, a path on the machine running the
    // server. That makes sense for a local stdio server and none at all here —
    // see the note at the top of src/attachments.js.
    run: async (ctx, p) => {
      const payload = compact({
        FileName: p.file_name,
        Note: p.note,
        Category: p.category,
        ContentType: p.content_type,
        AttachableRef: p.attachable_ref
          ? [compact({
            EntityRef: {
              type: p.attachable_ref.entity_ref_type,
              value: String(p.attachable_ref.entity_ref_value),
            },
            IncludeOnSend: typeof p.attachable_ref.include_on_send === 'boolean'
              ? p.attachable_ref.include_on_send
              : undefined,
          })]
          : undefined,
      });

      // ---- metadata only --------------------------------------------------
      if (!p.file_url && !p.base64_content) {
        return qb(ctx, 'createAttachable', payload);
      }

      // ---- binary upload --------------------------------------------------
      let file;
      let cleanup = null;
      let headerType = null;

      if (p.file_url) {
        const fetched = await fetchUrlToTempFile(p.file_url, MAX_UPLOAD_BYTES);
        file = { path: fetched.path, size: fetched.size };
        headerType = fetched.contentTypeHeader;
        cleanup = fetched.cleanup;
      } else {
        // Validate the type BEFORE decoding, so an unsupported file is refused
        // without allocating the decoded buffer at all.
        const preliminary = p.content_type || inferContentType(p.file_name) || 'application/octet-stream';
        assertAllowedType(preliminary);
        const approx = approximateDecodedSize(p.base64_content);
        if (approx > MAX_UPLOAD_BYTES) {
          throw new Error(
            `File too large: roughly ${approx} bytes exceeds QuickBooks' 100 MB upload limit.`,
          );
        }
        file = { buffer: Buffer.from(p.base64_content, 'base64') };
      }

      try {
        // Precedence: an explicit content_type, then the extension of the file
        // name or the URL PATH (query strings excluded, so "?f=x.pdf" cannot
        // spoof the type), then the response header — but only if it is a type
        // QuickBooks accepts, because servers routinely send octet-stream.
        const urlPathname = p.file_url ? new URL(p.file_url).pathname : undefined;
        const headerToken = headerType ? headerType.split(';')[0].trim().toLowerCase() : null;
        const effective = p.content_type
          || inferContentType(p.file_name, urlPathname)
          || (headerToken && ALLOWED_UPLOAD_CONTENT_TYPES.has(headerToken) ? headerToken : null)
          || 'application/octet-stream';
        assertAllowedType(effective);
        payload.ContentType = effective;

        return await uploadAttachableFile(file, payload, getAuthCredentials(ctx));
      } finally {
        if (cleanup) await cleanup();
      }
    },
  }),

  getById({
    name: 'get_attachable',
    description: 'Get an attachment record by Id from QuickBooks Online.',
    method: 'getAttachable',
    label: 'Attachment',
  }),

  tool({
    name: 'update_attachable',
    description:
      "Update an attachment's metadata — file name, note, category or content type. This cannot "
      + 'replace the stored file. To attach a corrected file, create a new attachment and delete the old one.',
    label: 'Attachment updated',
    schema: z.object({
      id: z.string().min(1).describe('Attachment Id.'),
      sync_token: z.string().min(1).describe('SyncToken from the latest read of this attachment.'),
      file_name: z.string().optional(),
      content_type: z.string().optional(),
      note: z.string().optional(),
      category: z.string().optional(),
    }),
    run: (ctx, p) => qb(ctx, 'updateAttachable', compact({
      Id: String(p.id),
      SyncToken: String(p.sync_token),
      sparse: true,
      FileName: p.file_name,
      ContentType: p.content_type || (p.file_name ? inferContentType(p.file_name) || undefined : undefined),
      Note: p.note,
      Category: p.category,
    })),
  }),

  deleteById({
    name: 'delete_attachable',
    description: 'Delete an attachment from QuickBooks Online.',
    method: 'deleteAttachable',
    getMethod: 'getAttachable',
    noun: 'attachment',
    label: 'Attachment deleted',
  }),

  searchByFields({
    name: 'search_attachables',
    description: 'Search attachments in QuickBooks Online.',
    method: 'findAttachables',
    entity: 'Attachable',
    label: 'Attachments',
    schema: z.object({
      file_name: z.string().optional().describe('Filter by exact file name.'),
      content_type: z.string().optional().describe('Filter by MIME type.'),
      limit: z.number().int().positive().optional(),
    }),
    map: (p) => compact({ FileName: p.file_name, ContentType: p.content_type, limit: p.limit }),
  }),
];
