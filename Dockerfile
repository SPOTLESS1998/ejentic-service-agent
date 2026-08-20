# Ejentic Service Agent — single-image, self-contained deployment.
# Builds the KB index at image-build time so the container starts ready to chat.
FROM node:20-alpine

WORKDIR /app

# Install dependencies first (better layer caching).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install

# Copy the source, tenant configs, and knowledge.
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY tenants ./tenants

# Pre-build the knowledge index for the default tenant (offline local embedder
# needs no keys). Safe to re-run at runtime via `npm run ingest` or /admin/reindex.
ARG TENANT=ejentic
ENV TENANT=${TENANT}
RUN npx tsx scripts/ingest.ts || echo "ingest skipped (will build at runtime)"

EXPOSE 4000
ENV PORT=4000

CMD ["npx", "tsx", "src/server.ts"]
