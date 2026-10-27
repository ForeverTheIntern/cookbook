# The factory dashboard. Build: docker build -t factory-dashboard dashboard/
# Run: see "Host the dashboard anywhere" in docs/reference.md.
FROM node:22.14.0-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN NEXT_OUTPUT=standalone npx next build

FROM node:22.14.0-slim
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 SA_PORTAL_PORT=8787 SA_PORTAL_DATA_DIR=/data/pglite
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY migrations ./migrations
COPY scripts ./scripts
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.SA_PORTAL_PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["sh", "-c", "node scripts/migrate.mjs && node server.js"]
