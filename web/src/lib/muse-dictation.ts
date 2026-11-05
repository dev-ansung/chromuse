// Voice input for the chat box: records from the microphone, and when it stops sends the recording to the server, which
// transcribes it with Muse Voice Transcribe. The text then goes into the composer like typed text.
// (The model takes no audio, so it is always turned into text first.)

import type { DictationAdapter } from "@assistant-ui/react";
import { describeError } from "./parse.ts";
import { transcribeAudio } from "./transcribe.ts";

type Callbacks<T> = Set<(value: T) => void>;

export class MuseDictationAdapter implements DictationAdapter {
  /** Called with a readable message when recording or transcription fails. */
  constructor(private readonly onError: (message: string) => void) {}

  listen(): DictationAdapter.Session {
    const speech: Callbacks<DictationAdapter.Result> = new Set();
    const speechEnd: Callbacks<DictationAdapter.Result> = new Set();
    const speechStart = new Set<() => void>();
    const chunks: Blob[] = [];
    let recorder: MediaRecorder | undefined;
    let stream: MediaStream | undefined;
    let cancelled = false;

    const session: DictationAdapter.Session = {
      status: { type: "starting" },
      onSpeech: (cb) => (speech.add(cb), () => speech.delete(cb)),
      onSpeechEnd: (cb) => (speechEnd.add(cb), () => speechEnd.delete(cb)),
      onSpeechStart: (cb) => (speechStart.add(cb), () => speechStart.delete(cb)),
      cancel: () => {
        cancelled = true;
        release();
        session.status = { type: "ended", reason: "cancelled" };
      },
      stop: async () => {
        if (!recorder || recorder.state === "inactive") return;
        const stopped = new Promise<void>((resolve) => recorder!.addEventListener("stop", () => resolve(), { once: true }));
        recorder.stop();
        await stopped;
        release();
        if (cancelled || chunks.length === 0) {
          session.status = { type: "ended", reason: "stopped" };
          return;
        }
        try {
          const transcript = (await transcribeAudio(new Blob(chunks, { type: recorder.mimeType }))).trim();
          if (transcript) {
            speech.forEach((cb) => cb({ transcript, isFinal: true }));
            speechEnd.forEach((cb) => cb({ transcript, isFinal: true }));
          } else this.onError("No speech was heard in the recording.");
          session.status = { type: "ended", reason: "stopped" };
        } catch (err) {
          this.onError(`Voice input failed: ${describeError(err)}`);
          session.status = { type: "ended", reason: "error" };
        }
      },
    };

    const release = () => stream?.getTracks().forEach((track) => track.stop());

    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((media) => {
        stream = media;
        if (cancelled) return release();
        recorder = new MediaRecorder(media);
        recorder.addEventListener("dataavailable", (e) => e.data.size > 0 && chunks.push(e.data));
        recorder.start();
        session.status = { type: "running" };
        speechStart.forEach((cb) => cb());
      })
      .catch((err) => {
        this.onError(`The microphone is not available: ${describeError(err)}`);
        session.status = { type: "ended", reason: "error" };
      });

    return session;
  }
}
