// Local telemetry: one JSON object per line in <dir>/<YYYY-MM-DD>.jsonl, so any run can be pulled out with jq.
//
//   { ts, type, run_id, thread_id, span_id, parent_span_id, node, ...data }
//
// Types:  run_start run_end chain_error  llm_start llm_end llm_error  tool_start tool_end tool_error      (LangChain callbacks)
//         attach_failed tabs_read connect screenshot warning live_error live_recovered memory_*            (our own events)
// `run_id` is the root run (one per user message); `span_id` is the individual model/tool/node call.
// Secrets: API keys never reach callbacks (they live in the HTTP client), and nothing here logs request headers.
// Large strings are clipped to `maxChars` (the original length is kept); set fullPayloads to log whole prompts.

import fs from "node:fs";
import path from "node:path";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { textOf } from "./text.js";

export function errorInfo(err) {
  if (!err || typeof err !== "object") return { message: String(err) };
  return {
    name: err.name,
    message: err.message,
    ...(err.hint ? { hint: err.hint } : {}),
    stack: typeof err.stack === "string" ? err.stack.split("\n").slice(0, 8).join("\n") : undefined,
    ...(err.cause ? { cause: errorInfo(err.cause) } : {}),
  };
}

const roleOf = (m) => m?.type ?? m?.getType?.() ?? m?.role ?? "unknown";

function reasoningOf(message) {
  const direct = message?.additional_kwargs?.reasoning_content;
  if (direct) return textOf(direct);
  if (Array.isArray(message?.content)) {
    return message.content
      .filter((b) => b && b.type === "reasoning")
      .map((b) => b.reasoning ?? b.text ?? "")
      .join("\n");
  }
  return "";
}

class TelemetryHandler extends BaseCallbackHandler {
  name = "agent_app_telemetry";

  constructor(telemetry) {
    super();
    this.t = telemetry;
    this.spans = new Map(); // span id -> { type, name, node, thread_id, root, startedAt }
  }

  // Context shared by every event of a span.
  start(runId, parentRunId, type, name, metadata) {
    const parent = parentRunId ? this.spans.get(parentRunId) : undefined;
    const span = {
      type,
      name,
      node: metadata?.langgraph_node ?? parent?.node,
      thread_id: metadata?.thread_id ?? parent?.thread_id,
      root: parent?.root ?? parentRunId ?? runId,
      parent: parentRunId,
      startedAt: this.t.now(),
    };
    this.spans.set(runId, span);
    return span;
  }

  ctx(runId) {
    const s = this.spans.get(runId);
    return s
      ? { run_id: s.root, thread_id: s.thread_id, span_id: runId, parent_span_id: s.parent, node: s.node }
      : { span_id: runId };
  }

  finish(runId) {
    const s = this.spans.get(runId);
    this.spans.delete(runId);
    return s ? this.t.now() - s.startedAt : undefined;
  }

  emit(type, runId, data) {
    this.t.event(type, data, this.ctx(runId));
  }

  // Context must be read BEFORE the span is closed (closing removes it).
  done(runId) {
    const ctx = this.ctx(runId);
    const name = this.spans.get(runId)?.name;
    return { ctx, name, ms: this.finish(runId) };
  }

  safe(fn) {
    try {
      fn();
    } catch {
      /* telemetry must never break a run */
    }
  }

  // --- chains / graph nodes: the root run frames the whole user message; errors are logged at every level ---
  handleChainStart(chain, inputs, runId, parentRunId, tags, metadata, runType, runName) {
    this.safe(() => {
      const name = runName ?? chain?.id?.at?.(-1) ?? "chain";
      this.start(runId, parentRunId, "chain", name, metadata);
      if (!parentRunId) {
        const msgs = Array.isArray(inputs?.messages) ? inputs.messages : [];
        this.emit("run_start", runId, { graph: name, tags, input: this.t.clip(textOf(msgs.at(-1)?.content ?? msgs.at(-1) ?? inputs)) });
      }
    });
  }

  handleChainEnd(_outputs, runId, parentRunId) {
    this.safe(() => {
      const ctx = this.ctx(runId);
      const ms = this.finish(runId);
      if (!parentRunId) this.t.event("run_end", { status: "ok", ms }, ctx);
    });
  }

  handleChainError(err, runId, parentRunId) {
    this.safe(() => {
      const ctx = this.ctx(runId);
      const ms = this.finish(runId);
      this.t.event("chain_error", { error: errorInfo(err), ms }, ctx);
      if (!parentRunId) this.t.event("run_end", { status: "error", ms, error: errorInfo(err).message }, ctx);
    });
  }

