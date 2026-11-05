// The attachment to the user's already-running Chrome, through chrome-devtools-mcp.
// One session per server process. Nothing here calls a model: attaching and listing tabs are plain tool calls.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MCPAdapter } from "@langchain/mcp-adapters";
import { interpretListPages } from "./tabs.js";
import { textOf } from "./text.js";

export class BrowserAttachError extends Error {
  constructor(detail, hint) {
    super(hint ? `${detail}\n${hint}` : detail);
    this.name = "BrowserAttachError";
    this.detail = detail;
    this.hint = hint;
  }
}

/** chrome-devtools-mcp flags that make it attach to an existing browser instead of launching one. */
export function attachArgs(browser) {
  return browser.attach === "browserUrl"
    ? [`--browserUrl=${browser.browserUrl}`]
    : ["--autoConnect", `--channel=${browser.channel}`];
}

export function attachHint(browser) {
  if (browser.attach === "browserUrl") {
    return `Could not reach Chrome at ${browser.browserUrl}. Quit Chrome, then start it with --remote-debugging-port=9222 and a separate --user-data-dir, and retry.`;
  }
  return "Could not attach to your running Chrome. In Chrome (version 144 or newer) open chrome://inspect/#remote-debugging, turn on remote debugging, allow the connection if Chrome asks, and retry.";
}

/** Minimal env for the MCP child process: no API keys. HOME is needed to find Chrome's profile for autoConnect. */
function childEnv(extra = {}) {
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TMPDIR", "LANG", "npm_config_cache"];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

/** Image bytes from a tool result that returned the image inline instead of writing the file. */
function inlineImage(out) {
  const blocks = Array.isArray(out) ? out.flat(Infinity) : [out];
  for (const b of blocks) {
    if (b && typeof b === "object" && typeof b.data === "string" && /image/i.test(`${b.type ?? ""}${b.mimeType ?? ""}${b.mime_type ?? ""}`)) {
      return { mime: b.mimeType ?? b.mime_type ?? "image/jpeg", data: b.data };
    }
  }
  return undefined;
}

/**
 * @param {{ browser: object, screenshot: { format: string, quality: number } }} config
 * @param {{ logFile?: string }} [opts]
 */
export function createBrowserSession(config, opts = {}) {
  const args = ["-y", "chrome-devtools-mcp@latest", ...attachArgs(config.browser)];
  if (opts.logFile) args.push(`--logFile=${opts.logFile}`);

  const adapter = new MCPAdapter({
    servers: { chrome: { transport: "stdio", command: "npx", args, env: childEnv(opts.logFile ? { DEBUG: "*" } : {}), stderr: "ignore" } },
    prefixToolNameWithServerName: false, // keep chrome-devtools-mcp's own tool names
  });

  let toolsPromise;
  const allTools = () => (toolsPromise ??= adapter.listTools());
  const tool = async (name) => {
    const found = (await allTools()).find((t) => t.name === name);
    if (!found) throw new Error(`chrome-devtools-mcp does not provide the "${name}" tool`);
    return found;
  };

  const session = {
    /** Tools to hand to the model (filtered by name). */
    async agentTools(names) {
      return (await allTools()).filter((t) => names.includes(t.name));
    },

    /** Attaches on first use (the MCP server connects lazily on its first tool call) and lists the open tabs. */
    async listTabs() {
      let text;
      try {
        text = textOf(await (await tool("list_pages")).invoke({}));
      } catch (err) {
        throw new BrowserAttachError(err?.message ?? String(err), attachHint(config.browser));
      }
      const result = interpretListPages(text);
      if (!result.ok) throw new BrowserAttachError(result.message, attachHint(config.browser));
      return result.tabs;
    },

    /** A screenshot of a page as base64, or undefined when the tool is unavailable. Never shown to the model. */
    async screenshot({ pageId } = {}) {
      const shot = await tool("take_screenshot");
      const props = shot.schema?.shape ?? shot.schema?.properties ?? {};
      const callArgs = { format: config.screenshot.format, quality: config.screenshot.quality };
      if ("pageId" in props) {
        let id = pageId;
        if (id === undefined) {
          const tabs = await session.listTabs();
          id = (tabs.find((t) => t.selected) ?? tabs.at(-1))?.id;
        }
        if (id === undefined) return undefined;
        callArgs.pageId = id;
      }
      const dir = path.join(os.tmpdir(), "agent-app-shots");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${crypto.randomUUID()}.${config.screenshot.format}`);
      try {
        const out = await shot.invoke({ ...callArgs, filePath: file });
        if (fs.existsSync(file)) return { mime: `image/${config.screenshot.format}`, data: fs.readFileSync(file).toString("base64") };
        return inlineImage(out);
      } finally {
        fs.rmSync(file, { force: true });
      }
    },

    async close() {
      await adapter.close();
    },
  };
  return session;
}

/** One shared session per process (graph modules are loaded once by the server). */
export function sharedBrowserSession(config, opts) {
  globalThis.__agentAppBrowser ??= createBrowserSession(config, opts);
  return globalThis.__agentAppBrowser;
}
