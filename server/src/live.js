// The camera button: the open tabs plus a screenshot of the selected one, taken when the user asks. The live view is otherwise
// driven by the agent's steps (agent.js sends a screenshot after each page-changing tool call), so there is no polling here.
//
// - Concurrent requests share one capture (a double click does not queue a second one).
// - Errors are logged when they CHANGE, not on every request.

import { noopTelemetry } from "./telemetry.js";

/**
 * Responses:
 *   { ok: true, tabs: Tab[], frame: { mime, data, pageId, url, title, takenAt } | null }
 *   { ok: false, error: { message, hint? } }
 */
export function createLiveFeed({ session, telemetry = noopTelemetry, now = () => Date.now(), screenshotEnabled = true }) {
  let inflight;
  let lastError;

  async function capture() {
    const tabs = await session.listTabs();
    const target = tabs.find((t) => t.selected) ?? tabs.at(-1);
    if (!target || !screenshotEnabled) return { tabs, frame: null };
    const shot = await session.screenshot({ pageId: target.id });
    return { tabs, frame: shot ? { ...shot, pageId: target.id, url: target.url, title: target.title, takenAt: new Date(now()).toISOString() } : null };
  }

  async function run() {
    try {
      const result = await capture();
      if (lastError !== undefined) {
        telemetry.event("live_recovered", { was: lastError });
        lastError = undefined;
      }
      return { ok: true, ...result };
    } catch (err) {
      const message = err?.detail ?? err?.message ?? String(err);
      if (message !== lastError) {
        lastError = message;
        telemetry.event("live_error", { error: message, hint: err?.hint });
      }
      return { ok: false, error: { message, ...(err?.hint ? { hint: err.hint } : {}) } };
    }
  }

  return {
    snapshot() {
      inflight ??= run().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
  };
}
