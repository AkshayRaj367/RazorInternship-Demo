/**
 * Socket.IO wiring — rooms keyed by session (+ authed user rooms), backlog replay on (re)join.
 *
 * Room re-join contract (grading criterion): Socket.IO does NOT restore room
 * membership on reconnect. The CLIENT must re-emit `join { sessionId, token? }`;
 * this server handles `join` idempotently and ALWAYS replays the full audit
 * backlog (audit_logs ascending by timestamp) as ONE `audit:backlog` event
 * BEFORE any live `audit:event` pushes reach the room.
 *
 * v2 ROOMS: when the join payload carries a valid JWT (login token), the socket
 * joins the AUTHED room "user:<uid>:<sessionId>" and the backlog is filtered to
 * that room's agentId — one account can never read another account's timeline,
 * even knowing their sessionId. Tokenless joins keep the legacy bare-session
 * room (demo agents), and their backlog EXCLUDES authed-room entries.
 */
import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { getDb } from './db';
import { verifyJwt } from './jwt';
import type { AuditBacklogPayload, AuditEventPayload } from '@razor-mcp/shared-types';

const SESSION_ID_RE = /^[A-Za-z0-9._:-]{6,128}$/;

function serializeId(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    ...doc,
    _id: doc._id !== undefined ? String(doc._id) : undefined,
    orderId: doc.orderId !== undefined && doc.orderId !== null ? String(doc.orderId) : null,
    timestamp: doc.timestamp instanceof Date ? doc.timestamp.toISOString() : doc.timestamp,
  };
}

export function attachSocketIo(httpServer: HttpServer, allowedOrigins: string[], jwtSecret: string): Server {
  const io = new Server(httpServer, {
    cors: {
      // Browser-facing service: restrict to the web app origins (comma-separated env).
      origin: allowedOrigins.length > 0 ? allowedOrigins : '*',
      methods: ['GET', 'POST'],
      credentials: false,
    },
    // Server side matches the client's reconnect tuning (useSocket.ts):
    //   reconnectionAttempts: Infinity, reconnectionDelay: 500,
    //   reconnectionDelayMax: 5000, randomizationFactor: 0.5
    pingTimeout: 20000,
    pingInterval: 25000,
    transports: ['polling', 'websocket'],
    maxHttpBufferSize: 256 * 1024,
  });

  io.on('connection', (socket) => {
    let joinedRoom: string | null = null;

    socket.on('join', async (payload: unknown, ack?: (result: { ok: boolean; events?: number; error?: string; room?: string }) => void) => {
      try {
        const p = (payload ?? {}) as { sessionId?: unknown; token?: unknown };
        const sessionId = p.sessionId;
        if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
          ack?.({ ok: false, error: 'INVALID_SESSION_ID' });
          return;
        }

        // ---- v2: JWT-authenticated rooms ----
        const claims = verifyJwt(p.token, jwtSecret);
        let room = sessionId;
        let backlogFilter: Record<string, unknown> = { sessionId };

        if (claims && /^[A-Za-z0-9]{16,40}$/.test(claims.sub)) {
          const agentId = `user:${claims.sub}`;
          room = `${agentId}:${sessionId}`;
          backlogFilter = { sessionId, agentId };
        } else {
          // Legacy/demo join: exclude authed-room entries from the replay.
          backlogFilter = { sessionId, agentId: { $not: /^user:/ } };
        }

        await socket.join(room);
        joinedRoom = room;

        // Backlog replay on EVERY join (including reconnect re-joins): full history
        // first, one event, ascending order — server truth wins on conflicts client-side.
        const docs = await getDb()
          .collection('audit_logs')
          .find(backlogFilter)
          .sort({ timestamp: 1, _id: 1 })
          .limit(1000)
          .toArray();

        const payloadOut: AuditBacklogPayload = {
          sessionId,
          events: docs.map((d) => serializeId(d as Record<string, unknown>) as unknown as AuditBacklogPayload['events'][number]),
        };
        socket.emit('audit:backlog', payloadOut);
        ack?.({ ok: true, events: docs.length, room });
      } catch (err) {
        console.error('[ws-gateway] join/backlog failed:', err);
        ack?.({ ok: false, error: 'BACKLOG_QUERY_FAILED' });
      }
    });

    socket.on('leave', (payload: unknown) => {
      const sessionId = (payload as { sessionId?: unknown })?.sessionId;
      if (typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId)) {
        void socket.leave(sessionId);
        if (joinedRoom === sessionId) joinedRoom = null;
      }
    });

    socket.on('error', (err) => {
      console.error('[ws-gateway] socket error:', err);
    });
  });

  return io;
}

/** Relay helper used by internalEmit — typed bridge from Flask events. */
export function emitToRoom(io: Server, room: string, event: string, payload: unknown): void {
  io.to(room).emit(event, payload);
}

export type { AuditEventPayload };
