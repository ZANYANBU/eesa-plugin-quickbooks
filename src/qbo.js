// Per-tenant QuickBooks client.
//
// This is the file that makes the port multi-tenant. Intuit's server builds ONE
// `QuickbooksClient` at module load from process.env, and all 142 handlers call
// `QuickbooksClient.getInstance()` — correct for a stdio server serving one
// accountant, catastrophic for a hosted service, where it would mean every
// workspace's agent reading and writing the same company's books.
//
// Here the credential arrives with the request (Eesa forwards the tenant's own,
// see src/credentials.js) and is carried on the call context. There is no
// ambient default and no cache keyed by tenant: a call that arrives without
// credentials cannot reach QuickBooks at all, which is the property that makes
// cross-tenant leakage structurally impossible rather than merely unlikely.
import QuickBooks from 'node-quickbooks';
import { NotConnectedError, NOT_CONNECTED_MESSAGE } from './credentials.js';

export { NotConnectedError, NOT_CONNECTED_MESSAGE };

/**
 * Build a node-quickbooks instance for one set of credentials.
 *
 * Deliberately NOT cached. These objects only hold configuration, so building
 * one costs nothing — and a cache keyed by anything other than the exact token
 * is how a request ends up talking to the previous tenant's company.
 */
function build(creds) {
  return new QuickBooks(
    // The Intuit app credentials are the platform's and global; only the token
    // and realm are per tenant. node-quickbooks wants them for its own refresh
    // path, which is never used — Eesa owns refresh.
    process.env.QUICKBOOKS_CLIENT_ID || '',
    process.env.QUICKBOOKS_CLIENT_SECRET || '',
    creds.accessToken,
    false,                                   // no token secret under OAuth 2.0
    creds.realmId,
    creds.environment === 'sandbox',
    false,                                   // debug
    null,                                    // minor version
    '2.0',
    creds.refreshToken || '',
  );
}

/** The credentials carried on a call context, or a clear refusal. */
function credentialsOf(ctx) {
  const creds = ctx?.qbCredentials;
  if (!creds?.accessToken || !creds?.realmId) {
    // The request layer explains WHY when it knows — not connected, or
    // connected but the token expired and could not be renewed. Those need
    // different actions from the user, so they get different sentences.
    throw new NotConnectedError(ctx?.qbCredentialError || NOT_CONNECTED_MESSAGE);
  }
  return creds;
}

/** node-quickbooks instance bound to this call's company. */
export function getClient(ctx) {
  return build(credentialsOf(ctx));
}

/**
 * Raw OAuth credentials, for the QBO endpoints node-quickbooks does not wrap
 * (currently only POST /upload, for file attachments).
 */
export function getAuthCredentials(ctx) {
  const creds = credentialsOf(ctx);
  return {
    accessToken: creds.accessToken,
    realmId: creds.realmId,
    isSandbox: creds.environment === 'sandbox',
  };
}

/** The company (realm) id for this call — used by get_company_info. */
export function getRealmId(ctx) {
  return credentialsOf(ctx).realmId;
}

/** Base host for QBO REST calls made directly rather than through node-quickbooks. */
export function apiHost(isSandbox) {
  return isSandbox ? 'sandbox-quickbooks.api.intuit.com' : 'quickbooks.api.intuit.com';
}

/**
 * Promisify one node-quickbooks callback method.
 *
 * The upstream handlers each hand-roll
 *   `new Promise((resolve) => qbo.getX(id, (err, res) => ...))`
 * 142 times over. Same semantics, one implementation.
 */
export function call(qbo, method, ...args) {
  return new Promise((resolve, reject) => {
    const fn = qbo[method];
    if (typeof fn !== 'function') {
      reject(new Error(`node-quickbooks has no method "${method}"`));
      return;
    }
    fn.call(qbo, ...args, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

/** Run a QuickBooks operation with this call's credentials. */
export async function withClient(ctx, fn) {
  return fn(getClient(ctx));
}
