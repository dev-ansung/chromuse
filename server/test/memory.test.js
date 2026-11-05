// SOUL.md and MEMORY.md in the real agent: what the model is given, what its tools do, how the user's edits are noticed.
// Real shipped templates and prompt, real LangGraph store and checkpointer, fake model. No Chrome, network or credits.

process.env.LANGSMITH_TRACING = "false";

import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
import { AIMessage, fakeModel } from "langchain";
import { buildAgent } from "../src/agent.js";
import { buildConfig } from "../src/config.js";
import { createDocuments, MEMORY, SOUL } from "../src/documents.js";
import { textOf } from "../src/text.js";

const shipped = buildConfig({ requireKey: false });
const baseConfig = { maxModelCalls: 10, modelRetries: 0, modelRetryDelayMs: 1, contextTrimTokens: 60000, memory: { userId: "local", budgetTokens: 1500 } };

const TABS = [{ id: 1, title: "Inbox", url: "https://mail.test/", selected: true }];
const session = { listTabs: async () => TABS };

function world({ config = baseConfig } = {}) {
  const store = new InMemoryStore();
  const events = [];
  const telemetry = { now: () => Date.now(), clip: (v) => v, event: (type, data, ctx) => events.push({ type, ...ctx, ...data }) };
  const documents = createDocuments({ templates: shipped.templates, telemetry, limits: shipped.config.memory.limits });
  const saver = new MemorySaver();
  return { store, events, telemetry, documents, saver, config, of: (t) => events.filter((e) => e.type === t) };
}

async function run(w, { model, thread = "t1", user, task = "go", withMemory = true, store = w.store } = {}) {
  const agent = buildAgent({
    model, tools: [], session, config: w.config, systemPrompt: "CORE RULES", tabsTemplate: "Open tabs:\n{{tabs}}",
    memory: withMemory ? { documents: w.documents, template: shipped.memoryTemplate } : undefined,
    store, checkpointer: w.saver, telemetry: w.telemetry,
  });
  const custom = [];
  let state;
  let error;
  try {
    for await (const [mode, chunk] of await agent.stream({ messages: [{ role: "user", content: task }] }, { streamMode: ["custom", "values"], configurable: { thread_id: thread, ...(user ? { user_id: user } : {}) } })) {
      if (mode === "custom") custom.push(chunk);
      else state = chunk;
    }
  } catch (err) {
    error = err;
  }
  return { custom, state, error, system: (k = 0) => textOf(model.calls[k].messages[0].content) };
}
const says = (text) => fakeModel().respond(new AIMessage(text));
const call = (name, args, id = "c1") => ({ name, args, id });
const toolResult = (state) => state.messages.filter((m) => m.type === "tool").map((m) => textOf(m.content));

