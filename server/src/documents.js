// SOUL.md, MEMORY.md and daily notes: markdown documents that both the user and the agent can update.
// Every write, from either side, goes through the functions below so that versioning, attribution, conflict handling,
// secret handling and telemetry are identical. Functions take the LangGraph store explicitly (it is only available at run time).
//
// Layout:  ["users", uid, "files"]          key = path   -> the current document
//          ["users", uid, "file_versions"]  key = path@n -> every version's full content, who made it, and its diff counts
//
// Results are plain objects, never exceptions, for expected outcomes:
//   { ok: true, doc, diff, warnings, unchanged? }
//   { ok: false, conflict: { current, diff } }                 a save based on an out-of-date version (nothing written)
//   { ok: false, blocked: { reason, kinds? } }                 an agent write refused (secret, too_large)
//   { ok: false, error: { code, message } }                    bad input, text not found, ...

import { compactDiff, diffLines } from "./diff.js";
import { scanSecrets } from "./secrets.js";
import { noopTelemetry } from "./telemetry.js";

export const SOUL = "SOUL.md";
export const MEMORY = "MEMORY.md";
const NOTE_PATH = /^notes\/\d{4}-\d{2}-\d{2}\.md$/;
export const isAllowedPath = (path) => typeof path === "string" && (path === SOUL || path === MEMORY || NOTE_PATH.test(path));

const filesNs = (uid) => ["users", uid, "files"];
const versionsNs = (uid) => ["users", uid, "file_versions"];
const versionKey = (path, version) => `${path}@${version}`;

const fail = (code, message, extra = {}) => ({ ok: false, error: { code, message, ...extra } });
const compact = (d) => ({ added: d.added, removed: d.removed, lines: compactDiff(d.lines) });

/**
 * @param {{ templates?: Record<string, string>, telemetry?: object, limits?: { maxChars?: number, hardMaxChars?: number }, now?: () => Date }} [opts]
 */
