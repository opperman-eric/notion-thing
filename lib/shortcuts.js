import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError, validateEntry } from './notion.js';

const digest = value => createHash('sha256').update(value).digest();
const DRAFT_MS = 10 * 60 * 1000;

export function createShortcuts(env, notion, ai, now = Date.now) {
  const drafts = new Map();
  let windowStart = now(), count = 0, preparing = false;
  function authenticate(authorization) {
    const expected = env.SHORTCUT_TOKEN?.trim();
    if (!expected || expected.length < 32) throw new AppError('Siri integration is not configured. Set SHORTCUT_TOKEN to at least 32 characters on the server, then save and redeploy.', 503);
    const fail = detail => { throw new AppError(`Shortcut authentication failed. ${detail}`, 401); };
    if (typeof authorization !== 'string' || !authorization.trim()) fail('No Authorization header reached the app. Add that header to Get Contents of URL.');
    // Tolerate surrounding paste whitespace and normal HTTP auth scheme casing.
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (!match) fail('The Authorization value must start with Bearer followed by a space and the token.');
    const supplied = match[1].trim();
    if (/\s/.test(supplied)) fail('The received token contains a space or line break. Only the space after Bearer is allowed.');
    if (/^["']|["']$/.test(supplied)) fail('The received token has quotation marks around it. Remove those quotation marks.');
    if (supplied.length !== expected.length) fail(`The app received ${supplied.length} token characters; Render is configured with ${expected.length}. Check that the header uses the token value, not a variable name or another action output.`);
    if (!timingSafeEqual(digest(supplied), digest(expected))) fail('The token length matches, but its value differs from SHORTCUT_TOKEN on this running Render service. Check the service URL and its deployed environment setting.');
  }
  function cleanup() {
    for (const [id, draft] of drafts) if (draft.expires <= now() && draft.state !== 'saving') drafts.delete(id);
  }
  async function prepare(body) {
    if (typeof body?.transcript !== 'string' || !body.transcript.trim() || body.transcript.length > 5000) throw new AppError('Say the project, task, and time spent in one short entry.');
    if (preparing) throw new AppError('Another Siri note is being processed. Please wait.', 429);
    if (now() - windowStart >= DRAFT_MS) { windowStart = now(); count = 0; }
    if (++count > 30) throw new AppError('Too many Siri notes. Please wait ten minutes.', 429);
    preparing = true;
    try {
      cleanup();
      const projects = await notion.projects();
      const { entry } = await ai.extract(body.transcript, projects);
      let checked;
      try { checked = validateEntry(entry); }
      catch { return { ok: true, canSave: false, message: 'I could not identify one complete entry. Try again and include the project name, task, and minutes spent.' }; }
      const project = projects.find(p => p.id === checked.projectId);
      if (!project) return { ok: true, canSave: false, message: 'I could not identify the project. Try again using its exact name in Notion.' };
      const draftId = randomUUID();
      const summary = `${checked.minutes} minutes on ${project.name}: ${checked.task}, dated ${checked.date}.`;
      drafts.set(draftId, { entry: checked, summary, expires: now() + DRAFT_MS, state: 'ready' });
      return { ok: true, canSave: true, draftId, summary, message: `${summary} Save this entry?` };
    } finally { preparing = false; }
  }
  async function save(body) {
    if (body?.confirmed !== true) throw new AppError('The entry was not confirmed. Nothing was saved.');
    cleanup();
    const draft = drafts.get(body.draftId);
    if (!draft) throw new AppError('This Siri draft expired or the server restarted. Check Notion before starting another entry.', 409);
    if (draft.state === 'saved') return draft.result;
    if (draft.state !== 'ready') throw new AppError('This save is pending or could not be confirmed. Check Notion before starting another entry.', 409);
    draft.state = 'saving';
    let prepared;
    try { prepared = await notion.prepare(draft.entry); }
    catch (error) { draft.state = 'ready'; throw error; }
    try {
      const page = await notion.create(prepared);
      draft.result = { ok: true, message: `Saved. ${draft.summary}`, id: page.id, url: page.url };
      draft.state = 'saved';
      return draft.result;
    } catch {
      draft.state = 'uncertain';
      throw new AppError('Save could not be confirmed. Check Notion before starting another entry.', 502);
    }
  }
  return { authenticate, prepare, save, cleanup };
}
