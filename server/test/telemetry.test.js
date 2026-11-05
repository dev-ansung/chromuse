// Runs the real agent with the real telemetry handler, then reads the JSONL back: is what we would need to debug a run actually logged?

process.env.LANGSMITH_TRACING = "false";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { AIMessage, fakeModel, tool } from "langchain";
import { buildAgent } from "../src/agent.js";
import { BrowserAttachError } from "../src/browser.js";
import { createTelemetry } from "../src/telemetry.js";
import { buildReport, latestRunId, parseJsonl } from "../src/telemetry-report.js";

const config = {
  maxModelCalls: 10,
  modelRetries: 0,
  modelRetryDelayMs: 1,
  contextTrimTokens: 60000,
  screenshot: { enabled: true, format: "jpeg", quality: 60, timeoutMs: 1000, after: ["click"] },
};
const click = tool(async ({ uid }) => `clicked ${uid}`, { name: "click", description: "click", schema: z.object({ pageId: z.number(), uid: z.string() }) });
const broken = tool(async () => { throw new Error("element not found"); }, { name: "broken", description: "fails", schema: z.object({}) });

const session = (over = {}) => ({
  listTabs: async () => [{ id: 1, title: "Inbox", url: "https://mail.test/", selected: true }],
  screenshot: async () => ({ mime: "image/jpeg", data: Buffer.from("fake-jpeg-bytes").toString("base64") }),
  ...over,
});

