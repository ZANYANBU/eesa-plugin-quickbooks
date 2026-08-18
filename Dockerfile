# Eesa QuickBooks Online plugin.
#
# Unlike the previous version, this image does NOT clone and run Intuit's MCP
# server as a subprocess. Every one of its 142 tools was ported into src/tools/
# so they can run per tenant — Intuit's server builds a single QuickBooks client
# from environment variables at module load, which for a hosted multi-tenant
# service would mean every workspace sharing one company's books.
#
# No credential is persisted, and there is no volume: each tenant's QuickBooks
# credential lives in Eesa's connections broker and is fetched per call. The
# token file the old image needed — and the volume it needed to survive a
# redeploy — are gone with it.
#
# The one thing this service does store is who may use it, in Postgres
# (DATABASE_URL, db/schema.sql). That table holds no secrets and nothing that
# rotates, so it carries none of the hazards the token file did.
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY manifest.json ./manifest.json
COPY db ./db
COPY src ./src
COPY public ./public

# Read-only by default. All three are deliberate: this container reaches a real
# company's accounting records, and Eesa's own permission checks are code, which
# can have bugs. With these set, the tools are never registered at all, so a
# gating bug cannot become a wrong journal entry. Unset them in the deployment
# when posting is actually being turned on — and see the README first.
ENV QUICKBOOKS_DISABLE_WRITE=true
ENV QUICKBOOKS_DISABLE_UPDATE=true
ENV QUICKBOOKS_DISABLE_DELETE=true

ENV PORT=8080
EXPOSE 8080

# Liveness only. /health/config is the readiness probe — it reports whether the
# container can reach Eesa at all, which /health deliberately does not check so
# that it can still answer during boot.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "src/server.js"]