  // --- model calls ---
  handleChatModelStart(llm, messages, runId, parentRunId, extraParams, _tags, metadata) {
    this.safe(() => {
      this.start(runId, parentRunId, "llm", llm?.id?.at?.(-1) ?? "llm", metadata);
      const list = messages?.[0] ?? [];
      const tools = (extraParams?.invocation_params?.tools ?? []).map((t) => t?.function?.name ?? t?.name).filter(Boolean);
      const describe = (m) => ({ role: roleOf(m), chars: textOf(m.content).length, text: this.t.clip(textOf(m.content)), ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}) });
      this.emit("llm_start", runId, {
        model: extraParams?.invocation_params?.model ?? extraParams?.invocation_params?.model_name,
        messages: list.length,
        input_chars: list.reduce((n, m) => n + textOf(m.content).length, 0),
        tools,
        ...(this.t.fullPayloads ? { prompt: list.map(describe) } : { last_message: list.length ? describe(list.at(-1)) : undefined }),
      });
    });
  }

  handleLLMStart(llm, prompts, runId, parentRunId, extraParams, _tags, metadata) {
    this.safe(() => {
      this.start(runId, parentRunId, "llm", llm?.id?.at?.(-1) ?? "llm", metadata);
      this.emit("llm_start", runId, { prompts: prompts?.length, ...(this.t.fullPayloads ? { prompt: prompts?.map((p) => this.t.clip(p)) } : {}) });
    });
  }

  handleLLMEnd(output, runId) {
    this.safe(() => {
      const { ctx, ms } = this.done(runId);
      const gen = output?.generations?.[0]?.[0];
      const msg = gen?.message;
      const text = gen?.text || textOf(msg?.content); // generation text can be "" while the message has content
      this.t.event(
        "llm_end",
        {
          ms,
          text: this.t.clip(text),
          reasoning: this.t.clip(reasoningOf(msg)),
          tool_calls: (msg?.tool_calls ?? []).map((c) => ({ id: c.id, name: c.name, args: c.args })),
          invalid_tool_calls: msg?.invalid_tool_calls?.length ? msg.invalid_tool_calls : undefined,
          usage: msg?.usage_metadata ?? output?.llmOutput?.tokenUsage,
          finish_reason: msg?.response_metadata?.finish_reason ?? gen?.generationInfo?.finish_reason,
        },
        ctx
      );
    });
  }

  handleLLMError(err, runId) {
    this.safe(() => {
      const ctx = this.ctx(runId);
      this.t.event("llm_error", { error: errorInfo(err), status: err?.status, ms: this.finish(runId) }, ctx);
    });
  }

  // --- tool calls ---
  handleToolStart(tool, input, runId, parentRunId, _tags, metadata, runName, toolCallId) {
    this.safe(() => {
      const name = runName ?? tool?.name ?? "tool";
      this.start(runId, parentRunId, "tool", name, metadata);
      this.emit("tool_start", runId, { tool: name, tool_call_id: toolCallId, args: this.t.clip(typeof input === "string" ? input : textOf(input)) });
    });
  }

  handleToolEnd(output, runId) {
    this.safe(() => {
      const { ctx, name, ms } = this.done(runId);
      const text = textOf(output);
      this.t.event("tool_end", { tool: name, ms, chars: text.length, output: this.t.clip(text) }, ctx);
    });
  }

  handleToolError(err, runId) {
    this.safe(() => {
      const name = this.spans.get(runId)?.name;
      const ctx = this.ctx(runId);
      this.t.event("tool_error", { tool: name, error: errorInfo(err), ms: this.finish(runId) }, ctx);
    });
  }
}

/**
 * @param {{ dir: string, maxChars?: number, fullPayloads?: boolean, saveScreenshots?: boolean, clock?: () => Date }} opts
 */
export function createTelemetry({ dir, maxChars = 4000, fullPayloads = false, saveScreenshots = true, clock = () => new Date() }) {
  fs.mkdirSync(dir, { recursive: true });

  const telemetry = {
    dir,
    fullPayloads,
    now: () => clock().getTime(),
    clip(value) {
      if (value === undefined || value === null || value === "") return value;
      const s = typeof value === "string" ? value : textOf(value);
      return s.length > maxChars ? `${s.slice(0, maxChars)}…[+${s.length - maxChars} chars]` : s;
    },
    /** Appends one record. Never throws. */
    event(type, data = {}, ctx = {}) {
      const at = clock();
      const record = { ts: at.toISOString(), type, ...ctx, ...data };
      try {
        fs.appendFileSync(path.join(dir, `${at.toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(record)}\n`);
      } catch {
        /* disk problems must not break a run */
      }
      return record;
    },
    /** Saves a screenshot next to the log and returns its path relative to `dir` (or undefined when disabled). */
    saveScreenshot({ tool, callId, mime, data }) {
      if (!saveScreenshots) return undefined;
      try {
        const ext = (mime ?? "image/jpeg").split("/")[1] ?? "jpg";
        const rel = path.join("shots", `${clock().toISOString().replace(/[:.]/g, "-")}-${tool}-${callId}.${ext}`);
        fs.mkdirSync(path.join(dir, "shots"), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), Buffer.from(data, "base64"));
        return rel;
      } catch {
        return undefined;
      }
    },
  };
  telemetry.handler = new TelemetryHandler(telemetry);
  return telemetry;
}

/** Same interface, records nothing (telemetry disabled, or tests that do not care). */
export const noopTelemetry = {
  dir: undefined,
  fullPayloads: false,
  handler: undefined,
  now: () => Date.now(),
  clip: (v) => v,
  event: () => ({}),
  saveScreenshot: () => undefined,
};

/** One telemetry instance per server process, shared by the graphs. */
export function sharedTelemetry(config) {
  if (!config.telemetry.enabled) return noopTelemetry;
  globalThis.__agentAppTelemetry ??= createTelemetry(config.telemetry);
  return globalThis.__agentAppTelemetry;
}
