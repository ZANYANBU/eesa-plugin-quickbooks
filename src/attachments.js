// File sources for QuickBooks attachments, and the raw multipart upload.
//
// Ported from helpers/attachable-file-source.ts and the upload half of
// create-quickbooks-attachable.handler.ts, minus the `file_path` source.
//
// WHY file_path IS GONE: upstream runs as a stdio subprocess on the same
// machine as the person asking, so "attach C:\Users\me\Documents\quote.pdf" is
// a reasonable thing to say and it guards the path with an allowlist. Here the
// only filesystem is the container's, which no user can put a file on — so the
// parameter could never do anything useful, and the one thing it COULD do is
// let a prompt-injected agent try to read the container's own files. It is
// removed rather than guarded.
import { lookup } from 'node:dns/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// File types the QBO /upload endpoint accepts. Two entries deviate from the
// RFC spellings (image/jpg, image/tif) because that is what QuickBooks
// documents and accepts; one (application/vnd.ms-excel) corrects a typo in
// Intuit's own docs, which print an invalid "application/vnd/ms-excel".
export const ALLOWED_UPLOAD_CONTENT_TYPES = new Set([
  'application/postscript',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/gif',
  'image/jpeg',
  'image/jpg',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/pdf',
  'image/png',
  'text/rtf',
  'image/tif',
  'text/plain',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/xml',
]);

const EXT_TO_MIME = {
  '.ai': 'application/postscript',
  '.eps': 'application/postscript',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpg',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.rtf': 'text/rtf',
  '.tif': 'image/tif',
  '.txt': 'text/plain',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'text/xml',
};

/** QuickBooks documents a 100 MB per-request cap on /upload. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** First candidate filename with a known extension wins; null when none match. */
export function inferContentType(...candidateNames) {
  for (const name of candidateNames) {
    if (!name) continue;
    const mime = EXT_TO_MIME[path.extname(name).toLowerCase()];
    if (mime) return mime;
  }
  return null;
}

