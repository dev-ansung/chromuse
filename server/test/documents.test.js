// The document writer shared by the user and the agent: versions, attribution, conflicts, secrets, undo, concurrency.
// Uses the real LangGraph InMemoryStore. No network.

import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryStore } from "@langchain/langgraph";
import { createDocuments, MEMORY, SOUL } from "../src/documents.js";
import { diffLines } from "../src/diff.js";
import { scanSecrets } from "../src/secrets.js";

const TEMPLATES = { [SOUL]: "# SOUL.md\n\nBe useful.\n", [MEMORY]: "# MEMORY.md\n\n" };
const uid = "local";

function setup(opts = {}) {
  const store = new InMemoryStore();
  const events = [];
  const telemetry = { now: () => Date.now(), clip: (v) => v, event: (type, data, ctx) => events.push({ type, ...ctx, ...data }), saveScreenshot: () => undefined };
  const docs = createDocuments({ templates: TEMPLATES, telemetry, ...opts });
  return { store, events, docs, of: (t) => events.filter((e) => e.type === t) };
}

test("documents are created from their templates on first read, once", async () => {
  const { store, docs, of } = setup();
  const first = (await docs.read(store, uid, SOUL)).doc;
  assert.equal(first.content, TEMPLATES[SOUL]);
  assert.deepEqual([first.version, first.updatedBy], [1, "template"]);
  await docs.save({ store, uid, path: SOUL, content: "# SOUL.md\n\nMine.\n", expectedVersion: 1 });
  const again = (await docs.read(store, uid, SOUL)).doc;
  assert.equal(again.content, "# SOUL.md\n\nMine.\n", "a user edit is not overwritten by the template");
  assert.equal(of("memory_write").filter((e) => e.by === "template").length, 1);
});

test("an unknown path is rejected and a note that does not exist yet reads as empty", async () => {
  const { store, docs } = setup();
  assert.equal((await docs.read(store, uid, "../etc/passwd")).error.code, "unknown_path");
  assert.equal((await docs.append({ store, uid, path: "random.md", text: "x" })).error.code, "unknown_path");
  assert.deepEqual((await docs.read(store, uid, "notes/2026-11-04.md")).doc, { path: "notes/2026-11-04.md", content: "", version: 0, updatedAt: null, updatedBy: null });
});

