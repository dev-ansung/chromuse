// Validation of data arriving from the server. Pure functions: no React, no I/O.

import type { ConnectState, CustomEvent, Diff, DiffLine, Doc, DocMeta, DocOutcome, DocWarning, LiveFrame, LiveResponse, Playbook, Tab, VersionMeta } from "./agent-events.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function isTab(v: unknown): v is Tab {
  return (
    isRecord(v) &&
    typeof v.id === "number" &&
    typeof v.title === "string" &&
    typeof v.url === "string" &&
    typeof v.selected === "boolean"
  );
}

/** A readable message from whatever was thrown or reported. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (isRecord(err) && typeof err.message === "string") return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** A custom stream event from the agent, or undefined when it is not one of ours (it is then ignored). */
export function parseCustomEvent(type: string, data: unknown): CustomEvent | undefined {
  if (type !== "custom" || !isRecord(data)) return undefined;
  switch (data.kind) {
    case "tabs":
      return Array.isArray(data.tabs) && data.tabs.every(isTab) ? { kind: "tabs", tabs: data.tabs } : undefined;
    case "screenshot":
      return typeof data.tool === "string" && typeof data.callId === "string" && typeof data.mime === "string" && typeof data.data === "string"
        ? { kind: "screenshot", tool: data.tool, callId: data.callId, mime: data.mime, data: data.data }
        : undefined;
    case "warning":
      return typeof data.message === "string" ? { kind: "warning", message: data.message } : undefined;
    case "usage": {
      const n = (v: unknown) => (typeof v === "number" ? v : 0);
      return { kind: "usage", input: n(data.input), output: n(data.output), reasoning: n(data.reasoning), cached: n(data.cached) };
    }
    case "memory_change":
      return typeof data.path === "string" && typeof data.version === "number" && typeof data.added === "number" && typeof data.removed === "number" && typeof data.soul === "boolean"
        ? { kind: "memory_change", path: data.path, version: data.version, by: "agent", added: data.added, removed: data.removed, soul: data.soul }
        : undefined;
    default:
      return undefined;
  }
}

/** The final state of the connect graph. Throws when the server answered with something else. */
export function parseConnectState(values: unknown): ConnectState {
  if (!isRecord(values)) throw new Error("The connect graph returned no state.");
  const { status, tabs, error, hint } = values;
  if (status !== "connected" && status !== "error" && status !== "idle") throw new Error(`The connect graph returned an unknown status: ${String(status)}`);
  if (!Array.isArray(tabs) || !tabs.every(isTab)) throw new Error("The connect graph returned tabs in an unexpected shape.");
  return {
    status,
    tabs,
    ...(typeof error === "string" ? { error } : {}),
    ...(typeof hint === "string" ? { hint } : {}),
  };
}

function isFrame(v: unknown): v is LiveFrame {
  return (
    isRecord(v) &&
    typeof v.mime === "string" &&
    typeof v.data === "string" &&
    typeof v.pageId === "number" &&
    typeof v.url === "string" &&
    typeof v.title === "string" &&
    typeof v.takenAt === "string"
  );
}

/** The live view endpoint's answer. Throws when it is not one (for example an error page from a proxy). */
export function parseLiveResponse(value: unknown): LiveResponse {
  if (!isRecord(value)) throw new Error("The live view returned no data.");
  if (value.ok === false) {
    const error = value.error;
    if (!isRecord(error) || typeof error.message !== "string") throw new Error("The live view reported an error in an unexpected shape.");
    return { ok: false, error: { message: error.message, ...(typeof error.hint === "string" ? { hint: error.hint } : {}) } };
  }
  if (value.ok !== true) throw new Error("The live view returned an unexpected response.");
  const tabs = value.tabs;
  if (!Array.isArray(tabs) || !tabs.every(isTab)) throw new Error("The live view returned tabs in an unexpected shape.");
  if (value.frame !== null && !isFrame(value.frame)) throw new Error("The live view returned a screenshot in an unexpected shape.");
  return { ok: true, tabs, frame: value.frame as LiveFrame | null };
}

// ---- documents ----

const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

function toDoc(v: unknown): Doc {
  if (!isRecord(v) || typeof v.path !== "string" || typeof v.content !== "string" || typeof v.version !== "number") throw new Error("The server returned a document in an unexpected shape.");
  return {
    path: v.path,
    content: v.content,
    version: v.version,
    updatedAt: isStringOrNull(v.updatedAt) ? v.updatedAt : null,
    updatedBy: isStringOrNull(v.updatedBy) ? v.updatedBy : null,
    ...(typeof v.runId === "string" ? { runId: v.runId } : {}),
  };
}

function toDiff(v: unknown): Diff {
  if (!isRecord(v) || typeof v.added !== "number" || typeof v.removed !== "number" || !Array.isArray(v.lines)) throw new Error("The server returned a diff in an unexpected shape.");
  const lines: DiffLine[] = v.lines.map((l) => {
    if (!isRecord(l) || (l.op !== "+" && l.op !== "-" && l.op !== " ") || typeof l.text !== "string") throw new Error("The server returned a diff line in an unexpected shape.");
    return { op: l.op, text: l.text };
  });
  return { added: v.added, removed: v.removed, lines };
}

