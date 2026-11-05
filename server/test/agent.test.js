// The real middleware stack (src/agent.js) with a fake model and a fake browser session.
// No Chrome, no network, no API credits.

process.env.LANGSMITH_TRACING = "false"; // never trace test runs

import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { AIMessage, fakeModel, tool } from "langchain";
import { buildAgent, recursionLimitFor } from "../src/agent.js";
import { BrowserAttachError } from "../src/browser.js";
import { textOf } from "../src/text.js";

const TABS = [
  { id: 1, title: "Inbox", url: "https://mail.test/", selected: true },
  { id: 2, title: "Docs", url: "https://docs.test/", selected: false },
];
const TABS_TEMPLATE = "Open tabs:\n{{tabs}}";
const config = {
  maxModelCalls: 10,
  modelRetries: 0,
  contextTrimTokens: 60000,
  screenshot: { enabled: true, format: "jpeg", quality: 60, timeoutMs: 1000, after: ["click"] },
};

const click = tool(async ({ uid }) => `clicked ${uid}`, {
  name: "click",
  description: "click an element",
  schema: z.object({ pageId: z.number(), uid: z.string() }),
});
const takeSnapshot = tool(async () => "uid=1 button 'Go'", {
  name: "take_snapshot",
  description: "snapshot",
  schema: z.object({ pageId: z.number() }),
});

/** A browser session that records calls in order. */
function fakeSession({ failAttach } = {}) {
  const calls = [];
  return {
    calls,
    async listTabs() {
      calls.push("listTabs");
      if (failAttach) throw new BrowserAttachError("The browser is not running", "Enable remote debugging in Chrome.");
      return TABS;
    },
    async screenshot({ pageId }) {
      calls.push(`screenshot:${pageId}`);
      return { mime: "image/jpeg", data: "QUJD" };
    },
  };
}

async function run(model, tools, session, task = "go") {
  const agent = buildAgent({ model, tools, session, config, systemPrompt: "You are a test agent.", tabsTemplate: TABS_TEMPLATE });
  const custom = [];
  let state;
  let error;
  try {
    for await (const [mode, chunk] of await agent.stream({ messages: [{ role: "user", content: task }] }, { streamMode: ["custom", "values"] })) {
      if (mode === "custom") custom.push(chunk);
      else state = chunk;
    }
  } catch (err) {
    error = err;
  }
  return { custom, state, error };
}

