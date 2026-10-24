import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from './notion.js';

export const SESSION_SECONDS = 30 * 24 * 60 * 60;

// A stable server secret makes these cookies valid across restarts without a database.
// Binding the key to APP_PASSWORD also invalidates all cookies on a password change.
export function createSessions(env, now = Date.now) {
  function key() {
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new AppError('Set SESSION_SECRET to a random value of at least 32 characters on the server.', 503);
    return createHmac('sha256', env.SESSION_SECRET).update(`spoken-minutes-session-v1:${env.APP_PASSWORD}`).digest();
  }
  const sign = payload => createHmac('sha256', key()).update(payload).digest('base64url');
  return {
    checkConfiguration: () => { key(); },
    issue() {
      const payload = Buffer.from(JSON.stringify({ v: 1, exp: now() + SESSION_SECONDS * 1000, nonce: randomBytes(32).toString('hex') })).toString('base64url');
      return `${payload}.${sign(payload)}`;
    },
    valid(token) {
      if (typeof token !== 'string' || token.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return false;
      const [payload, signature] = token.split('.');
      if (!timingSafeEqual(Buffer.from(signature), Buffer.from(sign(payload)))) return false;
      try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
        return data.v === 1 && /^[a-f0-9]{64}$/.test(data.nonce) && Number.isSafeInteger(data.exp) && data.exp > now() && data.exp <= now() + SESSION_SECONDS * 1000;
      } catch { return false; }
    }
  };
}
