// The agent: LangChain createAgent + middleware. Pure construction: model, tools and browser session are passed in,
// so tests run the real middleware stack with a fake model and a fake session.
//
// Custom stream events (config.writer, delivered to the UI as "custom" stream events), all shaped { kind, ... }:
//   { kind: "tabs", tabs }                      the tabs read from the browser before the first model call
//   { kind: "screenshot", tool, callId, mime, data }   a screenshot of the page after a page-changing tool call (never shown to the model)
//   { kind: "warning", message }
//   { kind: "usage", input, output, reasoning, cached }   token counts of one model call

import { z } from "zod";
import {
  createAgent,
  createMiddleware,
  modelCallLimitMiddleware,
  modelRetryMiddleware,
  toolErrorMiddleware,
  contextEditingMiddleware,
  ClearToolUsesEdit,
} from "langchain";
import { SystemMessage, ToolMessage } from "@langchain/core/messages";
import { createMemoryTools, memoryMiddleware } from "./memory.js";
import { createPlaybookTools, playbooksMiddleware } from "./playbooks-agent.js";
import { noopTelemetry } from "./telemetry.js";
import { formatTabs, tabSchema } from "./tabs.js";

/** Rejects if the promise has not settled within `ms`. */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Attaches (via the session) and reads the open tabs before the first model call, and tells the model about them. */
export function browserMiddleware({ session, config, tabsTemplate, telemetry = noopTelemetry }) {
  const shots = config.screenshot ?? { enabled: false, after: [] };

  async function snapAfter(request, name) {
    const ctx = { thread_id: request.runtime.configurable?.thread_id };
    try {
      const shot = await withTimeout(session.screenshot({ pageId: request.toolCall?.args?.pageId }), shots.timeoutMs ?? 3000);
      if (!shot) return;
      const event = { kind: "screenshot", tool: name, callId: request.toolCall.id, ...shot };
      const file = telemetry.saveScreenshot(event);
      telemetry.event("screenshot", { tool: name, call_id: request.toolCall.id, bytes: Math.floor((shot.data.length * 3) / 4), file }, ctx);
      request.runtime.writer?.(event);
    } catch (err) {
      const message = `screenshot failed: ${err?.message ?? err}`;
      telemetry.event("warning", { message, tool: name }, ctx);
      request.runtime.writer?.({ kind: "warning", message });
    }
  }

  return createMiddleware({
    name: "BrowserContext",
    stateSchema: z.object({ tabs: z.array(tabSchema).optional() }),

    // Runs once per run, before any model call. Throws BrowserAttachError if Chrome cannot be attached,
    // which fails the run before a single model token is spent.
    beforeAgent: async (_state, runtime) => {
      const ctx = { thread_id: runtime.configurable?.thread_id };
      const started = telemetry.now();
      try {
        const tabs = await session.listTabs();
        telemetry.event("tabs_read", { ms: telemetry.now() - started, count: tabs.length, tabs: tabs.map((t) => ({ id: t.id, url: t.url, selected: t.selected })) }, ctx);
        runtime.writer?.({ kind: "tabs", tabs });
        return { tabs };
      } catch (err) {
        telemetry.event("attach_failed", { ms: telemetry.now() - started, error: { name: err?.name, message: err?.detail ?? err?.message, hint: err?.hint } }, ctx);
        throw err;
      }
    },

    wrapModelCall: (request, handler) => {
      const prompt = `${request.systemPrompt}\n\n${formatTabs(request.state?.tabs ?? [], tabsTemplate)}`;
      // Only one of systemPrompt / systemMessage may be changed per request (LangChain throws otherwise).
      return handler({ ...request, systemMessage: new SystemMessage(prompt) });
    },

    // After a page-changing tool call, send the UI a screenshot of the page (the live view follows the agent's steps).
    // It is awaited, but with a timeout, and it never throws: a screenshot problem becomes a warning, not an agent failure.
    wrapToolCall: async (request, handler) => {
      const result = await handler(request);
      const name = request.toolCall?.name;
      if (shots.enabled && shots.after.includes(name)) await snapAfter(request, name);
      return result;
    },
  });
}

/** After each model call, tells the UI what it cost: { kind: "usage", input, output, reasoning, cached } (token counts from the provider). */
export function usageMiddleware() {
  return createMiddleware({
    name: "Usage",
    wrapModelCall: async (request, handler) => {
      const result = await handler(request);
      const message = Array.isArray(result?.result) ? result.result.at(-1) : result;
      const u = message?.usage_metadata;
      if (u) {
        request.runtime.writer?.({
          kind: "usage",
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          reasoning: u.output_token_details?.reasoning ?? 0,
          cached: u.input_token_details?.cache_read ?? 0,
        });
      }
      return result;
    },
  });
}

