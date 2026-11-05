// Playbooks in the agent: a few short pointers in the prompt when the task resembles something solved before (nothing otherwise),
// three tools (recall_playbook, save_playbook, playbook_feedback), and a reflection after hard runs that drafts a playbook.
// The store, scoring and write rules are in playbooks.js.

import { z } from "zod";
import { createMiddleware, tool } from "langchain";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { hostsOf } from "./playbooks.js";
import { textOf } from "./text.js";
import { errorInfo, noopTelemetry } from "./telemetry.js";

const userIdOf = (configurable, fallback) => configurable?.user_id ?? fallback;
const clip = (text, max) => (String(text).length > max ? `${String(text).slice(0, max)}…` : String(text));
const firstSentence = (text) => clip(text.split(/(?<=[.!?])\s/)[0], 160);

/** Only the written text of message content: an attached image must not be read as text (it is a huge base64 string). */
const writtenText = (content) => (Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : textOf(content));

/** The task as the user wrote it: the last human message of the run. */
export function taskOf(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages[i];
    if ((m._getType?.() ?? m.type) === "human") return writtenText(m.content);
  }
  return "";
}

const record = (id, p) =>
  [
    `Playbook ${id}: ${p.title}`,
    `Use when: ${p.situation}`,
    p.hosts.length ? `Sites: ${p.hosts.join(", ")}` : "",
    "Steps:",
    ...p.steps.map((s, i) => `${i + 1}. ${s}`),
    p.pitfalls.length ? "Pitfalls:" : "",
    ...p.pitfalls.map((s) => `- ${s}`),
    `Track record: worked ${p.worked}, failed ${p.failed}. These are hints from earlier runs: check each step against the real page.`,
  ]
    .filter(Boolean)
    .join("\n");

/** Tool failures in a run: toolErrorMiddleware turns them into "Error from <tool>: ..." messages. */
const failed = (m) => m.status === "error" || /^Error from /.test(textOf(m.content));