export function createDocuments({ templates = {}, telemetry = noopTelemetry, limits = {}, now = () => new Date() } = {}) {
  const maxChars = limits.maxChars ?? 20_000; // the agent may not grow a file past this; the user only gets a warning
  const hardMaxChars = limits.hardMaxChars ?? 500_000; // sanity limit for anything

  // One writer at a time per file, so read-modify-write cannot lose an update.
  const tails = new Map();
  async function withLock(key, fn) {
    const prev = tails.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const tail = prev.then(() => gate);
    tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  }
  const lockKey = (uid, path) => `${uid}\u0000${path}`;

  async function getRaw(store, uid, path) {
    return (await store.get(filesNs(uid), path))?.value;
  }

  // The current document, creating it from its template the first time. Call only while holding the file's lock (or via read()).
  async function loadForWrite(store, uid, path) {
    const existing = await getRaw(store, uid, path);
    if (existing) return existing;
    const template = templates[path];
    if (template === undefined) return { path, content: "", version: 0, updatedAt: null, updatedBy: null }; // a note that does not exist yet
    const at = now().toISOString();
    const doc = { path, content: template, version: 1, updatedAt: at, updatedBy: "template" };
    const lines = template === "" ? 0 : template.replace(/\n$/, "").split("\n").length;
    await store.put(versionsNs(uid), versionKey(path, 1), { path, version: 1, content: template, updatedBy: "template", updatedAt: at, added: lines, removed: 0 });
    await store.put(filesNs(uid), path, doc);
    telemetry.event("memory_write", { path, version: 1, by: "template", added: lines, removed: 0, chars: template.length }, {});
    return doc;
  }

  async function commit(store, uid, path, cur, content, { by, runId, undoOf, ctx }) {
    const d = diffLines(cur.content, content);
    const version = cur.version + 1;
    const at = now().toISOString();
    const doc = { path, content, version, updatedAt: at, updatedBy: by, ...(runId ? { runId } : {}) };
    await store.put(versionsNs(uid), versionKey(path, version), {
      path, version, content, updatedBy: by, updatedAt: at, runId, added: d.added, removed: d.removed, ...(undoOf ? { undoOf } : {}),
    });
    await store.put(filesNs(uid), path, doc);
    telemetry.event("memory_write", { path, version, by, added: d.added, removed: d.removed, chars: content.length, ...(undoOf ? { undo_of: undoOf } : {}) }, ctx);
    return { doc, diff: compact(d) };
  }

  const blocked = (path, by, reason, extra, ctx) => {
    telemetry.event("memory_blocked", { path, by, reason, ...extra }, ctx);
    return { ok: false, blocked: { reason, ...extra } };
  };

  // ---- reads ----

  /** The current document (seeded from its template on first use). A note that does not exist yet reads as version 0, empty. */
  async function read(store, uid, path) {
    if (!isAllowedPath(path)) return fail("unknown_path", `"${path}" is not a memory file. Use SOUL.md, MEMORY.md or notes/YYYY-MM-DD.md.`);
    const existing = await getRaw(store, uid, path);
    if (existing) return { ok: true, doc: existing };
    if (templates[path] === undefined) return { ok: true, doc: { path, content: "", version: 0, updatedAt: null, updatedBy: null } };
    return { ok: true, doc: await withLock(lockKey(uid, path), () => loadForWrite(store, uid, path)) };
  }

  /** Metadata for every document (SOUL.md and MEMORY.md are created from their templates if missing). */
  async function list(store, uid) {
    for (const path of [SOUL, MEMORY]) if (templates[path] !== undefined) await read(store, uid, path);
    const items = await store.search(filesNs(uid), { limit: 500 });
    const order = (p) => (p === SOUL ? "0" : p === MEMORY ? "1" : `2${p}`);
    return items
      .map(({ value }) => ({ path: value.path, version: value.version, updatedAt: value.updatedAt, updatedBy: value.updatedBy, chars: value.content.length }))
      .sort((a, b) => (order(a.path) < order(b.path) ? -1 : 1));
  }

  /** Version metadata, newest first (no content). */
  async function history(store, uid, path, limit = 100) {
    const items = await store.search(versionsNs(uid), { filter: { path }, limit: 1000 });
    return items
      .map(({ value }) => value)
      .sort((a, b) => b.version - a.version)
      .slice(0, limit)
      .map(({ content, ...meta }) => ({ ...meta, chars: content.length }));
  }

  async function readVersion(store, uid, path, version) {
    const item = await store.get(versionsNs(uid), versionKey(path, version));
    return item ? { ok: true, version: item.value } : fail("not_found", `${path} has no version ${version}.`);
  }

  /** What changed since a version, split into the user's changes and everyone else's. Used to tell the agent about user edits. */
  async function changesSince(store, uid, path, sinceVersion) {
    const all = await history(store, uid, path, 1000);
    const newer = all.filter((v) => v.version > sinceVersion);
    const sum = (list) => list.reduce((acc, v) => ({ count: acc.count + 1, added: acc.added + (v.added ?? 0), removed: acc.removed + (v.removed ?? 0) }), { count: 0, added: 0, removed: 0 });
    return { latest: all[0]?.version ?? 0, byUser: sum(newer.filter((v) => v.updatedBy === "user")), byOthers: sum(newer.filter((v) => v.updatedBy !== "user")), versions: newer };
  }

  // ---- writes ----

  /** The user's save of the whole document. Never rejected for content; refused only when it is based on an out-of-date version. */
  async function save({ store, uid, path, content, expectedVersion, by = "user", runId, ctx = {} }) {
    if (!isAllowedPath(path)) return fail("unknown_path", `"${path}" is not a memory file.`);
    if (typeof content !== "string") return fail("invalid_content", "content must be text.");
    if (content.length > hardMaxChars) return fail("too_large", `That is larger than the ${hardMaxChars} character limit.`);
    return withLock(lockKey(uid, path), async () => {
      const cur = await loadForWrite(store, uid, path);
      const d = diffLines(cur.content, content);
      if (expectedVersion !== undefined && cur.version !== expectedVersion) {
        telemetry.event("memory_conflict", { path, by, expected: expectedVersion, actual: cur.version }, ctx);
        return { ok: false, conflict: { current: cur, diff: compact(d) } };
      }
      if (content === cur.content) return { ok: true, unchanged: true, doc: cur, diff: { added: 0, removed: 0, lines: [] }, warnings: [] };
      const warnings = [];
      const kinds = scanSecrets(d.lines.filter((l) => l.op === "+").map((l) => l.text).join("\n")); // only what this save adds
      if (kinds.length) {
        warnings.push({ code: "secret", kinds });
        telemetry.event("memory_warning", { path, by, reason: "secret", kinds }, ctx);
      }
      if (content.length > maxChars) warnings.push({ code: "too_large", chars: content.length, max: maxChars });
      return { ok: true, ...(await commit(store, uid, path, cur, content, { by, runId, ctx })), warnings };
    });
  }

  /** The agent adds text at the end of a document. Blocked if it contains a secret or would make the file too large. */
  async function append({ store, uid, path, text, by = "agent", runId, ctx = {} }) {
    if (!isAllowedPath(path)) return fail("unknown_path", `"${path}" is not a memory file. Use SOUL.md, MEMORY.md or notes/YYYY-MM-DD.md.`);
    if (typeof text !== "string" || !text.trim()) return fail("empty", "There is nothing to add.");
    const kinds = scanSecrets(text);
    if (kinds.length) return blocked(path, by, "secret", { kinds }, ctx);
    return withLock(lockKey(uid, path), async () => {
      const cur = await loadForWrite(store, uid, path);
      const next = `${cur.content}${cur.content && !cur.content.endsWith("\n") ? "\n" : ""}${text.endsWith("\n") ? text : `${text}\n`}`;
      if (next.length > maxChars) return blocked(path, by, "too_large", { chars: next.length, max: maxChars }, ctx);
      return { ok: true, ...(await commit(store, uid, path, cur, next, { by, runId, ctx })), warnings: [] };
    });
  }

  /** The agent replaces one exact piece of text. Applied against the CURRENT content, so unrelated edits by the user are kept. */
  async function edit({ store, uid, path, find, replace, by = "agent", runId, ctx = {} }) {
    if (!isAllowedPath(path)) return fail("unknown_path", `"${path}" is not a memory file. Use SOUL.md, MEMORY.md or notes/YYYY-MM-DD.md.`);
    if (typeof find !== "string" || find === "") return fail("empty", "Say which text to replace.");
    if (typeof replace !== "string") return fail("invalid_content", "replace must be text (use an empty string to remove the text).");
    const kinds = scanSecrets(replace);
    if (kinds.length) return blocked(path, by, "secret", { kinds }, ctx);
    return withLock(lockKey(uid, path), async () => {
      const cur = await loadForWrite(store, uid, path);
      const first = cur.content.indexOf(find);
      if (first === -1) return fail("not_found", "That text is not in the file now (it may have been changed, for example by the user). Read the file again and retry.");
      if (cur.content.indexOf(find, first + find.length) !== -1) return fail("ambiguous", "That text appears more than once. Include more surrounding text so it matches exactly once.");
      const next = cur.content.slice(0, first) + replace + cur.content.slice(first + find.length);
      if (next.length > maxChars && next.length > cur.content.length) return blocked(path, by, "too_large", { chars: next.length, max: maxChars }, ctx);
      return { ok: true, ...(await commit(store, uid, path, cur, next, { by, runId, ctx })), warnings: [] };
    });
  }

  /** Writes an older version's content as a NEW version (history is never rewritten). */
  async function restore({ store, uid, path, toVersion, by = "user", runId, ctx = {} }) {
    if (!isAllowedPath(path)) return fail("unknown_path", `"${path}" is not a memory file.`);
    return withLock(lockKey(uid, path), async () => {
      const target = await readVersion(store, uid, path, toVersion);
      if (!target.ok) return target;
      const cur = await loadForWrite(store, uid, path);
      if (target.version.content === cur.content) return { ok: true, unchanged: true, doc: cur, diff: { added: 0, removed: 0, lines: [] }, warnings: [] };
      const result = await commit(store, uid, path, cur, target.version.content, { by, runId, undoOf: toVersion, ctx });
      telemetry.event("memory_undo", { path, by, restored_version: toVersion, new_version: result.doc.version }, ctx);
      return { ok: true, ...result, warnings: [] };
    });
  }

  return { read, list, history, readVersion, changesSince, save, append, edit, restore, isAllowedPath };
}
