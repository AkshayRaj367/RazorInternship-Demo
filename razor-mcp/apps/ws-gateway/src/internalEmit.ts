/**
 * POST /internal/emit — the ONLY way Flask reaches clients.
 * Guarded by the X-Internal-Secret header validated (timing-safe) against
 * INTERNAL_WS_SECRET. Relays { room, event, payload } into the Socket.IO room.
 */
import type { NextFunction, Request, Response, Router } from 'express';
import { Router as createRouter } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Server as SocketServer } from 'socket.io';

const ROOM_RE = /^[A-Za-z0-9._:-]{6,128}$/;
const EVENT_RE = /^[a-z][a-z0-9_:.-]{2,64}$/; // e.g. audit:event, recovery:alt_link, otp:required

function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function buildInternalEmitRouter(io: SocketServer, internalSecret: string): Router {
  const router = createRouter();

  router.post('/internal/emit', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const provided = req.header('x-internal-secret');
      if (typeof provided !== 'string' || provided.length === 0 || !secretsMatch(provided, internalSecret)) {
        // Constant-ish time rejection; no detail leakage.
        res.status(401).json({ error: 'UNAUTHORIZED' });
        return;
      }
      const body = (req.body ?? {}) as { room?: unknown; event?: unknown; payload?: unknown };
      const room = body.room;
      const event = body.event;
      if (typeof room !== 'string' || !ROOM_RE.test(room) || typeof event !== 'string' || !EVENT_RE.test(event)) {
        res.status(400).json({ error: 'INVALID_ROOM_OR_EVENT' });
        return;
      }
      // Relay to the room (room == sessionId — isolated timeline per session).
      io.to(room).emit(event, body.payload ?? {});
      res.status(202).json({ ok: true, room, event });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
