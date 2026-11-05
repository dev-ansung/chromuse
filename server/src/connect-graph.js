// Entry point for `langgraph dev` (graph "connect" in langgraph.json).

import { buildConfig } from "./config.js";
import { sharedRuntime } from "./shared.js";
import { createConnectGraph } from "./connect.js";

const { config } = buildConfig({ requireKey: false });

const { telemetry, session } = sharedRuntime(config);

export const graph = createConnectGraph({ session, telemetry });
