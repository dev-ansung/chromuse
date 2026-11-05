// The Documents panel's flows with a fake server API: no network, no React.

import test from "node:test";
import assert from "node:assert/strict";
import { createDocumentsController } from "../src/lib/documents-controller.ts";
import { initialDocumentsState, isDirty, reduceDocuments } from "../src/lib/documents-state.ts";

const docOf = (path, version, content = `${path} v${version}`) => ({ path, content, version, updatedAt: "2026-11-04T12:00:00.000Z", updatedBy: "user" });
const meta = (d) => ({ path: d.path, version: d.version, updatedAt: d.updatedAt, updatedBy: d.updatedBy, chars: d.content.length });
const ver = (path, version, by = "user") => ({ path, version, updatedBy: by, updatedAt: "2026-11-04T12:00:00.000Z", added: 1, removed: 0, chars: 5 });
const DIFF = { added: 1, removed: 1, lines: [{ op: "-", text: "old" }, { op: "+", text: "new" }] };

/** A tiny in-memory server that behaves like the documents graph (versions, stale-save conflicts, restore). */
function fakeServer() {
  const files = { "SOUL.md": docOf("SOUL.md", 1, "soul"), "MEMORY.md": docOf("MEMORY.md", 1, "memory") };
  const calls = [];
  const bump = (path, content, by) => (files[path] = { ...files[path], content, version: files[path].version + 1, updatedBy: by });
  const api = {
    list: async () => (calls.push("list"), Object.values(files).map(meta)),
    read: async (path) => (calls.push(`read ${path}`), { kind: "ok", doc: files[path], diff: null, warnings: [], unchanged: false }),
    save: async (path, content, expected) => {
      calls.push(`save ${path} expected=${expected}`);
      if (expected !== undefined && files[path].version !== expected) return { kind: "conflict", current: files[path], diff: DIFF };
      return { kind: "ok", doc: bump(path, content, "user"), diff: DIFF, warnings: [], unchanged: false };
    },
    history: async (path) => (calls.push(`history ${path}`), Array.from({ length: files[path].version }, (_, i) => ver(path, files[path].version - i))),
    restore: async (path, to) => (calls.push(`restore ${path} ${to}`), { kind: "ok", doc: bump(path, `restored v${to}`, "user"), diff: DIFF, warnings: [], unchanged: false }),
  };
  return { files, calls, api, agentWrites: (path, content) => bump(path, content, "agent") };
}

function harness(over = {}) {
  const server = fakeServer();
  let state = initialDocumentsState;
  let n = 0;
  const controller = createDocumentsController({
    api: { ...server.api, ...over },
    dispatch: (a) => (state = reduceDocuments(state, a)),
    getState: () => state,
    newId: () => `n${++n}`,
    now: () => "2026-11-04T12:00:00.000Z",
  });
  return { controller, server, state: () => state };
}
const agentEvent = (path, version, soul = false) => ({ kind: "memory_change", path, version, by: "agent", added: 1, removed: 0, soul });

test("the first load lists the files and opens SOUL.md", async () => {
  const h = harness();
  await h.controller.load();
  assert.deepEqual(h.state().files.map((f) => f.path), ["SOUL.md", "MEMORY.md"]);
  assert.deepEqual([h.state().path, h.state().draft, h.state().history.length], ["SOUL.md", "soul", 1]);
});

test("a load does not reopen a file the user already chose", async () => {
  const h = harness();
  await h.controller.open("MEMORY.md");
  await h.controller.load();
  assert.equal(h.state().path, "MEMORY.md");
});

test("editing then saving sends the version that was opened and adopts the server's copy", async () => {
  const h = harness();
  await h.controller.open("MEMORY.md");
  h.controller.edit("memory plus my line");
  assert.equal(isDirty(h.state()), true);
  await h.controller.save();
  assert.ok(h.server.calls.includes("save MEMORY.md expected=1"));
  assert.deepEqual([h.state().doc.version, isDirty(h.state()), h.state().history[0].version], [2, false, 2]);
});

test("saving a stale version raises a conflict, keeps the user's text, and writes nothing", async () => {
  const h = harness();
  await h.controller.open("MEMORY.md");
  h.controller.edit("my edit");
  h.server.agentWrites("MEMORY.md", "agent's line"); // the agent writes version 2 behind the user's back
  await h.controller.save();
  assert.equal(h.state().conflict.current.version, 2);
  assert.equal(h.state().draft, "my edit");
  assert.equal(h.server.files["MEMORY.md"].content, "agent's line", "the server still has the agent's version");
});

test("'keep mine' saves the user's text over the agent's (no expected version); 'take theirs' shows the agent's version and drops the draft", async () => {
  const mine = harness();
  await mine.controller.open("MEMORY.md");
  mine.controller.edit("my edit");
  mine.server.agentWrites("MEMORY.md", "agent's line");
  await mine.controller.save();
  await mine.controller.keepMine();
  assert.ok(mine.server.calls.includes("save MEMORY.md expected=undefined"));
  assert.deepEqual([mine.server.files["MEMORY.md"].content, mine.state().conflict, isDirty(mine.state())], ["my edit", null, false]);

  const theirs = harness();
  await theirs.controller.open("MEMORY.md");
  theirs.controller.edit("my edit");
  theirs.server.agentWrites("MEMORY.md", "agent's line");
  await theirs.controller.save();
  await theirs.controller.takeTheirs();
  assert.deepEqual([theirs.state().draft, theirs.state().doc.content, theirs.state().conflict, theirs.server.files["MEMORY.md"].content], ["agent's line", "agent's line", null, "agent's line"]);
});

