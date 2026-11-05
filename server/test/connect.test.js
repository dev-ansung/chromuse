// The no-model connect graph: attaches and returns the tabs; failures are state, never exceptions.

process.env.LANGSMITH_TRACING = "false";

import test from "node:test";
import assert from "node:assert/strict";
import { BrowserAttachError } from "../src/browser.js";
import { buildConfig } from "../src/config.js";
import { createConnectGraph } from "../src/connect.js";

const TABS = [{ id: 1, title: "Inbox", url: "https://mail.test/", selected: true }];

test("connected: returns the tabs", { timeout: 20_000 }, async () => {
  const graph = createConnectGraph({ session: { listTabs: async () => TABS } });
  const out = await graph.invoke({});
  assert.equal(out.status, "connected");
  assert.deepEqual(out.tabs, TABS);
  assert.equal(out.error, undefined);
});

test("attach failure: status error with the detail and the hint, and no exception", { timeout: 20_000 }, async () => {
  const session = {
    listTabs: async () => {
      throw new BrowserAttachError("The browser is not running", "Enable remote debugging in Chrome.");
    },
  };
  const out = await createConnectGraph({ session }).invoke({});
  assert.equal(out.status, "error");
  assert.deepEqual(out.tabs, []);
  assert.equal(out.error, "The browser is not running");
  assert.equal(out.hint, "Enable remote debugging in Chrome.");
});

test("an attached browser with no tabs is connected with an empty list", { timeout: 20_000 }, async () => {
  const out = await createConnectGraph({ session: { listTabs: async () => [] } }).invoke({});
  assert.equal(out.status, "connected");
  assert.deepEqual(out.tabs, []);
});

test("config loads the real data files; the connect graph needs no model key", () => {
  const { config, tabsTemplate, systemPrompt } = buildConfig({ requireKey: false });
  assert.equal(config.browser.attach, "autoConnect");
  assert.match(tabsTemplate, /\{\{tabs\}\}/);
  assert.match(systemPrompt, /autonomous browser agent/);
  assert.ok(config.tools.includes("take_snapshot"));
  assert.ok(!JSON.stringify(config).includes("apiKey"));
});
