# ============================================================
# 鐠囩帒鏅鸿剳 - Zeabur 閮ㄧ讲鐢?Dockerfile
# 澶氶樁娈垫瀯寤猴細builder 鈫?runner
# ============================================================

# ------------------ 闃舵1: 鏋勫缓 ------------------
FROM node:20-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# ------------------ 闃舵2: 杩愯 ------------------
FROM node:20-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle.config.ts ./
COPY --from=builder /app/db ./db

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "const http = require('http'); http.get('http://localhost:3000/health', r => { process.exit(r.statusCode !== 200 ? 1 : 0) }).on('error', () => process.exit(1))"

CMD ["./docker-entrypoint.sh"]
