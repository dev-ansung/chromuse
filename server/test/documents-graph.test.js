// The "documents" graph the web app uses for the user's reads and saves: same writer as the agent, results as data, never throws.

process.env.LANGSMITH_TRACING = "false";

import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryStore } from "@langchain/langgraph";
import { createDocuments, MEMORY, SOUL } from "../src/documents.js";
import { createDocumentsGraph } from "../src/documents-run.js";

const TEMPLATES = { [SOUL]: "# SOUL.md\n\nBe useful.\n", [MEMORY]: "# MEMORY.md\n\n" };

function setup() {
  const store = new InMemoryStore();
  const documents = createDocuments({ templates: TEMPLATES });
  const graph = createDocumentsGraph({ documents, defaultUserId: "local", compile: { store } });
  const call = async (input, user) => (await graph.invoke(input, user ? { configurable: { user_id: user } } : undefined)).result;
  return { store, documents, graph, call };
}

test("list creates SOUL.md and MEMORY.md from the templates and returns their metadata", async () => {
  const { call } = setup();
  const r = await call({ op: "list" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.files.map((f) => [f.path, f.version, f.updatedBy]), [[SOUL, 1, "template"], [MEMORY, 1, "template"]]);
});

test("read returns the document; an unknown path is an error result, not an exception", async () => {
  const { call } = setup();
  assert.match((await call({ op: "read", path: SOUL })).doc.content, /Be useful/);
  const bad = await call({ op: "read", path: "../etc/passwd" });
  assert.deepEqual([bad.ok, bad.error.code], [false, "unknown_path"]);
});

test("a save from the user is attributed to the user, with diff counts", async () => {
  const { call } = setup();
  const r = await call({ op: "save", path: MEMORY, content: "# MEMORY.md\n\n- Likes tea\n", expectedVersion: 1 });
  assert.deepEqual([r.ok, r.doc.version, r.doc.updatedBy, r.diff.added], [true, 2, "user", 1]);
});

test("a save based on an out-of-date version is a conflict result and writes nothing; saving without a version overwrites (keep mine)", async () => {
  const { call, documents, store } = setup();
  await call({ op: "read", path: MEMORY });
  await documents.append({ store, uid: "local", path: MEMORY, text: "- the agent wrote this" });
  const stale = await call({ op: "save", path: MEMORY, content: "# MEMORY.md\n\nmine\n", expectedVersion: 1 });
  assert.equal(stale.ok, false);
  assert.match(stale.conflict.current.content, /the agent wrote this/);
  assert.equal((await call({ op: "read", path: MEMORY })).doc.version, 2);
  const mine = await call({ op: "save", path: MEMORY, content: "# MEMORY.md\n\nmine\n" });
  assert.deepEqual([mine.ok, mine.doc.version], [true, 3]);
});

test("a secret in the user's save is a warning, not a refusal", async () => {
  const { call } = setup();
  const r = await call({ op: "save", path: MEMORY, content: "# MEMORY.md\n\npassword: correct-horse-battery\n", expectedVersion: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.warnings[0].code, "secret");
});

test("history shows who changed what; restore writes an old version as a new one, as the user", async () => {
  const { call, documents, store } = setup();
  await documents.append({ store, uid: "local", path: MEMORY, text: "- agent fact" });
  await call({ op: "save", path: MEMORY, content: "# MEMORY.md\n\n- agent fact\n- user fact\n", expectedVersion: 2 });
  const h = await call({ op: "history", path: MEMORY });
  assert.deepEqual(h.versions.map((v) => [v.version, v.updatedBy]), [[3, "user"], [2, "agent"], [1, "template"]]);
  const v = await call({ op: "read_version", path: MEMORY, version: 2 });
  assert.match(v.version.content, /agent fact/);
  const r = await call({ op: "restore", path: MEMORY, toVersion: 2 });
  assert.deepEqual([r.ok, r.doc.version, r.doc.updatedBy], [true, 4, "user"]);
  assert.doesNotMatch(r.doc.content, /user fact/);
});

test("an unknown operation, and a failing store, are error results (the graph never throws)", async () => {
  const { call } = setup();
  assert.equal((await call({ op: "explode" })).error.code, "unknown_op");

  // LangGraph wraps the store in a batching layer that calls batch(), so batch() is what has to fail.
  class BrokenStore extends InMemoryStore {
    async batch() {
      throw new Error("disk on fire");
    }
  }
  const store = new BrokenStore();
  const graph = createDocumentsGraph({ documents: createDocuments({ templates: TEMPLATES }), defaultUserId: "local", compile: { store } });
  const out = (await graph.invoke({ op: "read", path: MEMORY })).result;
  assert.deepEqual([out.ok, out.error.code], [false, "internal"]);
  assert.match(out.error.message, /disk on fire/);
});

test("the user is taken from config.configurable.user_id", async () => {
  const { call } = setup();
  await call({ op: "save", path: MEMORY, content: "# MEMORY.md\n\n- alice only\n", expectedVersion: 1 }, "alice");
  assert.match((await call({ op: "read", path: MEMORY }, "alice")).doc.content, /alice only/);
  assert.doesNotMatch((await call({ op: "read", path: MEMORY }, "bob")).doc.content, /alice only/);
});
