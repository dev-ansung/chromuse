// Entry point for `langgraph dev` (graph "documents" in langgraph.json): the web app's no-model way to list, read, save and restore
// documents, so the user's edits go through the same writer as the agent's (versions, conflicts, attribution, telemetry).

import { buildConfig } from "./config.js";
import { createDocumentsGraph } from "./documents-run.js";
import { sharedDocuments, sharedPlaybooks, sharedRuntime } from "./shared.js";

const { config, templates } = buildConfig({ requireKey: false });
const { telemetry } = sharedRuntime(config);

export const graph = createDocumentsGraph({ documents: sharedDocuments(config, telemetry, templates), playbooks: config.playbooks.enabled ? sharedPlaybooks(config, telemetry) : undefined, defaultUserId: config.memory.userId, telemetry });
