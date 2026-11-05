// Turns chrome-devtools-mcp's `list_pages` text into structured tabs, and tabs into prompt text.
// list_pages text format (chrome-devtools-mcp 1.12):
//   ## Pages
//   <id>: <title> (<url>)[ [selected]][ isolatedContext=<name>]      (or "<id>: <url>" when the page has no title)
// An empty browser prints no "## Pages" header at all; failures come back as plain text with no header.

import { z } from "zod";

export const tabSchema = z.object({
  id: z.number(),
  title: z.string(),
  url: z.string(),
  selected: z.boolean(),
  isolatedContext: z.string().optional(),
});

const FAILURE = /already running|cannot|can't|could not|couldn't|failed|error|econnrefused|refused|timed? ?out|not (?:found|reachable|running)|unable/i;

/** @returns {{ id: number, title: string, url: string, selected: boolean, isolatedContext?: string }[]} */
export function parsePages(text) {
  const tabs = [];
  let inPages = false;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^##\s+Pages\s*$/.test(line)) {
      inPages = true;
      continue;
    }
    if (/^##\s+/.test(line)) {
      inPages = false;
      continue;
    }
    if (!inPages) continue;
    const m = line.match(/^(\d+): (.*)$/);
    if (!m) continue;

    let rest = m[2];
    let isolatedContext;
    const iso = rest.match(/ isolatedContext=(\S+)$/);
    if (iso) {
      isolatedContext = iso[1];
      rest = rest.slice(0, iso.index);
    }
    let selected = false;
    if (rest.endsWith(" [selected]")) {
      selected = true;
      rest = rest.slice(0, -" [selected]".length);
    }
    const titled = rest.match(/^(.*) \((\S+)\)$/);
    const tab = { id: Number(m[1]), title: titled ? titled[1] : "", url: titled ? titled[2] : rest, selected };
    if (isolatedContext) tab.isolatedContext = isolatedContext;
    tabs.push(tab);
  }
  return tabs;
}

/**
 * Decides whether a list_pages response means "attached" or "could not attach".
 * @returns {{ ok: true, tabs: object[] } | { ok: false, message: string }}
 */
export function interpretListPages(text) {
  const body = String(text ?? "").trim();
  const tabs = parsePages(body);
  if (tabs.length) return { ok: true, tabs };
  if (/^##\s+Pages\s*$/m.test(body)) return { ok: true, tabs };
  if (body && FAILURE.test(body)) return { ok: false, message: body };
  return { ok: true, tabs }; // attached, no regular tabs open
}

/** Prompt text for a list of tabs, rendered into a template containing {{tabs}}. */
export function formatTabs(tabs, template) {
  const lines = tabs.length
    ? tabs.map((t) => `- page ${t.id}${t.selected ? " (selected)" : ""}: ${t.title ? `${t.title} — ` : ""}${t.url}`)
    : ["- (no tabs are open)"];
  return template.replace("{{tabs}}", lines.join("\n"));
}
