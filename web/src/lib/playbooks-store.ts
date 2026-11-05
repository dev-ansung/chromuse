// The playbooks list: loaded from the "documents" graph, with delete. Observable so the panel re-renders.

import { useSyncExternalStore } from "react";
import type { Playbook } from "./agent-events.ts";
import { documentsApi } from "./documents.ts";
import { describeError } from "./parse.ts";

export type PlaybooksState = { status: "idle" | "loading" | "ready" | "error"; items: Playbook[]; error?: string };

let state: PlaybooksState = { status: "idle", items: [] };
const listeners = new Set<() => void>();
const set = (next: PlaybooksState) => {
  state = next;
  listeners.forEach((listener) => listener());
};

export async function loadPlaybooks() {
  set({ ...state, status: "loading", error: undefined });
  try {
    set({ status: "ready", items: await documentsApi.playbooks() });
  } catch (err) {
    set({ ...state, status: "error", error: describeError(err) });
  }
}

export async function deletePlaybook(id: string) {
  try {
    await documentsApi.deletePlaybook(id);
    set({ ...state, items: state.items.filter((p) => p.id !== id) });
  } catch (err) {
    set({ ...state, status: "error", error: describeError(err) });
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const usePlaybooksState = (): PlaybooksState => useSyncExternalStore(subscribe, () => state);
