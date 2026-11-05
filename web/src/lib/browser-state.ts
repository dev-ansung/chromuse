// State of the browser connection and the live view, as a pure reducer. No React, no I/O.

import { APP_CONFIG } from "./app-config.ts";
import type { ConnectState, CustomEvent, LiveFrame, Tab } from "./agent-events.ts";

/** A screenshot in the history: taken after an agent step, or by the camera button. */
export type Frame = {
  mime: string;
  data: string;
  takenAt: string;
  source: { kind: "step"; tool: string; callId: string } | { kind: "camera"; pageId: number; url: string; title: string };
};

export type BrowserState = {
  connection: { status: "idle" | "connecting" | "connected" | "error"; error?: string; hint?: string };
  tabs: Tab[];
  /** Screenshots of the live view, oldest first (capped at APP_CONFIG.maxScreenshots). */
  frames: Frame[];
  /** Index being viewed; null means "follow the latest" (the default, and what >> returns to). */
  cursor: number | null;
  /** The camera button's request is running. */
  live: { inflight: boolean };
  /** Tokens used by the current run (reset when a run starts). `context` is the size of the last prompt sent. */
  usage: { calls: number; input: number; output: number; reasoning: number; cached: number; context: number };
  warnings: string[];
  runError: string | null;
};

export type BrowserAction =
  | { type: "connecting" }
  | { type: "connect_result"; result: ConnectState }
  | { type: "connect_failed"; error: string }
  /** An agent stream event; `at` is when it arrived (stamps screenshots). */
  | { type: "custom"; event: CustomEvent; at: string }
  | { type: "live_requested" }
  | { type: "live_frame"; frame: LiveFrame | null; tabs: Tab[] }
  | { type: "live_failed"; error: string; hint?: string }
  | { type: "screenshot_prev" }
  | { type: "screenshot_next" }
  | { type: "screenshot_latest" }
  | { type: "run_started" }
  | { type: "run_failed"; message: string };

const noUsage = { calls: 0, input: 0, output: 0, reasoning: 0, cached: 0, context: 0 };

export const initialBrowserState: BrowserState = {
  connection: { status: "idle" },
  tabs: [],
  frames: [],
  cursor: null,
  live: { inflight: false },
  usage: noUsage,
  warnings: [],
  runError: null,
};

/** Adds a frame to the history; past the cap the oldest is dropped, and a reader's place moves with it. */
function pushFrame(state: BrowserState, frame: Frame): Pick<BrowserState, "frames" | "cursor"> {
  const frames = [...state.frames, frame];
  let cursor = state.cursor; // a reader looking at history stays where they are while new frames arrive
  if (frames.length > APP_CONFIG.maxScreenshots) {
    frames.shift();
    if (cursor !== null) cursor = Math.max(0, cursor - 1);
  }
  return { frames, cursor };
}

export function reduceBrowser(state: BrowserState, action: BrowserAction): BrowserState {
  switch (action.type) {
    case "connecting":
      return { ...state, connection: { status: "connecting" } };
    case "connect_result":
      return action.result.status === "connected"
        ? { ...state, connection: { status: "connected" }, tabs: action.result.tabs }
        : {
            ...state,
            connection: { status: "error", error: action.result.error, hint: action.result.hint },
            tabs: [],
          };
    case "connect_failed":
      return { ...state, connection: { status: "error", error: action.error }, tabs: [] };
    case "custom": {
      const { event } = action;
      if (event.kind === "tabs") return { ...state, connection: { status: "connected" }, tabs: event.tabs };
      if (event.kind === "warning") return { ...state, warnings: [...state.warnings, event.message] };
      if (event.kind === "screenshot") {
        return { ...state, ...pushFrame(state, { mime: event.mime, data: event.data, takenAt: action.at, source: { kind: "step", tool: event.tool, callId: event.callId } }) };
      }
      if (event.kind === "usage") {
        const u = state.usage;
        return { ...state, usage: { calls: u.calls + 1, input: u.input + event.input, output: u.output + event.output, reasoning: u.reasoning + event.reasoning, cached: u.cached + event.cached, context: event.input } };
      }
      return state; // memory_change belongs to the documents state
    }

    case "live_requested":
      return { ...state, live: { inflight: true } };
    case "live_failed":
      // The camera could not reach the browser: show it where connection problems are shown.
      return { ...state, connection: { status: "error", error: action.error, hint: action.hint }, tabs: [], live: { inflight: false } };
    case "live_frame": {
      const base: BrowserState = { ...state, connection: { status: "connected" }, tabs: action.tabs, live: { inflight: false } };
      const { frame } = action;
      if (!frame) return base;
      return { ...base, ...pushFrame(base, { mime: frame.mime, data: frame.data, takenAt: frame.takenAt, source: { kind: "camera", pageId: frame.pageId, url: frame.url, title: frame.title } }) };
    }

    case "screenshot_prev": {
      if (state.frames.length === 0) return state;
      const at = state.cursor ?? state.frames.length - 1;
      const next = Math.max(0, at - 1);
      return { ...state, cursor: next === state.frames.length - 1 ? null : next };
    }
    case "screenshot_next": {
      if (state.cursor === null) return state;
      const next = state.cursor + 1;
      return { ...state, cursor: next >= state.frames.length - 1 ? null : next };
    }
    case "screenshot_latest":
      return { ...state, cursor: null };
    case "run_started":
      return { ...state, usage: noUsage, warnings: [], runError: null };
    case "run_failed":
      return { ...state, runError: action.message };
  }
}

export type ScreenshotView = {
  shot: Frame | null;
  /** 1-based position of the shown frame, and how many there are. */
  position: number;
  total: number;
  canPrev: boolean;
  canNext: boolean;
  /** True when following the latest frame. */
  live: boolean;
};

export function screenshotView(state: BrowserState): ScreenshotView {
  const total = state.frames.length;
  if (total === 0) return { shot: null, position: 0, total: 0, canPrev: false, canNext: false, live: true };
  const index = state.cursor ?? total - 1;
  return {
    shot: state.frames[index],
    position: index + 1,
    total,
    canPrev: index > 0,
    canNext: index < total - 1,
    live: state.cursor === null,
  };
}
