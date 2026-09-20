# Stream AI Agent

Behind-the-scenes streaming helper: no alerts, just a running list of
"here's what looked interesting and why," built entirely on Cloudflare
(Workers, Durable Objects, Workers AI, Media Transformations, D1) plus
one tiny optional local script for Meld/hotkey integration.

## How it works

Every ~25 seconds while you're live, the `StreamSession` Durable Object:

1. Pulls the last ~25s of your **audio-only** Twitch HLS stream and
   transcribes it with Whisper (Workers AI).
2. Pulls a few seconds of the **video** stream, grabs a still frame via
   Media Transformations, and captions it with a vision model.
3. Reads recent **chat** (already flagged so raids/sub-trains/gift
   bombs are excluded from being read as genuine reactions).
4. Sends all three to an LLM and asks: "does this window look like a
   highlight?" Flagged windows get written to D1 with a short reason.

Chat itself is read live by the same Durable Object, straight from
Twitch IRC (anonymous, read-only, no OAuth needed) over a hibernatable
WebSocket - it's only "active" (and billed) for the moment it's
handling one incoming line. Raids, sub-trains, and gift bombs arrive
as a structurally distinct message type (`USERNOTICE`) and are tagged
as system events before they ever reach the LLM, so they inform
context without being mistaken for genuine reactions.

A **manual hotkey** (routed through the small local bridge script, or
directly if you wire a Stream Deck action to the same endpoint) can
mark a moment at any time, no AI needed - useful for anything you
noticed that the automated signals might miss. High-confidence auto
detections (above `AUTO_CLIP_CONFIDENCE_THRESHOLD`) also flip a flag
the bridge script polls, so Meld can save a clip without you touching
anything.

Nothing here needs Containers, ffmpeg, or downloading full VODs - the
audio/video pulls are always small, rolling windows, not the whole
stream.

## One-time setup

### 1. Cloudflare resources

```
npm install
npx wrangler d1 create stream-agent-db      # copy the id into wrangler.jsonc
npm run db:migrate:remote
npx wrangler secret put TWITCH_EVENTSUB_SECRET
npx wrangler secret put MELD_BRIDGE_TOKEN
```

Fill in `TWITCH_CLIENT_ID` and `TWITCH_CHANNEL` in `wrangler.jsonc`.

### 2. Twitch app + EventSub

- Register an app at https://dev.twitch.tv/console to get a client ID.
- Subscribe to `stream.online` and `stream.offline` for your channel,
  pointing the webhook at `https://<your-worker>.workers.dev/twitch/eventsub`.
  (The subscription-creation call itself needs a server-to-server
  Twitch API request with an app access token - a one-time script, not
  part of this Worker.)
- **Add signature verification** to `handleEventSub` in `src/index.ts`
  before going live for real - the scaffold skips it for brevity, but
  an unverified webhook endpoint will accept forged requests.

### 3. Chat ingestion

Handled automatically - the `StreamSession` DO connects to Twitch IRC
itself on `/start` and reconnects if it ever drops. Nothing to set up
here beyond `TWITCH_CHANNEL` in `wrangler.jsonc`. The `/chat` HTTP
route still exists if you ever want to forward messages from a
separate bot instead, but it's optional now.

### 4. Meld + hotkey bridge (optional, for manual marking + AI-triggered clips)

```
cd local-bridge
npm install ws node-fetch
node meld-bridge.js
```

Confirm Meld's local WebSocket port in Meld's settings and update
`MELD_WS_URL`. Wire a Stream Deck "website" action to
`http://localhost:4545/hotkey`, or uncomment the global-hotkey option
in the script.

### 5. Deploy

```
npx wrangler deploy
```

## What's intentionally left as a next step

- **Post-stream jobs** (`stream.offline` handler has a comment marking
  where to queue this) - generating a written "stream notes" summary
  from the day's flagged windows, and any cleanup/dedup of
  near-duplicate highlight windows.
- **Hype Trains** - these arrive via a separate EventSub topic
  (`channel.hype_train.*`), not IRC, so they're not yet labeled as
  system events the way raids/gift-bombs are. Same pattern would
  apply if you add that subscription later.
- **Reconnect backoff** - the IRC reconnect-on-drop logic retries
  immediately; fine for a scaffold, but a real deployment should add
  a short backoff so a bad patch of connectivity doesn't hammer
  Twitch's IRC servers with rapid reconnects.

Everything else from the original stub list - IRC chat listening,
EventSub signature verification, and the AI-triggered `/pending-clips`
path - is built and wired in.
