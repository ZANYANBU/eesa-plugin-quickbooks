// HTTP <-> stdio bridge for Intuit's official QuickBooks Online MCP server.
//
// Eesa's MCPClient speaks a simple stateless JSON-RPC POST
// ({jsonrpc,id,method,params}) with no MCP initialize/session/SSE handshake.
// Intuit's server speaks stdio MCP. This keeps ONE persistent stdio session
// and maps tools/list + tools/call onto it.
//
// ---------------------------------------------------------------------------
// THE TOKEN PROBLEM, AND WHY THIS VERSION IS DIFFERENT
//
// Intuit rotates the refresh token on roughly every refresh and expires the
// old one after a short grace period. A long-lived stdio server holds the
// rotated token only in memory, so a restart boots with whatever was in the
// environment — which by then is dead.
//
// The previous deployment solved that by rewriting its own .env file. That
// works on a box with a real disk. It does not work in a container, whose
// filesystem is recreated on every deploy: the rotated token was erased, the
// next boot presented an expired one, and the QuickBooks connection died
// roughly a day later. It has been dead ever since.
//
// So the token is written to QB_TOKEN_STORE, which MUST be inside a mounted
// volume. On boot the file wins over the environment variable, because the
// file is the one that has been kept current. If the volume is missing this
// logs loudly rather than pretending — silent token loss is what caused the
// original outage, and it took weeks to notice.
// ---------------------------------------------------------------------------
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PORT = parseInt(process.env.GATEWAY_PORT || "8080", 10);
const TOKEN = process.env.GATEWAY_TOKEN || "";
const MCP_DIR = process.env.QB_MCP_DIR || "/app";
const TOKEN_STORE = process.env.QB_TOKEN_STORE || "/data/qb-token.json";
const ENVIRONMENT = process.env.QUICKBOOKS_ENVIRONMENT || "sandbox";

let client = null;
let connecting = null;
let lastRefreshAt = null;
let lastRefreshError = null;

// ---- token store --------------------------------------------------------

function loadStoredToken() {
  try {
    const raw = fs.readFileSync(TOKEN_STORE, "utf8");
    const j = JSON.parse(raw);
    if (j && typeof j.refresh_token === "string" && j.refresh_token) {
      console.error(
        `[gateway] refresh token loaded from ${TOKEN_STORE} (saved ${j.saved_at || "?"})`,
      );
      return j.refresh_token;
    }
  } catch (e) {
    if (e && e.code === "ENOENT") {
      console.error(
        `[gateway] no token store at ${TOKEN_STORE} yet — using the environment ` +
          `variable for this boot. If this message appears after EVERY deploy, the ` +
          `volume is not mounted and this connection will die within a day.`,
      );
    } else {
      console.error(`[gateway] token store unreadable: ${e && e.message}`);
    }
  }
  return "";
}

function persistToken(rt) {
  try {
    fs.mkdirSync(path.dirname(TOKEN_STORE), { recursive: true });
    // Write-then-rename, so a crash mid-write cannot leave a truncated file
    // where a valid token used to be. Losing this file means a human has to
    // re-authorise in a browser.
    const tmp = TOKEN_STORE + ".tmp";
    fs.writeFileSync(
      tmp,
      JSON.stringify({ refresh_token: rt, saved_at: new Date().toISOString(), environment: ENVIRONMENT }),
      { mode: 0o600 },
    );
    fs.renameSync(tmp, TOKEN_STORE);
    return true;
  } catch (e) {
    console.error(`[gateway] COULD NOT PERSIST TOKEN to ${TOKEN_STORE}: ${e && e.message}`);
    return false;
  }
}

let currentRefreshToken =
  loadStoredToken() || process.env.QUICKBOOKS_REFRESH_TOKEN || "";
if (currentRefreshToken) process.env.QUICKBOOKS_REFRESH_TOKEN = currentRefreshToken;

