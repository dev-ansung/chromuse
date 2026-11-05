import test from "node:test";
import assert from "node:assert/strict";
import { describeError, parseConnectState, parseCustomEvent, parseLiveResponse } from "../src/lib/parse.ts";

const TAB = { id: 1, title: "Inbox", url: "https://mail.test/", selected: true };

test("custom events from the agent are recognised", () => {
  assert.deepEqual(parseCustomEvent("custom", { kind: "tabs", tabs: [TAB] }), { kind: "tabs", tabs: [TAB] });
  assert.deepEqual(parseCustomEvent("custom", { kind: "warning", message: "careful" }), { kind: "warning", message: "careful" });
});

test("anything that is not one of ours is ignored, not trusted", () => {
  assert.equal(parseCustomEvent("updates", { kind: "tabs", tabs: [TAB] }), undefined);
  assert.equal(parseCustomEvent("custom", null), undefined);
  assert.equal(parseCustomEvent("custom", "hello"), undefined);
  assert.equal(parseCustomEvent("custom", { kind: "mystery" }), undefined);
  assert.equal(parseCustomEvent("custom", { kind: "tabs", tabs: [{ id: "1" }] }), undefined);
  assert.equal(parseCustomEvent("custom", { kind: "screenshot", tool: "click" }), undefined);
});

test("connect state: connected, error with hint, and an empty browser", () => {
  assert.deepEqual(parseConnectState({ status: "connected", tabs: [TAB] }), { status: "connected", tabs: [TAB] });
  assert.deepEqual(parseConnectState({ status: "error", tabs: [], error: "not running", hint: "enable it" }), {
    status: "error",
    tabs: [],
    error: "not running",
    hint: "enable it",
  });
  assert.deepEqual(parseConnectState({ status: "connected", tabs: [] }), { status: "connected", tabs: [] });
});

test("connect state: a malformed answer throws instead of rendering garbage", () => {
  assert.throws(() => parseConnectState(undefined), /no state/);
  assert.throws(() => parseConnectState({ status: "weird", tabs: [] }), /unknown status/);
  assert.throws(() => parseConnectState({ status: "connected", tabs: [{ id: 1 }] }), /unexpected shape/);
});

test("error descriptions", () => {
  assert.equal(describeError(new Error("boom")), "boom");
  assert.equal(describeError("plain"), "plain");
  assert.equal(describeError({ message: "from object" }), "from object");
  assert.equal(describeError({ code: 7 }), '{"code":7}');
});

const FRAME = { mime: "image/jpeg", data: "QUJD", pageId: 1, url: "https://mail.test/", title: "Inbox", takenAt: "2026-11-04T12:00:00.000Z" };

test("live view responses: a frame, no tab, and an error with its hint", () => {
  assert.deepEqual(parseLiveResponse({ ok: true, tabs: [TAB], frame: FRAME }), { ok: true, tabs: [TAB], frame: FRAME });
  assert.deepEqual(parseLiveResponse({ ok: true, tabs: [], frame: null }), { ok: true, tabs: [], frame: null });
  assert.deepEqual(parseLiveResponse({ ok: false, error: { message: "not running", hint: "enable it" } }), { ok: false, error: { message: "not running", hint: "enable it" } });
  assert.deepEqual(parseLiveResponse({ ok: false, error: { message: "not running" } }), { ok: false, error: { message: "not running" } });
});

test("live view responses: anything malformed throws instead of rendering garbage", () => {
  assert.throws(() => parseLiveResponse(undefined), /no data/);
  assert.throws(() => parseLiveResponse({ ok: "yes" }), /unexpected response/);
  assert.throws(() => parseLiveResponse({ ok: false, error: "boom" }), /unexpected shape/);
  assert.throws(() => parseLiveResponse({ ok: true, tabs: [{ id: 1 }], frame: null }), /tabs in an unexpected shape/);
  assert.throws(() => parseLiveResponse({ ok: true, tabs: [TAB], frame: { mime: "image/jpeg" } }), /screenshot in an unexpected shape/);
  assert.throws(() => parseLiveResponse({ ok: true, tabs: [TAB] }), /screenshot in an unexpected shape/, "a missing frame is not the same as null");
  assert.throws(() => parseLiveResponse({ ok: true, frame: FRAME }), /tabs in an unexpected shape/);
});

