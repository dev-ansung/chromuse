// What the Documents panel does: open, edit, save, resolve a conflict, restore, and react to the agent's changes.
// The API and the state are injected, so every flow is testable without a server.

import type { CustomEvent } from "./agent-events.ts";
import type { DocumentsAction, DocumentsState, Notice } from "./documents-state.ts";
import { canUndoNotice, isDirty } from "./documents-state.ts";
import type { DocumentsApi } from "./documents-api.ts";
import { describeError } from "./parse.ts";

export const DEFAULT_FILE = "SOUL.md";

export type ControllerDeps = {
  api: DocumentsApi;
  dispatch(action: DocumentsAction): void;
  getState(): DocumentsState;
  newId?: () => string;
  now?: () => string;
};

export function createDocumentsController({ api, dispatch, getState, newId = () => crypto.randomUUID(), now = () => new Date().toISOString() }: ControllerDeps) {
  const fail = (err: unknown) => dispatch({ type: "failed", message: describeError(err) });

  async function loadOpenFile(path: string) {
    const outcome = await api.read(path);
    if (outcome.kind !== "ok") return dispatch({ type: "failed", message: outcome.kind === "error" ? outcome.message : "The file changed while it was loading. Try again." });
    dispatch({ type: "doc_loaded", doc: outcome.doc, history: await api.history(path) });
  }

  const controller = {
    /** The first load: the file list, and the default file open. */
    async load() {
      try {
        dispatch({ type: "files_loaded", files: await api.list() });
        if (!getState().path) await controller.open(DEFAULT_FILE);
      } catch (err) {
        fail(err);
      }
    },

    async open(path: string) {
      dispatch({ type: "opening", path });
      try {
        await loadOpenFile(path);
      } catch (err) {
        fail(err);
      }
    },

    edit(text: string) {
      dispatch({ type: "draft_changed", text });
    },

    revertDraft() {
      const { doc } = getState();
      if (doc) dispatch({ type: "draft_changed", text: doc.content });
    },

    /** Saves the editor text, based on the version that was opened. A stale save is refused and surfaces as a conflict. */
    async save() {
      const { path, doc, draft } = getState();
      if (!path || !doc) return;
      await controller.saveAs(path, draft, doc.version);
    },

    /** The user chose "keep mine" in a conflict: save the editor text over whatever is there now. */
    async keepMine() {
      const { path, draft } = getState();
      if (!path) return;
      await controller.saveAs(path, draft, undefined);
    },

    /** The user chose "take theirs": discard the editor text and show the file as it is now. */
    async takeTheirs() {
      const { path, conflict } = getState();
      if (!path || !conflict) return;
      try {
        dispatch({ type: "doc_loaded", doc: conflict.current, history: await api.history(path) });
      } catch (err) {
        fail(err);
      }
    },

    cancelConflict() {
      dispatch({ type: "conflict_cleared" });
    },

    async saveAs(path: string, content: string, expectedVersion: number | undefined) {
      dispatch({ type: "saving" });
      try {
        const outcome = await api.save(path, content, expectedVersion);
        if (outcome.kind === "conflict") return dispatch({ type: "conflict", conflict: { current: outcome.current, diff: outcome.diff } });
        if (outcome.kind === "error") return dispatch({ type: "failed", message: outcome.message });
        dispatch({ type: "saved", doc: outcome.doc, warnings: outcome.warnings });
        dispatch({ type: "history_loaded", versions: await api.history(path) });
      } catch (err) {
        fail(err);
      }
    },

    /** Writes an old version of the open file back as a new version. Only offered when there are no unsaved edits. */
    async restore(toVersion: number) {
      const { path } = getState();
      if (!path) return;
      dispatch({ type: "saving" });
      try {
        const outcome = await api.restore(path, toVersion);
        if (outcome.kind !== "ok") return dispatch({ type: "failed", message: outcome.kind === "error" ? outcome.message : "The file changed. Try again." });
        dispatch({ type: "doc_loaded", doc: outcome.doc, history: await api.history(path) });
      } catch (err) {
        fail(err);
      }
    },

    /** The agent changed one of its documents (a stream event): note it, and refresh the open file when there is nothing to lose. */
    async onAgentChange(event: Extract<CustomEvent, { kind: "memory_change" }>) {
      const notice: Notice = { id: newId(), path: event.path, version: event.version, added: event.added, removed: event.removed, soul: event.soul, at: now() };
      const before = getState();
      dispatch({ type: "agent_changed", notice });
      try {
        if (!before.files.some((f) => f.path === event.path)) dispatch({ type: "files_loaded", files: await api.list() });
        if (before.path === event.path && !isDirty(before)) await loadOpenFile(event.path);
      } catch (err) {
        fail(err);
      }
    },

    /** Undo the agent's change by restoring the version before it, only while that change is still the latest. */
    async undoNotice(notice: Notice) {
      if (!canUndoNotice(getState(), notice)) return;
      try {
        const outcome = await api.restore(notice.path, notice.version - 1);
        if (outcome.kind !== "ok") return dispatch({ type: "failed", message: outcome.kind === "error" ? outcome.message : "The file changed. Try again." });
        dispatch({ type: "notice_dismissed", id: notice.id });
        dispatch({ type: "files_loaded", files: await api.list() });
        if (getState().path === notice.path && !isDirty(getState())) await loadOpenFile(notice.path);
      } catch (err) {
        fail(err);
      }
    },

    dismissNotice(id: string) {
      dispatch({ type: "notice_dismissed", id });
    },
  };
  return controller;
}
