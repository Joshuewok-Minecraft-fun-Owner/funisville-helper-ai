import { getLiveHlsVariants, fetchRecentSegments, concatSegments } from "../twitch";
import { transcribeAudio, captionFrame, judgeHighlight } from "../ai";
import { extractFrame } from "../media";
import { parseIrcLine } from "../irc";

interface Env {
  DB: D1Database;
  AI: Ai;
  MEDIA: any;
  TWITCH_CHANNEL: string;
  DETECTION_INTERVAL_SECONDS: string;
  // Highlights at/above this confidence auto-request a Meld clip via
  // the /pending-clips path, not just a flagged entry in the list.
  AUTO_CLIP_CONFIDENCE_THRESHOLD?: string;
}

const IRC_WS_URL = "https://irc-ws.chat.twitch.tv/"; // fetch+Upgrade, not a real HTTPS request
const IRC_BACKOFF_BASE_SECONDS = 10;
const IRC_BACKOFF_MAX_SECONDS = 300; // cap at 5 minutes between attempts

interface ChatEvent {
  ts: number;
  username: string;
  message: string;
  isSystemEvent: boolean;
}

/**
 * One instance of this DO exists per live stream. It:
 *  - receives chat messages pushed in over its hibernating WebSocket
 *    (kept in this DO's own SQLite storage, not just memory, so it
 *    survives hibernation between messages)
 *  - runs an alarm every DETECTION_INTERVAL_SECONDS to pull the
 *    newest audio+video chunk, transcribe it, caption a frame from
 *    it, gather recent chat, and ask an LLM to judge the window
 *  - accepts manual "mark this moment" triggers (hotkey or Meld)
 */
