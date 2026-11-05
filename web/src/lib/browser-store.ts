// Observable holder for BrowserState (the reducer lives in browser-state.ts). The panels read it; nothing else writes it.

import { useSyncExternalStore } from "react";
import { initialBrowserState, reduceBrowser, type BrowserAction, type BrowserState } from "./browser-state.ts";

let state: BrowserState = initialBrowserState;
const listeners = new Set<() => void>();

export const getBrowserState = (): BrowserState => state;

export function dispatch(action: BrowserAction) {
  state = reduceBrowser(state, action);
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useBrowserState = (): BrowserState => useSyncExternalStore(subscribe, () => state);
