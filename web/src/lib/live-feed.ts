// The camera button: asks the server for a fresh screenshot of the selected tab. The live view otherwise follows the agent's steps.
// The dependencies are injected so it can be tested without a browser or network.

import type { BrowserAction } from "./browser-state.ts";
import { describeError, parseLiveResponse } from "./parse.ts";

export type LiveDeps = {
  fetchImpl: (url: string, init?: { cache?: "no-store" }) => Promise<{ status: number; json(): Promise<unknown> }>;
  /** The snapshot endpoint. */
  url: string;
  dispatch(action: BrowserAction): void;
};

export function createLiveDriver(deps: LiveDeps) {
  let inflight: Promise<void> | undefined;

  async function request() {
    deps.dispatch({ type: "live_requested" });
    try {
      const response = await deps.fetchImpl(deps.url, { cache: "no-store" });
      const body = await response.json().catch(() => undefined);
      if (body === undefined) throw new Error(`The server answered HTTP ${response.status} without a snapshot. Is it running?`);
      const live = parseLiveResponse(body);
      if (!live.ok) deps.dispatch({ type: "live_failed", error: live.error.message, hint: live.error.hint });
      else deps.dispatch({ type: "live_frame", frame: live.frame, tabs: live.tabs });
    } catch (err) {
      deps.dispatch({ type: "live_failed", error: describeError(err) });
    }
  }

  return {
    /** Takes a screenshot now. A second click while one is running joins it instead of starting another. */
    snap(): Promise<void> {
      inflight ??= request().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
  };
}
