# Palermo game server (web UI + REST + Socket.IO + MCP endpoint)
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/runner/package.json apps/runner/
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 NODE_NO_WARNINGS=1
VOLUME /data
EXPOSE 3000
CMD ["npx", "tsx", "apps/server/src/index.ts"]
