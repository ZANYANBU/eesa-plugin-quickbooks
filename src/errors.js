// Turning a QuickBooks failure into something an agent can act on.
//
// The upstream server's formatError() JSON.stringify()s whatever it was given.
// For a node-quickbooks failure that means the agent receives the entire QBO
// fault envelope — realm id, intuit_tid trace identifiers, the lot — wrapped
// around the one sentence that actually says what went wrong ("Duplicate
// Document Number Error"). That is both a small information leak and, more
// practically, a wall of JSON the model then tries to reason about.
//
// So: pull out the fault's message and detail, keep the QBO error code (it is
// the thing worth searching for), and leave the trace identifiers in the server
// log where an operator can still find them.

/** QBO fault codes worth translating into an instruction rather than a restatement. */
const GUIDANCE = {
  // Stale SyncToken — the record changed since it was read.
  5010: 'The record was modified by someone else since it was read. Read it again to get the current SyncToken, then retry.',
  // Object not found.
  610: 'No record with that Id exists in this QuickBooks company.',
  // Duplicate name.
  6240: 'A record with that name already exists. Names must be unique in QuickBooks.',
  // Required param missing.
  2020: 'A required field was missing from the request.',
  // Invalid reference id.
  2010: 'One of the referenced ids does not exist, or a reference was sent in the wrong shape (it must be { value: "<id>" }).',
};

function faultErrors(err) {
  const fault = err?.Fault || err?.fault
    || err?.response?.Fault || err?.body?.Fault
    || err?.error?.Fault;
  const list = fault?.Error || fault?.error;
  return Array.isArray(list) ? list : list ? [list] : [];
}

/**
 * Format any thrown value as a single readable line.
 * @param {unknown} error
 * @returns {string}
 */
export function formatError(error) {
  const faults = faultErrors(error);
  if (faults.length) {
    const parts = faults.map((f) => {
      const code = f.code ?? f.Code;
      const message = f.Message || f.message || 'QuickBooks rejected the request';
      const detail = f.Detail || f.detail || '';
      // Detail routinely repeats Message with the entity name appended; keep it
      // only when it adds something.
      const body = detail && !detail.startsWith(message) ? `${message}: ${detail}` : message;
      const hint = code != null && GUIDANCE[Number(code)] ? ` ${GUIDANCE[Number(code)]}` : '';
      return code != null ? `${body} (QuickBooks error ${code}).${hint}` : `${body}.${hint}`;
    });
    return parts.join(' ');
  }

  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;

  // An unrecognised object. Say so rather than pasting it: an unbounded JSON
  // blob in a tool result is worse than useless to the model reading it.
  if (error && typeof error === 'object') {
    const message = error.message || error.Message || error.error_description || error.error;
    if (message) return String(message);
    return 'QuickBooks returned an error with no message. Check the plugin logs for the full response.';
  }
  return String(error ?? 'Unknown error');
}

/** Log the full failure server-side, where trace ids are useful and safe. */
export function logError(context, error) {
  const detail = error instanceof Error ? (error.stack || error.message) : JSON.stringify(error);
  console.error(`[qbo] ${context}: ${detail}`);
}
