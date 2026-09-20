import { StreamSession } from "./durable_objects/StreamSession";
export { StreamSession };

interface Env {
  STREAM_SESSION: DurableObjectNamespace;
  DB: D1Database;
  AI: Ai;
  MEDIA: any;
  TWITCH_CLIENT_ID: string;
  TWITCH_CHANNEL: string;
  DETECTION_INTERVAL_SECONDS: string;
  TWITCH_EVENTSUB_SECRET: string;
  MELD_BRIDGE_TOKEN: string;
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

    // --- Twitch EventSub: stream.online / stream.offline ---
    if (url.pathname === "/twitch/eventsub" && request.method === "POST") {
      return handleEventSub(request, env);
    }

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

    return new Response("not found", { status: 404 });
  },
};

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

async function handleEventSub(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const messageId = request.headers.get("Twitch-Eventsub-Message-Id") ?? "";
  const timestamp = request.headers.get("Twitch-Eventsub-Message-Timestamp") ?? "";
  const signature = request.headers.get("Twitch-Eventsub-Message-Signature");

  const valid = await verifyEventSubSignature(
    env.TWITCH_EVENTSUB_SECRET,
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
    const streamId = body.event.id as string;
    await env.DB.prepare(
      `INSERT INTO streams (id, channel, started_at, status) VALUES (?, ?, ?, 'live')`
    )
      .bind(streamId, env.TWITCH_CHANNEL, Math.floor(Date.now() / 1000))
      .run();
    await session.fetch("https://do/start", { method: "POST", body: JSON.stringify({ streamId }) });
  }

  if (eventType === "stream.offline") {
    await session.fetch("https://do/stop", { method: "POST" });
    await env.DB.prepare(
      `UPDATE streams SET status = 'ended', ended_at = ? WHERE channel = ? AND status = 'live'`
    )
      .bind(Math.floor(Date.now() / 1000), env.TWITCH_CHANNEL)
      .run();
    // This is where you'd queue the post-stream jobs (stream notes
    // generation, final highlight-list cleanup) - see README.
  }

  return new Response("ok");
}