test("the prompt is: core rules, then your soul and memory, then the open tabs", { timeout: 20_000 }, async () => {
  const w = world();
  const model = says("hi");
  const r = await run(w, { model });
  assert.equal(r.error, undefined);
  const s = r.system();
  const at = (needle) => s.indexOf(needle);
  assert.ok(at("CORE RULES") === 0);
  assert.ok(at("CORE RULES") < at("## Your memory") && at("## Your memory") < at("### SOUL.md") && at("### SOUL.md") < at("### MEMORY.md") && at("### MEMORY.md") < at("Open tabs:"), "order of sections");
  assert.match(s, /You are a browser agent working inside someone's own Chrome/, "the soul document is in the prompt");
  assert.match(s, /Durable facts, preferences, and commitments/, "the memory document is in the prompt");
  assert.match(s, /memory_append/, "the model is told how to use its tools");
  assert.doesNotMatch(s, /About this file/i, "interface text is not part of the files and is never shown to the model");
});

test("the first run creates both documents from the shipped templates, once", { timeout: 20_000 }, async () => {
  const w = world();
  await run(w, { model: says("hi") });
  await run(w, { model: says("hi again"), thread: "t2" });
  assert.deepEqual(w.of("memory_write").filter((e) => e.by === "template").map((e) => e.path).sort(), [MEMORY, SOUL]);
  const reads = w.of("memory_read");
  assert.equal(reads.length, 2);
  assert.deepEqual(reads[0].files, { [SOUL]: 1, [MEMORY]: 1 });
});

test("what the agent saves in one conversation is in the prompt of the next, with the change announced to the UI", { timeout: 20_000 }, async () => {
  const w = world();
  const first = await run(w, { model: fakeModel().respondWithTools([call("memory_append", { path: MEMORY, text: "## Preferences (2026-11-04)\n- Prefers short answers" })]).respond(new AIMessage("noted")) });
  assert.equal(first.error, undefined);
  assert.match(toolResult(first.state)[0], /Added to MEMORY\.md \(now version 2, \+2 −0\)/);
  assert.deepEqual(first.custom.filter((e) => e.kind === "memory_change"), [{ kind: "memory_change", path: MEMORY, version: 2, by: "agent", added: 2, removed: 0, soul: false }]);
  assert.equal(w.of("memory_write").at(-1).by, "agent");

  const second = await run(w, { model: says("hello"), thread: "another-conversation" });
  assert.match(second.system(), /- Prefers short answers/);
});

test("changing SOUL.md is flagged as a soul change for the UI, and the model is told the user was notified", { timeout: 20_000 }, async () => {
  const w = world();
  const model = fakeModel()
    .respondWithTools([call("memory_edit", { path: SOUL, find: "Have a point of view.", replace: "Have a point of view, and keep it short." })])
    .respond(new AIMessage("I updated my soul."));
  const r = await run(w, { model });
  assert.equal(r.custom.find((e) => e.kind === "memory_change").soul, true);
  assert.match(toolResult(r.state)[0], /The user has been notified of the change to your soul/);
  const doc = (await w.documents.read(w.store, "local", SOUL)).doc;
  assert.match(doc.content, /keep it short/);
  assert.equal(doc.updatedBy, "agent");
});

test("secrets are refused, nothing is written, and the model is told why", { timeout: 20_000 }, async () => {
  const w = world();
  const model = fakeModel().respondWithTools([call("memory_append", { path: MEMORY, text: "- card 4242 4242 4242 4242" })]).respond(new AIMessage("ok"));
  const r = await run(w, { model });
  assert.match(toolResult(r.state)[0], /Not saved: .*secret \(card_number\)/);
  assert.equal((await w.documents.read(w.store, "local", MEMORY)).doc.version, 1);
  assert.equal(r.custom.filter((e) => e.kind === "memory_change").length, 0);
  assert.equal(w.of("memory_blocked").length, 1);
  assert.ok(!JSON.stringify(w.events).includes("4242"), "the secret is not in the telemetry");
});

test("an edit whose text is no longer there, an unknown path, and memory_read all give the model something to act on", { timeout: 20_000 }, async () => {
  const w = world();
  const model = fakeModel()
    .respondWithTools([call("memory_edit", { path: MEMORY, find: "text that is not there", replace: "x" }, "a")])
    .respondWithTools([call("memory_append", { path: "../secrets.md", text: "x" }, "b")])
    .respondWithTools([call("memory_read", { path: MEMORY }, "c")])
    .respond(new AIMessage("done"));
  const r = await run(w, { model });
  const [notFound, unknown, read] = toolResult(r.state);
  assert.match(notFound, /not in the file now.*Read the file again/);
  assert.match(unknown, /not a memory file/);
  assert.match(read, /^MEMORY\.md \(version 1\):/);
  assert.match(read, /Durable facts/);
});

test("the user's edit between runs is noted to the agent once, and the agent's own writes are not", { timeout: 30_000 }, async () => {
  const w = world();
  const t = { thread: "same" };
  await run(w, { ...t, model: fakeModel().respondWithTools([call("memory_append", { path: MEMORY, text: "- agent fact" })]).respond(new AIMessage("ok")) });
  const afterAgent = await run(w, { ...t, model: says("two") });
  assert.doesNotMatch(afterAgent.system(), /edited MEMORY\.md since you last saw it/, "its own write is not announced to itself");

  const cur = (await w.documents.read(w.store, "local", MEMORY)).doc;
  await w.documents.save({ store: w.store, uid: "local", path: MEMORY, content: `${cur.content}- user fact\n`, expectedVersion: cur.version });
  const afterUser = await run(w, { ...t, model: says("three") });
  assert.match(afterUser.system(), /the user edited MEMORY\.md since you last saw it \(\+1 −0\)\. Their edits are authoritative/);
  assert.match(afterUser.system(), /- user fact/);
  assert.equal(w.of("memory_read").at(-1).user_edits_noted, true);

  const later = await run(w, { ...t, model: says("four") });
  assert.doesNotMatch(later.system(), /edited MEMORY\.md since you last saw it/, "said once");
});

test("a large MEMORY.md is clipped to the budget, the soul stays whole, and the prompt says so", { timeout: 20_000 }, async () => {
  const w = world({ config: { ...baseConfig, memory: { userId: "local", budgetTokens: 400 } } });
  await w.documents.read(w.store, "local", MEMORY);
  await w.documents.save({ store: w.store, uid: "local", path: MEMORY, content: `# MEMORY.md\n\n${"- a fact worth keeping\n".repeat(400)}`, expectedVersion: 1 });
  const r = await run(w, { model: says("hi") });
  const s = r.system();
  assert.match(s, /more characters of MEMORY\.md were left out to fit the memory budget/);
  assert.match(s, /You are a browser agent working inside someone's own Chrome/, "the soul is never clipped");
  assert.ok(w.of("memory_read")[0].clipped_chars > 0);
  assert.ok(s.length < 400 * 4 + 6000, "the memory section stays near the budget (rules, tabs and instructions are extra)");
});

test("a memory failure does not fail the run: it is logged and the run goes on without memory", { timeout: 20_000 }, async () => {
  // LangGraph wraps the store in a batching layer that calls batch(), so batch() is what has to fail.
  class BrokenStore extends InMemoryStore {
    async batch() {
      throw new Error("disk on fire");
    }
  }
  const w = world();
  const r = await run(w, { model: says("hello anyway"), store: new BrokenStore() });
  assert.equal(r.error, undefined);
  assert.equal(textOf(r.state.messages.at(-1).content), "hello anyway");
  assert.doesNotMatch(r.system(), /## Your memory/);
  assert.match(w.of("memory_error")[0].error.message, /disk on fire/);
});

test("memory tools never throw into the run when the store fails", { timeout: 20_000 }, async () => {
  const w = world();
  // Reads and the template seeding work; the write of version 2 fails.
  class FlakyStore extends InMemoryStore {
    async batch(ops) {
      if (ops.some((op) => op.value && op.namespace?.[2] === "files" && op.value.version === 2)) throw new Error("write failed");
      return super.batch(ops);
    }
  }
  const model = fakeModel().respondWithTools([call("memory_append", { path: MEMORY, text: "- x" })]).respond(new AIMessage("ok"));
  const r = await run(w, { model, store: new FlakyStore() });
  assert.equal(r.error, undefined);
  assert.match(toolResult(r.state)[0], /Memory is not available right now/);
  assert.ok(w.of("memory_error").some((e) => e.phase === "memory_append"));
});

test("memory is per user", { timeout: 30_000 }, async () => {
  const w = world();
  await run(w, { user: "alice", thread: "a", model: fakeModel().respondWithTools([call("memory_append", { path: MEMORY, text: "- alice likes tea" })]).respond(new AIMessage("ok")) });
  const alice = await run(w, { user: "alice", thread: "a2", model: says("hi") });
  const bob = await run(w, { user: "bob", thread: "b", model: says("hi") });
  assert.match(alice.system(), /alice likes tea/);
  assert.doesNotMatch(bob.system(), /alice likes tea/);
});

test("with memory switched off the agent has no memory section", { timeout: 20_000 }, async () => {
  const w = world();
  const r = await run(w, { model: says("hi"), withMemory: false });
  assert.doesNotMatch(r.system(), /## Your memory/);
  assert.equal(w.of("memory_read").length, 0);
});