async function refreshAndPersist() {
  const cid = process.env.QUICKBOOKS_CLIENT_ID;
  const csec = process.env.QUICKBOOKS_CLIENT_SECRET;
  const rt = currentRefreshToken;
  if (!cid || !csec || !rt || rt === "placeholder") {
    lastRefreshError = "not configured";
    return;
  }
  try {
    const auth = Buffer.from(cid + ":" + csec).toString("base64");
    const res = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
      method: "POST",
      headers: {
        Authorization: "Basic " + auth,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt }).toString(),
    });
    const j = await res.json().catch(() => ({}));
    if (j && j.refresh_token) {
      const rotated = j.refresh_token !== rt;
      currentRefreshToken = j.refresh_token;
      process.env.QUICKBOOKS_REFRESH_TOKEN = j.refresh_token;
      const saved = persistToken(j.refresh_token);
      lastRefreshAt = new Date().toISOString();
      lastRefreshError = saved ? null : "persist failed";
      console.error(`[gateway] token refreshed (rotated=${rotated}, persisted=${saved})`);
    } else {
      // Never log the response body — it can carry a token on the success path
      // and we do not want a credential in a log aggregator.
      lastRefreshError = `no refresh_token in response (http ${res.status})`;
      console.error(`[gateway] token refresh failed: ${lastRefreshError}`);
    }
  } catch (e) {
    lastRefreshError = String((e && e.message) || e);
    console.error(`[gateway] token refresh error: ${lastRefreshError}`);
  }
}

// ---- stdio MCP session --------------------------------------------------

async function connect() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: MCP_DIR,
    env: { ...process.env },
    stderr: "inherit",
  });
  const c = new Client({ name: "eesa-qbo-gateway", version: "1.0.0" }, { capabilities: {} });
  await c.connect(transport);
  c.onclose = () => {
    console.error("[gateway] QBO MCP transport closed; will reconnect on next call");
    if (client === c) client = null;
  };
  console.error(`[gateway] connected to QBO MCP (environment=${ENVIRONMENT})`);
  return c;
}

async function ensure() {
  if (client) return client;
  if (!connecting) {
    connecting = connect()
      .then((c) => {
        client = c;
        return c;
      })
      .finally(() => {
        connecting = null;
      });
  }
  return connecting;
}

function send(res, status, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(b),
  });
  res.end(b);
}

const server = http.createServer((req, res) => {
  // Liveness. Deliberately unauthenticated and deliberately NOT touching
  // Intuit — Coolify needs it to answer during boot.
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { ok: true, plugin: "quickbooks", connected: !!client, environment: ENVIRONMENT });
  }
  // Readiness. This is the one that tells you the token is alive, and the one
  // worth alerting on — /health stays green with a dead credential.
  if (req.method === "GET" && req.url === "/health/token") {
    const ok = !!currentRefreshToken && !lastRefreshError;
    return send(res, ok ? 200 : 503, {
      ok,
      has_token: !!currentRefreshToken,
      token_store: TOKEN_STORE,
      store_present: fs.existsSync(TOKEN_STORE),
      last_refresh_at: lastRefreshAt,
      last_error: lastRefreshError,
      environment: ENVIRONMENT,
      realm_id: process.env.QUICKBOOKS_REALM_ID || null,
    });
  }
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  if (TOKEN && req.headers["authorization"] !== "Bearer " + TOKEN) {
    return send(res, 401, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "unauthorized" },
    });
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 8e6) req.destroy();
  });
  req.on("end", async () => {
    let msg;
    try {
      msg = JSON.parse(body || "{}");
    } catch {
      return send(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error" },
      });
    }
    const id = msg.id ?? null;
    const method = msg.method;
    try {
      const c = await ensure();
      let result;
      if (method === "tools/list") {
        result = await c.listTools();
      } else if (method === "tools/call") {
        result = await c.callTool({
          name: msg.params?.name,
          arguments: msg.params?.arguments || {},
        });
      } else if (method === "ping" || method === "initialize") {
        result = { ok: true };
      } else {
        return send(res, 200, {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "method not found: " + method },
        });
      }
      send(res, 200, { jsonrpc: "2.0", id, result });
    } catch (e) {
      if (client) client = null;
      send(res, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: String((e && e.message) || e) },
      });
    }
  });
});

server.listen(PORT, "0.0.0.0", () =>
  console.error(`[gateway] listening on :${PORT} (environment=${ENVIRONMENT})`),
);

// Keep the stored token fresh so a restart never needs a manual re-auth.
// First pass shortly after boot, then every 6h — well inside Intuit's ~24h
// rotation grace, so a single missed run is survivable.
setTimeout(refreshAndPersist, 8000);
setInterval(refreshAndPersist, 6 * 60 * 60 * 1000);