test("the user's save creates a version attributed to the user, with diff counts", async () => {
  const { store, docs, of } = setup();
  const r = await docs.save({ store, uid, path: MEMORY, content: "# MEMORY.md\n\n- Likes tea\n", expectedVersion: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual([r.doc.version, r.doc.updatedBy, r.diff.added, r.diff.removed], [2, "user", 1, 0]);
  assert.equal(of("memory_write").at(-1).by, "user");
});

test("saving identical content changes nothing", async () => {
  const { store, docs } = setup();
  const r = await docs.save({ store, uid, path: MEMORY, content: TEMPLATES[MEMORY], expectedVersion: 1 });
  assert.equal(r.unchanged, true);
  assert.equal((await docs.read(store, uid, MEMORY)).doc.version, 1);
});

test("the agent can append and edit; both are attributed to the agent", async () => {
  const { store, docs } = setup();
  const a = await docs.append({ store, uid, path: MEMORY, text: "- Prefers short answers", runId: "run-1", ctx: { thread_id: "t1" } });
  assert.deepEqual([a.ok, a.doc.updatedBy, a.doc.runId], [true, "agent", "run-1"]);
  assert.match(a.doc.content, /- Prefers short answers\n$/);
  const e = await docs.edit({ store, uid, path: MEMORY, find: "short answers", replace: "brief answers" });
  assert.equal(e.ok, true);
  assert.match(e.doc.content, /brief answers/);
  assert.equal(e.doc.version, 3);
});

test("an agent edit keeps unrelated edits the user made (it is a find-and-replace on the current text)", async () => {
  const { store, docs } = setup();
  await docs.append({ store, uid, path: MEMORY, text: "- Fact A\n- Fact B" });
  const v = (await docs.read(store, uid, MEMORY)).doc.version;
  await docs.save({ store, uid, path: MEMORY, content: (await docs.read(store, uid, MEMORY)).doc.content + "- Fact C (added by the user)\n", expectedVersion: v });
  const r = await docs.edit({ store, uid, path: MEMORY, find: "Fact A", replace: "Fact A, updated" });
  assert.equal(r.ok, true);
  assert.match(r.doc.content, /Fact A, updated/);
  assert.match(r.doc.content, /Fact C \(added by the user\)/, "the user's line survived");
});

test("an agent edit whose text the user has changed writes nothing and says to re-read", async () => {
  const { store, docs } = setup();
  await docs.append({ store, uid, path: MEMORY, text: "- Lives in Paris" });
  const cur = (await docs.read(store, uid, MEMORY)).doc;
  await docs.save({ store, uid, path: MEMORY, content: cur.content.replace("Paris", "Lyon"), expectedVersion: cur.version });
  const before = (await docs.read(store, uid, MEMORY)).doc;
  const r = await docs.edit({ store, uid, path: MEMORY, find: "Lives in Paris", replace: "Lives in Nice" });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "not_found");
  assert.match(r.error.message, /Read the file again/);
  assert.deepEqual((await docs.read(store, uid, MEMORY)).doc, before, "nothing was written");
});

test("an ambiguous or empty find is refused", async () => {
  const { store, docs } = setup();
  await docs.append({ store, uid, path: MEMORY, text: "- tea\n- tea" });
  assert.equal((await docs.edit({ store, uid, path: MEMORY, find: "tea", replace: "coffee" })).error.code, "ambiguous");
  assert.equal((await docs.edit({ store, uid, path: MEMORY, find: "", replace: "x" })).error.code, "empty");
});

test("a user's save based on an out-of-date version is refused with both sides available", async () => {
  const { store, docs, of } = setup();
  const opened = (await docs.read(store, uid, MEMORY)).doc; // the user opens version 1
  await docs.append({ store, uid, path: MEMORY, text: "- the agent added this" }); // the agent writes version 2
  const r = await docs.save({ store, uid, path: MEMORY, content: opened.content + "- the user's change\n", expectedVersion: opened.version });
  assert.equal(r.ok, false);
  assert.match(r.conflict.current.content, /the agent added this/);
  assert.ok(r.conflict.diff.lines.some((l) => l.op === "-" && /the agent added this/.test(l.text)), "the diff shows what taking the user's version would drop");
  assert.equal((await docs.read(store, uid, MEMORY)).doc.version, 2, "nothing was overwritten");
  assert.equal(of("memory_conflict").length, 1);
});

test("a save without an expected version (the user chose 'keep mine') is applied", async () => {
  const { store, docs } = setup();
  await docs.append({ store, uid, path: MEMORY, text: "- agent" });
  const r = await docs.save({ store, uid, path: MEMORY, content: "# MEMORY.md\n\n- mine only\n" });
  assert.equal(r.ok, true);
  assert.equal(r.doc.version, 3);
});

test("secrets: blocked for the agent (reason logged, value never logged), only a warning for the user", async () => {
  const { store, docs, events, of } = setup();
  const card = "4242 4242 4242 4242";
  const agent = await docs.append({ store, uid, path: MEMORY, text: `- card ${card}` });
  assert.deepEqual([agent.ok, agent.blocked.reason, agent.blocked.kinds], [false, "secret", ["card_number"]]);
  assert.equal((await docs.read(store, uid, MEMORY)).doc.version, 1);
  const agentEdit = await docs.edit({ store, uid, path: MEMORY, find: "# MEMORY.md", replace: "password: hunter2hunter2" });
  assert.equal(agentEdit.blocked.reason, "secret");
  assert.equal(of("memory_blocked").length, 2);

  const user = await docs.save({ store, uid, path: MEMORY, content: `# MEMORY.md\n\nmy card ${card}\n`, expectedVersion: 1 });
  assert.equal(user.ok, true, "the user's own file is never refused");
  assert.deepEqual(user.warnings, [{ code: "secret", kinds: ["card_number"] }]);
  assert.ok(!JSON.stringify(events).includes("4242"), "the secret value is not in the telemetry");
});

test("a user warning is only about what the save adds, not secrets already in the file", async () => {
  const { store, docs } = setup();
  const first = await docs.save({ store, uid, path: MEMORY, content: "# MEMORY.md\n\npassword: correct-horse-battery\n", expectedVersion: 1 });
  assert.equal(first.warnings.length, 1);
  const second = await docs.save({ store, uid, path: MEMORY, content: first.doc.content + "- plain fact\n", expectedVersion: first.doc.version });
  assert.deepEqual(second.warnings, []);
});

test("size: the agent cannot grow a file past the limit; the user only gets a warning", async () => {
  const { store, docs, of } = setup({ limits: { maxChars: 200 } });
  const big = "x".repeat(300);
  const agent = await docs.append({ store, uid, path: MEMORY, text: big });
  assert.deepEqual([agent.ok, agent.blocked.reason], [false, "too_large"]);
  const user = await docs.save({ store, uid, path: MEMORY, content: `# MEMORY.md\n\n${big}\n`, expectedVersion: 1 });
  assert.equal(user.ok, true);
  assert.equal(user.warnings[0].code, "too_large");
  assert.equal(of("memory_blocked").length, 1);
});

test("history records who made each version; restore writes an old version as a NEW version", async () => {
  const { store, docs, of } = setup();
  await docs.append({ store, uid, path: MEMORY, text: "- agent fact", runId: "r1" });
  const cur = (await docs.read(store, uid, MEMORY)).doc;
  await docs.save({ store, uid, path: MEMORY, content: cur.content + "- user fact\n", expectedVersion: cur.version });
  const h = await docs.history(store, uid, MEMORY);
  assert.deepEqual(h.map((v) => [v.version, v.updatedBy]), [[3, "user"], [2, "agent"], [1, "template"]]);
  assert.equal(h[1].runId, "r1");

  const undoUser = await docs.restore({ store, uid, path: MEMORY, toVersion: 2, by: "user" });
  assert.equal(undoUser.doc.version, 4);
  assert.doesNotMatch(undoUser.doc.content, /user fact/);
  assert.match(undoUser.doc.content, /agent fact/);
  const undoAgent = await docs.restore({ store, uid, path: MEMORY, toVersion: 1, by: "user" });
  assert.doesNotMatch(undoAgent.doc.content, /agent fact/, "an agent change can be undone too");
  assert.equal((await docs.history(store, uid, MEMORY)).length, 5, "history only grows");
  assert.equal(of("memory_undo").length, 2);
  assert.equal((await docs.restore({ store, uid, path: MEMORY, toVersion: 99 })).error.code, "not_found");
});

test("changesSince separates the user's edits from everyone else's", async () => {
  const { store, docs } = setup();
  await docs.append({ store, uid, path: MEMORY, text: "- a" });
  const seen = (await docs.read(store, uid, MEMORY)).doc.version;
  const cur = (await docs.read(store, uid, MEMORY)).doc;
  await docs.save({ store, uid, path: MEMORY, content: cur.content + "- b\n- c\n", expectedVersion: cur.version });
  await docs.append({ store, uid, path: MEMORY, text: "- d" });
  const c = await docs.changesSince(store, uid, MEMORY, seen);
  assert.deepEqual(c.byUser, { count: 1, added: 2, removed: 0 });
  assert.deepEqual(c.byOthers, { count: 1, added: 1, removed: 0 });
  assert.deepEqual((await docs.changesSince(store, uid, MEMORY, c.latest)).byUser.count, 0);
});

test("concurrent writes to one file are serialized: no update is lost", async () => {
  const { store, docs } = setup();
  await Promise.all(Array.from({ length: 12 }, (_, i) => docs.append({ store, uid, path: MEMORY, text: `- fact ${i}` })));
  const doc = (await docs.read(store, uid, MEMORY)).doc;
  for (let i = 0; i < 12; i++) assert.match(doc.content, new RegExp(`- fact ${i}\\n`));
  assert.equal(doc.version, 13);
});

test("list returns SOUL.md and MEMORY.md first, then notes", async () => {
  const { store, docs } = setup();
  await docs.append({ store, uid, path: "notes/2026-11-04.md", text: "09:00 did a thing" });
  assert.deepEqual((await docs.list(store, uid)).map((f) => f.path), [SOUL, MEMORY, "notes/2026-11-04.md"]);
});

test("different users do not see each other's documents", async () => {
  const { store, docs } = setup();
  await docs.append({ store, uid: "alice", path: MEMORY, text: "- alice secret-free fact" });
  assert.doesNotMatch((await docs.read(store, "bob", MEMORY)).doc.content, /alice/);
});

test("the line diff counts additions and removals", () => {
  const d = diffLines("a\nb\nc\n", "a\nB\nc\nd\n");
  assert.deepEqual([d.added, d.removed], [2, 1]);
  assert.deepEqual(diffLines("", "x\n").added, 1);
});

test("the secret scanner finds real secrets and ignores ordinary text and ids", () => {
  assert.deepEqual(scanSecrets("card 4111 1111 1111 1111"), ["card_number"]);
  assert.deepEqual(scanSecrets("order 1234 5678 9012 3456"), [], "digits that fail the Luhn check are not a card");
  assert.ok(scanSecrets("Authorization: Bearer abcdef0123456789abcdef").includes("bearer_token"));
  assert.ok(scanSecrets("api_key = sk_live_abcdefghijklmnop1234").length >= 1);
  assert.ok(scanSecrets("https://user:hunter2@example.com/x").includes("credentials_in_url"));
  assert.ok(scanSecrets("your verification code is 482913").includes("one_time_code"));
  assert.deepEqual(scanSecrets("Vercel project prj_Ab3dEf6hIj9kLm2nOp5qRs8tUv1w deployed 2026-10-20 at https://my-project.vercel.app"), []);
  assert.deepEqual(scanSecrets("Prefers short answers and dark mode"), []);
});