function toWarnings(v: unknown): DocWarning[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error("The server returned warnings in an unexpected shape.");
  return v.map((w): DocWarning => {
    if (isRecord(w) && w.code === "secret" && Array.isArray(w.kinds)) return { code: "secret", kinds: w.kinds.map(String) };
    if (isRecord(w) && w.code === "too_large" && typeof w.chars === "number" && typeof w.max === "number") return { code: "too_large", chars: w.chars, max: w.max };
    throw new Error("The server returned a warning in an unexpected shape.");
  });
}

function toError(v: unknown): { code: string; message: string } {
  if (!isRecord(v) || typeof v.message !== "string") throw new Error("The server reported an error in an unexpected shape.");
  return { code: typeof v.code === "string" ? v.code : "error", message: v.message };
}

/** The `result` of a read, save or restore. */
export function parseDocOutcome(result: unknown): DocOutcome {
  if (!isRecord(result)) throw new Error("The documents graph returned no result.");
  if (result.ok === true) {
    return { kind: "ok", doc: toDoc(result.doc), diff: result.diff === undefined ? null : toDiff(result.diff), warnings: toWarnings(result.warnings), unchanged: result.unchanged === true };
  }
  if (isRecord(result.conflict)) return { kind: "conflict", current: toDoc(result.conflict.current), diff: toDiff(result.conflict.diff) };
  return { kind: "error", ...toError(result.error) };
}

/** The `result` of a list. Throws when it is an error or malformed. */
export function parseFileList(result: unknown): DocMeta[] {
  if (!isRecord(result)) throw new Error("The documents graph returned no result.");
  if (result.ok !== true) throw new Error(toError(result.error).message);
  if (!Array.isArray(result.files)) throw new Error("The server returned the file list in an unexpected shape.");
  return result.files.map((f) => {
    if (!isRecord(f) || typeof f.path !== "string" || typeof f.version !== "number") throw new Error("The server returned a file entry in an unexpected shape.");
    return { path: f.path, version: f.version, updatedAt: isStringOrNull(f.updatedAt) ? f.updatedAt : null, updatedBy: isStringOrNull(f.updatedBy) ? f.updatedBy : null, chars: typeof f.chars === "number" ? f.chars : 0 };
  });
}

/** The `result` of a history request. Throws when it is an error or malformed. */
export function parseHistory(result: unknown): VersionMeta[] {
  if (!isRecord(result)) throw new Error("The documents graph returned no result.");
  if (result.ok !== true) throw new Error(toError(result.error).message);
  if (!Array.isArray(result.versions)) throw new Error("The server returned the history in an unexpected shape.");
  return result.versions.map((v) => {
    if (!isRecord(v) || typeof v.path !== "string" || typeof v.version !== "number" || typeof v.updatedBy !== "string" || typeof v.updatedAt !== "string") {
      throw new Error("The server returned a version in an unexpected shape.");
    }
    return {
      path: v.path, version: v.version, updatedBy: v.updatedBy, updatedAt: v.updatedAt,
      added: typeof v.added === "number" ? v.added : 0, removed: typeof v.removed === "number" ? v.removed : 0, chars: typeof v.chars === "number" ? v.chars : 0,
      ...(typeof v.undoOf === "number" ? { undoOf: v.undoOf } : {}), ...(typeof v.runId === "string" ? { runId: v.runId } : {}),
    };
  });
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The `result` of a playbooks_list request. Throws when it is an error or malformed. */
export function parsePlaybooks(result: unknown): Playbook[] {
  if (!isRecord(result)) throw new Error("The documents graph returned no result.");
  if (result.ok !== true) throw new Error(toError(result.error).message);
  if (!Array.isArray(result.playbooks)) throw new Error("The server returned the playbooks in an unexpected shape.");
  return result.playbooks.map((p) => {
    if (!isRecord(p) || typeof p.id !== "string" || typeof p.title !== "string" || typeof p.situation !== "string") throw new Error("The server returned a playbook in an unexpected shape.");
    const count = (v: unknown) => (typeof v === "number" ? v : 0);
    return {
      id: p.id,
      title: p.title,
      situation: p.situation,
      hosts: strings(p.hosts),
      steps: strings(p.steps),
      pitfalls: strings(p.pitfalls),
      uses: count(p.uses),
      worked: count(p.worked),
      failed: count(p.failed),
      updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : "",
      lastUsedAt: isStringOrNull(p.lastUsedAt) ? p.lastUsedAt : null,
      by: typeof p.by === "string" ? p.by : "agent",
    };
  });
}

/** The `result` of an operation that returns nothing but success. Throws on an error. */
export function parseDone(result: unknown): void {
  if (!isRecord(result)) throw new Error("The documents graph returned no result.");
  if (result.ok !== true) throw new Error(toError(result.error).message);
}

/** The body of the transcription route: the text, or an Error carrying the server's message. */
export function parseTranscript(status: number, body: unknown): string {
  if (isRecord(body) && body.ok === true && typeof body.text === "string") return body.text;
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") throw new Error(body.error.message);
  throw new Error(`The server answered HTTP ${status} without a transcript. Is it running?`);
}