export class StreamSession {
  state: DurableObjectState;
  env: Env;
  streamId: string | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/start") && request.method === "POST") {
      const { streamId } = await request.json<{ streamId: string }>();
      this.streamId = streamId;
      await this.state.storage.put("streamId", streamId);
      await this.state.storage.delete("ircReconnectAttempts");
      await this.state.storage.delete("ircNextReconnectAt");
      const intervalMs = Number(this.env.DETECTION_INTERVAL_SECONDS || "25") * 1000;
      await this.state.storage.setAlarm(Date.now() + intervalMs);
      try {
        await this.connectToTwitchIrc();
      } catch (err) {
        console.error("initial IRC connect failed, will retry via alarm", err);
        await this.scheduleIrcReconnect();
      }
      return new Response("started");
    }

    if (url.pathname.endsWith("/stop") && request.method === "POST") {
      await this.state.storage.deleteAlarm();
      const existing = this.state.getWebSockets("irc")[0];
      existing?.close(1000, "stream ended");
      return new Response("stopped");
    }

    // Kept for any external chat source you might add later (e.g. a
    // separate bot), but the DO now listens to Twitch IRC directly -
    // see connectToTwitchIrc() - so this isn't required for the
    // built-in flow anymore.
    if (url.pathname.endsWith("/chat") && request.method === "POST") {
      const event = await request.json<ChatEvent>();
      await this.appendChat(event);
      return new Response("ok");
    }

    // Polled by the local Meld bridge every few seconds. Returns
    // whether the last detection cycle produced a high-confidence
    // auto highlight, and clears the flag once read.
    if (url.pathname.endsWith("/pending-clip") && request.method === "GET") {
      const shouldClip = (await this.state.storage.get<boolean>("pendingClip")) ?? false;
      if (shouldClip) await this.state.storage.put("pendingClip", false);
      return Response.json({ shouldClip });
    }

    // Manual trigger: a hotkey press or a Meld-side event, both just
    // POST a timestamp here. No AI needed for this path - if a human
    // (or Meld's own instant-replay) flagged it, that's good enough.
    if (url.pathname.endsWith("/mark") && request.method === "POST") {
      const { source = "hotkey", note = "" } = await request
        .json<{ source?: string; note?: string }>()
        .catch(() => ({}));
      const now = Math.floor(Date.now() / 1000);
      await this.recordWindow({
        windowStart: now - 30,
        windowEnd: now,
        transcript: "",
        frameCaption: null,
        chatExcerpt: "",
        source,
        isHighlight: true,
        confidence: 1,
        reason: note || `Manually marked via ${source}`,
      });
      return new Response("marked");
    }

    return new Response("not found", { status: 404 });
  }

  async alarm() {
    if (!this.streamId) {
      this.streamId = (await this.state.storage.get<string>("streamId")) ?? null;
    }
    if (!this.streamId) return; // nothing to do if we don't know the stream

    const intervalSeconds = Number(this.env.DETECTION_INTERVAL_SECONDS || "25");

    // The alarm is already ticking on a regular cadence, so it doubles
    // as our backoff clock for IRC reconnects - no separate timer, no
    // held-open sleep burning duration billing.
    await this.maybeReconnectIrc();

    try {
      await this.runDetectionCycle(intervalSeconds);
    } catch (err) {
      // A single failed cycle (e.g. a transient Twitch/AI hiccup)
      // shouldn't kill the loop - just skip this window and continue.
      console.error("detection cycle failed", err);
    }

    // Re-arm for the next cycle.
    await this.state.storage.setAlarm(Date.now() + intervalSeconds * 1000);
  }

  /** Reconnect to Twitch IRC if we're not currently connected and any backoff has elapsed. */
  private async maybeReconnectIrc() {
    if (this.state.getWebSockets("irc").length > 0) return; // already connected

    const nextAttemptAt = (await this.state.storage.get<number>("ircNextReconnectAt")) ?? 0;
    if (Date.now() < nextAttemptAt) return; // still backing off

    try {
      await this.connectToTwitchIrc();
      await this.state.storage.delete("ircReconnectAttempts");
      await this.state.storage.delete("ircNextReconnectAt");
    } catch (err) {
      console.error("IRC reconnect attempt failed", err);
      await this.scheduleIrcReconnect();
    }
  }

  /** Bump the reconnect attempt counter and push the next-allowed-attempt time out exponentially. */
  private async scheduleIrcReconnect() {
    const attempts = ((await this.state.storage.get<number>("ircReconnectAttempts")) ?? 0) + 1;
    const delaySeconds = Math.min(
      IRC_BACKOFF_BASE_SECONDS * 2 ** (attempts - 1),
      IRC_BACKOFF_MAX_SECONDS
    );
    await this.state.storage.put("ircReconnectAttempts", attempts);
    await this.state.storage.put("ircNextReconnectAt", Date.now() + delaySeconds * 1000);
  }

  private async runDetectionCycle(windowSeconds: number) {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - windowSeconds;

    const variants = await getLiveHlsVariants(this.env.TWITCH_CHANNEL);
    const audioVariant = variants.find((v) => v.name === "Audio Only");
    // Fall back to the lowest-bitrate non-audio-only variant for frame
    // grabs - we only need one still image, not full quality video.
    const videoVariant = variants.find((v) => v.name !== "Audio Only");

    let transcript = "";
    if (audioVariant) {
      const audioSegments = await fetchRecentSegments(audioVariant.url, windowSeconds);
      if (audioSegments.length) {
        transcript = await transcribeAudio(this.env.AI, concatSegments(audioSegments));
      }
    }

    let frameCaption: string | null = null;
    if (videoVariant) {
      const videoSegments = await fetchRecentSegments(videoVariant.url, Math.min(windowSeconds, 6));
      if (videoSegments.length) {
        const frame = await extractFrame(this.env.MEDIA, concatSegments(videoSegments), 0);
        frameCaption = await captionFrame(this.env.AI, frame);
      }
    }

    const chatExcerpt = await this.recentChatText(windowStart, now);

    // Nothing at all to go on this cycle (dead air, no chat, frame
    // grab failed) - skip the LLM call entirely rather than spend a
    // request on an obviously empty window.
    if (!transcript && !frameCaption && !chatExcerpt) return;

    const judgment = await judgeHighlight(this.env.AI, {
      streamId: this.streamId!,
      windowStart,
      windowEnd: now,
      transcript,
      frameCaption,
      chatExcerpt,
    });

    await this.recordWindow({
      windowStart,
      windowEnd: now,
      transcript,
      frameCaption,
      chatExcerpt,
      source: "auto",
      isHighlight: judgment.isHighlight,
      confidence: judgment.confidence,
      reason: judgment.reason,
    });

    const threshold = Number(this.env.AUTO_CLIP_CONFIDENCE_THRESHOLD ?? "0.75");
    if (judgment.isHighlight && judgment.confidence >= threshold) {
      // Picked up by the local bridge's poll loop, which tells Meld
      // to save an instant replay - see /pending-clip above.
      await this.state.storage.put("pendingClip", true);
    }
  }

  // --- Twitch IRC (chat) ---------------------------------------------
  //
  // Connects anonymously (read-only, no OAuth needed) using a
  // hibernatable WebSocket: the connection stays open for the whole
  // stream, but this DO is only "active" (and billed) for the brief
  // moments it's actually handling an incoming line.

  private async connectToTwitchIrc() {
    const resp = await fetch(IRC_WS_URL, { headers: { Upgrade: "websocket" } });
    const ws = (resp as any).webSocket as WebSocket | undefined;
    if (!ws) {
      throw new Error("failed to establish Twitch IRC websocket (no upgrade returned)");
    }
    this.state.acceptWebSocket(ws, ["irc"]);
    ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
    ws.send(`NICK justinfan${Math.floor(Math.random() * 100000)}`);
    ws.send(`JOIN #${this.env.TWITCH_CHANNEL.toLowerCase()}`);
  }

  /** Required hook for hibernatable WebSockets - called on every incoming line. */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    for (const line of text.split("\r\n")) {
      const parsed = parseIrcLine(line);
      if (!parsed) continue;

      if (parsed.type === "PING") {
        ws.send("PONG :tmi.twitch.tv");
        continue;
      }

      if (parsed.type === "PRIVMSG" || parsed.type === "USERNOTICE") {
        const now = Math.floor(Date.now() / 1000);
        await this.appendChat({
          ts: now,
          username: parsed.username,
          message: parsed.message,
          isSystemEvent: parsed.isSystemEvent,
        });
        if (this.streamId) {
          await this.env.DB.prepare(
            `INSERT INTO chat_messages (stream_id, ts, username, message, is_system_event) VALUES (?, ?, ?, ?, ?)`
          )
            .bind(this.streamId, now, parsed.username, parsed.message, parsed.isSystemEvent ? 1 : 0)
            .run();
        }
      }
    }
  }

  /** Required hook for hibernatable WebSockets - schedule a backed-off reconnect if the stream is still live. */
  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    const streamId = await this.state.storage.get<string>("streamId");
    if (streamId && code !== 1000) {
      // Not a deliberate stop (that sends code 1000) - Twitch dropped
      // us or the connection hiccuped. Don't reconnect inline here -
      // just record that we need to, and let the next alarm tick
      // (maybeReconnectIrc) pick it up once any backoff has elapsed.
      await this.scheduleIrcReconnect();
    }
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    console.error("Twitch IRC websocket error", error);
  }

  private async appendChat(event: ChatEvent) {
    const chat = (await this.state.storage.get<ChatEvent[]>("recentChat")) ?? [];
    chat.push(event);
    // Keep a rolling few minutes of chat in DO storage; the D1 table
    // (written from the Worker's IRC listener, not here) is the
    // durable long-term log.
    const cutoff = Math.floor(Date.now() / 1000) - 300;
    const trimmed = chat.filter((c) => c.ts >= cutoff);
    await this.state.storage.put("recentChat", trimmed);
  }

  private async recentChatText(start: number, end: number): Promise<string> {
    const chat = (await this.state.storage.get<ChatEvent[]>("recentChat")) ?? [];
    return chat
      .filter((c) => c.ts >= start && c.ts <= end)
      .map((c) => (c.isSystemEvent ? `[system event] ${c.message}` : `${c.username}: ${c.message}`))
      .join("\n");
  }

  private async recordWindow(w: {
    windowStart: number;
    windowEnd: number;
    transcript: string;
    frameCaption: string | null;
    chatExcerpt: string;
    source: string;
    isHighlight: boolean;
    confidence: number;
    reason: string;
  }) {
    await this.env.DB.prepare(
      `INSERT INTO highlight_windows
        (stream_id, window_start, window_end, transcript, frame_caption, chat_excerpt, source, is_highlight, confidence, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        this.streamId,
        w.windowStart,
        w.windowEnd,
        w.transcript,
        w.frameCaption,
        w.chatExcerpt,
        w.source,
        w.isHighlight ? 1 : 0,
        w.confidence,
        w.reason,
        Math.floor(Date.now() / 1000)
      )
      .run();
  }
}
