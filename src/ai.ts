export interface DetectionWindow {
  streamId: string;
  windowStart: number;
  windowEnd: number;
  transcript: string;
  frameCaption: string | null;
  chatExcerpt: string; // recent chat text, system events already filtered/labeled
}

export interface HighlightJudgment {
  isHighlight: boolean;
  confidence: number; // 0-1
  reason: string;
}

/** Transcribe a chunk of raw audio (MPEG-TS bytes are fine - Whisper decodes the container). */
export async function transcribeAudio(ai: Ai, audio: Uint8Array): Promise<string> {
  const response = await ai.run("@cf/openai/whisper-large-v3-turbo", {
    audio: [...audio],
  });
  return (response as any).text ?? "";
}

/** Caption a single still frame (JPEG bytes from Media Transformations' frame mode). */
export async function captionFrame(ai: Ai, frameJpeg: Uint8Array): Promise<string> {
  const response = await ai.run("@cf/unum/uform-gen2-qwen-500m", {
    image: [...frameJpeg],
    prompt:
      "Describe what's happening on screen in one short sentence, focused on anything visually notable (a big UI change, a death/victory screen, a dramatic action).",
    max_tokens: 100,
  });
  return (response as any).description ?? "";
}

/**
 * Ask a text model whether this window looks like a highlight, given
 * everything we know about it. Chat is passed as *context*, not a
 * trigger - the prompt explicitly tells the model to discount
 * raids/sub-trains/gift bombs, which are pre-labeled as system events
 * before they ever reach this function.
 */
export async function judgeHighlight(
  ai: Ai,
  window: DetectionWindow
): Promise<HighlightJudgment> {
  const prompt = `You are screening a small window of a live stream to decide if it's worth flagging as a highlight for the streamer to review later.

Transcript (speech during this window): ${window.transcript || "(silence / no speech detected)"}

On-screen description: ${window.frameCaption || "(not available)"}

Chat during this window (system events like raids/sub-trains/gift-bombs are already labeled - do NOT treat those as genuine reactions):
${window.chatExcerpt || "(no chat activity)"}

Decide if something genuinely highlight-worthy happened - a funny moment, a skilled play, a big reaction, a surprising turn, something visually striking. Ignore routine gameplay, ignore raid/gift-train noise, ignore silence with nothing notable on screen.

Respond with ONLY a JSON object, no other text:
{"isHighlight": boolean, "confidence": number between 0 and 1, "reason": "one short sentence"}`;

  const response = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [{ role: "user", content: prompt }],
  });

  const raw = (response as any).response ?? "{}";
  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      isHighlight: !!parsed.isHighlight,
      confidence: Number(parsed.confidence) || 0,
      reason: String(parsed.reason ?? ""),
    };
  } catch {
    // If the model didn't return clean JSON, fail safe: don't flag it.
    return { isHighlight: false, confidence: 0, reason: "unparsable model output" };
  }
}