/** A compact transcript of a run for the reflection call. */
function transcript(messages, maxChars) {
  const lines = [];
  for (const m of messages) {
    const type = m._getType?.() ?? m.type;
    if (type === "human") lines.push(`TASK: ${clip(writtenText(m.content), 600)}`);
    else if (type === "ai") {
      for (const c of m.tool_calls ?? []) lines.push(`CALL ${c.name} ${clip(JSON.stringify(c.args), 200)}`);
      const text = textOf(m.content).trim();
      if (text && !m.tool_calls?.length) lines.push(`FINAL ANSWER: ${clip(text, 800)}`);
    } else if (type === "tool") lines.push(`${failed(m) ? "FAILED" : "RESULT"} ${m.name ?? ""}: ${clip(textOf(m.content).replace(/\s+/g, " "), 240)}`);
  }
  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars / 2)}\n[… middle of the run left out …]\n${text.slice(-maxChars / 2)}` : text;
}

const parseJson = (text) => {
  const body = text.match(/\{[\s\S]*\}/)?.[0];
  return body ? JSON.parse(body) : undefined;
};

/**
 * Pointers before the run, reflection after it.
 * Put it AFTER the browser middleware: it reads the selected tab that middleware puts in state.
 */
export function playbooksMiddleware({ playbooks, config, model, template, reflectPrompt, telemetry = noopTelemetry }) {
  const P = config.playbooks;
  return createMiddleware({
    name: "Playbooks",
    stateSchema: z.object({ playbookPrompt: z.string().optional() }),

    beforeAgent: async (state, runtime) => {
      const ctx = { thread_id: runtime.configurable?.thread_id };
      try {
        if (!runtime.store) throw new Error("no store is available to this run");
        const uid = userIdOf(runtime.configurable, config.memory.userId);
        const task = taskOf(state.messages);
        const selected = state.tabs?.find((t) => t.selected);
        const hosts = hostsOf([selected?.url, ...(task.match(/https?:\/\/\S+/g) ?? [])].filter(Boolean));
        const started = telemetry.now();
        const found = await playbooks.search({ store: runtime.store, uid, query: task, hosts, ctx });
        telemetry.event("playbook_search", { ms: telemetry.now() - started, matches: found.map((r) => ({ id: r.playbook.id, score: Number(r.score.toFixed(3)) })) }, ctx);
        if (!found.length) return { playbookPrompt: "" };
        const pointers = found.map((r) => `- ${r.playbook.id} — ${r.playbook.title}: ${firstSentence(r.playbook.situation)} (worked ${r.playbook.worked}, failed ${r.playbook.failed})`).join("\n");
        return { playbookPrompt: template.replace("{{pointers}}", () => `Possibly relevant playbooks:\n${pointers}`).trim() };
      } catch (err) {
        telemetry.event("memory_error", { phase: "playbook_read", error: errorInfo(err) }, ctx);
        return { playbookPrompt: "" };
      }
    },

    // With no match this adds nothing: the playbook instructions are only in the prompt when there is something to recall.
    wrapModelCall: (request, handler) => {
      const text = request.state?.playbookPrompt;
      if (!text) return handler(request);
      return handler({ ...request, systemMessage: new SystemMessage(`${request.systemPrompt}\n\n${text}`) });
    },

    // After a run that took trial and error (or many steps), ask the model whether it is worth keeping, and keep it.
    // The answer is already on the user's screen by now, and the run (and the chat box) stays busy until this hook returns,
    // so the model call is started in the BACKGROUND and the hook returns at once. It reports through telemetry only.
    afterAgent: (state, runtime) => {
      const ctx = { thread_id: runtime.configurable?.thread_id };
      try {
        if (!P.reflect || !runtime.store) return;
        if (state.messages.some((m) => m.tool_calls?.some((c) => c.name === "save_playbook"))) return; // the agent already saved one
        const calls = state.messages.filter((m) => (m._getType?.() ?? m.type) === "tool");
        const errors = calls.filter(failed).length;
        const hard = calls.length >= P.reflectMinToolCalls || (errors > 0 && calls.length >= P.reflectMinToolCallsWithErrors);
        if (!hard) return;
        const input = [new SystemMessage(reflectPrompt), new HumanMessage(transcript(state.messages, P.reflectMaxChars))];
        const store = runtime.store;
        const uid = userIdOf(runtime.configurable, config.memory.userId);
        void (async () => {
          try {
            const started = telemetry.now();
            // Tagged "nostream": this call is internal, and its tokens must not appear in the user's chat.
            const reply = await model.withConfig({ tags: ["nostream"] }).invoke(input);
            const verdict = parseJson(textOf(reply.content));
            telemetry.event("playbook_reflection", { ms: telemetry.now() - started, tool_calls: calls.length, errors, save: Boolean(verdict?.save), usage: reply.usage_metadata, background: true }, ctx);
            if (verdict?.save) await playbooks.save({ store, uid, input: verdict, by: "reflection", ctx });
          } catch (err) {
            telemetry.event("memory_error", { phase: "playbook_reflection", error: errorInfo(err) }, ctx);
          }
        })();
      } catch (err) {
        telemetry.event("memory_error", { phase: "playbook_reflection", error: errorInfo(err) }, ctx);
      }
    },
  });
}

export function createPlaybookTools({ playbooks, config, telemetry = noopTelemetry }) {
  const where = (cfg) => ({ store: cfg?.store, uid: userIdOf(cfg?.configurable, config.memory.userId), ctx: { thread_id: cfg?.configurable?.thread_id } });
  const guarded = (name, fn) => async (input, cfg) => {
    try {
      if (!cfg?.store) return "Playbooks are not available right now.";
      return await fn(input, cfg);
    } catch (err) {
      telemetry.event("memory_error", { phase: name, error: errorInfo(err) }, { thread_id: cfg?.configurable?.thread_id });
      return "Playbooks are not available right now.";
    }
  };

  const recall = tool(
    guarded("recall_playbook", async ({ id, query }, cfg) => {
      const { store, uid, ctx } = where(cfg);
      if (id) {
        const p = await playbooks.get(store, uid, id);
        if (!p) return `There is no playbook ${id}.`;
        await playbooks.recordUse(store, uid, id);
        return record(id, p);
      }
      if (!query) return "Give an id or a query.";
      const found = await playbooks.search({ store, uid, query, minScore: playbooks.limits.recallMinScore, ctx });
      if (!found.length) return "No playbook matches that.";
      return found.map((r) => `- ${r.playbook.id} — ${r.playbook.title}: ${firstSentence(r.playbook.situation)}`).join("\n") + "\nCall recall_playbook with an id to read the steps.";
    }),
    {
      name: "recall_playbook",
      description: "Read the steps of a playbook (how a similar task was solved before) by id, from the pointers in your prompt. Or search by describing the situation in a query.",
      schema: z.object({ id: z.string().optional().describe("A playbook id"), query: z.string().optional().describe("A description of the situation, when you have no id") }),
    }
  );

  const save = tool(
    guarded("save_playbook", async (input, cfg) => {
      const { store, uid, ctx } = where(cfg);
      const r = await playbooks.save({ store, uid, input, by: "agent", ctx });
      if (r.ok) return `${r.merged ? "Updated" : "Saved"} playbook ${r.playbook.id}.`;
      if (r.blocked) return `Not saved: the text looks like it contains a secret (${r.blocked.kinds.join(", ")}). Never store secrets.`;
      return r.error.message;
    }),
    {
      name: "save_playbook",
      description: "Save how you just solved a task so you can do it faster next time. Generic title and situation (no one-off details), the shortest path that works (no dead ends), described by what is visible (labels, roles, text; never uids or coordinates), with a stable direct URL as a step when it skips navigation (never tokens or personal content in it), and the pitfalls you hit with their fixes. Pass `id` to correct an existing playbook. Never include secrets or page content.",
      schema: z.object({
        id: z.string().optional().describe("The id of the playbook to correct; omit to create one"),
        title: z.string().describe("The task in a few words"),
        situation: z.string().describe("When to use this, one or two sentences"),
        hosts: z.array(z.string()).optional().describe("Site hostnames involved"),
        steps: z.array(z.string()).describe("Ordered steps"),
        pitfalls: z.array(z.string()).optional().describe("What went wrong and what fixed it"),
      }),
    }
  );

  const feedback = tool(
    guarded("playbook_feedback", async ({ id, worked }, cfg) => {
      const { store, uid, ctx } = where(cfg);
      const r = await playbooks.recordOutcome(store, uid, id, worked);
      telemetry.event("playbook_feedback", { id, worked }, ctx);
      return r ? "Recorded." : `There is no playbook ${id}.`;
    }),
    {
      name: "playbook_feedback",
      description: "Say whether a playbook you recalled worked for this task. A playbook that keeps failing is ranked lower.",
      schema: z.object({ id: z.string(), worked: z.boolean() }),
    }
  );

  return [recall, save, feedback];
}
