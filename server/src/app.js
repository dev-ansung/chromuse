// Entry point for the HTTP routes next to the LangGraph API (langgraph.json -> http.app = "./src/app.js:app"):
// the camera route (live view) and the speech-to-text route.

import { buildConfig } from "./config.js";
import { createLiveFeed } from "./live.js";
import { createLiveApp } from "./live-app.js";
import { createAudioApp } from "./audio-app.js";
import { sharedRuntime } from "./shared.js";
import { createTranscriber } from "./transcribe.js";

const { config } = buildConfig({ requireKey: false });
const { telemetry, session } = sharedRuntime(config);

const audioKey = process.env[config.audio.keyVar];
const transcriber = config.audio.enabled && audioKey ? createTranscriber({ apiKey: audioKey, config: config.audio, telemetry }) : undefined;

export const app = createLiveApp(createLiveFeed({ session, telemetry, screenshotEnabled: config.screenshot.enabled }));
app.route("/", createAudioApp({ transcriber, maxBytes: config.audio.maxBytes }));
