import { StreamSession } from "./durable_objects/StreamSession";
import { generateStreamNotes } from "./notes";
import { renderDashboard } from "./dashboard";
import { isChannelLive } from "./twitch";
export { StreamSession };

interface Env {
  STREAM_SESSION: DurableObjectNamespace;
  DB: D1Database;
  AI: Ai;
  MEDIA: any;
  TWITCH_CLIENT_ID?: string; // only needed if you switch to the EventSub webhook path
  TWITCH_CHANNEL: string;
  DETECTION_INTERVAL_SECONDS: string;
  TWITCH_EVENTSUB_SECRET?: string; // only needed for the EventSub webhook path
  MELD_BRIDGE_TOKEN: string;
  DISCORD_WEBHOOK_URL?: string;
}

// One DO instance per channel is enough here - simplest to key it by
// channel name rather than by stream id, since the "stream start"
// webhook is what tells the DO which stream id to use internally.
function sessionFor(env: Env, channel: string) {
  const id = env.STREAM_SESSION.idFromName(channel);
  return env.STREAM_SESSION.get(id);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // --- A page to actually look at, instead of raw JSON ---
    if (url.pathname === "/dashboard" && request.method === "GET") {
      return new Response(renderDashboard(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // --- Twitch EventSub: OPTIONAL, only needed if you switch from
    //     polling to instant push notifications (requires a
    //     registered Twitch app + 2FA - see handleEventSub below for
    //     why this is commented out by default).
    // if (url.pathname === "/twitch/eventsub" && request.method === "POST") {
    //   return handleEventSub(request, env);
    // }

    // --- Chat bridge posts each message here (see note in README on
    //     where the IRC listener itself runs) ---
    if (url.pathname === "/chat" && request.method === "POST") {
      const body = await request.json<{ streamId: string; ts: number; username: string; message: string; isSystemEvent?: boolean }>();
      const session = sessionFor(env, env.TWITCH_CHANNEL);
      await session.fetch("https://do/chat", {
        method: "POST",
        body: JSON.stringify({
          ts: body.ts,
          username: body.username,
          message: body.message,
          isSystemEvent: !!body.isSystemEvent,
        }),
      });
      // Also keep the durable long-term copy in D1.
      await env.DB.prepare(
        `INSERT INTO chat_messages (stream_id, ts, username, message, is_system_event) VALUES (?, ?, ?, ?, ?)`
      )
        .bind(body.streamId, body.ts, body.username, body.message, body.isSystemEvent ? 1 : 0)
        .run();
      return new Response("ok");
    }

    // --- Manual "mark this moment" - hotkey script or Meld hits this ---
    if (url.pathname === "/mark" && request.method === "POST") {
      const auth = request.headers.get("Authorization");
      if (auth !== `Bearer ${env.MELD_BRIDGE_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const body = await request.json<{ source?: string; note?: string }>().catch(() => ({}));
      const session = sessionFor(env, env.TWITCH_CHANNEL);
      return session.fetch("https://do/mark", { method: "POST", body: JSON.stringify(body) });
    }

    // --- Polled by the local Meld bridge: has the AI flagged a high-confidence moment? ---
    if (url.pathname === "/pending-clips" && request.method === "GET") {
      const auth = request.headers.get("Authorization");
      if (auth !== `Bearer ${env.MELD_BRIDGE_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const session = sessionFor(env, env.TWITCH_CHANNEL);
      const res = await session.fetch("https://do/pending-clip");
      return new Response(await res.text(), { headers: { "Content-Type": "application/json" } });
    }

    // --- Read back the highlight list for a stream, for your dashboard/Discord message ---
    if (url.pathname === "/highlights" && request.method === "GET") {
      const streamId = url.searchParams.get("streamId");
      if (!streamId) return new Response("streamId required", { status: 400 });
      const { results } = await env.DB.prepare(
        `SELECT window_start, window_end, source, confidence, reason, transcript, frame_caption
         FROM highlight_windows
         WHERE stream_id = ? AND is_highlight = 1
         ORDER BY window_start ASC`
      )
        .bind(streamId)
        .all();
      return Response.json(results);
    }

    // --- Read back generated stream notes ---
    if (url.pathname === "/notes" && request.method === "GET") {
      const streamId = url.searchParams.get("streamId");
      if (!streamId) return new Response("streamId required", { status: 400 });
      const row = await env.DB.prepare(`SELECT notes, created_at FROM stream_notes WHERE stream_id = ?`)
        .bind(streamId)
        .first();
      if (!row) return new Response("not found", { status: 404 });
      return Response.json(row);
    }

    return new Response("not found", { status: 404 });
  },

  /**
   * Runs on the cron schedule set in wrangler.jsonc (default: every 2
   * minutes). This is the no-Twitch-app, no-2FA way of knowing when
   * you go live/offline - polls the same unofficial endpoint the
   * audio/video pulls already use, instead of Twitch pushing a
   * webhook. Slightly slower to notice (up to one polling interval),
   * genuinely free of any account requirements.
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(checkStreamStatus(env));
  },
};

async function checkStreamStatus(env: Env) {
  const session = sessionFor(env, env.TWITCH_CHANNEL);
  const liveNow = await isChannelLive(env.TWITCH_CHANNEL);

  const trackedLive = await env.DB.prepare(
    `SELECT id FROM streams WHERE channel = ? AND status = 'live'`
  )
    .bind(env.TWITCH_CHANNEL)
    .first<{ id: string }>();

  if (liveNow && !trackedLive) {
    // Just went live, and we're not already tracking a session.
    // There's no official Twitch stream ID available without the
    // Helix API, so we mint our own - it only needs to be unique and
    // stable for this session's lifetime.
    const streamId = `${env.TWITCH_CHANNEL}-${Date.now()}`;
    await handleStreamOnline(env, session, streamId);
  } else if (!liveNow && trackedLive) {
    // Went offline since the last check.
    await handleStreamOffline(env, session, trackedLive.id);
  }
  // Otherwise: no state change, nothing to do this tick.
}

/** Shared by both the poll-based path above and the optional EventSub webhook below. */
async function handleStreamOnline(
  env: Env,
  session: DurableObjectStub,
  streamId: string
) {
  await env.DB.prepare(
    `INSERT INTO streams (id, channel, started_at, status) VALUES (?, ?, ?, 'live')`
  )
    .bind(streamId, env.TWITCH_CHANNEL, Math.floor(Date.now() / 1000))
    .run();
  await session.fetch("https://do/start", { method: "POST", body: JSON.stringify({ streamId }) });
}

/** Shared by both the poll-based path above and the optional EventSub webhook below. */
async function handleStreamOffline(env: Env, session: DurableObjectStub, streamId: string) {
  await session.fetch("https://do/stop", { method: "POST" });
  await env.DB.prepare(`UPDATE streams SET status = 'ended', ended_at = ? WHERE id = ?`)
    .bind(Math.floor(Date.now() / 1000), streamId)
    .run();

  const jobResult = await env.DB.prepare(
    `INSERT INTO jobs (stream_id, type, status, created_at) VALUES (?, 'generate_notes', 'pending', ?)`
  )
    .bind(streamId, Math.floor(Date.now() / 1000))
    .run();

  try {
    await generateStreamNotes(env, streamId);
    await env.DB.prepare(`UPDATE jobs SET status = 'done', completed_at = ? WHERE id = ?`)
      .bind(Math.floor(Date.now() / 1000), jobResult.meta.last_row_id)
      .run();
    await env.DB.prepare(`UPDATE streams SET status = 'processed' WHERE id = ?`)
      .bind(streamId)
      .run();
  } catch (err) {
    console.error("stream notes generation failed", err);
    await env.DB.prepare(`UPDATE jobs SET status = 'error' WHERE id = ?`)
      .bind(jobResult.meta.last_row_id)
      .run();
  }
}

/**
 * Twitch signs every EventSub delivery with your subscription secret.
 * Verifying this is what stops anyone else from POSTing fake
 * "stream.online" events at your webhook. Must be checked against the
 * *raw* request body - not the parsed JSON - since the signature is
 * computed over the exact bytes Twitch sent.
 */
async function verifyEventSubSignature(
  secret: string,
  messageId: string,
  timestamp: string,
  rawBody: string,
  signatureHeader: string | null
): Promise<boolean> {
  if (!signatureHeader) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(messageId + timestamp + rawBody)
  );
  const hex = [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}` === signatureHeader;
}

/**
 * OPTIONAL - only relevant if you later want instant push
 * notifications instead of the ~2-minute polling above, and are
 * willing to register a Twitch app (requires 2FA on your account).
 * Not wired up by default - nothing calls this unless you add the
 * /twitch/eventsub route back in the fetch handler above and create
 * the actual EventSub subscriptions server-side.
 */
async function handleEventSub(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const messageId = request.headers.get("Twitch-Eventsub-Message-Id") ?? "";
  const timestamp = request.headers.get("Twitch-Eventsub-Message-Timestamp") ?? "";
  const signature = request.headers.get("Twitch-Eventsub-Message-Signature");

  const valid = await verifyEventSubSignature(
    env.TWITCH_EVENTSUB_SECRET ?? "",
    messageId,
    timestamp,
    rawBody,
    signature
  );
  if (!valid) return new Response("invalid signature", { status: 403 });

  const body = JSON.parse(rawBody);

  if (body.challenge) {
    // Subscription verification handshake.
    return new Response(body.challenge, { headers: { "Content-Type": "text/plain" } });
  }

  const messageType = request.headers.get("Twitch-Eventsub-Message-Type");
  if (messageType === "revocation") {
    console.error("EventSub subscription revoked:", body.subscription?.status);
    return new Response("ok");
  }

  const eventType = request.headers.get("Twitch-Eventsub-Subscription-Type");
  const session = sessionFor(env, env.TWITCH_CHANNEL);

  if (eventType === "stream.online") {
    await handleStreamOnline(env, session, body.event.id as string);
  }

  if (eventType === "stream.offline") {
    const streamRow = await env.DB.prepare(
      `SELECT id FROM streams WHERE channel = ? AND status = 'live'`
    )
      .bind(env.TWITCH_CHANNEL)
      .first<{ id: string }>();
    if (streamRow?.id) {
      await handleStreamOffline(env, session, streamRow.id);
    }
  }

  // Hype Trains aren't IRC messages - they're their own EventSub
  // topics. If you've subscribed to channel.hype_train.begin/progress,
  // label them the same way raids/gift-bombs are: a system event, not
  // a genuine per-message reaction, but still useful context.
  if (eventType?.startsWith("channel.hype_train")) {
    const streamRow = await env.DB.prepare(
      `SELECT id FROM streams WHERE channel = ? AND status = 'live'`
    )
      .bind(env.TWITCH_CHANNEL)
      .first<{ id: string }>();
    const now = Math.floor(Date.now() / 1000);
    const level = body.event?.level ?? "?";
    const message = `Hype Train ${eventType.split(".").pop()} (level ${level})`;

    await session.fetch("https://do/chat", {
      method: "POST",
      body: JSON.stringify({ ts: now, username: "system", message, isSystemEvent: true }),
    });
    if (streamRow?.id) {
      await env.DB.prepare(
        `INSERT INTO chat_messages (stream_id, ts, username, message, is_system_event) VALUES (?, ?, 'system', ?, 1)`
      )
        .bind(streamRow.id, now, message)
        .run();
    }
  }

  return new Response("ok");
}
