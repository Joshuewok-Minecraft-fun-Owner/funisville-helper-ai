-- One row per stream session (from "went live" to "went offline").
CREATE TABLE streams (
  id TEXT PRIMARY KEY,             -- Twitch stream/VOD id
  channel TEXT NOT NULL,
  started_at INTEGER NOT NULL,     -- unix seconds
  ended_at INTEGER,
  status TEXT NOT NULL DEFAULT 'live'  -- 'live' | 'ended' | 'processed'
);

-- Raw chat messages, kept mainly as context for the LLM judgment
-- step (surrounding text), not as a spike counter.
CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id TEXT NOT NULL REFERENCES streams(id),
  ts INTEGER NOT NULL,              -- unix seconds
  username TEXT NOT NULL,
  message TEXT NOT NULL,
  is_system_event INTEGER NOT NULL DEFAULT 0  -- 1 for raids/sub-trains/gift bombs
);

-- Every window the detection loop evaluated, whether or not it was
-- flagged. Keeping the negatives too makes it easy to tune later.
CREATE TABLE highlight_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id TEXT NOT NULL REFERENCES streams(id),
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  transcript TEXT,
  frame_caption TEXT,
  chat_excerpt TEXT,
  source TEXT NOT NULL,             -- 'auto' | 'hotkey' | 'meld'
  is_highlight INTEGER NOT NULL DEFAULT 0,
  confidence REAL,
  reason TEXT,                      -- short LLM explanation, shown to the user
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_highlight_windows_stream ON highlight_windows(stream_id, window_start);

-- Post-stream jobs (things the eventual "stream ended" flow queues up).
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id TEXT NOT NULL REFERENCES streams(id),
  type TEXT NOT NULL,               -- 'generate_notes' | 'finalize_highlights'
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'done' | 'error'
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
