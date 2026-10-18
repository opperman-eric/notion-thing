export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function notionId(value) {
  const id = String(value || '').replaceAll('-', '');
  if (!/^[a-f0-9]{32}$/i.test(id)) throw new AppError('Invalid Notion ID. Use the 32-character ID from the database URL.');
  return id;
}

export function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') throw new AppError('An entry is required.');
  notionId(entry.projectId);
  if (typeof entry.task !== 'string' || !entry.task.trim() || entry.task.length > 200) throw new AppError('Enter a task name (up to 200 characters).');
  if (typeof entry.minutes !== 'number' || !Number.isFinite(entry.minutes) || entry.minutes <= 0 || entry.minutes > 1440) throw new AppError('Minutes must be greater than zero and no more than 1,440.');
  if (typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || !Number.isFinite(Date.parse(entry.date)) || new Date(entry.date).toISOString().slice(0, 10) !== entry.date) throw new AppError('Choose a valid date.');
  return { projectId: entry.projectId, task: entry.task.trim(), minutes: entry.minutes, date: entry.date };
}

export function createNotion(env, fetcher = fetch) {
  const version = '2025-09-03';
  async function request(path, body) {
    if (!env.NOTION_TOKEN || !env.NOTION_PROJECTS_DATABASE_ID) throw new AppError('Set NOTION_TOKEN and NOTION_PROJECTS_DATABASE_ID on the server.', 503);
    let response;
    try {
      response = await fetcher(`https://api.notion.com/v1/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': version, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(25000)
      });
    } catch { throw new AppError('Notion did not respond. Check your connection and Notion before trying again.', 502); }
    const result = await response.json();
    if (!response.ok) throw new AppError(`Notion: ${result.message || 'request failed'}`, 502);
    return result;
  }
  async function source(databaseId, configuredId) {
    const db = await request(`databases/${notionId(databaseId)}`);
    if (configuredId) {
      const selected = db.data_sources?.find(s => notionId(s.id) === notionId(configuredId));
      if (!selected) throw new AppError('Configured data source does not belong to this database.');
      return selected.id;
    }
    if (db.data_sources?.length !== 1) throw new AppError('This database has multiple data sources. Configure a single source for time entries or NOTION_PROJECTS_DATA_SOURCE_ID for Projects.');
    return db.data_sources[0].id;
  }
  async function projects() {
    const id = await source(env.NOTION_PROJECTS_DATABASE_ID, env.NOTION_PROJECTS_DATA_SOURCE_ID);
    const rows = []; let cursor;
    do {
      const page = await request(`data_sources/${id}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
      for (const row of page.results) {
        const title = Object.values(row.properties).find(p => p.type === 'title');
        rows.push({ id: row.id, name: title?.title.map(t => t.plain_text ?? t.text?.content ?? '').join('') || 'Untitled project' });
      }
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor);
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }
  async function timeSource(projectId) {
    const map = JSON.parse(env.NOTION_TIME_DATABASE_MAP || '{}');
    const override = Object.entries(map).find(([key]) => notionId(key) === notionId(projectId));
    if (override) return source(override[1]);
    const matches = []; let cursor;
    do {
      const page = await request(`blocks/${notionId(projectId)}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`);
      matches.push(...page.results.filter(b => b.type === 'child_database' && b.child_database.title === (env.NOTION_TIME_DATABASE_NAME || 'Time Spent')));
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor);
    if (matches.length !== 1) throw new AppError('Expected one inline “Time Spent” database directly inside this project. For a linked or nested table, configure NOTION_TIME_DATABASE_MAP.');
    return source(matches[0].id);
  }
  async function prepare(entry) {
    entry = validateEntry(entry);
    const available = await projects();
    if (!available.some(p => notionId(p.id) === notionId(entry.projectId))) throw new AppError('Select a project from your Projects database.');
    const sourceId = await timeSource(entry.projectId);
    const schema = await request(`data_sources/${sourceId}`);
    const names = { task: env.NOTION_TASK_PROPERTY || 'Task Name', date: env.NOTION_DATE_PROPERTY || 'Date', minutes: env.NOTION_MINUTES_PROPERTY || 'Minutes' };
    for (const [key, type] of [['task', 'title'], ['date', 'date'], ['minutes', 'number']]) {
      if (schema.properties[names[key]]?.type !== type) throw new AppError(`Time table needs a ${type} column named “${names[key]}”. Check your server property settings.`);
    }
    return { parent: { type: 'data_source_id', data_source_id: sourceId }, properties: {
      [names.task]: { title: [{ text: { content: entry.task } }] },
      [names.date]: { date: { start: entry.date } },
      [names.minutes]: { number: entry.minutes }
    } };
  }
  return { projects, prepare, create: body => request('pages', body) };
}
