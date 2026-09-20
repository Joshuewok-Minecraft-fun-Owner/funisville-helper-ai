/**
 * Twitch integration helpers.
 *
 * Two kinds of API here, worth knowing apart:
 *
 * 1. Official Twitch API (Helix + EventSub) - documented, stable,
 *    used for "did the stream start/end" and reading chat via IRC.
 *
 * 2. The GQL access-token + usher HLS flow below - this is the same
 *    internal mechanism Twitch's own web player (and tools like
 *    streamlink/yt-dlp) use to fetch playable video/audio. It's not
 *    a published, versioned API, so it can change without notice.
 *    We're only ever using it to read our own public broadcast, but
 *    flag this clearly since it's the one "unofficial" piece here.
 */

const GQL_ENDPOINT = "https://gql.twitch.tv/gql";
// Twitch's public web client ID, used by the website itself for this
// exact flow. Not a secret - this is what makes the token request work.
const GQL_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

interface PlaybackAccessToken {
  value: string;
  signature: string;
}

async function getLivePlaybackToken(channel: string): Promise<PlaybackAccessToken> {
  const query = {
    operationName: "PlaybackAccessToken",
    variables: {
      isLive: true,
      login: channel,
      isVod: false,
      vodID: "",
      playerType: "site",
    },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash:
          "0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712",
      },
    },
  };

  const res = await fetch(GQL_ENDPOINT, {
    method: "POST",
    headers: { "Client-ID": GQL_CLIENT_ID, "Content-Type": "application/json" },
    body: JSON.stringify(query),
  });

  if (!res.ok) {
    throw new Error(`Twitch GQL token request failed: ${res.status}`);
  }

  const json = await res.json<any>();
  const token = json?.data?.streamPlaybackAccessToken;
  if (!token) throw new Error("Twitch GQL response missing playback token");
  return { value: token.value, signature: token.signature };
}

interface HlsVariant {
  name: string; // e.g. "Source", "720p60", "Audio Only"
  url: string;
}

/** Parse a master m3u8 playlist into its named variants. */
function parseMasterPlaylist(text: string): HlsVariant[] {
  const lines = text.split("\n");
  const variants: HlsVariant[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-MEDIA") && line.includes("NAME=")) {
      const nameMatch = line.match(/NAME="([^"]+)"/);
      const uriMatch = line.match(/URI="([^"]+)"/);
      if (nameMatch && uriMatch) {
        variants.push({ name: nameMatch[1], url: uriMatch[1] });
      }
    }
  }
  return variants;
}

/**
 * Fetch the live HLS master playlist for a channel and return its
 * variants (this is where "Audio Only" shows up if Twitch is
 * currently offering it for this broadcast).
 */
export async function getLiveHlsVariants(channel: string): Promise<HlsVariant[]> {
  const token = await getLivePlaybackToken(channel);
  const params = new URLSearchParams({
    client_id: GQL_CLIENT_ID,
    token: token.value,
    sig: token.signature,
    allow_source: "true",
    allow_audio_only: "true",
    fast_bread: "true",
  });
  const url = `https://usher.ttvnw.net/api/channel/hls/${channel}.m3u8?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Usher playlist fetch failed: ${res.status}`);
  return parseMasterPlaylist(await res.text());
}

interface Segment {
  url: string;
  durationSeconds: number;
}

/** Parse a media playlist (list of .ts segments) into segment URLs. */
function parseMediaPlaylist(text: string, baseUrl: string): Segment[] {
  const lines = text.split("\n");
  const segments: Segment[] = [];
  let nextDuration = 0;
  const base = baseUrl.slice(0, baseUrl.lastIndexOf("/") + 1);
  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      nextDuration = parseFloat(line.slice(8).split(",")[0]);
    } else if (line && !line.startsWith("#")) {
      const url = line.startsWith("http") ? line : base + line;
      segments.push({ url, durationSeconds: nextDuration });
    }
  }
  return segments;
}

/**
 * Grab roughly the last `windowSeconds` of segments from a variant's
 * live media playlist. Used for the rolling ~20-30s detection loop -
 * each call re-fetches the (short) live playlist and returns only the
 * newest segments, so we're never pulling more than one small window
 * of data at a time.
 */
export async function fetchRecentSegments(
  variantUrl: string,
  windowSeconds: number
): Promise<Uint8Array[]> {
  const res = await fetch(variantUrl);
  if (!res.ok) throw new Error(`Media playlist fetch failed: ${res.status}`);
  const playlist = parseMediaPlaylist(await res.text(), variantUrl);

  let total = 0;
  const recent: Segment[] = [];
  for (let i = playlist.length - 1; i >= 0 && total < windowSeconds; i--) {
    recent.unshift(playlist[i]);
    total += playlist[i].durationSeconds;
  }

  const buffers = await Promise.all(
    recent.map(async (seg) => {
      const r = await fetch(seg.url);
      return new Uint8Array(await r.arrayBuffer());
    })
  );
  return buffers;
}

/** Concatenate raw .ts segment bytes - a legal, decodable MPEG-TS stream. */
export function concatSegments(segments: Uint8Array[]): Uint8Array {
  const total = segments.reduce((sum, s) => sum + s.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const seg of segments) {
    out.set(seg, offset);
    offset += seg.length;
  }
  return out;
}
