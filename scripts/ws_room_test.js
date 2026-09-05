/**
 * ws-gateway v2 room test: JWT-authenticated join lands in the user room,
 * backlog is room-filtered, and internal emits reach the right room.
 */
const { io } = require('/home/z/my-project/razor-mcp/apps/web/node_modules/socket.io-client');

const WS = 'http://127.0.0.1:4001';
const AUTH_HEADER = { Authorization: 'Bearer TOKEN' };

function api(path, body, headers = {}) {
  return fetch('http://127.0.0.1:5000' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then((r) => r.json());
}

async function main() {
  // 1. create a fresh human account
  const email = `wstest_${Date.now()}@test.local`;
  const reg = await api('/api/auth/register', { email, password: 'password123', accountType: 'human' });
  const ver = await api('/api/auth/verify-email', { email, code: reg.verification.devCode });
  const jwt = ver.token;
  const room = ver.user.room;
  console.log('1. account created, room =', room);

  // 2. produce an audit event in that room (chat writes INTENT)
  const sid = `ws-test-${Date.now()}`;
  await api('/api/agent/chat', { prompt: 'ws-room-test', sessionId: sid, agentId: 'x' }, { Authorization: `Bearer ${jwt}` });

  // 3. socket join WITH the JWT -> authed room + room-filtered backlog
  const results = await new Promise((resolve) => {
    const socket = io(WS, { transports: ['websocket'] });
    const got = { backlogAuthed: null, liveEvent: false, wrongRoomEvent: false };
    const done = () => resolve(got);

    socket.on('connect', () => {
      socket.emit('join', { sessionId: sid, token: jwt }, (ack) => {
        got.joinAck = ack;
        if (ack?.ok && ack.room === `${room}:${sid}`) {
          got.authedRoom = true;
        }
      });
      // also join as a TOKENLESS stranger (legacy room) — must NOT see authed entries
      socket.emit('join', { sessionId: sid }, (ack2) => {
        got.legacyBacklogCount = ack2?.events ?? -1;
      });
    });

    socket.on('audit:backlog', (payload) => {
      if (payload?.sessionId === sid && got.backlogAuthed === null) got.backlogAuthed = payload.events?.length ?? 0;
      else if (payload?.sessionId === sid && got.legacyBacklog === undefined && got.backlogAuthed !== null) got.legacyBacklog = payload.events?.length ?? -1;
      // (do NOT resolve here — wait for the live OTP event below or timeout)
    });

    // 4. internal emit to the authed room must reach this socket
    setTimeout(async () => {
      // trigger a purchase OTP via HTTP (fires ws event to the authed room)
      await api('/api/transactions/execute',
        { sessionId: sid, agentId: 'x', items: [{ sku: 'ACC-WATCH-001', qty: 1 }] },
        { Authorization: `Bearer ${jwt}`, 'Idempotency-Key': `ws-${Date.now()}` })
        .then((r) => console.log('   (purchase ->', r.status + ')'))
        .catch(() => {});
    }, 1200);

    socket.on('otp:required', (payload) => {
      if (payload?.sessionId === sid) got.liveEvent = true;
      setTimeout(done, 300);
    });

    setTimeout(done, 6000);
  });

  console.log('2. authed join ack room ok:', results.authedRoom === true, JSON.stringify(results.joinAck));
  console.log('3. authed backlog events (INTENT present):', results.backlogAuthed, results.backlogAuthed >= 1 ? '✓' : '✗');
  console.log('4. legacy tokenless join sees authed entries:', results.legacyBacklogCount, '(expected 0)');
  console.log('5. live otp:required reached the authed room socket:', results.liveEvent ? '✓' : '✗');

  const pass = results.authedRoom === true && results.backlogAuthed >= 1 && results.legacyBacklogCount === 0 && results.liveEvent;
  console.log(pass ? '\nWS ROOM TEST: ALL PASS' : '\nWS ROOM TEST: FAILED');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('WS TEST ERROR:', e.message);
  process.exit(1);
});
