// The camera button's feed and route: tabs plus a screenshot of the selected tab, on request.

import test from "node:test";
import assert from "node:assert/strict";
import { BrowserAttachError } from "../src/browser.js";
import { createLiveFeed } from "../src/live.js";
import { createLiveApp } from "../src/live-app.js";

const TABS = [
  { id: 1, title: "Inbox", url: "https://mail.test/", selected: false },
  { id: 2, title: "Docs", url: "https://docs.test/", selected: true },
];
const FIXED = Date.parse("2026-11-04T12:00:00.000Z");

function fakeSession(over = {}) {
  const s = {
    lists: 0,
    shots: [],
    tabs: TABS,
    async listTabs() {
      s.lists++;
      return s.tabs;
    },
    async screenshot({ pageId }) {
      s.shots.push(pageId);
      return { mime: "image/jpeg", data: `DATA${pageId}` };
    },
    ...over,
  };
  return s;
}
const telemetryLog = () => {
  const events = [];
  return { events, now: () => Date.now(), clip: (v) => v, event: (type, data) => events.push({ type, ...data }) };
};

test("a snapshot lists the tabs and screenshots the selected one, stamped with the capture time", async () => {
  const session = fakeSession();
  const r = await createLiveFeed({ session, now: () => FIXED }).snapshot();
  assert.deepEqual(r, {
    ok: true,
    tabs: TABS,
    frame: { mime: "image/jpeg", data: "DATA2", pageId: 2, url: "https://docs.test/", title: "Docs", takenAt: "2026-11-04T12:00:00.000Z" },
  });
  assert.deepEqual(session.shots, [2]);
});

test("when no tab is selected the last one is used; with no tabs there is no screenshot and no error", async () => {
  const none = fakeSession({ tabs: [] });
  assert.deepEqual(await createLiveFeed({ session: none }).snapshot(), { ok: true, tabs: [], frame: null });
  assert.deepEqual(none.shots, []);
  const unselected = fakeSession({ tabs: TABS.map((t) => ({ ...t, selected: false })) });
  assert.equal((await createLiveFeed({ session: unselected }).snapshot()).frame.pageId, 2);
});

test("with screenshots disabled the feed still reports the tabs", async () => {
  const session = fakeSession();
  const r = await createLiveFeed({ session, screenshotEnabled: false }).snapshot();
  assert.deepEqual([r.tabs, r.frame, session.shots], [TABS, null, []]);
});

test("every request is a fresh capture, but concurrent requests share one", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const session = fakeSession({
    async listTabs() {
      session.lists++;
      await gate;
      return TABS;
    },
  });
  const feed = createLiveFeed({ session });
  const all = Promise.all([feed.snapshot(), feed.snapshot(), feed.snapshot()]);
  release();
  const results = await all;
  assert.equal(session.lists, 1);
  assert.ok(results.every((r) => r.ok && r.frame));
  await feed.snapshot();
  assert.equal(session.lists, 2, "a later request captures again");
});

test("failures are reported with their hint, and logged once per distinct message", async () => {
  const telemetry = telemetryLog();
  let failing = true;
  const session = fakeSession({
    async listTabs() {
      if (failing) throw new BrowserAttachError("The browser is not running", "Enable remote debugging.");
      return TABS;
    },
  });
  const feed = createLiveFeed({ session, telemetry });
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await feed.snapshot(), { ok: false, error: { message: "The browser is not running", hint: "Enable remote debugging." } });
  }
  assert.equal(telemetry.events.filter((e) => e.type === "live_error").length, 1);
  failing = false;
  await feed.snapshot();
  assert.deepEqual(telemetry.events.map((e) => e.type), ["live_error", "live_recovered"]);
});

test("a screenshot failure after listing is an error result too", async () => {
  const session = fakeSession({ screenshot: async () => { throw new Error("screenshot tool unavailable"); } });
  assert.deepEqual(await createLiveFeed({ session }).snapshot(), { ok: false, error: { message: "screenshot tool unavailable" } });
});

test("a successful snapshot writes no telemetry", async () => {
  const telemetry = telemetryLog();
  await createLiveFeed({ session: fakeSession(), telemetry }).snapshot();
  assert.deepEqual(telemetry.events, []);
});

test("GET /live/snapshot serves the feed as JSON, uncached; 503 with the error when the browser is unreachable", async () => {
  const ok = createLiveApp(createLiveFeed({ session: fakeSession() }));
  const res = await ok.request("/live/snapshot");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal((await res.json()).frame.pageId, 2);

  const down = createLiveApp(createLiveFeed({ session: fakeSession({ listTabs: async () => { throw new Error("no browser"); } }) }));
  const bad = await down.request("/live/snapshot");
  assert.equal(bad.status, 503);
  assert.equal((await bad.json()).error.message, "no browser");
});
