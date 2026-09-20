/**
 * Minimal parser for Twitch IRC-over-WebSocket lines. We only need
 * two message types:
 *
 *  - PRIVMSG: a normal chat message someone typed.
 *  - USERNOTICE: a system-generated notice - raids, individual sub
 *    gifts, mass gift bombs, sub/resub announcements, etc. These are
 *    structurally distinct from typed chat, which is what lets us
 *    reliably exclude raids/gift-trains from being read as organic
 *    reactions without trying to pattern-match copy-pasted text.
 *
 * Note: Hype Trains are a separate EventSub topic
 * (channel.hype_train.*), not an IRC message - out of scope here,
 * but worth wiring up the same way (as a labeled system event) if you
 * add EventSub subscriptions for it later.
 */

export interface ParsedIrcMessage {
  type: "PRIVMSG" | "USERNOTICE" | "PING" | "OTHER";
  username: string;
  message: string;
  isSystemEvent: boolean;
  raw: string;
}

const SYSTEM_MSG_IDS = new Set([
  "raid",
  "subgift",
  "submysterygift",
  "anonsubgift",
  "anongiftpaidupgrade",
  "giftpaidupgrade",
  "sub",
  "resub",
  "ritual",
  "bitsbadgetier",
]);

function parseTags(tagString: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const pair of tagString.split(";")) {
    const [key, value] = pair.split("=");
    if (key) tags[key] = value ?? "";
  }
  return tags;
}

export function parseIrcLine(line: string): ParsedIrcMessage | null {
  if (!line) return null;
  if (line.startsWith("PING")) {
    return { type: "PING", username: "", message: "", isSystemEvent: false, raw: line };
  }

  let tags: Record<string, string> = {};
  let rest = line;
  if (line.startsWith("@")) {
    const spaceIdx = line.indexOf(" ");
    tags = parseTags(line.slice(1, spaceIdx));
    rest = line.slice(spaceIdx + 1);
  }

  if (rest.includes(" PRIVMSG ")) {
    const displayName = tags["display-name"] || rest.match(/^:([^!]+)/)?.[1] || "unknown";
    const message = rest.slice(rest.indexOf(" :") + 2);
    return { type: "PRIVMSG", username: displayName, message, isSystemEvent: false, raw: line };
  }

  if (rest.includes(" USERNOTICE ")) {
    const msgId = tags["msg-id"] || "";
    const systemMsg = tags["system-msg"]?.replace(/\\s/g, " ") || "";
    const userMessage = rest.includes(" :") ? rest.slice(rest.indexOf(" :") + 2) : "";
    return {
      type: "USERNOTICE",
      username: tags["display-name"] || "system",
      message: systemMsg || userMessage || `[${msgId}]`,
      isSystemEvent: SYSTEM_MSG_IDS.has(msgId) || true, // every USERNOTICE is non-organic by definition
      raw: line,
    };
  }

  return { type: "OTHER", username: "", message: "", isSystemEvent: false, raw: line };
}
