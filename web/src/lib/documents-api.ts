// The "documents" graph as a typed API. `callGraph` runs one operation and returns the graph's `result`.

import type { DocMeta, DocOutcome, Playbook, VersionMeta } from "./agent-events.ts";
import { parseDocOutcome, parseDone, parseFileList, parseHistory, parsePlaybooks } from "./parse.ts";

export type DocumentsApi = {
  list(): Promise<DocMeta[]>;
  read(path: string): Promise<DocOutcome>;
  /** `expectedVersion` undefined means "overwrite whatever is there" (the user chose "keep mine"). */
  save(path: string, content: string, expectedVersion?: number): Promise<DocOutcome>;
  history(path: string): Promise<VersionMeta[]>;
  restore(path: string, toVersion: number): Promise<DocOutcome>;
  playbooks(): Promise<Playbook[]>;
  deletePlaybook(id: string): Promise<void>;
};

export function createDocumentsApi(callGraph: (input: Record<string, unknown>) => Promise<unknown>): DocumentsApi {
  return {
    list: async () => parseFileList(await callGraph({ op: "list" })),
    read: async (path) => parseDocOutcome(await callGraph({ op: "read", path })),
    save: async (path, content, expectedVersion) => parseDocOutcome(await callGraph({ op: "save", path, content, ...(expectedVersion === undefined ? {} : { expectedVersion }) })),
    history: async (path) => parseHistory(await callGraph({ op: "history", path })),
    restore: async (path, toVersion) => parseDocOutcome(await callGraph({ op: "restore", path, toVersion })),
    playbooks: async () => parsePlaybooks(await callGraph({ op: "playbooks_list" })),
    deletePlaybook: async (id) => parseDone(await callGraph({ op: "playbook_delete", id })),
  };
}
