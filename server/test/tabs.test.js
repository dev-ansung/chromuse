import test from "node:test";
import assert from "node:assert/strict";
import { formatTabs, interpretListPages, parsePages } from "../src/tabs.js";

// Real list_pages output format (chrome-devtools-mcp 1.12, McpResponse.js).
const LISTING = `## Pages
1: Inbox (3) - user@example.com (https://mail.google.com/mail/u/0/#inbox) [selected]
2: https://example.com/no-title
3: Docs | Muse (Preview) (https://docs.example.com/muse?a=1&b=(2)) isolatedContext=work`;

// The shape of a real failure (paths made generic): chrome-devtools-mcp reports it as plain text, not as an error.
const ALREADY_RUNNING = `The browser is already running for /home/user/.cache/chrome-devtools-mcp/chrome-profile. Use --isolated to run multiple browser instances.
Cause: The browser is already running for /home/user/.cache/chrome-devtools-mcp/chrome-profile. Use a different \`userDataDir\` or stop the running browser first.`;

test("parses ids, titles, urls, the selected flag and isolated contexts", () => {
  assert.deepEqual(parsePages(LISTING), [
    { id: 1, title: "Inbox (3) - user@example.com", url: "https://mail.google.com/mail/u/0/#inbox", selected: true },
    { id: 2, title: "", url: "https://example.com/no-title", selected: false },
    { id: 3, title: "Docs | Muse (Preview)", url: "https://docs.example.com/muse?a=1&b=(2)", selected: false, isolatedContext: "work" },
  ]);
});

test("only the Pages section is read, not extension pages or notes", () => {
  const text = `Note: the previously selected page was closed. Page 4 is now selected.
## Pages
4: Home (https://a.test/) [selected]
## Extension Pages
9: Worker (chrome-extension://abc/sw.js)`;
  assert.deepEqual(parsePages(text).map((t) => t.id), [4]);
});

test("a listing with tabs is an attached browser", () => {
  const r = interpretListPages(LISTING);
  assert.equal(r.ok, true);
  assert.equal(r.tabs.length, 3);
});

test("an attached browser with no regular tabs is ok with zero tabs (it prints no Pages header)", () => {
  assert.deepEqual(interpretListPages(""), { ok: true, tabs: [] });
  assert.deepEqual(interpretListPages("## Pages\n"), { ok: true, tabs: [] });
});

test("the real 'browser already running' failure is reported as a failed attach, with its text", () => {
  const r = interpretListPages(ALREADY_RUNNING);
  assert.equal(r.ok, false);
  assert.match(r.message, /already running/);
});

test("a tab whose title merely contains a failure word is still a tab", () => {
  const r = interpretListPages("## Pages\n1: Error 404 - Not found (https://x.test/missing) [selected]");
  assert.equal(r.ok, true);
  assert.equal(r.tabs[0].title, "Error 404 - Not found");
});

test("tabs render into the prompt template, and an empty list says so", () => {
  const template = "Open tabs:\n{{tabs}}\n";
  assert.equal(
    formatTabs([{ id: 1, title: "Inbox", url: "https://m.test/", selected: true }, { id: 2, title: "", url: "https://e.test/", selected: false }], template),
    "Open tabs:\n- page 1 (selected): Inbox — https://m.test/\n- page 2: https://e.test/\n"
  );
  assert.match(formatTabs([], template), /no tabs are open/);
});
