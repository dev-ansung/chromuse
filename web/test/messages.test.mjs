// The official message converter, fed the exact content-block shapes Baseten's Muse Spark produced in the first runs
// (these were printed as raw JSON in the chat by the previous, hand-written conversion).

import test from "node:test";
import assert from "node:assert/strict";
import { convertLangChainMessages } from "@assistant-ui/react-langgraph";

// The converter is a per-message callback: (message, metadata) => ThreadMessageLike | ThreadMessageLike[].
const convert = (message) => {
  const out = convertLangChainMessages(message, {});
  return Array.isArray(out) ? out : [out];
};
const partsOf = (message) => convert(message).flatMap((m) => m.content);

test("plain text content becomes one text part", () => {
  const parts = partsOf({ id: "m1", type: "ai", content: "Hey! How can I help you today?" });
  assert.deepEqual(parts.map((p) => p.type), ["text"]);
  assert.equal(parts[0].text, "Hey! How can I help you today?");
});

test("reasoning and tool_call content blocks do not leak into the answer text as JSON", () => {
  const parts = partsOf({
    id: "m2",
    type: "ai",
    content: [
      { type: "reasoning", reasoning: 'User says "connect to browser". Need to list pages.' },
      { type: "tool_call", id: "chatcmpl-tool-2cf3", name: "list_pages", args: {} },
    ],
    tool_calls: [{ id: "chatcmpl-tool-2cf3", name: "list_pages", args: {} }],
  });
  const textParts = parts.filter((p) => p.type === "text");
  for (const p of textParts) {
    assert.doesNotMatch(p.text, /"type"\s*:/, `raw block JSON leaked into a text part: ${p.text}`);
  }
  assert.equal(parts.filter((p) => p.type === "tool-call").length, 1, "exactly one tool call card");
  assert.equal(parts.find((p) => p.type === "tool-call").toolName, "list_pages");
});

test("a tool message carries its result and the id of the call it answers", () => {
  const flat = JSON.stringify(convert({ id: "m4", type: "tool", tool_call_id: "c1", name: "click", content: "clicked 7" }));
  assert.match(flat, /clicked 7/);
  assert.match(flat, /c1/);
});

test("an AI message that only calls a tool has exactly one tool-call part and no visible text", () => {
  const parts = partsOf({ id: "m3", type: "ai", content: "", tool_calls: [{ id: "c1", name: "click", args: { uid: "7" } }] });
  // The converter keeps an empty text part for empty content; it renders as nothing.
  assert.deepEqual(parts.filter((p) => p.type === "text" && p.text !== ""), []);
  const calls = parts.filter((p) => p.type === "tool-call");
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls[0].args), '{"uid":"7"}'); // the library tags args with an internal Symbol key
});
