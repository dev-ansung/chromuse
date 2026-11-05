import test from "node:test";
import assert from "node:assert/strict";
import { canUndoNotice, initialDocumentsState as s0, isDirty, MAX_NOTICES, reduceDocuments } from "../src/lib/documents-state.ts";

const doc = (version, content = `v${version}`, path = "MEMORY.md") => ({ path, content, version, updatedAt: "2026-11-04T12:00:00.000Z", updatedBy: "user" });
const meta = (path, version) => ({ path, version, updatedAt: null, updatedBy: "template", chars: 10 });
const notice = (over = {}) => ({ id: "n1", path: "MEMORY.md", version: 3, added: 1, removed: 0, soul: false, at: "2026-11-04T12:00:00.000Z", ...over });
const open = (state = s0, d = doc(2)) => reduceDocuments(reduceDocuments(state, { type: "opening", path: d.path }), { type: "doc_loaded", doc: d, history: [] });

test("opening a file clears the previous file's problems; loading it fills the editor and the file list entry", () => {
  let s = reduceDocuments(s0, { type: "files_loaded", files: [meta("SOUL.md", 1), meta("MEMORY.md", 1)] });
  s = { ...s, error: "old", warnings: [{ code: "secret", kinds: ["jwt"] }], conflict: { current: doc(9), diff: { added: 0, removed: 0, lines: [] } } };
  s = reduceDocuments(s, { type: "opening", path: "MEMORY.md" });
  assert.deepEqual([s.path, s.loading, s.error, s.warnings, s.conflict, s.doc], ["MEMORY.md", true, null, [], null, null]);
  s = reduceDocuments(s, { type: "doc_loaded", doc: doc(2, "hello"), history: [] });
  assert.deepEqual([s.loading, s.draft, s.doc.version, s.files.find((f) => f.path === "MEMORY.md").version], [false, "hello", 2, 2]);
});

test("the editor is dirty only when the text differs from the server's copy", () => {
  let s = open();
  assert.equal(isDirty(s), false);
  s = reduceDocuments(s, { type: "draft_changed", text: "v2 edited" });
  assert.equal(isDirty(s), true);
  s = reduceDocuments(s, { type: "draft_changed", text: "v2" });
  assert.equal(isDirty(s), false);
  assert.equal(isDirty(s0), false);
});

test("a successful save adopts the server's copy, keeps warnings, and bumps the file entry", () => {
  let s = reduceDocuments(open(), { type: "files_loaded", files: [meta("MEMORY.md", 2)] });
  s = reduceDocuments(reduceDocuments(s, { type: "draft_changed", text: "new" }), { type: "saving" });
  assert.equal(s.saving, true);
  s = reduceDocuments(s, { type: "saved", doc: doc(3, "new"), warnings: [{ code: "secret", kinds: ["jwt"] }] });
  assert.deepEqual([s.saving, s.doc.version, s.draft, s.warnings.length, s.files[0].version, isDirty(s)], [false, 3, "new", 1, 3, false]);
});

test("a conflict keeps the user's text and shows the server's current version; nothing is overwritten", () => {
  let s = reduceDocuments(open(), { type: "draft_changed", text: "my edit" });
  s = reduceDocuments(s, { type: "saving" });
  s = reduceDocuments(s, { type: "conflict", conflict: { current: doc(3, "agent text"), diff: { added: 1, removed: 1, lines: [] } } });
  assert.deepEqual([s.saving, s.draft, s.doc.version, s.conflict.current.version], [false, "my edit", 2, 3]);
  assert.equal(reduceDocuments(s, { type: "conflict_cleared" }).conflict, null);
});

test("an agent change adds a notice (newest first, capped), bumps the file entry, and flags unsaved edits on the open file", () => {
  let s = reduceDocuments(open(), { type: "files_loaded", files: [meta("MEMORY.md", 2)] });
  s = reduceDocuments(s, { type: "agent_changed", notice: notice({ id: "a", version: 3 }) });
  assert.deepEqual([s.notices.map((n) => n.id), s.files[0].version, s.files[0].updatedBy, s.changedUnderneath], [["a"], 3, "agent", false]);
  s = reduceDocuments(reduceDocuments(s, { type: "draft_changed", text: "unsaved" }), { type: "agent_changed", notice: notice({ id: "b", version: 4 }) });
  assert.deepEqual([s.notices.map((n) => n.id), s.changedUnderneath], [["b", "a"], true]);
  const other = reduceDocuments(reduceDocuments(open(), { type: "draft_changed", text: "unsaved" }), { type: "agent_changed", notice: notice({ path: "SOUL.md" }) });
  assert.equal(other.changedUnderneath, false, "a change to a different file is not a problem for this editor");
  let many = s0;
  for (let i = 0; i < MAX_NOTICES + 5; i++) many = reduceDocuments(many, { type: "agent_changed", notice: notice({ id: `n${i}` }) });
  assert.equal(many.notices.length, MAX_NOTICES);
  assert.equal(many.notices[0].id, `n${MAX_NOTICES + 4}`);
});

test("loading or saving clears the 'changed underneath' flag; dismissing removes a notice", () => {
  let s = reduceDocuments(reduceDocuments(open(), { type: "draft_changed", text: "x" }), { type: "agent_changed", notice: notice() });
  assert.equal(s.changedUnderneath, true);
  assert.equal(reduceDocuments(s, { type: "doc_loaded", doc: doc(4), history: [] }).changedUnderneath, false);
  assert.equal(reduceDocuments(s, { type: "saved", doc: doc(4), warnings: [] }).changedUnderneath, false);
  assert.deepEqual(reduceDocuments(s, { type: "notice_dismissed", id: "n1" }).notices, []);
});

test("undo is offered only while the agent's change is still the latest version", () => {
  let s = reduceDocuments(s0, { type: "files_loaded", files: [meta("MEMORY.md", 3)] });
  assert.equal(canUndoNotice(s, notice({ version: 3 })), true);
  s = reduceDocuments(s, { type: "files_loaded", files: [meta("MEMORY.md", 4)] }); // someone (the user) changed it afterwards
  assert.equal(canUndoNotice(s, notice({ version: 3 })), false, "undoing would discard the later edit");
  assert.equal(canUndoNotice(s0, notice()), false, "an unknown file cannot be undone");
});

test("a failure stops loading and saving and keeps the message", () => {
  const s = reduceDocuments(reduceDocuments(open(), { type: "saving" }), { type: "failed", message: "network down" });
  assert.deepEqual([s.saving, s.loading, s.error], [false, false, "network down"]);
});
