# ── Stage 1: Build ────────────────────────────────────────────
FROM node:22-slim AS builder

# @libsql/client uses better-sqlite3-multiple-ciphers which needs native compilation
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (layer cache)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# ── Stage 2: Production ──────────────────────────────────────
FROM node:22-slim AS production

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built output from builder
COPY --from=builder /app/dist ./dist

# Copy non-compiled assets needed at runtime
COPY legacy/ legacy/
COPY docs/ docs/

# Data directory for SQLite databases
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV MAJEL_PORT=8080
ENV LEX_WORKSPACE_ROOT=/app/data

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:8080/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "dist/server/index.js"]
