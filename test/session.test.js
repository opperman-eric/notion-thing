import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createSessions, SESSION_SECONDS } from '../lib/session.js';
import { createApp } from '../server.js';

const env = { APP_PASSWORD: 'test-password-long-enough', SESSION_SECRET: 'test-only-random-secret-long-enough-for-tests', RENDER: 'true' };

test('remembered login survives a new server process and expires after 30 days', () => {
  let now = 1800000000000;
  const token = createSessions(env, () => now).issue();
  const restarted = createSessions({ ...env }, () => now);
  assert.equal(restarted.valid(token), true);
  now += SESSION_SECONDS * 1000 - 1;
  assert.equal(restarted.valid(token), true);
  now++;
  assert.equal(restarted.valid(token), false);
});

test('tampered cookies, changed password, changed secret and old sessions are rejected', () => {
  const sessions = createSessions(env);
  const token = sessions.issue();
  const [payload, signature] = token.split('.');
  const data = JSON.parse(Buffer.from(payload, 'base64url'));
  data.exp += 86400000;
  assert.equal(sessions.valid(`${Buffer.from(JSON.stringify(data)).toString('base64url')}.${signature}`), false);
  assert.equal(sessions.valid(`${payload}.${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`), false);
  assert.equal(createSessions({ ...env, APP_PASSWORD: 'changed-password' }).valid(token), false);
  assert.equal(createSessions({ ...env, SESSION_SECRET: 'changed-secret-at-least-32-characters' }).valid(token), false);
  for (const invalid of [undefined, '', 'old-in-memory-session', '.', 'a'.repeat(1000)]) assert.equal(sessions.valid(invalid), false);
  assert.throws(() => createSessions({ ...env, SESSION_SECRET: '' }).issue(), /SESSION_SECRET/);
});

async function start(t) {
  const server = createApp(env); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (path, body, cookie) => fetch(`${base}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
}

test('HTTP login sets a protected 30-day cookie usable on another server; logout clears it', async t => {
  const first = await start(t);
  const login = await first('login', { password: env.APP_PASSWORD });
  assert.equal(login.status, 200);
  const header = login.headers.get('set-cookie');
  for (const flag of ['Max-Age=2592000', 'HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(header.includes(flag));
  const cookie = header.split(';')[0];
  const second = await start(t);
  // An unknown API path returns 404 only after passing authentication.
  assert.equal((await second('unknown', undefined, cookie)).status, 404);
  assert.equal((await second('unknown')).status, 401);
  const logout = await second('logout', {}, cookie);
  assert.equal(logout.status, 200);
  assert.ok(logout.headers.get('set-cookie').includes('Max-Age=0'));
});