test("'keep editing' dismisses the conflict and leaves the text alone", async () => {
  const h = harness();
  await h.controller.open("MEMORY.md");
  h.controller.edit("my edit");
  h.server.agentWrites("MEMORY.md", "agent");
  await h.controller.save();
  h.controller.cancelConflict();
  assert.deepEqual([h.state().conflict, h.state().draft], [null, "my edit"]);
});

test("revert puts the server's text back in the editor", async () => {
  const h = harness();
  await h.controller.open("MEMORY.md");
  h.controller.edit("oops");
  h.controller.revertDraft();
  assert.equal(h.state().draft, "memory");
});

test("restoring an old version writes it as a new version and reloads", async () => {
  const h = harness();
  await h.controller.open("MEMORY.md");
  await h.controller.restore(1);
  assert.ok(h.server.calls.includes("restore MEMORY.md 1"));
  assert.deepEqual([h.state().doc.content, h.state().doc.version, h.state().saving], ["restored v1", 2, false]);
});

test("an agent change to the open file with nothing unsaved reloads it; with unsaved edits it only warns", async () => {
  const clean = harness();
  await clean.controller.open("MEMORY.md");
  clean.server.agentWrites("MEMORY.md", "agent wrote this");
  await clean.controller.onAgentChange(agentEvent("MEMORY.md", 2));
  assert.deepEqual([clean.state().draft, clean.state().notices.length, clean.state().changedUnderneath], ["agent wrote this", 1, false]);

  const dirty = harness();
  await dirty.controller.open("MEMORY.md");
  dirty.controller.edit("my unsaved edit");
  dirty.server.agentWrites("MEMORY.md", "agent wrote this");
  await dirty.controller.onAgentChange(agentEvent("MEMORY.md", 2));
  assert.deepEqual([dirty.state().draft, dirty.state().changedUnderneath, dirty.state().notices.length], ["my unsaved edit", true, 1], "the user's text is never replaced under them");
});

test("an agent change to a file that is not open, or not listed yet, is noted without disturbing the editor", async () => {
  const h = harness();
  await h.controller.open("MEMORY.md");
  h.controller.edit("typing");
  h.server.files["notes/2026-11-04.md"] = docOf("notes/2026-11-04.md", 1, "note");
  await h.controller.onAgentChange(agentEvent("notes/2026-11-04.md", 1));
  assert.deepEqual([h.state().draft, h.state().path, h.state().changedUnderneath], ["typing", "MEMORY.md", false]);
  assert.ok(h.state().files.some((f) => f.path === "notes/2026-11-04.md"), "the new file appears in the list");
});

test("undoing the agent's change restores the version before it, dismisses the notice, and refreshes the open file", async () => {
  const h = harness();
  await h.controller.open("MEMORY.md");
  h.server.agentWrites("MEMORY.md", "agent wrote this");
  await h.controller.onAgentChange(agentEvent("MEMORY.md", 2));
  const notice = h.state().notices[0];
  await h.controller.undoNotice(notice);
  assert.ok(h.server.calls.includes("restore MEMORY.md 1"));
  assert.deepEqual([h.state().notices.length, h.state().doc.content], [0, "restored v1"]);
});

test("undo does nothing when a later edit exists (it would discard it)", async () => {
  const h = harness();
  await h.controller.open("MEMORY.md");
  h.server.agentWrites("MEMORY.md", "agent wrote this");
  await h.controller.onAgentChange(agentEvent("MEMORY.md", 2));
  const notice = h.state().notices[0];
  h.controller.edit("user edit");
  await h.controller.save(); // version 3: the user edited after the agent
  const before = h.server.calls.length;
  await h.controller.undoNotice(notice);
  assert.equal(h.server.calls.length, before, "no restore call was made");
  assert.equal(h.server.files["MEMORY.md"].content, "user edit");
});

test("failures from the server or the network surface as an error, not an exception", async () => {
  const h = harness({ read: async () => { throw new Error("network down"); } });
  await h.controller.open("MEMORY.md");
  assert.deepEqual([h.state().loading, h.state().error], [false, "network down"]);

  const bad = harness({ save: async () => ({ kind: "error", code: "unknown_path", message: "no such file" }) });
  await bad.controller.open("MEMORY.md");
  bad.controller.edit("x");
  await bad.controller.save();
  assert.deepEqual([bad.state().saving, bad.state().error], [false, "no such file"]);
});

test("the dismiss button removes a notice", async () => {
  const h = harness();
  await h.controller.onAgentChange(agentEvent("SOUL.md", 2, true));
  assert.equal(h.state().notices[0].soul, true);
  h.controller.dismissNotice(h.state().notices[0].id);
  assert.deepEqual(h.state().notices, []);
});