test("the tabs are read from the browser before the first model call, and the model is told about them", { timeout: 20_000 }, async () => {
  const session = fakeSession();
  const model = fakeModel().respond(new AIMessage("Hello!"));
  const { custom, error } = await run(model, [], session);

  assert.equal(error, undefined);
  assert.deepEqual(session.calls, ["listTabs"], "listed once, no screenshots for a plain answer");
  const system = textOf(model.calls[0].messages[0].content);
  assert.match(system, /You are a test agent\./);
  assert.match(system, /Open tabs:/);
  assert.match(system, /page 1 \(selected\): Inbox — https:\/\/mail\.test\//);
  assert.match(system, /page 2: Docs — https:\/\/docs\.test\//);
  assert.deepEqual(custom.filter((e) => e.kind === "tabs"), [{ kind: "tabs", tabs: TABS }]);
});

test("if the browser cannot be attached, the run fails before any model call", { timeout: 20_000 }, async () => {
  const session = fakeSession({ failAttach: true });
  const model = fakeModel().respond(new AIMessage("never sent"));
  const { error } = await run(model, [], session);

  assert.equal(model.callCount, 0, "no inference happened");
  assert.equal(error?.name, "BrowserAttachError");
  assert.match(error.message, /Enable remote debugging in Chrome/);
});

test("a screenshot is emitted after a page-changing tool, not after a snapshot", { timeout: 20_000 }, async () => {
  const session = fakeSession();
  const model = fakeModel()
    .respondWithTools([{ name: "take_snapshot", args: { pageId: 1 }, id: "c1" }])
    .respondWithTools([{ name: "click", args: { pageId: 2, uid: "7" }, id: "c2" }])
    .respond(new AIMessage("done"));
  const { custom, error } = await run(model, [click, takeSnapshot], session);

  assert.equal(error, undefined);
  assert.deepEqual(session.calls, ["listTabs", "screenshot:2"], "one screenshot, for the click's page");
  assert.deepEqual(custom.filter((e) => e.kind === "screenshot"), [
    { kind: "screenshot", tool: "click", callId: "c2", mime: "image/jpeg", data: "QUJD" },
  ]);
});

test("a failing screenshot becomes a warning and does not break the run", { timeout: 20_000 }, async () => {
  const session = fakeSession();
  session.screenshot = async () => {
    throw new Error("screenshot tool unavailable");
  };
  const model = fakeModel()
    .respondWithTools([{ name: "click", args: { pageId: 1, uid: "7" }, id: "c1" }])
    .respond(new AIMessage("done"));
  const { custom, error, state } = await run(model, [click], session);

  assert.equal(error, undefined);
  assert.equal(textOf(state.messages.at(-1).content), "done");
  assert.deepEqual(custom.filter((e) => e.kind === "warning").map((w) => w.message), ["screenshot failed: screenshot tool unavailable"]);
});

test("a screenshot that hangs times out as a warning and the agent moves on", { timeout: 20_000 }, async () => {
  const session = fakeSession();
  session.screenshot = () => new Promise(() => {}); // never settles
  const model = fakeModel()
    .respondWithTools([{ name: "click", args: { pageId: 1, uid: "7" }, id: "c1" }])
    .respond(new AIMessage("done"));
  const agent = buildAgent({ model, tools: [click], session, config: { ...config, screenshot: { ...config.screenshot, timeoutMs: 50 } }, systemPrompt: "t", tabsTemplate: TABS_TEMPLATE });
  const started = Date.now();
  const out = await agent.invoke({ messages: [{ role: "user", content: "go" }] });
  assert.equal(textOf(out.messages.at(-1).content), "done");
  assert.ok(Date.now() - started < 5000, "the agent was not stalled by the hanging screenshot");
});

test("the screenshot also follows a failed page-changing tool (the page state is still worth seeing)", { timeout: 20_000 }, async () => {
  const session = fakeSession();
  const badClick = tool(async () => { throw new Error("element not found"); }, { name: "click", description: "c", schema: z.object({ pageId: z.number(), uid: z.string() }) });
  const model = fakeModel()
    .respondWithTools([{ name: "click", args: { pageId: 1, uid: "7" }, id: "c1" }])
    .respond(new AIMessage("done"));
  const { custom, error } = await run(model, [badClick], session);
  assert.equal(error, undefined);
  assert.equal(custom.filter((e) => e.kind === "screenshot").length, 1);
});

test("screenshots can be switched off", { timeout: 20_000 }, async () => {
  const session = fakeSession();
  const model = fakeModel()
    .respondWithTools([{ name: "click", args: { pageId: 1, uid: "7" }, id: "c1" }])
    .respond(new AIMessage("done"));
  const agent = buildAgent({ model, tools: [click], session, config: { ...config, screenshot: { ...config.screenshot, enabled: false } }, systemPrompt: "t", tabsTemplate: TABS_TEMPLATE });
  await agent.invoke({ messages: [{ role: "user", content: "go" }] });
  assert.deepEqual(session.calls, ["listTabs"]);
});

test("each run reads the tabs again", { timeout: 20_000 }, async () => {
  const session = fakeSession();
  await run(fakeModel().respond(new AIMessage("one")), [], session);
  await run(fakeModel().respond(new AIMessage("two")), [], session);
  assert.deepEqual(session.calls, ["listTabs", "listTabs"]);
});

// Regression: "Recursion limit of 25 reached" after ~6 tool calls (the middleware makes each cycle cost ~4 graph steps).
test("a run of many tool calls is not cut off by LangGraph's default recursion limit", { timeout: 30_000 }, async () => {
  const ok = tool(async () => "ok", { name: "click", description: "c", schema: z.object({}) });
  let model = fakeModel();
  for (let i = 0; i < 15; i++) model = model.respond(new AIMessage({ content: "", tool_calls: [{ name: "click", args: {}, id: `c${i}` }] }));
  model = model.respond(new AIMessage("done after 15 tool calls"));
  const agent = buildAgent({ model, tools: [ok], session: fakeSession(), config: { ...config, maxModelCalls: 40 }, systemPrompt: "t", tabsTemplate: TABS_TEMPLATE });
  const out = await agent.invoke({ messages: [{ role: "user", content: "go" }] });
  assert.equal(textOf(out.messages.at(-1).content), "done after 15 tool calls");
});

test("the explicit model-call limit fires before LangGraph's recursion limit", { timeout: 30_000 }, async () => {
  const ok = tool(async () => "ok", { name: "click", description: "c", schema: z.object({}) });
  let model = fakeModel();
  for (let i = 0; i < 60; i++) model = model.respond(new AIMessage({ content: "", tool_calls: [{ name: "click", args: {}, id: `c${i}` }] }));
  const agent = buildAgent({ model, tools: [ok], session: fakeSession(), config: { ...config, maxModelCalls: 30 }, systemPrompt: "t", tabsTemplate: TABS_TEMPLATE });
  await assert.rejects(
    agent.invoke({ messages: [{ role: "user", content: "never stops" }] }),
    (err) => err.name === "ModelCallLimitMiddlewareError",
    "expected the model-call limit, not GraphRecursionError"
  );
  assert.equal(model.callCount, 30);
});

test("the recursion limit leaves room for every allowed model call", () => {
  // measured: 5 setup steps + 4 per cycle, and at most maxModelCalls - 1 cycles
  for (const n of [1, 10, 40, 100]) assert.ok(recursionLimitFor(n) >= 5 + 4 * (n - 1) + 10, `limit for ${n} calls`);
});
