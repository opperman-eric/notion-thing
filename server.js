import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createNotion, AppError } from './lib/notion.js';
import { createAI, today } from './lib/ai.js';
import { createSessions, SESSION_SECONDS } from './lib/session.js';

const digest = value => createHash('sha256').update(value).digest();
export function createApp(env = process.env, fetcher = fetch) {
  const notion = createNotion(env, fetcher), ai = createAI(env, fetcher);
  const sessions = createSessions(env), attempts = new Map(), saves = new Map(), busy = new Set();
  const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'], '/icon.svg': ['icon.svg', 'image/svg+xml'] };
  const cleanup = setInterval(() => {
    for (const [key, value] of attempts) if (value.until < Date.now()) attempts.delete(key);
  }, 60000);
  cleanup.unref();
  const server = http.createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const path = new URL(req.url, 'http://localhost').pathname;
    async function json(limit = 20000) {
      if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('Expected JSON.', 415);
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > limit) throw new AppError('Request is too large.', 413); chunks.push(chunk); }
      try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new AppError('Invalid JSON.'); }
    }
    try {
      if (req.method === 'GET' && path === '/health') return send(200, { ok: true });
      if (req.method === 'GET' && assets[path]) {
        const [name, type] = assets[path];
        const body = await readFile(new URL(`./public/${name}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(body);
      }
      if (!path.startsWith('/api/')) return send(404, { error: 'Not found.' });
      if (!env.APP_PASSWORD || env.APP_PASSWORD.length < 12) throw new AppError('Set APP_PASSWORD to at least 12 characters on the server.', 503);
      sessions.checkConfiguration();
      if (req.method !== 'GET' && req.headers.origin) {
        const origin = new URL(req.headers.origin);
        if (origin.host !== req.headers.host) throw new AppError('Invalid request origin.', 403);
      }
      if (path === '/api/login' && req.method === 'POST') {
        // Use the connection IP: proxy headers can be forged. Conservative shared limit on Render.
        const ip = req.socket.remoteAddress;
        const attempt = attempts.get(ip) || { count: 0, until: Date.now() + 600000 };
        if (attempt.until < Date.now()) { attempt.count = 0; attempt.until = Date.now() + 600000; }
        if (++attempt.count > 20) throw new AppError('Too many sign-in attempts. Wait ten minutes.', 429);
        attempts.set(ip, attempt);
        const body = await json();
        if (typeof body.password !== 'string' || !timingSafeEqual(digest(body.password), digest(env.APP_PASSWORD))) throw new AppError('Incorrect password.', 401);
        const token = sessions.issue();
        const secure = env.NODE_ENV === 'production' || !!env.RENDER;
        res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}`);
        return send(200, { ok: true });
      }
      const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('session='))?.slice(8);
      if (!sessions.valid(token)) throw new AppError('Sign in to continue.', 401);
      if (path === '/api/logout' && req.method === 'POST') { res.setHeader('Set-Cookie', `session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${env.NODE_ENV === 'production' || env.RENDER ? '; Secure' : ''}`); return send(200, { ok: true }); }
      if (path === '/api/projects' && req.method === 'GET') return send(200, { projects: await notion.projects(), today: today(env.TIME_ZONE) });
      if (path === '/api/draft' && req.method === 'POST') {
        if (busy.has(token)) throw new AppError('A recording is already being processed.', 429);
        busy.add(token);
        try {
          const body = await json(17 * 1024 * 1024);
          const projects = await notion.projects();
          const transcript = body.audio ? await ai.transcribe(body.audio, body.mime) : body.transcript;
          return send(200, await ai.extract(transcript, projects));
        } finally { busy.delete(token); }
      }
      if (path === '/api/entries' && req.method === 'POST') {
        const body = await json();
        if (typeof body.requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(body.requestId)) throw new AppError('Missing save identifier.');
        const key = body.requestId, fingerprint = JSON.stringify(body.entry);
        const existing = saves.get(key);
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw new AppError('This save was already submitted. Check Notion before creating another entry.', 409);
          if (existing.result) return send(200, existing.result);
          throw new AppError('This save is pending or its result is uncertain. Check Notion before creating another entry.', 409);
        }
        // Reserve before network work to prevent simultaneous double submissions.
        saves.set(key, { fingerprint });
        let prepared;
        try { prepared = await notion.prepare(body.entry); } catch (error) { saves.delete(key); throw error; }
        try {
          const page = await notion.create(prepared);
          const result = { id: page.id, url: page.url };
          saves.set(key, { fingerprint, result });
          return send(201, result);
        } catch { throw new AppError('Save could not be confirmed. Check the project’s Time Spent table in Notion before creating another entry.', 502); }
      }
      return send(404, { error: 'Not found.' });
    } catch (error) {
      if (!res.headersSent) send(error.status || 500, { error: error instanceof AppError ? error.message : 'Something went wrong. Check your server configuration and try again.' });
    }
  });
  server.on('close', () => clearInterval(cleanup));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  createApp().listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => console.log(`Spoken Minutes listening on port ${process.env.PORT || 3000}`));
}
