// Speech to text through the agent server (POST /audio/transcribe, which uses Muse Voice Transcribe).

import { APP_CONFIG } from "./app-config.ts";
import { parseTranscript } from "./parse.ts";

type FetchLike = (url: string, init: { method: "POST"; headers: Record<string, string>; body: Blob }) => Promise<{ status: number; json(): Promise<unknown> }>;

/** The words spoken in the audio. Throws an Error with a readable message when it cannot be transcribed. */
export async function transcribeAudio(audio: Blob, fetchImpl: FetchLike = fetch): Promise<string> {
  const response = await fetchImpl(`${APP_CONFIG.apiPath}/audio/transcribe`, {
    method: "POST",
    headers: { "Content-Type": audio.type || "application/octet-stream" },
    body: audio,
  });
  const body = await response.json().catch(() => undefined);
  return parseTranscript(response.status, body);
}
