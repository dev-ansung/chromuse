// The data the agent server sends beside the chat messages. Mirrors server/src/agent.js and server/src/connect.js.

export type Tab = {
  id: number;
  title: string;
  url: string;
  selected: boolean;
  isolatedContext?: string;
};

/** Custom stream events from the agent: the tabs it read, a screenshot after a page-changing step, warnings, and changes to its documents. */
export type CustomEvent =
  | { kind: "tabs"; tabs: Tab[] }
  | { kind: "screenshot"; tool: string; callId: string; mime: string; data: string }
  | { kind: "warning"; message: string }
  | { kind: "usage"; input: number; output: number; reasoning: number; cached: number }
  | { kind: "memory_change"; path: string; version: number; by: "agent"; added: number; removed: number; soul: boolean };

/** One screenshot of the selected tab, from the camera button's endpoint (GET /live/snapshot). */
export type LiveFrame = { mime: string; data: string; pageId: number; url: string; title: string; takenAt: string };

/** Response of GET /live/snapshot (server/src/live.js). */
export type LiveResponse =
  | { ok: true; tabs: Tab[]; frame: LiveFrame | null }
  | { ok: false; error: { message: string; hint?: string } };

/** Final state of the no-model "connect" graph. */
export type ConnectState = {
  status: "idle" | "connected" | "error";
  tabs: Tab[];
  error?: string;
  hint?: string;
};

// ---- documents (SOUL.md, MEMORY.md, notes): what the "documents" graph returns (server/src/documents.js) ----

export type DocMeta = { path: string; version: number; updatedAt: string | null; updatedBy: string | null; chars: number };
export type Doc = { path: string; content: string; version: number; updatedAt: string | null; updatedBy: string | null; runId?: string };
export type DiffLine = { op: "+" | "-" | " "; text: string };
export type Diff = { added: number; removed: number; lines: DiffLine[] };
export type VersionMeta = { path: string; version: number; updatedBy: string; updatedAt: string; added: number; removed: number; chars: number; undoOf?: number; runId?: string };
export type DocWarning = { code: "secret"; kinds: string[] } | { code: "too_large"; chars: number; max: number };

/** A document operation's outcome: it worked, the save was based on an out-of-date version, or it failed. */
export type DocOutcome =
  | { kind: "ok"; doc: Doc; diff: Diff | null; warnings: DocWarning[]; unchanged: boolean }
  | { kind: "conflict"; current: Doc; diff: Diff }
  | { kind: "error"; code: string; message: string };

// ---- playbooks: how the agent solved tasks before (server/src/playbooks.js) ----

export type Playbook = {
  id: string;
  title: string;
  situation: string;
  hosts: string[];
  steps: string[];
  pitfalls: string[];
  uses: number;
  worked: number;
  failed: number;
  updatedAt: string;
  lastUsedAt: string | null;
  by: string;
};
