/**
 * mcp-server entrypoint — Express + helmet + 100kb body limit + X-API-Key auth +
 * per-key rate limiting + JSON-RPC 2.0 MCP surface + REST fallback.
 */
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import helmet from 'helmet';
import { connectDb, disconnectDb, isDbConnected } from './db';
import { apiKeyAuth } from './middleware/apiKeyAuth';
import { perKeyRateLimit } from './middleware/rateLimit';
import { buildMcpRouter } from './routes/mcpRoute';
import { buildRestRouter, restErrorHandler } from './routes/restRoute';
import { buildInternalRouter } from './routes/internalRoute';
import { jsonRpcFailure, McpError, INTERNAL_CODE } from './mcp/errors';
import { seedCatalog, ensureApiClient } from './scripts/seedCatalog';

/** Load repo-root .env for local dev (docker-compose injects env directly). */
function loadDotEnv(): void {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '../../../.env'), // apps/mcp-server/dist -> repo root
  ];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dotenv = require('dotenv') as typeof import('dotenv');
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      dotenv.config({ path: p });
      console.log(`[mcp-server] loaded env from ${p}`);
      return;
    }
  }
}

async function main(): Promise<void> {
  loadDotEnv();

  const PORT = parseInt(process.env.MCP_PORT ?? process.env.PORT ?? '4000', 10);
  const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/razormcp?replicaSet=rs0&directConnection=true';
  const MCP_API_KEY_SALT = process.env.MCP_API_KEY_SALT ?? 'change-me-to-a-long-random-salt';
  const MCP_SERVER_INTERNAL_API_KEY = process.env.MCP_SERVER_INTERNAL_API_KEY ?? '';

  await connectDb(MONGODB_URI);

  // Bootstrap: internal API client for agent-service (+ Next.js server-side proxy).
  if (MCP_SERVER_INTERNAL_API_KEY && MCP_SERVER_INTERNAL_API_KEY.length >= 8) {
    await ensureApiClient(MCP_SERVER_INTERNAL_API_KEY, MCP_API_KEY_SALT, 'agent-service-internal', 600);
  } else {
    console.warn('[mcp-server] MCP_SERVER_INTERNAL_API_KEY not set — agent-service will get 401s');
  }

  // Real-time web search cache TTL + enablement.
  console.log(
    `[mcp-server] realtime web search: WEB_SEARCH_ENABLED=${process.env.WEB_SEARCH_ENABLED ?? 'true'}, ` +
    `cache ttl ${process.env.SEARCH_CACHE_TTL_SECONDS ?? '1800'}s (Bing -> DDG -> Google chain + Bing images)`
  );

  // Bootstrap: 20-item catalog (idempotent upsert).
  if ((process.env.SEED_CATALOG ?? 'true').toLowerCase() === 'true') {
    const r = await seedCatalog();
    console.log(`[mcp-server] catalog ready: ${r.inserted} new, ${r.updated} existing (total ${r.total})`);
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  // Hard body-size limit: 100kb everywhere.
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  // Unauthenticated liveness/readiness probe (used by docker healthcheck).
  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true, db: isDbConnected(), service: 'mcp-server' });
  });

  // Auth FIRST, then per-key rate limiting (keyed on the hashed API key).
  const auth = apiKeyAuth(MCP_API_KEY_SALT);
  const limiter = perKeyRateLimit();

  // Internal bridge (agent-key registration from agent-service auth flows).
  // NOT behind apiKeyAuth — it authenticates with the shared internal secret.
  const internalRouter = buildInternalRouter(MCP_API_KEY_SALT, MCP_SERVER_INTERNAL_API_KEY);
  app.use('/', internalRouter);

  const mcpRouter = buildMcpRouter();
  app.use('/', auth, limiter, mcpRouter);

  const restRouter = buildRestRouter();
  app.use('/', auth, limiter, restRouter);

  // Central error -> JSON-RPC failure mapping.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof McpError) {
      res.status(err.httpStatus ?? 400).json(jsonRpcFailure(null, err.code, err.message, err.data));
      return;
    }
    const bodyParse = err as { type?: string; status?: number };
    if (bodyParse?.type === 'entity.parse.failed' || bodyParse?.type === 'entity.too.large') {
      res.status(400).json(jsonRpcFailure(null, -32700, bodyParse.type === 'entity.too.large' ? 'PAYLOAD_TOO_LARGE' : 'PARSE_ERROR'));
      return;
    }
    console.error('[mcp-server] unhandled error:', err);
    res.status(500).json(jsonRpcFailure(null, INTERNAL_CODE, 'INTERNAL_ERROR'));
  });

  const server = app.listen(PORT, () => {
    console.log(`[mcp-server] listening on :${PORT} (MCP JSON-RPC 2.0 + REST fallback)`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[mcp-server] ${signal} received, shutting down`);
    server.close(async () => {
      await disconnectDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[mcp-server] fatal boot error:', err);
  process.exit(1);
});
