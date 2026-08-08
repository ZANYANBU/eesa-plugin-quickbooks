# Eesa QuickBooks Online plugin
#
# Wraps Intuit's OFFICIAL MCP server (github.com/intuit/quickbooks-online-mcp-server,
# Apache-2.0) in a thin HTTP bridge, because Eesa's MCPClient speaks stateless
# JSON-RPC over HTTP and that server speaks stdio MCP.
#
# The source is PINNED to a commit, not a branch. This container will hold
# QuickBooks credentials for a live company; "whatever main happened to be at
# build time" is not an acceptable provenance for that. Bump deliberately.
#
# NOTE: @qboapi/qbo-mcp-server is not published to npm, so it is built from
# source here rather than installed.
FROM node:20-slim AS qbo

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
ARG QBO_MCP_SHA=099351858ee696dbbeb00dc7ca8e3a86276d86bb
RUN git clone --filter=blob:none https://github.com/intuit/quickbooks-online-mcp-server.git . \
    && git checkout ${QBO_MCP_SHA} \
    && npm ci \
    && npm run build \
    && npm prune --omit=dev

# ---------------------------------------------------------------------------
FROM node:20-slim

WORKDIR /app

# Intuit's server, built.
COPY --from=qbo /build/dist ./dist
COPY --from=qbo /build/node_modules ./node_modules
COPY --from=qbo /build/package.json ./package.json

# Our bridge and its own dependency (the MCP client SDK is already present
# above, but declare it so the bridge is not silently relying on a transitive).
COPY gateway/package.json ./gateway/package.json
RUN cd gateway && npm install --omit=dev
COPY gateway/gateway.mjs ./gateway/gateway.mjs

# Where the rotated refresh token lives. MUST be a mounted volume — see the
# comment in gateway.mjs. Without one the token is lost on every redeploy and
# the connection dies within a day, which is exactly how the previous
# deployment of this died.
ENV QB_TOKEN_STORE=/data/qb-token.json
ENV GATEWAY_PORT=8080
EXPOSE 8080

CMD ["node", "gateway/gateway.mjs"]
