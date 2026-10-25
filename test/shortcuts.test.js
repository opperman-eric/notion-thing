import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createShortcuts } from '../lib/shortcuts.js';
import { createApp } from '../server.js';

const token = 'test-only-shortcut-token-at-least-32-characters';
const projectId = '11111111-1111-1111-1111-111111111111';
const entry = { projectId, task: 'Email stakeholders', minutes: 16, date: '2026-10-25' };
function fixture(options = {}) {
  const writes = [];
  const notion = {
    projects: async () => [{ id: projectId, name: 'Project B' }],
    prepare: options.prepare || (async value => value),
    create: async value => { writes.push(value); if (options.failWrite) throw new Error('timeout'); return { id: 'saved', url: 'https://www.notion.so/saved' }; }
  };
  const ai = { extract: async () => ({ entry: options.entry || entry }) };
  const api = createShortcuts({ SHORTCUT_TOKEN: token }, notion, ai, options.now);
  return { api, writes };
}

test('Siri only accepts its own bearer token and fails closed when unconfigured', () => {
  const { api } = fixture();
  assert.doesNotThrow(() => api.authenticate(`Bearer ${token}`));
  for (const value of [undefined, token, 'Bearer wrong', 'Basic abc']) assert.throws(() => api.authenticate(value), /authentication failed/);
  assert.throws(() => createShortcuts({}, {}, {}).authenticate(`Bearer ${token}`), /not configured/);
});
test('Siri tolerates surrounding whitespace but explains header mistakes without exposing tokens', () => {
  const api = createShortcuts({ SHORTCUT_TOKEN: ` ${token}\n` }, {}, {});
  assert.doesNotThrow(() => api.authenticate(` bearer  ${token} `));
  const cases = [
    [undefined, /No Authorization header/],
    [`Bearer, ${token}`, /must start with Bearer/],
    ['Bearer ShortcutToken', /received 13 token characters/],
    [`Bearer "${token}"`, /quotation marks/],
    [`Bearer ${token.slice(0, 10)} ${token.slice(10)}`, /space or line break/],
    [`Bearer ${'x'.repeat(token.length)}`, /length matches, but its value differs/]
  ];
  for (const [value, detail] of cases) {
    assert.throws(() => api.authenticate(value), error => {
      assert.equal(error.status, 401); assert.match(error.message, detail);
      assert.equal(error.message.includes(token), false);
      return true;
    });
  }
});
test('preparing never writes; confirmation saves the server draft once', async () => {
  const { api, writes } = fixture();
  const draft = await api.prepare({ transcript: '16 minutes emailing stakeholders on Project B' });
  assert.equal(draft.canSave, true); assert.match(draft.message, /16 minutes on Project B/); assert.match(draft.message, /2026-10-25/);
  assert.equal(writes.length, 0);
  await assert.rejects(api.save({ draftId: draft.draftId, confirmed: 'true' }), /not confirmed/);
  assert.equal(writes.length, 0);
  const saved = await api.save({ draftId: draft.draftId, confirmed: true, entry: { ...entry, minutes: 999 } });
  assert.equal(saved.ok, true); assert.deepEqual(writes, [entry]);
  assert.deepEqual(await api.save({ draftId: draft.draftId, confirmed: true }), saved);
  assert.equal(writes.length, 1);
});
test('missing and unmatched fields cannot produce a saveable draft', async () => {
  for (const replacement of [{ minutes: null }, { task: '' }, { projectId: '22222222-2222-2222-2222-222222222222' }, { date: 'bad' }]) {
    const { api, writes } = fixture({ entry: { ...entry, ...replacement } });
    const draft = await api.prepare({ transcript: 'incomplete note' });
    assert.equal(draft.canSave, false); assert.equal(draft.draftId, undefined); assert.equal(writes.length, 0);
  }
});
test('expired and lost drafts are rejected without a Notion write', async () => {
  let time = 10000;
  const { api, writes } = fixture({ now: () => time });
  const draft = await api.prepare({ transcript: '16 minutes on Project B emailing' });
  time += 600000;
  await assert.rejects(api.save({ draftId: draft.draftId, confirmed: true }), /expired/);
  const restarted = fixture().api;
  await assert.rejects(restarted.save({ draftId: draft.draftId, confirmed: true }), /expired/);
  assert.equal(writes.length, 0);
});
test('uncertain writes cannot be retried into duplicate entries', async () => {
  const { api, writes } = fixture({ failWrite: true });
  const draft = await api.prepare({ transcript: '16 minutes on Project B emailing' });
  await assert.rejects(api.save({ draftId: draft.draftId, confirmed: true }), /could not be confirmed/);
  await assert.rejects(api.save({ draftId: draft.draftId, confirmed: true }), /pending/);
  assert.equal(writes.length, 1);
});
test('simultaneous saves of a draft do not write twice', async () => {
  let release;
  const { api, writes } = fixture({ prepare: () => new Promise(resolve => { release = resolve; }) });
  const draft = await api.prepare({ transcript: '16 minutes on Project B emailing' });
  const first = api.save({ draftId: draft.draftId, confirmed: true });
  await assert.rejects(api.save({ draftId: draft.draftId, confirmed: true }), /pending/);
  release(entry); await first;
  assert.equal(writes.length, 1);
});
test('empty input and excessive prepare calls are rejected', async () => {
  const { api } = fixture();
  await assert.rejects(api.prepare(null), /Say the project/);
  await assert.rejects(api.prepare({ transcript: ' ' }), /Say the project/);
  for (let i = 0; i < 30; i++) await api.prepare({ transcript: '16 minutes emailing on Project B' });
  await assert.rejects(api.prepare({ transcript: 'one more' }), /Too many/);
});
test('HTTP Siri endpoints work without browser cookies and cannot access browser routes', async t => {
  const writes = [];
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname;
    if (url.includes('api.openai.com')) return Response.json({ choices: [{ message: { content: JSON.stringify(entry) } }] });
    if (path.includes('/databases/')) return Response.json({ data_sources: [{ id: 'source' }] });
    if (path.endsWith('/query')) return Response.json({ results: [{ id: projectId, properties: { Name: { type: 'title', title: [{ plain_text: 'Project B' }] } } }] });
    if (path.endsWith('/children')) return Response.json({ results: [{ id: projectId, type: 'child_database', child_database: { title: 'Time Spent' } }] });
    if (path.endsWith('/data_sources/source')) return Response.json({ properties: { 'Task Name': { type: 'title' }, Date: { type: 'date' }, Minutes: { type: 'number' } } });
    if (path.endsWith('/pages')) { writes.push(JSON.parse(options.body)); return Response.json({ id: 'saved', url: 'https://www.notion.so/saved' }); }
    throw new Error(`Unexpected URL ${url}`);
  };
  const server = createApp({ SHORTCUT_TOKEN: token, NOTION_TOKEN: 'fake', NOTION_PROJECTS_DATABASE_ID: projectId, OPENAI_API_KEY: 'fake', APP_PASSWORD: 'test-long-password', SESSION_SECRET: 'test-long-session-secret-at-least-32-characters' }, fetcher);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, body, authorization = `Bearer ${token}`) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization }, body: JSON.stringify(body) });
  const badAuth = await call('/api/shortcuts/prepare', { transcript: 'test' }, 'Bearer wrong');
  assert.equal(badAuth.status, 401);
  const authMessage = await badAuth.json();
  assert.match(authMessage.message, /received 5 token characters/);
  assert.equal(authMessage.message.includes(token), false);
  const prepared = await call('/api/shortcuts/prepare', { transcript: '16 minutes emailing stakeholders on Project B' });
  assert.equal(prepared.status, 200); const draft = await prepared.json();
  assert.equal(draft.canSave, true); assert.equal(writes.length, 0);
  const saved = await call('/api/shortcuts/save', { draftId: draft.draftId, confirmed: true });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).ok, true); assert.equal(writes.length, 1);
  assert.equal((await call('/api/shortcuts/save', { draftId: draft.draftId, confirmed: true })).status, 200);
  assert.equal(writes.length, 1);
  assert.equal((await call('/api/entries', {})).status, 401);
});
