// Speech to text with Muse Voice Transcribe (realtime websocket, wss://api.meta.ai/v1/asr/realtime).
// Protocol (from Meta's realtime speech-to-text API): a JSON handshake frame carrying the key, binary PCM16 mono frames,
// {"type":"endStream"}, then server events. Any audio format ffmpeg can read is accepted; it is converted first.
//
// transcribe(buffer) -> { text, audioMs, ms }       (throws Error with a readable message; the key is never in a message or log)

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { noopTelemetry } from "./telemetry.js";

export const WS_URL = "wss://api.meta.ai/v1/asr/realtime";
const RATE = 16000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Any audio (webm, ogg, mp4, wav, mp3 ...) -> raw PCM16 mono 16 kHz. Goes through a temp file: mp4 cannot be read from a pipe. */
export async function toPcm(buffer, { ffmpeg = "ffmpeg", maxSeconds }) {
  const file = path.join(os.tmpdir(), `agent-audio-${randomUUID()}`);
  await fs.writeFile(file, buffer);
  try {
    return await new Promise((resolve, reject) => {
      const p = spawn(ffmpeg, ["-v", "error", "-i", file, "-t", String(maxSeconds), "-vn", "-ac", "1", "-ar", String(RATE), "-f", "s16le", "pipe:1"]);
      const out = [];
      let err = "";
      p.stdout.on("data", (c) => out.push(c));
      p.stderr.on("data", (c) => (err += c));
      p.on("error", (e) => reject(new Error(e.code === "ENOENT" ? "ffmpeg is not installed, so audio cannot be converted." : e.message)));
      p.on("close", (code) => {
        const pcm = Buffer.concat(out);
        if (code !== 0 || pcm.length === 0) reject(new Error(`That audio could not be read${err ? `: ${err.trim().split("\n").pop()}` : "."}`));
        else resolve(pcm);
      });
    });
  } finally {
    await fs.rm(file, { force: true });
  }
}

/** The text of the finished turns in a list of server events. */
export function textFromEvents(events) {
  const turns = events.filter((d) => d?.type === "speechComplete" && d.transcript?.trim()).map((d) => d.transcript.trim());
  if (turns.length) return turns.join(" ");
  const finals = events.filter((d) => d?.type === "transcript" && d.final && d.transcript?.trim());
  return finals.map((d) => d.transcript.trim()).join(" ");
}

/** @param {{ apiKey: string, config: object, telemetry?: object, wsFactory?: (url: string) => WebSocket }} opts config = config.audio */
export function createTranscriber({ apiKey, config, telemetry = noopTelemetry, wsFactory = (url) => new WebSocket(url) }) {
  async function transcribePcm(pcm) {
    const events = [];
    const ws = wsFactory(`${WS_URL}?sessionId=stream-${randomUUID()}`);
    ws.binaryType = "arraybuffer";
    let closed = false;
    let ack;
    let processedMs = 0;
    let last = performance.now();
    let wake;
    ws.addEventListener("message", (e) => {
      last = performance.now();
      if (typeof e.data !== "string") return;
      let d;
      try {
        d = JSON.parse(e.data);
      } catch {
        return;
      }
      if (typeof d?.audioProcessedMs === "number" && d.audioProcessedMs > processedMs) processedMs = d.audioProcessedMs;
      if (!ack && d && typeof d === "object") {
        ack = d;
        wake?.();
      }
      events.push(d);
    });
    ws.addEventListener("close", () => {
      closed = true;
      wake?.();
    });
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("Could not reach the speech service.")), { once: true });
    });
    ws.send(JSON.stringify({ authorization: { accessToken: `Bearer ${apiKey}` }, audioEncoding: "PCM_16KHZ", model: config.model, mode: config.mode, partialMode: "CUMULATIVE", emitAudioProgress: true }));
    await Promise.race([new Promise((r) => (wake = r)), sleep(10_000)]);
    if (!ack?.sessionId) {
      ws.close();
      throw new Error(`The speech service did not accept the request${ack?.error?.message ? `: ${ack.error.message}` : ack ? "." : " (no reply in 10 s)."}`);
    }
    const bytesPerMs = (RATE * 2) / 1000;
    const chunk = Math.round(bytesPerMs * 100) & ~1;
    let sent = 0;
    while (sent < pcm.length && !closed) {
      // Never run more than maxAheadS ahead of what the service reports as processed (it rejects a large backlog).
      while (!closed && sent / bytesPerMs - processedMs > config.maxAheadS * 1000) await sleep(20);
      ws.send(pcm.subarray(sent, sent + chunk));
      sent = Math.min(pcm.length, sent + chunk);
      if ((sent / chunk) % 50 === 0) await sleep(0);
    }
    if (!closed) ws.send(JSON.stringify({ type: "endStream" }));
    last = performance.now();
    const started = performance.now();
    while (!closed && performance.now() - last < config.idleMs && performance.now() - started < config.timeoutMs) await sleep(50);
    if (!closed) ws.close();
    return events;
  }

  return {
    async transcribe(buffer, ctx = {}) {
      const started = telemetry.now();
      try {
        const pcm = await toPcm(buffer, { ffmpeg: config.ffmpeg, maxSeconds: config.maxSeconds });
        const audioMs = Math.round(pcm.length / ((RATE * 2) / 1000));
        const events = await transcribePcm(pcm);
        const text = textFromEvents(events);
        telemetry.event("transcribe", { ms: telemetry.now() - started, audio_ms: audioMs, chars: text.length, frames: events.length }, ctx);
        return { text, audioMs, ms: telemetry.now() - started };
      } catch (err) {
        telemetry.event("transcribe_error", { ms: telemetry.now() - started, error: { name: err?.name, message: err?.message } }, ctx);
        throw err;
      }
    },
  };
}
