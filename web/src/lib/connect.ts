// Attaches to the browser and lists its tabs by running the no-model "connect" graph. No inference involved.

import { APP_CONFIG } from "./app-config.ts";
import { dispatch } from "./browser-store.ts";
import { client } from "./client.ts";
import { describeError, parseConnectState } from "./parse.ts";

let inflight: Promise<void> | undefined;

/** Runs the connect graph once at a time (React StrictMode mounts effects twice in development). */
export function connectBrowser(): Promise<void> {
  inflight ??= (async () => {
    dispatch({ type: "connecting" });
    try {
      const values = await client.runs.wait(null, APP_CONFIG.connectGraphId, { input: {} });
      dispatch({ type: "connect_result", result: parseConnectState(values) });
    } catch (err) {
      dispatch({ type: "connect_failed", error: describeError(err) });
    }
  })().finally(() => {
    inflight = undefined;
  });
  return inflight;
}