/**
 * Page snapshots are the bulk of every prompt (about 75% of input tokens when measured), and only the latest one is usable:
 * element ids belong to it. In what the MODEL sees, every snapshot result but the latest becomes a short placeholder. Only the
 * request is changed (the saved conversation keeps the full text), and a replaced snapshot stays the same placeholder on every
 * later call, so the provider's prompt cache keeps working for everything before the newest messages.
 */
export function staleSnapshotsMiddleware({ tools, placeholder }) {
  const names = new Set(tools);
  return createMiddleware({
    name: "StaleSnapshots",
    wrapModelCall: (request, handler) => {
      const callNames = new Map(); // tool_call_id -> tool name, for results that carry no name
      for (const m of request.messages) for (const c of m.tool_calls ?? []) callNames.set(c.id, c.name);
      const isSnapshot = (m) => ToolMessage.isInstance(m) && names.has(m.name ?? callNames.get(m.tool_call_id));
      const latest = request.messages.findLastIndex(isSnapshot);
      if (latest < 0) return handler(request);
      const messages = request.messages.map((m, i) =>
        i < latest && isSnapshot(m) && m.content !== placeholder ? new ToolMessage({ tool_call_id: m.tool_call_id, name: m.name, content: placeholder }) : m
      );
      return handler({ ...request, messages });
    },
  });
}

/**
 * LangGraph counts every graph step against `recursionLimit` (default 25). Measured on this agent: a run costs about
 * 5 steps of setup plus 4 per model->tool cycle (the middleware adds nodes). The limit must exceed what the
 * model-call limit allows, so that the explicit ModelCallLimitMiddlewareError fires first, not LangGraph's raw
 * GraphRecursionError.
 */
export function recursionLimitFor(maxModelCalls) {
  return maxModelCalls * 4 + 20;
}

/**
 * @param {{ model: any, tools: any[], session: any, config: object, systemPrompt: string, tabsTemplate: string,
 *           onToolError?: (err: unknown, request: any) => void }} opts
 */
export function buildAgent({ model, tools, session, config, systemPrompt, tabsTemplate, memory, playbooks, store, checkpointer, telemetry = noopTelemetry, onToolError = () => {} }) {
  const agent = createAgent({
    name: "browser_agent",
    model,
    tools: [
      ...tools,
      ...(memory ? createMemoryTools({ documents: memory.documents, config, telemetry }) : []),
      ...(playbooks ? createPlaybookTools({ playbooks: playbooks.playbooks, config, telemetry }) : []),
    ],
    systemPrompt,
    ...(store ? { store } : {}),
    ...(checkpointer ? { checkpointer } : {}),
    middleware: [
      // Order = order of the prompt sections: rules, then soul and memory, then the open tabs.
      ...(memory ? [memoryMiddleware({ documents: memory.documents, config, template: memory.template, telemetry })] : []),
      browserMiddleware({ session, config, tabsTemplate, telemetry }),
      // After the browser middleware: it uses the selected tab that one reads. Adds nothing to the prompt when no playbook matches.
      ...(playbooks ? [playbooksMiddleware({ ...playbooks, config, telemetry })] : []),
      // Hard stop on runaway loops. Raises ModelCallLimitMiddlewareError, which is explicit
      // (exitBehavior "end" would inject a text message that looks like a normal answer).
      modelCallLimitMiddleware({ runLimit: config.maxModelCalls, exitBehavior: "error" }),
      // Transient model/API failures (5xx, rate limits, timeouts). After the retries a failure must be a real run error:
      // the default ("continue") turns it into a normal AI message and the run looks successful.
      modelRetryMiddleware({ maxRetries: config.modelRetries, initialDelayMs: config.modelRetryDelayMs ?? 1000, onFailure: "error" }),
      // A failing tool becomes an error message the model can react to, instead of crashing the run.
      toolErrorMiddleware({
        onError: (err, req) => {
          onToolError(err, req);
          return `Error from ${req.toolCall?.name}: ${err?.message ?? err}. The page may have changed: take a fresh snapshot and adjust.`;
        },
      }),
      ...(config.staleSnapshots?.enabled ? [staleSnapshotsMiddleware(config.staleSnapshots)] : []),
      usageMiddleware(),
      // Snapshots are large: clear old tool outputs once the context grows, keep the latest few.
      contextEditingMiddleware({
        edits: [
          new ClearToolUsesEdit({
            trigger: { tokens: config.contextTrimTokens },
            keep: { messages: 4 },
            placeholder: "[old tool output cleared to save context]",
          }),
        ],
      }),
    ],
  });
  // Defaults for every run (the server passes no limit of its own); the handler records every model/tool call.
  return agent.withConfig({
    recursionLimit: recursionLimitFor(config.maxModelCalls),
    ...(telemetry.handler ? { callbacks: [telemetry.handler] } : {}),
  });
}
