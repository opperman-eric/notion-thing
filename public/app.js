const $ = id => document.getElementById(id);
let projects = [], requestId = null, recorder = null, stream = null, timer = null, started = 0, processing = false;
let recording = null, defaultDate = '';

function message(text = '') { $('message').textContent = text; $('message').hidden = !text; }
async function api(path, body) {
  let response;
  try { response = await fetch(`/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new Error('Connection lost. If you were saving, check Notion before trying again.'); }
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) { $('login-panel').hidden = false; $('workspace').hidden = true; $('logout').hidden = true; }
    const error = new Error(data.error || 'Request failed.'); error.status = response.status; throw error;
  }
  return data;
}
function busy(value) {
  processing = value;
  for (const id of ['record', 'interpret', 'save', 'discard', 'another', 'logout']) $(id).disabled = value;
  $('typed-note').disabled = value;
  $('record-state').textContent = value ? 'Working on it…' : 'Ready';
}
async function loadProjects() {
  $('retry-projects').hidden = true;
  try {
    const data = await api('projects'); projects = data.projects;
    $('login-panel').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
    const selected = $('project').value;
    $('project').replaceChildren(new Option('Choose a project', ''), ...projects.map(p => new Option(p.name, p.id)));
    $('project').value = selected; defaultDate = data.today; $('date').value ||= data.today;
    $('record').disabled = false;
    if (!projects.length) message('No projects found. Add a project in Notion and share the Projects database with your integration.');
    return true;
  } catch (error) { if (error.status !== 401) message(error.message); $('retry-projects').hidden = error.status === 401; return false; }
}
function resetEntry() {
  $('review').hidden = true; $('success').hidden = true;
  $('entry-form').reset(); $('date').value = defaultDate; $('typed-note').value = ''; requestId = null; recording = null;
  message(); $('record-title').textContent = 'Tap to record'; $('record-help').textContent = 'Say the project, what you did, and how long.';
  $('record').focus();
}
function reviewDraft(data) {
  $('success').hidden = true; $('review').hidden = false;
  $('transcript').textContent = data.transcript;
  $('task').value = data.entry.task || '';
  $('minutes').value = data.entry.minutes ?? '';
  $('date').value = data.entry.date || '';
  $('project').value = data.entry.projectId || '';
  requestId = crypto.randomUUID();
  if (!data.entry.projectId || !data.entry.minutes || !data.entry.task) message('Fill in any missing details below. We couldn’t confidently identify everything.');
  $('review').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function prepare(body) {
  message(); busy(true);
  try { reviewDraft(await api('draft', body)); recording = null; }
  catch (error) { message(error.message + (recording ? ' Tap “Retry transcription” to use the same recording, or type the entry.' : '')); }
  finally {
    busy(false);
    if (recording) { $('record-title').textContent = 'Retry transcription'; $('record-help').textContent = 'Your recording is still here until you leave this page.'; }
  }
}
function stopTracks() { stream?.getTracks().forEach(t => t.stop()); stream = null; }
function finishRecording() { if (recorder?.state === 'recording') recorder.stop(); }
async function startRecording() {
  if (processing) return;
  if (recorder?.state === 'recording') { finishRecording(); return; }
  if (recording) { await prepare(recording); return; }
  if (!$('review').hidden && !confirm('Replace your unsaved draft with a new recording?')) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { message('Recording needs Safari over HTTPS. You can type your note below instead.'); return; }
  message(); $('record').disabled = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = []; let bytes = 0, failed = false;
    recorder.ondataavailable = event => { if (event.data.size) { chunks.push(event.data); bytes += event.data.size; if (bytes > 12 * 1024 * 1024) finishRecording(); } };
    recorder.onerror = () => { failed = true; message('Recording was interrupted. Please try again.'); finishRecording(); stopTracks(); };
    recorder.onstop = async () => {
      clearInterval(timer); stopTracks(); $('timer').hidden = true; $('record').classList.remove('recording');
      $('record').setAttribute('aria-label', 'Start recording'); $('record-title').textContent = 'Preparing your entry…'; $('record-state').textContent = 'Ready';
      $('interpret').disabled = false; $('logout').disabled = false;
      if (failed) { $('record-title').textContent = 'Tap to record'; return; }
      const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/mp4' });
      if (!blob.size || blob.size > 12 * 1024 * 1024) { message('Recording is empty or too large. Please record a shorter note.'); $('record-title').textContent = 'Tap to record'; return; }
      const reader = new FileReader();
      reader.onload = () => { recording = { audio: reader.result.split(',')[1], mime: blob.type }; prepare(recording); };
      reader.onerror = () => message('Could not read this recording. Please try again.');
      reader.readAsDataURL(blob);
    };
    recorder.start(1000); started = Date.now();
    $('record').classList.add('recording'); $('record').setAttribute('aria-label', 'Stop recording');
    $('record-title').textContent = 'Listening…'; $('record-help').textContent = 'Tap again when you’re done. Up to 2 minutes.';
    $('record-state').textContent = 'Recording'; $('timer').hidden = false; $('timer').textContent = '00:00';
    $('interpret').disabled = true; $('logout').disabled = true;
    timer = setInterval(() => { const seconds = Math.floor((Date.now() - started) / 1000); $('timer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; if (seconds >= 120) finishRecording(); }, 250);
  } catch { stopTracks(); message('Microphone access failed. Allow it in Safari’s website settings, or type your note below.'); }
  finally { $('record').disabled = false; }
}
$('record').addEventListener('click', startRecording);
document.addEventListener('visibilitychange', () => { if (document.hidden) finishRecording(); });
window.addEventListener('pagehide', stopTracks);
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); message(); $('login-button').disabled = true;
  try { await api('login', { password: $('password').value }); $('password').value = ''; $('login-panel').hidden = true; $('workspace').hidden = false; $('logout').hidden = false; await loadProjects(); }
  catch (error) { message(error.message); }
  finally { $('login-button').disabled = false; }
});
$('logout').addEventListener('click', async () => {
  try { await api('logout', {}); resetEntry(); $('workspace').hidden = true; $('login-panel').hidden = false; $('logout').hidden = true; $('retry-projects').hidden = true; }
  catch (error) { message(error.message); }
});
$('text-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!$('typed-note').value.trim()) { message('Describe what you did, the project, and the minutes spent.'); return; }
  if (!$('review').hidden && !confirm('Replace your unsaved draft?')) return;
  recording = null; await prepare({ transcript: $('typed-note').value });
});
$('entry-form').addEventListener('submit', async event => {
  event.preventDefault(); if (processing) return; message(); busy(true);
  const entry = { projectId: $('project').value, task: $('task').value.trim(), minutes: Number($('minutes').value), date: $('date').value };
  requestId ||= crypto.randomUUID();
  try {
    const result = await api('entries', { requestId, entry });
    $('saved-summary').textContent = `${entry.minutes} minutes · ${entry.task} · ${projects.find(p => p.id === entry.projectId)?.name || ''}`;
    const link = new URL(result.url);
    $('notion-link').hidden = link.protocol !== 'https:';
    if (link.protocol === 'https:') $('notion-link').href = link.href;
    $('review').hidden = true; $('success').hidden = false;
    $('success').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) { message(error.message); }
  finally { busy(false); }
});
$('discard').addEventListener('click', () => { if (confirm('Discard this unsaved entry?')) resetEntry(); });
$('another').addEventListener('click', resetEntry);
$('retry-projects').addEventListener('click', () => { message(); loadProjects(); });
loadProjects();
