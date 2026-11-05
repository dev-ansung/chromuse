// The "documents" graph: one node that performs a document operation for the user. No model. It never throws:
// every outcome, including errors, is returned as `result` (the shapes documents.js uses).
//
// input:  { op: "list" | "read" | "save" | "history" | "read_version" | "restore" | "playbooks_list" | "playbook_save" | "playbook_delete", path?, content?, expectedVersion?, version?, toVersion? }
// output: { result: ... }     the user's identity comes from config.configurable.user_id (default: the configured local user)

import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import { errorInfo, noopTelemetry } from "./telemetry.js";

export function createDocumentsGraph({ documents, playbooks, defaultUserId, telemetry = noopTelemetry, compile = {} }) {
  const State = new StateSchema({
    op: z.string(),
    path: z.string().optional(),
    content: z.string().optional(),
    expectedVersion: z.number().optional(),
    version: z.number().optional(),
    toVersion: z.number().optional(),
    id: z.string().optional(),
    playbook: z.record(z.string(), z.unknown()).optional(),
    result: z.unknown().optional(),
  });

  async function perform(state, store, uid) {
    switch (state.op) {
      case "list":
        return { ok: true, files: await documents.list(store, uid) };
      case "read":
        return documents.read(store, uid, state.path);
      case "save":
        return documents.save({ store, uid, path: state.path, content: state.content, expectedVersion: state.expectedVersion, by: "user" });
      case "history":
        return documents.isAllowedPath(state.path)
          ? { ok: true, versions: await documents.history(store, uid, state.path) }
          : { ok: false, error: { code: "unknown_path", message: `"${state.path}" is not a memory file.` } };
      case "read_version":
        return documents.readVersion(store, uid, state.path, state.version);
      case "restore":
        return documents.restore({ store, uid, path: state.path, toVersion: state.toVersion, by: "user" });
      case "playbooks_list":
        return playbooks ? { ok: true, playbooks: await playbooks.list(store, uid) } : { ok: true, playbooks: [] };
      case "playbook_save":
        return playbooks.save({ store, uid, input: { ...state.playbook, id: state.id }, by: "user" });
      case "playbook_delete":
        return playbooks.remove(store, uid, state.id);
      default:
        return { ok: false, error: { code: "unknown_op", message: `Unknown operation "${state.op}".` } };
    }
  }

  return new StateGraph(State)
    .addNode("run", async (state, config) => {
      try {
        if (!config?.store) return { result: { ok: false, error: { code: "no_store", message: "No store is available." } } };
        return { result: await perform(state, config.store, config.configurable?.user_id ?? defaultUserId) };
      } catch (err) {
        telemetry.event("memory_error", { phase: `documents:${state.op}`, error: errorInfo(err) }, {});
        return { result: { ok: false, error: { code: "internal", message: err?.message ?? String(err) } } };
      }
    })
    .addEdge(START, "run")
    .addEdge("run", END)
    .compile(compile);
}
