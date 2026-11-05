// A graph with no model: attaches to the browser and returns the open tabs. The web app runs it on page load
// (and on Refresh) so tabs are visible before any inference. It never throws: failures become state the UI can show.

import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import { noopTelemetry } from "./telemetry.js";
import { tabSchema } from "./tabs.js";

export function createConnectGraph({ session, telemetry = noopTelemetry }) {
  const State = new StateSchema({
    status: z.enum(["idle", "connected", "error"]).default("idle"),
    tabs: z.array(tabSchema).default(() => []),
    error: z.string().optional(),
    hint: z.string().optional(),
  });

  return new StateGraph(State)
    .addNode("attach", async () => {
      const started = telemetry.now();
      try {
        const tabs = await session.listTabs();
        telemetry.event("connect", { status: "connected", ms: telemetry.now() - started, count: tabs.length });
        return { status: "connected", tabs, error: undefined, hint: undefined };
      } catch (err) {
        const error = err?.detail ?? err?.message ?? String(err);
        telemetry.event("connect", { status: "error", ms: telemetry.now() - started, error, hint: err?.hint });
        return { status: "error", tabs: [], error, hint: err?.hint };
      }
    })
    .addEdge(START, "attach")
    .addEdge("attach", END)
    .compile();
}
