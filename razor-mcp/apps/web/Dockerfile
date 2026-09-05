# web — Next.js 16 App Router (chat UI + live audit dashboard + Onyx widget)
# Build context is the REPO ROOT so npm workspaces resolve.
FROM node:20-alpine

WORKDIR /app

# NEXT_PUBLIC_* vars are inlined at BUILD time -> pass them as build args.
ARG NEXT_PUBLIC_WS_GATEWAY_URL=http://localhost:4001

COPY package.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/web/package.json apps/web/

RUN npm install --workspaces --include-workspace-root --no-audit --no-fund \
    -w packages/shared-types -w apps/web

COPY packages/shared-types/tsconfig.json packages/shared-types/
COPY packages/shared-types/src packages/shared-types/src
COPY apps/web/ apps/web/

RUN npm run build -w packages/shared-types && \
    NEXT_PUBLIC_WS_GATEWAY_URL=$NEXT_PUBLIC_WS_GATEWAY_URL npm run build -w apps/web

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "run", "start", "-w", "apps/web"]
