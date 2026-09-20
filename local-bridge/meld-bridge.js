/**
 * Small local script - the ONLY thing that needs to run on your PC,
 * and only while you're actually streaming with Meld. It does two
 * cheap things, nothing CPU/disk heavy:
 *
 *   1. Listens for your "mark this moment" hotkey (via a global
 *      hotkey library, or a Stream Deck action hitting a tiny local
 *      HTTP server - wire up whichever you prefer) and forwards it
 *      to your Worker's /mark endpoint.
 *
 *   2. Connects to Meld's local WebSocket API so that when the cloud
 *      side wants to clip something, it can tell Meld to actually
 *      save the instant replay.
 *
 * Run with: node meld-bridge.js
 * Requires: npm install ws node-fetch
 */

const WebSocket = require("ws");
const fetch = require("node-fetch");

const WORKER_URL = "https://YOUR-WORKER-SUBDOMAIN.workers.dev";
const BRIDGE_TOKEN = "REPLACE_WITH_YOUR_MELD_BRIDGE_TOKEN"; // must match wrangler secret
const MELD_WS_URL = "ws://localhost:28492"; // Meld's local WebSocket port - confirm in Meld's settings

const meld = new WebSocket(MELD_WS_URL);

meld.on("open", () => console.log("[bridge] connected to Meld"));
meld.on("error", (err) => console.error("[bridge] Meld connection error:", err.message));

/** Call this from your hotkey handler / Stream Deck action. */
async function markMoment(note = "") {
  try {
    await fetch(`${WORKER_URL}/mark`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BRIDGE_TOKEN}`,
      },
      body: JSON.stringify({ source: "hotkey", note }),
    });
    // Also grab a local clip immediately via Meld's own instant-replay,
    // so you have footage on disk right away, not just a timestamp.
    meld.send(JSON.stringify({ command: "sendCommand", args: ["recordClip"] }));
    console.log("[bridge] moment marked + clip requested");
  } catch (err) {
    console.error("[bridge] failed to mark moment:", err.message);
  }
}

// --- Wire up a trigger. Two simple options: ---

// Option A: a tiny local HTTP server a Stream Deck "website" action can hit.
const http = require("http");
http
  .createServer((req, res) => {
    if (req.url === "/hotkey") {
      markMoment("Stream Deck button");
      res.end("ok");
    } else {
      res.end("bridge running");
    }
  })
  .listen(4545, () => console.log("[bridge] listening on http://localhost:4545/hotkey"));

// Option B: a global keyboard shortcut (uncomment and `npm install node-global-key-listener`)
// const { GlobalKeyboardListener } = require("node-global-key-listener");
// new GlobalKeyboardListener().addListener((e, down) => {
//   if (e.name === "F9" && e.state === "DOWN") markMoment("F9 hotkey");
// });

// --- Poll the Worker for any pending "AI wants to clip this" triggers ---
// (the live detection loop in StreamSession can't reach your local
// network directly, so this bridge checks in periodically instead.)
setInterval(async () => {
  try {
    const res = await fetch(`${WORKER_URL}/pending-clips`, {
      headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
    });
    const { shouldClip } = await res.json();
    if (shouldClip) {
      meld.send(JSON.stringify({ command: "sendCommand", args: ["recordClip"] }));
      console.log("[bridge] AI-triggered clip requested");
    }
  } catch {
    // Network hiccup - just try again next tick.
  }
}, 5000);
