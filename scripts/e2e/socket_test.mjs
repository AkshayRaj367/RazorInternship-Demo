/**
 * E2E: browser-side Socket.IO contract.
 *  - join {sessionId} triggers audit:backlog with the full history (ascending)
 *  - live audit:event relayed from Flask -> /internal/emit -> room
 *  - recovery:alt_link and otp:required events reach the room
 * Exits non-zero on any failure.
 */
import { io } from 'socket.io-client';
import { MongoClient } from 'mongodb';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';

const SESSION = 'e2e-socket-session-01';
const WS = 'http://127.0.0.1:4001';
const WS_SECRET = 'e2e-internal-ws-secret-0001';
const AGENT = 'http://127.0.0.1:5000';
const WEBHOOK_SECRET = 'e2e-webhook-secret';

const mongo = new MongoClient('mongodb://127.0.0.1:27017/razormcp?replicaSet=rs0&directConnection=true', {
  directConnection: true,
});
await mongo.connect();
const db = mongo.db('razormcp');

// Seed 3 audit entries for this session.
await db.collection('audit_logs').deleteMany({ sessionId: SESSION });
const now = () => new Date();
await db.collection('audit_logs').insertMany([
  { sessionId: SESSION, agentId: 'onyx-agent', orderId: null, step: 'INTENT', detail: { prompt: 'socket test' }, timestamp: now() },
  { sessionId: SESSION, agentId: 'onyx-agent', orderId: null, step: 'INVENTORY_LOCK', detail: { orderNumber: 'RZM-000099' }, timestamp: now() },
  { sessionId: SESSION, agentId: 'onyx-agent', orderId: null, step: 'GUARDRAIL_PASS', detail: { amountPaise: 149900 }, timestamp: now() },
]);

const failures = [];
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? '  [' + detail + ']' : ''}`);
  if (!cond) failures.push(name);
};

const socket = io(WS, {
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 5000,
  randomizationFactor: 0.5,
  transports: ['polling', 'websocket'],
});

const backlog = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('backlog timeout')), 8000);
  socket.on('audit:backlog', (payload) => {
    clearTimeout(t);
    resolve(payload);
  });
  socket.on('connect', () => socket.emit('join', { sessionId: SESSION }));
});
const steps = (backlog.events ?? []).map((e) => e.step);
ok('join -> audit:backlog arrives', backlog.sessionId === SESSION && Array.isArray(backlog.events));
ok('backlog has the full ordered history', JSON.stringify(steps) === JSON.stringify(['INTENT', 'INVENTORY_LOCK', 'GUARDRAIL_PASS']), JSON.stringify(steps));

// Live relay: register the listener BEFORE firing the chat — the INTENT audit
// event is emitted mid-request (log_step happens before the LLM call).
const liveEvent = await (async () => {
  const eventPromise = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('live audit:event timeout')), 15000);
    socket.on('audit:event', (payload) => {
      clearTimeout(t);
      resolve(payload);
    });
  });
  const chatRes = await fetch(`${AGENT}/api/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'socket live relay test', sessionId: SESSION, agentId: 'onyx-agent' }),
  });
  const chatJson = await chatRes.json();
  ok('chat via agent-service ok (INTENT emitted)', chatRes.status === 200, JSON.stringify(chatJson).slice(0, 120));
  return eventPromise;
})();
ok('live audit:event relayed to the room', liveEvent?.entry?.step === 'INTENT' && liveEvent?.entry?.sessionId === SESSION, JSON.stringify(liveEvent).slice(0, 150));

// otp:required + recovery:alt_link relay via /internal/emit (the exact path Flask uses).
async function internalEmit(event, payload) {
  const res = await fetch(`${WS}/internal/emit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': WS_SECRET },
    body: JSON.stringify({ room: SESSION, event, payload }),
  });
  return res.status;
}

const otpPromise = new Promise((resolve) => socket.on('otp:required', resolve));
const recPromise = new Promise((resolve) => socket.on('recovery:alt_link', resolve));
await internalEmit('otp:required', { sessionId: SESSION, transactionId: 'abc', amountPaise: 1000000, orderNumber: 'RZM-000123', devOtp: '123456' });
await internalEmit('recovery:alt_link', { sessionId: SESSION, orderNumber: 'RZM-000123', recoverySessionId: 'rcv-1', declineReason: 'insufficient_funds', altPaymentLinkUrl: 'https://example.test/link', configured: true });
const otpEvt = await Promise.race([otpPromise, new Promise((r) => setTimeout(() => r(null), 5000))]);
ok('otp:required relayed with devOtp', otpEvt?.devOtp === '123456' && otpEvt.sessionId === SESSION);
const recEvt = await Promise.race([recPromise, new Promise((r) => setTimeout(() => r(null), 5000))]);
ok('recovery:alt_link relayed with CTA url', recEvt?.altPaymentLinkUrl === 'https://example.test/link');

// Room isolation: another session's events must NOT reach this socket.
const otherPromise = new Promise((resolve) => socket.on('audit:event', (p) => resolve(p)));
await fetch(`${WS}/internal/emit`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': WS_SECRET },
  body: JSON.stringify({ room: 'other-session-9999', event: 'audit:event', payload: { sessionId: 'other-session-9999', entry: { _id: 'nope', step: 'INTENT' } } }),
});
const leaked = await Promise.race([otherPromise, new Promise((r) => setTimeout(() => r('timeout'), 3000))]);
ok('room isolation: other rooms do not leak', leaked === 'timeout' || leaked?.sessionId === SESSION);

socket.disconnect();
await mongo.close();

console.log(failures.length === 0 ? '\nSOCKET E2E: ALL PASSED' : `\nSOCKET E2E FAILURES: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