// ---- documents ----

import { parseDocOutcome, parseFileList, parseHistory } from "../src/lib/parse.ts";

const DOC = { path: "MEMORY.md", content: "# MEMORY.md\n", version: 2, updatedAt: "2026-11-04T12:00:00.000Z", updatedBy: "agent", runId: "r1" };
const DIFF = { added: 1, removed: 0, lines: [{ op: "+", text: "- x" }] };

test("memory_change events from the agent are recognised and validated", () => {
  const event = { kind: "memory_change", path: "SOUL.md", version: 3, by: "agent", added: 1, removed: 1, soul: true };
  assert.deepEqual(parseCustomEvent("custom", event), event);
  assert.equal(parseCustomEvent("custom", { ...event, soul: "yes" }), undefined);
  assert.equal(parseCustomEvent("custom", { kind: "memory_change", path: "SOUL.md" }), undefined);
});

test("document outcomes: ok (with diff and warnings), unchanged, conflict, and error", () => {
  const ok = parseDocOutcome({ ok: true, doc: DOC, diff: DIFF, warnings: [{ code: "secret", kinds: ["jwt"] }, { code: "too_large", chars: 30, max: 20 }] });
  assert.deepEqual([ok.kind, ok.doc.version, ok.diff.added, ok.warnings.length, ok.unchanged], ["ok", 2, 1, 2, false]);
  assert.equal(parseDocOutcome({ ok: true, doc: DOC, unchanged: true, diff: { added: 0, removed: 0, lines: [] }, warnings: [] }).unchanged, true);
  assert.equal(parseDocOutcome({ ok: true, doc: DOC }).diff, null, "a read has no diff");
  const conflict = parseDocOutcome({ ok: false, conflict: { current: DOC, diff: DIFF } });
  assert.deepEqual([conflict.kind, conflict.current.version], ["conflict", 2]);
  assert.deepEqual(parseDocOutcome({ ok: false, error: { code: "unknown_path", message: "no such file" } }), { kind: "error", code: "unknown_path", message: "no such file" });
});

test("document outcomes: anything malformed throws instead of rendering garbage", () => {
  assert.throws(() => parseDocOutcome(undefined), /no result/);
  assert.throws(() => parseDocOutcome({ ok: true, doc: { path: "MEMORY.md" } }), /document in an unexpected shape/);
  assert.throws(() => parseDocOutcome({ ok: true, doc: DOC, diff: { added: 1 } }), /diff in an unexpected shape/);
  assert.throws(() => parseDocOutcome({ ok: true, doc: DOC, warnings: [{ code: "mystery" }] }), /warning in an unexpected shape/);
  assert.throws(() => parseDocOutcome({ ok: false, error: "boom" }), /error in an unexpected shape/);
});

test("file lists and histories", () => {
  const files = parseFileList({ ok: true, files: [{ path: "SOUL.md", version: 1, updatedAt: null, updatedBy: "template", chars: 400 }] });
  assert.deepEqual(files, [{ path: "SOUL.md", version: 1, updatedAt: null, updatedBy: "template", chars: 400 }]);
  assert.throws(() => parseFileList({ ok: false, error: { message: "no store" } }), /no store/);
  assert.throws(() => parseFileList({ ok: true, files: [{ path: 1 }] }), /file entry/);

  const versions = parseHistory({ ok: true, versions: [{ path: "MEMORY.md", version: 3, updatedBy: "user", updatedAt: "2026-11-04T12:00:00.000Z", added: 2, removed: 1, chars: 90, undoOf: 1 }] });
  assert.deepEqual([versions[0].version, versions[0].undoOf, versions[0].runId], [3, 1, undefined]);
  assert.throws(() => parseHistory({ ok: true, versions: [{ version: 1 }] }), /version in an unexpected shape/);
});