/** Decoded size of a base64 string, without decoding it. */
export function approximateDecodedSize(base64) {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

// Extract the IPv4 address embedded in an IPv4-compatible (::/96) or NAT64
// (64:ff9b::/96) IPv6 address, in dotted or hex-group form.
function embeddedV4(lower) {
  const isNat64 = lower.startsWith('64:ff9b::');
  const isV4Compat = lower.startsWith('::') && !lower.startsWith('::ffff:');
  if (!isNat64 && !isV4Compat) return null;
  const dotted = lower.match(/((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dotted) return dotted[1];
  const tail = lower.replace(/^64:ff9b::/, '').replace(/^::/, '');
  const groups = tail.split(':').filter(Boolean);
  if (groups.length === 0 || groups.length > 2) return null;
  const [hi, lo] = groups.length === 2 ? groups : ['0', groups[0]];
  const hiN = parseInt(hi, 16);
  const loN = parseInt(lo, 16);
  return `${hiN >> 8}.${hiN & 255}.${loN >> 8}.${loN & 255}`;
}

/**
 * Reject loopback, RFC1918/4193 private ranges, link-local (including the
 * 169.254.169.254 cloud metadata address), CGNAT and unspecified addresses.
 *
 * This matters more here than it did upstream. There, the worst case was an
 * agent reading something on one operator's own laptop. Here the plugin sits
 * inside Eesa's network, so an unguarded fetch would let any tenant's agent use
 * it to reach internal services and the cloud metadata endpoint.
 */
export function isBlockedIp(ip) {
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower.startsWith('::ffff:')) {
      const v4 = lower.slice('::ffff:'.length);
      return net.isIPv4(v4) ? isBlockedIp(v4) : true;
    }
    if (lower === '::1' || lower === '::') return true;
    const embedded = embeddedV4(lower);
    if (embedded) return isBlockedIp(embedded);
    if (/^fe[89ab]/.test(lower)) return true;         // fe80::/10 link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique-local
    return false;
  }
  if (!net.isIPv4(ip)) return true;                    // unparseable -> blocked
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;             // link-local + metadata
  if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT
  return false;
}

async function assertUrlAllowed(url) {
  if (url.protocol !== 'https:') {
    throw new Error(`file_url must use https (got ${url.protocol.replace(':', '')}).`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) throw new Error('file_url resolves to a blocked address.');
    return;
  }
  // Check every resolved address. The fetch does its own resolution, so a
  // hostile DNS server could in principle answer differently the second time
  // (DNS rebinding); that residual risk is accepted, as the realistic threat is
  // an agent being talked into fetching an internal URL, not a targeted rebind.
  const addrs = await lookup(hostname, { all: true, verbatim: true });
  if (addrs.length === 0) throw new Error('file_url hostname did not resolve.');
  for (const { address } of addrs) {
    if (isBlockedIp(address)) throw new Error('file_url resolves to a blocked address.');
  }
}

function urlFetchTimeoutMs() {
  const raw = Number(process.env.QUICKBOOKS_ATTACHABLE_URL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

const swallow = () => undefined;

/**
 * Fetch an https URL and spool it to a temp file, enforcing the size cap while
 * streaming so memory stays flat. Redirects are followed manually (max 3) so
 * every hop passes the SSRF check — following them automatically would check
 * only the first.
 */
export async function fetchUrlToTempFile(fileUrl, maxBytes = MAX_UPLOAD_BYTES) {
  let current;
  try {
    current = new URL(fileUrl);
  } catch {
    throw new Error(`file_url is not a valid URL: ${fileUrl}`);
  }

  const signal = AbortSignal.timeout(urlFetchTimeoutMs());
  let response = null;
  for (let hop = 0; hop <= 3; hop++) {
    await assertUrlAllowed(current);
    const res = await fetch(current, {
      redirect: 'manual',
      signal,
      headers: { 'user-agent': 'eesa-quickbooks-plugin/2.0' },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new Error(`file_url redirect (${res.status}) had no Location header.`);
      if (hop === 3) throw new Error('file_url exceeded 3 redirects.');
      current = new URL(location, current);
      // Cancel without reading: a hostile server can hang an arbitrarily large
      // body off a 3xx.
      await res.body?.cancel().catch(swallow);
      continue;
    }
    if (!res.ok) throw new Error(`file_url fetch failed: HTTP ${res.status}`);
    response = res;
    break;
  }
  if (!response?.body) throw new Error('file_url fetch returned no body.');

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel().catch(swallow);
    throw new Error(`File too large: ${declared} bytes exceeds QuickBooks' 100 MB upload limit.`);
  }

  const tempPath = path.join(os.tmpdir(), `qbo-attach-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  const cleanup = async () => { await fs.unlink(tempPath).catch(swallow); };

  let received = 0;
  const capEnforcer = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (received > maxBytes) {
        cb(new Error("File too large: the download exceeded QuickBooks' 100 MB upload limit."));
        return;
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(response.body), capEnforcer, createWriteStream(tempPath));
  } catch (err) {
    await cleanup();
    throw err;
  }
  if (received === 0) {
    await cleanup();
    throw new Error('file_url returned an empty body.');
  }

  return {
    path: tempPath,
    size: received,
    contentTypeHeader: response.headers.get('content-type'),
    cleanup,
  };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

function sanitizeFilename(name) {
  return String(name).replace(/[\r\n"\\]/g, '_');
}

// Map a status to a message safe to hand back to an agent. The raw QBO body
// carries realm ids and internal trace identifiers; those go to the log.
function redactedUploadError(statusCode) {
  if (!statusCode) return 'The upload to QuickBooks failed: network error.';
  if (statusCode === 401 || statusCode === 403) return `The upload to QuickBooks failed (${statusCode}): not authorised.`;
  if (statusCode === 413) return `The upload to QuickBooks failed (${statusCode}): the file is too large.`;
  if (statusCode >= 500) return `The upload to QuickBooks failed (${statusCode}): QuickBooks server error.`;
  return `The upload to QuickBooks failed (${statusCode}): the request was rejected.`;
}

/**
 * POST one file plus its metadata to /v3/company/{realmId}/upload as
 * multipart/form-data. node-quickbooks does not wrap this endpoint.
 *
 * @param {{buffer: Buffer} | {path: string, size: number}} file
 */
export function uploadAttachableFile(file, metadata, { accessToken, realmId, isSandbox }) {
  const boundary = `----EesaQBOBoundary${randomBytes(8).toString('hex')}`;
  const fileName = sanitizeFilename(metadata.FileName);
  const contentType = metadata.ContentType;

  const preamble = Buffer.from(
    `--${boundary}\r\n`
    + 'Content-Disposition: form-data; name="file_metadata_01"\r\n'
    + 'Content-Type: application/json\r\n\r\n'
    + `${JSON.stringify(metadata)}\r\n`
    + `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="file_content_01"; filename="${fileName}"\r\n`
    + `Content-Type: ${contentType}\r\n\r\n`,
  );
  const closer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const fileSize = 'buffer' in file ? file.buffer.length : file.size;
  // An exact Content-Length lets the file part stream without chunked transfer
  // encoding, which this QBO endpoint does not reliably accept.
  const contentLength = preamble.length + fileSize + closer.length;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: isSandbox ? 'sandbox-quickbooks.api.intuit.com' : 'quickbooks.api.intuit.com',
        path: `/v3/company/${realmId}/upload`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': contentLength,
          Accept: 'application/json',
        },
        timeout: 120_000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode >= 400) {
            console.error(`[qbo-attachable-upload] QBO ${res.statusCode}: ${text}`);
            reject(new Error(redactedUploadError(res.statusCode)));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            console.error(`[qbo-attachable-upload] QBO ${res.statusCode} non-JSON: ${text}`);
            reject(new Error(redactedUploadError(res.statusCode)));
          }
        });
      },
    );

    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => {
      console.error(`[qbo-attachable-upload] network error: ${err.message}`);
      reject(new Error(redactedUploadError(undefined)));
    });

    req.write(preamble);
    if ('buffer' in file) {
      req.write(file.buffer);
      req.write(closer);
      req.end();
      return;
    }

    // Bounded to the size we stat'ed, so a file that grows mid-read cannot
    // overrun the declared Content-Length.
    const readStream = createReadStream(file.path, { end: file.size - 1 });
    req.on('error', () => readStream.destroy());
    readStream.on('error', (err) => {
      req.destroy(err);
      reject(new Error(`Could not read the file for upload: ${err.message}`));
    });
    readStream.pipe(req, { end: false });
    readStream.on('end', () => {
      if (readStream.bytesRead !== file.size) {
        req.destroy();
        reject(new Error(
          `The file changed during upload: read ${readStream.bytesRead} of ${file.size} expected bytes.`,
        ));
        return;
      }
      req.write(closer);
      req.end();
    });
  });
}