async function run({ model, tools = [], sess = session(), telemetryOpts = {}, task = "go" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-telemetry-"));
  const telemetry = createTelemetry({ dir, ...telemetryOpts });
  const agent = buildAgent({ model, tools, session: sess, config, systemPrompt: "t", tabsTemplate: "{{tabs}}", telemetry });
  let error;
  try {
    await agent.invoke({ messages: [{ role: "user", content: task }] }, { configurable: { thread_id: "thread-1" } });
  } catch (err) {
    error = err;
  }
  const file = fs.readdirSync(dir).find((f) => f.endsWith(".jsonl"));
  const records = file ? parseJsonl(fs.readFileSync(path.join(dir, file), "utf8")) : [];
  return { dir, records, error, of: (type) => records.filter((r) => r.type === type) };
}

test("a normal run is fully recorded: lifecycle, model calls, tool calls, tabs, screenshot", { timeout: 20_000 }, async () => {
  const model = fakeModel()
    .respondWithTools([{ name: "click", args: { pageId: 1, uid: "7" }, id: "c1" }])
    .respond(new AIMessage("all done"));
  const r = await run({ model, tools: [click], task: "click the button" });

  assert.equal(r.error, undefined);
  const start = r.of("run_start")[0];
  assert.match(start.input, /click the button/);
  const runId = start.run_id;
  assert.equal(r.of("run_end").filter((e) => !e.parent_span_id)[0].status, "ok");

  assert.equal(r.of("llm_end").length, 2, "both model calls");
  assert.deepEqual(r.of("llm_end")[0].tool_calls.map((c) => [c.name, c.args]), [["click", { pageId: 1, uid: "7" }]]);
  assert.match(r.of("llm_end")[1].text, /all done/);
  assert.equal(typeof r.of("llm_end")[0].ms, "number");

  const [toolStart] = r.of("tool_start");
  assert.equal(toolStart.tool, "click");
  assert.match(toolStart.args, /"uid":"7"/);
  const [toolEnd] = r.of("tool_end");
  assert.equal(toolEnd.tool, "click");
  assert.equal(toolEnd.output, "clicked 7");
  assert.equal(typeof toolEnd.ms, "number");

  assert.equal(r.of("tabs_read")[0].count, 1);
  assert.equal(r.of("tabs_read")[0].thread_id, "thread-1");
  const shot = r.of("screenshot")[0];
  assert.equal(shot.tool, "click");
  assert.ok(shot.bytes > 0);
  assert.ok(fs.existsSync(path.join(r.dir, shot.file)), "the screenshot file was saved next to the log");

  for (const type of ["run_start", "llm_start", "llm_end", "tool_start", "tool_end"]) {
    assert.ok(r.of(type).every((e) => e.run_id === runId), `${type} events share the run id`);
  }
  assert.ok(r.of("llm_end").every((e) => e.thread_id === "thread-1"), "thread id is on model events");
});

test("a failing tool is logged with its error, and the run still completes", { timeout: 20_000 }, async () => {
  const model = fakeModel().respondWithTools([{ name: "broken", args: {}, id: "b1" }]).respond(new AIMessage("sorry"));
  const r = await run({ model, tools: [broken] });
  assert.equal(r.error, undefined);
  assert.match(r.of("tool_error")[0].error.message, /element not found/);
  assert.equal(r.of("tool_error")[0].tool, "broken");
  assert.equal(r.of("run_end").filter((e) => !e.parent_span_id)[0].status, "ok");
});

test("a model failure is a failed run in the log and rejects (it is not turned into a chat message)", { timeout: 20_000 }, async () => {
  const r = await run({ model: fakeModel().alwaysThrow(new Error("upstream 500")) });
  assert.match(r.error?.message ?? "", /upstream 500/);
  assert.match(r.of("llm_error")[0].error.message, /upstream 500/);
  assert.ok(r.of("chain_error").length > 0);
  const end = r.of("run_end").filter((e) => !e.parent_span_id)[0];
  assert.equal(end.status, "error");
  assert.match(end.error, /upstream 500/);
});

test("a failed attach is logged with its reason and hint, and no model call is made", { timeout: 20_000 }, async () => {
  const sess = session({ listTabs: async () => { throw new BrowserAttachError("The browser is not running", "Enable remote debugging."); } });
  const r = await run({ model: fakeModel().respond(new AIMessage("never")), sess });
  assert.equal(r.error?.name, "BrowserAttachError");
  const failed = r.of("attach_failed")[0];
  assert.equal(failed.error.message, "The browser is not running");
  assert.equal(failed.error.hint, "Enable remote debugging.");
  assert.equal(r.of("llm_start").length, 0);
  assert.equal(r.of("run_end").filter((e) => !e.parent_span_id)[0].status, "error");
});

test("a failing screenshot is a logged warning", { timeout: 20_000 }, async () => {
  const model = fakeModel().respondWithTools([{ name: "click", args: { pageId: 1, uid: "7" }, id: "c1" }]).respond(new AIMessage("ok"));
  const r = await run({ model, tools: [click], sess: session({ screenshot: async () => { throw new Error("no screenshot tool"); } }) });
  assert.match(r.of("warning")[0].message, /screenshot failed: no screenshot tool/);
});

test("long text is clipped but its length is kept; fullPayloads logs the whole prompt", { timeout: 20_000 }, async () => {
  const long = "x".repeat(500);
  const clipped = await run({ model: fakeModel().respond(new AIMessage(long)), telemetryOpts: { maxChars: 50 }, task: long });
  assert.match(clipped.of("run_start")[0].input, /…\[\+450 chars\]$/);
  assert.equal(clipped.of("llm_start")[0].prompt, undefined, "no full prompt by default");
  const full = await run({ model: fakeModel().respond(new AIMessage("hi")), telemetryOpts: { fullPayloads: true } });
  assert.ok(Array.isArray(full.of("llm_start")[0].prompt) && full.of("llm_start")[0].prompt.length >= 2);
});

test("the report shows what happened in order, and surfaces errors", { timeout: 20_000 }, async () => {
  const model = fakeModel().respondWithTools([{ name: "click", args: { pageId: 1, uid: "7" }, id: "c1" }]).respond(new AIMessage("all done"));
  const ok = await run({ model, tools: [click], task: "click it" });
  const report = buildReport(ok.records);
  assert.match(report, /run_start +graph=.* thread=thread-1 input="click it"/);
  assert.match(report, /tabs_read +1 tab/);
  assert.match(report, /llm .*click\(/);
  assert.match(report, /tool +click .*clicked 7/);
  assert.match(report, /screenshot +after click/);
  assert.match(report, /run_end +ok/);
  assert.match(report, /summary: 2 model call\(s\), 1 tool call\(s\)/);

  const bad = await run({ model: fakeModel().alwaysThrow(new Error("upstream 500")) });
  const badReport = buildReport(bad.records, latestRunId(bad.records));
  assert.match(badReport, /llm_error .*upstream 500/);
  assert.match(badReport, /run_end +error/);
  assert.match(badReport, /errors:\n  - model: upstream 500/);
});

test("telemetry never breaks a run when the log cannot be written", { timeout: 20_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-telemetry-"));
  const telemetry = createTelemetry({ dir });
  fs.rmSync(dir, { recursive: true, force: true }); // the directory disappears under it
  const agent = buildAgent({ model: fakeModel().respond(new AIMessage("fine")), tools: [], session: session(), config, systemPrompt: "t", tabsTemplate: "{{tabs}}", telemetry });
  const out = await agent.invoke({ messages: [{ role: "user", content: "go" }] });
  assert.equal(out.messages.at(-1).content, "fine");
});
