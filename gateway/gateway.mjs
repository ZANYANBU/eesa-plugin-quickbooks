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
import crypto from "node:crypto";

const TOKEN_STORE = process.env.QB_TOKEN_STORE || "/data/qb-token.json";
const ENVIRONMENT = process.env.QUICKBOOKS_ENVIRONMENT || "sandbox";
// Where Intuit sends the person back. MUST be registered on the Intuit app, and
// for PRODUCTION keys it must be https — Intuit only permits http://localhost on
// development keys, which is why connecting real books cannot use the localhost
// flow that works against a sandbox.
const REDIRECT_URI =
  process.env.QB_OAUTH_REDIRECT_URI ||
  (process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/oauth/callback`
    : "");
// Shared secret on the connect link. Without it, anyone who found this URL
// could point the plugin at a QuickBooks company of their own choosing.
const CONNECT_TOKEN = process.env.QB_CONNECT_TOKEN || "";
let pendingState = null;

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

      // Intuit ROTATES the refresh token, and a child is spawned with a COPY of
      // process.env taken at spawn time — later mutations here never reach it.
      // So the moment we rotate, the running child is holding a dead token. It
      // does not notice until its ~1h access token expires, at which point
      // Intuit's client gives up and starts its INTERACTIVE OAuth flow, which
      // binds :8000 and fails with EADDRINUSE on every retry. tools/list keeps
      // working (it needs no auth), so the server looks healthy while every
      // tools/call returns an error — as `isError:false` text, no less.
      //
      // Drop the child here. The next call respawns it with the new token.
      if (rotated && client) {
        const stale = client;
        client = null;
        Promise.resolve()
          .then(() => stale.close())
          .catch(() => {})
          .finally(() =>
            console.error("[gateway] token rotated; dropped the QBO MCP child so the next call respawns it"),
          );
      }
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
  spawns += 1;
  c.onclose = () => {
    console.error("[gateway] QBO MCP transport closed; will reconnect on next call");
    if (client === c) client = null;
  };
  console.error(`[gateway] connected to QBO MCP (environment=${ENVIRONMENT})`);
  return c;
}

let spawns = 0;
let drops = 0;

/**
 * Let go of a child — and KILL it.
 *
 * The error path used to set `client = null` and nothing else. The transport
 * stayed open, the `node dist/index.js` underneath it stayed alive, and the
 * next call spawned another. Every "invalid arguments" error — a tool doing
 * its job — leaked one Intuit MCP server. A sweep of the tool list on
 * 2026-09-10 leaked about two dozen per pass; three passes and the container
 * ran out of memory, every spawn failed, and every call answered
 * "Connection closed" until a redeploy. /health said ok the whole time.
 */
function drop(c, why) {
  if (client === c) client = null;
  drops += 1;
  console.error(`[gateway] dropping QBO MCP child (${why}); drops=${drops}`);
  Promise.resolve().then(() => c.close()).catch(() => {});
}

/** Only a dead transport is a reason to drop the child. A tool refusing its
 *  arguments is the child working. */
function transportDead(e) {
  return /Connection closed|Not connected|EPIPE|ECONNRESET|write after end/i.test(
    String((e && e.message) || e),
  );
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

// async because the OAuth callback below exchanges a code before replying.
const server = http.createServer(async (req, res) => {
  // Liveness. Deliberately unauthenticated and deliberately NOT touching
  // Intuit — Coolify needs it to answer during boot.
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, {
      ok: true, plugin: "quickbooks", connected: !!client, environment: ENVIRONMENT,
      // How many children this container has started and let go. A number
      // that climbs with every error is the leak that took the service down.
      child_spawns: spawns, child_drops: drops,
    });
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
  // ── Connecting a QuickBooks company ────────────────────────────────────
  //
  // The plugin does its own OAuth, for a reason that only shows up in
  // production: Intuit requires redirect URIs to be HTTPS there, and only
  // allows http://localhost on DEVELOPMENT keys. The localhost dance that works
  // against a sandbox simply cannot be used against real books.
  //
  // Doing it here also means the refresh token never travels: it is written
  // straight into this container's token store, which is the only thing that
  // reads it. Nothing has to hand a standing grant to somebody else's books
  // across a system boundary.
  //
  // Guarded by CONNECT_TOKEN — without it anyone who found this URL could point
  // the plugin at a company of their own choosing.
  if (req.method === "GET" && req.url.startsWith("/oauth/start")) {
    const q = new URL(req.url, "http://x").searchParams;
    if (!CONNECT_TOKEN || q.get("key") !== CONNECT_TOKEN) {
      return send(res, 403, { error: "forbidden" });
    }
    const cid = process.env.QUICKBOOKS_CLIENT_ID;
    if (!cid) return send(res, 500, { error: "QUICKBOOKS_CLIENT_ID is not set" });
    pendingState = crypto.randomBytes(16).toString("hex");
    const p = new URLSearchParams({
      client_id: cid,
      response_type: "code",
      scope: "com.intuit.quickbooks.accounting openid profile email",
      redirect_uri: REDIRECT_URI,
      state: pendingState,
      // Force a fresh sign-in. An inherited Intuit session authorises as
      // whoever the browser already knows, which is how a connection ends up
      // owned by the wrong account without anybody noticing.
      prompt: "login",
    });
    res.writeHead(302, { Location: "https://appcenter.intuit.com/connect/oauth2?" + p });
    return res.end();
  }

  if (req.method === "GET" && req.url.startsWith("/oauth/callback")) {
    const q = new URL(req.url, "http://x").searchParams;
    const html = (msg) =>
      `<!doctype html><meta charset=utf-8><style>body{font:16px system-ui;padding:40px;max-width:32em}</style>${msg}`;
    if (q.get("error")) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html(`<h3>QuickBooks refused the connection</h3><p>${q.get("error")}</p>`));
    }
    if (!pendingState || q.get("state") !== pendingState) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html("<h3>That link has expired</h3><p>Start again from the connect link.</p>"));
    }
    pendingState = null;
    try {
      const auth = Buffer.from(
        process.env.QUICKBOOKS_CLIENT_ID + ":" + process.env.QUICKBOOKS_CLIENT_SECRET,
      ).toString("base64");
      const r = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
        method: "POST",
        headers: {
          Authorization: "Basic " + auth,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: q.get("code"),
          redirect_uri: REDIRECT_URI,
        }).toString(),
      });
      const j = await r.json().catch(() => ({}));
      if (!j.refresh_token) {
        res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
        // Never echo the body: it can carry the grant.
        return res.end(html(`<h3>QuickBooks did not issue a token</h3><p>HTTP ${r.status}.</p>`));
      }
      currentRefreshToken = j.refresh_token;
      process.env.QUICKBOOKS_REFRESH_TOKEN = j.refresh_token;
      const realm = q.get("realmId");
      if (realm) process.env.QUICKBOOKS_REALM_ID = realm;
      const saved = persistToken(j.refresh_token);
      lastRefreshAt = new Date().toISOString();
      lastRefreshError = saved ? null : "persist failed";
      // Drop the child so the next call respawns it with the new token — the
      // same reason a rotation drops it. A child holds a COPY of process.env
      // from spawn time and would keep using the old grant until it died.
      try { if (client) { await client.close?.(); } } catch (e) {}
      client = null;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html(
        `<h3>QuickBooks connected</h3><p>Company <code>${realm || "?"}</code>, ` +
        `${ENVIRONMENT}. ${saved ? "Saved." : "<b>NOT saved — the /data volume is missing.</b>"}</p>` +
        `<p>You can close this window.</p>`));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html(`<h3>Could not complete the connection</h3><p>${String(e && e.message)}</p>`));
    }
  }

  // The embedded UI. Unauthenticated ON PURPOSE: it is a static page holding no
  // credential and no data. Eesa frames it and hands it a short-lived session
  // token by postMessage; every figure it shows comes back through Eesa's
  // gateway, which checks the person's recorded QuickBooks role first. Serving
  // the HTML to an anonymous request reveals nothing but the layout.
  if (req.method === "GET" && (req.url === "/app" || req.url.startsWith("/app?"))) {
    try {
      const html = fs.readFileSync(new URL("../public/app.html", import.meta.url));
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        // Framed by Eesa, and by nobody else.
        "Content-Security-Policy": "frame-ancestors https://eesa.ai https://*.eesa.ai",
        "Cache-Control": "no-store",
      });
      return res.end(html);
    } catch (e) {
      return send(res, 500, { error: "app_unavailable", detail: String(e && e.message) });
    }
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
    if (!["tools/list", "tools/call", "ping", "initialize"].includes(method)) {
      return send(res, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "method not found: " + method },
      });
    }
    const run = async (c) => {
      if (method === "tools/list") return c.listTools();
      if (method === "tools/call") {
        return c.callTool({ name: msg.params?.name, arguments: msg.params?.arguments || {} });
      }
      return { ok: true };
    };
    // A child that has died is dropped — killed, not abandoned — and the call
    // is made once more on a fresh one, so one dead process costs a second and
    // not an outage. Any other error is the child answering, and is passed on.
    let c;
    try {
      c = await ensure();
      const result = await run(c);
      return send(res, 200, { jsonrpc: "2.0", id, result });
    } catch (e) {
      if (!transportDead(e)) {
        return send(res, 200, {
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: String((e && e.message) || e) },
        });
      }
      if (c) drop(c, "transport dead: " + String((e && e.message) || e).slice(0, 60));
    }
    try {
      const fresh = await ensure();
      const result = await run(fresh);
      return send(res, 200, { jsonrpc: "2.0", id, result });
    } catch (e) {
      if (client && transportDead(e)) drop(client, "dead again after respawn");
      return send(res, 200, {
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
//
// The interval is 45 MINUTES, not hours, and that is load-bearing. Intuit's
// client refreshes on its own once its access token (~60 min) is close to
// expiry — and it would refresh using the token it was spawned with, rotating
// it out from under us and leaving OUR stored copy dead. Refreshing and
// respawning inside that 60-minute window means the child is always younger
// than its access token, so it never reaches the point of refreshing itself.
// Exactly one component rotates this credential. Do not lengthen this past the
// access-token lifetime without making the child stop managing its own tokens.
setTimeout(refreshAndPersist, 8000);
setInterval(refreshAndPersist, 45 * 60 * 1000);
