# ── Stage 1: Build ────────────────────────────────────────────
FROM node:22-slim AS builder

# Build tools needed for argon2 native compilation (ADR-019)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (layer cache)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# ── Stage 2: Production deps (with native build tools for argon2) ──
FROM node:22-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── Stage 3: Production (no build tools — slim) ──────────────
FROM node:22-slim AS production

WORKDIR /app

# Copy production node_modules from deps stage (includes compiled argon2)
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./

# Copy built output from builder
COPY --from=builder /app/dist ./dist

# Copy non-compiled assets needed at runtime
COPY legacy/ legacy/
COPY docs/ docs/

ENV NODE_ENV=production
ENV MAJEL_PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:8080/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "dist/server/index.js"]
