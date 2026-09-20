/**
 * A single self-contained HTML page, served straight from the Worker
 * at GET /dashboard?streamId=... - no build step, no framework, just
 * enough to skim your highlights and notes without reading raw JSON.
 */
export function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Stream Notes</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0f0f13;
    --panel: #17171d;
    --border: #2a2a33;
    --text: #e6e6ea;
    --muted: #8b8b96;
    --accent: #9146ff; /* Twitch purple, felt like the honest choice */
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 2rem 1.25rem 4rem;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  .sub { color: var(--muted); font-size: 0.9rem; margin-bottom: 1.5rem; }
  .stream-picker {
    display: flex; gap: 0.5rem; margin-bottom: 2rem;
  }
  input[type=text] {
    flex: 1; background: var(--panel); border: 1px solid var(--border);
    color: var(--text); padding: 0.6rem 0.8rem; border-radius: 8px; font-size: 0.95rem;
  }
  button {
    background: var(--accent); color: white; border: none; border-radius: 8px;
    padding: 0.6rem 1.1rem; font-size: 0.95rem; cursor: pointer;
  }
  button:hover { opacity: 0.9; }
  section { margin-bottom: 2rem; }
  h2 { font-size: 1.05rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.75rem; }
  .notes-box {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 1rem 1.25rem; white-space: pre-wrap; line-height: 1.5; font-size: 0.95rem;
  }
  .highlight {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 0.9rem 1.1rem; margin-bottom: 0.6rem; display: flex; gap: 0.9rem; align-items: flex-start;
  }
  .ts {
    font-variant-numeric: tabular-nums; color: var(--accent); font-weight: 600;
    min-width: 3.5rem; font-size: 0.9rem; margin-top: 0.1rem;
  }
  .h-body { flex: 1; }
  .h-reason { font-size: 0.95rem; }
  .h-meta { color: var(--muted); font-size: 0.78rem; margin-top: 0.3rem; }
  .badge {
    display: inline-block; border: 1px solid var(--border); border-radius: 999px;
    padding: 0.1rem 0.55rem; font-size: 0.72rem; margin-right: 0.4rem; color: var(--muted);
  }
  .empty { color: var(--muted); font-size: 0.9rem; padding: 1rem 0; }
  .error { color: #ff6b6b; font-size: 0.9rem; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Stream Notes</h1>
  <div class="sub">Highlights and notes generated for one of your streams.</div>

  <div class="stream-picker">
    <input id="streamId" type="text" placeholder="Stream ID (from your streams table)" />
    <button onclick="load()">Load</button>
  </div>

  <section>
    <h2>Notes</h2>
    <div id="notes" class="empty">Enter a stream ID above to load its notes.</div>
  </section>

  <section>
    <h2>Highlights</h2>
    <div id="highlights"></div>
  </section>
</div>

<script>
function fmtTs(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0')
    : m + ':' + String(sec).padStart(2, '0');
}

async function load() {
  const streamId = document.getElementById('streamId').value.trim();
  const notesEl = document.getElementById('highlights');
  const notesBox = document.getElementById('notes');
  if (!streamId) return;

  const params = new URLSearchParams(location.search);
  params.set('streamId', streamId);
  history.replaceState(null, '', '?' + params.toString());

  notesBox.textContent = 'Loading...';
  notesBox.className = 'empty';
  notesEl.innerHTML = '';

  try {
    const notesRes = await fetch('/notes?streamId=' + encodeURIComponent(streamId));
    if (notesRes.ok) {
      const data = await notesRes.json();
      notesBox.textContent = data.notes;
      notesBox.className = 'notes-box';
    } else {
      notesBox.textContent = 'No notes generated yet for this stream (it may still be live).';
      notesBox.className = 'empty';
    }
  } catch (e) {
    notesBox.textContent = 'Failed to load notes.';
    notesBox.className = 'error';
  }

  try {
    const hlRes = await fetch('/highlights?streamId=' + encodeURIComponent(streamId));
    const highlights = await hlRes.json();
    if (!highlights.length) {
      notesEl.innerHTML = '<div class="empty">No highlights flagged (yet).</div>';
      return;
    }
    notesEl.innerHTML = highlights.map(h => \`
      <div class="highlight">
        <div class="ts">\${fmtTs(h.window_start)}</div>
        <div class="h-body">
          <div class="h-reason">\${h.reason || '(no reason recorded)'}</div>
          <div class="h-meta">
            <span class="badge">\${h.source}</span>
            <span class="badge">confidence \${Math.round((h.confidence || 0) * 100)}%</span>
          </div>
        </div>
      </div>
    \`).join('');
  } catch (e) {
    notesEl.innerHTML = '<div class="error">Failed to load highlights.</div>';
  }
}

// Auto-load if a streamId is already in the URL.
const existing = new URLSearchParams(location.search).get('streamId');
if (existing) {
  document.getElementById('streamId').value = existing;
  load();
}
</script>
</body>
</html>`;
}
