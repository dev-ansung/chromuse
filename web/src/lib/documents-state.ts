// State of the Documents panel (SOUL.md, MEMORY.md, notes) as a pure reducer. No React, no I/O.

import type { Diff, Doc, DocMeta, DocWarning, VersionMeta } from "./agent-events.ts";

/** A change the agent made to one of its documents. */
export type Notice = { id: string; path: string; version: number; added: number; removed: number; soul: boolean; at: string };

export type DocumentsState = {
  files: DocMeta[];
  /** The open file, the server's copy of it, and the text in the editor. */
  path: string | null;
  doc: Doc | null;
  draft: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  /** Warnings from the last save (a secret in the text, a file over the size limit). */
  warnings: DocWarning[];
  /** A save was refused because the agent changed the file after it was opened. Nothing was overwritten. */
  conflict: { current: Doc; diff: Diff } | null;
  /** The agent changed the open file while the user has unsaved edits. */
  changedUnderneath: boolean;
  history: VersionMeta[];
  notices: Notice[];
};

export type DocumentsAction =
  | { type: "files_loaded"; files: DocMeta[] }
  | { type: "opening"; path: string }
  | { type: "doc_loaded"; doc: Doc; history: VersionMeta[] }
  | { type: "history_loaded"; versions: VersionMeta[] }
  | { type: "draft_changed"; text: string }
  | { type: "saving" }
  | { type: "saved"; doc: Doc; warnings: DocWarning[] }
  | { type: "conflict"; conflict: { current: Doc; diff: Diff } }
  | { type: "conflict_cleared" }
  | { type: "failed"; message: string }
  | { type: "agent_changed"; notice: Notice }
  | { type: "notice_dismissed"; id: string };

export const MAX_NOTICES = 20;

export const initialDocumentsState: DocumentsState = {
  files: [],
  path: null,
  doc: null,
  draft: "",
  loading: false,
  saving: false,
  error: null,
  warnings: [],
  conflict: null,
  changedUnderneath: false,
  history: [],
  notices: [],
};

export const isDirty = (s: DocumentsState): boolean => s.doc !== null && s.draft !== s.doc.content;

/** Undo is offered only while the agent's change is still the latest, so it can never discard a later edit by the user. */
export const canUndoNotice = (s: DocumentsState, notice: Notice): boolean => s.files.find((f) => f.path === notice.path)?.version === notice.version;

const withMeta = (files: DocMeta[], doc: Doc): DocMeta[] => {
  const meta: DocMeta = { path: doc.path, version: doc.version, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy, chars: doc.content.length };
  return files.some((f) => f.path === doc.path) ? files.map((f) => (f.path === doc.path ? meta : f)) : [...files, meta];
};

export function reduceDocuments(state: DocumentsState, action: DocumentsAction): DocumentsState {
  switch (action.type) {
    case "files_loaded":
      return { ...state, files: action.files };
    case "opening":
      return { ...state, path: action.path, doc: null, draft: "", loading: true, error: null, warnings: [], conflict: null, changedUnderneath: false, history: [] };
    case "doc_loaded":
      return { ...state, doc: action.doc, draft: action.doc.content, loading: false, saving: false, error: null, conflict: null, changedUnderneath: false, history: action.history, files: withMeta(state.files, action.doc) };
    case "history_loaded":
      return { ...state, history: action.versions };
    case "draft_changed":
      return { ...state, draft: action.text };
    case "saving":
      return { ...state, saving: true, error: null };
    case "saved":
      return { ...state, doc: action.doc, draft: action.doc.content, saving: false, error: null, warnings: action.warnings, conflict: null, changedUnderneath: false, files: withMeta(state.files, action.doc) };
    case "conflict":
      return { ...state, saving: false, conflict: action.conflict };
    case "conflict_cleared":
      return { ...state, conflict: null };
    case "failed":
      return { ...state, loading: false, saving: false, error: action.message };
    case "agent_changed": {
      const { notice } = action;
      const files = state.files.map((f) => (f.path === notice.path ? { ...f, version: notice.version, updatedBy: "agent" } : f));
      return {
        ...state,
        files,
        notices: [notice, ...state.notices].slice(0, MAX_NOTICES),
        changedUnderneath: state.path === notice.path && isDirty(state) ? true : state.changedUnderneath,
      };
    }
    case "notice_dismissed":
      return { ...state, notices: state.notices.filter((n) => n.id !== action.id) };
  }
}
