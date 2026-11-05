#!/usr/bin/env node
// Prints a timeline of a run from the telemetry log.
//   node scripts/report.js                 latest run in today's (or the newest) log
//   node scripts/report.js <run_id>        a specific run
//   node scripts/report.js --list          the recent runs
//   node scripts/report.js --file <path>   a specific log file

import fs from "node:fs";
import path from "node:path";
import { APP_ROOT } from "../src/config.js";
import { buildReport, parseJsonl } from "../src/telemetry-report.js";

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dir = path.resolve(APP_ROOT, process.env.AGENT_TELEMETRY_DIR || "telemetry");
const file =
  flag("--file") ??
  (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().map((f) => path.join(dir, f)).at(-1) : undefined);

if (!file || !fs.existsSync(file)) {
  console.error(`No telemetry log found in ${dir}. Run the agent first (telemetry is on by default).`);
  process.exit(1);
}
const records = parseJsonl(fs.readFileSync(file, "utf8"));

if (args.includes("--list")) {
  for (const r of records.filter((x) => x.type === "run_start").slice(-15)) {
    const end = records.find((x) => x.type === "run_end" && x.run_id === r.run_id && !x.parent_span_id);
    console.log(`${r.ts}  ${r.run_id}  ${(end?.status ?? "running").padEnd(8)} ${String(r.input ?? "").slice(0, 70)}`);
  }
} else {
  const runId = args.find((a) => !a.startsWith("--") && a !== flag("--file"));
  console.log(`# ${file}\n${buildReport(records, runId)}`);
}
