// Builds the run configuration from config/agent.json (data) + environment overrides + prompts/*.md (data).
// Throws Error with a readable message instead of exiting.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "./env.js";

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const num = (v, fallback) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? fallback : Number(v));
const list = (v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
const read = (file, what) => {
  let text;
  try {
    text = fs.readFileSync(file, "utf8").trim();
  } catch (err) {
    throw new Error(`Cannot read ${what} ${file}: ${err.message}`);
  }
  if (!text) throw new Error(`${what} is empty: ${file}`);
  return text;
};

/** @returns {{ config: object, apiKey: string, systemPrompt: string, tabsTemplate: string, memoryTemplate: string, playbooksTemplate: string, reflectPrompt: string, templates: Record<string, string> }} apiKey is kept out of `config` so it is never logged. */
export function buildConfig({ requireKey = true } = {}) {
  loadDotEnv();
  const file = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "config", "agent.json"), "utf8"));
  const d = file.defaults;

  const providerName = process.env.AGENT_PROVIDER || file.defaultProvider;
  const provider = file.providers[providerName];
  if (!provider) throw new Error(`Unknown AGENT_PROVIDER "${providerName}". Use: ${Object.keys(file.providers).join(", ")}`);
  const apiKey = process.env[provider.keyVar] ?? "";
  if (requireKey && !apiKey) throw new Error(`${provider.keyVar} is not set (environment or .env).`);

  const attach = process.env.AGENT_BROWSER_ATTACH || file.browser.attach;
  if (!["autoConnect", "browserUrl"].includes(attach)) throw new Error(`AGENT_BROWSER_ATTACH must be autoConnect or browserUrl, got "${attach}"`);

  const config = {
    provider: providerName,
    baseURL: provider.baseURL,
    model: process.env.AGENT_MODEL || provider.model,
    api: process.env.AGENT_API || provider.api, // "chat" | "responses"
    effort: process.env.AGENT_REASONING || d.effort, // low | medium | high
    maxModelCalls: num(process.env.AGENT_MAX_TURNS, d.maxModelCalls),
    maxTokens: num(process.env.AGENT_MAX_TOKENS, d.maxTokens), // Muse reasons first; small budgets return empty answers
    contextTrimTokens: num(process.env.AGENT_CONTEXT_TRIM_TOKENS, d.contextTrimTokens),
    modelRetries: d.modelRetries,
    modelRetryDelayMs: d.modelRetryDelayMs,
    tools: list(process.env.AGENT_TOOLS) ?? file.tools,
    browser: {
      attach,
      channel: process.env.AGENT_BROWSER_CHANNEL || file.browser.channel,
      browserUrl: process.env.AGENT_BROWSER_URL || file.browser.browserUrl,
    },
    screenshot: { ...file.screenshot, enabled: file.screenshot.enabled && process.env.AGENT_SCREENSHOTS !== "0" },
    telemetry: {
      enabled: file.telemetry.enabled && process.env.AGENT_TELEMETRY !== "0",
      dir: path.resolve(APP_ROOT, process.env.AGENT_TELEMETRY_DIR || file.telemetry.dir),
      maxChars: num(process.env.AGENT_TELEMETRY_MAX_CHARS, file.telemetry.maxChars),
      fullPayloads: process.env.AGENT_TELEMETRY_FULL === "1", // log whole prompts, not just the last message
      saveScreenshots: file.telemetry.saveScreenshots,
    },
    memory: {
      enabled: file.memory.enabled && process.env.AGENT_MEMORY !== "0",
      userId: process.env.AGENT_USER_ID || file.memory.userId,
      budgetTokens: num(process.env.AGENT_MEMORY_BUDGET, file.memory.budgetTokens),
      limits: { maxChars: file.memory.maxChars, hardMaxChars: file.memory.hardMaxChars },
    },
    playbooks: {
      ...file.playbooks,
      enabled: file.playbooks.enabled && process.env.AGENT_PLAYBOOKS !== "0",
      reflect: file.playbooks.reflect && process.env.AGENT_PLAYBOOKS_REFLECT !== "0",
    },
    staleSnapshots: { ...file.staleSnapshots, enabled: file.staleSnapshots.enabled && process.env.AGENT_CLEAR_OLD_SNAPSHOTS !== "0" },
    audio: { ...file.audio, enabled: file.audio.enabled && process.env.AGENT_AUDIO !== "0" },
    promptFile: process.env.AGENT_PROMPT_FILE || path.join(APP_ROOT, "prompts", "system.md"),
  };

  return {
    config,
    apiKey,
    systemPrompt: read(config.promptFile, "system prompt"),
    tabsTemplate: read(path.join(APP_ROOT, "prompts", "tabs.md"), "tabs template"),
    playbooksTemplate: read(path.join(APP_ROOT, "prompts", "playbooks.md"), "playbooks prompt template"),
    reflectPrompt: read(path.join(APP_ROOT, "prompts", "reflect.md"), "reflection prompt"),
    memoryTemplate: read(path.join(APP_ROOT, "prompts", "memory.md"), "memory prompt template"),
    // The starting content of the documents (copied into the store on first use, never over a user's edits).
    templates: {
      "SOUL.md": read(path.join(APP_ROOT, "templates", "SOUL.md"), "SOUL.md template"),
      "MEMORY.md": read(path.join(APP_ROOT, "templates", "MEMORY.md"), "MEMORY.md template"),
    },
  };
}
