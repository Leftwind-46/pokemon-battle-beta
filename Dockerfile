# Zeabur/Nixpacks 預設會從 Docker Hub 拉 node:22 當基底，匿名拉取會被限流（HTTP 429
# Too Many Requests）導致建置失敗。改用 AWS ECR Public 的 Docker 官方映像鏡像（同一份
# node:22-slim，tag 完全對應，但走 public.ecr.aws 不受 Docker Hub 限流）。
FROM public.ecr.aws/docker/library/node:22-slim

WORKDIR /app

# 先只複製依賴清單，讓 npm ci 這層在原始碼變動時仍能命中 build cache
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 其餘原始碼（server.js + public/ 靜態資源 + scripts/）
COPY . .

ENV NODE_ENV=production
# server.js 讀 process.env.PORT（Zeabur 會注入），沒有時 fallback 3000
EXPOSE 3000
CMD ["node", "server.js"]
