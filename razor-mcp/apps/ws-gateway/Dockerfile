# ws-gateway — Node 20 + Express + Socket.IO realtime hub
# Build context is the REPO ROOT so npm workspaces resolve.
FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/ws-gateway/package.json apps/ws-gateway/

RUN npm install --workspaces --include-workspace-root --no-audit --no-fund \
    -w packages/shared-types -w apps/ws-gateway

COPY packages/shared-types/tsconfig.json packages/shared-types/
COPY packages/shared-types/src packages/shared-types/src
COPY apps/ws-gateway/tsconfig.json apps/ws-gateway/
COPY apps/ws-gateway/src apps/ws-gateway/src

RUN npm run build -w packages/shared-types && npm run build -w apps/ws-gateway

ENV NODE_ENV=production
EXPOSE 4001

CMD ["node", "apps/ws-gateway/dist/server.js"]
