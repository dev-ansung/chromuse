// HTTP route for speech to text. Mounted by the LangGraph dev server next to its own API (see app.js).
//   POST /audio/transcribe    body = the audio bytes (any format ffmpeg reads)  ->  { ok: true, text, audioMs } | { ok: false, error: { message } }

import { Hono } from "hono";

export function createAudioApp({ transcriber, maxBytes }) {
  const app = new Hono();
  const fail = (c, status, message) => c.json({ ok: false, error: { message } }, status);

  app.post("/audio/transcribe", async (c) => {
    if (!transcriber) return fail(c, 503, "Speech to text is not available: it is switched off or its API key is not set.");
    const body = Buffer.from(await c.req.arrayBuffer());
    if (body.length === 0) return fail(c, 400, "No audio was sent.");
    if (body.length > maxBytes) return fail(c, 413, `That audio is larger than ${Math.round(maxBytes / 1e6)} MB.`);
    try {
      const { text, audioMs } = await transcriber.transcribe(body);
      c.header("Cache-Control", "no-store");
      return c.json({ ok: true, text, audioMs });
    } catch (err) {
      return fail(c, 502, err?.message ?? String(err));
    }
  });
  return app;
}
