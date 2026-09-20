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

**No Twitch app, no registration, no 2FA required for any of this.**
A scheduled check runs every 2 minutes and asks the same
no-registration-needed Twitch endpoint "is this channel live right
now?" - when the answer flips, that's what starts/stops a session.
(There's an optional, faster alternative using Twitch's official
EventSub webhooks, but it requires registering a Twitch app - which
Twitch gates behind 2FA on your account - so it's off by default; see
"Going faster later" below if you want it.)

When the stream ends, a post-stream job collapses near-duplicate
flagged windows (the rolling loop can flag several consecutive ~25s
windows for one longer moment) and asks an LLM to turn the list into
short, skimmable **stream notes** - stored in D1 and, if you set
`DISCORD_WEBHOOK_URL`, posted straight to Discord. Read them back any
time via `GET /notes?streamId=...`.

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
npx wrangler secret put MELD_BRIDGE_TOKEN
```

Fill in `TWITCH_CHANNEL` in `wrangler.jsonc` (your channel's login,
lowercase - the part in your Twitch URL).

That's it for Twitch setup - no app registration, no 2FA, nothing
else needed. The cron trigger in `wrangler.jsonc` handles live
detection on its own once deployed.

### 2. Chat ingestion

Handled automatically - the `StreamSession` DO connects to Twitch IRC
itself on `/start` and reconnects if it ever drops. Nothing to set up
here beyond `TWITCH_CHANNEL` in `wrangler.jsonc`. The `/chat` HTTP
route still exists if you ever want to forward messages from a
separate bot instead, but it's optional now.

### 3. Meld + hotkey bridge (optional, for manual marking + AI-triggered clips)

```
cd local-bridge
npm install ws node-fetch
node meld-bridge.js
```

Confirm Meld's local WebSocket port in Meld's settings and update
`MELD_WS_URL`. Wire a Stream Deck "website" action to
`http://localhost:4545/hotkey`, or uncomment the global-hotkey option
in the script.

### 4. Deploy

```
npx wrangler deploy
```

## Going faster later (optional)

The 2-minute polling above is simple and needs zero Twitch account
requirements, but it's not instant. If you eventually want push
notifications the second you go live/offline instead:

1. Register an app at https://dev.twitch.tv/console (requires 2FA on
   your Twitch account - this is Twitch's requirement, not this
   project's).
2. Add `TWITCH_CLIENT_ID` back under `vars` in `wrangler.jsonc`, and
   run `npx wrangler secret put TWITCH_EVENTSUB_SECRET`.
3. Uncomment the `/twitch/eventsub` route in `src/index.ts` (it's
   already there, commented out) and point a real EventSub
   subscription at it - that subscription-creation call needs a
   server-to-server Twitch API request with an app access token, a
   one-time script not included here.
4. You can keep the cron trigger running alongside it as a fallback,
   or remove it - your call.

## What's intentionally left as a next step

- **Hype Train subscription** - only relevant if you set up the
  optional EventSub path above; the *handling* code for it is already
  in `index.ts`, it just needs the subscription itself created.

Everything else - live-status polling (no Twitch app needed), IRC
chat listening (with exponential-backoff reconnects), the AI-triggered
`/pending-clips` path, post-stream notes generation, and a dashboard
at `/dashboard?streamId=...` to view it all - is built and wired in.
