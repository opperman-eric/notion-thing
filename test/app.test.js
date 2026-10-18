import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server.js';
import { createAI, today } from '../lib/ai.js';
import { createNotion, validateEntry } from '../lib/notion.js';

const projectId = '11111111-1111-1111-1111-111111111111';
const projectsDb = '22222222-2222-2222-2222-222222222222';
const timeDb = '33333333-3333-3333-3333-333333333333';
const projectSource = '44444444-4444-4444-4444-444444444444';
const timeSource = '55555555-5555-5555-5555-555555555555';
const env = { APP_PASSWORD: 'a-test-password-for-tests', NOTION_TOKEN: 'fake-notion', NOTION_PROJECTS_DATABASE_ID: projectsDb, OPENAI_API_KEY: 'fake-openai' };
const entry = { projectId, task: 'Email stakeholders', minutes: 16, date: '2026-10-18' };
const compact = id => id.replaceAll('-', '');
function notionMock({ badSchema = false, failCreate = false } = {}) {
  const state = { creates: [], calls: [] };
  const fetcher = async (url, options = {}) => {
    state.calls.push(url);
    const path = new URL(url).pathname.replace('/v1/', '');
    let body;
    if (path === `databases/${compact(projectsDb)}`) body = { data_sources: [{ id: projectSource }] };
    else if (path === `data_sources/${projectSource}/query`) body = { results: [{ id: projectId, properties: { Name: { type: 'title', title: [{ plain_text: 'Project B' }] } } }], has_more: false };
    else if (path === `blocks/${compact(projectId)}/children`) body = { results: [{ id: timeDb, type: 'child_database', child_database: { title: 'Time Spent' } }], has_more: false };
    else if (path === `databases/${compact(timeDb)}`) body = { data_sources: [{ id: timeSource }] };
    else if (path === `data_sources/${timeSource}`) body = { properties: { 'Task Name': { type: 'title' }, Date: { type: 'date' }, Minutes: { type: badSchema ? 'rich_text' : 'number' } } };
    else if (path === 'pages') {
      state.creates.push(JSON.parse(options.body));
      if (failCreate) throw new Error('Timeout after write');
      body = { id: 'new-page', url: 'https://www.notion.so/new-page' };
    } else throw new Error(`Unexpected path: ${path}`);
    return Response.json(body);
  };
  return { state, fetcher };
}
async function running(t, fetcher) {
  const server = createApp(env, fetcher); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, body, cookie) => fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const login = await call('/api/login', { password: env.APP_PASSWORD });
  assert.equal(login.status, 200);
  return { call, cookie: login.headers.get('set-cookie').split(';')[0] };
}
test('rejects invalid dates, unknown minutes, and blank tasks before any write', () => {
  assert.deepEqual(validateEntry(entry), entry);
  for (const override of [{ date: '2026-02-30' }, { minutes: -1 }, { minutes: '16' }, { minutes: null }, { task: ' ' }, { projectId: 'bad-id' }]) assert.throws(() => validateEntry({ ...entry, ...override }));
});
test('uses Auckland calendar day across UTC midnight and daylight saving', () => {
  assert.equal(today('Pacific/Auckland', new Date('2026-10-17T12:30:00Z')), '2026-10-18');
  assert.equal(today('Pacific/Auckland', new Date('2026-06-01T11:30:00Z')), '2026-06-01');
});
test('writes the screenshot example to the selected project’s inline table', async () => {
  const mock = notionMock(); const notion = createNotion(env, mock.fetcher);
  const payload = await notion.prepare(entry); await notion.create(payload);
  assert.deepEqual(mock.state.creates[0], { parent: { type: 'data_source_id', data_source_id: timeSource }, properties: { 'Task Name': { title: [{ text: { content: 'Email stakeholders' } }] }, Date: { date: { start: '2026-10-18' } }, Minutes: { number: 16 } } });
});
test('wrong schema or non-member project cannot create a page', async () => {
  const mock = notionMock({ badSchema: true }); const notion = createNotion(env, mock.fetcher);
  await assert.rejects(notion.prepare(entry), /number column/);
  await assert.rejects(notion.prepare({ ...entry, projectId: timeDb }), /Select a project/);
  assert.equal(mock.state.creates.length, 0);
});
test('authentication protects data; repeated save reuses its result', async t => {
  const mock = notionMock(); const { call, cookie } = await running(t, mock.fetcher);
  assert.equal((await call('/api/projects')).status, 401);
  assert.equal((await call('/.env')).status, 404);
  const body = { requestId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', entry };
  const first = await call('/api/entries', body, cookie); assert.equal(first.status, 201);
  const second = await call('/api/entries', body, cookie); assert.equal(second.status, 200);
  assert.deepEqual(await first.json(), await second.json()); assert.equal(mock.state.creates.length, 1);
  const changed = await call('/api/entries', { ...body, entry: { ...entry, minutes: 20 } }, cookie);
  assert.equal(changed.status, 409);
});
test('uncertain write is not silently retried', async t => {
  const mock = notionMock({ failCreate: true }); const { call, cookie } = await running(t, mock.fetcher);
  const body = { requestId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', entry };
  assert.equal((await call('/api/entries', body, cookie)).status, 502);
  assert.equal((await call('/api/entries', body, cookie)).status, 409);
  assert.equal(mock.state.creates.length, 1);
});
test('unknown AI project is left blank and iPhone audio uses mp4 multipart', async () => {
  const calls = [];
  const ai = createAI(env, async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/transcriptions')) return Response.json({ text: 'I spent 16 minutes emailing stakeholders on Project B' });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ ...entry, projectId: 'invented' }) } }] });
  });
  const transcript = await ai.transcribe(Buffer.from('mock-audio').toString('base64'), 'audio/mp4;codecs=mp4a.40.2');
  const result = await ai.extract(transcript, [{ id: projectId, name: 'Project B' }]);
  assert.equal(result.entry.projectId, null);
  assert.equal(calls[0].options.body.get('file').name, 'recording.mp4');
  assert.equal(calls[0].options.body.get('model'), 'gpt-4o-mini-transcribe');
  await assert.rejects(ai.transcribe('', 'audio/mp4'), /empty recording/);
});
