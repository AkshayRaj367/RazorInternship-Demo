# mcp-server — Node 20 + Express (JSON-RPC 2.0 MCP catalog surface)
# Build context is the REPO ROOT so npm workspaces resolve.
FROM node:20-alpine

WORKDIR /app

# Install first (layer cache), then build.
COPY package.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/mcp-server/package.json apps/mcp-server/

RUN npm install --workspaces --include-workspace-root --no-audit --no-fund \
    -w packages/shared-types -w apps/mcp-server

# Copy sources and build.
COPY packages/shared-types/tsconfig.json packages/shared-types/
COPY packages/shared-types/src packages/shared-types/src
COPY apps/mcp-server/tsconfig.json apps/mcp-server/
COPY apps/mcp-server/src apps/mcp-server/src

RUN npm run build -w packages/shared-types && npm run build -w apps/mcp-server

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "apps/mcp-server/dist/server.js"]
