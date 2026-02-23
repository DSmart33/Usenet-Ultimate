# ============================================================================
# Usenet Ultimate - Multi-stage Docker Build
# ============================================================================

ARG VERSION=dev

# Stage 1: Build the React UI
FROM node:20-alpine AS ui-builder
WORKDIR /app/ui
COPY ui/package.json ui/package-lock.json* ./
RUN npm ci
COPY ui/ .
RUN npm run build

# Stage 2: Build the backend TypeScript
FROM node:20-alpine AS backend-builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 3: Production runtime
FROM node:20-alpine AS runtime
ARG VERSION=dev
LABEL org.opencontainers.image.title="Usenet Ultimate"
LABEL org.opencontainers.image.description="Modern Usenet streaming addon for Stremio"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.source="https://github.com/DSmart33/Usenet-Ultimate"
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built backend
COPY --from=backend-builder /app/dist ./dist

# Copy built UI
COPY --from=ui-builder /app/ui/dist ./ui/dist

# Create config directory (config.json is created at runtime by entrypoint)
RUN mkdir -p /app/config

# Copy entrypoint script
COPY scripts/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Default environment
ENV NODE_ENV=production
ENV PORT=1337

EXPOSE 1337

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:1337/health || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
