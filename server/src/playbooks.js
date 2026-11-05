// Playbooks: how the agent solved a task before, kept outside the context window and found again by meaning (local embeddings).
// A playbook is steps in words (element labels and roles, never uids), the pitfalls met, and counts of how it worked out.
//
// Layout:  ["users", uid, "playbooks"]   key = id -> { id, title, situation, hosts, steps, pitfalls, embedding, uses, worked, failed, createdAt, updatedAt, lastUsedAt, by }
//
// Results are plain objects: { ok: true, playbook, merged? } | { ok: false, blocked: { reason: "secret", kinds } } | { ok: false, error: { code, message } }

import { randomUUID } from "node:crypto";
import { cosine } from "./embeddings.js";
import { scanSecrets } from "./secrets.js";
import { noopTelemetry } from "./telemetry.js";

const ns = (uid) => ["users", uid, "playbooks"];
const fail = (code, message) => ({ ok: false, error: { code, message } });
const clean = (list) => [...new Set((list ?? []).map((s) => String(s).trim()).filter(Boolean))];
export const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
};
export const hostsOf = (urls) => clean(urls.map(hostOf));

/** What gets embedded: the situation, not the steps, so a new task is matched to the problem it resembles. */
const embedText = (p) => `${p.title}. ${p.situation} ${p.hosts.join(" ")}`;
/** Without the embedding, which is bulky and of no use to a reader. */
const strip = ({ embedding, ...rest }) => rest;

/**
 * @param {{ embedder: { embed(texts: string[]): Promise<number[][]> }, telemetry?: object, now?: () => Date, limits?: object }} opts
 * limits: minScore (a pointer is shown at or above it), recallMinScore, duplicateScore, hostBoost, trustWeight, maxPointers
 */
export function createPlaybooks({ embedder, telemetry = noopTelemetry, now = () => new Date(), limits = {} }) {
  const L = { minScore: 0.33, recallMinScore: 0.25, duplicateScore: 0.88, hostBoost: 0.08, trustWeight: 0.02, maxPointers: 3, maxSteps: 40, ...limits };

  async function all(store, uid) {
    return (await store.search(ns(uid), { limit: 1000 })).map((i) => i.value);
  }

  const list = async (store, uid) => (await all(store, uid)).map(strip).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const get = async (store, uid, id) => (await store.get(ns(uid), id))?.value;

  async function remove(store, uid, id) {
    const found = await get(store, uid, id);
    if (!found) return fail("not_found", "That playbook does not exist.");
    await store.delete(ns(uid), id);
    telemetry.event("playbook_deleted", { id }, {});
    return { ok: true };
  }

  /** Creates a playbook, or updates the one it duplicates (same id, or a very close situation), keeping its counts. */
  async function save({ store, uid, input, by = "agent", ctx = {} }) {
    const title = String(input.title ?? "").trim();
    const situation = String(input.situation ?? "").trim();
    const steps = clean(input.steps).slice(0, L.maxSteps);
    if (!title || !situation) return fail("invalid", "A playbook needs a title and a situation.");
    if (!steps.length) return fail("invalid", "A playbook needs at least one step.");
    const pitfalls = clean(input.pitfalls);
    const hosts = clean(input.hosts);

    const kinds = scanSecrets([title, situation, ...steps, ...pitfalls].join("\n"));
    if (kinds.length) {
      telemetry.event("playbook_blocked", { kinds }, ctx);
      return { ok: false, blocked: { reason: "secret", kinds } };
    }

    const draft = { title, situation, hosts, steps, pitfalls };
    const [embedding] = await embedder.embed([embedText(draft)]);
    const existing = await all(store, uid);
    let target = input.id ? existing.find((p) => p.id === input.id) : undefined;
    if (!target) {
      const best = existing.map((p) => ({ p, score: cosine(embedding, p.embedding) })).sort((a, b) => b.score - a.score)[0];
      if (best && best.score >= L.duplicateScore) target = best.p;
    }

    const at = now().toISOString();
    const playbook = target
      ? { ...target, ...draft, embedding, updatedAt: at, by }
      : { id: randomUUID(), ...draft, embedding, uses: 0, worked: 0, failed: 0, createdAt: at, updatedAt: at, lastUsedAt: null, by };
    await store.put(ns(uid), playbook.id, playbook);
    telemetry.event("playbook_saved", { id: playbook.id, title, merged: Boolean(target), steps: steps.length, by }, ctx);
    return { ok: true, playbook: strip(playbook), merged: Boolean(target) };
  }

  /** Playbooks that resemble the query, best first. Never throws: a retrieval problem means no playbooks, not a failed run. */
  async function search({ store, uid, query, hosts = [], minScore = L.minScore, limit = L.maxPointers, ctx = {} }) {
    try {
      const existing = await all(store, uid);
      if (!existing.length || !query.trim()) return [];
      const [q] = await embedder.embed([query]);
      const wanted = new Set(hosts);
      return existing
        .map((p) => {
          const trust = Math.max(-3, Math.min(3, p.worked - p.failed)) * L.trustWeight;
          const hostMatch = p.hosts.some((h) => wanted.has(h));
          return { playbook: strip(p), score: cosine(q, p.embedding) + (hostMatch ? L.hostBoost : 0) + trust, hostMatch };
        })
        .filter((r) => r.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch (err) {
      telemetry.event("memory_error", { phase: "playbook_search", error: { name: err?.name, message: err?.message } }, ctx);
      return [];
    }
  }

  async function update(store, uid, id, change) {
    const found = await get(store, uid, id);
    if (!found) return undefined;
    const next = { ...found, ...change(found), updatedAt: found.updatedAt };
    await store.put(ns(uid), id, next);
    return strip(next);
  }

  const recordUse = (store, uid, id) => update(store, uid, id, (p) => ({ uses: p.uses + 1, lastUsedAt: now().toISOString() }));
  const recordOutcome = (store, uid, id, worked) => update(store, uid, id, (p) => (worked ? { worked: p.worked + 1 } : { failed: p.failed + 1 }));

  return { list, get, remove, save, search, recordUse, recordOutcome, limits: L };
}
