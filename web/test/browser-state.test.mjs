import test from "node:test";
import assert from "node:assert/strict";
import { initialBrowserState as s0, reduceBrowser, screenshotView } from "../src/lib/browser-state.ts";
import { APP_CONFIG } from "../src/lib/app-config.ts";

const TAB = { id: 1, title: "Inbox", url: "https://mail.test/", selected: true };
const frame = (n) => ({ mime: "image/jpeg", data: `D${n}`, pageId: 1, url: "https://mail.test/", title: "Inbox", takenAt: `2026-11-04T12:00:${String(n % 60).padStart(2, "0")}.000Z` });
const live = (state, n, { manual = false, tabs = [TAB] } = {}) => reduceBrowser(state, { type: "live_frame", frame: frame(n), tabs, manual });
const addFrames = (state, count, from = 1) => {
  for (let n = from; n < from + count; n++) state = live(state, n);
  return state;
};
const viewed = (state) => screenshotView(state).shot?.data;

test("connecting, then connected with tabs", () => {
  const s1 = reduceBrowser(s0, { type: "connecting" });
  assert.equal(s1.connection.status, "connecting");
  const s2 = reduceBrowser(s1, { type: "connect_result", result: { status: "connected", tabs: [TAB] } });
  assert.deepEqual(s2.connection, { status: "connected" });
  assert.deepEqual(s2.tabs, [TAB]);
});

test("a failed attach keeps the reason and the hint and clears the tabs", () => {
  const withTabs = reduceBrowser(s0, { type: "connect_result", result: { status: "connected", tabs: [TAB] } });
  const s = reduceBrowser(withTabs, { type: "connect_result", result: { status: "error", tabs: [], error: "not running", hint: "enable it" } });
  assert.deepEqual(s.connection, { status: "error", error: "not running", hint: "enable it" });
  assert.deepEqual(s.tabs, []);
});

test("a request that never reached the server is a failed connection too", () => {
  const s = reduceBrowser(s0, { type: "connect_failed", error: "fetch failed" });
  assert.deepEqual(s.connection, { status: "error", error: "fetch failed" });
});

test("agent events update tabs and warnings", () => {
  let s = reduceBrowser(s0, { type: "custom", event: { kind: "tabs", tabs: [TAB] } });
  assert.equal(s.connection.status, "connected");
  assert.deepEqual(s.tabs, [TAB]);
  s = reduceBrowser(s, { type: "custom", event: { kind: "warning", message: "careful" } });
  assert.deepEqual(s.warnings, ["careful"]);
});

test("a new run clears the previous run's problems but keeps the tabs and the live history", () => {
  let s = reduceBrowser(s0, { type: "custom", event: { kind: "tabs", tabs: [TAB] } });
  s = addFrames(s, 2);
  s = reduceBrowser(s, { type: "custom", event: { kind: "warning", message: "old" } });
  s = reduceBrowser(s, { type: "run_failed", message: "old failure" });
  s = reduceBrowser(s, { type: "run_started" });
  assert.deepEqual(s.warnings, []);
  assert.equal(s.runError, null);
  assert.deepEqual(s.tabs, [TAB]);
  assert.equal(screenshotView(s).total, 2);
});

// ---- live view ----

test("no tab to capture: the tabs update, the history does not", () => {
  let s = live(s0, 1);
  s = reduceBrowser(s, { type: "live_frame", frame: null, tabs: [], manual: false });
  assert.deepEqual([s.tabs, screenshotView(s).total], [[], 1]);
});

test("a live failure is shown as a connection problem (with the hint), clears the tabs, and stops being in flight", () => {
  let s = reduceBrowser(live(s0, 1), { type: "live_requested" });
  s = reduceBrowser(s, { type: "live_failed", error: "browser closed", hint: "Open Chrome and refresh." });
  assert.deepEqual(s.connection, { status: "error", error: "browser closed", hint: "Open Chrome and refresh." });
  assert.deepEqual([s.tabs, s.live.inflight], [[], false]);
  assert.equal(screenshotView(s).total, 1, "the history survives");
});

test("no frames: nothing to show, nothing to navigate, and following live", () => {
  assert.deepEqual(screenshotView(s0), { shot: null, position: 0, total: 0, canPrev: false, canNext: false, live: true });
  assert.equal(reduceBrowser(s0, { type: "screenshot_prev" }), s0);
});

test("new frames are followed: the view is always the latest", () => {
  const v = screenshotView(addFrames(s0, 3));
  assert.equal(v.shot.data, "D3");
  assert.deepEqual([v.position, v.total, v.canPrev, v.canNext, v.live], [3, 3, true, false, true]);
});

test("previous steps back through history; next steps forward; reaching the end follows live again", () => {
  let s = addFrames(s0, 4);
  s = reduceBrowser(s, { type: "screenshot_prev" });
  assert.equal(viewed(s), "D3");
  assert.equal(screenshotView(s).live, false);
  s = reduceBrowser(s, { type: "screenshot_prev" });
  s = reduceBrowser(s, { type: "screenshot_prev" });
  assert.equal(viewed(s), "D1");
  assert.equal(screenshotView(s).canPrev, false);
  s = reduceBrowser(s, { type: "screenshot_prev" });
  assert.equal(viewed(s), "D1");
  s = reduceBrowser(s, { type: "screenshot_next" });
  assert.equal(viewed(s), "D2");
  s = reduceBrowser(s, { type: "screenshot_next" });
  s = reduceBrowser(s, { type: "screenshot_next" });
  assert.equal(viewed(s), "D4");
  assert.equal(screenshotView(s).live, true, "stepping onto the newest returns to following live");
});

test(">> jumps to the latest from anywhere", () => {
  let s = addFrames(s0, 5);
  for (let i = 0; i < 4; i++) s = reduceBrowser(s, { type: "screenshot_prev" });
  assert.equal(viewed(s), "D1");
  s = reduceBrowser(s, { type: "screenshot_latest" });
  assert.equal(viewed(s), "D5");
  assert.equal(screenshotView(s).live, true);
});

test("a reader looking at history is not yanked to the new frame", () => {
  let s = addFrames(s0, 3);
  s = reduceBrowser(reduceBrowser(s, { type: "screenshot_prev" }), { type: "screenshot_prev" });
  assert.equal(viewed(s), "D1");
  s = addFrames(s, 2, 4);
  assert.equal(viewed(s), "D1", "still on the frame being read");
  const v = screenshotView(s);
  assert.deepEqual([v.position, v.total, v.canNext, v.live], [1, 5, true, false]);
});

test("history is capped, dropping the oldest, and a reader's place moves with it", () => {
  const max = APP_CONFIG.maxScreenshots;
  let s = addFrames(s0, max);
  assert.equal(screenshotView(s).total, max);
  s = reduceBrowser(s, { type: "screenshot_prev" });
  const reading = viewed(s);
  s = addFrames(s, 1, max + 1);
  assert.equal(screenshotView(s).total, max, "still capped");
  assert.equal(s.frames[0].data, "D2", "the oldest was dropped");
  assert.equal(viewed(s), reading, "the reader still sees the same frame after the shift");
});

test("a reader on the oldest frame stays on the (new) oldest when it is dropped", () => {
  const max = APP_CONFIG.maxScreenshots;
  let s = addFrames(s0, max);
  for (let i = 0; i < max; i++) s = reduceBrowser(s, { type: "screenshot_prev" });
  assert.equal(viewed(s), "D1");
  s = addFrames(s, 1, max + 1);
  assert.equal(screenshotView(s).position, 1);
  assert.equal(viewed(s), "D2");
});
