  # --- STAGE 1: Build Stage ---
  FROM node:24-bookworm-slim AS base
  RUN apt-get update && apt-get install -y --no-install-recommends openssl \
      && rm -rf /var/lib/apt/lists/*

  FROM base AS builder
  WORKDIR /app

  # Copy package files để tận dụng Docker layer caching
  COPY package*.json ./

  # Cài đặt toàn bộ dependencies (bao gồm devDependencies để build TS)
  RUN npm ci

  # Generate the client into src before compiling TypeScript.
  COPY prisma/schema.prisma ./prisma/schema.prisma
  COPY prisma7.config.ts ./
  RUN npx prisma generate --config prisma7.config.ts

  # Copy toàn bộ mã nguồn
  COPY . .

  # Build code (chuyển đổi TS sang JS trong thư mục dist)
  RUN npm run build

  # --- STAGE 2: Production Stage ---
  FROM base AS runner
  WORKDIR /app
  ENV NODE_ENV=production

  # Chỉ copy package files và cài đặt dependencies production
  COPY package*.json ./
  RUN npm ci --omit=dev && npm cache clean --force

  # Copy thư mục dist đã build từ Stage 1 sang
  COPY --from=builder --chown=node:node /app/dist ./dist
  COPY --from=builder --chown=node:node /app/prisma ./prisma
  COPY --from=builder --chown=node:node /app/prisma7.config.ts ./prisma7.config.ts
  COPY --from=builder --chown=node:node /app/src/generated/prisma ./src/generated/prisma
  # Seeds share source utilities and the organization permission catalog.
  COPY --from=builder --chown=node:node /app/src/common ./src/common

  # Chuyển sang user non-root
  USER node

  # Khai báo port backend lắng nghe
  EXPOSE 3000

  # Readiness probe (PostgreSQL). The slim image has no curl/wget, so use node.
  HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/ready',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

  # Lệnh chạy ứng dụng
  CMD ["node", "dist/main.js"]
