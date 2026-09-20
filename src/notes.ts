/**
 * Runs once, right after a stream ends. Takes every flagged
 * highlight_window row, collapses near-duplicates (the rolling
 * detector can flag two or three consecutive ~25s windows for one
 * longer moment), and asks an LLM to turn the list into a short,
 * readable summary you can skim instead of a raw timestamp dump.
 */

interface Env {
  DB: D1Database;
  AI: Ai;
  DISCORD_WEBHOOK_URL?: string;
}

interface HighlightRow {
  window_start: number;
  window_end: number;
  source: string;
  confidence: number;
  reason: string;
  transcript: string | null;
  frame_caption: string | null;
}

interface MergedHighlight {
  start: number;
  end: number;
  source: string;
  confidence: number;
  reason: string;
}

const MERGE_GAP_SECONDS = 60;

/** Collapse consecutive/overlapping flagged windows into single entries. */
function mergeHighlights(rows: HighlightRow[]): MergedHighlight[] {
  const sorted = [...rows].sort((a, b) => a.window_start - b.window_start);
  const merged: MergedHighlight[] = [];

  for (const row of sorted) {
    const last = merged[merged.length - 1];
    if (last && row.window_start - last.end <= MERGE_GAP_SECONDS) {
      last.end = Math.max(last.end, row.window_end);
      // Keep whichever reason came from the more confident window.
      if (row.confidence > last.confidence) {
        last.confidence = row.confidence;
        last.reason = row.reason;
        last.source = row.source;
      }
    } else {
      merged.push({
        start: row.window_start,
        end: row.window_end,
        source: row.source,
        confidence: row.confidence,
        reason: row.reason,
      });
    }
  }
  return merged;
}

function formatTimestamp(streamStart: number, absoluteSeconds: number): string {
  const elapsed = Math.max(0, absoluteSeconds - streamStart);
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = Math.floor(elapsed % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

async function summarizeWithLLM(ai: Ai, bulletList: string): Promise<string> {
  const prompt = `Here is a raw list of flagged moments from a livestream, with timestamps (relative to stream start) and short reasons they were flagged:

${bulletList}

Turn this into short, readable stream notes: a one-sentence overview line, then a clean timestamped bullet list a streamer could skim to decide what to clip or talk about in a recap. Keep each bullet to one line. Do not invent details that aren't in the list. Respond with ONLY the notes, no preamble.`;

  const response = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [{ role: "user", content: prompt }],
  });
  return (response as any).response ?? bulletList;
}

export async function generateStreamNotes(env: Env, streamId: string): Promise<string> {
  const streamRow = await env.DB.prepare(`SELECT started_at FROM streams WHERE id = ?`)
    .bind(streamId)
    .first<{ started_at: number }>();
  const streamStart = streamRow?.started_at ?? 0;

  const { results } = await env.DB.prepare(
    `SELECT window_start, window_end, source, confidence, reason, transcript, frame_caption
     FROM highlight_windows
     WHERE stream_id = ? AND is_highlight = 1
     ORDER BY window_start ASC`
  )
    .bind(streamId)
    .all<HighlightRow>();

  if (!results.length) {
    return "No highlights were flagged for this stream.";
  }

  const merged = mergeHighlights(results);
  const bulletList = merged
    .map((h) => {
      const ts = formatTimestamp(streamStart, h.start);
      const tag = h.source === "auto" ? "" : ` (${h.source})`;
      return `- [${ts}]${tag} ${h.reason}`;
    })
    .join("\n");

  const notes = await summarizeWithLLM(env.AI, bulletList);

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS stream_notes (
       stream_id TEXT PRIMARY KEY,
       notes TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`
  ).run();

  await env.DB.prepare(
    `INSERT INTO stream_notes (stream_id, notes, created_at) VALUES (?, ?, ?)
     ON CONFLICT(stream_id) DO UPDATE SET notes = excluded.notes, created_at = excluded.created_at`
  )
    .bind(streamId, notes, Math.floor(Date.now() / 1000))
    .run();

  if (env.DISCORD_WEBHOOK_URL) {
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `**Stream notes ready:**\n${notes}`.slice(0, 1900) }),
    }).catch((err) => console.error("Discord notify failed", err));
  }

  return notes;
}
