// Observable holder for DocumentsState (the reducer lives in documents-state.ts). The Documents panel reads it.

import { useSyncExternalStore } from "react";
import { initialDocumentsState, reduceDocuments, type DocumentsAction, type DocumentsState } from "./documents-state.ts";

let state: DocumentsState = initialDocumentsState;
const listeners = new Set<() => void>();

export const getDocumentsState = (): DocumentsState => state;

export function dispatchDocuments(action: DocumentsAction) {
  state = reduceDocuments(state, action);
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useDocumentsState = (): DocumentsState => useSyncExternalStore(subscribe, () => state);
