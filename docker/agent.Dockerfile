# Sandbox for AI agents (needed for no-rules mode, recommended for Codex).
# Build:  docker build -f docker/agent.Dockerfile -t palermo-agent .
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli
RUN useradd -m player
WORKDIR /palermo
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/runner/package.json apps/runner/
RUN npm ci --ignore-scripts
COPY packages packages
COPY apps/runner apps/runner
COPY skills skills
USER player
ENTRYPOINT ["npx", "tsx", "apps/runner/src/index.ts"]
