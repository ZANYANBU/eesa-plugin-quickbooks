// The MCP surface: JSON-RPC over a single POST, the way Eesa's MCPClient speaks
// it. Handles initialize, tools/list and tools/call, and is where the two
// authorisation gates that matter are enforced.
import { findTool, listTools } from './tools/index.js';
import { crudCategory, CRUD } from './tools/registry.js';
import { formatError, logError } from './errors.js';
import { NotConnectedError } from './credentials.js';

const PROTOCOL = '2025-06-18';

/** Role ranking. A caller Eesa marked "none" is refused everywhere. */
const RANK = { none: 0, staff: 1, admin: 2 };

export async function handleRpc(body, ctx, serverInfo) {
  const { method, params = {} } = body;

  if (method === 'initialize') {
    return { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo };
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: listTools() };
  if (method === 'tools/call') return callTool(params, ctx);

  const err = new Error('Unknown method: ' + method);
  err.code = -32601;
  throw err;
}

/**
 * Intuit's server nests every tool's arguments under a `params` key, because it
 * registers each schema as `{ params: <schema> }`. Eesa's agent passes
 * arguments flat, which is also what the schemas we publish describe.
 *
 * Accept both: unwrap a lone `params` object so a caller written against
 * Intuit's documentation still works, and pass anything else through. No tool
 * here has a top-level field named `params`, so this is unambiguous.
 */
function unwrapArguments(args) {
  if (
    args && typeof args === 'object' && !Array.isArray(args)
    && Object.keys(args).length === 1
    && args.params && typeof args.params === 'object' && !Array.isArray(args.params)
  ) {
    return args.params;
  }
  return args && typeof args === 'object' ? args : {};
}

/** Turn zod issues into one sentence an agent can act on. */
function describeIssues(error) {
  return error.issues
    .slice(0, 6)
    .map((i) => {
      const at = i.path.length ? i.path.join('.') : 'input';
      return `${at}: ${i.message}`;
    })
    .join('; ');
}

const textResult = (text, isError = false) => ({
  content: [{ type: 'text', text }],
  isError,
});

async function callTool(params, ctx) {
  const name = params?.name;
  const tool = findTool(name);

  if (!tool) {
    // Distinguish "no such tool" from "switched off here", because the second
    // is a configuration answer and the first is a spelling answer.
    const category = crudCategory(String(name || ''));
    if (category !== CRUD.READ) {
      return textResult(
        `The tool "${name}" is not available. QuickBooks ${category.toLowerCase()} operations are `
        + 'currently disabled for this deployment.',
        true,
      );
    }
    return textResult(`There is no QuickBooks tool called "${name}".`, true);
  }

  // ---- authorisation ------------------------------------------------------
  const role = ctx.role_ || 'none';
  const mutating = crudCategory(tool.name) !== CRUD.READ;
  const required = mutating ? 'admin' : 'staff';

  if ((RANK[role] ?? 0) < RANK[required]) {
    // Two independent gates protect writes: this one, and the deployment-level
    // QUICKBOOKS_DISABLE_* switches checked in findTool(). A role check is code,
    // and code has bugs; the environment switch is the belt to this braces.
    return textResult(
      mutating
        ? 'You do not have permission to change anything in QuickBooks — you have read-only access. '
          + 'A QuickBooks admin can change that on the Permissions tab of the QuickBooks app in Eesa.'
        : "You do not have access to this workspace's QuickBooks data. A QuickBooks admin can grant "
          + 'it on the Permissions tab of the QuickBooks app in Eesa.',
      true,
    );
  }

  // ---- validation ---------------------------------------------------------
  const args = unwrapArguments(params?.arguments);
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    return textResult(`Invalid arguments for ${tool.name} — ${describeIssues(parsed.error)}`, true);
  }

  // ---- run ----------------------------------------------------------------
  try {
    const result = await tool.run(ctx, parsed.data);
    const label = tool.label ? `${tool.label}:\n` : '';
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return textResult(`${label}${text}`);
  } catch (e) {
    // A missing connection is the single most common failure and is not an
    // error in the plugin — it is a thing the workspace has not done yet. Say
    // exactly that, so the agent tells the user to connect rather than
    // reporting a fault.
    if (e instanceof NotConnectedError) return textResult(e.message, true);

    // A rejected argument is the caller's mistake, not a fault. Logging a stack
    // trace for it buries the real failures in the noise.
    if (e && e.userError) return textResult(`${tool.name}: ${e.message}`, true);

    logError(`tool ${tool.name} (tenant ${ctx.tenantId})`, e);

    // update_bill throws with the written record attached when QuickBooks drops
    // tracking fields: the write DID happen, and hiding it would leave the agent
    // believing nothing changed.
    if (e && e.partialResult) {
      return textResult(
        `${formatError(e)}\n\nThe record as QuickBooks now holds it:\n${JSON.stringify(e.partialResult, null, 2)}`,
        true,
      );
    }
    return textResult(`${tool.name} failed. ${formatError(e)}`, true);
  }
}

export { unwrapArguments, RANK };
