// Turns the telemetry JSONL into a readable timeline of one run. Pure functions; scripts/report.js is the CLI.

export function parseJsonl(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

/** Events of one run: those carrying its run_id, plus our own events (attach, tabs, screenshots) from the same thread while it ran. */
export function eventsOfRun(records, runId) {
  const start = records.find((r) => r.type === "run_start" && r.run_id === runId);
  if (!start) return [];
  const end = records.find((r) => r.type === "run_end" && r.run_id === runId && !r.parent_span_id);
  const from = Date.parse(start.ts);
  const to = end ? Date.parse(end.ts) : Infinity;
  return records.filter(
    (r) =>
      r.run_id === runId ||
      (!r.run_id && r.thread_id && r.thread_id === start.thread_id && Date.parse(r.ts) >= from && Date.parse(r.ts) <= to)
  );
}

export const latestRunId = (records) => records.filter((r) => r.type === "run_start").at(-1)?.run_id;

const secs = (ms) => (ms === undefined ? "" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const brief = (v, n = 90) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
const callText = (c) => `${c.name}(${brief(JSON.stringify(c.args), 60)})`;

export function buildReport(records, runId = latestRunId(records)) {
  const events = eventsOfRun(records, runId);
  if (!events.length) return `No events found for run ${runId ?? "(none)"}.`;
  const t0 = Date.parse(events[0].ts);
  const at = (r) => `+${((Date.parse(r.ts) - t0) / 1000).toFixed(2)}s`.padEnd(9);

  const lines = [];
  const totals = { llm: 0, tools: 0, toolErrors: 0, inTokens: 0, outTokens: 0, errors: [] };
  for (const r of events) {
    switch (r.type) {
      case "run_start":
        lines.push(`${at(r)}run_start    graph=${r.graph} thread=${r.thread_id ?? "-"} input="${brief(r.input)}"`);
        break;
      case "attach_failed":
      case "connect":
        lines.push(`${at(r)}${r.type.padEnd(12)}${r.status ?? ""} ${secs(r.ms)} ${r.error ? `ERROR ${brief(r.error?.message ?? r.error, 120)}` : ""}`);
        if (r.type === "attach_failed") totals.errors.push(`attach: ${brief(r.error?.message, 120)}`);
        break;
      case "tabs_read":
        lines.push(`${at(r)}tabs_read    ${r.count} tab(s) ${secs(r.ms)}`);
        break;
      case "llm_end": {
        totals.llm++;
        totals.inTokens += r.usage?.input_tokens ?? 0;
        totals.outTokens += r.usage?.output_tokens ?? 0;
        const tools = (r.tool_calls ?? []).map(callText).join(", ");
        lines.push(
          `${at(r)}llm          ${secs(r.ms)} in=${r.usage?.input_tokens ?? "?"} out=${r.usage?.output_tokens ?? "?"} finish=${r.finish_reason ?? "?"}` +
            `${tools ? ` → ${tools}` : ` → "${brief(r.text, 80)}"`}${r.reasoning ? ` [reasoning ${r.reasoning.length} chars]` : ""}`
        );
        break;
      }
      case "llm_error":
        totals.errors.push(`model: ${brief(r.error?.message, 140)}`);
        lines.push(`${at(r)}llm_error    ${secs(r.ms)} status=${r.status ?? "?"} ${brief(r.error?.message, 140)}`);
        break;
      case "tool_end":
        totals.tools++;
        lines.push(`${at(r)}tool         ${r.tool} ${secs(r.ms)} ${r.chars} chars: ${brief(r.output, 70)}`);
        break;
      case "tool_error":
        totals.tools++;
        totals.toolErrors++;
        lines.push(`${at(r)}tool_error   ${r.tool} ${secs(r.ms)} ${brief(r.error?.message, 140)}`);
        break;
      case "memory_read":
        lines.push(`${at(r)}memory_read  soul v${r.files?.["SOUL.md"]} memory v${r.files?.["MEMORY.md"]} ~${r.tokens} tokens${r.clipped_chars ? ` (clipped ${r.clipped_chars} chars)` : ""}${r.user_edits_noted ? " [user edits noted]" : ""}`);
        break;
      case "memory_write":
        lines.push(`${at(r)}memory_write ${r.path} v${r.version} by ${r.by} +${r.added} −${r.removed}${r.undo_of ? ` (undo of v${r.undo_of})` : ""}`);
        break;
      case "memory_blocked":
        lines.push(`${at(r)}memory_blocked ${r.path} (${r.reason}${r.kinds ? `: ${r.kinds.join(",")}` : ""})`);
        break;
      case "memory_conflict":
        lines.push(`${at(r)}memory_conflict ${r.path} save based on v${r.expected}, file is v${r.actual}`);
        break;
      case "memory_error":
        totals.errors.push(`memory ${r.phase}: ${brief(r.error?.message, 120)}`);
        lines.push(`${at(r)}memory_error ${r.phase}: ${brief(r.error?.message, 140)}`);
        break;
      case "screenshot":
        lines.push(`${at(r)}screenshot   after ${r.tool}, ${r.bytes} bytes${r.file ? ` → ${r.file}` : ""}`);
        break;
      case "warning":
        lines.push(`${at(r)}warning      ${brief(r.message, 140)}`);
        break;
      case "live_error":
        lines.push(`${at(r)}live_error   ${brief(r.error, 140)}`);
        break;
      case "warning":
        lines.push(`${at(r)}warning      ${brief(r.message, 140)}`);
        break;
      case "chain_error":
        totals.errors.push(`${r.node ?? "graph"}: ${brief(r.error?.message, 140)}`);
        lines.push(`${at(r)}chain_error  node=${r.node ?? "-"} ${r.error?.name ?? ""}: ${brief(r.error?.message, 140)}`);
        break;
      case "run_end":
        if (!r.parent_span_id) lines.push(`${at(r)}run_end      ${r.status} ${secs(r.ms)}${r.error ? ` ${brief(r.error, 120)}` : ""}`);
        break;
      default:
        break; // llm_start, tool_start: paired with their end events
    }
  }
  lines.push(
    `summary: ${totals.llm} model call(s), ${totals.tools} tool call(s) (${totals.toolErrors} failed), tokens in ${totals.inTokens} / out ${totals.outTokens}` +
      (totals.errors.length ? `\nerrors:\n  - ${[...new Set(totals.errors)].join("\n  - ")}` : "")
  );
  return lines.join("\n");
}
