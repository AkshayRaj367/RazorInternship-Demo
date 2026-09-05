/**
 * ws-gateway entrypoint — Express + Socket.IO hub.
 * Flask (agent-service) NEVER talks Socket.IO directly: it POSTs /internal/emit
 * with the shared secret, and this service relays into sessionId rooms.
 */
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import helmet from 'helmet';
import { attachSocketIo } from './socket';
import { buildInternalEmitRouter } from './internalEmit';
import { connectDb, disconnectDb, isDbConnected } from './db';

function loadDotEnv(): void {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '../../../.env'), // apps/ws-gateway/dist -> repo root
  ];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dotenv = require('dotenv') as typeof import('dotenv');
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      dotenv.config({ path: p });
      console.log(`[ws-gateway] loaded env from ${p}`);
      return;
    }
  }
}

async function main(): Promise<void> {
  loadDotEnv();

  const PORT = parseInt(process.env.WS_PORT ?? process.env.PORT ?? '4001', 10);
  const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/razormcp?replicaSet=rs0&directConnection=true';
  const INTERNAL_WS_SECRET = process.env.INTERNAL_WS_SECRET ?? '';
  const AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET ?? '';
  const WS_ALLOWED_ORIGINS = (process.env.WS_ALLOWED_ORIGINS ?? '*')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (!INTERNAL_WS_SECRET || INTERNAL_WS_SECRET.length < 8) {
    console.warn('[ws-gateway] INTERNAL_WS_SECRET is missing/short — /internal/emit will reject everything until it is set');
  }
  if (!AUTH_JWT_SECRET || AUTH_JWT_SECRET.length < 16) {
    console.warn('[ws-gateway] AUTH_JWT_SECRET missing — sockets fall back to legacy session rooms (no per-user isolation)');
  }

  await connectDb(MONGODB_URI);

  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '64kb' }));

  // Liveness/readiness (docker healthcheck target). Not socket-related, no auth.
  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true, db: isDbConnected(), service: 'ws-gateway' });
  });

  const httpServer = http.createServer(app);
  const io = attachSocketIo(httpServer, WS_ALLOWED_ORIGINS, AUTH_JWT_SECRET);

  // Internal relay bridge — guarded by the shared secret.
  app.use('/', buildInternalEmitRouter(io, INTERNAL_WS_SECRET || 'unset-secret-0000000000'));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[ws-gateway] unhandled error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });

  httpServer.listen(PORT, () => {
    console.log(`[ws-gateway] Socket.IO hub listening on :${PORT} (origins: ${WS_ALLOWED_ORIGINS.join(', ') || '*'})`);
  });

  const shutdown = (signal: string) => {
    console.log(`[ws-gateway] ${signal} received, shutting down`);
    io.close();
    httpServer.close(async () => {
      await disconnectDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[ws-gateway] fatal boot error:', err);
  process.exit(1);
});
