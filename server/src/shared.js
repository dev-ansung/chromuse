// The telemetry and browser session shared by everything the server loads (the graphs and the live-view routes).

import path from "node:path";
import { sharedBrowserSession } from "./browser.js";
import { createDocuments } from "./documents.js";
import { createEmbedder } from "./embeddings.js";
import { createPlaybooks } from "./playbooks.js";
import { sharedTelemetry } from "./telemetry.js";

export function sharedRuntime(config) {
  const telemetry = sharedTelemetry(config);
  const session = sharedBrowserSession(config, telemetry.dir ? { logFile: path.join(telemetry.dir, "chrome-devtools-mcp.log") } : undefined);
  return { telemetry, session };
}

/** One documents instance per process, so the agent's and the user's writes share the same per-file locks. */
export function sharedDocuments(config, telemetry, templates) {
  globalThis.__agentAppDocuments ??= createDocuments({ templates, telemetry, limits: config.memory.limits });
  return globalThis.__agentAppDocuments;
}

/** One playbooks instance (and one loaded embedding model) per process. */
export function sharedPlaybooks(config, telemetry) {
  globalThis.__agentAppPlaybooks ??= createPlaybooks({
    embedder: createEmbedder({ model: config.playbooks.embeddingModel, dtype: config.playbooks.embeddingDtype }),
    telemetry,
    limits: config.playbooks,
  });
  return globalThis.__agentAppPlaybooks;
}
