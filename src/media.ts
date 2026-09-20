/**
 * Wraps the Media Transformations binding for the one thing we need:
 * given a short (well under the 10-min/100MB limit) raw video chunk,
 * pull a single JPEG frame out of it to hand to a vision model.
 */
export async function extractFrame(
  media: MediaBinding,
  videoChunk: Uint8Array,
  atSeconds: number = 0
): Promise<Uint8Array> {
  const result = media
    .input(new Blob([videoChunk]).stream())
    .transform({ width: 640 })
    .output({ mode: "frame", time: `${atSeconds}s`, format: "jpg" });

  const buf = await (await result.response()).arrayBuffer();
  return new Uint8Array(buf);
}

// Minimal local type - replace with the generated Cloudflare Workers
// types once `wrangler types` has been run against your account.
export interface MediaBinding {
  input(stream: ReadableStream): {
    transform(opts: { width?: number; height?: number }): {
      output(opts: {
        mode: "video" | "frame" | "spritesheet" | "audio";
        time?: string;
        duration?: string;
        format?: string;
      }): { response(): Promise<Response> };
    };
  };
}
