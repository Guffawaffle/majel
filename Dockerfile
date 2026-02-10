# ── Stage 1: Build ────────────────────────────────────────────
FROM node:22-slim AS builder

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

WORKDIR /app

# Production deps only (pg is pure JS — no native build tools needed)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

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
