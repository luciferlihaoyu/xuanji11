# ============================================================
# 璇玑智脑 - Zeabur 部署用 Dockerfile
# 多阶段构建：builder → runner
# ============================================================

# ------------------ 阶段1: 构建 ------------------
FROM node:20-slim AS builder

WORKDIR /app

# 安装构建工具和 Python（esbuild 等需要）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# 复制依赖文件并安装（利用 Docker 缓存层）
COPY package.json package-lock.json* ./
RUN npm ci

# 复制项目源码
COPY . .

# 构建前端 + 后端（vite build + esbuild）
RUN npm run build

# ------------------ 阶段2: 运行 ------------------
FROM node:20-alpine AS runner

WORKDIR /app

# 设置生产环境
ENV NODE_ENV=production
ENV PORT=3000

# 复制 package 文件并只安装生产依赖
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# 复制构建产物
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle.config.ts ./
COPY --from=builder /app/db ./db

# 暴露端口
EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/trpc/ping || exit 1

# 启动命令
CMD ["node", "dist/boot.js"]
